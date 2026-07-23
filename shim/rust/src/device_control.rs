use std::collections::HashSet;
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::credentials::ContentCollectionMode;
use crate::targets::{Target, TargetStore};

const SCHEMA_VERSION: u8 = 1;
const MAX_COMMANDS: usize = 8;
const MAX_PENDING_RESULTS: usize = 32;
const MAX_COMPLETED_COMMANDS: usize = 128;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum ContentMode {
    Off,
    ServerV1,
    E2eeV1,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum CommandType {
    Collect,
    Doctor,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CommandResult {
    command_id: String,
    status: CommandResultStatus,
    result_code: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum CommandResultStatus {
    Succeeded,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ControlState {
    schema_version: u8,
    target_revision: String,
    applied_generation: u64,
    applied_content_mode: ContentMode,
    applied_content_since: Option<String>,
    #[serde(default)]
    completed_command_ids: Vec<String>,
    #[serde(default)]
    pending_results: Vec<CommandResult>,
    #[serde(default)]
    error_code: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncRequest<'a> {
    schema_version: u8,
    device_fingerprint: &'a str,
    host: Option<&'a str>,
    shim_version: &'a str,
    daemon_active: bool,
    applied_generation: u64,
    applied_content_mode: ContentMode,
    applied_content_since: Option<&'a str>,
    error_code: Option<&'a str>,
    command_results: &'a [CommandResult],
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SyncResponse {
    schema_version: u8,
    desired: DesiredState,
    commands: Vec<RemoteCommand>,
    next_sync_seconds: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DesiredState {
    generation: u64,
    content_mode: ContentMode,
    content_since: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteCommand {
    id: String,
    #[serde(rename = "type")]
    command_type: CommandType,
}

#[derive(Debug)]
enum SyncError {
    Unsupported,
    Unauthorized,
    Unavailable,
    InvalidResponse,
    State,
}

trait Transport {
    fn sync(&self, target: &Target, request: &SyncRequest<'_>) -> Result<SyncResponse, SyncError>;
}

trait Executor {
    fn execute(&self, target: &Target, command_type: CommandType) -> i32;
}

struct CurlTransport;
struct LocalExecutor;

fn state_path(target: &Target) -> std::path::PathBuf {
    target.state_dir.join("device-control.json")
}

fn base_content_mode(target: &Target) -> ContentMode {
    match target.credentials.collect_content {
        ContentCollectionMode::ServerManaged => ContentMode::ServerV1,
        ContentCollectionMode::Off => ContentMode::Off,
        ContentCollectionMode::LegacyE2eeV1 => ContentMode::E2eeV1,
    }
}

fn normalized_content_since(target: &Target) -> Option<String> {
    let value = target.credentials.collect_content_since.as_deref()?;
    if value.eq_ignore_ascii_case("all") {
        return Some("1970-01-01T00:00:00.000Z".into());
    }
    crate::iso::iso_to_epoch_ms(value).map(crate::iso::epoch_ms_to_iso)
}

fn initial_state(target: &Target) -> ControlState {
    ControlState {
        schema_version: SCHEMA_VERSION,
        target_revision: target.revision.clone(),
        applied_generation: 0,
        applied_content_mode: base_content_mode(target),
        applied_content_since: normalized_content_since(target),
        completed_command_ids: Vec::new(),
        pending_results: Vec::new(),
        error_code: None,
    }
}

fn load_state(target: &Target) -> ControlState {
    let state = std::fs::read_to_string(state_path(target))
        .ok()
        .and_then(|text| serde_json::from_str::<ControlState>(&text).ok());
    match state {
        Some(state)
            if state.schema_version == SCHEMA_VERSION
                && state.target_revision == target.revision =>
        {
            state
        }
        _ => initial_state(target),
    }
}

fn save_state(target: &Target, state: &ControlState) -> Result<(), SyncError> {
    let text = serde_json::to_string(state).map_err(|_| SyncError::State)?;
    crate::fsx::write_atomic(&state_path(target), &text, 0o600).map_err(|_| SyncError::State)
}

pub fn apply_overrides(targets: &mut [Target]) {
    for target in targets {
        let state = load_state(target);
        if state.applied_generation == 0 {
            continue;
        }
        target.credentials.collect_content = match state.applied_content_mode {
            ContentMode::Off => ContentCollectionMode::Off,
            ContentMode::ServerV1 => ContentCollectionMode::ServerManaged,
            ContentMode::E2eeV1 => ContentCollectionMode::LegacyE2eeV1,
        };
        target.credentials.collect_content_since = state.applied_content_since;
    }
}

fn daemon_active() -> bool {
    matches!(
        crate::daemon::state(),
        crate::daemon::State::Installed { active: true, .. }
    )
}

fn valid_uuid(value: &str) -> bool {
    if value.len() != 36 {
        return false;
    }
    value.bytes().enumerate().all(|(index, byte)| match index {
        8 | 13 | 18 | 23 => byte == b'-',
        _ => byte.is_ascii_hexdigit(),
    })
}

fn validate_response(response: &SyncResponse) -> Result<(), SyncError> {
    if response.schema_version != SCHEMA_VERSION
        || response.desired.generation == 0
        || response.commands.len() > MAX_COMMANDS
        || response.next_sync_seconds < 60
    {
        return Err(SyncError::InvalidResponse);
    }
    if let Some(since) = response.desired.content_since.as_deref() {
        if crate::iso::iso_to_epoch_ms(since).is_none() {
            return Err(SyncError::InvalidResponse);
        }
    }
    let mut ids = HashSet::new();
    if response
        .commands
        .iter()
        .any(|command| !valid_uuid(&command.id) || !ids.insert(command.id.as_str()))
    {
        return Err(SyncError::InvalidResponse);
    }
    Ok(())
}

fn request<'a>(
    state: &'a ControlState,
    device_id: &'a str,
    host: Option<&'a str>,
    daemon_active: bool,
) -> SyncRequest<'a> {
    SyncRequest {
        schema_version: SCHEMA_VERSION,
        device_fingerprint: device_id,
        host,
        shim_version: crate::cli::version(),
        daemon_active,
        applied_generation: state.applied_generation,
        applied_content_mode: state.applied_content_mode,
        applied_content_since: state.applied_content_since.as_deref(),
        error_code: state.error_code.as_deref(),
        command_results: &state.pending_results,
    }
}

fn apply_desired(state: &mut ControlState, desired: DesiredState) -> bool {
    if desired.generation < state.applied_generation {
        return false;
    }
    let changed = desired.generation != state.applied_generation
        || desired.content_mode != state.applied_content_mode
        || desired.content_since != state.applied_content_since;
    state.applied_generation = desired.generation;
    state.applied_content_mode = desired.content_mode;
    state.applied_content_since = desired.content_since;
    state.error_code = None;
    changed
}

fn execute_commands(
    target: &Target,
    state: &mut ControlState,
    commands: Vec<RemoteCommand>,
    executor: &dyn Executor,
) -> Result<bool, SyncError> {
    let mut changed = false;
    for command in commands {
        if state
            .completed_command_ids
            .iter()
            .any(|completed| completed == &command.id)
        {
            continue;
        }
        let code = executor.execute(target, command.command_type);
        state.completed_command_ids.push(command.id.clone());
        if state.completed_command_ids.len() > MAX_COMPLETED_COMMANDS {
            let excess = state.completed_command_ids.len() - MAX_COMPLETED_COMMANDS;
            state.completed_command_ids.drain(0..excess);
        }
        state.pending_results.push(CommandResult {
            command_id: command.id,
            status: if code == 0 {
                CommandResultStatus::Succeeded
            } else {
                CommandResultStatus::Failed
            },
            result_code: (code != 0).then(|| match command.command_type {
                CommandType::Collect => "collect_failed".into(),
                CommandType::Doctor => "doctor_failed".into(),
            }),
        });
        if state.pending_results.len() > MAX_PENDING_RESULTS {
            let excess = state.pending_results.len() - MAX_PENDING_RESULTS;
            state.pending_results.drain(0..excess);
        }
        save_state(target, state)?;
        changed = true;
    }
    Ok(changed)
}

fn sync_once(
    target: &Target,
    state: &mut ControlState,
    device_id: &str,
    host: Option<&str>,
    daemon_active: bool,
    transport: &dyn Transport,
    executor: &dyn Executor,
) -> Result<bool, SyncError> {
    let reported_results = !state.pending_results.is_empty();
    let response = transport.sync(target, &request(state, device_id, host, daemon_active))?;
    validate_response(&response)?;
    if reported_results {
        state.pending_results.clear();
    }
    let desired_changed = apply_desired(state, response.desired);
    let commands_changed = execute_commands(target, state, response.commands, executor)?;
    save_state(target, state)?;
    Ok(reported_results || desired_changed || commands_changed)
}

fn sync_target(
    target: &Target,
    device_id: &str,
    host: Option<&str>,
    daemon_active: bool,
    transport: &dyn Transport,
    executor: &dyn Executor,
) -> Result<(), SyncError> {
    let mut state = load_state(target);
    let should_confirm = sync_once(
        target,
        &mut state,
        device_id,
        host,
        daemon_active,
        transport,
        executor,
    )?;
    if should_confirm {
        let _ = sync_once(
            target,
            &mut state,
            device_id,
            host,
            daemon_active,
            transport,
            executor,
        )?;
    }
    Ok(())
}

fn sync_targets(
    targets: Vec<Target>,
    device_id: &str,
    host: Option<&str>,
    daemon_active: bool,
    transport: &dyn Transport,
    executor: &dyn Executor,
) -> bool {
    let mut failed = false;
    for target in targets {
        if target.credentials.token.is_none() {
            failed = true;
            continue;
        }
        match sync_target(&target, device_id, host, daemon_active, transport, executor) {
            Ok(()) | Err(SyncError::Unsupported) => {}
            Err(_) => failed = true,
        }
    }
    failed
}

pub fn sync_all() -> i32 {
    let store = match TargetStore::from_home() {
        Ok(store) => store,
        Err(_) => return 1,
    };
    let targets = match store.load_or_migrate() {
        Ok(targets) => targets,
        Err(_) => return 1,
    };
    if targets.is_empty() {
        return 0;
    }
    let global_state = store.root().join("state");
    let Some(device_id) = crate::collect::inventory::device_id(&global_state) else {
        return 1;
    };
    let host = crate::host::host_label();
    i32::from(sync_targets(
        targets,
        &device_id,
        host.as_deref(),
        daemon_active(),
        &CurlTransport,
        &LocalExecutor,
    ))
}

fn auth_config(token: &str) -> Result<String, SyncError> {
    if token.contains(['\r', '\n']) {
        return Err(SyncError::Unavailable);
    }
    let escaped = token.replace('\\', "\\\\").replace('"', "\\\"");
    Ok(format!("header = \"Authorization: Bearer {escaped}\"\n"))
}

fn secure_endpoint(endpoint: &str) -> bool {
    let Ok(url) = url::Url::parse(endpoint) else {
        return false;
    };
    if url.scheme() == "https" {
        return true;
    }
    url.scheme() == "http"
        && url.host_str().is_some_and(|host| {
            host.eq_ignore_ascii_case("localhost")
                || host == "127.0.0.1"
                || host == "::1"
                || host == "[::1]"
        })
}

impl Transport for CurlTransport {
    fn sync(&self, target: &Target, request: &SyncRequest<'_>) -> Result<SyncResponse, SyncError> {
        if !secure_endpoint(&target.endpoint) {
            return Err(SyncError::Unavailable);
        }
        let token = target
            .credentials
            .token
            .as_deref()
            .ok_or(SyncError::Unauthorized)?;
        let body = serde_json::to_string(request).map_err(|_| SyncError::Unavailable)?;
        let nonce = rand::random::<u64>();
        let request_path = target
            .state_dir
            .join(format!(".device-control-{nonce}.json"));
        let auth_path = target
            .state_dir
            .join(format!(".device-control-auth-{nonce}.conf"));
        crate::fsx::write_atomic(&request_path, &body, 0o600)
            .map_err(|_| SyncError::Unavailable)?;
        let auth = auth_config(token)?;
        if crate::fsx::write_atomic(&auth_path, &auth, 0o600).is_err() {
            let _ = std::fs::remove_file(&request_path);
            return Err(SyncError::Unavailable);
        }
        let url = format!(
            "{}/v1/device-control/sync",
            target.endpoint.trim_end_matches('/')
        );
        let output = Command::new("curl")
            .args([
                "-sS",
                "--connect-timeout",
                "5",
                "--max-time",
                "20",
                "--config",
            ])
            .arg(&auth_path)
            .args([
                "-A",
                &format!("toard-shim/{}", crate::cli::version()),
                "-X",
                "POST",
                "-H",
                "Content-Type: application/json",
                "--data-binary",
                &format!("@{}", request_path.display()),
                "-w",
                "\n%{http_code}",
                &url,
            ])
            .output();
        let _ = std::fs::remove_file(&request_path);
        let _ = std::fs::remove_file(&auth_path);
        let output = output.map_err(|_| SyncError::Unavailable)?;
        let text = String::from_utf8_lossy(&output.stdout);
        let (body, code) = text.rsplit_once('\n').ok_or(SyncError::InvalidResponse)?;
        match code.trim().parse::<u16>().unwrap_or(0) {
            200 => serde_json::from_str(body.trim()).map_err(|_| SyncError::InvalidResponse),
            401 => Err(SyncError::Unauthorized),
            404 | 405 | 426 => Err(SyncError::Unsupported),
            _ => Err(SyncError::Unavailable),
        }
    }
}

impl Executor for LocalExecutor {
    fn execute(&self, target: &Target, command_type: CommandType) -> i32 {
        match command_type {
            CommandType::Collect => {
                crate::collect::run_selected(None, Some(&target.endpoint), false, true)
            }
            CommandType::Doctor => crate::cli::doctor(Some(&target.endpoint)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::Credentials;
    use std::cell::{Cell, RefCell};
    use std::path::PathBuf;

    fn test_target(root: &std::path::Path, revision: &str) -> Target {
        let state_dir = root.join("state");
        std::fs::create_dir_all(&state_dir).unwrap();
        Target {
            id: "a".repeat(64),
            revision: revision.into(),
            endpoint: "https://toard.example/api".into(),
            credentials_path: root.join("credentials"),
            state_dir,
            credentials: Credentials {
                token: Some("token".into()),
                endpoint: Some("https://toard.example/api".into()),
                ..Credentials::default()
            },
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "toard-device-control-{name}-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ))
    }

    #[test]
    fn response_rejects_duplicate_commands_and_bad_timestamps() {
        let duplicate = serde_json::from_str::<SyncResponse>(
            r#"{"schemaVersion":1,"desired":{"generation":1,"contentMode":"off","contentSince":null},"commands":[{"id":"123e4567-e89b-12d3-a456-426614174000","type":"collect"},{"id":"123e4567-e89b-12d3-a456-426614174000","type":"doctor"}],"nextSyncSeconds":60}"#,
        )
        .unwrap();
        assert!(matches!(
            validate_response(&duplicate),
            Err(SyncError::InvalidResponse)
        ));

        let bad_since = serde_json::from_str::<SyncResponse>(
            r#"{"schemaVersion":1,"desired":{"generation":1,"contentMode":"server_v1","contentSince":"yesterday"},"commands":[],"nextSyncSeconds":60}"#,
        )
        .unwrap();
        assert!(matches!(
            validate_response(&bad_since),
            Err(SyncError::InvalidResponse)
        ));
    }

    #[test]
    fn stored_policy_applies_only_to_matching_target_revision() {
        let root = temp_dir("revision");
        let mut target = test_target(&root, "rev-1");
        let state = ControlState {
            applied_generation: 4,
            applied_content_mode: ContentMode::ServerV1,
            applied_content_since: Some("2026-07-24T00:00:00.000Z".into()),
            ..initial_state(&target)
        };
        save_state(&target, &state).unwrap();
        apply_overrides(std::slice::from_mut(&mut target));
        assert_eq!(
            target.credentials.collect_content,
            ContentCollectionMode::ServerManaged
        );

        target.revision = "rev-2".into();
        target.credentials.collect_content = ContentCollectionMode::Off;
        apply_overrides(std::slice::from_mut(&mut target));
        assert_eq!(
            target.credentials.collect_content,
            ContentCollectionMode::Off
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn initial_state_preserves_legacy_e2ee_until_server_changes_it() {
        let root = temp_dir("legacy");
        let mut target = test_target(&root, "rev-1");
        target.credentials.collect_content = ContentCollectionMode::LegacyE2eeV1;
        target.credentials.collect_content_since = Some("all".into());

        let state = initial_state(&target);

        assert_eq!(state.applied_content_mode, ContentMode::E2eeV1);
        assert_eq!(
            state.applied_content_since.as_deref(),
            Some("1970-01-01T00:00:00.000Z")
        );
        let _ = std::fs::remove_dir_all(root);
    }

    struct FakeTransport {
        calls: Cell<usize>,
        response: RefCell<Option<SyncResponse>>,
    }

    impl Transport for FakeTransport {
        fn sync(
            &self,
            _target: &Target,
            _request: &SyncRequest<'_>,
        ) -> Result<SyncResponse, SyncError> {
            self.calls.set(self.calls.get() + 1);
            self.response
                .borrow_mut()
                .take()
                .ok_or(SyncError::Unsupported)
        }
    }

    struct FakeExecutor {
        calls: Cell<usize>,
    }

    struct IsolationTransport {
        calls: RefCell<Vec<String>>,
    }

    impl Transport for IsolationTransport {
        fn sync(
            &self,
            target: &Target,
            _request: &SyncRequest<'_>,
        ) -> Result<SyncResponse, SyncError> {
            self.calls.borrow_mut().push(target.endpoint.clone());
            if target.endpoint.contains("broken") {
                return Err(SyncError::Unavailable);
            }
            Ok(SyncResponse {
                schema_version: 1,
                desired: DesiredState {
                    generation: 1,
                    content_mode: ContentMode::Off,
                    content_since: None,
                },
                commands: Vec::new(),
                next_sync_seconds: 60,
            })
        }
    }

    impl Executor for FakeExecutor {
        fn execute(&self, _target: &Target, _command_type: CommandType) -> i32 {
            self.calls.set(self.calls.get() + 1);
            0
        }
    }

    #[test]
    fn desired_policy_and_allowlisted_command_are_persisted_before_confirmation() {
        let root = temp_dir("sync");
        let target = test_target(&root, "rev-1");
        let transport = FakeTransport {
            calls: Cell::new(0),
            response: RefCell::new(Some(SyncResponse {
                schema_version: 1,
                desired: DesiredState {
                    generation: 2,
                    content_mode: ContentMode::ServerV1,
                    content_since: Some("2026-07-24T00:00:00.000Z".into()),
                },
                commands: vec![RemoteCommand {
                    id: "123e4567-e89b-12d3-a456-426614174000".into(),
                    command_type: CommandType::Collect,
                }],
                next_sync_seconds: 60,
            })),
        };
        let executor = FakeExecutor {
            calls: Cell::new(0),
        };

        let result = sync_target(
            &target,
            &"d".repeat(64),
            Some("host"),
            true,
            &transport,
            &executor,
        );
        assert!(matches!(result, Err(SyncError::Unsupported)));
        let saved = load_state(&target);
        assert_eq!(saved.applied_generation, 2);
        assert_eq!(saved.applied_content_mode, ContentMode::ServerV1);
        assert_eq!(saved.pending_results.len(), 1);
        assert_eq!(executor.calls.get(), 1);
        assert_eq!(transport.calls.get(), 2);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn one_target_failure_does_not_block_the_next_target() {
        let root = temp_dir("isolation");
        let mut broken = test_target(&root.join("broken"), "rev-1");
        broken.endpoint = "https://broken.example/api".into();
        let mut healthy = test_target(&root.join("healthy"), "rev-1");
        healthy.endpoint = "https://healthy.example/api".into();
        let transport = IsolationTransport {
            calls: RefCell::new(Vec::new()),
        };
        let executor = FakeExecutor {
            calls: Cell::new(0),
        };

        assert!(sync_targets(
            vec![broken, healthy],
            &"d".repeat(64),
            Some("host"),
            true,
            &transport,
            &executor,
        ));
        let calls = transport.calls.borrow();
        assert_eq!(calls[0], "https://broken.example/api");
        assert!(calls
            .iter()
            .any(|endpoint| endpoint == "https://healthy.example/api"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn only_https_and_loopback_http_can_carry_ingest_tokens() {
        assert!(secure_endpoint("https://toard.example/api"));
        assert!(secure_endpoint("http://127.0.0.1:3000/api"));
        assert!(secure_endpoint("http://localhost:3000/api"));
        assert!(!secure_endpoint("http://192.168.1.20:3000/api"));
    }
}

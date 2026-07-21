use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::json;

use super::adapters::{
    merge_managed_json_entry, merge_managed_toml_mcp, remove_managed_json_entry,
    remove_managed_toml_mcp,
};
use super::client::{
    download_archive, fetch_manifest, next_backoff_seconds, parse_manifest, CurlResponse,
    ManifestFetch,
};
use super::launcher::{build_mcp_launch, McpLaunchDefinition};
use super::plan::{plan, plan_after_fetch_error};
use super::protocol::{
    DeploymentOrigin, DeploymentReport, DeploymentStatus, DesiredItem, InstallPayload,
};
use super::source::{canonical_tree_digest, read_tar_gz_files, SourceFile};
use super::state::{
    enqueue_reports, flush_reports, load_client_state, load_managed_state, save_client_state,
    save_managed_state, tools_dir, ManagedItem, ManagedState,
};
use super::DeployError;

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TransactionOutcome {
    Applied,
    RolledBack,
}

fn write_atomic_bytes(path: &Path, bytes: &[u8]) -> Result<(), DeployError> {
    let parent = path
        .parent()
        .ok_or_else(|| DeployError::new("invalid_target_path"))?;
    fs::create_dir_all(parent).map_err(|_| DeployError::new("target_write_failed"))?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| DeployError::new("invalid_target_path"))?;
    let temporary = parent.join(format!(".{name}.toard-tmp-{}", std::process::id()));
    fs::write(&temporary, bytes).map_err(|_| DeployError::new("target_write_failed"))?;
    crate::fsx::set_mode(&temporary, 0o600).map_err(|_| DeployError::new("target_write_failed"))?;
    fs::rename(&temporary, path).map_err(|_| {
        let _ = fs::remove_file(&temporary);
        DeployError::new("target_write_failed")
    })
}

fn apply_file_replacements(replacements: &[(PathBuf, Vec<u8>)]) -> Result<(), DeployError> {
    let previous = replacements
        .iter()
        .map(|(path, _)| fs::read(path).ok())
        .collect::<Vec<_>>();
    for (index, (path, bytes)) in replacements.iter().enumerate() {
        if let Err(error) = write_atomic_bytes(path, bytes) {
            for rollback_index in (0..index).rev() {
                let rollback_path = &replacements[rollback_index].0;
                match &previous[rollback_index] {
                    Some(contents) => {
                        let _ = write_atomic_bytes(rollback_path, contents);
                    }
                    None => {
                        let _ = fs::remove_file(rollback_path);
                    }
                }
            }
            return Err(error);
        }
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn apply_file_transaction<F>(
    target: &Path,
    replacement: &[u8],
    health_check: F,
) -> Result<TransactionOutcome, DeployError>
where
    F: FnOnce() -> bool,
{
    let previous = fs::read(target).ok();
    write_atomic_bytes(target, replacement)?;
    if health_check() {
        return Ok(TransactionOutcome::Applied);
    }
    match previous {
        Some(bytes) => write_atomic_bytes(target, &bytes)?,
        None => {
            if target.exists() {
                fs::remove_file(target).map_err(|_| DeployError::new("rollback_failed"))?;
            }
        }
    }
    Ok(TransactionOutcome::RolledBack)
}

fn device_fingerprint() -> Option<String> {
    let body = crate::fsx::state_dir()
        .map(|directory| directory.join("tool-inventory.json"))
        .and_then(|path| fs::read_to_string(path).ok())?;
    let value: serde_json::Value = serde_json::from_str(&body).ok()?;
    value
        .get("device_id")
        .and_then(serde_json::Value::as_str)
        .filter(|fingerprint| fingerprint.len() == 64)
        .map(str::to_owned)
}

fn stage_directory(target: &Path, files: &[SourceFile]) -> Result<Option<PathBuf>, DeployError> {
    let parent = target
        .parent()
        .ok_or_else(|| DeployError::new("invalid_target_path"))?;
    fs::create_dir_all(parent).map_err(|_| DeployError::new("target_write_failed"))?;
    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| DeployError::new("invalid_target_path"))?;
    let staging = parent.join(format!(".{name}.toard-stage-{}", std::process::id()));
    let backup = parent.join(format!(".{name}.toard-backup-{}", std::process::id()));
    let _ = fs::remove_dir_all(&staging);
    let _ = fs::remove_dir_all(&backup);
    fs::create_dir_all(&staging).map_err(|_| DeployError::new("target_write_failed"))?;
    for file in files {
        let destination = staging.join(&file.path);
        if let Some(directory) = destination.parent() {
            fs::create_dir_all(directory).map_err(|_| DeployError::new("target_write_failed"))?;
        }
        fs::write(destination, &file.bytes).map_err(|_| DeployError::new("target_write_failed"))?;
    }
    if !staging.join("SKILL.md").is_file() {
        let _ = fs::remove_dir_all(staging);
        return Err(DeployError::new("health_check_failed"));
    }
    let had_previous = target.exists();
    if had_previous {
        fs::rename(target, &backup).map_err(|_| DeployError::new("target_write_failed"))?;
    }
    if fs::rename(&staging, target).is_err() {
        if had_previous {
            let _ = fs::rename(&backup, target);
        }
        return Err(DeployError::new("target_write_failed"));
    }
    Ok(had_previous.then_some(backup))
}

fn rollback_skill_targets(applied: &[(PathBuf, Option<PathBuf>)]) {
    for (target, backup) in applied.iter().rev() {
        let _ = fs::remove_dir_all(target);
        if let Some(backup) = backup {
            let _ = fs::rename(backup, target);
        }
    }
}

fn skill_targets(home: &Path, clients: &[String], target_key: &str) -> Vec<PathBuf> {
    clients
        .iter()
        .filter_map(|client| match client.as_str() {
            "codex" => Some(home.join(".codex").join("skills").join(target_key)),
            "claude_code" => Some(home.join(".claude").join("skills").join(target_key)),
            _ => None,
        })
        .collect()
}

fn install_skill(
    item: &DesiredItem,
    state: &ManagedState,
    files: &[String],
    target_key: &str,
) -> Result<ManagedItem, DeployError> {
    let home = crate::fsx::home_dir().ok_or_else(|| DeployError::new("home_unavailable"))?;
    let archive = download_archive(&item.manifest.source.download_url)?;
    let source_files = read_tar_gz_files(&archive, &item.manifest.source.path, files)?;
    if canonical_tree_digest(&source_files)? != item.manifest.source.tree_digest {
        return Err(DeployError::new("digest_mismatch"));
    }
    let current = state.items.get(&item.manifest.slug);
    let targets = skill_targets(&home, &item.manifest.clients, target_key);
    for target in &targets {
        let value = target.to_string_lossy();
        if target.exists()
            && !current.is_some_and(|managed| managed.managed_paths.contains(value.as_ref()))
        {
            return Err(DeployError::new("unmanaged_conflict"));
        }
    }
    let mut applied = Vec::new();
    for target in &targets {
        match stage_directory(target, &source_files) {
            Ok(backup) => applied.push((target.clone(), backup)),
            Err(error) => {
                rollback_skill_targets(&applied);
                return Err(error);
            }
        }
    }
    for (_, backup) in &applied {
        if let Some(backup) = backup {
            let _ = fs::remove_dir_all(backup);
        }
    }
    Ok(ManagedItem {
        catalog_item_id: item.catalog_item_id.clone(),
        version_id: item.version_id.clone(),
        last_known_good_version_id: item.version_id.clone(),
        managed_keys: BTreeSet::new(),
        managed_paths: targets
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect(),
        settings_required: false,
    })
}

fn write_mcp_configs(
    home: &Path,
    state: &ManagedState,
    clients: &[String],
    key: &str,
    entry: serde_json::Value,
) -> Result<BTreeSet<String>, DeployError> {
    let mut replacements = Vec::new();
    for client in clients {
        match client.as_str() {
            "claude_code" => {
                let path = home.join(".claude.json");
                let content = fs::read_to_string(&path).unwrap_or_else(|_| "{}".into());
                let root = serde_json::from_str(&content)
                    .map_err(|_| DeployError::new("invalid_client_config"))?;
                let merged = merge_managed_json_entry(&root, state, key, entry.clone())?;
                let body = serde_json::to_string_pretty(&merged)
                    .map_err(|_| DeployError::new("invalid_client_config"))?;
                replacements.push((path, body.into_bytes()));
            }
            "codex" => {
                let path = home.join(".codex").join("config.toml");
                let content = fs::read_to_string(&path).unwrap_or_default();
                let command = entry
                    .get("command")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| DeployError::new("invalid_manifest"))?;
                let args = entry
                    .get("args")
                    .and_then(serde_json::Value::as_array)
                    .ok_or_else(|| DeployError::new("invalid_manifest"))?
                    .iter()
                    .map(|value| {
                        value
                            .as_str()
                            .map(str::to_owned)
                            .ok_or_else(|| DeployError::new("invalid_manifest"))
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                let merged = merge_managed_toml_mcp(&content, state, key, command, &args)?;
                replacements.push((path, merged.into_bytes()));
            }
            _ => return Err(DeployError::new("unsupported_client")),
        }
    }
    apply_file_replacements(&replacements)?;
    Ok(BTreeSet::from([key.to_owned()]))
}

fn install_mcp_stdio(
    item: &DesiredItem,
    state: &ManagedState,
    command: &str,
    args: &[String],
    required_env_names: &[String],
    managed_key: &str,
) -> Result<(ManagedItem, bool), DeployError> {
    if !command_available(command) {
        return Err(DeployError::new("health_check_failed"));
    }
    let home = crate::fsx::home_dir().ok_or_else(|| DeployError::new("home_unavailable"))?;
    let definition = McpLaunchDefinition {
        deployment_id: item.manifest.slug.clone(),
        command: command.to_owned(),
        args: args.to_vec(),
        required_env_names: required_env_names.to_vec(),
    };
    let definitions = tools_dir()
        .ok_or_else(|| DeployError::new("home_unavailable"))?
        .join("deployments");
    let body = serde_json::to_string_pretty(&definition)
        .map_err(|_| DeployError::new("invalid_manifest"))?;
    crate::fsx::write_atomic(
        &definitions.join(format!("{}.json", item.manifest.slug)),
        &body,
        0o600,
    )
    .map_err(|_| DeployError::new("target_write_failed"))?;
    let local_secrets = super::secrets::load_secrets(&item.manifest.slug, required_env_names);
    let launch = build_mcp_launch(&definition, &local_secrets).ok();
    let entry = launch
        .as_ref()
        .map(|launch| launch.managed_client_entry.clone())
        .unwrap_or_else(
            || json!({ "command": "toard-shim", "args": ["tool", "run-mcp", item.manifest.slug] }),
        );
    let managed_keys = write_mcp_configs(&home, state, &item.manifest.clients, managed_key, entry)?;
    Ok((
        ManagedItem {
            catalog_item_id: item.catalog_item_id.clone(),
            version_id: item.version_id.clone(),
            last_known_good_version_id: item.version_id.clone(),
            managed_keys,
            managed_paths: BTreeSet::new(),
            settings_required: launch.is_none(),
        },
        launch.is_none(),
    ))
}

fn command_available(command: &str) -> bool {
    let candidate = Path::new(command);
    if candidate.components().count() > 1 {
        return candidate.is_file();
    }
    std::env::var_os("PATH")
        .map(|paths| {
            std::env::split_paths(&paths).any(|directory| {
                let path = directory.join(command);
                path.is_file()
                    || (cfg!(windows) && directory.join(format!("{command}.exe")).is_file())
            })
        })
        .unwrap_or(false)
}

fn report(
    item: &DesiredItem,
    status: DeploymentStatus,
    error_code: Option<&str>,
) -> DeploymentReport {
    DeploymentReport {
        device_fingerprint: String::new(),
        catalog_item_id: item.catalog_item_id.clone(),
        desired_version_id: Some(item.version_id.clone()),
        applied_version_id: matches!(
            status,
            DeploymentStatus::Installed | DeploymentStatus::SettingsRequired
        )
        .then(|| item.version_id.clone()),
        status,
        error_code: error_code.map(str::to_owned),
        attempt: 1,
        rollout_id: item.rollout_id.clone(),
    }
}

fn remove_managed_item(slug: &str, state: &mut ManagedState) -> Result<(), DeployError> {
    let Some(item) = state.items.get(slug).cloned() else {
        return Ok(());
    };
    let mut moved_paths = Vec::new();
    for path in &item.managed_paths {
        let target = Path::new(path);
        if target.exists() {
            let parent = target
                .parent()
                .ok_or_else(|| DeployError::new("remove_failed"))?;
            let name = target
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or_else(|| DeployError::new("remove_failed"))?;
            let backup = parent.join(format!(".{name}.toard-remove-{}", std::process::id()));
            if backup.exists() {
                let _ = if backup.is_dir() {
                    fs::remove_dir_all(&backup)
                } else {
                    fs::remove_file(&backup)
                };
            }
            if fs::rename(target, &backup).is_err() {
                for (restore_target, restore_backup) in moved_paths.iter().rev() {
                    let _ = fs::rename(restore_backup, restore_target);
                }
                return Err(DeployError::new("remove_failed"));
            }
            moved_paths.push((target.to_path_buf(), backup));
        }
    }
    let mut replacements = Vec::new();
    if let Some(home) = crate::fsx::home_dir() {
        let claude = home.join(".claude.json");
        if let Ok(content) = fs::read_to_string(&claude) {
            if let Ok(mut root) = serde_json::from_str(&content) {
                for key in &item.managed_keys {
                    root = remove_managed_json_entry(&root, state, key)?;
                }
                let body = serde_json::to_string_pretty(&root)
                    .map_err(|_| DeployError::new("invalid_client_config"))?;
                replacements.push((claude, body.into_bytes()));
            }
        }
        let codex = home.join(".codex").join("config.toml");
        if let Ok(mut content) = fs::read_to_string(&codex) {
            for key in &item.managed_keys {
                let next = remove_managed_toml_mcp(&content, state, key)?;
                content = next;
            }
            replacements.push((codex, content.into_bytes()));
        }
    }
    if let Err(error) = apply_file_replacements(&replacements) {
        for (target, backup) in moved_paths.iter().rev() {
            let _ = fs::rename(backup, target);
        }
        return Err(error);
    }
    for (_, backup) in moved_paths {
        let _ = if backup.is_dir() {
            fs::remove_dir_all(backup)
        } else {
            fs::remove_file(backup)
        };
    }
    state.items.remove(slug);
    Ok(())
}

fn validate_protocol_contract(
    manifest: &super::protocol::DeviceManifestV1,
) -> Result<(), DeployError> {
    if manifest.generated_at.is_empty() {
        return Err(DeployError::new("invalid_manifest"));
    }
    for item in &manifest.items {
        let source = &item.manifest.source;
        let permissions = &item.manifest.permissions;
        let ref_is_sha = source.exact_ref.len() == 40
            && source
                .exact_ref
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit());
        let identity_matches = item.catalog_item_id == item.manifest.catalog_item_id
            && item.version_id == item.manifest.version_id;
        let rollout_matches = match item.origin {
            DeploymentOrigin::Personal => item.rollout_id.is_none(),
            DeploymentOrigin::Team => item.rollout_id.is_some(),
        };
        let payload_matches = matches!(
            (item.manifest.kind.as_str(), &item.manifest.payload),
            ("skill", InstallPayload::Skill { .. })
                | ("mcp", InstallPayload::McpStdio { .. })
                | ("mcp", InstallPayload::McpHttp { .. })
                | ("plugin", InstallPayload::Plugin { .. })
        );
        let payload_fields_valid = match &item.manifest.payload {
            InstallPayload::McpStdio { command, .. } => !matches!(
                command.to_ascii_lowercase().as_str(),
                "sh" | "bash"
                    | "zsh"
                    | "fish"
                    | "cmd"
                    | "cmd.exe"
                    | "pwsh"
                    | "powershell"
                    | "powershell.exe"
            ),
            InstallPayload::McpHttp {
                url, managed_key, ..
            } => url.starts_with("https://") && !managed_key.is_empty(),
            InstallPayload::Plugin { components } => components.iter().all(|component| {
                matches!(
                    component.component_type.as_str(),
                    "skill" | "mcp_stdio" | "mcp_http"
                ) && !component.key.is_empty()
            }),
            _ => true,
        };
        if item.manifest.schema_version != 1
            || item.manifest.min_protocol_version != 1
            || source.provider != "github"
            || !source.repository.contains('/')
            || !ref_is_sha
            || !identity_matches
            || !rollout_matches
            || !payload_matches
            || !payload_fields_valid
            || permissions.env.iter().any(String::is_empty)
            || permissions.network_hosts.iter().any(String::is_empty)
            || permissions.executables.iter().any(String::is_empty)
        {
            return Err(DeployError::new("invalid_manifest"));
        }
    }
    Ok(())
}

pub(crate) fn run_once() -> i32 {
    if cfg!(windows) {
        return 0;
    }
    let credentials = crate::credentials::read_credentials();
    let Some(token) = credentials.token.as_deref() else {
        return 0;
    };
    let Some(fingerprint) = device_fingerprint() else {
        return 0;
    };
    let endpoint = credentials
        .endpoint
        .as_deref()
        .unwrap_or(crate::credentials::DEFAULT_ENDPOINT);
    let _ = flush_reports(endpoint, token);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    let mut client_state = load_client_state();
    if client_state.next_attempt_at > now {
        return 0;
    }
    let fetched = match fetch_manifest(endpoint, token, &fingerprint, client_state.etag.as_deref())
    {
        Ok(value) => value,
        Err(_) => {
            let _ = plan_after_fetch_error(&load_managed_state());
            client_state.failure_count = client_state.failure_count.saturating_add(1);
            client_state.next_attempt_at =
                now.saturating_add(next_backoff_seconds(client_state.failure_count - 1));
            let _ = save_client_state(&client_state);
            return 1;
        }
    };
    let ManifestFetch { response, etag } = fetched;
    let body = match response {
        CurlResponse::Body(body) => body,
        CurlResponse::NotModified => {
            client_state.failure_count = 0;
            client_state.next_attempt_at = now.saturating_add(60);
            let _ = save_client_state(&client_state);
            return 0;
        }
    };
    let desired = match parse_manifest(&body) {
        Ok(manifest) => manifest,
        Err(_) => {
            client_state.failure_count = client_state.failure_count.saturating_add(1);
            client_state.next_attempt_at =
                now.saturating_add(next_backoff_seconds(client_state.failure_count - 1));
            let _ = save_client_state(&client_state);
            return 1;
        }
    };
    if validate_protocol_contract(&desired).is_err() {
        client_state.failure_count = client_state.failure_count.saturating_add(1);
        client_state.next_attempt_at =
            now.saturating_add(next_backoff_seconds(client_state.failure_count - 1));
        let _ = save_client_state(&client_state);
        return 1;
    }
    let mut state = load_managed_state();
    let _actions = plan(&state, &desired.items);
    let mut apply_failed = false;
    let mut reports = Vec::new();
    let desired_slugs: BTreeSet<_> = desired
        .items
        .iter()
        .map(|item| item.manifest.slug.clone())
        .collect();
    let existing: Vec<_> = state.items.keys().cloned().collect();
    for slug in existing {
        if !desired_slugs.contains(&slug) && remove_managed_item(&slug, &mut state).is_err() {
            apply_failed = true;
        }
    }
    for item in &desired.items {
        if let Some(current) = state
            .items
            .get(&item.manifest.slug)
            .filter(|current| current.version_id == item.version_id)
            .cloned()
        {
            let mut next = current;
            let status = if next.settings_required {
                match &item.manifest.payload {
                    InstallPayload::McpStdio {
                        command,
                        required_env_names,
                        ..
                    } => {
                        let secrets =
                            super::secrets::load_secrets(&item.manifest.slug, required_env_names);
                        if command_available(command)
                            && required_env_names
                                .iter()
                                .all(|name| secrets.contains_key(name))
                        {
                            next.settings_required = false;
                            state.items.insert(item.manifest.slug.clone(), next);
                            DeploymentStatus::Installed
                        } else {
                            DeploymentStatus::SettingsRequired
                        }
                    }
                    _ => DeploymentStatus::SettingsRequired,
                }
            } else {
                DeploymentStatus::Installed
            };
            reports.push(report(
                item,
                status.clone(),
                matches!(status, DeploymentStatus::SettingsRequired)
                    .then_some("local_secret_missing"),
            ));
            continue;
        }
        let result = match &item.manifest.payload {
            InstallPayload::Skill { files, target_key } => {
                install_skill(item, &state, files, target_key).map(|managed| (managed, false))
            }
            InstallPayload::McpStdio {
                command,
                args,
                required_env_names,
                managed_key,
            } => install_mcp_stdio(item, &state, command, args, required_env_names, managed_key),
            InstallPayload::McpHttp { auth, .. } if auth == "manual_secret_header" => {
                Err(DeployError::new("client_auth_required"))
            }
            InstallPayload::McpHttp { .. } => Err(DeployError::new("unsupported_manifest")),
            InstallPayload::Plugin { .. } => Err(DeployError::new("unsupported_manifest")),
        };
        let deployment_report = match result {
            Ok((managed, settings_required)) => {
                state.items.insert(item.manifest.slug.clone(), managed);
                report(
                    item,
                    if settings_required {
                        DeploymentStatus::SettingsRequired
                    } else {
                        DeploymentStatus::Installed
                    },
                    settings_required.then_some("local_secret_missing"),
                )
            }
            Err(error) if error.code() == "unmanaged_conflict" => {
                report(item, DeploymentStatus::Conflict, Some(error.code()))
            }
            Err(error) if error.code() == "client_auth_required" => {
                report(item, DeploymentStatus::SettingsRequired, Some(error.code()))
            }
            Err(error)
                if error.code() == "unsupported_manifest"
                    || error.code() == "unsupported_client" =>
            {
                report(item, DeploymentStatus::Unsupported, Some(error.code()))
            }
            Err(error) => {
                apply_failed = true;
                report(item, DeploymentStatus::Failed, Some(error.code()))
            }
        };
        reports.push(deployment_report);
    }
    if save_managed_state(&state).is_err() {
        apply_failed = true;
    }
    for deployment_report in &mut reports {
        deployment_report.device_fingerprint = fingerprint.clone();
    }
    let report_failed = enqueue_reports(reports).is_err() || !flush_reports(endpoint, token);
    if apply_failed || report_failed {
        client_state.failure_count = client_state.failure_count.saturating_add(1);
        client_state.next_attempt_at =
            now.saturating_add(next_backoff_seconds(client_state.failure_count - 1));
        let _ = save_client_state(&client_state);
        return 1;
    }
    if etag.is_some() {
        client_state.etag = etag;
    }
    client_state.failure_count = 0;
    client_state.next_attempt_at = now.saturating_add(60);
    save_client_state(&client_state).map(|_| 0).unwrap_or(1)
}

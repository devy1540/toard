use crate::credentials::{self, Credentials};
use fs2::FileExt;
use sha2::{Digest, Sha256};
use std::fmt;
use std::fs::{self, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use url::Url;

#[derive(Debug)]
pub enum TargetError {
    InvalidEndpoint(String),
    InvalidCredentials(&'static str),
    MissingHome,
    Io(io::Error),
}

impl fmt::Display for TargetError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidEndpoint(message) => write!(formatter, "invalid endpoint: {message}"),
            Self::InvalidCredentials(message) => {
                write!(formatter, "invalid credentials: {message}")
            }
            Self::MissingHome => write!(formatter, "home directory is unavailable"),
            Self::Io(error) => write!(formatter, "target storage error: {error}"),
        }
    }
}

impl std::error::Error for TargetError {}

impl From<io::Error> for TargetError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

pub fn normalize_endpoint(value: &str) -> Result<String, TargetError> {
    let mut url = Url::parse(value.trim())
        .map_err(|_| TargetError::InvalidEndpoint("expected an absolute URL".into()))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(TargetError::InvalidEndpoint(
            "scheme must be http or https".into(),
        ));
    }
    if url.host_str().is_none() {
        return Err(TargetError::InvalidEndpoint("host is required".into()));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(TargetError::InvalidEndpoint(
            "userinfo is not allowed".into(),
        ));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(TargetError::InvalidEndpoint(
            "query and fragment are not allowed".into(),
        ));
    }

    if matches!(
        (url.scheme(), url.port()),
        ("https", Some(443)) | ("http", Some(80))
    ) {
        url.set_port(None)
            .map_err(|_| TargetError::InvalidEndpoint("invalid port".into()))?;
    }
    let trimmed_path = url.path().trim_end_matches('/');
    let path = if trimmed_path.is_empty() {
        "/".to_string()
    } else {
        trimmed_path.to_string()
    };
    url.set_path(&path);

    let mut normalized = url.to_string();
    if path == "/" {
        normalized.pop();
    }
    Ok(normalized)
}

pub fn target_id(normalized_endpoint: &str) -> String {
    format!("{:x}", Sha256::digest(normalized_endpoint.as_bytes()))
}

pub fn normalize_origin(value: &str) -> Result<String, TargetError> {
    let url = Url::parse(value.trim())
        .map_err(|_| TargetError::InvalidEndpoint("UI origin must be an absolute URL".into()))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(TargetError::InvalidEndpoint(
            "UI origin must use http or https and include a host".into(),
        ));
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err(TargetError::InvalidEndpoint(
            "UI origin must not include credentials, path, query, or fragment".into(),
        ));
    }
    Ok(url.origin().ascii_serialization())
}

#[derive(Clone, Debug)]
pub struct Target {
    pub id: String,
    pub revision: String,
    pub endpoint: String,
    pub credentials_path: PathBuf,
    pub state_dir: PathBuf,
    pub credentials: Credentials,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RemoveResult {
    pub removed: bool,
    pub remaining: usize,
}

pub struct TargetStore {
    root: PathBuf,
}

impl TargetStore {
    pub fn from_root(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn from_home() -> Result<Self, TargetError> {
        let home = crate::fsx::home_dir().ok_or(TargetError::MissingHome)?;
        Ok(Self::from_root(home.join(".toard")))
    }

    pub fn targets_dir(&self) -> PathBuf {
        self.root.join("targets")
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn load_or_migrate(&self) -> Result<Vec<Target>, TargetError> {
        self.with_lock(|| match self.migrate_legacy_unlocked() {
            Ok(()) => {
                self.ensure_registry_revisions_unlocked()?;
                self.load_unlocked()
            }
            Err(migration_error) => {
                self.ensure_registry_revisions_unlocked()?;
                let mut targets = self.load_unlocked()?;
                if let Ok(fallback) = self.legacy_fallback() {
                    if !targets.iter().any(|target| target.id == fallback.id) {
                        targets.push(fallback);
                        targets.sort_by(|left, right| left.id.cmp(&right.id));
                    }
                }
                if targets.is_empty() {
                    Err(migration_error)
                } else {
                    Ok(targets)
                }
            }
        })
    }

    pub fn load_readonly(&self) -> Result<Vec<Target>, TargetError> {
        let mut targets = self.load_unlocked()?;
        if self.root.join("credentials").is_file() {
            match self.legacy_fallback() {
                Ok(fallback) => {
                    if let Some(existing) =
                        targets.iter_mut().find(|target| target.id == fallback.id)
                    {
                        *existing = fallback;
                    } else {
                        targets.push(fallback);
                    }
                }
                Err(error) if targets.is_empty() => return Err(error),
                Err(_) => {}
            }
            targets.sort_by(|left, right| left.id.cmp(&right.id));
        }
        Ok(targets)
    }

    pub fn upsert(&self, mut credentials: Credentials) -> Result<Target, TargetError> {
        self.with_lock(|| {
            self.migrate_before_write_unlocked()?;
            self.write_target_unlocked(&mut credentials)
        })
    }

    pub fn upsert_installer(
        &self,
        mut credentials: Credentials,
        update_content_since: bool,
    ) -> Result<Target, TargetError> {
        self.with_lock(|| {
            self.migrate_before_write_unlocked()?;
            let endpoint = validate_credentials(&credentials)?;
            let credentials_path = self
                .targets_dir()
                .join(target_id(&endpoint))
                .join("credentials");
            if let Ok(content) = fs::read_to_string(credentials_path) {
                let existing = credentials::parse(&content);
                if !update_content_since {
                    credentials.collect_content_since = existing.collect_content_since;
                }
                if credentials.content_owner_id.is_none() {
                    credentials.content_owner_id = existing.content_owner_id;
                }
                if credentials.content_key_version.is_none() {
                    credentials.content_key_version = existing.content_key_version;
                }
                if credentials.content_device_id.is_none() {
                    credentials.content_device_id = existing.content_device_id;
                }
                if credentials.ui_origin.is_none() {
                    credentials.ui_origin = existing.ui_origin;
                }
            }
            self.write_target_unlocked(&mut credentials)
        })
    }

    fn migrate_before_write_unlocked(&self) -> Result<(), TargetError> {
        match self.migrate_legacy_unlocked() {
            Ok(()) => Ok(()),
            Err(migration_error) => {
                self.ensure_registry_revisions_unlocked()?;
                let has_valid_registry = !self.load_unlocked()?.is_empty();
                let malformed_legacy = matches!(
                    migration_error,
                    TargetError::InvalidCredentials(_) | TargetError::InvalidEndpoint(_)
                );
                if has_valid_registry && malformed_legacy {
                    Ok(())
                } else {
                    Err(migration_error)
                }
            }
        }
    }

    fn write_target_unlocked(&self, credentials: &mut Credentials) -> Result<Target, TargetError> {
        let endpoint = validate_credentials(credentials)?;
        credentials.endpoint = Some(endpoint.clone());
        if let Some(ui_origin) = credentials.ui_origin.as_deref() {
            credentials.ui_origin = Some(normalize_origin(ui_origin)?);
        }

        let id = target_id(&endpoint);
        let target_dir = self.targets_dir().join(&id);
        let state_dir = target_dir.join("state");
        create_private_dir(&target_dir)?;
        create_private_dir(&state_dir)?;
        let revision = write_new_revision(&target_dir, &endpoint)?;
        let credentials_path = target_dir.join("credentials");
        crate::fsx::write_atomic(
            &credentials_path,
            &credentials::serialize(credentials),
            0o600,
        )?;
        initialize_enabled_since(&state_dir, credentials)?;
        let _ = fs::remove_file(self.root.join("cleanup-pending"));

        Ok(Target {
            id,
            revision,
            endpoint,
            credentials_path,
            state_dir,
            credentials: credentials.clone(),
        })
    }

    pub fn remove(&self, endpoint: &str) -> Result<RemoveResult, TargetError> {
        let endpoint = normalize_endpoint(endpoint)?;
        let id = target_id(&endpoint);
        self.with_lock(|| {
            let path = self.targets_dir().join(&id);
            let targets = self.load_unlocked()?;
            let registered = targets.iter().any(|target| target.id == id);
            let remaining = if registered {
                targets.len() - 1
            } else {
                targets.len()
            };
            let pending_path = self.root.join("cleanup-pending");
            if registered && remaining == 0 {
                crate::fsx::write_atomic(&pending_path, &format!("{endpoint}\n"), 0o600)?;
            }
            if registered {
                fs::remove_dir_all(&path)?;
            }
            let mut removed = registered;
            if !registered && remaining == 0 {
                removed = fs::read_to_string(&pending_path)
                    .ok()
                    .and_then(|value| normalize_endpoint(value.trim()).ok())
                    .is_some_and(|pending| pending == endpoint);
            } else if remaining > 0 {
                let _ = fs::remove_file(&pending_path);
            }
            Ok(RemoveResult { removed, remaining })
        })
    }

    pub fn activate_e2ee(
        &self,
        id: &str,
        owner_id: &str,
        key_version: u16,
        device_id: &str,
        expected_revision: &str,
    ) -> Result<(), TargetError> {
        if id.len() != 64 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(TargetError::InvalidCredentials("target id is invalid"));
        }
        if owner_id.is_empty()
            || device_id.is_empty()
            || key_version == 0
            || owner_id.contains(['\r', '\n'])
            || device_id.contains(['\r', '\n'])
        {
            return Err(TargetError::InvalidCredentials("E2EE metadata is invalid"));
        }
        self.with_lock(|| {
            let target_dir = self.targets_dir().join(id);
            let revision = read_revision(&target_dir)?;
            if revision != expected_revision {
                return Err(TargetError::InvalidCredentials(
                    "target credentials changed during E2EE setup",
                ));
            }
            let credentials_path = target_dir.join("credentials");
            let content = fs::read_to_string(&credentials_path).map_err(|error| {
                if error.kind() == io::ErrorKind::NotFound {
                    TargetError::InvalidCredentials("target no longer exists")
                } else {
                    error.into()
                }
            })?;
            let mut credentials = credentials::parse(&content);
            let endpoint = validate_credentials(&credentials)?;
            if target_id(&endpoint) != id {
                return Err(TargetError::InvalidCredentials(
                    "stored target identity is invalid",
                ));
            }
            credentials.collect_content = credentials::ContentCollectionMode::LegacyE2eeV1;
            credentials.content_owner_id = Some(owner_id.to_string());
            credentials.content_key_version = Some(key_version);
            credentials.content_device_id = Some(device_id.to_string());
            crate::fsx::write_atomic(
                &credentials_path,
                &credentials::serialize(&credentials),
                0o600,
            )?;
            initialize_enabled_since(&target_dir.join("state"), &credentials)
        })
    }

    fn with_lock<T>(
        &self,
        operation: impl FnOnce() -> Result<T, TargetError>,
    ) -> Result<T, TargetError> {
        create_private_dir(&self.root)?;
        create_private_dir(&self.targets_dir())?;
        let lock_path = self.root.join("registry.lock");
        let lock = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(lock_path)?;
        crate::fsx::set_mode(&self.root.join("registry.lock"), 0o600)?;
        FileExt::lock_exclusive(&lock)?;
        let result = operation();
        let unlock_result = FileExt::unlock(&lock);
        result.and_then(|value| {
            unlock_result?;
            Ok(value)
        })
    }

    fn load_unlocked(&self) -> Result<Vec<Target>, TargetError> {
        let mut targets = Vec::new();
        if !self.targets_dir().is_dir() {
            return Ok(targets);
        }
        for entry in fs::read_dir(self.targets_dir())? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let id = entry.file_name().to_string_lossy().into_owned();
            if id.len() != 64 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                continue;
            }
            let credentials_path = entry.path().join("credentials");
            let content = match fs::read_to_string(&credentials_path) {
                Ok(content) => content,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            let mut credentials = credentials::parse(&content);
            let endpoint =
                credentials
                    .endpoint
                    .as_deref()
                    .ok_or(TargetError::InvalidCredentials(
                        "stored endpoint is missing",
                    ))?;
            let endpoint = normalize_endpoint(endpoint)?;
            if let Some(ui_origin) = credentials.ui_origin.as_deref() {
                credentials.ui_origin = Some(normalize_origin(ui_origin)?);
            }
            if target_id(&endpoint) != id || credentials.token.is_none() {
                return Err(TargetError::InvalidCredentials(
                    "stored target identity is invalid",
                ));
            }
            targets.push(Target {
                id,
                revision: read_revision(&entry.path()).unwrap_or_default(),
                endpoint,
                credentials_path,
                state_dir: entry.path().join("state"),
                credentials,
            });
        }
        targets.sort_by(|left, right| left.id.cmp(&right.id));
        Ok(targets)
    }

    fn ensure_registry_revisions_unlocked(&self) -> Result<(), TargetError> {
        if !self.targets_dir().is_dir() {
            return Ok(());
        }
        for entry in fs::read_dir(self.targets_dir())? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let credentials_path = entry.path().join("credentials");
            let Ok(content) = fs::read_to_string(credentials_path) else {
                continue;
            };
            let credentials = credentials::parse(&content);
            let Ok(endpoint) = validate_credentials(&credentials) else {
                continue;
            };
            if target_id(&endpoint) == entry.file_name().to_string_lossy() {
                ensure_revision(&entry.path(), &endpoint)?;
            }
        }
        Ok(())
    }

    fn legacy_fallback(&self) -> Result<Target, TargetError> {
        let credentials_path = self.root.join("credentials");
        let content = fs::read_to_string(&credentials_path)?;
        let mut credentials = credentials::parse(&content);
        let endpoint = validate_credentials(&credentials)?;
        credentials.endpoint = Some(endpoint.clone());
        Ok(Target {
            id: target_id(&endpoint),
            revision: String::new(),
            endpoint,
            credentials_path,
            state_dir: self.root.join("state"),
            credentials,
        })
    }

    fn migrate_legacy_unlocked(&self) -> Result<(), TargetError> {
        let legacy_credentials_path = self.root.join("credentials");
        if !legacy_credentials_path.is_file() {
            return Ok(());
        }

        let content = fs::read_to_string(&legacy_credentials_path)?;
        let mut credentials = credentials::parse(&content);
        let endpoint = validate_credentials(&credentials)?;
        credentials.endpoint = Some(endpoint.clone());
        let id = target_id(&endpoint);
        let target_dir = self.targets_dir().join(&id);
        let target_state = target_dir.join("state");
        let legacy_state = self.root.join("state");

        if target_dir.exists() {
            create_private_dir(&target_dir)?;
            create_private_dir(&target_state)?;
            if let Ok(existing_content) = fs::read_to_string(target_dir.join("credentials")) {
                let existing = credentials::parse(&existing_content);
                merge_unmentioned_legacy_fields(&content, &mut credentials, &existing);
            }
            copy_legacy_state(&legacy_state, &target_state)?;
            write_new_revision(&target_dir, &endpoint)?;
            crate::fsx::write_atomic(
                &target_dir.join("credentials"),
                &credentials::serialize(&credentials),
                0o600,
            )?;
        } else {
            let staging = self.targets_dir().join(format!(
                ".migrate-{}-{}",
                std::process::id(),
                unique_stamp()
            ));
            let staged_state = staging.join("state");
            let staged_result = (|| -> Result<(), TargetError> {
                create_private_dir(&staging)?;
                create_private_dir(&staged_state)?;
                crate::fsx::write_atomic(
                    &staging.join("credentials"),
                    &credentials::serialize(&credentials),
                    0o600,
                )?;
                write_new_revision(&staging, &endpoint)?;
                copy_legacy_state(&legacy_state, &staged_state)?;
                validate_readable_tree(&staging)?;
                fs::rename(&staging, &target_dir)?;
                Ok(())
            })();
            if staged_result.is_err() {
                let _ = fs::remove_dir_all(&staging);
            }
            staged_result?;
        }
        initialize_enabled_since(&target_state, &credentials)?;
        let _ = fs::remove_file(self.root.join("cleanup-pending"));

        let backup = self.root.join("legacy-backup").join(unique_stamp());
        create_private_dir(&backup)?;
        move_to_backup(&legacy_credentials_path, &backup.join("credentials"))?;
        let mut moved = vec!["credentials".to_string()];
        for relative in legacy_state_paths(&legacy_state)? {
            let source = legacy_state.join(&relative);
            if !source.exists() {
                continue;
            }
            let destination = backup.join("state").join(&relative);
            move_to_backup(&source, &destination)?;
            moved.push(format!("state/{}", relative.display()));
        }
        let marker = format!(
            "endpoint={endpoint}\ntarget_id={id}\nfiles={}\n",
            moved.join(",")
        );
        crate::fsx::write_atomic(&backup.join("migration.txt"), &marker, 0o600)?;
        Ok(())
    }
}

fn initialize_enabled_since(
    state_dir: &Path,
    credentials: &Credentials,
) -> Result<(), TargetError> {
    initialize_enabled_since_at(state_dir, credentials, crate::bg::now_unix_ms())
}

fn initialize_enabled_since_at(
    state_dir: &Path,
    credentials: &Credentials,
    now_ms: i64,
) -> Result<(), TargetError> {
    create_private_dir(state_dir)?;
    if credentials.collect_content.is_enabled()
        && credentials.collect_content_since.is_none()
        && !state_dir.join("content-since").exists()
    {
        crate::fsx::write_atomic(
            &state_dir.join("content-since"),
            &format!("{now_ms}\n"),
            0o600,
        )?;
    }
    if credentials.collect_tools && !state_dir.join("tool-since").exists() {
        crate::fsx::write_atomic(&state_dir.join("tool-since"), &format!("{now_ms}\n"), 0o600)?;
    }
    Ok(())
}

fn has_key(content: &str, expected: &str) -> bool {
    content.lines().any(|line| {
        let line = line.trim();
        !line.starts_with('#')
            && line
                .split_once('=')
                .is_some_and(|(key, _)| key.trim() == expected)
    })
}

fn merge_unmentioned_legacy_fields(
    source: &str,
    incoming: &mut Credentials,
    existing: &Credentials,
) {
    let preserve_e2ee = existing.collect_content
        == credentials::ContentCollectionMode::LegacyE2eeV1
        && incoming.collect_content != credentials::ContentCollectionMode::LegacyE2eeV1;
    if !has_key(source, "collect_content") {
        incoming.collect_content = existing.collect_content;
    }
    if !has_key(source, "collect_content_since") {
        incoming.collect_content_since = existing.collect_content_since.clone();
    }
    if !has_key(source, "collect_tools") {
        incoming.collect_tools = existing.collect_tools;
    }
    if !has_key(source, "content_owner_id") {
        incoming.content_owner_id = existing.content_owner_id.clone();
    }
    if !has_key(source, "content_key_version") {
        incoming.content_key_version = existing.content_key_version;
    }
    if !has_key(source, "content_device_id") {
        incoming.content_device_id = existing.content_device_id.clone();
    }
    if preserve_e2ee {
        incoming.collect_content = credentials::ContentCollectionMode::LegacyE2eeV1;
        incoming.collect_content_since = existing.collect_content_since.clone();
        incoming.content_owner_id = existing.content_owner_id.clone();
        incoming.content_key_version = existing.content_key_version;
        incoming.content_device_id = existing.content_device_id.clone();
    }
}

fn ensure_revision(target_dir: &Path, endpoint: &str) -> Result<String, TargetError> {
    let path = target_dir.join("revision");
    if let Ok(value) = fs::read_to_string(&path) {
        let value = value.trim();
        if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Ok(value.to_string());
        }
    }
    write_new_revision(target_dir, endpoint)
}

fn write_new_revision(target_dir: &Path, endpoint: &str) -> Result<String, TargetError> {
    let seed = format!("{endpoint}\n{}\n{}", unique_stamp(), std::process::id());
    let value = format!("{:x}", Sha256::digest(seed.as_bytes()));
    crate::fsx::write_atomic(&target_dir.join("revision"), &format!("{value}\n"), 0o600)?;
    Ok(value)
}

fn read_revision(target_dir: &Path) -> Result<String, TargetError> {
    let value = fs::read_to_string(target_dir.join("revision"))?;
    let value = value.trim();
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(TargetError::InvalidCredentials(
            "target revision is invalid",
        ));
    }
    Ok(value.to_string())
}

fn create_private_dir(path: &Path) -> Result<(), TargetError> {
    fs::create_dir_all(path)?;
    crate::fsx::set_mode(path, 0o700)?;
    Ok(())
}

fn validate_credentials(credentials: &Credentials) -> Result<String, TargetError> {
    credentials
        .token
        .as_deref()
        .filter(|value| !value.trim().is_empty() && !value.contains(['\r', '\n']))
        .ok_or(TargetError::InvalidCredentials("token is required"))?;
    let endpoint = credentials
        .endpoint
        .as_deref()
        .filter(|value| !value.contains(['\r', '\n']))
        .ok_or(TargetError::InvalidCredentials("endpoint is required"))?;
    normalize_endpoint(endpoint)
}

fn unique_stamp() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .to_string()
}

fn legacy_state_paths(state_dir: &Path) -> Result<Vec<PathBuf>, TargetError> {
    if !state_dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut paths = Vec::new();
    if state_dir.join("cursors").exists() {
        paths.push(PathBuf::from("cursors"));
    }
    for name in ["content-since", "tool-since", "tool-inventory.json"] {
        if state_dir.join(name).exists() {
            paths.push(PathBuf::from(name));
        }
    }
    for entry in fs::read_dir(state_dir)? {
        let entry = entry?;
        let name = entry.file_name();
        if name.to_string_lossy().starts_with("unsupported-") {
            paths.push(PathBuf::from(name));
        }
    }
    paths.sort();
    paths.dedup();
    Ok(paths)
}

fn copy_legacy_state(source: &Path, destination: &Path) -> Result<(), TargetError> {
    create_private_dir(destination)?;
    for relative in legacy_state_paths(source)? {
        copy_missing(&source.join(&relative), &destination.join(relative))?;
    }
    Ok(())
}

fn copy_missing(source: &Path, destination: &Path) -> Result<(), TargetError> {
    if destination.exists() {
        if source.is_dir() && destination.is_dir() {
            for entry in fs::read_dir(source)? {
                let entry = entry?;
                copy_missing(&entry.path(), &destination.join(entry.file_name()))?;
            }
        }
        return Ok(());
    }
    if source.is_dir() {
        create_private_dir(destination)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy_missing(&entry.path(), &destination.join(entry.file_name()))?;
        }
    } else {
        if let Some(parent) = destination.parent() {
            create_private_dir(parent)?;
        }
        fs::copy(source, destination)?;
        crate::fsx::set_mode(destination, 0o600)?;
    }
    Ok(())
}

fn validate_readable_tree(path: &Path) -> Result<(), TargetError> {
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            validate_readable_tree(&entry.path())?;
        } else {
            fs::read(entry.path())?;
        }
    }
    Ok(())
}

fn move_to_backup(source: &Path, destination: &Path) -> Result<(), TargetError> {
    if let Some(parent) = destination.parent() {
        create_private_dir(parent)?;
    }
    fs::rename(source, destination)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::Credentials;
    use std::fs;
    use std::path::{Path, PathBuf};

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new(name: &str) -> Self {
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "toard-targets-{name}-{}-{nonce}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn credentials(token: &str, endpoint: &str) -> Credentials {
        Credentials {
            token: Some(token.into()),
            endpoint: Some(endpoint.into()),
            ..Credentials::default()
        }
    }

    #[test]
    fn normalizes_equivalent_endpoints_to_one_target_id() {
        let a = normalize_endpoint("HTTPS://Toard.Example:443/api/").unwrap();
        let b = normalize_endpoint("https://toard.example/api").unwrap();

        assert_eq!(a, "https://toard.example/api");
        assert_eq!(a, b);
        assert_eq!(target_id(&a), target_id(&b));
    }

    #[test]
    fn normalizes_ui_origin_and_rejects_path_components() {
        assert_eq!(
            normalize_origin("HTTPS://Dashboard.Example:443/").unwrap(),
            "https://dashboard.example"
        );
        for value in [
            "https://dashboard.example/team",
            "https://user@dashboard.example",
            "https://dashboard.example?team=1",
        ] {
            assert!(normalize_origin(value).is_err(), "accepted {value}");
        }
    }

    #[test]
    fn rejects_ambiguous_endpoint_components() {
        for value in [
            "https://user@toard.example/api",
            "https://toard.example/api?team=1",
            "https://toard.example/api#fragment",
            "not-a-url",
        ] {
            assert!(normalize_endpoint(value).is_err(), "accepted {value}");
        }
    }

    #[test]
    fn upsert_updates_one_target_without_resetting_state() {
        let temp = TempRoot::new("upsert");
        let store = TargetStore::from_root(temp.path().join(".toard"));
        let first = store
            .upsert(credentials("company", "https://company.example/api"))
            .unwrap();
        fs::create_dir_all(first.state_dir.join("cursors")).unwrap();
        fs::write(first.state_dir.join("cursors/codex.json"), "cursor-v1").unwrap();

        let updated = store
            .upsert(credentials("company-new", "https://company.example/api/"))
            .unwrap();
        let personal = store
            .upsert(credentials("personal", "https://personal.example/api"))
            .unwrap();

        assert_eq!(first.id, updated.id);
        assert_ne!(updated.id, personal.id);
        assert_eq!(
            fs::read_to_string(updated.state_dir.join("cursors/codex.json")).unwrap(),
            "cursor-v1"
        );
        let targets = store.load_or_migrate().unwrap();
        assert_eq!(targets.len(), 2);
        assert!(targets.windows(2).all(|pair| pair[0].id < pair[1].id));
    }

    #[test]
    fn upsert_records_enable_time_once_for_content_and_tools() {
        let temp = TempRoot::new("enable-since");
        let store = TargetStore::from_root(temp.path().join(".toard"));
        let mut enabled = credentials("company", "https://company.example/api");
        enabled.collect_content = crate::credentials::ContentCollectionMode::ServerManaged;

        let target = store.upsert(enabled.clone()).unwrap();
        let content_since = fs::read_to_string(target.state_dir.join("content-since")).unwrap();
        let tool_since = fs::read_to_string(target.state_dir.join("tool-since")).unwrap();
        assert!(content_since.trim().parse::<i64>().unwrap() > 0);
        assert!(tool_since.trim().parse::<i64>().unwrap() > 0);

        fs::write(target.state_dir.join("content-since"), "111\n").unwrap();
        fs::write(target.state_dir.join("tool-since"), "222\n").unwrap();
        store.upsert(enabled).unwrap();
        assert_eq!(
            fs::read_to_string(target.state_dir.join("content-since")).unwrap(),
            "111\n"
        );
        assert_eq!(
            fs::read_to_string(target.state_dir.join("tool-since")).unwrap(),
            "222\n"
        );
    }

    #[test]
    fn enable_cutoffs_preserve_millisecond_precision() {
        let temp = TempRoot::new("enable-since-ms");
        let state = temp.path().join("state");
        let mut enabled = credentials("company", "https://company.example/api");
        enabled.collect_content = crate::credentials::ContentCollectionMode::ServerManaged;

        initialize_enabled_since_at(&state, &enabled, 1_700_000_000_987).unwrap();

        assert_eq!(
            fs::read_to_string(state.join("content-since")).unwrap(),
            "1700000000987\n"
        );
        assert_eq!(
            fs::read_to_string(state.join("tool-since")).unwrap(),
            "1700000000987\n"
        );
    }

    #[test]
    fn remove_reports_missing_and_last_target_without_broad_cleanup() {
        let temp = TempRoot::new("remove");
        let store = TargetStore::from_root(temp.path().join(".toard"));
        store
            .upsert(credentials("company", "https://company.example/api"))
            .unwrap();

        assert_eq!(
            store.remove("https://missing.example/api").unwrap(),
            RemoveResult {
                removed: false,
                remaining: 1,
            }
        );
        assert_eq!(
            store.remove("https://company.example/api").unwrap(),
            RemoveResult {
                removed: true,
                remaining: 0,
            }
        );
        assert_eq!(
            store.remove("https://company.example/api").unwrap(),
            RemoveResult {
                removed: true,
                remaining: 0,
            },
            "last-target cleanup must remain retryable"
        );
        assert_eq!(
            store.remove("https://missing.example/api").unwrap(),
            RemoveResult {
                removed: false,
                remaining: 0,
            }
        );
        assert!(store.targets_dir().is_dir());
    }

    #[test]
    fn last_target_is_not_deleted_when_cleanup_receipt_cannot_be_written() {
        let temp = TempRoot::new("remove-receipt-failure");
        let root = temp.path().join(".toard");
        let store = TargetStore::from_root(root.clone());
        let target = store
            .upsert(credentials("company", "https://company.example/api"))
            .unwrap();
        fs::create_dir(root.join("cleanup-pending")).unwrap();

        assert!(store.remove("https://company.example/api").is_err());
        assert!(target.credentials_path.is_file());
    }

    #[test]
    fn orphan_directory_never_counts_as_the_last_registered_target() {
        let temp = TempRoot::new("remove-orphan");
        let root = temp.path().join(".toard");
        let store = TargetStore::from_root(root.clone());
        let registered = store
            .upsert(credentials("company", "https://company.example/api"))
            .unwrap();
        let orphan_id = target_id("https://orphan.example/api");
        fs::create_dir_all(root.join("targets").join(orphan_id)).unwrap();

        assert_eq!(
            store.remove("https://orphan.example/api").unwrap(),
            RemoveResult {
                removed: false,
                remaining: 1,
            }
        );
        assert!(registered.credentials_path.is_file());
    }

    fn write_legacy_fixture(root: &Path, token: &str, endpoint: &str) {
        fs::create_dir_all(root.join("state/cursors")).unwrap();
        fs::write(
            root.join("credentials"),
            format!("agent_key={token}\nendpoint={endpoint}\ncollect_content=off\n"),
        )
        .unwrap();
        fs::write(root.join("state/cursors/codex.json"), "legacy-cursor").unwrap();
        fs::write(root.join("state/content-since"), "2026-07-01").unwrap();
        fs::write(root.join("state/tool-since"), "2026-07-02").unwrap();
        fs::write(root.join("state/tool-inventory.json"), "inventory").unwrap();
        fs::write(root.join("state/unsupported-tool-events"), "stamp").unwrap();
        fs::write(root.join("state/last-collect"), "global-stamp").unwrap();
    }

    #[test]
    fn migrates_legacy_target_state_before_loading_registry() {
        let temp = TempRoot::new("migration");
        let root = temp.path().join(".toard");
        write_legacy_fixture(&root, "company", "https://company.example/api");
        let store = TargetStore::from_root(root.clone());

        let targets = store.load_or_migrate().unwrap();

        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].credentials.token.as_deref(), Some("company"));
        assert_eq!(
            fs::read_to_string(targets[0].state_dir.join("cursors/codex.json")).unwrap(),
            "legacy-cursor"
        );
        assert!(targets[0].state_dir.join("tool-inventory.json").is_file());
        assert!(targets[0]
            .state_dir
            .join("unsupported-tool-events")
            .is_file());
        assert!(root
            .join("legacy-backup")
            .read_dir()
            .unwrap()
            .next()
            .is_some());
        assert!(!root.join("credentials").exists());
        assert_eq!(
            fs::read_to_string(root.join("state/last-collect")).unwrap(),
            "global-stamp"
        );
    }

    #[test]
    fn reimport_updates_credentials_without_overwriting_existing_cursor() {
        let temp = TempRoot::new("reimport");
        let root = temp.path().join(".toard");
        let store = TargetStore::from_root(root.clone());
        let target = store
            .upsert(credentials("company-old", "https://company.example/api"))
            .unwrap();
        fs::create_dir_all(target.state_dir.join("cursors")).unwrap();
        fs::write(target.state_dir.join("cursors/codex.json"), "new-cursor").unwrap();
        write_legacy_fixture(&root, "company-new", "https://company.example/api/");

        let targets = store.load_or_migrate().unwrap();

        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].credentials.token.as_deref(), Some("company-new"));
        assert_eq!(
            fs::read_to_string(targets[0].state_dir.join("cursors/codex.json")).unwrap(),
            "new-cursor"
        );
    }

    #[test]
    fn reimport_preserves_unmentioned_policy_and_e2ee_metadata() {
        let temp = TempRoot::new("reimport-metadata");
        let root = temp.path().join(".toard");
        let store = TargetStore::from_root(root.clone());
        let mut active = credentials("company-old", "https://company.example/api");
        active.collect_content = crate::credentials::ContentCollectionMode::LegacyE2eeV1;
        active.collect_content_since = Some("all".into());
        active.collect_tools = false;
        active.content_owner_id = Some("owner-1".into());
        active.content_key_version = Some(7);
        active.content_device_id = Some("device-1".into());
        store.upsert(active).unwrap();
        fs::write(
            root.join("credentials"),
            "agent_key=company-new\nendpoint=https://company.example/api/\ncollect_content=true\ncollect_tools=true\n",
        )
        .unwrap();

        let targets = store.load_or_migrate().unwrap();

        assert_eq!(targets[0].credentials.token.as_deref(), Some("company-new"));
        assert_eq!(
            targets[0].credentials.collect_content,
            crate::credentials::ContentCollectionMode::LegacyE2eeV1
        );
        assert_eq!(
            targets[0].credentials.collect_content_since.as_deref(),
            Some("all")
        );
        assert!(targets[0].credentials.collect_tools);
        assert_eq!(
            targets[0].credentials.content_owner_id.as_deref(),
            Some("owner-1")
        );
        assert_eq!(targets[0].credentials.content_key_version, Some(7));
        assert_eq!(
            targets[0].credentials.content_device_id.as_deref(),
            Some("device-1")
        );
    }

    #[test]
    fn locked_e2ee_activation_rejects_updated_or_recreated_target() {
        let temp = TempRoot::new("e2ee-update");
        let root = temp.path().join(".toard");
        let store = TargetStore::from_root(root);
        let first = store
            .upsert(credentials("old-token", "https://company.example/api"))
            .unwrap();
        let updated = store
            .upsert(credentials("new-token", "https://company.example/api"))
            .unwrap();

        assert_ne!(updated.revision, first.revision);
        assert!(store
            .activate_e2ee(&first.id, "owner-1", 3, "device-1", &first.revision)
            .is_err());
        let current = store.load_or_migrate().unwrap().remove(0);
        assert_eq!(current.credentials.token.as_deref(), Some("new-token"));
        assert!(current.credentials.content_owner_id.is_none());

        store
            .activate_e2ee(&updated.id, "owner-1", 3, "device-1", &updated.revision)
            .unwrap();

        store.remove("https://company.example/api").unwrap();
        let replacement = store
            .upsert(credentials(
                "replacement-token",
                "https://company.example/api",
            ))
            .unwrap();
        assert_ne!(replacement.revision, updated.revision);
        assert!(store
            .activate_e2ee(&updated.id, "owner-2", 4, "device-2", &updated.revision)
            .is_err());
        let current = store.load_or_migrate().unwrap().remove(0);
        assert_eq!(
            current.credentials.token.as_deref(),
            Some("replacement-token")
        );
        assert_eq!(
            current.credentials.collect_content,
            crate::credentials::ContentCollectionMode::Off
        );
        assert!(current.credentials.content_owner_id.is_none());
    }

    #[test]
    fn migration_failure_keeps_legacy_fallback_and_blocks_new_target() {
        let temp = TempRoot::new("fallback");
        let root = temp.path().join(".toard");
        write_legacy_fixture(&root, "company", "https://company.example/api");
        let company_id = target_id("https://company.example/api");
        fs::create_dir_all(root.join("targets")).unwrap();
        fs::write(root.join("targets").join(company_id), "blocks-directory").unwrap();
        let store = TargetStore::from_root(root.clone());

        let targets = store.load_or_migrate().unwrap();

        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].credentials_path, root.join("credentials"));
        assert_eq!(targets[0].state_dir, root.join("state"));
        assert!(store
            .upsert(credentials("personal", "https://personal.example/api"))
            .is_err());
        assert!(!store
            .targets_dir()
            .join(target_id("https://personal.example/api"))
            .exists());
    }

    #[test]
    fn invalid_legacy_credentials_do_not_block_valid_registry_targets() {
        let temp = TempRoot::new("invalid-legacy");
        let root = temp.path().join(".toard");
        let store = TargetStore::from_root(root.clone());
        store
            .upsert(credentials("personal", "https://personal.example/api"))
            .unwrap();
        fs::write(root.join("credentials"), "agent_key=partial-only\n").unwrap();

        let targets = store.load_or_migrate().unwrap();

        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].endpoint, "https://personal.example/api");
        assert!(root.join("credentials").is_file());

        store
            .upsert(credentials("second", "https://second.example/api"))
            .unwrap();
        assert_eq!(store.load_readonly().unwrap().len(), 2);
    }

    #[test]
    fn valid_legacy_io_failure_still_blocks_new_target_upsert() {
        let temp = TempRoot::new("valid-legacy-io-failure");
        let root = temp.path().join(".toard");
        let store = TargetStore::from_root(root.clone());
        store
            .upsert(credentials("personal", "https://personal.example/api"))
            .unwrap();
        write_legacy_fixture(&root, "company", "https://company.example/api");
        fs::write(
            root.join("targets")
                .join(target_id("https://company.example/api")),
            "blocks-directory",
        )
        .unwrap();

        assert!(store
            .upsert(credentials("second", "https://second.example/api"))
            .is_err());
        assert!(!store
            .targets_dir()
            .join(target_id("https://second.example/api"))
            .exists());
    }

    #[test]
    fn readonly_load_exposes_legacy_without_migrating_it() {
        let temp = TempRoot::new("readonly");
        let root = temp.path().join(".toard");
        write_legacy_fixture(&root, "company", "https://company.example/api");
        let store = TargetStore::from_root(root.clone());

        let targets = store.load_readonly().unwrap();

        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].credentials_path, root.join("credentials"));
        assert!(root.join("credentials").is_file());
        assert!(!root.join("legacy-backup").exists());
        assert!(!root.join("targets").exists());
    }

    #[cfg(unix)]
    #[test]
    fn registry_directories_and_credentials_are_private() {
        use std::os::unix::fs::PermissionsExt;

        let temp = TempRoot::new("permissions");
        let root = temp.path().join(".toard");
        let store = TargetStore::from_root(root.clone());
        let target = store
            .upsert(credentials("company", "https://company.example/api"))
            .unwrap();

        for directory in [&root, &store.targets_dir(), &target.state_dir] {
            let mode = fs::metadata(directory).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700, "unexpected mode for {}", directory.display());
        }
        let mode = fs::metadata(target.credentials_path)
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }
}

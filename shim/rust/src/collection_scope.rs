//! Local collection policy. Project IDs are opaque and never added to wire events.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub const PROVIDERS: [&str; 5] = ["claude_code", "codex", "cursor", "gemini", "qwen"];
const MAX_POLICY_BYTES: usize = 24 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScopeMode {
    All,
    Custom,
    Paused,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProviderScope {
    All {},
    Off {},
    Include { projects: BTreeSet<String> },
    Exclude { projects: BTreeSet<String> },
}

impl ProviderScope {
    pub fn is_off(&self) -> bool {
        matches!(self, Self::Off {})
    }
    pub fn is_all(&self) -> bool {
        matches!(self, Self::All {})
    }

    pub fn query_parameters(&self) -> (u8, String) {
        match self {
            Self::All {} => (0, "[]".into()),
            Self::Off {} => (1, "[]".into()),
            Self::Include { projects } => {
                (2, serde_json::to_string(projects).expect("project IDs"))
            }
            Self::Exclude { projects } => {
                (3, serde_json::to_string(projects).expect("project IDs"))
            }
        }
    }
    pub fn allows(&self, project: Option<&str>) -> bool {
        match self {
            Self::All {} => true,
            Self::Off {} => false,
            Self::Include { projects } => project.is_some_and(|id| projects.contains(id)),
            // Unknown identity is not evidence that a record is outside an exclusion.
            Self::Exclude { projects } => project.is_some_and(|id| !projects.contains(id)),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CollectionScope {
    pub schema_version: u32,
    pub mode: ScopeMode,
    pub providers: BTreeMap<String, ProviderScope>,
}

impl Default for CollectionScope {
    fn default() -> Self {
        Self {
            schema_version: 1,
            mode: ScopeMode::All,
            providers: BTreeMap::new(),
        }
    }
}

impl CollectionScope {
    pub fn paused() -> Self {
        Self {
            mode: ScopeMode::Paused,
            ..Self::default()
        }
    }

    /// Malformed or future saved policies must never become legacy unrestricted mode.
    pub fn invalid() -> Self {
        Self {
            schema_version: 0,
            ..Self::paused()
        }
    }

    pub fn decode(value: &str) -> Result<Self, &'static str> {
        if value.len() > MAX_POLICY_BYTES {
            return Err("collection policy is too large");
        }
        let policy: Self = serde_json::from_str(value).map_err(|_| "invalid collection policy")?;
        policy.validate()?;
        Ok(policy)
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        if self.schema_version != 1 {
            return Err("unsupported collection policy version");
        }
        if self.mode != ScopeMode::Custom && !self.providers.is_empty() {
            return Err("unexpected provider rules");
        }
        let mut total = 0;
        for (provider, rule) in &self.providers {
            if !PROVIDERS.contains(&provider.as_str()) {
                return Err("unknown collection provider");
            }
            if let ProviderScope::Include { projects } | ProviderScope::Exclude { projects } = rule
            {
                total += projects.len();
                if projects.iter().any(|id| {
                    id.len() != 64
                        || !id
                            .bytes()
                            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                }) {
                    return Err("invalid local project identity");
                }
            }
        }
        if total > 256 {
            return Err("too many project rules");
        }
        Ok(())
    }

    pub fn provider(&self, key: &str) -> &ProviderScope {
        if self.schema_version != 1 {
            return &ProviderScope::Off {};
        }
        match self.mode {
            ScopeMode::All => &ProviderScope::All {},
            ScopeMode::Paused => &ProviderScope::Off {},
            ScopeMode::Custom => self.providers.get(key).unwrap_or(&ProviderScope::Off {}),
        }
    }

    pub fn is_unrestricted(&self) -> bool {
        self.schema_version == 1 && self.mode == ScopeMode::All && self.providers.is_empty()
    }

    pub fn fingerprint(&self) -> String {
        format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(self).expect("serializable local scope"))
        )
    }

    pub fn needs_rescan(&self, state: &std::path::Path) -> bool {
        match std::fs::read_to_string(state.join("collection-scope-applied")) {
            Ok(saved) => saved.trim() != self.fingerprint(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => !self.is_unrestricted(),
            Err(_) => true,
        }
    }

    pub fn record_applied(&self, state: &std::path::Path) -> std::io::Result<()> {
        crate::fsx::write_atomic(
            &state.join("collection-scope-applied"),
            &self.fingerprint(),
            0o600,
        )
    }
}

/// Labels are only for the local confirmation window/CLI. They must not be sent
/// to the toard server, even when a project has been selected for collection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LocalProject {
    pub id: String,
    pub label: String,
    pub kind: &'static str,
}

impl LocalProject {
    pub fn valid_id(id: &str) -> bool {
        id.len() == 64
            && id
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }

    /// Local label cache for hook usage, whose journal contains only opaque IDs.
    pub fn remember(&self, state: &std::path::Path, provider: &str) -> std::io::Result<()> {
        let expected = match self.kind {
            "cwd" => Self::cwd(provider, &self.label),
            "group" => Self::group(provider, &self.label),
            _ => None,
        };
        if !PROVIDERS.contains(&provider) || expected.as_ref() != Some(self) {
            return Err(std::io::Error::other("invalid local project identity"));
        }
        let directory = state.join("local-projects").join(provider);
        let path = directory.join(format!("{}.json", self.id));
        if path.is_file() {
            return Ok(());
        }
        std::fs::create_dir_all(&directory)?;
        crate::fsx::set_mode(state, 0o700)?;
        crate::fsx::set_mode(&state.join("local-projects"), 0o700)?;
        crate::fsx::set_mode(&directory, 0o700)?;
        if std::fs::read_dir(&directory)?.take(4097).count() >= 4096 {
            return Err(std::io::Error::other("local project label cache is full"));
        }
        crate::fsx::write_atomic(
            &path,
            &serde_json::json!({ "label": self.label, "kind": self.kind }).to_string(),
            0o600,
        )
    }

    pub fn recalled(state: &std::path::Path, provider: &str, id: &str) -> Option<Self> {
        use std::io::Read;
        if !PROVIDERS.contains(&provider) || !Self::valid_id(id) {
            return None;
        }
        let path = state
            .join("local-projects")
            .join(provider)
            .join(format!("{id}.json"));
        let mut bytes = Vec::new();
        std::fs::File::open(path)
            .ok()?
            .take(8193)
            .read_to_end(&mut bytes)
            .ok()?;
        if bytes.len() > 8192 {
            return None;
        }
        let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
        let label = value.get("label")?.as_str()?;
        let project = match value
            .get("kind")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("cwd")
        {
            "cwd" => Self::cwd(provider, label)?,
            "group" => Self::group(provider, label)?,
            _ => return None,
        };
        (project.id == id).then_some(project)
    }

    pub fn cwd(provider: &str, value: &str) -> Option<Self> {
        if value.is_empty() || value.len() > 4096 || value.chars().any(char::is_control) {
            return None;
        }
        let normalized = value.replace('\\', "/");
        let absolute = normalized.starts_with('/')
            || (normalized.len() >= 3
                && normalized.as_bytes()[0].is_ascii_alphabetic()
                && normalized.as_bytes()[1..3] == *b":/");
        if !absolute {
            return None;
        }
        // Lexical normalization only. Never open project contents or require a
        // historic project directory to still exist. Preserve case and UNC roots.
        let mut parts = Vec::new();
        for part in normalized.split('/') {
            if part == "." {
                continue;
            }
            if part == ".." {
                if parts
                    .last()
                    .is_some_and(|part: &&str| !part.is_empty() && !part.ends_with(':'))
                {
                    parts.pop();
                } else {
                    return None;
                }
            } else {
                parts.push(part);
            }
        }
        let mut label = parts.join("/");
        while label.len() > 1 && label.ends_with('/') && !label.ends_with(":/") {
            label.pop();
        }
        Some(Self::make(provider, "cwd", &label))
    }

    pub fn group(provider: &str, value: &str) -> Option<Self> {
        if value.is_empty() || value.len() > 4096 || value.chars().any(char::is_control) {
            return None;
        }
        Some(Self::make(provider, "group", value))
    }

    fn make(provider: &str, kind: &'static str, value: &str) -> Self {
        let id = format!(
            "{:x}",
            Sha256::digest(format!("{provider}\0{kind}\0{value}").as_bytes())
        );
        Self {
            id,
            label: value.into(),
            kind,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restrictions_do_not_allow_unidentified_projects_or_unmentioned_providers() {
        let id = "a".repeat(64);
        let include = ProviderScope::Include {
            projects: BTreeSet::from([id.clone()]),
        };
        assert!(include.allows(Some(&id)));
        assert!(!include.allows(None));
        let exclude = ProviderScope::Exclude {
            projects: BTreeSet::from([id.clone()]),
        };
        assert!(!exclude.allows(Some(&id)));
        assert!(!exclude.allows(None));
        assert!(exclude.allows(Some(&"b".repeat(64))));
        let scope = CollectionScope {
            schema_version: 1,
            mode: ScopeMode::Custom,
            providers: BTreeMap::from([("codex".into(), include)]),
        };
        assert!(!scope.provider("gemini").allows(Some(&id)));
        assert!(!scope.is_unrestricted());
        assert!(!CollectionScope::paused().provider("codex").allows(None));
    }

    #[test]
    fn invalid_policies_fail_closed_and_raw_paths_cannot_be_project_rules() {
        for input in [
            "",
            "{}",
            r#"{"schemaVersion":2,"mode":"all","providers":{}}"#,
            r#"{"schemaVersion":1,"mode":"all","providers":{},"secret":"private"}"#,
            r#"{"schemaVersion":1,"mode":"custom","providers":{"codex":{"mode":"include","projects":["/private/path"]}}}"#,
            r#"{"schemaVersion":1,"mode":"custom","providers":{"codex":{"mode":"all","projects":[]}}}"#,
        ] {
            assert!(
                CollectionScope::decode(input).is_err(),
                "unexpectedly accepted {input}"
            );
        }
        assert!(!CollectionScope::invalid().provider("codex").allows(None));
    }

    #[test]
    fn local_identity_is_stable_without_reading_project_contents() {
        let project = LocalProject::cwd("codex", "/synthetic/does-not-exist/./project/").unwrap();
        assert_eq!(
            project,
            LocalProject::cwd("codex", "/synthetic/does-not-exist/project").unwrap()
        );
        assert_ne!(
            project.id,
            LocalProject::cwd("claude_code", &project.label).unwrap().id
        );
        assert_eq!(project.id.len(), 64);
        assert!(!project.id.contains("synthetic"));
        assert!(LocalProject::cwd("codex", "relative/path").is_none());
        assert!(LocalProject::cwd("codex", "/../../escape").is_none());
        assert!(LocalProject::cwd("codex", "C:\\synthetic\\project").is_some());
    }
}

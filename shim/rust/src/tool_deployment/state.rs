use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClientState {
    pub etag: Option<String>,
    pub failure_count: usize,
    pub next_attempt_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManagedState {
    pub schema_version: u8,
    pub items: BTreeMap<String, ManagedItem>,
}

impl Default for ManagedState {
    fn default() -> Self {
        Self {
            schema_version: 1,
            items: BTreeMap::new(),
        }
    }
}

impl ManagedState {
    pub(crate) fn manages_key(&self, key: &str) -> bool {
        self.items
            .values()
            .any(|item| item.managed_keys.contains(key))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManagedItem {
    pub catalog_item_id: String,
    pub version_id: String,
    pub last_known_good_version_id: String,
    pub managed_keys: BTreeSet<String>,
    #[serde(default)]
    pub managed_paths: BTreeSet<String>,
}

pub(crate) fn tools_dir() -> Option<std::path::PathBuf> {
    crate::fsx::home_dir().map(|home| home.join(".toard").join("tools"))
}

pub(crate) fn load_managed_state() -> ManagedState {
    tools_dir()
        .map(|directory| directory.join("state.json"))
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|body| serde_json::from_str(&body).ok())
        .unwrap_or_default()
}

pub(crate) fn save_managed_state(state: &ManagedState) -> Result<(), String> {
    let path = tools_dir()
        .ok_or_else(|| "HOME 이 없어 도구 상태를 저장할 수 없습니다".to_string())?
        .join("state.json");
    let body = serde_json::to_string_pretty(state).map_err(|error| error.to_string())?;
    crate::fsx::write_atomic(&path, &body, 0o600).map_err(|error| error.to_string())
}

pub(crate) fn load_client_state() -> ClientState {
    tools_dir()
        .map(|directory| directory.join("client-state.json"))
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|body| serde_json::from_str(&body).ok())
        .unwrap_or_default()
}

pub(crate) fn save_client_state(state: &ClientState) -> Result<(), String> {
    let path = tools_dir()
        .ok_or_else(|| "HOME 이 없어 도구 client 상태를 저장할 수 없습니다".to_string())?
        .join("client-state.json");
    let body = serde_json::to_string_pretty(state).map_err(|error| error.to_string())?;
    crate::fsx::write_atomic(&path, &body, 0o600).map_err(|error| error.to_string())
}

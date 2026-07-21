use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryItem {
    pub kind: String,
    pub item_key: String,
    pub display_name: String,
    pub source_provider: String,
    pub plugin_key: Option<String>,
    pub version: Option<String>,
    pub enabled: bool,
}

impl InventoryItem {
    pub fn new(kind: &str, name: &str, provider: &str, enabled: bool) -> Self {
        Self {
            kind: kind.to_string(),
            item_key: name.to_string(),
            display_name: name.to_string(),
            source_provider: provider.to_string(),
            plugin_key: None,
            version: None,
            enabled,
        }
    }
}

pub fn inventory_fingerprint(items: &[InventoryItem]) -> String {
    let mut sorted = items.to_vec();
    sorted.sort();
    let json = serde_json::to_vec(&sorted).unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(json);
    format!("{:x}", hasher.finalize())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InventoryBody<'a> {
    host: Option<&'a str>,
    fingerprint: String,
    observed_at: String,
    items: &'a [InventoryItem],
}

pub fn inventory_body(
    host: Option<&str>,
    device_id: &str,
    observed_at_ms: i64,
    items: &[InventoryItem],
) -> String {
    serde_json::to_string(&InventoryBody {
        host,
        fingerprint: device_id.to_owned(),
        observed_at: crate::iso::epoch_ms_to_iso(observed_at_ms),
        items,
    })
    .unwrap_or_else(|_| "{}".into())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct WatchStamp {
    path: String,
    modified_ms: i64,
    size: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct InventoryState {
    last_checked: u64,
    #[serde(default)]
    device_id: String,
    fingerprint: String,
    stamps: Vec<WatchStamp>,
}

fn random_device_id() -> String {
    rand::random::<[u8; 32]>()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub struct PendingInventory {
    pub body: String,
    state: InventoryState,
}

fn state_path() -> Option<PathBuf> {
    crate::fsx::state_dir().map(|dir| dir.join("tool-inventory.json"))
}

fn load_state() -> InventoryState {
    state_path()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save_state(state: &InventoryState) {
    let Some(path) = state_path() else { return };
    if let Ok(text) = serde_json::to_string(state) {
        let _ = crate::fsx::write_atomic(&path, &text, 0o600);
    }
}

fn watched_paths(home: &Path) -> Vec<PathBuf> {
    vec![
        home.join(".claude/settings.json"),
        home.join(".claude.json"),
        home.join(".mcp.json"),
        home.join(".codex/config.toml"),
        home.join(".codex/skills"),
        home.join(".agents/skills"),
        home.join(".claude/skills"),
        home.join(".codex/plugins/cache"),
    ]
}

fn stamps(home: &Path) -> Vec<WatchStamp> {
    watched_paths(home)
        .into_iter()
        .filter_map(|path| {
            let metadata = std::fs::metadata(&path).ok()?;
            let modified_ms = metadata
                .modified()
                .ok()?
                .duration_since(std::time::UNIX_EPOCH)
                .ok()?
                .as_millis() as i64;
            Some(WatchStamp {
                path: path
                    .strip_prefix(home)
                    .unwrap_or(&path)
                    .display()
                    .to_string(),
                modified_ms,
                size: metadata.len(),
            })
        })
        .collect()
}

fn add_json_names(
    items: &mut Vec<InventoryItem>,
    path: &Path,
    key: &str,
    kind: &str,
    provider: &str,
) {
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return;
    };
    let Some(object) = value.get(key).and_then(serde_json::Value::as_object) else {
        return;
    };
    for (name, config) in object {
        let enabled = config.as_bool().unwrap_or(true);
        let mut item = InventoryItem::new(kind, name, provider, enabled);
        if kind == "plugin" {
            item.plugin_key = Some(name.clone());
        }
        items.push(item);
    }
}

fn walk_skills(dir: &Path, provider: &str, items: &mut Vec<InventoryItem>, depth: u8) {
    if depth > 12 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_skills(&path, provider, items, depth + 1);
        } else if path.file_name().and_then(|name| name.to_str()) == Some("SKILL.md") {
            if let Some(name) = path
                .parent()
                .and_then(Path::file_name)
                .and_then(|name| name.to_str())
            {
                items.push(InventoryItem::new("skill", name, provider, true));
            }
        }
    }
}

fn add_codex_mcp(items: &mut Vec<InventoryItem>, path: &Path) {
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    for line in text.lines().map(str::trim) {
        let Some(table) = line
            .strip_prefix("[mcp_servers.")
            .and_then(|value| value.strip_suffix(']'))
        else {
            continue;
        };
        let name = table.trim_matches('"');
        if !name.is_empty() {
            items.push(InventoryItem::new("mcp", name, "codex", true));
        }
    }
}

pub fn scan_inventory(home: &Path) -> Vec<InventoryItem> {
    let mut items = Vec::new();
    add_json_names(
        &mut items,
        &home.join(".claude/settings.json"),
        "enabledPlugins",
        "plugin",
        "claude_code",
    );
    add_json_names(
        &mut items,
        &home.join(".claude.json"),
        "mcpServers",
        "mcp",
        "claude_code",
    );
    add_json_names(
        &mut items,
        &home.join(".mcp.json"),
        "mcpServers",
        "mcp",
        "claude_code",
    );
    add_codex_mcp(&mut items, &home.join(".codex/config.toml"));
    for (root, provider) in [
        (home.join(".codex/skills"), "codex"),
        (home.join(".agents/skills"), "codex"),
        (home.join(".claude/skills"), "claude_code"),
        (home.join(".codex/plugins/cache"), "codex"),
    ] {
        walk_skills(&root, provider, &mut items, 0);
    }
    let unique = items.into_iter().collect::<BTreeSet<_>>();
    unique.into_iter().collect()
}

pub fn prepare_inventory(host: Option<&str>, dry_run: bool) -> Option<PendingInventory> {
    let home = crate::fsx::home_dir()?;
    let now = crate::bg::now_unix();
    let current_stamps = stamps(&home);
    let mut state = load_state();
    let created_device_id = state.device_id.is_empty();
    if created_device_id {
        state.device_id = random_device_id();
    }
    if !created_device_id
        && state.stamps == current_stamps
        && now.saturating_sub(state.last_checked) < 24 * 60 * 60
    {
        return None;
    }
    let items = scan_inventory(&home);
    let fingerprint = inventory_fingerprint(&items);
    state.last_checked = now;
    state.stamps = current_stamps;
    if !created_device_id && fingerprint == state.fingerprint {
        if !dry_run {
            save_state(&state);
        }
        return None;
    }
    state.fingerprint = fingerprint;
    Some(PendingInventory {
        body: inventory_body(host, &state.device_id, (now * 1000) as i64, &items),
        state,
    })
}

pub fn commit_inventory(pending: PendingInventory) {
    save_state(&pending.state);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_is_stable_across_input_order() {
        let a = InventoryItem::new("skill", "brainstorming", "codex", true);
        let b = InventoryItem::new("plugin", "superpowers", "codex", true);
        assert_eq!(
            inventory_fingerprint(&[a.clone(), b.clone()]),
            inventory_fingerprint(&[b, a])
        );
    }

    #[test]
    fn serialized_inventory_has_no_sensitive_configuration_fields() {
        let item = InventoryItem::new("mcp", "context7", "claude_code", true);
        let device_id = "a".repeat(64);
        let body = inventory_body(Some("box"), &device_id, 1_783_641_600_000, &[item]);
        assert!(body.contains("context7"));
        assert!(body.contains(&device_id));
        for forbidden in ["endpoint", "command", "arguments", "output", "/Users/"] {
            assert!(!body.contains(forbidden));
        }
    }

    #[test]
    fn device_identity_is_stable_when_inventory_changes() {
        let device_id = "d".repeat(64);
        let first = inventory_body(
            Some("box"),
            &device_id,
            1_783_641_600_000,
            &[InventoryItem::new("mcp", "first", "codex", true)],
        );
        let second = inventory_body(
            Some("box"),
            &device_id,
            1_783_641_600_001,
            &[InventoryItem::new("skill", "second", "codex", true)],
        );
        let first: serde_json::Value = serde_json::from_str(&first).unwrap();
        let second: serde_json::Value = serde_json::from_str(&second).unwrap();
        assert_eq!(first["fingerprint"], second["fingerprint"]);
        assert_eq!(first["fingerprint"], device_id);
    }
}

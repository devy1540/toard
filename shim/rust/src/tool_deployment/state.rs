use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

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
}

use serde_json::{Map, Value};

use super::state::ManagedState;
use super::DeployError;

pub(crate) fn merge_managed_json_entry(
    root: &Value,
    state: &ManagedState,
    key: &str,
    entry: Value,
) -> Result<Value, DeployError> {
    let mut next = root.clone();
    let object = next
        .as_object_mut()
        .ok_or_else(|| DeployError::new("invalid_client_config"))?;
    if !object.contains_key("mcpServers") {
        object.insert("mcpServers".to_owned(), Value::Object(Map::new()));
    }
    let servers = object
        .get_mut("mcpServers")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| DeployError::new("invalid_client_config"))?;
    if servers.contains_key(key) && !state.manages_key(key) {
        return Err(DeployError::new("unmanaged_conflict"));
    }
    servers.insert(key.to_owned(), entry);
    Ok(next)
}

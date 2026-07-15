use serde_json::{Map, Value};
use toml_edit::{value, Array, DocumentMut, Item, Table};

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

pub(crate) fn merge_managed_toml_mcp(
    content: &str,
    state: &ManagedState,
    key: &str,
    command: &str,
    args: &[String],
) -> Result<String, DeployError> {
    let mut document = content
        .parse::<DocumentMut>()
        .map_err(|_| DeployError::new("invalid_client_config"))?;
    if document.get("mcp_servers").is_none() {
        document.insert("mcp_servers", Item::Table(Table::new()));
    }
    let servers = document
        .get_mut("mcp_servers")
        .and_then(Item::as_table_mut)
        .ok_or_else(|| DeployError::new("invalid_client_config"))?;
    if servers.contains_key(key) && !state.manages_key(key) {
        return Err(DeployError::new("unmanaged_conflict"));
    }
    let mut server = Table::new();
    server.insert("command", value(command));
    let mut array = Array::new();
    for argument in args {
        array.push(argument.as_str());
    }
    server.insert("args", value(array));
    servers.insert(key, Item::Table(server));
    Ok(document.to_string())
}

pub(crate) fn remove_managed_json_entry(
    root: &Value,
    state: &ManagedState,
    key: &str,
) -> Result<Value, DeployError> {
    if !state.manages_key(key) {
        return Err(DeployError::new("unmanaged_conflict"));
    }
    let mut next = root.clone();
    if let Some(servers) = next
        .as_object_mut()
        .and_then(|object| object.get_mut("mcpServers"))
        .and_then(Value::as_object_mut)
    {
        servers.remove(key);
    }
    Ok(next)
}

pub(crate) fn remove_managed_toml_mcp(
    content: &str,
    state: &ManagedState,
    key: &str,
) -> Result<String, DeployError> {
    if !state.manages_key(key) {
        return Err(DeployError::new("unmanaged_conflict"));
    }
    let mut document = content
        .parse::<DocumentMut>()
        .map_err(|_| DeployError::new("invalid_client_config"))?;
    if let Some(servers) = document
        .get_mut("mcp_servers")
        .and_then(Item::as_table_mut)
    {
        servers.remove(key);
    }
    Ok(document.to_string())
}

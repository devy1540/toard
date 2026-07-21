use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::DeployError;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpLaunchDefinition {
    pub deployment_id: String,
    pub command: String,
    pub args: Vec<String>,
    pub required_env_names: Vec<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct McpLaunch {
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub managed_client_entry: Value,
}

pub(crate) fn build_mcp_launch(
    definition: &McpLaunchDefinition,
    local_secrets: &BTreeMap<String, String>,
) -> Result<McpLaunch, DeployError> {
    let mut env = BTreeMap::new();
    for name in &definition.required_env_names {
        let value = local_secrets
            .get(name)
            .ok_or_else(|| DeployError::new("local_secret_missing"))?;
        env.insert(name.clone(), value.clone());
    }
    Ok(McpLaunch {
        command: definition.command.clone(),
        args: definition.args.clone(),
        env,
        managed_client_entry: json!({
            "command": "toard-shim",
            "args": ["tool", "run-mcp", definition.deployment_id]
        }),
    })
}

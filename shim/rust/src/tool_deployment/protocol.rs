use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeviceManifestV1 {
    pub schema_version: u8,
    pub generated_at: String,
    pub reconcile_after_seconds: u64,
    pub items: Vec<DesiredItem>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesiredItem {
    pub catalog_item_id: String,
    pub version_id: String,
    pub origin: DeploymentOrigin,
    pub rollout_id: Option<String>,
    pub manifest: ToolManifestV1,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DeploymentOrigin {
    Personal,
    Team,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolManifestV1 {
    pub schema_version: u8,
    pub catalog_item_id: String,
    pub version_id: String,
    pub slug: String,
    pub kind: String,
    pub source: ManifestSource,
    pub clients: Vec<String>,
    pub min_protocol_version: u8,
    pub permissions: ManifestPermissions,
    pub payload: InstallPayload,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManifestSource {
    pub provider: String,
    pub repository: String,
    pub exact_ref: String,
    pub path: String,
    pub tree_digest: String,
    pub download_url: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManifestPermissions {
    pub env: Vec<String>,
    pub network_hosts: Vec<String>,
    pub executables: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum InstallPayload {
    Skill {
        files: Vec<String>,
        #[serde(rename = "targetKey")]
        target_key: String,
    },
    McpStdio {
        command: String,
        args: Vec<String>,
        #[serde(rename = "requiredEnvNames")]
        required_env_names: Vec<String>,
        #[serde(rename = "managedKey")]
        managed_key: String,
    },
    McpHttp {
        url: String,
        auth: String,
        #[serde(rename = "managedKey")]
        managed_key: String,
    },
    Plugin {
        components: Vec<PluginComponent>,
    },
}

#[cfg(test)]
impl InstallPayload {
    pub(crate) fn payload_type(&self) -> &'static str {
        match self {
            Self::Skill { .. } => "skill",
            Self::McpStdio { .. } => "mcp_stdio",
            Self::McpHttp { .. } => "mcp_http",
            Self::Plugin { .. } => "plugin",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct PluginComponent {
    #[serde(rename = "type")]
    pub component_type: String,
    pub key: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DeploymentStatus {
    Queued,
    Applying,
    SettingsRequired,
    Installed,
    Conflict,
    Failed,
    RolledBack,
    Excluded,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentReport {
    pub device_fingerprint: String,
    pub catalog_item_id: String,
    pub desired_version_id: Option<String>,
    pub applied_version_id: Option<String>,
    pub status: DeploymentStatus,
    pub error_code: Option<String>,
    pub attempt: u32,
    pub rollout_id: Option<String>,
}

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use super::client::post_report;
use super::protocol::DeploymentReport;

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
    #[serde(default)]
    pub settings_required: bool,
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

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReportQueue {
    reports: Vec<DeploymentReport>,
}

fn report_queue_path() -> Option<std::path::PathBuf> {
    tools_dir().map(|directory| directory.join("report-queue.json"))
}

fn load_report_queue() -> ReportQueue {
    report_queue_path()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|body| serde_json::from_str(&body).ok())
        .unwrap_or_default()
}

fn save_report_queue(queue: &ReportQueue) -> Result<(), String> {
    let path = report_queue_path()
        .ok_or_else(|| "HOME 이 없어 report queue를 저장할 수 없습니다".to_string())?;
    let body = serde_json::to_string_pretty(queue).map_err(|error| error.to_string())?;
    crate::fsx::write_atomic(&path, &body, 0o600).map_err(|error| error.to_string())
}

pub(crate) fn enqueue_reports(reports: Vec<DeploymentReport>) -> Result<(), String> {
    let mut queue = load_report_queue();
    for report in reports {
        queue.reports.retain(|current| {
            current.device_fingerprint != report.device_fingerprint
                || current.catalog_item_id != report.catalog_item_id
                || current.desired_version_id != report.desired_version_id
                || current.rollout_id != report.rollout_id
        });
        queue.reports.push(report);
    }
    if queue.reports.len() > 200 {
        queue.reports.drain(..queue.reports.len() - 200);
    }
    save_report_queue(&queue)
}

pub(crate) fn flush_reports(endpoint: &str, token: &str) -> bool {
    let mut queue = load_report_queue();
    let mut remaining = Vec::new();
    for report in queue.reports {
        match post_report(endpoint, token, &report) {
            Ok(()) => {}
            Err(error) if error.code() == "report_rejected" => {}
            Err(_) => remaining.push(report),
        }
    }
    queue.reports = remaining;
    save_report_queue(&queue).is_ok() && queue.reports.is_empty()
}

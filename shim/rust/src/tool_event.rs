use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::collect::RawToolActivity;
use crate::iso;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolActivityKind {
    Mcp,
    Skill,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolOutcome {
    Success,
    Failure,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolDetection {
    Explicit,
    DerivedLoad,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolActivityWire<'a> {
    dedup_key: String,
    provider_key: &'a str,
    session_id: &'a Option<String>,
    host: Option<&'a str>,
    ts: String,
    activity_kind: ToolActivityKind,
    item_key: &'a str,
    display_name: &'a str,
    plugin_key: &'a Option<String>,
    outcome: ToolOutcome,
    detection: ToolDetection,
}

fn dedup_key(provider: &str, event: &RawToolActivity) -> String {
    let mut hasher = Sha256::new();
    hasher.update(
        format!(
            "tool:{provider}:{}:{:?}:{}",
            event.call_id, event.kind, event.item_key
        )
        .as_bytes(),
    );
    format!("{:x}", hasher.finalize())
}

pub fn to_tool_events_body(provider: &str, host: Option<&str>, events: &[RawToolActivity]) -> String {
    let values: Vec<ToolActivityWire<'_>> = events
        .iter()
        .map(|event| ToolActivityWire {
            dedup_key: dedup_key(provider, event),
            provider_key: provider,
            session_id: &event.session_id,
            host,
            ts: iso::epoch_ms_to_iso(event.ts_ms),
            activity_kind: event.kind,
            item_key: &event.item_key,
            display_name: &event.display_name,
            plugin_key: &event.plugin_key,
            outcome: event.outcome,
            detection: event.detection,
        })
        .collect();
    serde_json::to_string(&values).unwrap_or_else(|_| "[]".into())
}

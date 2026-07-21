use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryKind {
    Success,
    Unreachable,
    Unauthorized,
    Unsupported,
    Disabled,
    ServerError,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeliveryStatus {
    pub last_attempt_at: String,
    pub last_success_at: Option<String>,
    pub result: DeliveryKind,
    pub error_fingerprint: Option<String>,
    pub last_logged_at: Option<String>,
}

pub fn error_fingerprint(error: &str) -> String {
    format!("{:x}", Sha256::digest(error.as_bytes()))
}

fn status_path(state_dir: &Path) -> std::path::PathBuf {
    state_dir.join("delivery.json")
}

pub fn load(state_dir: &Path) -> Option<DeliveryStatus> {
    std::fs::read_to_string(status_path(state_dir))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
}

fn now_iso(now: u64) -> String {
    crate::iso::epoch_ms_to_iso((now * 1000) as i64)
}

fn save(state_dir: &Path, status: &DeliveryStatus) -> std::io::Result<()> {
    let text = serde_json::to_string(status).map_err(std::io::Error::other)?;
    crate::fsx::write_atomic(&status_path(state_dir), &text, 0o600)
}

pub fn record_attempt(state_dir: &Path) -> std::io::Result<()> {
    let now = crate::bg::now_unix();
    let mut status = load(state_dir).unwrap_or(DeliveryStatus {
        last_attempt_at: now_iso(now),
        last_success_at: None,
        result: DeliveryKind::ServerError,
        error_fingerprint: None,
        last_logged_at: None,
    });
    status.last_attempt_at = now_iso(now);
    save(state_dir, &status)
}

pub fn record_success(state_dir: &Path) -> std::io::Result<()> {
    let now = crate::bg::now_unix();
    let timestamp = now_iso(now);
    save(
        state_dir,
        &DeliveryStatus {
            last_attempt_at: timestamp.clone(),
            last_success_at: Some(timestamp),
            result: DeliveryKind::Success,
            error_fingerprint: None,
            last_logged_at: None,
        },
    )
}

pub fn should_log_failure(status: &DeliveryStatus, fingerprint: &str, now: u64) -> bool {
    if status.error_fingerprint.as_deref() != Some(fingerprint) {
        return true;
    }
    let Some(last_logged) = status
        .last_logged_at
        .as_deref()
        .and_then(crate::iso::iso_to_epoch_ms)
    else {
        return true;
    };
    now.saturating_sub((last_logged.max(0) as u64) / 1000) >= 60 * 60
}

pub fn record_failure(state_dir: &Path, kind: DeliveryKind, error: &str) -> std::io::Result<bool> {
    let now = crate::bg::now_unix();
    let fingerprint = error_fingerprint(error);
    let previous = load(state_dir);
    let should_log = previous
        .as_ref()
        .is_none_or(|status| should_log_failure(status, &fingerprint, now));
    let last_success_at = previous
        .as_ref()
        .and_then(|status| status.last_success_at.clone());
    let last_logged_at = if should_log {
        Some(now_iso(now))
    } else {
        previous
            .as_ref()
            .and_then(|status| status.last_logged_at.clone())
    };
    let status = DeliveryStatus {
        last_attempt_at: now_iso(now),
        last_success_at,
        result: kind,
        error_fingerprint: Some(fingerprint),
        last_logged_at,
    };
    save(state_dir, &status)?;
    Ok(should_log)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_state(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "toard-delivery-{name}-{}-{}",
            std::process::id(),
            crate::bg::now_unix()
        ))
    }

    #[test]
    fn persistent_failure_contains_only_sanitized_fingerprint() {
        let state = temp_state("redaction");
        record_failure(
            &state,
            DeliveryKind::Unauthorized,
            "Authorization: Bearer secret-token prompt body",
        )
        .unwrap();

        let text = std::fs::read_to_string(state.join("delivery.json")).unwrap();
        let status: DeliveryStatus = serde_json::from_str(&text).unwrap();
        assert_eq!(status.result, DeliveryKind::Unauthorized);
        assert!(status.error_fingerprint.is_some());
        for forbidden in ["secret-token", "prompt body", "Authorization"] {
            assert!(!text.contains(forbidden));
        }
        let _ = std::fs::remove_dir_all(state);
    }

    #[test]
    fn identical_failure_logs_at_most_once_per_hour() {
        let now = 2_000_000_000;
        let fingerprint = error_fingerprint("connection refused");
        let recent = DeliveryStatus {
            last_attempt_at: crate::iso::epoch_ms_to_iso((now * 1000) as i64),
            last_success_at: None,
            result: DeliveryKind::Unreachable,
            error_fingerprint: Some(fingerprint.clone()),
            last_logged_at: Some(crate::iso::epoch_ms_to_iso(((now - 3599) * 1000) as i64)),
        };

        assert!(!should_log_failure(&recent, &fingerprint, now));
        assert!(should_log_failure(&recent, &fingerprint, now + 1));
        assert!(should_log_failure(&recent, "different", now));
    }

    #[test]
    fn suppressed_failure_preserves_the_previous_log_time() {
        let state = temp_state("rate-limit");

        assert!(record_failure(&state, DeliveryKind::Unreachable, "connection refused").unwrap());
        assert!(!record_failure(&state, DeliveryKind::Unreachable, "connection refused").unwrap());
        assert!(!record_failure(&state, DeliveryKind::Unreachable, "connection refused").unwrap());
        assert!(load(&state).unwrap().last_logged_at.is_some());
        let _ = std::fs::remove_dir_all(state);
    }
}

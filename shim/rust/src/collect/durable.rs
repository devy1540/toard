use super::post::{EndpointResult, PostResult, Transport};
use crate::targets::Target;
use crate::usage_queue::{batch_body, QueueIdentity, UsageQueue, DEFAULT_MAX_BYTES};

pub struct PreparedQueue {
    pub queue: UsageQueue,
    pub health_supported: bool,
}

fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

pub fn open(
    target: &Target,
    token: &str,
    transport: &dyn Transport,
) -> Result<PreparedQueue, String> {
    let hello = transport.post_collection_health(
        &target.endpoint,
        token,
        r#"{"schemaVersion":1,"host":null,"collectors":[]}"#,
    );
    let (owner, health_supported) = match hello {
        EndpointResult::Ok(result) if result.events_receipt_version == Some(1) => {
            let owner = result
                .user_id
                .filter(|value| uuid(value))
                .ok_or("collector handshake returned an invalid owner identity")?;
            (Some(owner), true)
        }
        EndpointResult::Unauthorized => return Err("토큰이 유효하지 않습니다(만료/폐기)".into()),
        _ => (None, false), // Offline/legacy targets remain credential-bound until verified.
    };
    let max_bytes = std::env::var("TOARD_SHIM_QUEUE_MAX_BYTES")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value >= 1024 && *value <= 1024 * 1024 * 1024)
        .unwrap_or(DEFAULT_MAX_BYTES);
    let queue = UsageQueue::open(
        &target.state_dir,
        QueueIdentity::new(&target.id, owner.as_deref(), token),
        max_bytes,
    )
    .map_err(|error| error.to_string())?;
    Ok(PreparedQueue {
        queue,
        health_supported,
    })
}

pub fn acknowledged(result: &PostResult, sent: usize, require_confirmed: bool) -> bool {
    let sent = sent as u64;
    let accounted = result
        .inserted
        .checked_add(result.deduped)
        .and_then(|count| count.checked_add(result.expired))
        .and_then(|count| count.checked_add(result.ignored));
    if accounted != Some(sent) {
        return false;
    }
    match result.confirmed {
        Some(confirmed) => {
            confirmed
                .checked_add(result.expired)
                .and_then(|count| count.checked_add(result.ignored))
                == Some(sent)
        }
        None => !require_confirmed,
    }
}

#[derive(Default)]
pub struct DrainResult {
    pub sent: usize,
    pub superseded: bool,
}

/// Bound work per invocation. A failed/partial receipt leaves the whole batch intact.
pub fn drain(
    queue: &mut UsageQueue,
    target: &Target,
    token: &str,
    transport: &dyn Transport,
    provider: &str,
    current: impl Fn() -> bool,
) -> Result<DrainResult, String> {
    let mut progress = DrainResult::default();
    for _ in 0..32 {
        if !current() {
            progress.superseded = true;
            return Ok(progress);
        }
        let batch = queue
            .peek_for(provider, 250)
            .map_err(|error| error.to_string())?;
        if batch.is_empty() {
            return Ok(progress);
        }
        if !current() {
            progress.superseded = true;
            return Ok(progress);
        }
        let result = transport.post_events(&target.endpoint, token, &batch_body(&batch))?;
        if !acknowledged(&result, batch.len(), queue.requires_confirmed_receipt()) {
            return Err(
                "서버 저장 확인이 배치와 일치하지 않습니다; 전송 대기 기록을 보존합니다".into(),
            );
        }
        if !current() {
            progress.superseded = true;
            return Ok(progress);
        }
        queue
            .acknowledge(&batch.iter().map(|row| row.sequence).collect::<Vec<_>>())
            .map_err(|error| error.to_string())?;
        progress.sent += batch.len();
    }
    Ok(progress)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn receipts_must_account_for_the_exact_batch_and_authenticated_owner() {
        assert!(acknowledged(
            &PostResult {
                inserted: 1,
                confirmed: Some(1),
                ..Default::default()
            },
            1,
            true
        ));
        assert!(!acknowledged(
            &PostResult {
                deduped: 1,
                confirmed: Some(0),
                ..Default::default()
            },
            1,
            true
        ));
        assert!(!acknowledged(
            &PostResult {
                inserted: 1,
                ..Default::default()
            },
            1,
            true
        ));
        assert!(acknowledged(
            &PostResult {
                inserted: 1,
                ..Default::default()
            },
            1,
            false
        ));
        assert!(!acknowledged(&PostResult::default(), 1, false));
        assert!(acknowledged(
            &PostResult {
                expired: 1,
                confirmed: Some(0),
                ..Default::default()
            },
            1,
            true
        ));
        assert!(acknowledged(
            &PostResult {
                ignored: 1,
                confirmed: Some(0),
                ..Default::default()
            },
            1,
            true
        ));
        assert!(!acknowledged(
            &PostResult {
                inserted: u64::MAX,
                deduped: 1,
                ..Default::default()
            },
            0,
            false
        ));
    }
}

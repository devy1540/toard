// 배치 POST — doctor/자동업데이트와 동일하게 HTTP 는 curl 에 위임한다.
// 본문은 0600 임시 파일로 전달(프로세스 인자에 데이터 노출 방지).
// /v1/events(UsageEvent[])와 /v1/prompts(PromptRecord[])가 이 경로를 공유한다.

use std::process::Command;

use serde::Deserialize;

use crate::fsx;

#[derive(Debug, Default, Deserialize)]
pub struct PostResult {
    #[serde(default)]
    pub inserted: u64,
    #[serde(default)]
    pub deduped: u64,
    #[serde(default)]
    pub reconciled: u64,
}

enum Outcome {
    Ok(PostResult),
    /// 503 — 서버에서 해당 수집이 비활성(본문 수집 KEK 미설정 등). 실패 아님.
    Disabled,
    Unauthorized,
    Unsupported,
    Err(String),
}

fn post_batch(
    endpoint: &str,
    token: &str,
    method: &str,
    path_suffix: &str,
    file_prefix: &str,
    body: &str,
) -> Outcome {
    let url = format!("{}{}", endpoint.trim_end_matches('/'), path_suffix);
    let Some(dir) = fsx::state_dir().map(|d| d.join("tmp")) else {
        return Outcome::Err("HOME 없음".into());
    };
    let req_path = dir.join(format!("{file_prefix}-{}.json", std::process::id()));
    if let Err(e) = fsx::write_atomic(&req_path, body, 0o600) {
        return Outcome::Err(format!("임시 파일 쓰기 실패: {e}"));
    }

    // User-Agent 로 shim 버전을 알린다 — 서버가 기기별 버전을 기록(구버전 식별)
    let ua = format!("toard-shim/{}", crate::cli::version());
    let out = Command::new("curl")
        .args([
            "-sS",
            "--max-time",
            "60",
            "-A",
            &ua,
            "-X",
            method,
            "-H",
            "Content-Type: application/json",
            "-H",
            &format!("Authorization: Bearer {token}"),
            "--data-binary",
            &format!("@{}", req_path.display()),
            "-w",
            "\n%{http_code}",
            &url,
        ])
        .output();
    let _ = std::fs::remove_file(&req_path);
    let out = match out {
        Ok(o) => o,
        Err(e) => return Outcome::Err(format!("curl 실행 불가: {e}")),
    };

    let text = String::from_utf8_lossy(&out.stdout);
    let (resp_body, code_line) = text.rsplit_once('\n').unwrap_or(("", text.trim()));
    let code: u16 = code_line.trim().parse().unwrap_or(0);
    match code {
        200 => match serde_json::from_str::<PostResult>(resp_body.trim()) {
            Ok(r) => Outcome::Ok(r),
            Err(e) => Outcome::Err(format!("응답 파싱 실패: {e}")),
        },
        0 => Outcome::Err(format!(
            "서버 연결 실패: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )),
        401 => Outcome::Unauthorized,
        404 | 405 => Outcome::Unsupported,
        503 => Outcome::Disabled,
        _ => Outcome::Err(format!("HTTP {code}: {}", resp_body.trim())),
    }
}

pub fn post_events(endpoint: &str, token: &str, body: &str) -> Result<PostResult, String> {
    match post_batch(endpoint, token, "POST", "/v1/events", "events", body) {
        Outcome::Ok(r) => Ok(r),
        Outcome::Unauthorized => Err("토큰이 유효하지 않습니다(만료/폐기)".into()),
        Outcome::Disabled => Err("HTTP 503".into()),
        Outcome::Unsupported => Err("HTTP 404/405".into()),
        Outcome::Err(e) => Err(e),
    }
}

/// PromptRecord[] 전송. `Ok(None)` = 서버에서 본문 수집이 비활성(503) — 실패로 보지 않는다.
pub fn post_prompts(endpoint: &str, token: &str, body: &str) -> Result<Option<PostResult>, String> {
    match post_batch(endpoint, token, "POST", "/v1/prompts", "prompts", body) {
        Outcome::Ok(r) => Ok(Some(r)),
        Outcome::Disabled => Ok(None),
        Outcome::Unauthorized => Err("토큰이 유효하지 않습니다(만료/폐기)".into()),
        Outcome::Unsupported => Err("HTTP 404/405".into()),
        Outcome::Err(e) => Err(e),
    }
}

pub enum EndpointResult {
    Ok(PostResult),
    Unsupported,
    Unauthorized,
    Err(String),
}

pub fn post_tool_events(endpoint: &str, token: &str, body: &str) -> EndpointResult {
    match post_batch(
        endpoint,
        token,
        "POST",
        "/v1/tool-events",
        "tool-events",
        body,
    ) {
        Outcome::Ok(result) => EndpointResult::Ok(result),
        Outcome::Unsupported => EndpointResult::Unsupported,
        Outcome::Unauthorized => EndpointResult::Unauthorized,
        Outcome::Disabled => EndpointResult::Err("HTTP 503".into()),
        Outcome::Err(error) => EndpointResult::Err(error),
    }
}

pub fn post_usage_reconciliation(endpoint: &str, token: &str, body: &str) -> EndpointResult {
    match post_batch(
        endpoint,
        token,
        "POST",
        "/v1/events/reconcile",
        "usage-reconciliation",
        body,
    ) {
        Outcome::Ok(result) => EndpointResult::Ok(result),
        Outcome::Unsupported => EndpointResult::Unsupported,
        Outcome::Unauthorized => EndpointResult::Unauthorized,
        Outcome::Disabled => EndpointResult::Err("HTTP 503".into()),
        Outcome::Err(error) => EndpointResult::Err(error),
    }
}

pub fn put_tool_inventory(endpoint: &str, token: &str, body: &str) -> EndpointResult {
    match post_batch(
        endpoint,
        token,
        "PUT",
        "/v1/tool-inventory",
        "tool-inventory",
        body,
    ) {
        Outcome::Ok(result) => EndpointResult::Ok(result),
        Outcome::Unsupported => EndpointResult::Unsupported,
        Outcome::Unauthorized => EndpointResult::Unauthorized,
        Outcome::Disabled => EndpointResult::Err("HTTP 503".into()),
        Outcome::Err(error) => EndpointResult::Err(error),
    }
}

fn unsupported_is_due(stamp_content: Option<&str>, now: u64) -> bool {
    crate::bg::is_due(stamp_content, now, 24 * 60 * 60)
}

pub fn unsupported_probe_due(name: &str) -> bool {
    let stamp = crate::fsx::state_dir().map(|dir| dir.join(format!("unsupported-{name}")));
    let content = stamp
        .as_ref()
        .and_then(|path| std::fs::read_to_string(path).ok());
    unsupported_is_due(content.as_deref(), crate::bg::now_unix())
}

pub fn mark_unsupported(name: &str) {
    if let Some(path) = crate::fsx::state_dir().map(|dir| dir.join(format!("unsupported-{name}"))) {
        let _ = crate::fsx::write_atomic(&path, &format!("{}\n", crate::bg::now_unix()), 0o644);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_endpoint_retries_after_24_hours() {
        let now = 2_000_000_000;
        assert!(!unsupported_is_due(
            Some(&(now - 23 * 3600).to_string()),
            now
        ));
        assert!(unsupported_is_due(
            Some(&(now - 24 * 3600).to_string()),
            now
        ));
        assert!(unsupported_is_due(None, now));
    }
}

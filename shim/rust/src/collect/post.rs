// 배치 POST — doctor/자동업데이트와 동일하게 HTTP 는 curl 에 위임한다.
// 본문은 0600 임시 파일로 전달(프로세스 인자에 데이터 노출 방지).
// /v1/events(UsageEvent[])와 /v1/prompts(PromptRecord[])가 이 경로를 공유한다.

use std::path::Path;
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

fn curl_args(
    method: &str,
    request_path: &Path,
    auth_config_path: &Path,
    user_agent: &str,
    url: &str,
) -> Vec<String> {
    vec![
        "-sS".into(),
        "--connect-timeout".into(),
        "5".into(),
        "--max-time".into(),
        "60".into(),
        "--config".into(),
        auth_config_path.display().to_string(),
        "-A".into(),
        user_agent.into(),
        "-X".into(),
        method.into(),
        "-H".into(),
        "Content-Type: application/json".into(),
        "--data-binary".into(),
        format!("@{}", request_path.display()),
        "-w".into(),
        "\n%{http_code}".into(),
        url.into(),
    ]
}

fn auth_config(token: &str) -> Result<String, &'static str> {
    if token.contains(['\r', '\n']) {
        return Err("invalid token");
    }
    let escaped = token.replace('\\', "\\\\").replace('"', "\\\"");
    Ok(format!("header = \"Authorization: Bearer {escaped}\"\n"))
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
    let auth_path = dir.join(format!("{file_prefix}-auth-{}.conf", std::process::id()));
    if let Err(e) = fsx::write_atomic(&req_path, body, 0o600) {
        return Outcome::Err(format!("임시 파일 쓰기 실패: {e}"));
    }
    let auth = match auth_config(token) {
        Ok(auth) => auth,
        Err(error) => {
            let _ = std::fs::remove_file(&req_path);
            return Outcome::Err(error.into());
        }
    };
    if let Err(error) = fsx::write_atomic(&auth_path, &auth, 0o600) {
        let _ = std::fs::remove_file(&req_path);
        return Outcome::Err(format!("인증 임시 파일 쓰기 실패: {error}"));
    }

    // User-Agent 로 shim 버전을 알린다 — 서버가 기기별 버전을 기록(구버전 식별)
    let ua = format!("toard-shim/{}", crate::cli::version());
    let args = curl_args(method, &req_path, &auth_path, &ua, &url);
    let out = Command::new("curl").args(args).output();
    let _ = std::fs::remove_file(&req_path);
    let _ = std::fs::remove_file(&auth_path);
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
        _ => Outcome::Err(format!("HTTP {code}")),
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

pub trait Transport {
    fn post_events(&self, endpoint: &str, token: &str, body: &str) -> Result<PostResult, String>;
    fn post_prompts(
        &self,
        endpoint: &str,
        token: &str,
        body: &str,
    ) -> Result<Option<PostResult>, String>;
    fn post_tool_events(&self, endpoint: &str, token: &str, body: &str) -> EndpointResult;
    fn post_usage_reconciliation(&self, endpoint: &str, token: &str, body: &str) -> EndpointResult;
    fn put_tool_inventory(&self, endpoint: &str, token: &str, body: &str) -> EndpointResult;
}

pub struct CurlTransport;

impl Transport for CurlTransport {
    fn post_events(&self, endpoint: &str, token: &str, body: &str) -> Result<PostResult, String> {
        post_events(endpoint, token, body)
    }

    fn post_prompts(
        &self,
        endpoint: &str,
        token: &str,
        body: &str,
    ) -> Result<Option<PostResult>, String> {
        post_prompts(endpoint, token, body)
    }

    fn post_tool_events(&self, endpoint: &str, token: &str, body: &str) -> EndpointResult {
        post_tool_events(endpoint, token, body)
    }

    fn post_usage_reconciliation(&self, endpoint: &str, token: &str, body: &str) -> EndpointResult {
        post_usage_reconciliation(endpoint, token, body)
    }

    fn put_tool_inventory(&self, endpoint: &str, token: &str, body: &str) -> EndpointResult {
        put_tool_inventory(endpoint, token, body)
    }
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

pub fn unsupported_probe_due(state_dir: &Path, name: &str) -> bool {
    let stamp = state_dir.join(format!("unsupported-{name}"));
    let content = std::fs::read_to_string(stamp).ok();
    unsupported_is_due(content.as_deref(), crate::bg::now_unix())
}

pub fn mark_unsupported(state_dir: &Path, name: &str) {
    let path = state_dir.join(format!("unsupported-{name}"));
    let _ = crate::fsx::write_atomic(&path, &format!("{}\n", crate::bg::now_unix()), 0o600);
}

pub fn clear_unsupported(state_dir: &Path, name: &str) {
    let _ = std::fs::remove_file(state_dir.join(format!("unsupported-{name}")));
}

pub fn unsupported_marked(state_dir: &Path, name: &str) -> bool {
    state_dir.join(format!("unsupported-{name}")).is_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeTransport;

    impl Transport for FakeTransport {
        fn post_events(
            &self,
            _endpoint: &str,
            _token: &str,
            _body: &str,
        ) -> Result<PostResult, String> {
            Ok(PostResult {
                inserted: 1,
                ..PostResult::default()
            })
        }

        fn post_prompts(
            &self,
            _endpoint: &str,
            _token: &str,
            _body: &str,
        ) -> Result<Option<PostResult>, String> {
            Ok(None)
        }

        fn post_tool_events(&self, _endpoint: &str, _token: &str, _body: &str) -> EndpointResult {
            EndpointResult::Unsupported
        }

        fn post_usage_reconciliation(
            &self,
            _endpoint: &str,
            _token: &str,
            _body: &str,
        ) -> EndpointResult {
            EndpointResult::Unsupported
        }

        fn put_tool_inventory(&self, _endpoint: &str, _token: &str, _body: &str) -> EndpointResult {
            EndpointResult::Unsupported
        }
    }

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

    #[test]
    fn transport_can_be_injected_without_spawning_curl() {
        let result = FakeTransport
            .post_events("https://toard.example/api", "secret", "[]")
            .unwrap();

        assert_eq!(result.inserted, 1);
    }

    #[test]
    fn curl_process_arguments_have_short_connect_timeout_and_no_secret_material() {
        let args = curl_args(
            "POST",
            Path::new("/tmp/toard-body.json"),
            Path::new("/tmp/toard-auth.conf"),
            "toard-shim/test",
            "https://toard.example/api/v1/events",
        );
        let joined = args.join(" ");

        assert!(joined.contains("--connect-timeout 5"));
        assert!(joined.contains("--max-time 60"));
        assert!(joined.contains("--config /tmp/toard-auth.conf"));
        assert!(!joined.contains("secret-token"));
        assert!(!joined.contains("prompt body"));
        assert!(!joined.contains("Authorization:"));
    }

    #[test]
    fn unsupported_probe_stamp_is_isolated_by_target_state_root() {
        let root = std::env::temp_dir().join(format!(
            "toard-unsupported-isolation-{}-{}",
            std::process::id(),
            crate::bg::now_unix()
        ));
        let company = root.join("company");
        let personal = root.join("personal");

        mark_unsupported(&company, "tool-events");

        assert!(!unsupported_probe_due(&company, "tool-events"));
        assert!(unsupported_probe_due(&personal, "tool-events"));
        let _ = std::fs::remove_dir_all(root);
    }
}

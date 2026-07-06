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
}

enum Outcome {
    Ok(PostResult),
    /// 503 — 서버에서 해당 수집이 비활성(본문 수집 KEK 미설정 등). 실패 아님.
    Disabled,
    Unauthorized,
    Err(String),
}

fn post_batch(
    endpoint: &str,
    token: &str,
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
            "POST",
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
        503 => Outcome::Disabled,
        _ => Outcome::Err(format!("HTTP {code}: {}", resp_body.trim())),
    }
}

pub fn post_events(endpoint: &str, token: &str, body: &str) -> Result<PostResult, String> {
    match post_batch(endpoint, token, "/v1/events", "events", body) {
        Outcome::Ok(r) => Ok(r),
        Outcome::Unauthorized => Err("토큰이 유효하지 않습니다(만료/폐기)".into()),
        Outcome::Disabled => Err("HTTP 503".into()),
        Outcome::Err(e) => Err(e),
    }
}

/// PromptRecord[] 전송. `Ok(None)` = 서버에서 본문 수집이 비활성(503) — 실패로 보지 않는다.
pub fn post_prompts(endpoint: &str, token: &str, body: &str) -> Result<Option<PostResult>, String> {
    match post_batch(endpoint, token, "/v1/prompts", "prompts", body) {
        Outcome::Ok(r) => Ok(Some(r)),
        Outcome::Disabled => Ok(None),
        Outcome::Unauthorized => Err("토큰이 유효하지 않습니다(만료/폐기)".into()),
        Outcome::Err(e) => Err(e),
    }
}

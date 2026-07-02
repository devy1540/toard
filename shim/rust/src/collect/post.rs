// UsageEvent[] 배치 POST — doctor/자동업데이트와 동일하게 HTTP 는 curl 에 위임한다.
// 본문은 0600 임시 파일로 전달(프로세스 인자에 데이터 노출 방지).

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

pub fn post_events(endpoint: &str, token: &str, body: &str) -> Result<PostResult, String> {
    let url = format!("{}/v1/events", endpoint.trim_end_matches('/'));
    let dir = fsx::state_dir().ok_or("HOME 없음")?.join("tmp");
    let req_path = dir.join(format!("events-{}.json", std::process::id()));
    fsx::write_atomic(&req_path, body, 0o600).map_err(|e| format!("임시 파일 쓰기 실패: {e}"))?;

    let out = Command::new("curl")
        .args([
            "-sS",
            "--max-time",
            "60",
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
    let out = out.map_err(|e| format!("curl 실행 불가: {e}"))?;

    let text = String::from_utf8_lossy(&out.stdout);
    let (resp_body, code_line) = text.rsplit_once('\n').unwrap_or(("", text.trim()));
    let code: u16 = code_line.trim().parse().unwrap_or(0);
    match code {
        200 => serde_json::from_str::<PostResult>(resp_body.trim())
            .map_err(|e| format!("응답 파싱 실패: {e}")),
        0 => Err(format!(
            "서버 연결 실패: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )),
        401 => Err("토큰이 유효하지 않습니다(만료/폐기)".into()),
        _ => Err(format!("HTTP {code}: {}", resp_body.trim())),
    }
}

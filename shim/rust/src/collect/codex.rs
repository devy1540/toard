// Codex 본문 수집 어댑터 (content pull 일원화 — 설계 확정).
// Codex 는 사용량을 OTLP 로 보내고, 응답은 OTLP 로 절대 안 온다(실측·소스 확정 — 응답 로깅
// 이벤트/플래그 자체가 없음). 따라서 본문은 세션 롤아웃 파일에서 pull 한다.
//
// 소스: ~/.codex/sessions/**/*.jsonl (CODEX_HOME 존중). 각 라인:
//   - session_meta      → payload.session_id (세션 식별, 승계)
//   - event_msg/user_message   → payload.message (사용자 프롬프트, 정본)
//   - event_msg/agent_message  → payload.message (모델 응답, 정본)
// response_item(user/assistant)엔 환경 컨텍스트 주입 노이즈가 섞여 event_msg 를 정본으로 쓴다.
//
// 최상위 crate::codex(=OTEL config.toml 주입기)와는 다른 모듈(collect::codex).

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::{file_mtime_ms, walk_files, LogAdapter, RawContent, RawUsage};
use crate::iso::iso_to_epoch_ms;

pub struct Codex;

impl LogAdapter for Codex {
    fn key(&self) -> &'static str {
        "codex"
    }

    /// 사용량은 OTLP 로 오므로 본문 전용.
    fn collects_usage(&self) -> bool {
        false
    }

    /// (CODEX_HOME|~/.codex)/sessions 아래 롤아웃(*.jsonl) 재귀 수집.
    fn discover_files(&self) -> Vec<PathBuf> {
        let mut files = Vec::new();
        if let Some(root) = sessions_dir() {
            walk_files(&root, &["jsonl"], &mut files, 0);
        }
        files.sort();
        files.dedup();
        files
    }

    fn parse_file(&self, _path: &Path) -> Vec<RawUsage> {
        Vec::new() // 사용량 없음 — OTLP 경로가 담당
    }

    fn parse_content(&self, path: &Path) -> Vec<RawContent> {
        parse_rollout(path)
    }
}

fn sessions_dir() -> Option<PathBuf> {
    if let Some(h) = std::env::var_os("CODEX_HOME") {
        return Some(PathBuf::from(h).join("sessions"));
    }
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".codex").join("sessions"))
}

/// 롤아웃 jsonl → user/assistant 본문 레코드. event_msg(user_message/agent_message)만 정본으로 사용.
fn parse_rollout(path: &Path) -> Vec<RawContent> {
    let fallback = file_mtime_ms(path);
    let Ok(bytes) = std::fs::read(path) else {
        return Vec::new();
    };
    let mut session_id: Option<String> = None;
    let mut out = Vec::new();
    for line in bytes.split(|b| *b == b'\n') {
        let Ok(v) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        let Some(obj) = v.as_object() else {
            continue;
        };
        let ty = obj.get("type").and_then(Value::as_str);
        let payload = obj.get("payload").and_then(Value::as_object);

        if ty == Some("session_meta") {
            if let Some(p) = payload {
                session_id = p
                    .get("session_id")
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
            continue;
        }
        if ty != Some("event_msg") {
            continue;
        }
        let Some(p) = payload else {
            continue;
        };
        let role: &'static str = match p.get("type").and_then(Value::as_str) {
            Some("user_message") => "user",
            Some("agent_message") => "assistant",
            _ => continue,
        };
        let Some(text) = p.get("message").and_then(Value::as_str) else {
            continue;
        };
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        let ts_ms = obj
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(iso_to_epoch_ms)
            .unwrap_or(fallback);
        out.push(RawContent {
            ts_ms,
            session_id: session_id.clone(),
            // event_msg 엔 message id 가 없음 — dedup 은 session+ts+role+text 로 성립(§content_dedup_key)
            message_id: None,
            role,
            text: text.to_string(),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::super::gemini_family::testutil::TempDir;
    use super::*;

    #[test]
    fn extracts_user_and_agent_messages_only() {
        let tmp = TempDir::new("codex-content");
        let path = tmp.write(
            "sessions/2026/07/06/rollout.jsonl",
            &[
                r#"{"timestamp":"2026-07-06T02:05:16.000Z","type":"session_meta","payload":{"session_id":"019f352c","cwd":"/x"}}"#,
                r#"{"timestamp":"2026-07-06T02:05:22.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"환경 컨텍스트 노이즈 (제외돼야 함)"}]}}"#,
                r#"{"timestamp":"2026-07-06T02:05:22.687Z","type":"event_msg","payload":{"type":"user_message","message":"대한민국의 수도는? 한 단어로만 답해."}}"#,
                r#"{"timestamp":"2026-07-06T02:05:25.300Z","type":"event_msg","payload":{"type":"agent_message","message":"서울"}}"#,
            ]
            .join("\n"),
        );
        let recs = Codex.parse_content(&path);
        assert_eq!(
            recs.len(),
            2,
            "event_msg user/agent 만 (response_item 컨텍스트 노이즈 제외)"
        );
        assert_eq!(recs[0].role, "user");
        assert_eq!(recs[0].text, "대한민국의 수도는? 한 단어로만 답해.");
        assert_eq!(
            recs[0].session_id.as_deref(),
            Some("019f352c"),
            "session_meta 에서 세션 승계"
        );
        assert_eq!(recs[1].role, "assistant");
        assert_eq!(recs[1].text, "서울");
        assert_eq!(
            recs[1].ts_ms,
            iso_to_epoch_ms("2026-07-06T02:05:25.300Z").unwrap()
        );
    }

    #[test]
    fn is_content_only_no_usage() {
        let tmp = TempDir::new("codex-usage");
        let path = tmp.write(
            "sessions/x.jsonl",
            r#"{"type":"event_msg","payload":{"type":"agent_message","message":"x"}}"#,
        );
        assert!(
            Codex.parse_file(&path).is_empty(),
            "사용량은 OTLP — parse_file 은 빈 벡터"
        );
        assert!(!Codex.collects_usage());
        assert_eq!(Codex.key(), "codex");
    }
}

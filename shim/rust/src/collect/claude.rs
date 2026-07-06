// Claude Code 본문 수집 어댑터 (content pull 일원화 — 설계 확정).
// Claude Code 는 사용량을 OTLP push 로 보내므로(ADR-001) 이 어댑터는 **본문만** 수집한다
// (collects_usage=false, parse_file 빈 벡터 → 사용량 이중집계 없음).
// 전문(프롬프트+응답)은 트랜스크립트 ~/.claude/projects/**/*.jsonl 에 있다(Desktop 사용분 포함 — 실측 확인).

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::{file_mtime_ms, walk_files, LogAdapter, RawContent, RawUsage};
use crate::iso::iso_to_epoch_ms;

pub struct Claude;

impl LogAdapter for Claude {
    fn key(&self) -> &'static str {
        "claude_code"
    }

    /// 사용량은 OTLP 로 오므로 본문 전용.
    fn collects_usage(&self) -> bool {
        false
    }

    /// ~/.claude/projects 아래 트랜스크립트(*.jsonl) 재귀 수집.
    fn discover_files(&self) -> Vec<PathBuf> {
        let mut files = Vec::new();
        if let Some(root) = projects_dir() {
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
        parse_transcript(path)
    }
}

fn projects_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".claude").join("projects"))
}

/// message.content(문자열 또는 블록 배열)에서 텍스트 추출.
/// 문자열 = 그대로(user 프롬프트). 배열 = 각 블록의 "text" 필드만(assistant text 블록).
/// thinking/tool_use/tool_result 등 "text" 없는 블록은 자연히 제외된다.
fn extract_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// 트랜스크립트 jsonl → user/assistant 본문 레코드.
/// type=user|assistant 라인의 message.content 를 뽑는다. text 가 없는 라인(순수 tool/thinking)은 제외.
fn parse_transcript(path: &Path) -> Vec<RawContent> {
    let fallback = file_mtime_ms(path);
    let Ok(bytes) = std::fs::read(path) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for line in bytes.split(|b| *b == b'\n') {
        let Ok(v) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        let Some(obj) = v.as_object() else {
            continue;
        };
        let role: &'static str = match obj.get("type").and_then(Value::as_str) {
            Some("user") => "user",
            Some("assistant") => "assistant",
            _ => continue,
        };
        let Some(msg) = obj.get("message").and_then(Value::as_object) else {
            continue;
        };
        let text = extract_text(msg.get("content"));
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        let session_id = obj
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_string);
        // dedup 1차 키: assistant 는 message.id, 없으면 라인 uuid 폴백
        let message_id = msg
            .get("id")
            .and_then(Value::as_str)
            .or_else(|| obj.get("uuid").and_then(Value::as_str))
            .map(str::to_string);
        let ts_ms = obj
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(iso_to_epoch_ms)
            .unwrap_or(fallback);
        out.push(RawContent {
            ts_ms,
            session_id,
            message_id,
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
    fn extracts_user_prompt_and_assistant_text() {
        let tmp = TempDir::new("claude-content");
        let path = tmp.write(
            "projects/proj/session.jsonl",
            &[
                r#"{"type":"summary","summary":"noise"}"#,
                r#"{"type":"user","sessionId":"s1","uuid":"u1","timestamp":"2026-07-01T12:00:00.000Z","message":{"role":"user","content":"대한민국의 수도는?"}}"#,
                r#"{"type":"assistant","sessionId":"s1","uuid":"u2","timestamp":"2026-07-01T12:00:05.000Z","message":{"id":"msg_1","role":"assistant","content":[{"type":"thinking","thinking":"..."},{"type":"text","text":"서울"}]}}"#,
                r#"{"type":"user","sessionId":"s1","uuid":"u3","timestamp":"2026-07-01T12:00:06.000Z","message":{"role":"user","content":[{"type":"tool_result","content":"tool output only"}]}}"#,
            ]
            .join("\n"),
        );
        let recs = Claude.parse_content(&path);
        assert_eq!(
            recs.len(),
            2,
            "user 프롬프트 + assistant text 만 (summary·tool_result-only 제외)"
        );
        assert_eq!(recs[0].role, "user");
        assert_eq!(recs[0].text, "대한민국의 수도는?");
        assert_eq!(recs[0].session_id.as_deref(), Some("s1"));
        assert_eq!(
            recs[0].message_id.as_deref(),
            Some("u1"),
            "user 는 uuid 폴백"
        );
        assert_eq!(
            recs[0].ts_ms,
            iso_to_epoch_ms("2026-07-01T12:00:00Z").unwrap()
        );
        assert_eq!(recs[1].role, "assistant");
        assert_eq!(recs[1].text, "서울", "thinking 제외, text 블록만");
        assert_eq!(
            recs[1].message_id.as_deref(),
            Some("msg_1"),
            "assistant 는 message.id"
        );
    }

    #[test]
    fn is_content_only_no_usage() {
        let tmp = TempDir::new("claude-usage");
        let path = tmp.write(
            "projects/p/s.jsonl",
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"x"}]}}"#,
        );
        assert!(
            Claude.parse_file(&path).is_empty(),
            "사용량은 OTLP — parse_file 은 빈 벡터"
        );
        assert!(!Claude.collects_usage());
        assert_eq!(Claude.key(), "claude_code");
    }
}

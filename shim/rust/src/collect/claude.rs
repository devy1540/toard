// Claude Code 사용량 + 본문 수집 어댑터 (트랜스크립트 pull — docs/design-usage-pull).
// 사용량·본문 모두 ~/.claude/projects/**/*.jsonl 트랜스크립트에서 읽는다(Desktop 사용분 포함 — 실측 확인).
//   - parse_file    : type=="assistant" 라인의 message.usage → RawUsage (사용량, /v1/events)
//   - parse_content : user/assistant 본문 → RawContent (opt-in, /v1/prompts)
// 사용량을 OTLP push 가 아니라 여기서 pull 하므로 재시작·env 주입이 불필요하고 host 가 자동으로 붙는다(§4.5).

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::{file_mtime_ms, walk_files, LogAdapter, RawContent, RawUsage};
use crate::iso::iso_to_epoch_ms;

pub struct Claude;

impl LogAdapter for Claude {
    fn key(&self) -> &'static str {
        "claude_code"
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

    fn parse_file(&self, path: &Path) -> Vec<RawUsage> {
        parse_transcript_usage(path)
    }

    fn parse_content(&self, path: &Path) -> Vec<RawContent> {
        parse_transcript(path)
    }
}

/// 트랜스크립트 jsonl → 사용량 레코드 (§4.2 필드 매핑).
/// type=="assistant" 라인의 message.usage 만 집계한다.
fn parse_transcript_usage(path: &Path) -> Vec<RawUsage> {
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
        // assistant 라인만 사용량을 담는다. **isSidechain 은 스킵하지 않는다**(§4.2): 서브에이전트
        // 턴도 고유 message.id 로 실제 토큰을 쓰므로 스킵하면 누락된다. 파일 재작성 리플레이
        // 중복은 message.id 기반 dedup_key(§4.3)가 흡수한다.
        if obj.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(msg) = obj.get("message").and_then(Value::as_object) else {
            continue;
        };
        let Some(usage) = msg.get("usage").and_then(Value::as_object) else {
            continue;
        };
        let tok = |k: &str| usage.get(k).and_then(Value::as_u64).unwrap_or(0);
        // input_tokens 는 Claude 가 이미 캐시 제외로 기록(cache_read/creation 별도) → UsageEvent 불변식과 일치.
        let input_tokens = tok("input_tokens");
        let output_tokens = tok("output_tokens");
        let cache_read_tokens = tok("cache_read_input_tokens");
        // 상위 cache_creation_input_tokens 는 5m+1h 합(실측). 캐시생성 5m/1h 분리 정밀도는 후속(리스크 B).
        let cache_creation_tokens = tok("cache_creation_input_tokens");
        // 토큰이 전부 0 이면(빈 usage) 스킵 — 비용 0 이벤트로 dedup 공간만 낭비.
        if input_tokens == 0
            && output_tokens == 0
            && cache_read_tokens == 0
            && cache_creation_tokens == 0
        {
            continue;
        }
        out.push(RawUsage {
            ts_ms: obj
                .get("timestamp")
                .and_then(Value::as_str)
                .and_then(iso_to_epoch_ms)
                .unwrap_or(fallback),
            session_id: obj
                .get("sessionId")
                .and_then(Value::as_str)
                .map(str::to_string),
            model: msg.get("model").and_then(Value::as_str).map(str::to_string),
            message_id: msg.get("id").and_then(Value::as_str).map(str::to_string),
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_creation_tokens,
        });
    }
    out
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
    fn parses_assistant_usage_including_sidechain() {
        let tmp = TempDir::new("claude-usage");
        // 실 트랜스크립트 구조 기반 골든: 일반 assistant + 서브에이전트(isSidechain) + usage 없는 라인.
        let path = tmp.write(
            "projects/p/s.jsonl",
            &[
                // 사용자/summary/usage-없는 assistant 는 제외
                r#"{"type":"user","sessionId":"s1","message":{"role":"user","content":"hi"}}"#,
                r#"{"type":"assistant","sessionId":"s1","message":{"id":"m0","model":"claude-opus-4-8","content":[{"type":"text","text":"no usage"}]}}"#,
                // 일반 assistant 사용량
                r#"{"type":"assistant","sessionId":"s1","isSidechain":false,"timestamp":"2026-06-26T07:57:48.385Z","requestId":"req_1","message":{"id":"m1","model":"claude-opus-4-8","usage":{"input_tokens":28947,"output_tokens":17543,"cache_read_input_tokens":19441,"cache_creation_input_tokens":111174}}}"#,
                // 서브에이전트 턴(isSidechain=true) — 고유 message.id, 스킵되면 안 됨
                r#"{"type":"assistant","sessionId":"s1","isSidechain":true,"timestamp":"2026-06-26T07:58:00.000Z","message":{"id":"m2","model":"claude-sonnet-4-5","usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#,
                // 토큰 전부 0 → 스킵
                r#"{"type":"assistant","sessionId":"s1","message":{"id":"m3","usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#,
            ]
            .join("\n"),
        );
        let recs = Claude.parse_file(&path);
        assert_eq!(
            recs.len(),
            2,
            "일반 + 서브에이전트 사용량만 (usage 없음·전부0 제외)"
        );
        assert!(Claude.collects_usage(), "이제 사용량도 수집");
        assert_eq!(Claude.key(), "claude_code");

        let a = &recs[0];
        assert_eq!(a.input_tokens, 28947, "input 은 캐시 제외 원값 그대로");
        assert_eq!(a.output_tokens, 17543);
        assert_eq!(a.cache_read_tokens, 19441);
        assert_eq!(a.cache_creation_tokens, 111174);
        assert_eq!(a.model.as_deref(), Some("claude-opus-4-8"));
        assert_eq!(a.message_id.as_deref(), Some("m1"), "message.id 로 dedup");
        assert_eq!(a.session_id.as_deref(), Some("s1"));
        assert_eq!(
            a.ts_ms,
            iso_to_epoch_ms("2026-06-26T07:57:48.385Z").unwrap()
        );

        let sc = &recs[1];
        assert_eq!(sc.message_id.as_deref(), Some("m2"), "서브에이전트 턴 보존");
        assert_eq!(sc.input_tokens, 10);
        assert_eq!(sc.output_tokens, 20);
    }
}

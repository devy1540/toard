// Codex 사용량 + 본문 수집 어댑터 (세션 롤아웃 pull — docs/design-usage-pull).
// 사용량·본문 모두 ~/.codex/sessions/**/*.jsonl (CODEX_HOME 존중) 에서 읽는다. 각 라인:
//   - session_meta             → payload.session_id (세션 식별, 승계)
//   - turn_context             → payload.model (모델명 — 실측: 여기 있음. session_meta 아님. 승계)
//   - event_msg/token_count    → payload.info.last_token_usage (사용량, /v1/events)
//   - event_msg/user_message   → payload.message (사용자 프롬프트, 정본, /v1/prompts)
//   - event_msg/agent_message  → payload.message (모델 응답, 정본, /v1/prompts)
// response_item(user/assistant)엔 환경 컨텍스트 주입 노이즈가 섞여 event_msg 를 본문 정본으로 쓴다.
// 사용량을 OTLP push 가 아니라 여기서 pull 하므로 재시작·config 주입이 불필요하고 host 가 자동으로 붙는다(§4.5).
//
// 최상위 crate::codex(=OTEL config.toml 주입기)와는 다른 모듈(collect::codex).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::Value;

use super::{
    file_mtime_ms, walk_files, LogAdapter, ParsedLog, RawContent, RawToolActivity, RawUsage,
};
use crate::iso::iso_to_epoch_ms;
use crate::tool_event::{ToolActivityKind, ToolDetection, ToolOutcome};

pub struct Codex;

impl LogAdapter for Codex {
    fn key(&self) -> &'static str {
        "codex"
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

    fn parse_file(&self, path: &Path) -> Vec<RawUsage> {
        parse_rollout_usage(path)
    }

    fn parse_content(&self, path: &Path) -> Vec<RawContent> {
        parse_rollout(path)
    }

    fn parse_changed(&self, path: &Path, include_content: bool, include_tools: bool) -> ParsedLog {
        parse_rollout_all(path, include_content, include_tools)
    }
}

fn parse_mcp_name(name: &str) -> Option<String> {
    let rest = name.strip_prefix("mcp__")?;
    let (server, tool) = rest.split_once("__")?;
    if server.is_empty() || tool.is_empty() {
        return None;
    }
    let mut key = String::with_capacity(server.len() + tool.len() + 1);
    key.push_str(server);
    key.push('.');
    if tool.contains("__") {
        let mut parts = tool.split("__");
        if let Some(first) = parts.next() {
            key.push_str(first);
        }
        for part in parts {
            key.push('.');
            key.push_str(part);
        }
    } else {
        key.push_str(tool);
    }
    Some(key)
}

fn skill_names_from_input(input: &str) -> Vec<(String, Option<String>)> {
    let mut names = Vec::new();
    for token in input.split_whitespace() {
        let path =
            token.trim_matches(|ch: char| matches!(ch, '"' | '\'' | '}' | ']' | ')' | ',' | ';'));
        if !path.ends_with("/SKILL.md") {
            continue;
        }
        if !(path.contains("/.codex/skills/")
            || path.contains("/.agents/skills/")
            || path.contains("/.claude/skills/")
            || path.contains("/.codex/plugins/cache/"))
        {
            continue;
        }
        if let Some(name) = path.trim_end_matches("/SKILL.md").rsplit('/').next() {
            if name.is_empty() || names.iter().any(|(existing, _)| existing == name) {
                continue;
            }
            let segments: Vec<&str> = path.split('/').collect();
            let plugin = segments
                .iter()
                .position(|segment| *segment == "cache")
                .and_then(|index| segments.get(index + 2))
                .filter(|plugin| !plugin.is_empty())
                .map(|plugin| (*plugin).to_string());
            names.push((name.to_string(), plugin));
        }
    }
    names
}

fn parse_rollout_all(path: &Path, include_content: bool, include_tools: bool) -> ParsedLog {
    let fallback = file_mtime_ms(path);
    let Ok(bytes) = std::fs::read(path) else {
        return ParsedLog::default();
    };
    let mut parsed = ParsedLog::default();
    let mut session_id: Option<Arc<str>> = None;
    let mut model: Option<String> = None;
    let mut last_seen_total: Option<(u64, u64)> = None;
    for line in bytes.split(|byte| *byte == b'\n') {
        let Ok(value) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        let Some(obj) = value.as_object() else {
            continue;
        };
        let ty = obj.get("type").and_then(Value::as_str);
        let payload = obj.get("payload").and_then(Value::as_object);
        let ts_ms = obj
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(iso_to_epoch_ms)
            .unwrap_or(fallback);
        if ty == Some("session_meta") {
            session_id = payload
                .and_then(|item| item.get("session_id"))
                .and_then(Value::as_str)
                .map(Arc::from);
            continue;
        }
        if ty == Some("turn_context") {
            if let Some(value) = payload
                .and_then(|item| item.get("model"))
                .and_then(Value::as_str)
            {
                model = Some(value.to_string());
            }
            continue;
        }
        if ty == Some("event_msg") {
            let Some(item) = payload else { continue };
            match item.get("type").and_then(Value::as_str) {
                Some("token_count") => {
                    let Some(info) = item.get("info").and_then(Value::as_object) else {
                        continue;
                    };
                    if let Some(total) = info.get("total_token_usage").and_then(Value::as_object) {
                        let count = |key: &str| total.get(key).and_then(Value::as_u64).unwrap_or(0);
                        let current = (count("input_tokens"), count("output_tokens"));
                        if last_seen_total == Some(current) {
                            continue;
                        }
                        last_seen_total = Some(current);
                    }
                    let Some(last) = info.get("last_token_usage").and_then(Value::as_object) else {
                        continue;
                    };
                    let count = |key: &str| last.get(key).and_then(Value::as_u64).unwrap_or(0);
                    let cached = count("cached_input_tokens");
                    let usage = RawUsage {
                        ts_ms,
                        session_id: session_id.as_deref().map(str::to_string),
                        model: model.clone(),
                        message_id: None,
                        input_tokens: count("input_tokens").saturating_sub(cached),
                        output_tokens: count("output_tokens"),
                        cache_read_tokens: cached,
                        cache_creation_tokens: 0,
                        cache_creation_1h_tokens: 0,
                    };
                    if usage.input_tokens + usage.output_tokens + usage.cache_read_tokens > 0 {
                        parsed.usage.push(usage);
                    }
                }
                Some("user_message" | "agent_message") if include_content => {
                    let Some(text) = item.get("message").and_then(Value::as_str).map(str::trim)
                    else {
                        continue;
                    };
                    if !text.is_empty() {
                        parsed.content.push(RawContent {
                            ts_ms,
                            session_id: session_id.as_deref().map(str::to_string),
                            message_id: None,
                            role: if item.get("type").and_then(Value::as_str)
                                == Some("user_message")
                            {
                                "user"
                            } else {
                                "assistant"
                            },
                            text: text.to_string(),
                        });
                    }
                }
                _ => {}
            }
            continue;
        }
        if !include_tools || ty != Some("response_item") {
            continue;
        }
        let Some(item) = payload else { continue };
        let item_type = item.get("type").and_then(Value::as_str);
        if !matches!(item_type, Some("function_call" | "custom_tool_call")) {
            continue;
        }
        let Some(name) = item.get("name").and_then(Value::as_str) else {
            continue;
        };
        let call_id = item
            .get("call_id")
            .or_else(|| item.get("id"))
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let outcome = match item.get("status").and_then(Value::as_str) {
            Some("completed") => ToolOutcome::Success,
            Some("failed") => ToolOutcome::Failure,
            _ => ToolOutcome::Unknown,
        };
        if let Some(item_key) = parse_mcp_name(name) {
            parsed.tools.push(RawToolActivity {
                ts_ms,
                session_id: session_id.clone(),
                call_id: call_id.to_string(),
                kind: ToolActivityKind::Mcp,
                item_key,
                plugin_key: None,
                outcome,
                detection: ToolDetection::Explicit,
            });
        }
        if matches!(
            name,
            "exec_command" | "shell_command" | "exec" | "read_file"
        ) {
            let input = item
                .get("arguments")
                .or_else(|| item.get("input"))
                .map(|value| {
                    value
                        .as_str()
                        .map(str::to_string)
                        .unwrap_or_else(|| value.to_string())
                })
                .unwrap_or_default();
            for (skill, plugin_key) in skill_names_from_input(&input) {
                parsed.tools.push(RawToolActivity {
                    ts_ms,
                    session_id: session_id.clone(),
                    call_id: format!("{call_id}:{skill}"),
                    kind: ToolActivityKind::Skill,
                    item_key: skill,
                    plugin_key,
                    outcome,
                    detection: ToolDetection::DerivedLoad,
                });
            }
        }
    }
    parsed
}

/// 롤아웃 jsonl → 사용량 레코드 (§4.2·§4.3 — 실측 검증).
///
/// 규칙:
///  - `session_meta` → session_id, `turn_context` → model 을 승계(실측: 모델은 turn_context.payload.model).
///  - `token_count` 의 `info.last_token_usage`(턴 델타)를 billing 하되, **`total_token_usage`(누적)가
///    직전과 같은 재방출은 스킵**한다. 일부 Codex 버전이 같은 턴 token_count 를 2~3회 방출하는데
///    (last/total 값 동일·ts 만 다름) 단순 합산 시 2~3배가 된다. total 변화 시에만 billing 하면
///    authoritative total 과 정확히 일치(실측: input_excl+cache_read=total.input, output=total.output).
///  - Codex `input_tokens` 는 cached 를 **포함** → `input − cached`(saturating)로 캐시 제외분 산출(§4.2).
///  - `info==null` 이벤트(실측 존재)와 토큰 전부 0 은 스킵.
fn parse_rollout_usage(path: &Path) -> Vec<RawUsage> {
    let fallback = file_mtime_ms(path);
    let Ok(bytes) = std::fs::read(path) else {
        return Vec::new();
    };
    let mut session_id: Option<String> = None;
    let mut model: Option<String> = None;
    let mut last_seen_total: Option<(u64, u64)> = None;
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

        match ty {
            Some("session_meta") => {
                if let Some(p) = payload {
                    session_id = p
                        .get("session_id")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                }
                continue;
            }
            Some("turn_context") => {
                if let Some(m) = payload.and_then(|p| p.get("model")).and_then(Value::as_str) {
                    model = Some(m.to_string());
                }
                continue;
            }
            Some("event_msg") => {}
            _ => continue,
        }

        let Some(p) = payload else { continue };
        if p.get("type").and_then(Value::as_str) != Some("token_count") {
            continue;
        }
        // info==null 이벤트는 스킵(실측: 18995개 중 4개 등 존재 — 스킵 안 하면 크래시).
        let Some(info) = p.get("info").and_then(Value::as_object) else {
            continue;
        };

        // 중복 방출 dedup: total_token_usage(누적)가 직전과 같으면 같은 턴 재방출 → 스킵.
        // total 부재(구/특수 포맷)면 비교 불가라 그대로 emit(실측상 total 은 항상 존재).
        if let Some(tt) = info.get("total_token_usage").and_then(Value::as_object) {
            let u = |k: &str| tt.get(k).and_then(Value::as_u64).unwrap_or(0);
            let cur = (u("input_tokens"), u("output_tokens"));
            if last_seen_total == Some(cur) {
                continue;
            }
            last_seen_total = Some(cur);
        }

        let Some(lt) = info.get("last_token_usage").and_then(Value::as_object) else {
            continue;
        };
        let tok = |k: &str| lt.get(k).and_then(Value::as_u64).unwrap_or(0);
        let cached = tok("cached_input_tokens");
        // Codex input_tokens 는 cached 를 포함(실측: total=input+output, cached⊂input) →
        // UsageEvent 불변식(input=캐시 제외)에 맞춰 빼준다. saturating 으로 음수 방어(리스크 A).
        let input_tokens = tok("input_tokens").saturating_sub(cached);
        // reasoning_output_tokens ⊂ output_tokens(실측) → 따로 더하지 않음.
        let output_tokens = tok("output_tokens");
        if input_tokens == 0 && output_tokens == 0 && cached == 0 {
            continue;
        }
        out.push(RawUsage {
            ts_ms: obj
                .get("timestamp")
                .and_then(Value::as_str)
                .and_then(iso_to_epoch_ms)
                .unwrap_or(fallback),
            session_id: session_id.clone(),
            model: model.clone(),
            // token_count 엔 message id 가 없음 → dedup 은 session+ts+model+in+out(§4.3).
            message_id: None,
            input_tokens,
            output_tokens,
            cache_read_tokens: cached,
            // Codex 는 캐시 생성 개념 없음 → 0.
            cache_creation_tokens: 0,
            cache_creation_1h_tokens: 0,
        });
    }
    out
}

fn sessions_dir() -> Option<PathBuf> {
    if let Some(h) = std::env::var_os("CODEX_HOME") {
        return Some(PathBuf::from(h).join("sessions"));
    }
    crate::fsx::home_dir().map(|h| h.join(".codex").join("sessions"))
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
    fn parses_token_count_with_dedup_and_cache_split() {
        let tmp = TempDir::new("codex-usage");
        // 실 롤아웃 구조 기반 골든(2025-11 중복 방출 세션 반영):
        //  - session_meta → session, turn_context → model
        //  - 같은 턴 token_count 3회 방출(last/total 동일·ts 만 다름) → 1건만 billing
        //  - 다음 턴 total 증가 → billing
        //  - info==null 이벤트 스킵
        let path = tmp.write(
            "sessions/2025/11/10/rollout.jsonl",
            &[
                r#"{"type":"session_meta","payload":{"session_id":"019a6d26","cwd":"/x","model_provider":"openai"}}"#,
                r#"{"type":"turn_context","payload":{"model":"gpt-5.5"}}"#,
                // 턴1 — 3회 재방출(total.input=3133, last in=3133 cached=1920 out=45)
                r#"{"timestamp":"2025-11-11T01:07:46.873Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":3133,"cached_input_tokens":1920,"output_tokens":45},"total_token_usage":{"input_tokens":3133,"output_tokens":45}}}}"#,
                r#"{"timestamp":"2025-11-11T01:07:47.366Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":3133,"cached_input_tokens":1920,"output_tokens":45},"total_token_usage":{"input_tokens":3133,"output_tokens":45}}}}"#,
                r#"{"timestamp":"2025-11-11T01:08:00.732Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":3133,"cached_input_tokens":1920,"output_tokens":45},"total_token_usage":{"input_tokens":3133,"output_tokens":45}}}}"#,
                // info==null → 스킵(크래시 방어)
                r#"{"timestamp":"2025-11-11T01:08:01.000Z","type":"event_msg","payload":{"type":"token_count","info":null}}"#,
                // 턴2 — total 증가(6490) → billing. last in=3357 cached=3072 out=70
                r#"{"timestamp":"2025-11-11T01:08:02.013Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":3357,"cached_input_tokens":3072,"output_tokens":70},"total_token_usage":{"input_tokens":6490,"output_tokens":115}}}}"#,
            ]
            .join("\n"),
        );
        let recs = Codex.parse_file(&path);
        assert!(Codex.collects_usage(), "이제 사용량도 수집");
        assert_eq!(Codex.key(), "codex");
        assert_eq!(recs.len(), 2, "재방출 2건·info=null 제외 → 실제 턴 2건만");

        let t1 = &recs[0];
        assert_eq!(t1.input_tokens, 3133 - 1920, "input = input−cached");
        assert_eq!(t1.cache_read_tokens, 1920);
        assert_eq!(t1.output_tokens, 45);
        assert_eq!(t1.cache_creation_tokens, 0, "Codex 캐시생성 없음");
        assert_eq!(
            t1.model.as_deref(),
            Some("gpt-5.5"),
            "turn_context 모델 승계"
        );
        assert_eq!(t1.session_id.as_deref(), Some("019a6d26"));
        assert_eq!(t1.message_id, None, "token_count 엔 id 없음");
        assert_eq!(
            t1.ts_ms,
            iso_to_epoch_ms("2025-11-11T01:07:46.873Z").unwrap()
        );

        let t2 = &recs[1];
        assert_eq!(t2.input_tokens, 3357 - 3072);
        assert_eq!(t2.cache_read_tokens, 3072);
        assert_eq!(t2.output_tokens, 70);

        // billing 합 = authoritative 최종 total 재구성: input_excl+cache_read=total.input, output=total.output
        let bin: u64 = recs.iter().map(|r| r.input_tokens).sum();
        let bcache: u64 = recs.iter().map(|r| r.cache_read_tokens).sum();
        let bout: u64 = recs.iter().map(|r| r.output_tokens).sum();
        assert_eq!(bin + bcache, 6490, "input_excl+cache_read == total.input");
        assert_eq!(bout, 115, "output == total.output");
    }

    #[test]
    fn usage_saturates_when_cached_exceeds_input() {
        let tmp = TempDir::new("codex-usage-sat");
        // 방어: cached>input 이면 saturating_sub 로 0(음수 언더플로 없음).
        let path = tmp.write(
            "sessions/x.jsonl",
            r#"{"timestamp":"2026-07-06T00:00:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"cached_input_tokens":150,"output_tokens":5},"total_token_usage":{"input_tokens":100,"output_tokens":5}}}}"#,
        );
        let recs = Codex.parse_file(&path);
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].input_tokens, 0, "언더플로 없이 0");
        assert_eq!(recs[0].cache_read_tokens, 150);
    }

    #[test]
    fn parses_mcp_and_skill_load_without_serializing_command() {
        let tmp = TempDir::new("codex-tools");
        let path = tmp.write(
            "sessions/tools.jsonl",
            &[
                r#"{"type":"session_meta","payload":{"session_id":"s1"}}"#,
                r#"{"timestamp":"2026-07-10T00:00:00Z","type":"response_item","payload":{"type":"function_call","name":"mcp__github__get_issue","call_id":"call-1","arguments":"{\"owner\":\"secret\"}"}}"#,
                r#"{"timestamp":"2026-07-10T00:00:01Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","call_id":"call-2","arguments":"{\"cmd\":\"sed -n 1,200p /Users/test/.codex/plugins/cache/openai-curated-remote/superpowers/6.1.1/skills/brainstorming/SKILL.md\"}"}}"#,
            ]
            .join("\n"),
        );

        let parsed = Codex.parse_changed(&path, false, true);
        assert_eq!(parsed.tools.len(), 2);
        assert_eq!(parsed.tools[0].item_key, "github.get_issue");
        assert_eq!(parsed.tools[1].item_key, "brainstorming");
        assert_eq!(parsed.tools[1].plugin_key.as_deref(), Some("superpowers"));
        assert_eq!(parsed.tools[1].detection, ToolDetection::DerivedLoad);
        let body = crate::tool_event::to_tool_events_body("codex", Some("box"), &parsed.tools);
        assert!(!body.contains("sed -n"));
        assert!(!body.contains("/Users/test"));
        assert!(!body.contains("secret"));
    }

    #[test]
    #[ignore = "release 성능 검증에서 명시적으로 실행"]
    fn benchmark_collect_fixture_stays_within_ten_percent() {
        use std::time::Instant;

        let tmp = TempDir::new("codex-benchmark");
        let mut lines =
            vec![r#"{"type":"session_meta","payload":{"session_id":"bench"}}"#.to_string()];
        const RECORDS: usize = 5_000;
        for index in 1..=RECORDS {
            lines.push(
                serde_json::json!({
                    "timestamp": "2026-07-10T00:00:00Z",
                    "type": "event_msg",
                    "payload": {
                        "type": "token_count",
                        "info": {
                            "last_token_usage": {
                                "input_tokens": 100,
                                "cached_input_tokens": 50,
                                "output_tokens": 20
                            },
                            "total_token_usage": {
                                "input_tokens": index * 100,
                                "output_tokens": index * 20
                            }
                        }
                    }
                })
                .to_string(),
            );
            lines.push(
                serde_json::json!({
                    "timestamp": "2026-07-10T00:00:01Z",
                    "type": "response_item",
                    "payload": {
                        "type": "function_call",
                        "name": "mcp__github__get_issue",
                        "call_id": format!("call-{index}"),
                        "arguments": "{}"
                    }
                })
                .to_string(),
            );
        }
        let path = tmp.write("sessions/bench.jsonl", &lines.join("\n"));

        let baseline = || {
            let start = Instant::now();
            assert_eq!(Codex.parse_file(&path).len(), RECORDS);
            start.elapsed().as_nanos()
        };
        let feature = || {
            let start = Instant::now();
            let parsed = Codex.parse_changed(&path, false, true);
            assert_eq!(parsed.tools.len(), RECORDS);
            start.elapsed().as_nanos()
        };

        for _ in 0..3 {
            let _ = baseline();
            let _ = feature();
        }

        let mut baseline_times = Vec::new();
        let mut feature_times = Vec::new();
        for index in 0..31 {
            let (base, with_tools) = if index % 2 == 0 {
                (baseline(), feature())
            } else {
                let with_tools = feature();
                (baseline(), with_tools)
            };
            baseline_times.push(base);
            feature_times.push(with_tools);
        }
        baseline_times.sort_unstable();
        feature_times.sort_unstable();
        let baseline_total: u128 = baseline_times[5..26].iter().sum();
        let feature_total: u128 = feature_times[5..26].iter().sum();
        let trimmed_ratio = feature_total as f64 / baseline_total as f64;
        eprintln!(
            "trimmed_mean_overhead={:.2}%",
            (trimmed_ratio - 1.0) * 100.0
        );
        assert!(
            trimmed_ratio <= 1.10,
            "도구 파서 CPU 증가가 10%를 초과했습니다"
        );
    }
}

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
        parse_rollout_all(path, false, false).usage
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
    let mut first_session_id: Option<String> = None;
    let mut source_is_subagent = false;
    let mut saw_foreign_session = false;
    let mut first_live_fork_task: Option<usize> = None;
    let mut first_inter_agent_marker: Option<usize> = None;
    let mut positioned_usage = Vec::new();
    for (line_index, line) in bytes.split(|byte| *byte == b'\n').enumerate() {
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
            let next_session_id = payload
                .and_then(|item| item.get("session_id"))
                .and_then(Value::as_str)
                .map(str::to_string);
            if first_session_id.is_none() {
                first_session_id = next_session_id.clone();
                source_is_subagent = payload
                    .and_then(|item| item.get("source"))
                    .and_then(Value::as_object)
                    .is_some_and(|source| source.contains_key("subagent"));
            } else if next_session_id != first_session_id {
                // vscode fork/resume는 새 rollout의 session_meta 뒤에 다른 세션의 전체
                // 기록을 복사한다. 현재 session UUID 이후의 첫 turn이 live 경계다.
                saw_foreign_session = true;
            }
            session_id = next_session_id.map(Arc::from);
            continue;
        }
        if ty == Some("inter_agent_communication_metadata") {
            first_inter_agent_marker.get_or_insert(line_index);
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
            if item.get("type").and_then(Value::as_str) == Some("task_started")
                && saw_foreign_session
                && !source_is_subagent
                && first_live_fork_task.is_none()
            {
                let is_current_turn = item
                    .get("turn_id")
                    .and_then(Value::as_str)
                    .zip(first_session_id.as_deref())
                    .is_some_and(|(turn_id, current_session_id)| turn_id >= current_session_id);
                if is_current_turn {
                    first_live_fork_task = Some(line_index);
                }
            }
            match item.get("type").and_then(Value::as_str) {
                Some("token_count") => {
                    let Some(info) = item.get("info").and_then(Value::as_object) else {
                        continue;
                    };
                    // subagent rollout 앞부분에는 부모 세션 token_count가 재생될 수 있다.
                    // 이 세션의 turn_context(model)가 나오기 전 값은 자체 사용량이 아니다.
                    let Some(current_model) = model.as_ref().filter(|value| !value.is_empty())
                    else {
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
                        model: Some(current_model.clone()),
                        message_id: None,
                        input_tokens: count("input_tokens").saturating_sub(cached),
                        output_tokens: count("output_tokens"),
                        cache_read_tokens: cached,
                        cache_creation_tokens: 0,
                        cache_creation_1h_tokens: 0,
                    };
                    if usage.input_tokens + usage.output_tokens + usage.cache_read_tokens > 0 {
                        positioned_usage.push((line_index, usage));
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
    let replay_cutoff = if source_is_subagent {
        first_inter_agent_marker
    } else if saw_foreign_session {
        first_live_fork_task
    } else {
        None
    };
    for (line_index, usage) in positioned_usage {
        if replay_cutoff.is_some_and(|cutoff| line_index < cutoff) {
            parsed.replayed_usage.push(usage);
        } else {
            parsed.usage.push(usage);
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
    fn skips_replayed_subagent_usage_before_first_turn_context() {
        let tmp = TempDir::new("codex-subagent-replay");
        let path = tmp.write(
            "sessions/2026/07/13/rollout.jsonl",
            &[
                r#"{"type":"session_meta","payload":{"session_id":"subagent-1","source":{"subagent":{"thread_spawn":true}}}}"#,
                // Codex Desktop가 부모 기록을 재생한 구간: 아직 이 세션의 모델 문맥이 없다.
                r#"{"timestamp":"2026-07-13T09:14:50.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":10},"total_token_usage":{"input_tokens":100,"output_tokens":10}}}}"#,
                r#"{"timestamp":"2026-07-13T09:14:56.000Z","type":"turn_context","payload":{"model":"gpt-5.6-sol"}}"#,
                // 같은 누적값이어도 turn_context 뒤의 실제 사용량은 한 번 수집해야 한다.
                r#"{"timestamp":"2026-07-13T09:14:57.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":10},"total_token_usage":{"input_tokens":100,"output_tokens":10}}}}"#,
            ]
            .join("\n"),
        );

        let usage_only = Codex.parse_file(&path);
        let parsed_all = Codex.parse_changed(&path, false, false);

        for usages in [&usage_only, &parsed_all.usage] {
            assert_eq!(usages.len(), 1, "모델 문맥 이전 재생분은 수집하지 않는다");
            assert_eq!(usages[0].model.as_deref(), Some("gpt-5.6-sol"));
            assert_eq!(
                usages[0].ts_ms,
                iso_to_epoch_ms("2026-07-13T09:14:57.000Z").unwrap(),
            );
        }
    }

    #[test]
    fn separates_full_fork_replay_from_live_subagent_usage() {
        let tmp = TempDir::new("codex-full-fork-replay");
        let path = tmp.write(
            "sessions/2026/07/15/rollout.jsonl",
            &[
                // 새 subagent rollout의 정체성. 그 뒤에는 부모 rollout이 통째로 복사된다.
                r#"{"timestamp":"2026-07-15T01:20:20.000Z","type":"session_meta","payload":{"session_id":"subagent-current","source":{"subagent":{"thread_spawn":true}}}}"#,
                r#"{"timestamp":"2026-07-15T01:20:21.000Z","type":"session_meta","payload":{"session_id":"parent-replayed","source":"vscode"}}"#,
                r#"{"timestamp":"2026-07-15T01:20:21.000Z","type":"turn_context","payload":{"model":"gpt-5.6-sol"}}"#,
                r#"{"timestamp":"2026-07-15T01:20:21.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":10},"total_token_usage":{"input_tokens":100,"output_tokens":10}}}}"#,
                // 이 구조적 marker 이후부터가 새 subagent의 실제 실행이다.
                r#"{"timestamp":"2026-07-15T01:20:27.000Z","type":"inter_agent_communication_metadata","payload":{"trigger_turn":true}}"#,
                r#"{"timestamp":"2026-07-15T01:20:28.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":200,"cached_input_tokens":160,"output_tokens":20},"total_token_usage":{"input_tokens":300,"output_tokens":30}}}}"#,
            ]
            .join("\n"),
        );

        let parsed = Codex.parse_changed(&path, false, false);

        assert_eq!(parsed.replayed_usage.len(), 1);
        assert_eq!(parsed.replayed_usage[0].output_tokens, 10);
        assert_eq!(parsed.usage.len(), 1);
        assert_eq!(parsed.usage[0].output_tokens, 20);
        // 과거 parser가 저장한 키를 그대로 재현하려면 복사된 부모 session_id 승계를 보존해야 한다.
        assert_eq!(
            parsed.replayed_usage[0].session_id.as_deref(),
            Some("parent-replayed")
        );
    }

    #[test]
    fn separates_vscode_fork_without_inter_agent_marker() {
        let tmp = TempDir::new("codex-vscode-fork-replay");
        let path = tmp.write(
            "sessions/2026/07/15/rollout.jsonl",
            &[
                r#"{"type":"session_meta","payload":{"session_id":"019f5a26-67e2-7011-9a5f-abeff38bf4df","source":"vscode"}}"#,
                r#"{"type":"session_meta","payload":{"session_id":"019f5634-1aba-70c3-95f1-d1dacd259ecb","source":"vscode"}}"#,
                // foreign meta 직후의 task도 복사본일 수 있다. 이 지점에서 live로 바꾸면 안 된다.
                r#"{"type":"event_msg","payload":{"type":"task_started","turn_id":"019f5634-1dec-7282-a5fb-4f65770d9e50"}}"#,
                r#"{"type":"turn_context","payload":{"model":"gpt-5.6-sol"}}"#,
                r#"{"timestamp":"2026-07-15T01:00:00Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":10},"total_token_usage":{"input_tokens":100,"output_tokens":10}}}}"#,
                r#"{"timestamp":"2026-07-15T02:00:00Z","type":"event_msg","payload":{"type":"task_started","turn_id":"019f5a26-b995-70f0-8529-fc00110fe745"}}"#,
                r#"{"timestamp":"2026-07-15T02:00:01Z","type":"turn_context","payload":{"model":"gpt-5.6-sol"}}"#,
                r#"{"timestamp":"2026-07-15T02:00:02Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":200,"cached_input_tokens":160,"output_tokens":20},"total_token_usage":{"input_tokens":300,"output_tokens":30}}}}"#,
            ]
            .join("\n"),
        );

        let parsed = Codex.parse_changed(&path, false, false);

        assert_eq!(parsed.replayed_usage.len(), 1);
        assert_eq!(parsed.usage.len(), 1);
        assert_eq!(parsed.usage[0].output_tokens, 20);
    }

    #[test]
    fn keeps_root_usage_around_inter_agent_messages() {
        let tmp = TempDir::new("codex-root-inter-agent-message");
        let path = tmp.write(
            "sessions/2026/07/15/rollout.jsonl",
            &[
                r#"{"type":"session_meta","payload":{"session_id":"root","source":"vscode"}}"#,
                r#"{"type":"turn_context","payload":{"model":"gpt-5.6-sol"}}"#,
                r#"{"timestamp":"2026-07-15T01:00:00Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":10},"total_token_usage":{"input_tokens":100,"output_tokens":10}}}}"#,
                r#"{"timestamp":"2026-07-15T01:00:01Z","type":"inter_agent_communication_metadata","payload":{"trigger_turn":true}}"#,
                r#"{"timestamp":"2026-07-15T01:00:02Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":200,"cached_input_tokens":160,"output_tokens":20},"total_token_usage":{"input_tokens":300,"output_tokens":30}}}}"#,
            ]
            .join("\n"),
        );

        let parsed = Codex.parse_changed(&path, false, false);

        assert!(parsed.replayed_usage.is_empty());
        assert_eq!(parsed.usage.len(), 2);
    }

    #[test]
    fn usage_saturates_when_cached_exceeds_input() {
        let tmp = TempDir::new("codex-usage-sat");
        // 방어: cached>input 이면 saturating_sub 로 0(음수 언더플로 없음).
        let path = tmp.write(
            "sessions/x.jsonl",
            &[
                r#"{"type":"turn_context","payload":{"model":"gpt-5.6-sol"}}"#,
                r#"{"timestamp":"2026-07-06T00:00:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"cached_input_tokens":150,"output_tokens":5},"total_token_usage":{"input_tokens":100,"output_tokens":5}}}}"#,
            ].join("\n"),
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
        let mut lines = vec![
            r#"{"type":"session_meta","payload":{"session_id":"bench"}}"#.to_string(),
            r#"{"type":"turn_context","payload":{"model":"gpt-5.6-sol"}}"#.to_string(),
        ];
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

// Cursor Agent 하이브리드 어댑터.
// - 정확 사용량: user-global stop hook이 최소 필드만 기록한 ~/.toard/cursor/usage.jsonl
// - 세션 본문/도구 활동: ~/.cursor/projects/**/agent-transcripts/**/*.{jsonl,txt}
//
// transcript의 토큰 필드는 버전·세션별로 불완전하고 hook 기록과 중복될 수 있으므로
// 사용량으로 집계하지 않는다. 본문은 기존 어댑터와 동일하게 명시적 opt-in에서만 읽는다.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::Value;

use super::{
    file_mtime_ms, walk_files, LogAdapter, ParsedLog, RawContent, RawToolActivity, RawUsage,
};
use crate::cursor_hook::CapturedUsage;
use crate::iso::iso_to_epoch_ms;
use crate::tool_event::{ToolActivityKind, ToolDetection, ToolOutcome};

pub struct CursorUsage;

impl LogAdapter for CursorUsage {
    fn key(&self) -> &'static str {
        "cursor"
    }

    fn discover_files(&self) -> Vec<PathBuf> {
        let mut files = crate::cursor_hook::usage_log_path()
            .filter(|path| path.is_file())
            .into_iter()
            .collect::<Vec<_>>();
        if let Some(root) = cursor_home().map(|home| home.join("projects")) {
            walk_files(&root, &["jsonl", "txt"], &mut files, 0);
            files.retain(|path| is_agent_transcript(path) || is_usage_log(path));
        }
        files.sort();
        files.dedup();
        files
    }

    fn parse_file(&self, path: &Path) -> Vec<RawUsage> {
        parse_usage_file(path)
    }

    fn parse_changed(&self, path: &Path, include_content: bool, include_tools: bool) -> ParsedLog {
        if is_usage_log(path) {
            return ParsedLog {
                usage: parse_usage_file(path),
                ..ParsedLog::default()
            };
        }
        match path.extension().and_then(|extension| extension.to_str()) {
            Some("jsonl") => parse_jsonl_transcript(path, include_content, include_tools),
            Some("txt") => parse_legacy_transcript(path, include_content, include_tools),
            _ => ParsedLog::default(),
        }
    }
}

fn cursor_home() -> Option<PathBuf> {
    std::env::var_os("CURSOR_AGENT_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| crate::fsx::home_dir().map(|home| home.join(".cursor")))
}

fn is_agent_transcript(path: &Path) -> bool {
    path.components()
        .any(|component| component.as_os_str() == "agent-transcripts")
}

fn is_usage_log(path: &Path) -> bool {
    if crate::cursor_hook::usage_log_path().as_deref() == Some(path) {
        return true;
    }
    path.file_name().and_then(|name| name.to_str()) == Some("usage.jsonl")
        && path
            .parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            == Some("cursor")
        && path
            .parent()
            .and_then(Path::parent)
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            == Some(".toard")
}

fn parse_usage_file(path: &Path) -> Vec<RawUsage> {
    let Ok(bytes) = std::fs::read(path) else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    bytes
        .split(|byte| *byte == b'\n')
        .filter_map(|line| serde_json::from_slice::<CapturedUsage>(line).ok())
        .filter(|usage| seen.insert(usage.generation_id.clone()))
        .filter(|usage| {
            usage.input_tokens > 0
                || usage.output_tokens > 0
                || usage.cache_read_tokens > 0
                || usage.cache_creation_tokens > 0
        })
        .map(|usage| RawUsage {
            ts_ms: usage.ts_ms,
            session_id: usage.session_id,
            model: usage.model,
            message_id: Some(usage.generation_id),
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cache_read_tokens: usage.cache_read_tokens,
            cache_creation_tokens: usage.cache_creation_tokens,
            cache_creation_1h_tokens: 0,
        })
        .collect()
}

fn session_id_from_path(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    if matches!(stem, "transcript" | "agent-transcript") {
        path.parent()?.file_name()?.to_str().map(str::to_string)
    } else {
        Some(stem.to_string())
    }
}

fn timestamp_value(value: &Value) -> Option<i64> {
    if let Some(raw) = value.as_i64() {
        return if (1..10_000_000_000).contains(&raw) {
            Some(raw.saturating_mul(1000))
        } else if raw > 0 {
            Some(raw)
        } else {
            None
        };
    }
    value.as_str().and_then(|raw| {
        iso_to_epoch_ms(raw).or_else(|| {
            raw.parse::<i64>().ok().and_then(|parsed| {
                if (1..10_000_000_000).contains(&parsed) {
                    Some(parsed.saturating_mul(1000))
                } else if parsed > 0 {
                    Some(parsed)
                } else {
                    None
                }
            })
        })
    })
}

fn timestamp_at(value: &Value, message: &Value, fallback: i64) -> i64 {
    ["timestamp", "createdAt", "created_at"]
        .iter()
        .find_map(|key| value.get(*key).and_then(timestamp_value))
        .or_else(|| {
            ["timestamp", "createdAt", "created_at"]
                .iter()
                .find_map(|key| message.get(*key).and_then(timestamp_value))
        })
        .unwrap_or(fallback)
}

fn parse_mcp_name(name: &str) -> Option<String> {
    let rest = name.strip_prefix("mcp__")?;
    let (server, tool) = rest.split_once("__")?;
    if server.is_empty() || tool.is_empty() {
        return None;
    }
    Some(format!("{server}.{}", tool.replace("__", ".")))
}

fn skill_identity(input: &Value) -> Option<(String, Option<String>)> {
    let raw = input
        .get("skill")
        .or_else(|| input.get("name"))
        .and_then(Value::as_str)?;
    let name = raw.rsplit(':').next()?.trim();
    if name.is_empty() {
        return None;
    }
    let plugin = raw
        .split_once(':')
        .map(|(prefix, _)| prefix.trim())
        .filter(|prefix| !prefix.is_empty() && *prefix != name)
        .map(str::to_string);
    Some((name.to_string(), plugin))
}

fn remove_tagged_sections(mut text: String, tag: &str) -> String {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    while let Some(start) = text.find(&open) {
        let Some(relative_end) = text[start + open.len()..].find(&close) else {
            text.truncate(start);
            break;
        };
        let end = start + open.len() + relative_end + close.len();
        text.replace_range(start..end, "");
    }
    text
}

fn tagged_sections(text: &str, tag: &str) -> Vec<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut rest = text;
    let mut values = Vec::new();
    while let Some(start) = rest.find(&open) {
        let after_open = &rest[start + open.len()..];
        let Some(end) = after_open.find(&close) else {
            break;
        };
        values.push(after_open[..end].to_string());
        rest = &after_open[end + close.len()..];
    }
    values
}

fn clean_text(text: &str, role: &str) -> String {
    let user_queries = if role == "user" {
        tagged_sections(text, "user_query")
    } else {
        Vec::new()
    };
    let mut cleaned = if user_queries.is_empty() {
        text.to_string()
    } else {
        user_queries.join("\n")
    };
    for tag in [
        "timestamp",
        "system_reminder",
        "environment_context",
        "attached_files",
        "workspace_context",
    ] {
        cleaned = remove_tagged_sections(cleaned, tag);
    }
    cleaned.trim().to_string()
}

fn text_from_content(content: Option<&Value>, role: &str) -> String {
    let values = match content {
        Some(Value::String(text)) => vec![text.as_str()],
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|block| {
                if block.get("type").and_then(Value::as_str) == Some("text") {
                    block.get("text").and_then(Value::as_str)
                } else {
                    None
                }
            })
            .collect(),
        _ => Vec::new(),
    };
    clean_text(&values.join("\n"), role)
}

fn tool_blocks(content: Option<&Value>) -> impl Iterator<Item = &Value> {
    content.and_then(Value::as_array).into_iter().flatten()
}

fn parse_jsonl_transcript(path: &Path, include_content: bool, include_tools: bool) -> ParsedLog {
    let fallback = file_mtime_ms(path);
    let fallback_session = session_id_from_path(path);
    let Ok(bytes) = std::fs::read(path) else {
        return ParsedLog::default();
    };
    let mut parsed = ParsedLog::default();
    let mut pending = HashMap::<String, usize>::new();

    for (line_index, line) in bytes.split(|byte| *byte == b'\n').enumerate() {
        let Ok(value) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        let message = value.get("message").unwrap_or(&value);
        let Some(role) = value
            .get("role")
            .or_else(|| message.get("role"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        if !matches!(role, "user" | "assistant") {
            continue;
        }
        let content = message.get("content").or_else(|| value.get("content"));
        let ts_ms = timestamp_at(&value, message, fallback);
        let session = value
            .get("sessionId")
            .or_else(|| value.get("session_id"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| fallback_session.clone());
        let session_arc = session.as_deref().map(Arc::from);
        let message_id = value
            .get("id")
            .or_else(|| value.get("uuid"))
            .or_else(|| value.get("generation_id"))
            .or_else(|| message.get("id"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                Some(format!(
                    "{}:{line_index}:{role}",
                    session.as_deref().unwrap_or("cursor")
                ))
            });

        if include_content {
            let text = text_from_content(content, role);
            if !text.is_empty() {
                parsed.content.push(RawContent {
                    ts_ms,
                    session_id: session.clone(),
                    message_id,
                    role: if role == "user" { "user" } else { "assistant" },
                    text,
                });
            }
        }

        if include_tools && role == "assistant" {
            for (tool_index, block) in tool_blocks(content).enumerate() {
                if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                    continue;
                }
                let Some(name) = block.get("name").and_then(Value::as_str) else {
                    continue;
                };
                let activity = if let Some(item_key) = parse_mcp_name(name) {
                    Some((ToolActivityKind::Mcp, item_key, None))
                } else if name == "Skill" {
                    block
                        .get("input")
                        .and_then(skill_identity)
                        .map(|(skill, plugin)| (ToolActivityKind::Skill, skill, plugin))
                } else {
                    None
                };
                let Some((kind, item_key, plugin_key)) = activity else {
                    continue;
                };
                let call_id = block
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| {
                        format!(
                            "{}:{line_index}:tool:{tool_index}",
                            session.as_deref().unwrap_or("cursor")
                        )
                    });
                let index = parsed.tools.len();
                parsed.tools.push(RawToolActivity {
                    ts_ms,
                    session_id: session_arc.clone(),
                    call_id: call_id.clone(),
                    kind,
                    item_key,
                    plugin_key,
                    outcome: ToolOutcome::Unknown,
                    detection: ToolDetection::Explicit,
                });
                pending.insert(call_id, index);
            }
        }

        if include_tools {
            for block in tool_blocks(content) {
                if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                    continue;
                }
                let Some(call_id) = block
                    .get("tool_use_id")
                    .or_else(|| block.get("toolUseId"))
                    .and_then(Value::as_str)
                else {
                    continue;
                };
                let Some(index) = pending.remove(call_id) else {
                    continue;
                };
                parsed.tools[index].outcome = match block
                    .get("is_error")
                    .or_else(|| block.get("isError"))
                    .and_then(Value::as_bool)
                {
                    Some(true) => ToolOutcome::Failure,
                    Some(false) => ToolOutcome::Success,
                    None => ToolOutcome::Unknown,
                };
            }
        }
    }
    parsed
}

fn legacy_tool_name(line: &str) -> Option<&str> {
    let raw = line.trim().strip_prefix("[Tool call]")?.trim();
    raw.split(|character: char| character.is_whitespace() || character == '(')
        .next()
        .filter(|name| !name.is_empty())
}

fn flush_legacy_content(
    parsed: &mut ParsedLog,
    role: Option<&'static str>,
    lines: &mut Vec<String>,
    session: &Option<String>,
    ts_ms: i64,
    message_index: &mut usize,
) {
    let Some(role) = role else {
        lines.clear();
        return;
    };
    let text = clean_text(&lines.join("\n"), role);
    lines.clear();
    if text.is_empty() {
        return;
    }
    parsed.content.push(RawContent {
        ts_ms,
        session_id: session.clone(),
        message_id: Some(format!(
            "{}:legacy:{}",
            session.as_deref().unwrap_or("cursor"),
            *message_index
        )),
        role,
        text,
    });
    *message_index += 1;
}

fn parse_legacy_transcript(path: &Path, include_content: bool, include_tools: bool) -> ParsedLog {
    let ts_ms = file_mtime_ms(path);
    let session = session_id_from_path(path);
    let Ok(text) = std::fs::read_to_string(path) else {
        return ParsedLog::default();
    };
    let mut parsed = ParsedLog::default();
    let mut role = None;
    let mut lines = Vec::new();
    let mut message_index = 0usize;
    let mut tool_index = 0usize;

    for line in text.lines() {
        let next = if let Some(rest) = line.strip_prefix("user:") {
            Some(("user", rest))
        } else {
            line.strip_prefix("A:").map(|rest| ("assistant", rest))
        };
        if let Some((next_role, rest)) = next {
            if include_content {
                flush_legacy_content(
                    &mut parsed,
                    role,
                    &mut lines,
                    &session,
                    ts_ms,
                    &mut message_index,
                );
            }
            role = Some(next_role);
            lines.push(rest.trim_start().to_string());
            continue;
        }
        if include_tools && role == Some("assistant") {
            if let Some(name) = legacy_tool_name(line) {
                if let Some(item_key) = parse_mcp_name(name) {
                    parsed.tools.push(RawToolActivity {
                        ts_ms,
                        session_id: session.as_deref().map(Arc::from),
                        call_id: format!(
                            "{}:legacy-tool:{tool_index}",
                            session.as_deref().unwrap_or("cursor")
                        ),
                        kind: ToolActivityKind::Mcp,
                        item_key,
                        plugin_key: None,
                        outcome: ToolOutcome::Unknown,
                        detection: ToolDetection::Explicit,
                    });
                    tool_index += 1;
                }
            }
        }
        if ["[Tool call]", "[Tool result]", "[Thinking]", "[tool]"]
            .iter()
            .any(|marker| line.trim_start().starts_with(marker))
        {
            continue;
        }
        if include_content {
            lines.push(line.to_string());
        }
    }
    if include_content {
        flush_legacy_content(
            &mut parsed,
            role,
            &mut lines,
            &session,
            ts_ms,
            &mut message_index,
        );
    }
    parsed
}

#[cfg(test)]
mod tests {
    use super::super::gemini_family::testutil::{EnvGuard, TempDir};
    use super::*;

    #[test]
    fn parses_exact_cursor_stop_usage_and_deduplicates_generation() {
        let tmp = TempDir::new("cursor-usage");
        let path = tmp.path().join("usage.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"generationId\":\"g1\",\"sessionId\":\"s1\",\"model\":\"claude-4.5-sonnet\",\"tsMs\":1800000000000,\"inputTokens\":100,\"outputTokens\":20,\"cacheReadTokens\":30,\"cacheCreationTokens\":4}\n",
                "{broken}\n",
                "{\"generationId\":\"g1\",\"sessionId\":\"s1\",\"model\":\"claude-4.5-sonnet\",\"tsMs\":1800000000001,\"inputTokens\":100,\"outputTokens\":20,\"cacheReadTokens\":30,\"cacheCreationTokens\":4}\n",
                "{\"generationId\":\"g2\",\"sessionId\":null,\"model\":null,\"tsMs\":1800000000002,\"inputTokens\":1,\"outputTokens\":2,\"cacheReadTokens\":0,\"cacheCreationTokens\":0}\n"
            ),
        )
        .unwrap();

        let rows = parse_usage_file(&path);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].message_id.as_deref(), Some("g1"));
        assert_eq!(rows[0].session_id.as_deref(), Some("s1"));
        assert_eq!(rows[0].input_tokens, 100);
        assert_eq!(rows[0].output_tokens, 20);
        assert_eq!(rows[0].cache_read_tokens, 30);
        assert_eq!(rows[0].cache_creation_tokens, 4);
        assert_eq!(rows[1].message_id.as_deref(), Some("g2"));
    }

    #[test]
    fn discovers_flat_nested_and_subagent_transcripts() {
        let tmp = TempDir::new("cursor-discovery");
        let _env = EnvGuard::set("CURSOR_AGENT_HOME", tmp.path().as_os_str());
        tmp.write("projects/a/agent-transcripts/flat.jsonl", "");
        tmp.write("projects/a/agent-transcripts/s1/transcript.jsonl", "");
        tmp.write("projects/a/agent-transcripts/s1/subagents/sub.txt", "");
        tmp.write("projects/a/not-agent-transcripts/ignored.jsonl", "");

        let files = CursorUsage.discover_files();
        let relative = files
            .iter()
            .filter_map(|path| path.strip_prefix(tmp.path()).ok())
            .map(|path| path.display().to_string())
            .collect::<Vec<_>>();
        assert_eq!(relative.len(), 3);
        assert!(relative.iter().any(|path| path.ends_with("flat.jsonl")));
        assert!(relative
            .iter()
            .any(|path| path.ends_with("transcript.jsonl")));
        assert!(relative.iter().any(|path| path.ends_with("sub.txt")));
    }

    #[test]
    fn parses_cursor_jsonl_content_and_tools_without_usage_or_arguments() {
        let tmp = TempDir::new("cursor-jsonl");
        let path = tmp.write(
            "projects/repo/agent-transcripts/session-1/transcript.jsonl",
            concat!(
                "{\"role\":\"user\",\"timestamp\":\"2026-07-20T01:02:03Z\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"<timestamp>noise</timestamp><system_reminder>private system</system_reminder><user_query>질문</user_query>\"}]}}\n",
                "{broken}\n",
                "{\"role\":\"assistant\",\"id\":\"m2\",\"usage\":{\"input_tokens\":999},\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"답변\"},{\"type\":\"tool_use\",\"id\":\"call-1\",\"name\":\"mcp__context7__resolve__library\",\"input\":{\"secret\":\"do-not-send\"}},{\"type\":\"tool_use\",\"id\":\"call-2\",\"name\":\"Skill\",\"input\":{\"skill\":\"superpowers:brainstorming\",\"prompt\":\"do-not-send\"}},{\"type\":\"tool_use\",\"id\":\"call-3\",\"name\":\"Shell\",\"input\":{\"command\":\"do-not-send\"}}]}}\n",
                "{\"role\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"call-1\",\"is_error\":false,\"content\":\"secret output\"},{\"type\":\"tool_result\",\"tool_use_id\":\"call-2\",\"is_error\":true}]}}\n"
            ),
        );

        let parsed = CursorUsage.parse_changed(&path, true, true);
        assert!(parsed.usage.is_empty());
        assert_eq!(parsed.content.len(), 2);
        assert_eq!(parsed.content[0].session_id.as_deref(), Some("session-1"));
        assert_eq!(parsed.content[0].text, "질문");
        assert_eq!(parsed.content[1].text, "답변");
        assert_eq!(parsed.tools.len(), 2);
        assert_eq!(parsed.tools[0].item_key, "context7.resolve.library");
        assert_eq!(parsed.tools[0].outcome, ToolOutcome::Success);
        assert_eq!(parsed.tools[1].kind, ToolActivityKind::Skill);
        assert_eq!(parsed.tools[1].item_key, "brainstorming");
        assert_eq!(parsed.tools[1].plugin_key.as_deref(), Some("superpowers"));
        assert_eq!(parsed.tools[1].outcome, ToolOutcome::Failure);
        let wire = crate::tool_event::to_tool_events_body("cursor", None, &parsed.tools);
        for forbidden in ["do-not-send", "secret output", "command", "prompt"] {
            assert!(!wire.contains(forbidden));
        }
    }

    #[test]
    fn cursor_content_and_tools_respect_independent_switches() {
        let tmp = TempDir::new("cursor-switches");
        let path = tmp.write(
            "agent-transcripts/s.jsonl",
            "{\"role\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"private\"},{\"type\":\"tool_use\",\"id\":\"c\",\"name\":\"mcp__srv__tool\",\"input\":{}}]}}\n",
        );
        let neither = CursorUsage.parse_changed(&path, false, false);
        assert!(neither.content.is_empty());
        assert!(neither.tools.is_empty());
        let tools_only = CursorUsage.parse_changed(&path, false, true);
        assert!(tools_only.content.is_empty());
        assert_eq!(tools_only.tools.len(), 1);
    }

    #[test]
    fn parses_legacy_text_content_and_mcp_activity() {
        let tmp = TempDir::new("cursor-legacy");
        let path = tmp.write(
            "agent-transcripts/legacy.txt",
            "user: 질문\nA: 답변\n[Tool call] mcp__docs__search(query)\n[Tool result] hidden\n",
        );
        let parsed = CursorUsage.parse_changed(&path, true, true);
        assert!(parsed.usage.is_empty());
        assert_eq!(parsed.content.len(), 2);
        assert_eq!(parsed.content[0].text, "질문");
        assert_eq!(parsed.content[1].text, "답변");
        assert_eq!(parsed.tools.len(), 1);
        assert_eq!(parsed.tools[0].item_key, "docs.search");
        assert_eq!(parsed.tools[0].outcome, ToolOutcome::Unknown);
    }

    #[test]
    fn ignores_missing_and_corrupt_files() {
        let tmp = TempDir::new("cursor-empty");
        assert!(parse_usage_file(&tmp.path().join("missing.jsonl")).is_empty());
        let corrupt = tmp.path().join("corrupt.jsonl");
        std::fs::write(&corrupt, "not-json\n").unwrap();
        assert!(parse_usage_file(&corrupt).is_empty());
    }
}

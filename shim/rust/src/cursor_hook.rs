// Cursor Agent의 user-global stop hook 관리와 사용량 캡처.
//
// Cursor stop payload에는 세대/세션/모델과 정확한 input/output/cache 토큰이 들어온다.
// 원본 payload에는 이메일·workspace path·transcript path 등이 함께 올 수 있으므로 그대로
// 저장하지 않고 아래 CapturedUsage 최소 필드만 ~/.toard/cursor/usage.jsonl 에 기록한다.

use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::fsx;

const MAX_PAYLOAD_BYTES: u64 = 1_048_576;
const CAPTURE_COMMAND: &str = "cursor-hook capture-toard-v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CapturedUsage {
    pub generation_id: String,
    pub session_id: Option<String>,
    pub model: Option<String>,
    pub ts_ms: i64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
}

pub fn run(args: &[String]) -> i32 {
    match args.first().map(String::as_str) {
        Some("install") if args.len() == 1 => install(),
        Some("uninstall") if args.len() == 1 => uninstall(),
        Some("status") if args.len() == 1 => status(),
        Some("capture-toard-v1") if args.len() == 1 => capture_stdin(),
        _ => {
            eprintln!("toard-shim: cursor-hook 사용법: install | uninstall | status");
            2
        }
    }
}

pub(crate) fn usage_log_path() -> Option<PathBuf> {
    fsx::home_dir().map(|home| home.join(".toard").join("cursor").join("usage.jsonl"))
}

fn hooks_path() -> Option<PathBuf> {
    fsx::home_dir().map(|home| home.join(".cursor").join("hooks.json"))
}

fn current_time_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

fn string_field(value: &Value, names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|name| value.get(*name).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(String::from)
}

fn token_field(value: &Value, names: &[&str]) -> u64 {
    names
        .iter()
        .find_map(|name| value.get(*name))
        .and_then(|token| {
            token
                .as_u64()
                .or_else(|| token.as_str().and_then(|raw| raw.parse::<u64>().ok()))
        })
        .unwrap_or(0)
}

fn timestamp_ms(value: &Value, fallback: i64) -> i64 {
    let raw = ["timestamp_ms", "timestampMs", "timestamp"]
        .iter()
        .find_map(|name| value.get(*name))
        .and_then(|timestamp| {
            timestamp
                .as_i64()
                .or_else(|| timestamp.as_str().and_then(|raw| raw.parse::<i64>().ok()))
        });
    match raw {
        Some(seconds) if (1..10_000_000_000).contains(&seconds) => seconds.saturating_mul(1000),
        Some(milliseconds) if milliseconds > 0 => milliseconds,
        _ => fallback,
    }
}

fn parse_payload(value: &Value, captured_at_ms: i64) -> Option<CapturedUsage> {
    if string_field(value, &["hook_event_name", "hookEventName"]).as_deref() != Some("stop") {
        return None;
    }
    let generation_id = string_field(
        value,
        &["generation_id", "generationId", "request_id", "requestId"],
    )?;
    let input_tokens = token_field(value, &["input_tokens", "inputTokens"]);
    let output_tokens = token_field(value, &["output_tokens", "outputTokens"]);
    let cache_read_tokens = token_field(value, &["cache_read_tokens", "cacheReadTokens"]);
    let cache_creation_tokens = token_field(
        value,
        &[
            "cache_write_tokens",
            "cacheWriteTokens",
            "cache_creation_tokens",
            "cacheCreationTokens",
        ],
    );
    if input_tokens == 0
        && output_tokens == 0
        && cache_read_tokens == 0
        && cache_creation_tokens == 0
    {
        return None;
    }
    Some(CapturedUsage {
        generation_id,
        session_id: string_field(
            value,
            &[
                "session_id",
                "sessionId",
                "conversation_id",
                "conversationId",
            ],
        ),
        model: string_field(value, &["model"]),
        ts_ms: timestamp_ms(value, captured_at_ms),
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_creation_tokens,
    })
}

fn append_usage(path: &Path, usage: &CapturedUsage) -> std::io::Result<()> {
    let Some(parent) = path.parent() else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "cursor usage parent missing",
        ));
    };
    std::fs::create_dir_all(parent)?;
    fsx::set_mode(parent, 0o700)?;
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    fsx::set_mode(path, 0o600)?;
    file.lock_exclusive()?;
    let result = (|| {
        serde_json::to_writer(&mut file, usage)?;
        file.write_all(b"\n")?;
        file.flush()
    })();
    let _ = file.unlock();
    result
}

fn capture_stdin() -> i32 {
    // Cursor 작업을 훅 오류로 막지 않는다. 실패해도 continue 응답과 exit 0을 반환한다.
    let mut bytes = Vec::new();
    let read_result = std::io::stdin()
        .take(MAX_PAYLOAD_BYTES + 1)
        .read_to_end(&mut bytes);
    if read_result.is_ok() && bytes.len() as u64 <= MAX_PAYLOAD_BYTES {
        if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
            if let Some(usage) = parse_payload(&value, current_time_ms()) {
                if let Some(path) = usage_log_path() {
                    let _ = append_usage(&path, &usage);
                }
            }
        }
    }
    println!("{{\"continue\":true}}");
    0
}

fn hook_executable() -> Result<PathBuf, String> {
    let current = std::env::current_exe()
        .map_err(|error| format!("현재 실행 파일을 찾을 수 없습니다: {error}"))?;
    let filename = if cfg!(windows) {
        "toard-shim.exe"
    } else {
        "toard-shim"
    };
    let stable = current
        .parent()
        .map(|parent| parent.join(filename))
        .filter(|path| path.exists());
    Ok(stable.unwrap_or(current))
}

fn quote_command(path: &Path, windows: bool) -> Result<String, String> {
    let raw = path.to_string_lossy();
    if raw.contains(['\n', '\r', '\0']) || (windows && raw.contains('"')) {
        return Err("Cursor hook 실행 파일 경로를 안전하게 인용할 수 없습니다".into());
    }
    let quoted = if windows {
        format!("\"{raw}\"")
    } else {
        format!("'{}'", raw.replace('\'', "'\"'\"'"))
    };
    Ok(format!("{quoted} {CAPTURE_COMMAND}"))
}

fn is_managed_entry(value: &Value) -> bool {
    value
        .get("command")
        .and_then(Value::as_str)
        .is_some_and(|command| command.contains(CAPTURE_COMMAND))
}

fn parse_hooks(text: &str) -> Result<Value, String> {
    if text.trim().is_empty() {
        return Ok(json!({ "version": 1, "hooks": {} }));
    }
    let value: Value = serde_json::from_str(text)
        .map_err(|error| format!("기존 Cursor hooks.json이 올바른 JSON이 아닙니다: {error}"))?;
    if !value.is_object() {
        return Err("기존 Cursor hooks.json 최상위 값이 객체가 아닙니다".into());
    }
    Ok(value)
}

fn read_optional(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Cursor hooks.json 읽기 실패: {error}")),
    }
}

fn merge_install(text: &str, command: &str) -> Result<String, String> {
    let mut root = parse_hooks(text)?;
    let object = root.as_object_mut().expect("parse_hooks object");
    object.entry("version").or_insert(json!(1));
    let hooks = object.entry("hooks").or_insert_with(|| json!({}));
    let hooks = hooks
        .as_object_mut()
        .ok_or("기존 Cursor hooks 필드가 객체가 아닙니다")?;
    let stop = hooks.entry("stop").or_insert_with(|| json!([]));
    let stop = stop
        .as_array_mut()
        .ok_or("기존 Cursor stop hook이 배열이 아닙니다")?;
    stop.retain(|entry| !is_managed_entry(entry));
    stop.push(json!({ "command": command }));
    serde_json::to_string_pretty(&root)
        .map(|text| format!("{text}\n"))
        .map_err(|error| error.to_string())
}

fn merge_uninstall(text: &str) -> Result<(String, bool), String> {
    let mut root = parse_hooks(text)?;
    let Some(hooks) = root.get_mut("hooks").and_then(Value::as_object_mut) else {
        return Ok((
            format!("{}\n", serde_json::to_string_pretty(&root).unwrap()),
            false,
        ));
    };
    let mut changed = false;
    let mut remove_stop = false;
    if let Some(stop) = hooks.get_mut("stop").and_then(Value::as_array_mut) {
        let before = stop.len();
        stop.retain(|entry| !is_managed_entry(entry));
        changed = stop.len() != before;
        remove_stop = changed && stop.is_empty();
    }
    if remove_stop {
        hooks.remove("stop");
    }
    let rendered = serde_json::to_string_pretty(&root).map_err(|error| error.to_string())?;
    Ok((format!("{rendered}\n"), changed))
}

fn install() -> i32 {
    let Some(path) = hooks_path() else {
        eprintln!("toard-shim: 사용자 홈을 찾을 수 없어 Cursor hook을 설치하지 못했습니다");
        return 1;
    };
    let command = match hook_executable().and_then(|path| quote_command(&path, cfg!(windows))) {
        Ok(command) => command,
        Err(error) => {
            eprintln!("toard-shim: {error}");
            return 1;
        }
    };
    let existing = match read_optional(&path) {
        Ok(Some(existing)) => existing,
        Ok(None) => String::new(),
        Err(error) => {
            eprintln!("toard-shim: {error} — 기존 설정은 변경하지 않았습니다");
            return 1;
        }
    };
    let merged = match merge_install(&existing, &command) {
        Ok(merged) => merged,
        Err(error) => {
            eprintln!("toard-shim: {error} — 기존 설정은 변경하지 않았습니다");
            return 1;
        }
    };
    if let Err(error) = fsx::write_atomic(&path, &merged, 0o600) {
        eprintln!("toard-shim: Cursor hook 저장 실패: {error}");
        return 1;
    }
    println!("  ✓ Cursor 사용량 hook 등록됨 — 대화 본문·경로·이메일은 저장하지 않음");
    0
}

fn uninstall() -> i32 {
    let Some(path) = hooks_path() else {
        return 0;
    };
    let existing = match read_optional(&path) {
        Ok(Some(existing)) => existing,
        Ok(None) => {
            println!("  ✓ Cursor 사용량 hook 없음");
            return 0;
        }
        Err(error) => {
            eprintln!("toard-shim: {error} — 기존 설정은 변경하지 않았습니다");
            return 1;
        }
    };
    let (merged, changed) = match merge_uninstall(&existing) {
        Ok(result) => result,
        Err(error) => {
            eprintln!("toard-shim: {error} — 기존 설정은 변경하지 않았습니다");
            return 1;
        }
    };
    if changed {
        if let Err(error) = fsx::write_atomic(&path, &merged, 0o600) {
            eprintln!("toard-shim: Cursor hook 제거 실패: {error}");
            return 1;
        }
        println!("  ✓ Cursor 사용량 hook 제거됨 (다른 hook 보존)");
    } else {
        println!("  ✓ Cursor 사용량 hook 없음");
    }
    0
}

pub(crate) fn installed() -> bool {
    hooks_path()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.pointer("/hooks/stop").cloned())
        .and_then(|stop| stop.as_array().cloned())
        .is_some_and(|entries| entries.iter().any(is_managed_entry))
}

fn status() -> i32 {
    if installed() {
        println!("Cursor 사용량 hook: installed");
        0
    } else {
        println!("Cursor 사용량 hook: not installed");
        1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stop_payload_keeps_only_usage_fields() {
        let value = json!({
            "hook_event_name": "stop",
            "generation_id": "generation-1",
            "conversation_id": "conversation-1",
            "model": "claude-4.5-sonnet",
            "input_tokens": 10129,
            "output_tokens": 34,
            "cache_read_tokens": 4608,
            "cache_write_tokens": 12,
            "user_email": "private@example.com",
            "workspace_roots": ["/secret/project"],
            "transcript_path": "/secret/transcript.jsonl"
        });
        assert_eq!(
            parse_payload(&value, 1_800_000_000_000),
            Some(CapturedUsage {
                generation_id: "generation-1".into(),
                session_id: Some("conversation-1".into()),
                model: Some("claude-4.5-sonnet".into()),
                ts_ms: 1_800_000_000_000,
                input_tokens: 10129,
                output_tokens: 34,
                cache_read_tokens: 4608,
                cache_creation_tokens: 12,
            })
        );
        let serialized = serde_json::to_string(&parse_payload(&value, 1).unwrap()).unwrap();
        for private in [
            "private@example.com",
            "/secret/project",
            "/secret/transcript.jsonl",
        ] {
            assert!(!serialized.contains(private));
        }
    }

    #[test]
    fn ignores_non_stop_and_zero_usage_payloads() {
        assert_eq!(
            parse_payload(&json!({ "hook_event_name": "beforeSubmitPrompt" }), 1),
            None
        );
        assert_eq!(
            parse_payload(
                &json!({ "hook_event_name": "stop", "generation_id": "g" }),
                1
            ),
            None
        );
    }

    #[test]
    fn hook_merge_is_idempotent_and_preserves_other_hooks() {
        let existing = r#"{
          "version": 1,
          "hooks": {
            "stop": [{"command":"~/.superset/hooks/cursor-hook.sh Stop"}],
            "beforeSubmitPrompt": [{"command":"keep-me"}]
          }
        }"#;
        let once = merge_install(existing, "'/x/toard-shim' cursor-hook capture-toard-v1").unwrap();
        let twice = merge_install(&once, "'/new/toard-shim' cursor-hook capture-toard-v1").unwrap();
        let value: Value = serde_json::from_str(&twice).unwrap();
        let stop = value.pointer("/hooks/stop").unwrap().as_array().unwrap();
        assert_eq!(stop.len(), 2);
        assert_eq!(
            stop.iter().filter(|entry| is_managed_entry(entry)).count(),
            1
        );
        assert_eq!(
            value
                .pointer("/hooks/beforeSubmitPrompt/0/command")
                .and_then(Value::as_str),
            Some("keep-me")
        );
    }

    #[test]
    fn uninstall_removes_only_toard_entry() {
        let installed = merge_install(
            r#"{"version":1,"hooks":{"stop":[{"command":"other Stop"}]}}"#,
            "'/x/toard-shim' cursor-hook capture-toard-v1",
        )
        .unwrap();
        let (removed, changed) = merge_uninstall(&installed).unwrap();
        assert!(changed);
        let value: Value = serde_json::from_str(&removed).unwrap();
        assert_eq!(
            value
                .pointer("/hooks/stop/0/command")
                .and_then(Value::as_str),
            Some("other Stop")
        );
    }

    #[test]
    fn malformed_existing_config_is_not_replaced() {
        assert!(merge_install("{broken", "command").is_err());
        assert!(merge_install(r#"{"hooks":[]}"#, "command").is_err());
    }

    #[test]
    fn command_quoting_handles_spaces() {
        assert_eq!(
            quote_command(Path::new("/Users/A B/toard-shim"), false).unwrap(),
            "'/Users/A B/toard-shim' cursor-hook capture-toard-v1"
        );
        assert_eq!(
            quote_command(Path::new(r"C:\\Users\\A B\\toard-shim.exe"), true).unwrap(),
            r#""C:\\Users\\A B\\toard-shim.exe" cursor-hook capture-toard-v1"#
        );
    }
}

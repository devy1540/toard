// ccusage rust/crates/ccusage/src/adapter/qwen @ cdda1821
// (MIT, Copyright (c) 2025 ryoppippi) 에서 이식 — 비용 계산 제거, RawUsage 로 매핑.
//
// qwen 은 gemini 계열 변형: projects/<project>/chats/*.jsonl 의 type=="assistant"
// 라인이 gemini 스타일 usageMetadata(promptTokenCount 등) 를 갖는다.
// 이식 매핑 요약:
//   - input_tokens  = promptTokenCount
//   - output_tokens = candidatesTokenCount + reasoning(thoughtsTokenCount +
//                     totalTokenCount 초과분) — upstream billable_usage 와 동일 합산
//   - cache_read_tokens = cachedContentTokenCount, cache_creation_tokens = 0
//   - message_id = 없음(upstream 도 None), ts = timestamp → 파일 mtime 폴백

use std::path::{Component, Path, PathBuf};

use serde::Deserialize;

use super::gemini_family::{apply_total_token_fallback, lenient_u64, non_empty_string};
use super::{file_mtime_ms, walk_files, LogAdapter, RawUsage};
use crate::iso::iso_to_epoch_ms;

const DEFAULT_QWEN_MODEL: &str = "unknown";
const QWEN_DATA_DIR_ENV: &str = "QWEN_DATA_DIR";
/// 쓸 수 있는 라인은 전부 usageMetadata 를 갖는다 — JSON 파싱 전 프리필터 (upstream 동일)
const USAGE_MARKER: &[u8] = br#""usageMetadata""#;

pub struct Qwen;

impl LogAdapter for Qwen {
    fn key(&self) -> &'static str {
        "qwen"
    }

    /// QWEN_DATA_DIR(csv) 우선, 기본 ~/.qwen —
    /// projects/<project>/chats/<file>.jsonl (정확히 3계층) 만 수집
    fn discover_files(&self) -> Vec<PathBuf> {
        let mut files = Vec::new();
        for root in data_dirs() {
            let projects = root.join("projects");
            if !projects.is_dir() {
                continue;
            }
            let mut root_files = Vec::new();
            walk_files(&projects, &["jsonl"], &mut root_files, 0);
            root_files.retain(|file| is_chat_file(&projects, file));
            files.extend(root_files);
        }
        files.sort();
        files
    }

    fn parse_file(&self, path: &Path) -> Vec<RawUsage> {
        parse_chat_file(path)
    }
}

fn data_dirs() -> Vec<PathBuf> {
    let candidates = if let Ok(paths) = std::env::var(QWEN_DATA_DIR_ENV) {
        paths
            .split(',')
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(PathBuf::from)
            .collect::<Vec<_>>()
    } else {
        crate::fsx::home_dir()
            .map(|home| vec![home.join(".qwen")])
            .unwrap_or_default()
    };
    let mut dirs: Vec<PathBuf> = Vec::new();
    for path in candidates {
        if path.is_dir() && !dirs.contains(&path) {
            dirs.push(path);
        }
    }
    dirs
}

/// upstream paths::is_chat_file — projects 기준 상대 경로가 정확히
/// <project>/chats/<file>.jsonl 세 조각일 때만 채팅 파일로 인정.
fn is_chat_file(projects: &Path, file: &Path) -> bool {
    let Ok(relative) = file.strip_prefix(projects) else {
        return false;
    };
    let parts = relative.components().collect::<Vec<_>>();
    matches!(
        parts.as_slice(),
        [Component::Normal(project), Component::Normal(chats), Component::Normal(name)]
            if !project.is_empty()
                && chats.to_str() == Some("chats")
                && name.to_string_lossy().ends_with(".jsonl")
    )
}

/// upstream paths::project_from_file — .../projects/<project>/chats/<file> 에서
/// 가장 뒤쪽(rev) 일치를 찾아 project 를 추출.
fn project_from_file(file: &Path) -> Option<String> {
    let parts = file.components().collect::<Vec<_>>();
    for window in parts.windows(4).rev() {
        if let [Component::Normal(projects), Component::Normal(project), Component::Normal(chats), Component::Normal(_)] =
            window
        {
            if projects.to_str() == Some("projects") && chats.to_str() == Some("chats") {
                return Some(project.to_string_lossy().into_owned());
            }
        }
    }
    None
}

/// upstream QwenLine — 소비하는 필드만 선언, camelCase 로그 키.
/// usageMetadata 가 객체가 아니면 라인 역직렬화 자체가 실패해 스킵된다 (upstream 동일).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QwenLine {
    #[serde(default, deserialize_with = "non_empty_string")]
    r#type: Option<String>,
    usage_metadata: Option<QwenUsageMetadata>,
    #[serde(default, deserialize_with = "non_empty_string")]
    timestamp: Option<String>,
    #[serde(default, deserialize_with = "non_empty_string")]
    session_id: Option<String>,
    #[serde(default, deserialize_with = "non_empty_string")]
    model: Option<String>,
}

/// gemini 스타일 usage 블록 — lenient_u64(정수만, float/문자열은 0) 는 upstream 동일.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QwenUsageMetadata {
    #[serde(default, deserialize_with = "lenient_u64")]
    prompt_token_count: u64,
    #[serde(default, deserialize_with = "lenient_u64")]
    candidates_token_count: u64,
    #[serde(default, deserialize_with = "lenient_u64")]
    thoughts_token_count: u64,
    #[serde(default, deserialize_with = "lenient_u64")]
    cached_content_token_count: u64,
    #[serde(default, deserialize_with = "lenient_u64")]
    total_token_count: u64,
}

fn parse_chat_file(path: &Path) -> Vec<RawUsage> {
    let fallback_timestamp = file_mtime_ms(path);
    let Ok(content) = std::fs::read(path) else {
        return Vec::new();
    };
    let mut events = Vec::new();
    for line in content.split(|b| *b == b'\n') {
        if !contains_subslice(line, USAGE_MARKER) {
            continue;
        }
        let Ok(record) = serde_json::from_slice::<QwenLine>(line) else {
            continue;
        };
        if let Some(event) = parse_line(path, fallback_timestamp, &record) {
            events.push(event);
        }
    }
    events
}

/// upstream parse_line — type=="assistant" 라인의 usageMetadata 를 RawUsage 로.
fn parse_line(file: &Path, fallback_timestamp: i64, record: &QwenLine) -> Option<RawUsage> {
    if record.r#type.as_deref() != Some("assistant") {
        return None;
    }
    let usage = record.usage_metadata.as_ref()?;
    let input_tokens = usage.prompt_token_count;
    let cache_read_tokens = usage.cached_content_token_count;
    let (output_tokens, extra_total_tokens) = apply_total_token_fallback(
        input_tokens,
        usage.candidates_token_count,
        cache_read_tokens,
        usage.thoughts_token_count,
        usage.total_token_count,
    );
    if input_tokens == 0 && output_tokens == 0 && cache_read_tokens == 0 && extra_total_tokens == 0
    {
        return None;
    }
    let ts_ms = record
        .timestamp
        .as_deref()
        .and_then(iso_to_epoch_ms)
        .unwrap_or(fallback_timestamp);
    let project = project_from_file(file).unwrap_or_else(|| "unknown".to_string());
    let session_id = record.session_id.clone().unwrap_or_else(|| {
        let stem = file
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("unknown");
        format!("{project}-{stem}")
    });
    let model = record
        .model
        .clone()
        .unwrap_or_else(|| DEFAULT_QWEN_MODEL.to_string());
    Some(RawUsage {
        ts_ms,
        session_id: Some(session_id),
        model: Some(model),
        message_id: None,
        input_tokens,
        output_tokens: output_tokens.saturating_add(extra_total_tokens),
        cache_read_tokens,
        cache_creation_tokens: 0,
    })
}

fn contains_subslice(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

#[cfg(test)]
mod tests {
    use super::super::gemini_family::testutil::{EnvGuard, TempDir};
    use super::*;

    // ① assistant 라인만 파싱, 토큰·세션·모델·타임스탬프 매핑
    #[test]
    fn parses_assistant_lines_only() {
        let tmp = TempDir::new("qwen-parse");
        let path = tmp.write(
            "projects/myProject/chats/chat-a.jsonl",
            &[
                r#"{"type":"user","text":"hello"}"#,
                r#"{"type":"user","text":"has key but not assistant","usageMetadata":{"promptTokenCount":9}}"#,
                r#"{"type":"assistant","model":"qwen3-coder-plus","timestamp":"2026-02-23T14:24:56.857Z","sessionId":"session-json","usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":50,"thoughtsTokenCount":10,"cachedContentTokenCount":5}}"#,
            ]
            .join("\n"),
        );
        let events = Qwen.parse_file(&path);

        assert_eq!(events.len(), 1);
        let e = &events[0];
        assert_eq!(e.session_id.as_deref(), Some("session-json"));
        assert_eq!(e.model.as_deref(), Some("qwen3-coder-plus"));
        assert_eq!(e.message_id, None, "qwen 로그에는 message id 없음");
        assert_eq!(
            e.ts_ms,
            iso_to_epoch_ms("2026-02-23T14:24:56.857Z").unwrap()
        );
        assert_eq!(e.input_tokens, 100);
        assert_eq!(
            e.output_tokens, 60,
            "candidates 50 + thoughts(reasoning) 10"
        );
        assert_eq!(e.cache_read_tokens, 5);
        assert_eq!(e.cache_creation_tokens, 0);
    }

    // ② totalTokenCount 폴백 + 세션/모델 기본값 (project-stem, "unknown")
    #[test]
    fn total_fallback_and_defaults() {
        let tmp = TempDir::new("qwen-total");
        let path = tmp.write(
            "projects/proj1/chats/chat-b.jsonl",
            r#"{"type":"assistant","usageMetadata":{"totalTokenCount":321}}"#,
        );
        let events = Qwen.parse_file(&path);

        assert_eq!(events.len(), 1);
        let e = &events[0];
        assert_eq!(
            e.output_tokens, 321,
            "부분 카운트가 없으면 total 이 output 으로"
        );
        assert_eq!(e.input_tokens, 0);
        assert_eq!(
            e.session_id.as_deref(),
            Some("proj1-chat-b"),
            "project-stem 폴백"
        );
        assert_eq!(e.model.as_deref(), Some("unknown"));
        assert_eq!(
            e.ts_ms,
            file_mtime_ms(&path),
            "타임스탬프 없으면 파일 mtime"
        );
    }

    // ③ 전 토큰 0 라인·float 카운트(정수만 인정) 스킵 의미
    #[test]
    fn skips_zero_usage_and_integer_only_counts() {
        let tmp = TempDir::new("qwen-zero");
        let path = tmp.write(
            "projects/p/chats/c.jsonl",
            &[
                r#"{"type":"assistant","usageMetadata":{}}"#,
                r#"{"type":"assistant","usageMetadata":{"promptTokenCount":12.5}}"#,
                r#"{"type":"assistant","usageMetadata":{"promptTokenCount":"7"}}"#,
            ]
            .join("\n"),
        );
        // lenient_u64: float/문자열은 0 (gemini 의 float 절삭과 달리 정수만) → 전부 0 → 스킵
        assert!(Qwen.parse_file(&path).is_empty());
    }

    // ⑤ 손상 파일 → 빈 벡터
    #[test]
    fn corrupt_file_yields_empty() {
        let tmp = TempDir::new("qwen-corrupt");
        let path = tmp.write(
            "projects/p/chats/bad.jsonl",
            "not json with \"usageMetadata\" marker\n{\"usageMetadata\":\"not an object\",\"type\":\"assistant\"}\n",
        );
        assert!(Qwen.parse_file(&path).is_empty());
        assert!(Qwen
            .parse_file(Path::new("/nonexistent/x.jsonl"))
            .is_empty());
    }

    // ⑥ 경로 탐색: QWEN_DATA_DIR csv override + projects/<p>/chats/*.jsonl 규칙
    #[test]
    fn discover_files_honors_env_and_chat_rule() {
        let tmp = TempDir::new("qwen-discover");
        let ok = tmp.write("projects/p1/chats/a.jsonl", "{}\n");
        tmp.write("projects/p1/chats/nested/too-deep.jsonl", "{}\n");
        tmp.write("projects/direct.jsonl", "{}\n");
        tmp.write("projects/p2/notchats/e.jsonl", "{}\n");
        tmp.write("other/p3/chats/outside.jsonl", "{}\n");
        tmp.write("projects/p1/chats/not-jsonl.json", "{}\n");
        let csv = format!(
            " {} ,{},/nonexistent-toard-dir",
            tmp.path().display(),
            tmp.path().display()
        );
        let _guard = EnvGuard::set(QWEN_DATA_DIR_ENV, std::ffi::OsStr::new(&csv));

        assert_eq!(Qwen.discover_files(), vec![ok]);
    }

    #[test]
    fn project_from_file_finds_last_projects_segment() {
        assert_eq!(
            project_from_file(Path::new("/home/u/.qwen/projects/myProj/chats/c.jsonl")).as_deref(),
            Some("myProj")
        );
        assert_eq!(
            project_from_file(Path::new("/tmp/project/chat.jsonl")),
            None
        );
    }
}

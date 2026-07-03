// ccusage rust/crates/ccusage/src/adapter/gemini @ cdda1821
// (MIT, Copyright (c) 2025 ryoppippi) 에서 이식 — 비용 계산 제거, RawUsage 로 매핑.
//
// 이식 매핑 요약:
//   - input_tokens  = 정규화된 input(캐시 중복 제거) + tool
//   - output_tokens = output + reasoning(thoughts + total 초과분)
//                     — upstream 비용 계산(cost_usage)과 동일한 합산. 서버 pricing 이
//                     이 토큰 수로 비용을 계산하므로 billable 의미를 보존한다.
//   - cache_read_tokens = cached, cache_creation_tokens = 0 (gemini 로그에 없음)
//   - message_id = 레코드 id, ts = timestamp/created_at → 파일 mtime 폴백

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{Map, Value};

use super::gemini_family::{
    apply_total_token_fallback, content_from_message, lenient_str, non_empty_json_string,
    non_empty_string, session_id_of,
};
use super::{file_mtime_ms, walk_files, LogAdapter, RawContent, RawUsage};
use crate::iso::iso_to_epoch_ms;

const DEFAULT_MODEL: &str = "unknown";
const GEMINI_DATA_DIR_ENV: &str = "GEMINI_DATA_DIR";

pub struct Gemini;

impl LogAdapter for Gemini {
    fn key(&self) -> &'static str {
        "gemini"
    }

    /// GEMINI_DATA_DIR(csv) 설정 시 그 경로들만, 기본 ~/.gemini/tmp — json/jsonl 재귀 수집
    fn discover_files(&self) -> Vec<PathBuf> {
        let mut files = Vec::new();
        for root in data_dirs() {
            walk_files(&root, &["json", "jsonl"], &mut files, 0);
        }
        files.sort();
        files.dedup();
        files
    }

    fn parse_file(&self, path: &Path) -> Vec<RawUsage> {
        if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            parse_jsonl_file(path)
        } else {
            parse_json_file(path)
        }
    }

    fn parse_content(&self, path: &Path) -> Vec<RawContent> {
        if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            parse_content_jsonl(path)
        } else {
            parse_content_json(path)
        }
    }
}

/// 전체 파일 JSON: messages 배열의 user/gemini 메시지 텍스트를 뽑는다.
/// 세션 id·타임스탬프 폴백은 토큰 경로(parse_json_file)와 동일 규칙.
fn parse_content_json(path: &Path) -> Vec<RawContent> {
    let fallback_timestamp = file_mtime_ms(path);
    let Ok(content) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&content) else {
        return Vec::new();
    };
    let Some(obj) = value.as_object() else {
        return Vec::new();
    };
    let session_id = session_id_of(obj).unwrap_or_else(|| file_stem(path));
    let session_ts = obj
        .get("startTime")
        .and_then(Value::as_str)
        .and_then(iso_to_epoch_ms)
        .or_else(|| {
            obj.get("lastUpdated")
                .and_then(Value::as_str)
                .and_then(iso_to_epoch_ms)
        })
        .unwrap_or(fallback_timestamp);
    if let Some(messages) = obj.get("messages").and_then(Value::as_array) {
        return messages
            .iter()
            .filter_map(Value::as_object)
            .filter_map(|m| content_from_message(m, &session_id, session_ts))
            .collect();
    }
    // messages 배열이 없으면 최상위 레코드 자체를 하나의 메시지로 시도
    content_from_message(obj, &session_id, session_ts)
        .into_iter()
        .collect()
}

/// JSONL: 라인별 user/gemini 텍스트. 세션 id 힌트는 라인을 따라 승계되고,
/// 같은 id+role 은 교체(제자리 갱신 대응) — 토큰 경로의 direct 이벤트와 같은 의미.
fn parse_content_jsonl(path: &Path) -> Vec<RawContent> {
    let fallback_timestamp = file_mtime_ms(path);
    let Ok(bytes) = std::fs::read(path) else {
        return Vec::new();
    };
    let mut session_id = file_stem(path);
    let mut out: Vec<RawContent> = Vec::new();
    let mut seen: HashMap<(String, &'static str), usize> = HashMap::new();
    for line in bytes.split(|b| *b == b'\n') {
        let Ok(value) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        let Some(obj) = value.as_object() else {
            continue;
        };
        if let Some(s) = session_id_of(obj) {
            session_id = s;
        }
        let Some(record) = content_from_message(obj, &session_id, fallback_timestamp) else {
            continue;
        };
        match record.message_id.clone() {
            Some(id) => {
                let k = (id, record.role);
                if let Some(&i) = seen.get(&k) {
                    out[i] = record;
                } else {
                    seen.insert(k, out.len());
                    out.push(record);
                }
            }
            None => out.push(record),
        }
    }
    out
}

fn data_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(env_paths) = std::env::var(GEMINI_DATA_DIR_ENV) {
        for raw in env_paths
            .split(',')
            .map(str::trim)
            .filter(|p| !p.is_empty())
        {
            let path = PathBuf::from(raw);
            if path.is_dir() && !dirs.contains(&path) {
                dirs.push(path);
            }
        }
        // upstream 과 동일: env 가 설정되면 기본 경로는 보지 않는다
        return dirs;
    }
    if let Some(home) = crate::fsx::home_dir() {
        let path = home.join(".gemini").join("tmp");
        if path.is_dir() {
            dirs.push(path);
        }
    }
    dirs
}

/// upstream GeminiRecord — 전체 파일 JSON 과 JSONL 라인 양쪽에 쓰는 봉투.
/// 토큰 카운트(tokens/stats/result)는 parse_tokens 의 키 별칭·float 절삭 규칙이
/// 필요해 raw Value 로 둔다. 소비하는 필드만 선언하고 나머지는 serde 가 건너뛴다.
#[derive(Debug, Deserialize)]
struct GeminiRecord {
    #[serde(default, deserialize_with = "lenient_str")]
    r#type: Option<String>,
    #[serde(default, deserialize_with = "non_empty_string", rename = "sessionId")]
    session_id_camel: Option<String>,
    #[serde(default, deserialize_with = "non_empty_string")]
    session_id: Option<String>,
    #[serde(default, deserialize_with = "non_empty_string")]
    model: Option<String>,
    #[serde(default, deserialize_with = "non_empty_string")]
    id: Option<String>,
    #[serde(default, deserialize_with = "lenient_str")]
    timestamp: Option<String>,
    #[serde(default, deserialize_with = "lenient_str")]
    created_at: Option<String>,
    #[serde(default, deserialize_with = "lenient_str", rename = "startTime")]
    start_time: Option<String>,
    #[serde(default, deserialize_with = "lenient_str", rename = "lastUpdated")]
    last_updated: Option<String>,
    messages: Option<Value>,
    tokens: Option<Value>,
    stats: Option<Value>,
    result: Option<Value>,
}

impl GeminiRecord {
    /// sessionId(camel) 우선, 다음 session_id — upstream 조회 순서 그대로.
    fn session_id(&self) -> Option<String> {
        self.session_id_camel
            .clone()
            .or_else(|| self.session_id.clone())
    }

    /// 최상위 stats 우선, 다음 result.stats — upstream 조회 순서 그대로.
    fn stats(&self) -> Option<&Value> {
        self.stats
            .as_ref()
            .or_else(|| self.result.as_ref().and_then(|r| r.get("stats")))
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct GeminiTokens {
    input: u64,
    output: u64,
    cached: u64,
    thoughts: u64,
    tool: u64,
    total: Option<u64>,
}

/// 전체 파일이 JSON 문서 하나인 로그 (upstream parse_json_file).
fn parse_json_file(path: &Path) -> Vec<RawUsage> {
    let fallback_timestamp = file_mtime_ms(path);
    let Ok(content) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(record) = serde_json::from_str::<GeminiRecord>(&content) else {
        return Vec::new();
    };
    let session_id = record.session_id().unwrap_or_else(|| file_stem(path));
    let session_timestamp = record
        .start_time
        .as_deref()
        .and_then(iso_to_epoch_ms)
        .or_else(|| record.last_updated.as_deref().and_then(iso_to_epoch_ms))
        .unwrap_or(fallback_timestamp);
    if let Some(messages) = record.messages.as_ref().and_then(Value::as_array) {
        return messages
            .iter()
            .filter_map(Value::as_object)
            .filter(|m| m.get("type").and_then(Value::as_str) == Some("gemini"))
            .filter_map(|m| parse_direct_event(m, None, &session_id, session_timestamp))
            .collect();
    }
    if record.r#type.as_deref() == Some("gemini") {
        return parse_direct_event_record(&record, None, &session_id, fallback_timestamp)
            .into_iter()
            .collect();
    }
    parse_stats_events(
        record.stats(),
        record.model.as_deref(),
        &session_id,
        record
            .timestamp
            .as_deref()
            .and_then(iso_to_epoch_ms)
            .unwrap_or(fallback_timestamp),
    )
}

/// JSONL 로그 (upstream parse_jsonl_file). 세션 id·모델 힌트는 라인을 따라 승계되고,
/// 같은 id 의 direct 이벤트는 교체(replace)된다 — 세션 파일이 제자리 갱신되는 형태 대응.
fn parse_jsonl_file(path: &Path) -> Vec<RawUsage> {
    let fallback_timestamp = file_mtime_ms(path);
    let Ok(content) = std::fs::read(path) else {
        return Vec::new();
    };
    let mut session_id = file_stem(path);
    let mut current_model: Option<String> = None;
    let mut events: Vec<RawUsage> = Vec::new();
    let mut direct_event_indexes: HashMap<String, usize> = HashMap::new();
    for line in content.split(|b| *b == b'\n') {
        // 파싱 불가 라인은 건너뛴다 (upstream jsonl::records 와 동일)
        let Ok(record) = serde_json::from_slice::<GeminiRecord>(line) else {
            continue;
        };
        if let Some(value) = record.session_id() {
            session_id = value;
        }
        if let Some(model) = record.model.clone() {
            current_model = Some(model);
        }
        if record.r#type.as_deref() == Some("gemini") {
            let Some(event) = parse_direct_event_record(
                &record,
                current_model.as_deref(),
                &session_id,
                fallback_timestamp,
            ) else {
                continue;
            };
            if let Some(id) = record.id.clone() {
                if let Some(index) = direct_event_indexes.get(&id).copied() {
                    events[index] = event;
                } else {
                    direct_event_indexes.insert(id, events.len());
                    events.push(event);
                }
            } else {
                events.push(event);
            }
            continue;
        }
        let stats = record.stats();
        if stats.is_some() {
            events.extend(parse_stats_events(
                stats,
                current_model.as_deref(),
                &session_id,
                record
                    .timestamp
                    .as_deref()
                    .and_then(iso_to_epoch_ms)
                    .unwrap_or(fallback_timestamp),
            ));
        }
    }
    events
}

/// messages 배열 안의 type=="gemini" 메시지 (upstream parse_direct_event).
fn parse_direct_event(
    record: &Map<String, Value>,
    model_hint: Option<&str>,
    session_id: &str,
    fallback_timestamp: i64,
) -> Option<RawUsage> {
    let tokens = parse_tokens(record.get("tokens"))?;
    let model = string_at(record, "model");
    build_event(
        model.as_deref().or(model_hint),
        session_id,
        timestamp_at(record, "timestamp")
            .or_else(|| timestamp_at(record, "created_at"))
            .unwrap_or(fallback_timestamp),
        tokens,
        normalize_session_input,
        string_at(record, "id"),
    )
}

/// 이미 역직렬화된 최상위 레코드용 (upstream parse_direct_event_record).
fn parse_direct_event_record(
    record: &GeminiRecord,
    model_hint: Option<&str>,
    session_id: &str,
    fallback_timestamp: i64,
) -> Option<RawUsage> {
    let tokens = parse_tokens(record.tokens.as_ref())?;
    build_event(
        record.model.as_deref().or(model_hint),
        session_id,
        record
            .timestamp
            .as_deref()
            .and_then(iso_to_epoch_ms)
            .or_else(|| record.created_at.as_deref().and_then(iso_to_epoch_ms))
            .unwrap_or(fallback_timestamp),
        tokens,
        normalize_session_input,
        record.id.clone(),
    )
}

/// stats 이벤트 (upstream parse_stats_events): stats.models 의 모델별 tokens 를
/// 우선 사용하고, 하나도 못 만들면 stats 자체를 tokens 로 재해석하는 폴백.
fn parse_stats_events(
    stats: Option<&Value>,
    model_hint: Option<&str>,
    session_id: &str,
    ts_ms: i64,
) -> Vec<RawUsage> {
    let Some(stats) = stats.and_then(Value::as_object) else {
        return Vec::new();
    };
    if let Some(models) = stats.get("models").and_then(Value::as_object) {
        let events = models
            .iter()
            .filter_map(|(model, data)| {
                let tokens = parse_tokens(data.as_object()?.get("tokens"))?;
                build_event(
                    Some(model),
                    session_id,
                    ts_ms,
                    tokens,
                    subtract_cached_overlap_tokens,
                    None,
                )
            })
            .collect::<Vec<_>>();
        if !events.is_empty() {
            return events;
        }
    }
    let Some(tokens) = parse_tokens(Some(&Value::Object(stats.clone()))) else {
        return Vec::new();
    };
    build_event(
        model_hint.or(Some(DEFAULT_MODEL)),
        session_id,
        ts_ms,
        tokens,
        subtract_cached_overlap_tokens,
        None,
    )
    .into_iter()
    .collect()
}

/// upstream build_event → RawUsage. 모델이 비면(직접 이벤트에 모델·힌트 모두 없음) 스킵.
/// 전 토큰이 0 이면 스킵. reasoning(thoughts + total 초과분)은 output 에 합산
/// (upstream event_to_loaded 의 cost_usage 와 동일 — 파일 상단 주석 참고).
fn build_event(
    model: Option<&str>,
    session_id: &str,
    ts_ms: i64,
    tokens: GeminiTokens,
    normalize_input: fn(GeminiTokens) -> (u64, u64),
    message_id: Option<String>,
) -> Option<RawUsage> {
    let model = model.filter(|m| !m.trim().is_empty())?;
    let (input_without_cache, cache_read_tokens) = normalize_input(tokens);
    let input_tokens = input_without_cache.saturating_add(tokens.tool);
    let total_tokens = tokens.total.unwrap_or_else(|| {
        input_tokens
            .saturating_add(tokens.output)
            .saturating_add(cache_read_tokens)
            .saturating_add(tokens.thoughts)
    });
    let (output_tokens, reasoning_tokens) = apply_total_token_fallback(
        input_tokens,
        tokens.output,
        cache_read_tokens,
        tokens.thoughts,
        total_tokens,
    );
    if input_tokens == 0 && output_tokens == 0 && cache_read_tokens == 0 && reasoning_tokens == 0 {
        return None;
    }
    Some(RawUsage {
        ts_ms,
        session_id: Some(session_id.to_string()),
        model: Some(model.to_string()),
        message_id,
        input_tokens,
        output_tokens: output_tokens.saturating_add(reasoning_tokens),
        cache_read_tokens,
        cache_creation_tokens: 0,
    })
}

/// upstream parse_tokens — 키 별칭을 순서대로 시도하고, 숫자는 f64 로 읽어
/// 음수는 0, 소수는 절삭(trunc)한다. tokens 값이 객체가 아니면 None.
fn parse_tokens(value: Option<&Value>) -> Option<GeminiTokens> {
    let record = value?.as_object()?;
    Some(GeminiTokens {
        input: token_number(
            record,
            &["input", "prompt", "input_tokens", "prompt_tokens"],
        ),
        output: token_number(
            record,
            &["output", "candidates", "output_tokens", "candidates_tokens"],
        ),
        cached: token_number(record, &["cached", "cached_tokens"]),
        thoughts: token_number(
            record,
            &[
                "thoughts",
                "reasoning",
                "thoughts_tokens",
                "reasoning_tokens",
            ],
        ),
        tool: token_number(record, &["tool", "tool_tokens"]),
        total: value_u64(record.get("total").or_else(|| record.get("total_tokens"))),
    })
}

fn token_number(record: &Map<String, Value>, keys: &[&str]) -> u64 {
    keys.iter()
        .find_map(|key| value_u64(record.get(*key)))
        .unwrap_or(0)
}

fn value_u64(value: Option<&Value>) -> Option<u64> {
    let value = value?.as_f64()?;
    if !value.is_finite() {
        return None;
    }
    Some(value.max(0.0).trunc() as u64)
}

/// stats 경로용: input 은 항상 cached 와의 중복(overlap)을 뺀다.
fn subtract_cached_overlap_tokens(tokens: GeminiTokens) -> (u64, u64) {
    let cache_read = tokens.cached;
    let cached_portion = tokens.input.min(cache_read);
    (tokens.input.saturating_sub(cached_portion), cache_read)
}

/// 직접 이벤트용: total 이 "cached 를 제외한 합"과 일치할 때만 — 즉 input 이
/// cached 를 포함해 집계된 세션 형식일 때만 — 중복을 뺀다 (upstream 동일).
fn normalize_session_input(tokens: GeminiTokens) -> (u64, u64) {
    let inclusive_total = tokens
        .input
        .saturating_add(tokens.output)
        .saturating_add(tokens.thoughts)
        .saturating_add(tokens.tool);
    let exclusive_total = inclusive_total.saturating_add(tokens.cached);
    if tokens.cached > 0
        && tokens.total == Some(inclusive_total)
        && tokens.total != Some(exclusive_total)
    {
        return subtract_cached_overlap_tokens(tokens);
    }
    (tokens.input, tokens.cached)
}

fn timestamp_at(record: &Map<String, Value>, key: &str) -> Option<i64> {
    iso_to_epoch_ms(record.get(key)?.as_str()?)
}

fn string_at(record: &Map<String, Value>, key: &str) -> Option<String> {
    non_empty_json_string(record.get(key))
}

fn file_stem(path: &Path) -> String {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("unknown")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::super::gemini_family::testutil::{EnvGuard, TempDir};
    use super::*;

    // ① JSON 전체 파일: messages 배열에서 type=="gemini" 만, 세션/타임스탬프 폴백
    #[test]
    fn parses_whole_file_json_messages_array() {
        let tmp = TempDir::new("gemini-json");
        let path = tmp.write(
            "chats/session-1.json",
            r#"{
              "sessionId": "sess-1",
              "startTime": "2026-05-17T11:07:00.000Z",
              "messages": [
                {"type": "user", "text": "hi"},
                {"type": "gemini", "id": "msg-1", "model": "gemini-2.5-pro",
                 "timestamp": "2026-05-17T11:07:32.000Z",
                 "tokens": {"input": 100, "output": 10, "cached": 40, "thoughts": 5, "tool": 2, "total": 117}},
                {"type": "gemini", "tokens": {"input": 1}},
                {"type": "gemini", "model": "gemini-2.5-flash", "tokens": {"input": 7}}
              ]
            }"#,
        );
        let events = Gemini.parse_file(&path);

        assert_eq!(events.len(), 2, "모델 없는 direct 이벤트는 스킵");
        let e = &events[0];
        assert_eq!(e.session_id.as_deref(), Some("sess-1"));
        assert_eq!(e.model.as_deref(), Some("gemini-2.5-pro"));
        assert_eq!(e.message_id.as_deref(), Some("msg-1"));
        assert_eq!(
            e.ts_ms,
            iso_to_epoch_ms("2026-05-17T11:07:32.000Z").unwrap()
        );
        // total==input+output+thoughts+tool(캐시 제외 합) → 캐시 중복 제거:
        // input=(100-40)+tool 2=62, output=10+reasoning 5=15, cache_read=40
        assert_eq!(e.input_tokens, 62);
        assert_eq!(e.output_tokens, 15);
        assert_eq!(e.cache_read_tokens, 40);
        assert_eq!(e.cache_creation_tokens, 0);
        // 타임스탬프 없는 메시지는 세션 startTime 으로 폴백
        assert_eq!(
            events[1].ts_ms,
            iso_to_epoch_ms("2026-05-17T11:07:00.000Z").unwrap()
        );
        assert_eq!(events[1].model.as_deref(), Some("gemini-2.5-flash"));
        assert_eq!(events[1].input_tokens, 7);
    }

    // ② JSONL: 같은 id 레코드 교체 + 세션/모델 힌트 승계 + mtime 폴백
    #[test]
    fn jsonl_replaces_same_id_and_inherits_hints() {
        let tmp = TempDir::new("gemini-jsonl");
        let path = tmp.write(
            "logs/session-a.jsonl",
            &[
                r#"{"sessionId":"session-a","projectHash":"p1"}"#,
                r#"{"model":"gemini-3-flash"}"#,
                r#"{"type":"gemini","id":"m1","tokens":{"input":10,"output":1}}"#,
                "this line is not json",
                r#"{"type":"gemini","id":"m1","tokens":{"input":20,"output":2}}"#,
                r#"{"type":"gemini","id":"m2","model":"gemini-3-pro","timestamp":"2026-05-17T11:07:32.000Z","tokens":{"input":5,"output":5}}"#,
            ]
            .join("\n"),
        );
        let events = Gemini.parse_file(&path);

        assert_eq!(events.len(), 2, "같은 id 는 교체되어 1건만 남는다");
        let m1 = &events[0];
        assert_eq!(m1.message_id.as_deref(), Some("m1"));
        assert_eq!(m1.input_tokens, 20, "뒤 레코드가 앞을 교체");
        assert_eq!(m1.output_tokens, 2);
        assert_eq!(
            m1.model.as_deref(),
            Some("gemini-3-flash"),
            "모델 힌트 승계"
        );
        assert_eq!(m1.session_id.as_deref(), Some("session-a"), "세션 승계");
        assert_eq!(
            m1.ts_ms,
            file_mtime_ms(&path),
            "타임스탬프 없으면 파일 mtime"
        );
        assert_eq!(events[1].model.as_deref(), Some("gemini-3-pro"));
    }

    // ③ stats.models 폴백 + models 없는 flat stats 의 기본 모델
    #[test]
    fn stats_models_and_flat_stats_fallback() {
        let tmp = TempDir::new("gemini-stats");
        let path = tmp.write(
            "logs/stats.json",
            r#"{
              "sessionId": "s2",
              "timestamp": "2026-05-17T12:00:00.000Z",
              "stats": {"models": {"gemini-2.5-pro": {"tokens":
                {"prompt": 100, "candidates": 20, "cached": 30, "thoughts": 3}}}}
            }"#,
        );
        let events = Gemini.parse_file(&path);
        assert_eq!(events.len(), 1);
        let e = &events[0];
        assert_eq!(e.model.as_deref(), Some("gemini-2.5-pro"));
        assert_eq!(e.session_id.as_deref(), Some("s2"));
        assert_eq!(e.message_id, None, "stats 이벤트에는 message id 없음");
        assert_eq!(
            e.ts_ms,
            iso_to_epoch_ms("2026-05-17T12:00:00.000Z").unwrap()
        );
        // stats 경로는 항상 캐시 중복 제거: input=100-30=70, output=20+thoughts 3
        assert_eq!(e.input_tokens, 70);
        assert_eq!(e.output_tokens, 23);
        assert_eq!(e.cache_read_tokens, 30);

        // models 가 없으면 stats 자체를 tokens 로 해석, 모델은 "unknown"
        let path = tmp.write(
            "logs/flat.json",
            r#"{"session_id":"s3","stats":{"prompt_tokens":50,"candidates_tokens":5}}"#,
        );
        let events = Gemini.parse_file(&path);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].model.as_deref(), Some("unknown"));
        assert_eq!(
            events[0].session_id.as_deref(),
            Some("s3"),
            "snake session_id 도 인식"
        );
        assert_eq!(events[0].input_tokens, 50);
        assert_eq!(events[0].output_tokens, 5);

        // result.stats 경로도 최상위 stats 부재 시 사용된다
        let path = tmp.write(
            "logs/result.json",
            r#"{"model":"gemini-2.5-pro","result":{"stats":{"input":9,"output":1}}}"#,
        );
        let events = Gemini.parse_file(&path);
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].model.as_deref(),
            Some("gemini-2.5-pro"),
            "최상위 model 이 힌트"
        );
        assert_eq!(events[0].input_tokens, 9);
    }

    // ④ 토큰 키 별칭 + float 절삭 + 음수/비숫자 처리
    #[test]
    fn token_aliases_and_float_truncation() {
        let value = serde_json::json!({
            "prompt_tokens": 12.9,
            "candidates": 3,
            "cached_tokens": 2.5,
            "reasoning": 1,
            "tool_tokens": 4,
            "total_tokens": 99.9
        });
        let t = parse_tokens(Some(&value)).unwrap();
        assert_eq!(
            (t.input, t.output, t.cached, t.thoughts, t.tool, t.total),
            (12, 3, 2, 1, 4, Some(99)),
            "별칭 키 인식 + float 절삭"
        );

        // 별칭 우선순위: 먼저 나온 키가 이기고, 비숫자 값은 다음 별칭으로 넘어간다
        let value = serde_json::json!({"input": 1, "prompt": 9});
        assert_eq!(parse_tokens(Some(&value)).unwrap().input, 1);
        let value = serde_json::json!({"input": "x", "prompt": 7});
        assert_eq!(parse_tokens(Some(&value)).unwrap().input, 7);
        // 음수는 0 으로 클램프
        let value = serde_json::json!({"input": -5});
        assert_eq!(parse_tokens(Some(&value)).unwrap().input, 0);
        // tokens 가 객체가 아니면 None → 해당 이벤트 스킵
        assert!(parse_tokens(Some(&serde_json::json!(42))).is_none());
        assert!(parse_tokens(None).is_none());
    }

    // ⑤ 손상 파일 → 빈 벡터 (수집 전체를 중단시키지 않음)
    #[test]
    fn corrupt_files_yield_empty() {
        let tmp = TempDir::new("gemini-corrupt");
        let json = tmp.write("bad.json", "not json {{{");
        assert!(Gemini.parse_file(&json).is_empty());
        let jsonl = tmp.write("bad.jsonl", "garbage\nmore garbage\n");
        assert!(Gemini.parse_file(&jsonl).is_empty());
        assert!(Gemini
            .parse_file(Path::new("/nonexistent/x.json"))
            .is_empty());
        // 유효한 JSON 이지만 쓸 데이터가 없는 파일도 빈 벡터
        let empty = tmp.write("empty.json", r#"{"sessionId":"s"}"#);
        assert!(Gemini.parse_file(&empty).is_empty());
    }

    // ⑥ 경로 탐색: GEMINI_DATA_DIR csv override, json+jsonl 만, 정렬·중복 제거
    #[test]
    fn discover_files_honors_env_csv() {
        let tmp = TempDir::new("gemini-discover");
        let a = tmp.write("dirA/chats/a.json", "{}");
        let b = tmp.write("dirB/b.jsonl", "{}\n");
        tmp.write("dirA/ignore.txt", "no");
        let dir_a = tmp.path().join("dirA");
        let dir_b = tmp.path().join("dirB");
        let csv = format!(
            " {} , {} ,{},/nonexistent-toard-dir",
            dir_a.display(),
            dir_b.display(),
            dir_a.display() // 중복 항목은 제거
        );
        let _guard = EnvGuard::set(GEMINI_DATA_DIR_ENV, std::ffi::OsStr::new(&csv));
        let mut expected = vec![a, b];
        expected.sort();
        assert_eq!(Gemini.discover_files(), expected);
    }

    // ⑦ 본문(JSON messages): user/gemini 텍스트만, 공백·기타 타입 스킵, ts·id·세션 매핑
    #[test]
    fn content_from_messages_array() {
        let tmp = TempDir::new("gemini-content-json");
        let path = tmp.write(
            "chats/session-1.json",
            r#"{
              "sessionId": "sess-1",
              "startTime": "2026-05-17T11:07:00.000Z",
              "messages": [
                {"type": "user", "text": "안녕 프롬프트", "timestamp": "2026-05-17T11:07:10.000Z"},
                {"type": "gemini", "id": "m1", "text": "응답이야", "timestamp": "2026-05-17T11:07:32.000Z"},
                {"type": "user", "text": "   "},
                {"type": "tool", "text": "skip me"},
                {"type": "gemini", "tokens": {"input": 1}}
              ]
            }"#,
        );
        let items = Gemini.parse_content(&path);
        assert_eq!(items.len(), 2, "빈 텍스트·tool·텍스트없음은 스킵");

        let u = &items[0];
        assert_eq!(u.role, "user");
        assert_eq!(u.text, "안녕 프롬프트");
        assert_eq!(u.session_id.as_deref(), Some("sess-1"));
        assert_eq!(u.message_id, None);
        assert_eq!(u.ts_ms, iso_to_epoch_ms("2026-05-17T11:07:10.000Z").unwrap());

        let a = &items[1];
        assert_eq!(a.role, "assistant");
        assert_eq!(a.text, "응답이야");
        assert_eq!(a.message_id.as_deref(), Some("m1"));
        assert_eq!(a.ts_ms, iso_to_epoch_ms("2026-05-17T11:07:32.000Z").unwrap());
    }

    // ⑧ 본문(JSONL): 세션 승계 + 같은 id 교체 + ts 없으면 mtime 폴백
    #[test]
    fn content_jsonl_inherits_session_and_replaces_same_id() {
        let tmp = TempDir::new("gemini-content-jsonl");
        let path = tmp.write(
            "logs/session-a.jsonl",
            &[
                r#"{"sessionId":"session-a"}"#,
                r#"{"type":"user","text":"첫 질문"}"#,
                r#"{"type":"gemini","id":"m1","text":"부분 응답"}"#,
                "not json",
                r#"{"type":"gemini","id":"m1","text":"최종 응답"}"#,
            ]
            .join("\n"),
        );
        let items = Gemini.parse_content(&path);
        assert_eq!(items.len(), 2, "같은 id 는 교체되어 1건");
        assert_eq!(items[0].role, "user");
        assert_eq!(items[0].text, "첫 질문");
        assert_eq!(items[0].session_id.as_deref(), Some("session-a"));
        assert_eq!(items[1].text, "최종 응답", "뒤 레코드가 앞을 교체");
        assert_eq!(items[1].ts_ms, file_mtime_ms(&path), "ts 없으면 파일 mtime");
    }
}

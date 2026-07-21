// ccusage rust/crates/ccusage/src/adapter/jsonl.rs + src/utils.rs @ cdda1821
// (MIT, Copyright (c) 2025 ryoppippi) 에서 이식 — 비용 계산 제거, RawUsage 로 매핑.
// gemini 계열 어댑터(gemini/qwen)가 공유하는 lenient 역직렬화 헬퍼와
// total 토큰 폴백. 파싱 의미는 upstream 과 동일하게 유지한다.

use serde::{Deserialize, Deserializer};
use serde_json::{Map, Value};

use super::RawContent;
use crate::iso::iso_to_epoch_ms;

/// upstream utils::non_empty_json_string — 문자열이 아니거나 trim 후 비면 None.
pub fn non_empty_json_string(value: Option<&Value>) -> Option<String> {
    let value = value?.as_str()?.trim();
    (!value.is_empty()).then(|| value.to_string())
}

/// upstream jsonl::non_empty_string — trim 된 비어있지 않은 문자열만.
/// 타입 불일치는 라인 전체를 실패시키지 않고 None 이 된다.
pub fn non_empty_string<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<Value>::deserialize(deserializer)?;
    Ok(non_empty_json_string(value.as_ref()))
}

/// upstream gemini/parser::lenient_str — Value::as_str 의미의 미가공(un-trimmed) 문자열.
/// type 판별자("gemini" 와 정확 비교)와 타임스탬프 필드용. 비문자열은 None.
pub fn lenient_str<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<Value>::deserialize(deserializer)?;
    Ok(value
        .as_ref()
        .and_then(Value::as_str)
        .map(ToString::to_string))
}

/// upstream jsonl::lenient_u64 — Value::as_u64 의미.
/// 음이 아닌 정수만 값이 되고 float/문자열/음수/null/누락은 0.
pub fn lenient_u64<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<Value>::deserialize(deserializer)?;
    Ok(value.as_ref().and_then(Value::as_u64).unwrap_or_default())
}

/// upstream utils::apply_total_token_fallback — gemini 계열은 cache_creation 이 항상 0.
/// known(input+output+cache_read+extra) 보다 total 이 크면 부족분을
/// output(0일 때) 또는 extra(reasoning 누적) 에 귀속한다. 반환은 (output, extra).
pub fn apply_total_token_fallback(
    input: u64,
    output: u64,
    cache_read: u64,
    extra_total: u64,
    total: u64,
) -> (u64, u64) {
    let known = input
        .saturating_add(output)
        .saturating_add(cache_read)
        .saturating_add(extra_total);
    let missing = total.saturating_sub(known);
    if missing == 0 {
        return (output, extra_total);
    }
    if output == 0 {
        (missing, extra_total)
    } else {
        (output, extra_total.saturating_add(missing))
    }
}

// ── 본문(프롬프트/응답) 추출 — opt-in 콘텐츠 수집 공용 헬퍼 ──
// gemini/qwen 로그의 메시지 객체에서 role + 텍스트를 뽑는다. 토큰 파서와 별개로,
// 텍스트를 담은 user/assistant 메시지만 본다. 알 수 없는 형태는 빈 결과(안전 쪽).

/// 메시지 본문 문자열 — "text" 우선, 없으면 "content"(문자열일 때). trim 후 비면 None.
pub fn message_text(obj: &Map<String, Value>) -> Option<String> {
    for key in ["text", "content"] {
        if let Some(s) = obj.get(key).and_then(Value::as_str) {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// 메시지 type → 역할. gemini/model/assistant = assistant, user = user, 그 외는 None(스킵).
pub fn content_role(obj: &Map<String, Value>) -> Option<&'static str> {
    match obj.get("type").and_then(Value::as_str)? {
        "user" => Some("user"),
        "gemini" | "assistant" | "model" => Some("assistant"),
        _ => None,
    }
}

/// sessionId(camel) 우선, 다음 session_id — 토큰 파서와 동일 조회 순서.
pub fn session_id_of(obj: &Map<String, Value>) -> Option<String> {
    non_empty_json_string(obj.get("sessionId"))
        .or_else(|| non_empty_json_string(obj.get("session_id")))
}

/// 메시지 객체 하나 → RawContent. role·텍스트가 모두 있어야 한다.
/// ts 는 timestamp/created_at → 폴백. id 는 dedup 1차 키(있으면).
pub fn content_from_message(
    obj: &Map<String, Value>,
    session_id: &str,
    fallback_ts: i64,
) -> Option<RawContent> {
    let role = content_role(obj)?;
    let text = message_text(obj)?;
    let ts_ms = obj
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(iso_to_epoch_ms)
        .or_else(|| {
            obj.get("created_at")
                .and_then(Value::as_str)
                .and_then(iso_to_epoch_ms)
        })
        .unwrap_or(fallback_ts);
    Some(RawContent {
        ts_ms,
        session_id: Some(session_id.to_string()),
        message_id: non_empty_json_string(obj.get("id")),
        role,
        text,
        agent: None,
    })
}

/// 테스트 픽스처·env var 직렬화 공용 유틸 (gemini/qwen 테스트가 공유).
#[cfg(test)]
pub mod testutil {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::{Mutex, MutexGuard};

    /// env var 는 프로세스 전역 상태 — set/remove 하는 테스트는 이 락으로 직렬화한다.
    fn env_lock() -> MutexGuard<'static, ()> {
        static LOCK: Mutex<()> = Mutex::new(());
        LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// std::env::temp_dir() 아래 프로세스 고유 서브디렉토리 — drop 시 정리.
    pub struct TempDir(PathBuf);

    impl TempDir {
        pub fn new(tag: &str) -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let dir = std::env::temp_dir().join(format!(
                "toard-shim-test-{tag}-{}-{}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        pub fn path(&self) -> &Path {
            &self.0
        }

        pub fn write(&self, rel: &str, content: &str) -> PathBuf {
            let path = self.0.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, content).unwrap();
            path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// env var 를 잡고(락 보유) 원복하는 가드.
    pub struct EnvGuard {
        key: &'static str,
        prev: Option<std::ffi::OsString>,
        _lock: MutexGuard<'static, ()>,
    }

    impl EnvGuard {
        pub fn set(key: &'static str, value: &std::ffi::OsStr) -> Self {
            let lock = env_lock();
            let prev = std::env::var_os(key);
            std::env::set_var(key, value);
            Self {
                key,
                prev,
                _lock: lock,
            }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match &self.prev {
                Some(v) => std::env::set_var(self.key, v),
                None => std::env::remove_var(self.key),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn total_fallback_fills_output_when_output_is_zero() {
        // upstream utils 테스트와 동일: input 100 + cache 25, total 175 → output 50
        assert_eq!(apply_total_token_fallback(100, 0, 25, 0, 175), (50, 0));
    }

    #[test]
    fn total_fallback_accrues_extra_when_output_is_known() {
        // output 이 이미 있으면 초과분은 extra(reasoning) 로
        assert_eq!(apply_total_token_fallback(100, 50, 25, 0, 200), (50, 25));
        // extra(thoughts) 는 known 에 포함된다
        assert_eq!(apply_total_token_fallback(100, 50, 25, 10, 200), (50, 25));
    }

    #[test]
    fn total_fallback_is_noop_when_total_not_larger() {
        assert_eq!(apply_total_token_fallback(100, 50, 0, 0, 0), (50, 0));
        assert_eq!(apply_total_token_fallback(100, 50, 0, 0, 150), (50, 0));
    }

    #[test]
    fn lenient_u64_matches_value_as_u64() {
        #[derive(serde::Deserialize)]
        struct T {
            #[serde(default, deserialize_with = "lenient_u64")]
            n: u64,
        }
        let coerce = |raw: &str| {
            serde_json::from_str::<T>(&format!("{{\"n\":{raw}}}"))
                .unwrap()
                .n
        };
        assert_eq!(coerce("42"), 42);
        assert_eq!(coerce("12.5"), 0, "float 은 as_u64 의미로 0");
        assert_eq!(coerce("-1"), 0);
        assert_eq!(coerce("\"7\""), 0);
        assert_eq!(coerce("null"), 0);
    }

    #[test]
    fn string_helpers_trim_or_preserve() {
        #[derive(serde::Deserialize)]
        struct T {
            #[serde(default, deserialize_with = "non_empty_string")]
            a: Option<String>,
            #[serde(default, deserialize_with = "lenient_str")]
            b: Option<String>,
        }
        let t: T = serde_json::from_str(r#"{"a":"  x  ","b":" gemini "}"#).unwrap();
        assert_eq!(t.a.as_deref(), Some("x"));
        // lenient_str 은 trim 하지 않는다 — type=="gemini" 정확 비교를 위해
        assert_eq!(t.b.as_deref(), Some(" gemini "));
        let t: T = serde_json::from_str(r#"{"a":"   ","b":5}"#).unwrap();
        assert_eq!(t.a, None);
        assert_eq!(t.b, None);
    }
}

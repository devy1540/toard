// UsageEvent 와이어 포맷 미러 (설계 §5.6 — 계약 원본은 TS `packages/core/src/wire.ts`).
// 2차 fat shim 이 로컬 로그를 정규화해 POST /api/v1/events 로 보낼 때 쓰는 직렬화기.
// TS 와 같은 fixtures/usage-event.golden.json 을 테스트에서 읽어 드리프트를 CI 에서 잡는다.
//
// 런타임 소비자는 2차(pull 수집)에서 붙는다 — 그때까지는 계약 테스트가 유일한 사용처.
#![allow(dead_code)]

use crate::json::{self, Value};

#[derive(Debug, Clone, PartialEq)]
pub struct UsageEvent {
    pub dedup_key: String,
    pub provider_key: String,
    /// 서버가 토큰으로 확정 — shim 은 항상 None (§10.1)
    pub user_id: Option<String>,
    pub session_id: Option<String>,
    pub model: Option<String>,
    /// ISO 8601 UTC 문자열 — 파싱·검증은 서버 책임, shim 은 포맷만 보장
    pub ts: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    /// 서버가 pricing 으로 확정 — shim 은 항상 0 (§5.6)
    pub cost_usd: f64,
}

fn opt_string(v: Option<&Value>, field: &str) -> Result<Option<String>, String> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(format!("{field} 는 문자열 또는 null 이어야 합니다")),
    }
}

fn req_string(v: Option<&Value>, field: &str) -> Result<String, String> {
    match v {
        Some(Value::String(s)) if !s.is_empty() => Ok(s.clone()),
        _ => Err(format!("{field} 는 비어있지 않은 문자열이어야 합니다")),
    }
}

fn token_count(v: Option<&Value>, field: &str) -> Result<u64, String> {
    match v {
        Some(Value::Number(n)) => n
            .parse::<u64>()
            .map_err(|_| format!("{field} 는 0 이상의 정수여야 합니다")),
        _ => Err(format!("{field} 는 0 이상의 정수여야 합니다")),
    }
}

impl UsageEvent {
    pub fn from_json(v: &Value) -> Result<Self, String> {
        let cost_usd = match v.get("costUsd") {
            None | Some(Value::Null) => 0.0,
            Some(Value::Number(n)) => n
                .parse::<f64>()
                .ok()
                .filter(|c| c.is_finite() && *c >= 0.0)
                .ok_or("costUsd 는 0 이상의 숫자여야 합니다")?,
            Some(_) => return Err("costUsd 는 0 이상의 숫자여야 합니다".into()),
        };
        Ok(UsageEvent {
            dedup_key: req_string(v.get("dedupKey"), "dedupKey")?,
            provider_key: req_string(v.get("providerKey"), "providerKey")?,
            user_id: opt_string(v.get("userId"), "userId")?,
            session_id: opt_string(v.get("sessionId"), "sessionId")?,
            model: opt_string(v.get("model"), "model")?,
            ts: req_string(v.get("ts"), "ts")?,
            input_tokens: token_count(v.get("inputTokens"), "inputTokens")?,
            output_tokens: token_count(v.get("outputTokens"), "outputTokens")?,
            cache_read_tokens: token_count(v.get("cacheReadTokens"), "cacheReadTokens")?,
            cache_creation_tokens: token_count(
                v.get("cacheCreationTokens"),
                "cacheCreationTokens",
            )?,
            cost_usd,
        })
    }

    pub fn to_json(&self) -> Value {
        let opt = |o: &Option<String>| match o {
            Some(s) => Value::String(s.clone()),
            None => Value::Null,
        };
        // cost 는 shim 에서 항상 0 — 정수로 떨어지면 정수 토큰으로 (JSON 숫자 표현 안정화)
        let cost = if self.cost_usd.fract() == 0.0 {
            format!("{}", self.cost_usd as u64)
        } else {
            format!("{}", self.cost_usd)
        };
        Value::Object(vec![
            ("dedupKey".into(), Value::String(self.dedup_key.clone())),
            (
                "providerKey".into(),
                Value::String(self.provider_key.clone()),
            ),
            ("userId".into(), opt(&self.user_id)),
            ("sessionId".into(), opt(&self.session_id)),
            ("model".into(), opt(&self.model)),
            ("ts".into(), Value::String(self.ts.clone())),
            (
                "inputTokens".into(),
                Value::Number(self.input_tokens.to_string()),
            ),
            (
                "outputTokens".into(),
                Value::Number(self.output_tokens.to_string()),
            ),
            (
                "cacheReadTokens".into(),
                Value::Number(self.cache_read_tokens.to_string()),
            ),
            (
                "cacheCreationTokens".into(),
                Value::Number(self.cache_creation_tokens.to_string()),
            ),
            ("costUsd".into(), Value::Number(cost)),
        ])
    }
}

/// POST /api/v1/events 본문 직렬화 (UsageEvent[] JSON)
pub fn to_events_body(events: &[UsageEvent]) -> String {
    json::to_pretty(&Value::Array(
        events.iter().map(UsageEvent::to_json).collect(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn golden() -> Value {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/usage-event.golden.json"
        );
        let text = std::fs::read_to_string(path).expect("골든 fixture 읽기");
        json::parse(&text).expect("골든 fixture 파싱")
    }

    #[test]
    fn golden_fixture_roundtrips() {
        let Value::Array(items) = golden() else {
            panic!("fixture 는 배열이어야 함")
        };
        assert_eq!(items.len(), 3);
        for item in &items {
            let ev = UsageEvent::from_json(item).expect("모든 골든 이벤트가 파싱돼야 함");
            // 미러 왕복: to_json → from_json 이 동일 구조체
            let back = UsageEvent::from_json(&ev.to_json()).unwrap();
            assert_eq!(back, ev);
            // 신뢰경계 불변식 — shim 산출물은 user/cost 를 갖지 않는다
            assert_eq!(ev.user_id, None);
            assert_eq!(ev.cost_usd, 0.0);
        }
    }

    #[test]
    fn golden_field_values() {
        let Value::Array(items) = golden() else {
            panic!()
        };
        let full = UsageEvent::from_json(&items[0]).unwrap();
        assert_eq!(full.provider_key, "gemini");
        assert_eq!(full.ts, "2026-07-01T12:00:00.000Z");
        assert_eq!(full.input_tokens, 1200);
        assert_eq!(full.cache_read_tokens, 500);
        let minimal = UsageEvent::from_json(&items[1]).unwrap();
        assert_eq!(minimal.session_id, None);
        assert_eq!(minimal.model, None);
    }

    #[test]
    fn rejects_missing_and_invalid_fields() {
        let bad = json::parse(r#"{"providerKey": "x"}"#).unwrap();
        assert!(UsageEvent::from_json(&bad)
            .unwrap_err()
            .contains("dedupKey"));
        let neg = json::parse(
            r#"{"dedupKey":"d","providerKey":"p","ts":"2026-07-01T00:00:00Z","inputTokens":-1,"outputTokens":0,"cacheReadTokens":0,"cacheCreationTokens":0}"#,
        )
        .unwrap();
        assert!(UsageEvent::from_json(&neg)
            .unwrap_err()
            .contains("inputTokens"));
    }

    #[test]
    fn events_body_is_json_array() {
        let Value::Array(items) = golden() else {
            panic!()
        };
        let events: Vec<UsageEvent> = items
            .iter()
            .map(|i| UsageEvent::from_json(i).unwrap())
            .collect();
        let body = to_events_body(&events);
        let reparsed = json::parse(&body).unwrap();
        let Value::Array(back) = reparsed else {
            panic!()
        };
        assert_eq!(back.len(), 3);
    }
}

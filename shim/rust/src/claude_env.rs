// `toard-shim claude-env on|off|status` — ~/.claude/settings.json 의 `env` 에
// OTEL 텔레메트리 키를 병합 주입한다. shim 은 PATH 경유 실행만 가로채므로,
// IDE 확장·절대경로·alias 실행까지 수집하려면 Claude Code 가 직접 읽는
// settings.json 경로가 필요하다 (shim wrap 의 보완재).
//
// 정책: 우리가 설정한 값은 ~/.toard/state/claude-env.json 에 기록해 두고,
// off 시 "기록과 일치하는 키만" 제거한다. 사용자가 직접 넣었거나 이후에 바꾼
// 값은 절대 덮지도 지우지도 않는다(경고만).

use crate::json::{self, Value};

/// 주입 대상 키 (Claude Code env 기반 텔레메트리 — shim wrap 과 동일 세트)
fn managed_keys(endpoint: &str, token: &str) -> Vec<(String, String)> {
    vec![
        ("CLAUDE_CODE_ENABLE_TELEMETRY".into(), "1".into()),
        ("OTEL_LOGS_EXPORTER".into(), "otlp".into()),
        ("OTEL_METRICS_EXPORTER".into(), "none".into()),
        ("OTEL_EXPORTER_OTLP_PROTOCOL".into(), "http/json".into()),
        ("OTEL_EXPORTER_OTLP_ENDPOINT".into(), endpoint.to_string()),
        (
            "OTEL_EXPORTER_OTLP_HEADERS".into(),
            format!("Authorization=Bearer {token}"),
        ),
        (
            "OTEL_RESOURCE_ATTRIBUTES".into(),
            "toard.shim=rust,toard.tool=claude".into(),
        ),
    ]
}

pub struct PlanResult {
    /// 새 settings.json 본문 (None = 쓰기 불필요)
    pub settings: Option<String>,
    /// 새 상태 파일 항목 (우리가 관리 중인 key=value)
    pub state: Vec<(String, String)>,
    pub warnings: Vec<String>,
}

fn parse_root(settings_text: &str) -> Result<Value, String> {
    if settings_text.trim().is_empty() {
        return Ok(Value::Object(vec![]));
    }
    let root = json::parse(settings_text)
        .map_err(|e| format!("settings.json 파싱 실패({e}) — 파일을 건드리지 않습니다"))?;
    match root {
        Value::Object(_) => Ok(root),
        _ => Err("settings.json 루트가 객체가 아닙니다".into()),
    }
}

pub fn plan_on(
    settings_text: &str,
    prev_state: &[(String, String)],
    endpoint: &str,
    token: &str,
) -> Result<PlanResult, String> {
    let mut root = parse_root(settings_text)?;
    if root.get("env").is_none() {
        root.set("env", Value::Object(vec![]));
    }
    if !matches!(root.get("env"), Some(Value::Object(_))) {
        return Err("settings.json 의 'env' 가 객체가 아닙니다 — 수동 확인 필요".into());
    }

    let mut warnings = Vec::new();
    let mut state = Vec::new();
    let env = root.get_mut("env").expect("env ensured above");
    for (key, want) in managed_keys(endpoint, token) {
        let ours_before = prev_state
            .iter()
            .find(|(k, _)| *k == key)
            .map(|(_, v)| v.as_str());
        match env.get(&key) {
            None => {
                env.set(&key, Value::String(want.clone()));
                state.push((key, want));
            }
            Some(Value::String(cur)) if *cur == want => state.push((key, want)),
            Some(Value::String(cur)) if Some(cur.as_str()) == ours_before => {
                // 예전에 우리가 넣은 값 → 갱신(endpoint/토큰 변경 추종)
                let cur = cur.clone();
                env.set(&key, Value::String(want.clone()));
                warnings.push(format!("{key}: toard 관리 값 갱신 ({cur} → {want})"));
                state.push((key, want));
            }
            Some(_) => warnings.push(format!(
                "{key}: 사용자가 설정한 값이 있어 보존합니다 — toard 수집과 충돌할 수 있음"
            )),
        }
    }

    let new_text = json::to_pretty(&root);
    Ok(PlanResult {
        settings: (new_text != settings_text).then_some(new_text),
        state,
        warnings,
    })
}

pub fn plan_off(
    settings_text: &str,
    prev_state: &[(String, String)],
) -> Result<PlanResult, String> {
    let mut root = parse_root(settings_text)?;
    let mut warnings = Vec::new();

    if let Some(env) = root.get_mut("env") {
        for (key, ours) in prev_state {
            match env.get(key) {
                Some(Value::String(cur)) if cur == ours => {
                    env.remove(key);
                }
                Some(_) => warnings.push(format!(
                    "{key}: 값이 toard 기록과 달라 보존합니다 (사용자 변경 추정)"
                )),
                None => {}
            }
        }
        if env.is_empty_object() {
            root.remove("env");
        }
    }

    let new_text = json::to_pretty(&root);
    Ok(PlanResult {
        settings: (new_text != settings_text).then_some(new_text),
        state: Vec::new(),
        warnings,
    })
}

// ── 상태 파일 (~/.toard/state/claude-env.json) 직렬화 ──

pub fn state_to_json(state: &[(String, String)]) -> String {
    let entries = state
        .iter()
        .map(|(k, v)| (k.clone(), Value::String(v.clone())))
        .collect();
    json::to_pretty(&Value::Object(vec![(
        "keys".into(),
        Value::Object(entries),
    )]))
}

pub fn state_from_json(text: &str) -> Vec<(String, String)> {
    let Ok(root) = json::parse(text) else {
        return Vec::new();
    };
    match root.get("keys") {
        Some(Value::Object(entries)) => entries
            .iter()
            .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
            .collect(),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EP: &str = "https://toard.example.com/api";
    const TK: &str = "tk_test";

    #[test]
    fn on_fresh_settings_injects_all() {
        let r = plan_on("", &[], EP, TK).unwrap();
        let text = r.settings.expect("settings 작성돼야 함");
        assert!(text.contains("\"CLAUDE_CODE_ENABLE_TELEMETRY\": \"1\""));
        assert!(text.contains("Authorization=Bearer tk_test"));
        assert_eq!(r.state.len(), 7);
        assert!(r.warnings.is_empty());
    }

    #[test]
    fn on_preserves_unrelated_settings_and_env() {
        let src = r#"{"model": "opus", "env": {"MY_VAR": "x"}}"#;
        let r = plan_on(src, &[], EP, TK).unwrap();
        let text = r.settings.unwrap();
        assert!(text.contains("\"model\": \"opus\""));
        assert!(text.contains("\"MY_VAR\": \"x\""));
    }

    #[test]
    fn on_is_idempotent() {
        let first = plan_on("", &[], EP, TK).unwrap();
        let applied = first.settings.unwrap();
        let second = plan_on(&applied, &first.state, EP, TK).unwrap();
        assert!(second.settings.is_none(), "재실행 시 쓰기 없어야 함");
        assert_eq!(second.state.len(), 7);
    }

    #[test]
    fn on_respects_user_value_conflict() {
        let src = r#"{"env": {"OTEL_EXPORTER_OTLP_ENDPOINT": "https://my-collector"}}"#;
        let r = plan_on(src, &[], EP, TK).unwrap();
        let text = r.settings.unwrap();
        assert!(text.contains("https://my-collector"), "사용자 값 보존");
        assert!(r
            .warnings
            .iter()
            .any(|w| w.contains("OTEL_EXPORTER_OTLP_ENDPOINT")));
        assert!(!r
            .state
            .iter()
            .any(|(k, _)| k == "OTEL_EXPORTER_OTLP_ENDPOINT"));
    }

    #[test]
    fn on_updates_previously_managed_value() {
        let first = plan_on("", &[], EP, "old_token").unwrap();
        let applied = first.settings.unwrap();
        let second = plan_on(&applied, &first.state, EP, "new_token").unwrap();
        let text = second.settings.expect("토큰 변경 시 재작성");
        assert!(text.contains("Bearer new_token"));
        assert!(!text.contains("Bearer old_token"));
    }

    #[test]
    fn off_removes_only_ours() {
        let first = plan_on(r#"{"env": {"MY_VAR": "x"}}"#, &[], EP, TK).unwrap();
        let applied = first.settings.unwrap();
        let off = plan_off(&applied, &first.state).unwrap();
        let text = off.settings.unwrap();
        assert!(text.contains("\"MY_VAR\": \"x\""), "사용자 env 보존");
        assert!(!text.contains("CLAUDE_CODE_ENABLE_TELEMETRY"));
        assert!(!text.contains("Authorization=Bearer"));
    }

    #[test]
    fn off_keeps_user_modified_value() {
        let first = plan_on("", &[], EP, TK).unwrap();
        let applied = first.settings.unwrap();
        // 사용자가 endpoint 를 바꿨다고 가정
        let modified = applied.replace(EP, "https://user-changed");
        let off = plan_off(&modified, &first.state).unwrap();
        let text = off.settings.unwrap();
        assert!(text.contains("https://user-changed"), "사용자 변경 값 보존");
        assert!(off
            .warnings
            .iter()
            .any(|w| w.contains("OTEL_EXPORTER_OTLP_ENDPOINT")));
    }

    #[test]
    fn off_removes_empty_env_object() {
        let first = plan_on("", &[], EP, TK).unwrap();
        let off = plan_off(&first.settings.unwrap(), &first.state).unwrap();
        assert_eq!(off.settings.unwrap().trim(), "{}");
    }

    #[test]
    fn broken_settings_is_never_touched() {
        assert!(plan_on("{broken", &[], EP, TK).is_err());
        assert!(plan_off("[1,2]", &[]).is_err());
    }

    #[test]
    fn state_roundtrip() {
        let state = vec![
            ("A".to_string(), "1".to_string()),
            ("B".to_string(), "x=y".to_string()),
        ];
        assert_eq!(state_from_json(&state_to_json(&state)), state);
        assert!(state_from_json("garbage").is_empty());
    }
}

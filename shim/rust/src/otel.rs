// OTEL 텔레메트리 env 주입. 사용자 설정은 존중하되(set_if_empty),
// 병합 가능한 키(headers/resource attrs)는 병합하고, 충돌은 notice 로 알린다.

use std::env;
use std::io::IsTerminal;

/// 진단 메시지 — 스크립트 stderr 오염을 피해 TTY 에서만 출력.
/// TOARD_SHIM_DEBUG=1 이면 항상 출력.
pub fn notice(msg: &str) {
    if env::var_os("TOARD_SHIM_DEBUG").is_some() || std::io::stderr().is_terminal() {
        eprintln!("toard-shim: {msg}");
    }
}

/// 값이 없을 때만 설정. 이미 있으면 false.
fn set_if_empty(key: &str, value: &str) -> bool {
    if env::var_os(key).is_none() {
        env::set_var(key, value);
        true
    } else {
        false
    }
}

pub enum HeaderMerge {
    /// 최종 값으로 설정 (기존 값에 append 포함)
    Set(String),
    /// 사용자 Authorization 이 이미 있어 주입하지 않음
    KeptUserAuth,
}

/// OTLP 헤더(comma-separated key=value) 병합. 사용자 Authorization 은 덮지 않는다.
pub fn merge_otlp_headers(existing: Option<&str>, token: &str) -> HeaderMerge {
    let auth = format!("Authorization=Bearer {token}");
    match existing.map(str::trim).filter(|s| !s.is_empty()) {
        None => HeaderMerge::Set(auth),
        Some(s) => {
            let has_auth = s.split(',').any(|pair| {
                pair.split('=')
                    .next()
                    .is_some_and(|k| k.trim().eq_ignore_ascii_case("authorization"))
            });
            if has_auth {
                HeaderMerge::KeptUserAuth
            } else {
                HeaderMerge::Set(format!("{s},{auth}"))
            }
        }
    }
}

/// 리소스 속성(comma-separated key=value)에 toard 마커 병합. 이미 있으면 None(변경 불필요).
pub fn merge_resource_attrs(existing: Option<&str>, tool: &str) -> Option<String> {
    let ours = format!("toard.shim=rust,toard.tool={tool}");
    match existing.map(str::trim).filter(|s| !s.is_empty()) {
        None => Some(ours),
        Some(s) => {
            let has_marker = s.split(',').any(|pair| {
                pair.split('=')
                    .next()
                    .is_some_and(|k| k.trim() == "toard.tool")
            });
            if has_marker {
                None
            } else {
                Some(format!("{s},{ours}"))
            }
        }
    }
}

/// 공통 OTEL env 주입 (Claude Code 는 env 기반; Codex 는 config.toml 우선이나 보조로 둠)
pub fn inject_env(tool: &str, endpoint: &str, token: &str) {
    set_if_empty("CLAUDE_CODE_ENABLE_TELEMETRY", "1");
    set_if_empty("OTEL_LOGS_EXPORTER", "otlp");
    set_if_empty("OTEL_METRICS_EXPORTER", "none");
    set_if_empty("OTEL_EXPORTER_OTLP_PROTOCOL", "http/json");

    if !set_if_empty("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint) {
        let cur = env::var("OTEL_EXPORTER_OTLP_ENDPOINT").unwrap_or_default();
        if cur.trim_end_matches('/') != endpoint.trim_end_matches('/') {
            notice(&format!(
                "OTEL_EXPORTER_OTLP_ENDPOINT 가 이미 '{cur}' 로 설정돼 있어 존중합니다 — toard({endpoint})로는 전송되지 않을 수 있습니다"
            ));
        }
    }

    match merge_otlp_headers(env::var("OTEL_EXPORTER_OTLP_HEADERS").ok().as_deref(), token) {
        HeaderMerge::Set(v) => env::set_var("OTEL_EXPORTER_OTLP_HEADERS", v),
        HeaderMerge::KeptUserAuth => notice(
            "OTEL_EXPORTER_OTLP_HEADERS 에 사용자 Authorization 이 있어 toard 토큰을 주입하지 않았습니다 — 401 유실 가능",
        ),
    }

    if let Some(v) =
        merge_resource_attrs(env::var("OTEL_RESOURCE_ATTRIBUTES").ok().as_deref(), tool)
    {
        env::set_var("OTEL_RESOURCE_ATTRIBUTES", v);
    }

    if tool == "codex" {
        set_if_empty("OTEL_SERVICE_NAME", "codex");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headers_fresh() {
        match merge_otlp_headers(None, "tk") {
            HeaderMerge::Set(v) => assert_eq!(v, "Authorization=Bearer tk"),
            _ => panic!("expected Set"),
        }
    }

    #[test]
    fn headers_append_to_user_values() {
        match merge_otlp_headers(Some("X-Custom=1,Team=infra"), "tk") {
            HeaderMerge::Set(v) => assert_eq!(v, "X-Custom=1,Team=infra,Authorization=Bearer tk"),
            _ => panic!("expected Set"),
        }
    }

    #[test]
    fn headers_keep_user_auth() {
        assert!(matches!(
            merge_otlp_headers(Some("authorization=Basic abc"), "tk"),
            HeaderMerge::KeptUserAuth
        ));
        assert!(matches!(
            merge_otlp_headers(Some("X-A=1, Authorization=Bearer other"), "tk"),
            HeaderMerge::KeptUserAuth
        ));
    }

    #[test]
    fn headers_blank_treated_as_empty() {
        assert!(matches!(
            merge_otlp_headers(Some("  "), "tk"),
            HeaderMerge::Set(_)
        ));
    }

    #[test]
    fn attrs_fresh() {
        assert_eq!(
            merge_resource_attrs(None, "claude").as_deref(),
            Some("toard.shim=rust,toard.tool=claude")
        );
    }

    #[test]
    fn attrs_append_preserves_user() {
        assert_eq!(
            merge_resource_attrs(Some("team=infra"), "codex").as_deref(),
            Some("team=infra,toard.shim=rust,toard.tool=codex")
        );
    }

    #[test]
    fn attrs_noop_when_marker_present() {
        assert_eq!(
            merge_resource_attrs(Some("toard.tool=claude,team=x"), "claude"),
            None
        );
    }
}

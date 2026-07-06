// 호스트(컴퓨터) 식별 라벨 취득 — 사용량을 컴퓨터별로 구분(설계 design-host-breakdown).
// HTTP 를 curl 에 위임하듯 hostname 취득도 시스템 `hostname` 명령에 위임(외부 크레이트 0 유지).
//
//   TOARD_DISABLE_HOST=1|true|on  → None (미전송 → 서버에서 "(알 수 없음)")
//   TOARD_HOST_LABEL=<별칭>        → 별칭(trim 만, 대소문자 존중 — 사용자가 고른 라벨)
//   그 외                         → `hostname` 결과를 trim + 소문자화
//
// 어느 경로든 제어문자·`,`·`=`(OTEL resource attr 구분자) 제거 + 255자 절단. 빈값 → None.

use std::env;
use std::process::Command;

const MAX_LEN: usize = 255;

fn truthy(v: &str) -> bool {
    matches!(v.trim(), "1" | "true" | "on")
}

/// 전송할 host 라벨. None = 미상/비활성.
pub fn host_label() -> Option<String> {
    if env::var("TOARD_DISABLE_HOST")
        .ok()
        .as_deref()
        .is_some_and(truthy)
    {
        return None;
    }
    if let Ok(alias) = env::var("TOARD_HOST_LABEL") {
        // 사용자 별칭 — 소문자화하지 않음(대소문자 존중)
        return clean(&alias, false);
    }
    clean(&detect_hostname()?, true)
}

/// `hostname` 명령 결과(비어있지 않으면). 실패 시 None.
fn detect_hostname() -> Option<String> {
    let out = Command::new("hostname").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// trim → 제어문자·구분자 제거 → (자동이면)소문자 → 255자 절단 → 빈값이면 None.
fn clean(s: &str, lowercase: bool) -> Option<String> {
    let mut v: String = s
        .trim()
        .chars()
        .filter(|c| !c.is_control() && *c != ',' && *c != '=')
        .collect();
    if lowercase {
        v = v.to_lowercase();
    }
    if v.chars().count() > MAX_LEN {
        v = v.chars().take(MAX_LEN).collect();
    }
    let v = v.trim().to_string();
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}

#[cfg(test)]
mod tests {
    use super::clean;

    #[test]
    fn lowercases_auto_hostname() {
        assert_eq!(
            clean("Alice-MacBook", true).as_deref(),
            Some("alice-macbook")
        );
    }

    #[test]
    fn preserves_alias_case() {
        assert_eq!(clean("Work-Laptop", false).as_deref(), Some("Work-Laptop"));
    }

    #[test]
    fn strips_control_and_separators() {
        // 개행·comma·equals 제거 (OTEL resource attr 안전)
        assert_eq!(clean("host,a=b\n", true).as_deref(), Some("hostab"));
    }

    #[test]
    fn empty_and_whitespace_to_none() {
        assert_eq!(clean("   ", false), None);
        assert_eq!(clean("", true), None);
    }

    #[test]
    fn truncates_to_255() {
        let long = "x".repeat(300);
        assert_eq!(clean(&long, false).unwrap().chars().count(), 255);
    }
}

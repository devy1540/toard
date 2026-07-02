// Codex(config.toml 기반)용 OTEL 설정 주입 — toard 마커 블록을 멱등 관리.
// 계획(plan)은 순수 함수로 분리해 테스트하고, 쓰기는 temp+rename 으로 원자적으로 수행한다
// (codex 동시 실행 시 read-modify-write 겹침으로 config 가 깨지는 것을 방지).

use std::env;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use crate::fsx;
use crate::otel::notice;

const BEGIN: &str = "# >>> toard otel >>>";
const END: &str = "# <<< toard otel <<<";

#[derive(Debug, PartialEq)]
pub enum Plan {
    /// 이미 원하는 내용 — 쓰기 불필요 (mtime 훼손 방지)
    Unchanged,
    /// 새 내용으로 교체
    Write(String),
    /// 사용자 [otel] 이 있어 주입 skip. stale toard 블록이 있었다면 제거본을 쓴다
    /// (양쪽이 공존하면 TOML 테이블 중복으로 codex 자체가 깨지므로).
    SkipUserOtel { cleaned: Option<String> },
}

/// 기존 내용에서 toard 마커 블록 제거(블록 뒤 개행 1개 포함 — 반복 실행 시 빈 줄 누적 방지).
pub fn strip_toard_block(existing: &str) -> String {
    match (existing.find(BEGIN), existing.find(END)) {
        (Some(b), Some(e)) if e >= b => {
            let mut rest = &existing[e + END.len()..];
            if let Some(r) = rest.strip_prefix('\n') {
                rest = r;
            }
            format!("{}{}", &existing[..b], rest)
        }
        _ => existing.to_string(),
    }
}

/// toard 블록 밖에서 사용자가 직접 정의한 [otel] 테이블 존재 여부.
/// 라인 시작 기준으로 검사해 주석(`# [otel]`)은 무시하고, `[otel.exporter…]` 하위 테이블도 잡는다.
pub fn has_user_otel(base: &str) -> bool {
    base.lines().any(|l| {
        let t = l.trim_start();
        t.starts_with("[otel]") || t.starts_with("[otel.")
    })
}

fn render_block(endpoint: &str, token: &str) -> String {
    let full = format!("{}/v1/logs", endpoint.trim_end_matches('/'));
    format!(
        "{BEGIN}\n[otel]\nlog_user_prompt = false\n\n[otel.exporter.otlp-http]\nendpoint = \"{full}\"\nprotocol = \"json\"\nheaders = {{ \"Authorization\" = \"Bearer {token}\" }}\n{END}\n"
    )
}

pub fn plan(existing: &str, endpoint: &str, token: &str) -> Plan {
    let base = strip_toard_block(existing);
    if has_user_otel(&base) {
        let cleaned = if base != existing { Some(base) } else { None };
        return Plan::SkipUserOtel { cleaned };
    }
    let sep = if base.is_empty() || base.ends_with('\n') {
        ""
    } else {
        "\n"
    };
    let full = format!("{base}{sep}{}", render_block(endpoint, token));
    if full == existing {
        Plan::Unchanged
    } else {
        Plan::Write(full)
    }
}

/// 토큰이 평문으로 들어가므로 파일 0600, 디렉토리 0700.
fn write_config(dir: &Path, path: &Path, content: &str) {
    let _ = std::fs::create_dir_all(dir);
    let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    let _ = fsx::write_atomic(path, content, 0o600);
}

pub fn inject_config(endpoint: &str, token: &str) {
    let Some(home) = env::var_os("HOME") else {
        return;
    };
    let dir = PathBuf::from(home).join(".codex");
    let path = dir.join("config.toml");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    match plan(&existing, endpoint, token) {
        Plan::Unchanged => {}
        Plan::Write(content) => write_config(&dir, &path, &content),
        Plan::SkipUserOtel { cleaned } => {
            notice("~/.codex/config.toml 에 사용자 [otel] 설정이 있어 자동 주입을 건너뜁니다(수동 설정 필요)");
            if let Some(content) = cleaned {
                write_config(&dir, &path, &content);
                notice("충돌 방지를 위해 기존 toard [otel] 블록은 제거했습니다");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EP: &str = "https://toard.example.com/api";
    const TK: &str = "tk_test";

    #[test]
    fn fresh_install_writes_block() {
        let Plan::Write(c) = plan("", EP, TK) else {
            panic!("expected Write")
        };
        assert!(c.contains("endpoint = \"https://toard.example.com/api/v1/logs\""));
        assert!(c.contains("Bearer tk_test"));
        assert!(c.starts_with(BEGIN));
        assert!(c.ends_with(&format!("{END}\n")));
    }

    #[test]
    fn idempotent_second_run_unchanged() {
        let Plan::Write(first) = plan("", EP, TK) else {
            panic!()
        };
        assert_eq!(plan(&first, EP, TK), Plan::Unchanged);
        // 사용자 설정과 공존해도 안정 상태 유지
        let with_user = format!("model = \"o3\"\n{first}");
        let Plan::Write(second) = plan("model = \"o3\"\n", EP, TK) else {
            panic!()
        };
        assert_eq!(second, with_user);
        assert_eq!(plan(&second, EP, TK), Plan::Unchanged);
    }

    #[test]
    fn endpoint_change_rewrites() {
        let Plan::Write(first) = plan("", EP, TK) else {
            panic!()
        };
        let Plan::Write(second) = plan(&first, "https://other.example.com/api", TK) else {
            panic!("endpoint 변경 시 재작성해야 함")
        };
        assert!(second.contains("other.example.com"));
        assert!(!second.contains("toard.example.com"));
    }

    #[test]
    fn user_otel_skips_injection() {
        assert_eq!(
            plan("[otel]\nlog_user_prompt = true\n", EP, TK),
            Plan::SkipUserOtel { cleaned: None }
        );
        // 하위 테이블만 있어도 충돌로 간주
        assert_eq!(
            plan("[otel.exporter.otlp-grpc]\nendpoint = \"x\"\n", EP, TK),
            Plan::SkipUserOtel { cleaned: None }
        );
    }

    #[test]
    fn commented_otel_is_not_user_otel() {
        assert!(matches!(plan("# [otel]\n", EP, TK), Plan::Write(_)));
    }

    #[test]
    fn stale_toard_block_removed_when_user_otel_added() {
        let Plan::Write(applied) = plan("", EP, TK) else {
            panic!()
        };
        let conflicted = format!("{applied}\n[otel]\nlog_user_prompt = true\n");
        let Plan::SkipUserOtel { cleaned: Some(c) } = plan(&conflicted, EP, TK) else {
            panic!("stale 블록 제거본을 반환해야 함")
        };
        assert!(!c.contains(BEGIN));
        assert!(c.contains("log_user_prompt = true"));
    }

    #[test]
    fn strip_does_not_accumulate_blank_lines() {
        let Plan::Write(first) = plan("", EP, TK) else {
            panic!()
        };
        assert_eq!(strip_toard_block(&first), "");
    }
}

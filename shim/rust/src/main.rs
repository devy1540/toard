// toard shim (Rust).
// `claude`/`codex` 이름으로 설치되어 텔레메트리 설정을 주입한 뒤
// PATH 에서 찾은 "진짜" 도구 바이너리(자기 자신 제외)를 exec 한다.
//   - claude: OTEL env 주입 (Claude Code 는 env 기반)
//   - codex : ~/.codex/config.toml 의 [otel] 주입 (Codex 는 config.toml 기반)
// OTEL SDK 없음 — 설정 주입 + resolver + exec 뿐인 얇은 래퍼 (설계 ADR-001/006).

mod codex;
mod credentials;
mod otel;

use std::env;
use std::ffi::OsString;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;

use credentials::{read_credentials, DEFAULT_ENDPOINT};
use otel::notice;

/// 재귀 exec 가드. exec 는 PID 를 보존하므로, 같은 PID 로 shim 이 다시 시작됐다면
/// (current_exe 판별 실패 또는 PATH 의 shim 사본 간 핑퐁) 무한 exec 루프다.
/// fork 로 태어난 진짜 하위 프로세스는 PID 가 달라 오탐하지 않는다.
const GUARD_ENV: &str = "TOARD_SHIM_GUARD_PID";

fn tool_name_from(arg0: Option<OsString>) -> String {
    arg0.map(PathBuf::from)
        .and_then(|p| p.file_name().map(|s| s.to_string_lossy().into_owned()))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "claude".to_string())
}

fn find_real_binary(name: &str) -> Option<PathBuf> {
    let self_canon = env::current_exe().ok().and_then(|p| p.canonicalize().ok());
    let path = env::var_os("PATH")?;
    for dir in env::split_paths(&path) {
        let cand = dir.join(name);
        if !cand.is_file() {
            continue;
        }
        // canonicalize 실패 후보는 자기 자신 오인(재귀 exec)을 막기 위해 건너뛴다
        let Ok(cc) = cand.canonicalize() else {
            continue;
        };
        if self_canon.as_ref() == Some(&cc) {
            continue;
        }
        return Some(cand);
    }
    None
}

fn main() {
    let pid = std::process::id().to_string();
    if env::var(GUARD_ENV).ok().as_deref() == Some(pid.as_str()) {
        eprintln!(
            "toard-shim: 재귀 실행 감지 — 진짜 도구 대신 shim 이 자기 자신을 다시 실행했습니다. PATH 의 shim 사본을 정리하세요."
        );
        std::process::exit(127);
    }

    let tool = tool_name_from(env::args_os().next());
    let creds = read_credentials();

    // 토큰이 없으면 주입하지 않고 순수 패스스루 — 죽은 endpoint 로의 전송(유실+재시도 노이즈)을 만들지 않는다.
    match &creds.token {
        Some(token) => {
            let endpoint = creds.endpoint.as_deref().unwrap_or(DEFAULT_ENDPOINT);
            otel::inject_env(&tool, endpoint, token);
            if tool == "codex" {
                codex::inject_config(endpoint, token);
            }
        }
        None => notice(
            "자격 증명이 없어 텔레메트리 주입 없이 실행합니다 — ~/.toard/credentials 또는 TOARD_INGEST_TOKEN 설정",
        ),
    }

    let real = match find_real_binary(&tool) {
        Some(p) => p,
        None => {
            eprintln!("toard-shim: '{tool}' 실제 바이너리를 PATH 에서 찾지 못했습니다");
            std::process::exit(127);
        }
    };

    env::set_var(GUARD_ENV, &pid);
    let args: Vec<OsString> = env::args_os().skip(1).collect();
    let err = Command::new(&real).args(&args).exec();
    eprintln!("toard-shim: exec 실패 ({}): {err}", real.display());
    std::process::exit(1);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_name_from_path() {
        assert_eq!(
            tool_name_from(Some("/Users/x/.toard/bin/codex".into())),
            "codex"
        );
        assert_eq!(tool_name_from(Some("claude".into())), "claude");
    }

    #[test]
    fn tool_name_defaults_to_claude() {
        assert_eq!(tool_name_from(None), "claude");
    }
}

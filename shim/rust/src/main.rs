// toard shim (Rust).
// `claude`/`codex` 이름으로 설치되어 텔레메트리 설정을 주입한 뒤
// PATH 에서 찾은 "진짜" 도구 바이너리(자기 자신 제외)를 exec 한다.
//   - claude: OTEL env 주입 (Claude Code 는 env 기반)
//   - codex : ~/.codex/config.toml 의 [otel] 주입 (Codex 는 config.toml 기반)
//   - toard-shim: 관리 CLI (doctor/version)
// OTEL SDK 없음 — 설정 주입 + resolver + exec 뿐인 얇은 래퍼 (설계 ADR-001/006).

mod bg;
mod claude_env;
mod cli;
mod codex;
pub mod collect;
mod content_crypto;
mod content_keys;
pub mod credentials;
mod daemon;
pub mod delivery;
mod e2ee_setup;
mod fsx;
mod host;
mod iso;
mod json;
mod otel;
mod recovery;
mod resolve;
pub mod targets;
mod tool_event;
mod update;
mod usage_event;

use std::env;
use std::ffi::OsString;
use std::process::Command;

use credentials::{read_credentials, DEFAULT_ENDPOINT};
use otel::notice;
use resolve::{find_real_binary, tool_name_from};

/// 재귀 실행 가드.
/// Unix: exec 는 PID 를 보존하므로, 같은 PID 로 shim 이 다시 시작됐다면
/// (current_exe 판별 실패 또는 PATH 의 shim 사본 간 핑퐁) 무한 exec 루프다.
/// fork 로 태어난 진짜 하위 프로세스는 PID 가 달라 오탐하지 않는다.
/// Windows: exec 가 없어 spawn 마다 PID 가 바뀌므로 PID 비교가 불가능하다 —
/// 대신 shim 경유 깊이를 세서 상한을 넘으면 핑퐁으로 판정한다(정상 사용은
/// claude 가 하위 claude 를 띄우는 중첩이라도 이 깊이에 도달하지 않는다).
const GUARD_ENV: &str = "TOARD_SHIM_GUARD_PID";
#[cfg(windows)]
const GUARD_MAX_DEPTH: u32 = 64;

enum WrapperMode {
    Missing,
    Single(credentials::Credentials),
    Multiple,
}

fn select_wrapper_mode(
    targets: &[targets::Target],
    legacy: credentials::Credentials,
) -> WrapperMode {
    match targets {
        [] if legacy.token.is_some() => WrapperMode::Single(legacy),
        [] => WrapperMode::Missing,
        [target] if target.credentials.token.is_some() => {
            WrapperMode::Single(target.credentials.clone())
        }
        [_] => WrapperMode::Missing,
        [_, _, ..] => WrapperMode::Multiple,
    }
}

fn main() {
    // 백그라운드 작업 내부 재진입 — argv0 과 무관하게 최우선 분기
    match env::args().nth(1).as_deref() {
        Some(update::SPAWN_ARG) => update::spawn_detached_updater(),
        Some(update::RUN_ARG) => std::process::exit(update::run_self_update(true)),
        Some(collect::SPAWN_ARG) => collect::spawn_detached_collector(),
        Some(collect::RUN_ARG) => std::process::exit(collect::run(None, false, false)),
        _ => {}
    }

    let tool = tool_name_from(env::args_os().next());

    // 관리 CLI — 래핑 대상이 아니므로 가드·주입 없이 즉시 분기
    if tool.starts_with("toard-shim") {
        let args: Vec<String> = env::args().skip(1).collect();
        cli::run(&args);
    }

    guard_against_recursion();

    let legacy = read_credentials();
    let targets = match targets::TargetStore::from_home().and_then(|store| store.load_or_migrate())
    {
        Ok(targets) => targets,
        Err(error) => {
            notice(&format!(
                "target 저장소를 읽지 못해 legacy 자격 증명만 확인합니다: {error}"
            ));
            Vec::new()
        }
    };
    let wrapper_mode = select_wrapper_mode(&targets, legacy);

    // 사용량은 트랜스크립트 pull(collect, 아래 maybe_spawn_background)로 수집한다(docs/design-usage-pull).
    // OTLP push 주입은 experimental(TOARD_EXPERIMENTAL_OTLP)로만 — 기본은 env/config 주입 없이 순수 패스스루라
    // 재시작·env 주입 dance 가 불필요하다. 토큰이 없으면 collect 도 전송 불가라 그대로 패스스루.
    match &wrapper_mode {
        WrapperMode::Single(credentials) if otel::experimental_otlp_enabled() => {
            let token = credentials
                .token
                .as_deref()
                .expect("single wrapper credentials must contain a token");
            let endpoint = credentials.endpoint.as_deref().unwrap_or(DEFAULT_ENDPOINT);
            otel::inject_env(&tool, endpoint, token);
            if tool == "codex" {
                codex::inject_config(endpoint, token);
            }
        }
        WrapperMode::Multiple if otel::experimental_otlp_enabled() => notice(
            "experimental OTLP는 여러 target에 주입할 수 없어 비활성화했습니다 — pull 수집은 모든 target으로 전송됩니다",
        ),
        WrapperMode::Single(_) | WrapperMode::Multiple => {} // 기본 경로: 주입 없음(pull 수집)
        WrapperMode::Missing => notice(
            "등록된 target이 없어 실행합니다 — 수집하려면 서버 설치 스크립트로 연결하세요",
        ),
    }

    let real = match find_real_binary(&tool) {
        Some(p) => p,
        None => {
            eprintln!("toard-shim: '{tool}' 실제 바이너리를 PATH 에서 찾지 못했습니다");
            std::process::exit(127);
        }
    };

    // 백그라운드 편승 작업 — exec 경로에 네트워크 없음 (스탬프 파일 판정만)
    update::maybe_spawn_background_check(); // 2h: 자동 업데이트
    collect::maybe_spawn_background(); // 10m: 비-OTEL 로컬 로그 수집 (§5.6)

    let args: Vec<OsString> = env::args_os().skip(1).collect();
    run_real(&real, &args);
}

fn recursion_bail() -> ! {
    eprintln!(
        "toard-shim: 재귀 실행 감지 — 진짜 도구 대신 shim 이 자기 자신을 다시 실행했습니다. PATH 의 shim 사본을 정리하세요."
    );
    std::process::exit(127);
}

#[cfg(unix)]
fn guard_against_recursion() {
    let pid = std::process::id().to_string();
    if env::var(GUARD_ENV).ok().as_deref() == Some(pid.as_str()) {
        recursion_bail();
    }
    env::set_var(GUARD_ENV, pid);
}

#[cfg(windows)]
fn guard_against_recursion() {
    let depth: u32 = env::var(GUARD_ENV)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    if depth >= GUARD_MAX_DEPTH {
        recursion_bail();
    }
    env::set_var(GUARD_ENV, (depth + 1).to_string());
}

/// 진짜 도구 실행. Unix 는 exec(프로세스 교체 — PID·시그널·TTY 그대로),
/// Windows 는 exec 가 없어 spawn 후 종료 코드를 전파한다.
#[cfg(unix)]
fn run_real(real: &std::path::Path, args: &[OsString]) -> ! {
    use std::os::unix::process::CommandExt;
    let err = Command::new(real).args(args).exec();
    eprintln!("toard-shim: exec 실패 ({}): {err}", real.display());
    std::process::exit(1);
}

#[cfg(windows)]
fn run_real(real: &std::path::Path, args: &[OsString]) -> ! {
    match Command::new(real).args(args).status() {
        Ok(status) => std::process::exit(status.code().unwrap_or(1)),
        Err(err) => {
            eprintln!("toard-shim: 실행 실패 ({}): {err}", real.display());
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod wrapper_target_tests {
    use super::*;

    fn credentials(endpoint: &str, token: Option<&str>) -> credentials::Credentials {
        credentials::Credentials {
            endpoint: Some(endpoint.into()),
            token: token.map(str::to_string),
            ..credentials::Credentials::default()
        }
    }

    fn target(endpoint: &str, token: &str) -> targets::Target {
        targets::Target {
            id: targets::target_id(endpoint),
            revision: String::new(),
            endpoint: endpoint.into(),
            credentials_path: std::path::PathBuf::from("credentials"),
            state_dir: std::path::PathBuf::from("state"),
            credentials: credentials(endpoint, Some(token)),
        }
    }

    #[test]
    fn wrapper_uses_registry_singleton_and_refuses_push_for_multiple_targets() {
        let legacy = credentials("https://legacy.example/api", Some("tk_legacy"));
        let company = target("https://company.example/api", "tk_company");
        let personal = target("https://personal.example/api", "tk_personal");

        match select_wrapper_mode(&[], legacy.clone()) {
            WrapperMode::Single(selected) => {
                assert_eq!(selected.token.as_deref(), Some("tk_legacy"));
            }
            _ => panic!("legacy credentials must remain compatible without registry targets"),
        }
        match select_wrapper_mode(std::slice::from_ref(&company), legacy.clone()) {
            WrapperMode::Single(selected) => {
                assert_eq!(selected.token.as_deref(), Some("tk_company"));
            }
            _ => panic!("one registry target must be selected"),
        }
        assert!(matches!(
            select_wrapper_mode(&[company, personal], legacy),
            WrapperMode::Multiple
        ));
        assert!(matches!(
            select_wrapper_mode(&[], credentials("https://legacy.example/api", None)),
            WrapperMode::Missing
        ));
    }
}

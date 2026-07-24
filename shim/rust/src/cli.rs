// `toard-shim` 이름으로 실행됐을 때의 관리 CLI — doctor / version / help.
// 래핑 경로(claude/codex)에는 어떤 오버헤드도 더하지 않는다.

use std::env;
use std::process::Command;

use crate::claude_env;
use crate::codex;
use crate::credentials::{
    read_credentials, ContentCollectionMode, InstallerCredentialsInput, DEFAULT_ENDPOINT,
};
use crate::fsx;
use crate::resolve::{find_real_binary, first_in_path, is_shim_executable_path};

const LEGACY_E2EE_WARNING: &str =
    "toard-shim: legacy E2EE 호환 명령입니다. 신규 연결에는 필요하지 않습니다.";

/// 릴리스 빌드는 CI 가 태그를 주입(TOARD_SHIM_BUILD_VERSION), 개발 빌드는 0.0.0.
pub fn version() -> &'static str {
    option_env!("TOARD_SHIM_BUILD_VERSION").unwrap_or(env!("CARGO_PKG_VERSION"))
}

pub fn run(args: &[String]) -> ! {
    match args.first().map(String::as_str) {
        Some("capabilities") if args.len() == 1 => {
            println!("multi-target-v1");
            std::process::exit(0);
        }
        Some("targets") => std::process::exit(targets_cmd(&args[1..])),
        Some("target") => std::process::exit(target_cmd(&args[1..])),
        Some("doctor") => std::process::exit(doctor_cmd(&args[1..])),
        Some("claude-env") => std::process::exit(claude_env_cmd(&args[1..])),
        Some("cursor-hook") => std::process::exit(crate::cursor_hook::run(&args[1..])),
        Some("collect") => std::process::exit(collect_cmd(&args[1..])),
        Some("daemon") => std::process::exit(crate::daemon::run(&args[1..])),
        Some("local") => std::process::exit(crate::local_bridge::run(&args[1..])),
        Some("e2ee") => std::process::exit(e2ee_cmd(&args[1..])),
        Some("tool") => std::process::exit(tool_cmd(&args[1..])),
        Some("update") => std::process::exit(crate::update::run_self_update(false)),
        Some("version" | "--version" | "-V") => {
            println!("toard-shim {}", version());
            std::process::exit(0);
        }
        None | Some("help" | "--help" | "-h") => {
            print_usage();
            std::process::exit(0);
        }
        Some(other) => {
            eprintln!("toard-shim: 알 수 없는 커맨드 '{other}'\n");
            print_usage();
            std::process::exit(2);
        }
    }
}

fn print_usage() {
    println!("{}", usage_text());
}

fn usage_text() -> String {
    format!(
        "toard-shim {} — toard 수집 shim 관리 CLI

사용법: toard-shim <command>

  capabilities                  installer 호환 capability 출력
  targets list                 등록된 전송 대상 목록 출력 (토큰 제외)
  target upsert                installer env의 endpoint·token·정책 추가/갱신
  target remove --machine      installer env의 endpoint 대상 제거 결과 출력
  doctor                       설치·자격 증명·endpoint·PATH 상태 진단
  claude-env on|off|status     ~/.claude/settings.json env 주입 관리
                               (IDE 등 PATH 를 거치지 않는 실행까지 수집)
  cursor-hook install|uninstall|status
                               Cursor stop hook 기반 정확 토큰 수집 관리
  collect [--dry-run]          비-OTEL 도구 로컬 로그 수집 → toard 전송
          [--adapter <key>]    (claude·codex·cursor·gemini·qwen)
          [--quiet]            무변경 시 무출력 (데몬 주기 실행용 — 전송·오류는 출력)
                               본문 수집은 opt-in(기본 off). 신규 연결은 평문을 HTTPS로
                               /v1/prompts에 전송하고 서버 관리형 암호화로 저장
  daemon install|uninstall|status
                               주기 수집 등록·해제·확인 (macOS launchd / Linux systemd·cron)
                               install --interval <초> (기본 60, 하한 60)
                               — Desktop/IDE 처럼 PATH 를 안 거치는 사용도 주기 안에 수집
  tool reconcile               도구 원하는 상태를 즉시 조회·적용
  tool configure <slug>        MCP 비밀값을 로컬 보안 저장소에 입력
  tool run-mcp <slug>          로컬 비밀값을 주입해 관리 MCP 실행
  local start|stop|status       UI 로컬 bridge 시작·종료·확인
  [legacy-e2ee — 기존 사용자 호환]
  e2ee setup                   기존 E2EE Recovery Kit 설정·복구
  e2ee status                  기존 로컬 E2EE 모드와 보안 저장소 키 상태 확인
  e2ee approve [--request ID]  기존 E2EE 기기 승인
  update                       최신 릴리스로 즉시 업데이트
                               (평소엔 2h 주기 백그라운드 자동 — TOARD_SHIM_AUTO_UPDATE=0 으로 끔)
  version                      버전 출력
  help                         이 도움말",
        version()
    )
}

fn installer_env(name: &str) -> Result<String, &'static str> {
    env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or("필수 installer 환경변수가 없습니다")
}

fn targets_cmd(args: &[String]) -> i32 {
    if args != ["list"] {
        eprintln!("toard-shim: 사용법: toard-shim targets list");
        return 2;
    }
    let store = match crate::targets::TargetStore::from_home() {
        Ok(store) => store,
        Err(error) => {
            eprintln!("toard-shim: target 저장소를 열 수 없습니다: {error}");
            return 1;
        }
    };
    let targets = match store.load_or_migrate() {
        Ok(targets) => targets,
        Err(error) => {
            eprintln!("toard-shim: target 목록을 읽을 수 없습니다: {error}");
            return 1;
        }
    };
    for target in targets {
        let content = match target.credentials.collect_content {
            ContentCollectionMode::Off => "off",
            ContentCollectionMode::ServerManaged => "server_v1",
            ContentCollectionMode::LegacyE2eeV1 => "e2ee_v1",
        };
        let tools = if target.credentials.collect_tools {
            "on"
        } else {
            "off"
        };
        let status = crate::delivery::load(&target.state_dir)
            .map(|status| {
                let result = format!("{:?}", status.result).to_ascii_lowercase();
                match status.last_success_at {
                    Some(last_success) => format!("delivery={result} last_success={last_success}"),
                    None => format!("delivery={result}"),
                }
            })
            .unwrap_or_else(|| "delivery=never".to_string());
        println!(
            "{} {} content={} tools={} {}",
            &target.id[..12],
            target.endpoint,
            content,
            tools,
            status
        );
    }
    0
}

fn target_cmd(args: &[String]) -> i32 {
    match args {
        [command] if command == "upsert" => target_upsert(),
        [command, machine] if command == "remove" && machine == "--machine" => {
            target_remove_machine()
        }
        _ => {
            eprintln!("toard-shim: 사용법: toard-shim target upsert | target remove --machine");
            2
        }
    }
}

fn target_upsert() -> i32 {
    let token = match installer_env("TOARD_INGEST_TOKEN") {
        Ok(value) => value,
        Err(_) => {
            eprintln!("toard-shim: TOARD_INGEST_TOKEN 이 필요합니다");
            return 2;
        }
    };
    let endpoint = match installer_env("TOARD_INGEST_ENDPOINT") {
        Ok(value) => value,
        Err(_) => {
            eprintln!("toard-shim: TOARD_INGEST_ENDPOINT 가 필요합니다");
            return 2;
        }
    };
    let content_since = env::var("TOARD_SHIM_COLLECT_CONTENT_SINCE").ok();
    let update_content_since = content_since
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty());
    let credentials = match crate::credentials::from_installer_input(InstallerCredentialsInput {
        token,
        endpoint,
        ui_origin: env::var("TOARD_UI_ORIGIN").ok(),
        collect_content: env::var("TOARD_SHIM_COLLECT_CONTENT").ok(),
        collect_tools: env::var("TOARD_SHIM_COLLECT_TOOLS").ok(),
        collect_content_since: content_since,
    }) {
        Ok(credentials) => credentials,
        Err(error) => {
            eprintln!("toard-shim: installer 입력이 올바르지 않습니다: {error}");
            return 2;
        }
    };
    let store = match crate::targets::TargetStore::from_home() {
        Ok(store) => store,
        Err(error) => {
            eprintln!("toard-shim: target 저장소를 열 수 없습니다: {error}");
            return 1;
        }
    };
    match store.upsert_installer(credentials, update_content_since) {
        Ok(target) => {
            println!("target={} endpoint={}", &target.id[..12], target.endpoint);
            0
        }
        Err(crate::targets::TargetError::InvalidEndpoint(error)) => {
            eprintln!("toard-shim: endpoint가 올바르지 않습니다: {error}");
            2
        }
        Err(crate::targets::TargetError::InvalidCredentials(error)) => {
            eprintln!("toard-shim: 자격 증명이 올바르지 않습니다: {error}");
            2
        }
        Err(error) => {
            eprintln!("toard-shim: target 저장 실패: {error}");
            1
        }
    }
}

fn target_remove_machine() -> i32 {
    let endpoint = match installer_env("TOARD_INGEST_ENDPOINT") {
        Ok(value) => value,
        Err(_) => {
            eprintln!("toard-shim: TOARD_INGEST_ENDPOINT 가 필요합니다");
            return 2;
        }
    };
    let store = match crate::targets::TargetStore::from_home() {
        Ok(store) => store,
        Err(error) => {
            eprintln!("toard-shim: target 저장소를 열 수 없습니다: {error}");
            return 1;
        }
    };
    match store.remove(&endpoint) {
        Ok(result) => {
            println!("removed={}", u8::from(result.removed));
            println!("remaining={}", result.remaining);
            0
        }
        Err(crate::targets::TargetError::InvalidEndpoint(error)) => {
            eprintln!("toard-shim: endpoint가 올바르지 않습니다: {error}");
            2
        }
        Err(error) => {
            eprintln!("toard-shim: target 제거 실패: {error}");
            1
        }
    }
}

fn tool_cmd(args: &[String]) -> i32 {
    match args.first().map(String::as_str) {
        Some("reconcile") if args.len() == 1 => crate::tool_deployment::run_once(),
        Some("configure") if args.len() == 2 => {
            crate::tool_deployment::secrets::configure(&args[1])
        }
        Some("run-mcp") if args.len() == 2 => crate::tool_deployment::secrets::run_mcp(&args[1]),
        _ => {
            eprintln!("toard-shim: 사용법: toard-shim tool reconcile | tool configure <slug> | tool run-mcp <slug>");
            2
        }
    }
}

fn e2ee_cmd(args: &[String]) -> i32 {
    eprintln!("{LEGACY_E2EE_WARNING}");
    match args.first().map(String::as_str) {
        Some("setup") if args.len() == 1 => crate::e2ee_setup::run(),
        Some("status") if args.len() == 1 => crate::e2ee_setup::status(),
        Some("approve") if args.len() == 1 => crate::e2ee_setup::approve(None),
        Some("approve") if args.len() == 3 && args[1] == "--request" => {
            crate::e2ee_setup::approve(Some(&args[2]))
        }
        _ => {
            eprintln!("toard-shim: 사용법: toard-shim e2ee setup | e2ee status | e2ee approve [--request ID]");
            2
        }
    }
}

// ── collect — 로컬 로그 pull 수집 ──

fn collect_cmd(args: &[String]) -> i32 {
    let mut dry_run = false;
    let mut quiet = false;
    let mut only: Option<String> = None;
    let mut selected_endpoint: Option<String> = None;
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--dry-run" => dry_run = true,
            "--quiet" => quiet = true,
            "--adapter" => match it.next() {
                Some(key) => only = Some(key.clone()),
                None => {
                    eprintln!("toard-shim: --adapter 뒤에 어댑터 이름이 필요합니다");
                    return 2;
                }
            },
            "--target-env" => {
                let endpoint = match installer_env("TOARD_INGEST_ENDPOINT") {
                    Ok(endpoint) => endpoint,
                    Err(_) => {
                        eprintln!("toard-shim: collect --target-env에는 TOARD_INGEST_ENDPOINT가 필요합니다");
                        return 2;
                    }
                };
                selected_endpoint = match crate::targets::normalize_endpoint(&endpoint) {
                    Ok(endpoint) => Some(endpoint),
                    Err(error) => {
                        eprintln!("toard-shim: endpoint가 올바르지 않습니다: {error}");
                        return 2;
                    }
                };
            }
            other => {
                eprintln!("toard-shim: collect 가 모르는 인자: {other}");
                return 2;
            }
        }
    }
    if env::var(crate::local_bridge::BRIDGE_ACTION_ENV)
        .ok()
        .as_deref()
        != Some("1")
    {
        crate::local_bridge::ensure_background_quiet();
    }
    run_pre_collect_maintenance(dry_run, || {
        let _ = crate::device_control::sync_all();
    });
    let report = crate::collect::run_selected_report(
        only.as_deref(),
        selected_endpoint.as_deref(),
        dry_run,
        quiet,
    );
    run_post_collect_maintenance(
        dry_run,
        only.is_none(),
        &report.target_codes,
        |target_codes| {
            let _ = crate::device_control::complete_collects(target_codes);
        },
        || {
            let _ = crate::device_control::sync_all();
        },
        || {
            let _ = crate::tool_deployment::run_once();
        },
        // Desktop/IDE만 사용하는 설치도 daemon의 주기 collect를 통해 최신
        // shim으로 이동해야 한다. wrapper(claude/codex) 실행에만 업데이트
        // 체크를 묶으면 해당 사용자는 새 로컬 bridge 기능을 받을 수 없다.
        crate::update::maybe_spawn_background_check,
    );
    report.code
}

fn run_pre_collect_maintenance(dry_run: bool, sync_device_control: impl FnOnce()) {
    if !dry_run {
        sync_device_control();
    }
}

fn run_post_collect_maintenance(
    dry_run: bool,
    full_collect: bool,
    target_codes: &std::collections::HashMap<String, i32>,
    complete_collects: impl FnOnce(&std::collections::HashMap<String, i32>),
    sync_device_control: impl FnOnce(),
    reconcile_tools: impl FnOnce(),
    check_for_update: impl FnOnce(),
) {
    if dry_run {
        return;
    }
    if full_collect {
        complete_collects(target_codes);
    }
    sync_device_control();
    reconcile_tools();
    check_for_update();
}

// ── claude-env — settings.json env 주입 관리 ──

fn claude_env_cmd(args: &[String]) -> i32 {
    let Some(home) = fsx::home_dir() else {
        eprintln!("toard-shim: HOME 이 없어 settings.json 위치를 알 수 없습니다");
        return 1;
    };
    let settings_path = home.join(".claude").join("settings.json");
    let Some(state_path) = fsx::state_dir().map(|d| d.join("claude-env.json")) else {
        return 1;
    };
    let settings_text = std::fs::read_to_string(&settings_path).unwrap_or_default();
    let prev_state = std::fs::read_to_string(&state_path)
        .map(|t| claude_env::state_from_json(&t))
        .unwrap_or_default();

    match args.first().map(String::as_str) {
        Some("on") => {
            // 사용량은 이제 트랜스크립트 pull 로 수집한다(docs/design-usage-pull) — Desktop·IDE 도
            // 파일만 있으면 재시작·env 주입 없이 수집된다. claude-env(=settings.json OTEL 주입)는
            // experimental OTLP(TOARD_EXPERIMENTAL_OTLP + 서버 collection_method='otel')용으로만 남는다.
            warn("claude-env 는 experimental OTLP 전용으로 강등됐습니다 — 일반 사용량 수집엔 불필요(트랜스크립트 pull 로 자동 수집).");
            let creds = match singleton_credentials_for_legacy_push() {
                Ok(credentials) => credentials,
                Err(error) => {
                    eprintln!("toard-shim: {error}");
                    return 1;
                }
            };
            let Some(token) = creds.token else {
                eprintln!(
                    "toard-shim: 선택된 target의 자격 증명 또는 TOARD_INGEST_TOKEN 설정 후 재시도"
                );
                return 1;
            };
            let endpoint = creds.endpoint.as_deref().unwrap_or(DEFAULT_ENDPOINT);
            match claude_env::plan_on(&settings_text, &prev_state, endpoint, &token) {
                Ok(r) => {
                    // 토큰이 평문으로 들어가므로 settings.json 을 0600 으로 조인다
                    if let Some(text) = &r.settings {
                        if let Err(e) = fsx::write_atomic(&settings_path, text, 0o600) {
                            eprintln!("toard-shim: settings.json 쓰기 실패: {e}");
                            return 1;
                        }
                    }
                    let _ =
                        fsx::write_atomic(&state_path, &claude_env::state_to_json(&r.state), 0o600);
                    for w in &r.warnings {
                        warn(w);
                    }
                    ok(&format!(
                        "claude-env on — {} 개 키 관리 중 ({})",
                        r.state.len(),
                        settings_path.display()
                    ));
                    0
                }
                Err(e) => {
                    eprintln!("toard-shim: {e}");
                    1
                }
            }
        }
        Some("off") => match claude_env::plan_off(&settings_text, &prev_state) {
            Ok(r) => {
                if let Some(text) = &r.settings {
                    if let Err(e) = fsx::write_atomic(&settings_path, text, 0o600) {
                        eprintln!("toard-shim: settings.json 쓰기 실패: {e}");
                        return 1;
                    }
                }
                let _ = std::fs::remove_file(&state_path);
                for w in &r.warnings {
                    warn(w);
                }
                ok("claude-env off — toard 관리 키 제거됨");
                0
            }
            Err(e) => {
                eprintln!("toard-shim: {e}");
                1
            }
        },
        Some("status") | None => {
            if prev_state.is_empty() {
                info("claude-env: off (관리 중인 키 없음)");
                return 0;
            }
            let env = crate::json::parse(&settings_text)
                .ok()
                .and_then(|root| root.get("env").cloned());
            for (key, ours) in &prev_state {
                match env
                    .as_ref()
                    .and_then(|e| e.get(key))
                    .and_then(crate::json::Value::as_str)
                {
                    Some(cur) if cur == ours => ok(&format!("{key} 주입됨")),
                    Some(_) => warn(&format!("{key}: 사용자 변경으로 toard 관리 밖")),
                    None => warn(&format!(
                        "{key}: settings.json 에서 사라짐 — claude-env on 으로 재주입"
                    )),
                }
            }
            0
        }
        Some(other) => {
            eprintln!("toard-shim: claude-env 사용법: on|off|status (받은 값: {other})");
            2
        }
    }
}

fn singleton_credentials_for_legacy_push() -> Result<crate::credentials::Credentials, String> {
    let targets = crate::targets::TargetStore::from_home()
        .and_then(|store| store.load_or_migrate())
        .map_err(|error| format!("target 저장소를 읽을 수 없습니다: {error}"))?;
    match targets.as_slice() {
        [] => Ok(read_credentials()),
        [target] => Ok(target.credentials.clone()),
        _ => Err(
            "이 기능은 target이 정확히 하나일 때만 사용할 수 있습니다 — 멀티 target은 pull 수집을 사용하세요"
                .into(),
        ),
    }
}

fn ok(msg: &str) {
    println!("  ✓ {msg}");
}
fn info(msg: &str) {
    println!("  - {msg}");
}
fn warn(msg: &str) {
    println!("  ! {msg}");
}

struct Doctor {
    failed: bool,
    result_code: Option<&'static str>,
}

impl Doctor {
    fn fail_with(&mut self, result_code: &'static str, msg: &str) {
        println!("  ✗ {msg}");
        if !self.failed {
            self.result_code = Some(result_code);
        }
        self.failed = true;
    }

    fn advisory(&mut self, result_code: &'static str, msg: &str) {
        warn(msg);
        if self.result_code.is_none() {
            self.result_code = Some(result_code);
        }
    }
}

pub(crate) struct DoctorReport {
    pub code: i32,
    pub result_code: Option<String>,
}

fn doctor_cmd(args: &[String]) -> i32 {
    match args {
        [] => doctor(None),
        [flag] if flag == "--target-env" => {
            let endpoint = match installer_env("TOARD_INGEST_ENDPOINT") {
                Ok(endpoint) => endpoint,
                Err(_) => {
                    eprintln!(
                        "toard-shim: doctor --target-env에는 TOARD_INGEST_ENDPOINT가 필요합니다"
                    );
                    return 2;
                }
            };
            match crate::targets::normalize_endpoint(&endpoint) {
                Ok(endpoint) => doctor(Some(&endpoint)),
                Err(error) => {
                    eprintln!("toard-shim: endpoint가 올바르지 않습니다: {error}");
                    2
                }
            }
        }
        _ => {
            eprintln!("toard-shim: 사용법: toard-shim doctor [--target-env]");
            2
        }
    }
}

pub(crate) fn doctor(selected_endpoint: Option<&str>) -> i32 {
    doctor_report(selected_endpoint, false).code
}

pub(crate) fn doctor_headless(selected_endpoint: Option<&str>) -> DoctorReport {
    doctor_report(selected_endpoint, true)
}

fn doctor_report(selected_endpoint: Option<&str>, service_context: bool) -> DoctorReport {
    println!("toard-shim doctor — v{}\n", version());
    let mut d = Doctor {
        failed: false,
        result_code: None,
    };
    let local_bridge_action = env::var(crate::local_bridge::BRIDGE_ACTION_ENV)
        .ok()
        .as_deref()
        == Some("1");

    // 1–2. target별 자격 증명·endpoint·최근 전송 상태. registry가 권위이며,
    // --target-env는 endpoint 선택에만 사용하고 env token은 의도적으로 무시한다.
    let store = crate::targets::TargetStore::from_home();
    let mut targets = match store.and_then(|store| store.load_or_migrate()) {
        Ok(targets) => targets,
        Err(error) => {
            d.fail_with(
                "target_unavailable",
                &format!("target 저장소를 읽을 수 없습니다: {error}"),
            );
            Vec::new()
        }
    };
    if targets.is_empty() && selected_endpoint.is_none() {
        // registry가 아직 없는 env-only 구버전 자동화는 진단 호환만 유지한다.
        let credentials = read_credentials();
        if credentials.token.is_some() {
            let endpoint = credentials.endpoint.as_deref().unwrap_or(DEFAULT_ENDPOINT);
            if let Ok(endpoint) = crate::targets::normalize_endpoint(endpoint) {
                let root = fsx::home_dir()
                    .map(|home| home.join(".toard"))
                    .unwrap_or_default();
                targets.push(crate::targets::Target {
                    id: crate::targets::target_id(&endpoint),
                    revision: String::new(),
                    endpoint,
                    credentials_path: root.join("credentials"),
                    state_dir: root.join("state"),
                    credentials,
                });
            }
        }
    }
    if let Some(endpoint) = selected_endpoint {
        targets.retain(|target| target.endpoint == endpoint);
        if targets.is_empty() {
            d.fail_with(
                "target_unavailable",
                &format!("등록된 target을 찾을 수 없습니다: {endpoint}"),
            );
        }
    } else if targets.is_empty() {
        d.fail_with(
            "target_unavailable",
            "등록된 target이 없습니다 — 서버 설치 스크립트로 연결하세요",
        );
    }

    let strict_target_probe = selected_endpoint.is_some();
    for target in &targets {
        println!("target {} — {}", &target.id[..12], target.endpoint);
        let Some(token) = target.credentials.token.as_deref() else {
            d.fail_with(
                "target_unavailable",
                &format!("자격 증명 없음: {}", target.endpoint),
            );
            continue;
        };
        ok("토큰 로드됨 (target credentials)");
        check_credentials_permissions(&target.credentials_path);
        match probe_ingest(&target.endpoint, token) {
            Ok(200) => ok(&format!("endpoint 연결 + 토큰 유효: {}", target.endpoint)),
            Ok(401) => d.fail_with(
                "token_invalid",
                &format!("토큰이 유효하지 않습니다(만료/폐기): {}", target.endpoint),
            ),
            Ok(404) => d.fail_with(
                "endpoint_not_found",
                &format!(
                    "{}/v1/logs 가 없습니다 — endpoint 값을 확인하세요",
                    target.endpoint
                ),
            ),
            Ok(0) => d.fail_with(
                "endpoint_unreachable",
                &format!("endpoint 연결 실패: {}", target.endpoint),
            ),
            Ok(code) if strict_target_probe => d.fail_with(
                "endpoint_unhealthy",
                &format!("endpoint 연결 확인 실패: {} HTTP {code}", target.endpoint),
            ),
            Ok(code) => warn(&format!(
                "endpoint 응답이 예상 밖입니다: {} HTTP {code}",
                target.endpoint
            )),
            Err(error) if strict_target_probe => d.fail_with(
                "endpoint_unreachable",
                &format!("endpoint 점검 실패: {} — {error}", target.endpoint),
            ),
            Err(error) => warn(&format!(
                "endpoint 점검 생략: {} — {error}",
                target.endpoint
            )),
        }
        match crate::delivery::load(&target.state_dir) {
            Some(status) => {
                info(&format!(
                    "최근 전송: {:?}, 마지막 성공: {}",
                    status.result,
                    status.last_success_at.as_deref().unwrap_or("없음")
                ));
                if status.result != crate::delivery::DeliveryKind::Success {
                    info("미전송분 재시도는 로컬 원본 세션 로그가 남아 있는 동안 가능합니다 — 장애 중 원본 로그를 삭제하면 복구할 수 없습니다");
                }
            }
            None => info("최근 전송 기록 없음"),
        }
        println!();
    }

    // 3. PATH 가로채기 순서 + 진짜 바이너리. 로컬 bridge는 launchd/systemd의
    // 서비스 PATH를 상속하므로 사용자 로그인 셸의 PATH를 판정할 수 없다.
    if local_bridge_action || service_context {
        info("PATH 점검 생략 — 백그라운드 서비스 환경은 사용자 셸 PATH와 다릅니다");
    } else {
        let self_canon = env::current_exe().ok().and_then(|p| p.canonicalize().ok());
        for (tool, path_required) in [("claude", true), ("codex", false)] {
            match first_in_path(tool) {
                Some(first) => {
                    let first_canon = first.canonicalize().ok();
                    let first_is_shim = first_canon.as_deref().is_some_and(|candidate| {
                        self_canon.as_deref().is_some_and(|current| {
                            is_shim_executable_path(candidate, current, cfg!(windows))
                        })
                    });
                    if first_is_shim {
                        ok(&format!("PATH: '{tool}' 은 shim 이 우선 가로챕니다"));
                        match find_real_binary(tool) {
                            Some(real) => ok(&format!("진짜 {tool}: {}", real.display())),
                            None => {
                                info(&format!("진짜 {tool} 없음 (Desktop/IDE 수집만 쓰면 무시)"))
                            }
                        }
                    } else {
                        d.fail_with(
                            "path_misconfigured",
                            &format!(
                                "PATH: shim 보다 '{}' 가 먼저 옵니다 — 수집되지 않습니다. PATH 에서 shim 디렉토리를 앞에 두세요",
                                first.display()
                            ),
                        );
                    }
                }
                None => {
                    if path_required {
                        d.fail_with(
                            "path_misconfigured",
                            "PATH 에 claude 가 없습니다 — shim 디렉토리를 PATH 에 추가하세요",
                        );
                    } else {
                        info("codex: PATH 에 없음 (미사용 시 무시)");
                    }
                }
            }
        }
    }

    // 4. codex config.toml 상태 — OTLP 는 experimental 로 강등(기본은 트랜스크립트 pull 로 수집)
    if let Some(home) = fsx::home_dir() {
        let cfg = home.join(".codex").join("config.toml");
        if let Ok(existing) = std::fs::read_to_string(&cfg) {
            let base = codex::strip_toard_block(&existing);
            let has_toard_block = base != existing;
            if crate::otel::experimental_otlp_enabled() {
                if codex::has_user_otel(&base) {
                    warn("~/.codex/config.toml 에 사용자 [otel] 이 있어 codex 자동 주입이 비활성입니다");
                } else if has_toard_block {
                    ok("codex: config.toml 에 toard [otel] 블록 주입됨 (experimental OTLP)");
                } else {
                    info("codex: 다음 실행 시 [otel] 블록이 주입됩니다 (experimental OTLP)");
                }
            } else if has_toard_block {
                info("codex: config.toml 에 옛 toard [otel] 블록 잔존 — OTLP 강등됨(사용량은 pull 로 수집, 서버가 OTLP 드롭). 정리하려면 수동 제거");
            } else {
                ok("codex: OTLP 주입 안 함 — 사용량은 pull 로 수집 (experimental 은 TOARD_EXPERIMENTAL_OTLP)");
            }
        }
    }

    // 5. Cursor exact-token stop hook. 설치기는 기존 user-global hooks를 병합 보존한다.
    if crate::cursor_hook::installed() {
        ok("Cursor 사용량 hook 등록됨 — 정확 토큰만 최소 저장");
    } else {
        info("Cursor 사용량 hook 미등록 — Cursor를 쓰면 'toard-shim cursor-hook install'");
    }

    // 6. 주기 수집 데몬 + 최근 수집 시각 — 수집이 조용히 멈춘 상태를 드러낸다 (#65)
    let daemon_interval = match crate::daemon::state() {
        crate::daemon::State::Unsupported { os } => {
            info(&format!(
                "주기 수집 자동 등록 미지원({os}) — Claude/Codex CLI 실행 시 수집됩니다"
            ));
            None
        }
        crate::daemon::State::Installed {
            backend,
            interval,
            active: true,
        } => {
            ok(&format!(
                "주기 수집 등록됨 — {backend}, {}",
                interval
                    .map(|i| format!("{i}초 간격"))
                    .unwrap_or_else(|| "간격 미상".into())
            ));
            interval
        }
        crate::daemon::State::Installed {
            backend,
            active: false,
            ..
        } => {
            // 활성 판정은 환경(user bus 부재 등)에 따라 오탐 가능 — ✗ 대신 경고로
            d.advisory(
                "scheduler_inactive",
                &format!(
                    "주기 수집({backend}) 파일은 있으나 비활성으로 보입니다 — toard-shim daemon install 로 재등록"
                ),
            );
            None
        }
        crate::daemon::State::NotInstalled => {
            d.advisory(
                "scheduler_inactive",
                "주기 수집 미등록 — Desktop/IDE 만 쓰는 날은 다음 CLI 실행까지 수집이 지연됩니다 (등록: toard-shim daemon install)",
            );
            None
        }
    };
    match last_collect_age() {
        Some(age) => match daemon_interval {
            Some(i) if age > i.saturating_mul(3) => d.advisory(
                "collection_stale",
                &format!(
                    "마지막 수집 {} 전 — 데몬 간격({i}초)의 3배 초과, ~/.toard/state/daemon.err.log 확인",
                    human_age(age)
                ),
            ),
            _ => ok(&format!("마지막 수집 {} 전", human_age(age))),
        },
        None => info("수집 실행 기록 없음 — 첫 수집 전이거나 트리거 미발동"),
    }
    if local_bridge_action || crate::local_bridge::is_running() {
        ok("UI 로컬 bridge 실행 중 — loopback 전용");
    } else {
        warn("UI 로컬 bridge 미실행 — 다음 주기 수집 또는 'toard-shim local start'로 복구");
    }

    println!();
    let code = if d.failed {
        println!("문제가 발견됐습니다 — 위 ✗ 항목을 해결하세요.");
        1
    } else {
        println!("모든 점검 통과.");
        0
    };
    DoctorReport {
        code,
        result_code: d.result_code.map(str::to_owned),
    }
}

fn check_credentials_permissions(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(path) {
            if meta.permissions().mode() & 0o077 != 0 {
                warn(&format!(
                    "credentials 권한이 넓습니다({:o}) — chmod 600 권장: {}",
                    meta.permissions().mode() & 0o777,
                    path.display()
                ));
            }
        }
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// last-collect 스탬프 나이(초) — 편승·데몬·직접 collect 가 공유하는 스탬프 기준.
fn last_collect_age() -> Option<u64> {
    let stamp = fsx::state_dir()?.join("last-collect");
    let t = std::fs::read_to_string(stamp)
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()?;
    Some(crate::bg::now_unix().saturating_sub(t))
}

fn human_age(secs: u64) -> String {
    if secs < 60 {
        format!("{secs}초")
    } else if secs < 3600 {
        format!("{}분", secs / 60)
    } else {
        format!("{}시간", secs / 3600)
    }
}

/// `POST {endpoint}/v1/logs` 에 빈 OTLP(`{}`)를 보내 연결·인증을 확인한다.
/// 빈 페이로드는 서버에서 레코드 0건으로 즉시 반환되므로 부작용이 없다.
fn probe_ingest(endpoint: &str, token: &str) -> Result<u16, String> {
    if token.contains(['\r', '\n']) {
        return Err("토큰 형식이 올바르지 않습니다".into());
    }
    let url = format!("{}/v1/logs", endpoint.trim_end_matches('/'));
    let null_dev = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let temp_dir = fsx::state_dir()
        .ok_or_else(|| "HOME 이 없어 임시 파일을 만들 수 없습니다".to_string())?
        .join("tmp");
    let auth_path = temp_dir.join(format!("doctor-auth-{}.conf", std::process::id()));
    let body_path = temp_dir.join(format!("doctor-body-{}.json", std::process::id()));
    let escaped = token.replace('\\', "\\\\").replace('"', "\\\"");
    fsx::write_atomic(
        &auth_path,
        &format!("header = \"Authorization: Bearer {escaped}\"\n"),
        0o600,
    )
    .map_err(|error| format!("인증 임시 파일 쓰기 실패: {error}"))?;
    if let Err(error) = fsx::write_atomic(&body_path, "{}", 0o600) {
        let _ = std::fs::remove_file(&auth_path);
        return Err(format!("본문 임시 파일 쓰기 실패: {error}"));
    }
    let out = Command::new("curl")
        .args([
            "-sS",
            "-o",
            null_dev,
            "-w",
            "%{http_code}",
            "--connect-timeout",
            "5",
            "--max-time",
            "5",
            "--config",
            &auth_path.display().to_string(),
            "-X",
            "POST",
            "-H",
            "Content-Type: application/json",
            "--data-binary",
            &format!("@{}", body_path.display()),
            &url,
        ])
        .output();
    let _ = std::fs::remove_file(&auth_path);
    let _ = std::fs::remove_file(&body_path);
    let out = out.map_err(|e| format!("curl 실행 불가: {e}"))?;
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse::<u16>()
        .map_err(|_| {
            format!(
                "응답 해석 실패: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn legacy_e2ee_warning_says_new_connections_do_not_need_it() {
        assert_eq!(
            LEGACY_E2EE_WARNING,
            "toard-shim: legacy E2EE 호환 명령입니다. 신규 연결에는 필요하지 않습니다."
        );
    }

    #[test]
    fn default_help_keeps_e2ee_only_in_the_legacy_section() {
        let usage = usage_text();
        let legacy_section = usage.find("[legacy-e2ee").expect("legacy section");

        assert!(usage[..legacy_section].contains("서버 관리형 암호화"));
        assert!(!usage[..legacy_section].contains("e2ee setup"));
        assert!(usage[legacy_section..].contains("e2ee setup"));
    }

    #[test]
    fn doctor_failure_code_overrides_an_earlier_advisory_without_exposing_output() {
        let mut doctor = Doctor {
            failed: false,
            result_code: None,
        };
        doctor.advisory("scheduler_inactive", "scheduler warning");
        doctor.fail_with("token_invalid", "token failure");

        assert!(doctor.failed);
        assert_eq!(doctor.result_code, Some("token_invalid"));
    }

    #[test]
    fn periodic_collect_runs_update_maintenance_but_dry_run_stays_read_only() {
        let completions = Cell::new(0);
        let control_syncs = Cell::new(0);
        let reconciles = Cell::new(0);
        let update_checks = Cell::new(0);
        let target_codes =
            std::collections::HashMap::from([("https://toard.example/api".to_string(), 0)]);

        run_post_collect_maintenance(
            false,
            true,
            &target_codes,
            |_| completions.set(completions.get() + 1),
            || control_syncs.set(control_syncs.get() + 1),
            || reconciles.set(reconciles.get() + 1),
            || update_checks.set(update_checks.get() + 1),
        );
        run_post_collect_maintenance(
            true,
            true,
            &target_codes,
            |_| completions.set(completions.get() + 1),
            || control_syncs.set(control_syncs.get() + 1),
            || reconciles.set(reconciles.get() + 1),
            || update_checks.set(update_checks.get() + 1),
        );
        run_post_collect_maintenance(
            false,
            false,
            &target_codes,
            |_| completions.set(completions.get() + 1),
            || control_syncs.set(control_syncs.get() + 1),
            || reconciles.set(reconciles.get() + 1),
            || update_checks.set(update_checks.get() + 1),
        );

        assert_eq!(completions.get(), 1);
        assert_eq!(control_syncs.get(), 2);
        assert_eq!(reconciles.get(), 2);
        assert_eq!(update_checks.get(), 2);
    }

    #[test]
    fn device_policy_sync_precedes_collection_and_result_confirmation() {
        let events = std::cell::RefCell::new(Vec::new());
        run_pre_collect_maintenance(false, || events.borrow_mut().push("pre-sync"));
        events.borrow_mut().push("collect");
        let target_codes = std::collections::HashMap::new();
        run_post_collect_maintenance(
            false,
            true,
            &target_codes,
            |_| events.borrow_mut().push("complete"),
            || events.borrow_mut().push("post-sync"),
            || events.borrow_mut().push("tools"),
            || events.borrow_mut().push("update"),
        );
        assert_eq!(
            events.into_inner(),
            [
                "pre-sync",
                "collect",
                "complete",
                "post-sync",
                "tools",
                "update"
            ]
        );
    }
}

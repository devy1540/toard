// `toard-shim` 이름으로 실행됐을 때의 관리 CLI — doctor / version / help.
// 래핑 경로(claude/codex)에는 어떤 오버헤드도 더하지 않는다.

use std::env;
use std::process::Command;

use crate::claude_env;
use crate::codex;
use crate::credentials::{read_credentials, DEFAULT_ENDPOINT};
use crate::fsx;
use crate::resolve::{find_real_binary, first_in_path, is_shim_executable_path};

/// 릴리스 빌드는 CI 가 태그를 주입(TOARD_SHIM_BUILD_VERSION), 개발 빌드는 0.0.0.
pub fn version() -> &'static str {
    option_env!("TOARD_SHIM_BUILD_VERSION").unwrap_or(env!("CARGO_PKG_VERSION"))
}

pub fn run(args: &[String]) -> ! {
    match args.first().map(String::as_str) {
        Some("doctor") => std::process::exit(doctor()),
        Some("claude-env") => std::process::exit(claude_env_cmd(&args[1..])),
        Some("collect") => std::process::exit(collect_cmd(&args[1..])),
        Some("daemon") => std::process::exit(crate::daemon::run(&args[1..])),
        Some("e2ee") => std::process::exit(e2ee_cmd(&args[1..])),
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
    println!(
        "toard-shim {} — toard 수집 shim 관리 CLI

사용법: toard-shim <command>

  doctor                       설치·자격 증명·endpoint·PATH 상태 진단
  claude-env on|off|status     ~/.claude/settings.json env 주입 관리
                               (IDE 등 PATH 를 거치지 않는 실행까지 수집)
  collect [--dry-run]          비-OTEL 도구 로컬 로그 수집 → toard 전송
          [--adapter <key>]    (gemini·qwen — §5.6 pull 경로)
          [--quiet]            무변경 시 무출력 (데몬 주기 실행용 — 전송·오류는 출력)
                               본문 수집은 opt-in(기본 off). e2ee setup 후 로컬 암호화하여
                               /v1/prompts 로 전송. 기존 true 설정은 server_v1 호환 모드
  daemon install|uninstall|status
                               주기 수집 등록·해제·확인 (macOS launchd / Linux systemd·cron)
                               install --interval <초> (기본 300, 하한 60)
                               — Desktop/IDE 처럼 PATH 를 안 거치는 사용도 주기 안에 수집
  e2ee setup                   Recovery Kit를 저장·확인하고 E2EE 본문 수집 활성화
  e2ee status                  로컬 E2EE 모드와 보안 저장소 키 상태 확인
  e2ee approve [--request ID]  브라우저의 6자리 코드를 로컬에서 확인해 승인
  update                       최신 릴리스로 즉시 업데이트
                               (평소엔 2h 주기 백그라운드 자동 — TOARD_SHIM_AUTO_UPDATE=0 으로 끔)
  version                      버전 출력
  help                         이 도움말",
        version()
    );
}

fn e2ee_cmd(args: &[String]) -> i32 {
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
            other => {
                eprintln!("toard-shim: collect 가 모르는 인자: {other}");
                return 2;
            }
        }
    }
    crate::collect::run(only.as_deref(), dry_run, quiet)
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
            let creds = read_credentials();
            let Some(token) = creds.token else {
                eprintln!("toard-shim: 자격 증명이 없습니다 — ~/.toard/credentials 또는 TOARD_INGEST_TOKEN 설정 후 재시도");
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
}

impl Doctor {
    fn fail(&mut self, msg: &str) {
        println!("  ✗ {msg}");
        self.failed = true;
    }
}

fn doctor() -> i32 {
    println!("toard-shim doctor — v{}\n", version());
    let mut d = Doctor { failed: false };

    // 1. 자격 증명
    let creds = read_credentials();
    let cred_path = fsx::home_dir().map(|h| h.join(".toard").join("credentials"));
    match &creds.token {
        Some(_) => {
            ok("토큰 로드됨 (~/.toard/credentials 또는 TOARD_INGEST_TOKEN)");
            // 파일 퍼미션 점검은 Unix 전용 — Windows 는 ACL 모델이라 mode 비트가 무의미
            #[cfg(unix)]
            if let Some(p) = cred_path.as_ref().filter(|p| p.is_file()) {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(meta) = std::fs::metadata(p) {
                    if meta.permissions().mode() & 0o077 != 0 {
                        warn(&format!(
                            "credentials 권한이 넓습니다({:o}) — chmod 600 권장",
                            meta.permissions().mode() & 0o777
                        ));
                    }
                }
            }
            #[cfg(not(unix))]
            let _ = &cred_path;
        }
        None => d.fail("자격 증명 없음 — 수집 비활성(순수 패스스루). ~/.toard/credentials 또는 TOARD_INGEST_TOKEN 설정"),
    }

    // 2. endpoint 연결 + 토큰 유효성 (curl 위임 — shim 은 HTTP 클라이언트를 갖지 않는다)
    let endpoint = creds.endpoint.as_deref().unwrap_or(DEFAULT_ENDPOINT);
    if creds.endpoint.is_none() {
        info(&format!(
            "endpoint 미설정 — 기본값 사용: {DEFAULT_ENDPOINT}"
        ));
    }
    if let Some(token) = &creds.token {
        match probe_ingest(endpoint, token) {
            Ok(200) => ok(&format!("endpoint 연결 + 토큰 유효: {endpoint}")),
            Ok(401) => d.fail("토큰이 유효하지 않습니다(만료/폐기) — 대시보드에서 재발급 필요"),
            Ok(404) => d.fail(&format!(
                "{endpoint}/v1/logs 가 없습니다 — endpoint 값을 확인하세요"
            )),
            Ok(0) => d.fail(&format!("endpoint 연결 실패: {endpoint}")),
            Ok(code) => warn(&format!("endpoint 응답이 예상 밖입니다: HTTP {code}")),
            Err(e) => warn(&format!("endpoint 점검 생략 — {e}")),
        }
    }

    // 3. PATH 가로채기 순서 + 진짜 바이너리
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
                        None => info(&format!("진짜 {tool} 없음 (Desktop/IDE 수집만 쓰면 무시)")),
                    }
                } else {
                    d.fail(&format!(
                        "PATH: shim 보다 '{}' 가 먼저 옵니다 — 수집되지 않습니다. PATH 에서 shim 디렉토리를 앞에 두세요",
                        first.display()
                    ));
                }
            }
            None => {
                if path_required {
                    d.fail("PATH 에 claude 가 없습니다 — shim 디렉토리를 PATH 에 추가하세요");
                } else {
                    info("codex: PATH 에 없음 (미사용 시 무시)");
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

    // 5. 주기 수집 데몬 + 최근 수집 시각 — 수집이 조용히 멈춘 상태를 드러낸다 (#65)
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
            warn(&format!(
                "주기 수집({backend}) 파일은 있으나 비활성으로 보입니다 — toard-shim daemon install 로 재등록"
            ));
            None
        }
        crate::daemon::State::NotInstalled => {
            info("주기 수집 미등록 — Desktop/IDE 만 쓰는 날은 다음 CLI 실행까지 수집이 지연됩니다 (등록: toard-shim daemon install)");
            None
        }
    };
    match last_collect_age() {
        Some(age) => match daemon_interval {
            Some(i) if age > i.saturating_mul(3) => warn(&format!(
                "마지막 수집 {} 전 — 데몬 간격({i}초)의 3배 초과, ~/.toard/state/daemon.err.log 확인",
                human_age(age)
            )),
            _ => ok(&format!("마지막 수집 {} 전", human_age(age))),
        },
        None => info("수집 실행 기록 없음 — 첫 수집 전이거나 트리거 미발동"),
    }

    println!();
    if d.failed {
        println!("문제가 발견됐습니다 — 위 ✗ 항목을 해결하세요.");
        1
    } else {
        println!("모든 점검 통과.");
        0
    }
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
    let url = format!("{}/v1/logs", endpoint.trim_end_matches('/'));
    let null_dev = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let out = Command::new("curl")
        .args([
            "-sS",
            "-o",
            null_dev,
            "-w",
            "%{http_code}",
            "--max-time",
            "5",
            "-X",
            "POST",
            "-H",
            "Content-Type: application/json",
            "-H",
            &format!("Authorization: Bearer {token}"),
            "--data",
            "{}",
            &url,
        ])
        .output()
        .map_err(|e| format!("curl 실행 불가: {e}"))?;
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

// `toard-shim` 이름으로 실행됐을 때의 관리 CLI — doctor / version / help.
// 래핑 경로(claude/codex)에는 어떤 오버헤드도 더하지 않는다.

use std::env;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::Command;

use crate::codex;
use crate::credentials::{read_credentials, DEFAULT_ENDPOINT};
use crate::resolve::{find_real_binary, first_in_path};

/// 릴리스 빌드는 CI 가 태그를 주입(TOARD_SHIM_BUILD_VERSION), 개발 빌드는 0.0.0.
pub fn version() -> &'static str {
    option_env!("TOARD_SHIM_BUILD_VERSION").unwrap_or(env!("CARGO_PKG_VERSION"))
}

pub fn run(args: &[String]) -> ! {
    match args.first().map(String::as_str) {
        Some("doctor") => std::process::exit(doctor()),
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

  doctor    설치·자격 증명·endpoint·PATH 상태 진단
  version   버전 출력
  help      이 도움말",
        version()
    );
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
    let cred_path =
        env::var_os("HOME").map(|h| PathBuf::from(h).join(".toard").join("credentials"));
    match &creds.token {
        Some(_) => {
            ok("토큰 로드됨 (~/.toard/credentials 또는 TOARD_INGEST_TOKEN)");
            if let Some(p) = cred_path.as_ref().filter(|p| p.is_file()) {
                if let Ok(meta) = std::fs::metadata(p) {
                    if meta.permissions().mode() & 0o077 != 0 {
                        warn(&format!(
                            "credentials 권한이 넓습니다({:o}) — chmod 600 권장",
                            meta.permissions().mode() & 0o777
                        ));
                    }
                }
            }
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
    for (tool, required) in [("claude", true), ("codex", false)] {
        match first_in_path(tool) {
            Some(first) => {
                let first_canon = first.canonicalize().ok();
                if first_canon.is_some() && first_canon == self_canon {
                    ok(&format!("PATH: '{tool}' 은 shim 이 우선 가로챕니다"));
                    match find_real_binary(tool) {
                        Some(real) => ok(&format!("진짜 {tool}: {}", real.display())),
                        None => {
                            if required {
                                d.fail(&format!(
                                    "진짜 {tool} 를 PATH 에서 찾지 못했습니다 — {tool} 설치 필요"
                                ));
                            } else {
                                info(&format!("진짜 {tool} 없음 (미사용 시 무시)"));
                            }
                        }
                    }
                } else {
                    d.fail(&format!(
                        "PATH: shim 보다 '{}' 가 먼저 옵니다 — 수집되지 않습니다. PATH 에서 shim 디렉토리를 앞에 두세요",
                        first.display()
                    ));
                }
            }
            None => {
                if required {
                    d.fail("PATH 에 claude 가 없습니다 — shim 디렉토리를 PATH 에 추가하세요");
                } else {
                    info("codex: PATH 에 없음 (미사용 시 무시)");
                }
            }
        }
    }

    // 4. codex config.toml 상태
    if let Some(home) = env::var_os("HOME") {
        let cfg = PathBuf::from(home).join(".codex").join("config.toml");
        if let Ok(existing) = std::fs::read_to_string(&cfg) {
            let base = codex::strip_toard_block(&existing);
            if codex::has_user_otel(&base) {
                warn(
                    "~/.codex/config.toml 에 사용자 [otel] 이 있어 codex 자동 주입이 비활성입니다",
                );
            } else if base != existing {
                ok("codex: config.toml 에 toard [otel] 블록 주입됨");
            } else {
                info("codex: 다음 실행 시 [otel] 블록이 주입됩니다");
            }
        }
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

/// `POST {endpoint}/v1/logs` 에 빈 OTLP(`{}`)를 보내 연결·인증을 확인한다.
/// 빈 페이로드는 서버에서 레코드 0건으로 즉시 반환되므로 부작용이 없다.
fn probe_ingest(endpoint: &str, token: &str) -> Result<u16, String> {
    let url = format!("{}/v1/logs", endpoint.trim_end_matches('/'));
    let out = Command::new("curl")
        .args([
            "-sS",
            "-o",
            "/dev/null",
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

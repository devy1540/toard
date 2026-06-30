// toard shim (Rust).
// `claude`/`codex` 이름으로 설치되어, OTEL 텔레메트리 env 를 주입한 뒤
// PATH 에서 찾은 "진짜" 도구 바이너리(자기 자신 제외)를 exec 한다.
// OTEL SDK 없음 — env 주입 + resolver + exec 뿐인 얇은 래퍼 (설계 ADR-001/006).

use std::env;
use std::ffi::OsString;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;

/// argv[0] basename → 래핑 대상 도구 이름 (claude/codex). 기본 claude.
fn tool_name() -> String {
    env::args()
        .next()
        .map(PathBuf::from)
        .and_then(|p| p.file_name().map(|s| s.to_string_lossy().into_owned()))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "claude".to_string())
}

/// PATH 순회로 진짜 도구 바이너리를 찾는다. 자기 자신(shim)은 건너뛴다.
fn find_real_binary(name: &str) -> Option<PathBuf> {
    let self_exe = env::current_exe().ok().and_then(|p| p.canonicalize().ok());
    let path = env::var_os("PATH")?;
    for dir in env::split_paths(&path) {
        let cand = dir.join(name);
        if !cand.is_file() {
            continue;
        }
        // shim 자신 제외 (PATH 에 shim 이 앞서 있으므로)
        if let (Some(se), Ok(cc)) = (self_exe.as_ref(), cand.canonicalize()) {
            if &cc == se {
                continue;
            }
        }
        return Some(cand);
    }
    None
}

/// 자격 증명 로딩: env 우선, 없으면 ~/.toard/credentials (KEY=VALUE).
fn read_credentials() -> (Option<String>, String) {
    let mut token = env::var("TOARD_INGEST_TOKEN").ok();
    let mut endpoint = env::var("TOARD_INGEST_ENDPOINT").ok();

    if let Some(home) = env::var_os("HOME") {
        let cred = PathBuf::from(home).join(".toard").join("credentials");
        if let Ok(content) = std::fs::read_to_string(&cred) {
            for line in content.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                if let Some((k, v)) = line.split_once('=') {
                    match k.trim() {
                        "agent_key" if token.is_none() => token = Some(v.trim().to_string()),
                        "endpoint" if endpoint.is_none() => endpoint = Some(v.trim().to_string()),
                        _ => {}
                    }
                }
            }
        }
    }

    (token, endpoint.unwrap_or_else(|| "http://localhost:3000/api".to_string()))
}

fn set_if_empty(key: &str, value: &str) {
    if env::var_os(key).is_none() {
        env::set_var(key, value);
    }
}

fn main() {
    let tool = tool_name();
    let (token, endpoint) = read_credentials();

    // Claude Code 네이티브 텔레메트리 (logs only, http/json — ADR-001)
    set_if_empty("CLAUDE_CODE_ENABLE_TELEMETRY", "1");
    set_if_empty("OTEL_LOGS_EXPORTER", "otlp");
    set_if_empty("OTEL_METRICS_EXPORTER", "none");
    set_if_empty("OTEL_EXPORTER_OTLP_PROTOCOL", "http/json");
    set_if_empty("OTEL_EXPORTER_OTLP_ENDPOINT", &endpoint);
    if let Some(t) = token {
        set_if_empty("OTEL_EXPORTER_OTLP_HEADERS", &format!("Authorization=Bearer {t}"));
    }
    set_if_empty("OTEL_RESOURCE_ATTRIBUTES", &format!("toard.shim=rust,toard.tool={tool}"));

    let real = match find_real_binary(&tool) {
        Some(p) => p,
        None => {
            eprintln!("toard-shim: '{tool}' 실제 바이너리를 PATH 에서 찾지 못했습니다");
            std::process::exit(127);
        }
    };

    // 인자 그대로 전달하며 프로세스 대체 (exec 성공 시 반환 없음)
    let args: Vec<OsString> = env::args_os().skip(1).collect();
    let err = Command::new(&real).args(&args).exec();
    eprintln!("toard-shim: exec 실패 ({}): {err}", real.display());
    std::process::exit(1);
}

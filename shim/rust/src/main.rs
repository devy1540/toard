// toard shim (Rust).
// `claude`/`codex` 이름으로 설치되어 텔레메트리 설정을 주입한 뒤
// PATH 에서 찾은 "진짜" 도구 바이너리(자기 자신 제외)를 exec 한다.
//   - claude: OTEL env 주입 (Claude Code 는 env 기반)
//   - codex : ~/.codex/config.toml 의 [otel] 주입 (Codex 는 config.toml 기반)
// OTEL SDK 없음 — 설정 주입 + resolver + exec 뿐인 얇은 래퍼 (설계 ADR-001/006).

use std::env;
use std::ffi::OsString;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;

fn tool_name() -> String {
    env::args()
        .next()
        .map(PathBuf::from)
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
        let Ok(cc) = cand.canonicalize() else { continue };
        if self_canon.as_ref() == Some(&cc) {
            continue;
        }
        return Some(cand);
    }
    None
}

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

/// Codex(config.toml 기반)용 OTEL 설정 주입. toard 마커 블록을 멱등 관리.
/// 사용자가 직접 만든 [otel] 이 있으면 충돌을 피해 건너뛴다.
fn inject_codex_config(endpoint: &str, token: Option<&str>) {
    let Some(home) = env::var_os("HOME") else { return };
    let dir = PathBuf::from(home).join(".codex");
    let path = dir.join("config.toml");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();

    const BEGIN: &str = "# >>> toard otel >>>";
    const END: &str = "# <<< toard otel <<<";

    // 기존 toard 블록 제거(멱등)
    let base = match (existing.find(BEGIN), existing.find(END)) {
        (Some(b), Some(e)) if e >= b => {
            let mut s = existing[..b].to_string();
            s.push_str(&existing[e + END.len()..]);
            s
        }
        _ => existing,
    };

    // toard 가 관리하지 않는 사용자 [otel] 이 있으면 충돌 위험 → 건너뜀
    if base.contains("[otel]") {
        eprintln!("toard: ~/.codex/config.toml 에 이미 [otel] 이 있어 자동 주입을 건너뜁니다(수동 설정 필요).");
        return;
    }

    let full = format!("{}/v1/logs", endpoint.trim_end_matches('/'));
    let mut block = format!(
        "{BEGIN}\n[otel]\nlog_user_prompt = false\n\n[otel.exporter.otlp-http]\nendpoint = \"{full}\"\nprotocol = \"json\"\n"
    );
    if let Some(t) = token {
        block.push_str(&format!("headers = {{ \"Authorization\" = \"Bearer {t}\" }}\n"));
    }
    block.push_str(END);
    block.push('\n');

    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    let sep = if base.is_empty() || base.ends_with('\n') { "" } else { "\n" };
    let _ = std::fs::write(&path, format!("{base}{sep}{block}"));
    // 토큰이 평문으로 들어가므로 소유자만 읽도록 제한
    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
}

fn main() {
    let tool = tool_name();
    let (token, endpoint) = read_credentials();

    // 공통 OTEL env (Claude Code 는 이걸로 동작; Codex 는 config.toml 우선이나 보조로 둠)
    set_if_empty("CLAUDE_CODE_ENABLE_TELEMETRY", "1");
    set_if_empty("OTEL_LOGS_EXPORTER", "otlp");
    set_if_empty("OTEL_METRICS_EXPORTER", "none");
    set_if_empty("OTEL_EXPORTER_OTLP_PROTOCOL", "http/json");
    set_if_empty("OTEL_EXPORTER_OTLP_ENDPOINT", &endpoint);
    if let Some(t) = &token {
        set_if_empty("OTEL_EXPORTER_OTLP_HEADERS", &format!("Authorization=Bearer {t}"));
    }
    set_if_empty("OTEL_RESOURCE_ATTRIBUTES", &format!("toard.shim=rust,toard.tool={tool}"));

    // Codex 는 config.toml 기반 → 파일 주입
    if tool == "codex" {
        set_if_empty("OTEL_SERVICE_NAME", "codex");
        inject_codex_config(&endpoint, token.as_deref());
    }

    let real = match find_real_binary(&tool) {
        Some(p) => p,
        None => {
            eprintln!("toard-shim: '{tool}' 실제 바이너리를 PATH 에서 찾지 못했습니다");
            std::process::exit(127);
        }
    };

    let args: Vec<OsString> = env::args_os().skip(1).collect();
    let err = Command::new(&real).args(&args).exec();
    eprintln!("toard-shim: exec 실패 ({}): {err}", real.display());
    std::process::exit(1);
}

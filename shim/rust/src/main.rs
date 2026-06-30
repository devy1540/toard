// toard shim (Rust PoC).
// claude/codex 를 래핑해 OTEL 텔레메트리 env 주입 후 실제 바이너리를 exec.
// OTEL SDK 없음 — env 주입 + exec 뿐인 얇은 래퍼 (설계 ADR-001/006).
//
// 사용: shim <command> [args...]
//   TOARD_INGEST_ENDPOINT (기본 http://localhost:3000/api), TOARD_INGEST_TOKEN 로 설정.

use std::env;
use std::os::unix::process::CommandExt;
use std::process::Command;

fn set_if_empty(key: &str, value: &str) {
    if env::var_os(key).is_none() {
        env::set_var(key, value);
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: shim <command> [args...]");
        std::process::exit(2);
    }

    let endpoint =
        env::var("TOARD_INGEST_ENDPOINT").unwrap_or_else(|_| "http://localhost:3000/api".to_string());
    let token = env::var("TOARD_INGEST_TOKEN").ok();

    // Claude Code 네이티브 텔레메트리 활성화 (logs only, http/json — ADR-001)
    set_if_empty("CLAUDE_CODE_ENABLE_TELEMETRY", "1");
    set_if_empty("OTEL_LOGS_EXPORTER", "otlp");
    set_if_empty("OTEL_METRICS_EXPORTER", "none");
    set_if_empty("OTEL_EXPORTER_OTLP_PROTOCOL", "http/json");
    set_if_empty("OTEL_EXPORTER_OTLP_ENDPOINT", &endpoint);
    if let Some(t) = token {
        set_if_empty("OTEL_EXPORTER_OTLP_HEADERS", &format!("Authorization=Bearer {t}"));
    }
    set_if_empty("OTEL_RESOURCE_ATTRIBUTES", "toard.shim=rust");

    // 프로세스 대체 (exec 성공 시 반환하지 않음)
    let err = Command::new(&args[1]).args(&args[2..]).exec();
    eprintln!("shim: exec failed: {err}");
    std::process::exit(1);
}

// toard shim (Go PoC).
// claude/codex 같은 도구를 래핑해 OTEL 텔레메트리 env 를 주입한 뒤 실제 바이너리를 exec 한다.
// OTEL SDK 의존성 없음 — 환경변수 주입 + exec 뿐인 얇은 래퍼 (설계 ADR-001/006).
//
// 사용: shim <command> [args...]
//   TOARD_INGEST_ENDPOINT (기본 http://localhost:3000/api), TOARD_INGEST_TOKEN 로 설정.
package main

import (
	"os"
	"os/exec"
	"syscall"
)

func setIfEmpty(key, value string) {
	if os.Getenv(key) == "" {
		_ = os.Setenv(key, value)
	}
}

func main() {
	if len(os.Args) < 2 {
		os.Stderr.WriteString("usage: shim <command> [args...]\n")
		os.Exit(2)
	}

	endpoint := os.Getenv("TOARD_INGEST_ENDPOINT")
	if endpoint == "" {
		endpoint = "http://localhost:3000/api"
	}
	token := os.Getenv("TOARD_INGEST_TOKEN")

	// Claude Code 네이티브 텔레메트리 활성화 (logs only, http/json — ADR-001)
	setIfEmpty("CLAUDE_CODE_ENABLE_TELEMETRY", "1")
	setIfEmpty("OTEL_LOGS_EXPORTER", "otlp")
	setIfEmpty("OTEL_METRICS_EXPORTER", "none")
	setIfEmpty("OTEL_EXPORTER_OTLP_PROTOCOL", "http/json")
	setIfEmpty("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint)
	if token != "" {
		setIfEmpty("OTEL_EXPORTER_OTLP_HEADERS", "Authorization=Bearer "+token)
	}
	setIfEmpty("OTEL_RESOURCE_ATTRIBUTES", "toard.shim=go")

	bin, err := exec.LookPath(os.Args[1])
	if err != nil {
		os.Stderr.WriteString("shim: command not found: " + os.Args[1] + "\n")
		os.Exit(127)
	}

	// 프로세스 대체 (PTY 불필요)
	if err := syscall.Exec(bin, os.Args[1:], os.Environ()); err != nil {
		os.Stderr.WriteString("shim: exec failed: " + err.Error() + "\n")
		os.Exit(1)
	}
}

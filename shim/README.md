# toard shim

`claude`/`codex` 를 래핑해 OTEL 텔레메트리를 toard 로 보내는 얇은 래퍼 (설계 ADR-001/006). **언어: Rust.**

## 동작
1. `~/.toard/bin/claude`(또는 `codex`) 로 설치되고 PATH 에서 우선한다.
2. 실행 시 OTEL env 주입 — `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_LOGS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`(ingest token).
   - 사용자 env 는 존중: 이미 설정된 키는 덮지 않고, `OTEL_EXPORTER_OTLP_HEADERS`/`OTEL_RESOURCE_ATTRIBUTES` 는 **병합**(사용자 Authorization 존재 시 미주입 + 경고).
   - **토큰이 없으면 주입 없이 순수 패스스루** — 죽은 endpoint 로의 전송을 만들지 않는다.
3. PATH 에서 진짜 `claude` 를 찾아(자기 자신 제외) `exec` — 프로세스 대체(PTY 불필요). exec 는 PID 를 보존하므로 `TOARD_SHIM_GUARD_PID` 로 재귀 exec(자기 자신/사본 핑퐁)을 차단한다.
4. `codex` 는 `~/.codex/config.toml` 에 `[otel]` 마커 블록을 멱등 주입 — 내용 동일 시 무변경, 쓰기는 temp+rename(원자적), 사용자 `[otel]` 존재 시 건너뛰고 stale toard 블록은 제거.

진단 메시지는 TTY 에서만 stderr 로 출력한다(`TOARD_SHIM_DEBUG=1` 로 강제).

## 관리 CLI (`toard-shim`)
같은 바이너리가 `toard-shim` 이름으로도 설치되어 관리 커맨드를 받는다:
```sh
toard-shim doctor    # 자격 증명·endpoint 연결·토큰 유효성·PATH 순서·codex config 상태 진단
toard-shim version   # 배포 버전 (릴리스 CI 가 태그를 임베드)
```
`doctor` 의 endpoint 점검은 `POST <endpoint>/v1/logs` 에 빈 OTLP(`{}`)를 보내 연결·인증만 확인한다(레코드 0건 — 부작용 없음, curl 사용).

## 설치
```sh
curl -fsSL https://github.com/devy1540/toard/releases/latest/download/install.sh | sh
```
OS/arch(darwin·linux × x64·arm64) 를 자동 감지해 해당 바이너리를 `~/.toard/bin/{claude,codex,toard-shim}` 에 설치한다(다운로드 후 `SHA256SUMS` 대조). 릴리즈는 `v*` 태그 push 시 GitHub Actions 가 OS 네이티브 매트릭스(macOS 러너에서 arm64 native + x64 cross, Ubuntu x64·arm64 native)로 4-플랫폼을 빌드해 GitHub Release(+npm) 에 업로드한다.

## 설정
`~/.toard/credentials` (또는 동명 env `TOARD_INGEST_TOKEN`/`TOARD_INGEST_ENDPOINT`):
```
agent_key=<ingest_token>
endpoint=https://toard.example.com/api
```

## 빌드
```sh
cargo build --manifest-path shim/rust/Cargo.toml --release
# → shim/rust/target/release/shim  (release profile: opt-level z + LTO + strip ≈ 312KB)
```
4-플랫폼 빌드는 GitHub Actions OS 네이티브 매트릭스(macOS arm 러너에서 x64 는 동일 SDK 로 cross). 배포는 `install.sh`(curl) 또는 `npx @toard/shim`.

## 언어 선택 근거 (ADR-006)
PoC 로 Go·Rust 둘 다 측정: 바이너리 **Go 1.4MB vs Rust 312KB(4.4배)**, cold start Rust 우위. Go PoC 는 비교 자료로 git 히스토리(커밋 `5c01d18`)에 보존.

## 대역 테스트
`fake-claude.sh` 는 실제 Claude Code 없이 shim → 수집 흐름을 검증하는 대역 도구(주입된 OTEL env 로 OTLP/JSON 전송).

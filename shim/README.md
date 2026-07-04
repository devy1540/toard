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
toard-shim doctor                    # 자격 증명·endpoint 연결·토큰 유효성·PATH 순서·codex config 상태 진단
toard-shim claude-env on|off|status  # ~/.claude/settings.json env 주입 관리
toard-shim collect [--dry-run]       # 비-OTEL 도구 로컬 로그 수집 → /api/v1/events 전송
toard-shim version                   # 배포 버전 (릴리스 CI 가 태그를 임베드)
```
`doctor` 의 endpoint 점검은 `POST <endpoint>/v1/logs` 에 빈 OTLP(`{}`)를 보내 연결·인증만 확인한다(레코드 0건 — 부작용 없음, curl 사용).

`claude-env` 는 shim 의 커버리지 갭(PATH 를 거치지 않는 IDE 확장·절대경로·alias 실행)을 메운다 — Claude Code 가 직접 읽는 settings.json 의 `env` 에 동일 OTEL 키를 병합 주입한다. 우리가 넣은 값은 `~/.toard/state/claude-env.json` 에 기록되며, 사용자가 직접 설정했거나 이후 변경한 키는 덮지도 지우지도 않는다(경고만). 토큰이 평문으로 들어가므로 settings.json 은 0600 으로 조정된다.

## 로컬 로그 pull 수집 (§5.6 — 2차)
비-OTEL 도구(gemini·qwen …)의 로컬 로그를 어댑터로 파싱해 `UsageEvent[]` 로 정규화하고 `POST /api/v1/events` 로 보낸다. 파서는 ccusage(MIT) Rust 어댑터에서 이식(`shim/NOTICE` attribution 참조).
- **커서**: 로그가 append 가 아니라 세션 파일 제자리 갱신이라, 파일별 stamp(mtime+size) 를 `~/.toard/state/cursors/` 에 기록하고 변한 파일만 재파싱. 재파싱 중복은 dedup_key 멱등 저장이 흡수.
- **신뢰경계**: shim 은 토큰 카운트까지만(costUsd=0, userId=null) — user/cost 는 서버 권위(§10.1).
- **실행 모델**: 데몬 없음. `claude`/`codex` wrap 실행에 편승해 10분 스로틀(double-spawn 분리)로 백그라운드 수집. `TOARD_SHIM_COLLECT=0` 끄기, `TOARD_SHIM_COLLECT_INTERVAL`(초) 조절, `toard-shim collect` 즉시 실행.

## 본문 수집 (opt-in — 기본 off)
`TOARD_SHIM_COLLECT_CONTENT=1` 이면 gemini/qwen 로그의 **프롬프트/응답 텍스트**도 함께 수집해 `POST /api/v1/prompts` 로 보낸다. usage 경로(`/v1/events`)와 **커서(`{adapter}-content`)·엔드포인트가 완전 분리**되며, usage 수집 동작에는 영향이 없다.
- **신뢰경계**: shim 은 본문을 **평문 TLS** 로 보내되 키를 쥐지 않는다 — **봉투 암호화(at-rest)·소유자 전용(RLS)은 서버 몫**. shim 의 "본문 안 읽음" 기본값을 여는 스위치라 명시적 opt-in.
- **서버측 게이트**: 서버에 본문 수집 KEK 가 없으면 `/v1/prompts` 가 503 → shim 은 실패로 보지 않고 조용히 건너뛴다.
- **전송 안전(https 강제)**: 본문은 `https://`(또는 로컬 `localhost`/`127.0.0.1`) endpoint 로만 보낸다. 원격 `http://` 면 평문 노출 위험이라 **본문 수집을 건너뛴다**(경고 출력). 토큰 카운트 usage 경로는 이 제약과 무관.
- **범위 주의**: 텍스트 필드는 `text`/`content` 를 시도한다. qwen 등 실로그의 본문 키가 다르면 빈 결과(안전)가 되므로, 프로덕션 활성화 전 실로그 검증이 필요하다.

## 자동 업데이트 (ADR-006)
wrap 실행 경로에는 네트워크가 없다 — 24h 스로틀 파일(`~/.toard/state/last-update-check`)만 확인하고, 주기가 지났으면 업데이터를 double-spawn 으로 백그라운드 분리(좀비 없음)한 뒤 즉시 exec 한다. 업데이터는 releases/latest 의 302 Location 에서 태그를 읽고, 새 버전이면 다운로드 → `SHA256SUMS` 검증 → rename(원자적 교체). 개발 빌드(0.0.0)는 대상 제외.
- 즉시 실행: `toard-shim update`
- 끄기: `TOARD_SHIM_AUTO_UPDATE=0`
- 미러/에어갭: `TOARD_SHIM_RELEASE_BASE=<host>` (기본 `https://github.com`)

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

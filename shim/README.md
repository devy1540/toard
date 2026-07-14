# toard shim

`claude`/`codex` 를 래핑하고, 로컬 세션 파일에서 **사용량·본문을 pull 수집**해 toard 로 보내는 얇은 래퍼 (설계 ADR-001/006 · docs/design-usage-pull). **언어: Rust.** OTLP push 는 experimental 로 강등(`TOARD_EXPERIMENTAL_OTLP`).

## 동작
1. `~/.toard/bin/claude`(또는 `codex`) 로 설치되고 PATH 에서 우선한다.
2. wrap 실행에 편승해 **로컬 세션 파일 pull 수집**을 백그라운드로 킥한다(사용량 → `/api/v1/events`, 본문 opt-in → `/api/v1/prompts`). 사용량이 파일에 이미 있으므로 **재시작·env 주입이 불필요**하고, Desktop·IDE·CLI 구분 없이 파일만 있으면 수집되며, 발생 기기 host 가 자동으로 붙는다.
3. PATH 에서 진짜 `claude` 를 찾아(자기 자신 제외) `exec` — 프로세스 대체(PTY 불필요). exec 는 PID 를 보존하므로 `TOARD_SHIM_GUARD_PID` 로 재귀 exec(자기 자신/사본 핑퐁)을 차단한다.
4. **experimental OTLP**(`TOARD_EXPERIMENTAL_OTLP=1` 일 때만): 옛 push 경로. claude 는 OTEL env 주입(`CLAUDE_CODE_ENABLE_TELEMETRY=1`·`OTEL_*`), codex 는 `~/.codex/config.toml` `[otel]` 멱등 주입. 서버 provider `collection_method` 도 `otel` 이어야 실제로 수집된다(대칭 게이트 §5.2). 켜지 않으면 env/config 주입 없이 순수 패스스루.
   - 사용자 env 존중·병합 규칙은 종전과 동일(이미 설정된 키는 덮지 않고, `OTEL_EXPORTER_OTLP_HEADERS`/`OTEL_RESOURCE_ATTRIBUTES` 는 병합, 사용자 Authorization 존재 시 미주입+경고).

진단 메시지는 TTY 에서만 stderr 로 출력한다(`TOARD_SHIM_DEBUG=1` 로 강제).

## 관리 CLI (`toard-shim`)
같은 바이너리가 `toard-shim` 이름으로도 설치되어 관리 커맨드를 받는다:
```sh
toard-shim doctor                    # 자격 증명·endpoint 연결·토큰 유효성·PATH 순서·codex config·주기 수집 상태 진단
toard-shim claude-env on|off|status  # settings.json OTEL 주입 관리 (experimental OTLP 전용 — 강등)
toard-shim collect [--dry-run]       # 로컬 세션 파일 수집(claude·codex·gemini·qwen) → /api/v1/events
toard-shim daemon install|uninstall|status  # 주기 수집 등록·해제·확인 (macOS launchd / Linux systemd·cron)
toard-shim version                   # 배포 버전 (릴리스 CI 가 태그를 임베드)
```
`doctor` 의 endpoint 점검은 `POST <endpoint>/v1/logs` 에 빈 OTLP(`{}`)를 보내 연결·인증만 확인한다(레코드 0건 — 부작용 없음, curl 사용).

**(experimental OTLP 전용 — 강등)** `claude-env` 는 OTLP push 커버리지 갭(PATH 를 거치지 않는 IDE 확장·절대경로·alias 실행)을 메우던 장치로, Claude Code 가 직접 읽는 settings.json 의 `env` 에 OTEL 키를 병합 주입한다. 사용량이 이제 pull(트랜스크립트)로 수집되므로 **일반 사용엔 불필요**하고, `TOARD_EXPERIMENTAL_OTLP` + 서버 `collection_method='otel'` 로 push 를 되켤 때만 의미가 있다(`on` 실행 시 강등 경고 출력). 우리가 넣은 값은 `~/.toard/state/claude-env.json` 에 기록되며, 사용자가 직접 설정했거나 이후 변경한 키는 덮지도 지우지도 않는다(경고만). 토큰이 평문으로 들어가므로 settings.json 은 0600 으로 조정된다.

## 로컬 세션 파일 pull 수집 (사용량 기본 경로)
claude·codex·gemini·qwen **전 도구**의 로컬 세션 파일을 어댑터로 파싱해 `UsageEvent[]` 로 정규화하고 `POST /api/v1/events` 로 보낸다. 파서는 ccusage(MIT) Rust 어댑터에서 이식(`shim/NOTICE` attribution 참조).
- **소스·매핑**: claude=`~/.claude/projects/**/*.jsonl`(`assistant.message.usage`, Desktop 사용분 포함, `input_tokens` 는 캐시 제외), codex=`~/.codex/sessions/**/*.jsonl`(`token_count.info.last_token_usage`, 모델은 `turn_context.model`, `input−cached`, `total_token_usage` 변화 기준 중복 방출 dedup), gemini·qwen=각 CLI 로그.
- **커서**: 로그가 append 가 아니라 세션 파일 제자리 갱신이라, 파일별 stamp(mtime+size) 를 `~/.toard/state/cursors/` 에 기록하고 변한 파일만 재파싱. **전송 필터**: 파일별 전송 진행(sent 개수 + dedup_key prefix 해시)을 커서에 함께 기록해, 재파싱해도 이전에 보낸 prefix 가 그대로면 **신규분만 전송**한다 — 활성 세션 파일이 주기마다 변해도 전체 재전송하지 않음. 판정이 어긋나면(파일 재작성 등) 전체 전송으로 폴백하고 서버 dedup_key 멱등 저장이 흡수.
- **백필**: usage 커서가 없으면 전 파일 스캔 → 과거 사용량 전량 백필(토큰 카운트라 민감정보 아님, 히스토리 가치↑). 이후엔 커서로 변한 파일만.
- **신뢰경계**: shim 은 토큰 카운트까지만(costUsd=0, userId=null) — user/cost 는 서버 권위(§10.1).
- **실행 모델**: 트리거 3중 — ① **주기 수집(권장, #65)**: `toard-shim daemon install` 이 OS 스케줄러에 단발 `collect` 를 등록(macOS launchd LaunchAgent / Linux systemd user timer, 폴백 crontab). 기본 300초, `--interval <초>`(하한 60) 조절. Desktop/IDE 처럼 PATH 를 안 거치는 사용도 주기 간격 안에 수집. 상주 프로세스 아님 — 스케줄러가 매번 단발 실행을 깨움. 제거는 `daemon uninstall`, 상태는 `daemon status`/`doctor`. ② `claude`/`codex` wrap 실행 편승(10분 스로틀, double-spawn 분리 — `TOARD_SHIM_COLLECT=0` 끄기, `TOARD_SHIM_COLLECT_INTERVAL`(초) 조절). ③ `toard-shim collect` 즉시 실행. 세 트리거는 `~/.toard/state/last-collect` 스탬프를 공유해 서로 중복 실행하지 않는다(겹쳐도 dedup 멱등이 흡수). 데몬 등록물은 `collect --quiet` 로 실행돼 **무변경 회차는 로그를 남기지 않고**(전송·오류만 출력), 데몬 로그(`~/.toard/state/daemon*.log`)는 **1년 주기로 `.1` 한 세대 로테이션**된다.

## 컴퓨터별 구분 (host — 기본 on)
같은 계정을 여러 컴퓨터에서 써도 사용량을 **컴퓨터별로 구분**해 볼 수 있게, shim 이 발생 기기의 라벨(호스트명)을 함께 보낸다. **기본(pull) 경로는 `UsageEvent.host` 로 claude·codex·gemini·qwen 전부 자동 부착** — env 주입이 없어 host 누락 지점이 사라졌다. experimental OTLP push 는 OTEL resource attribute `toard.host`. 표시는 **본인 화면 한정**(내 사용량 · 설정 › 내 기기).
- **기본값**: 자동으로 `hostname` 을 `trim`+소문자화해 전송(대소문자·공백 차이로 버킷이 갈리지 않게).
- `TOARD_DISABLE_HOST=1`: 기기명 전송 끄기 → 서버에서 "(알 수 없음)" 으로 집계.
- `TOARD_HOST_LABEL=<별칭>`: 호스트명 대신 지정한 별칭 전송(대소문자 존중). 사내 기기명이 실명/직책을 담는 경우 대비.
- **Codex 주의(experimental OTLP 한정)**: Codex 는 `config.toml` 우선이라 push 시 env resource attribute 존중 여부가 버전마다 달라 host 가 "(알 수 없음)"이 될 수 있다. **기본 pull 경로는 host 자동 부착이라 무관**.

## 본문 수집 (E2EE opt-in — 기본 off)
설정 화면에서 E2EE 본문 수집을 선택하면 installer는 먼저 `collect_content=off`, `e2ee_setup_requested=true`만 기록한다. 아래 로컬 설정을 완료해야 `collect_content=e2ee_v1`로 원자 전환되고 **claude·codex·gemini·qwen** 로컬 세션 파일의 프롬프트/응답을 로컬 암호화해 `POST /api/v1/prompts`로 보낸다.

```bash
toard-shim e2ee setup
toard-shim e2ee status
toard-shim e2ee approve
```

`TOARD_SHIM_COLLECT_CONTENT=1`과 `collect_content=true`는 서버가 복호화할 수 있는 기존 `server_v1` 운영 호환 경로로만 보존한다. 새 설치에는 `e2ee_v1`을 사용한다. usage 경로(`/v1/events`)와 커서(`{adapter}` vs `{adapter}-content`)는 완전히 분리되어 서로 영향을 주지 않는다.

- **본문·사용량 모두 pull 로 일원화(설계 확정)**: OTLP 로는 응답을 얻을 수 없어(Codex 는 응답 이벤트 자체가 없고 — 실측·소스 확정) 본문은 전 도구가 로컬 세션 파일에서 pull 하고, 사용량도 같은 파일에서 pull 한다(claude/codex 트랜스크립트, docs/design-usage-pull). usage·content 는 **커서(`{adapter}` vs `{adapter}-content`)·엔드포인트가 완전 분리**돼 서로 영향이 없다.
  - claude: `~/.claude/projects/**/*.jsonl` (Desktop 사용분 포함). codex: `~/.codex/sessions/**/*.jsonl`(CODEX_HOME 존중). 각 도구가 프롬프트+응답을 전문으로 남긴다.
- **백필 컷오프 `collect_content_since`** (credentials 또는 env `TOARD_SHIM_COLLECT_CONTENT_SINCE`): 이 시점 이후 턴만 수집.
  - **미설정(기본) = "지금부터"** — 최초 활성화 시각을 `~/.toard/state/content-since` 에 기록해, 켜는 순간 과거 대화가 통째로 전송되지 않는다.
  - `collect_content_since=2026-06-01`(그 날짜부터) · `collect_content_since=all`(전량 백필). 진행 중 세션이 append 돼도 옛 턴은 컷오프로 제외된다.
- **설치 기본값**: E2EE 선택 시에도 setup 완료 전에는 본문 수집이 off다. `TOARD_SHIM_COLLECT_CONTENT=0`으로 언제든 강제 해제할 수 있다.
- **신뢰경계**: shim은 UCK를 OS keyring에서 읽어 레코드별 DEK와 본문을 로컬 암호화한다. 서버 방향 payload에는 평문이 없다.
- **서버측 게이트**: 활성 content owner와 키 버전이 일치하는 암호문만 저장한다. `TOARD_CONTENT_KEK_B64`는 E2EE 경로에서 읽지 않는다.
- **전송 안전(https 강제)**: 암호문과 인증 토큰은 `https://`(또는 로컬 `localhost`/`127.0.0.1`) endpoint로만 보낸다. 원격 `http://`에서는 본문 수집을 건너뛴다.
- **fail-closed**: UCK, owner metadata, OS keyring 중 하나라도 없으면 전송과 content cursor 갱신을 모두 중단한다.
- **범위 주의**: 텍스트 필드는 `text`/`content` 를 시도한다. qwen 등 실로그의 본문 키가 다르면 빈 결과(안전)가 되므로, 프로덕션 활성화 전 실로그 검증이 필요하다.

## 자동 업데이트 (ADR-006)
wrap 실행 경로에는 네트워크가 없다 — 2h 스로틀 파일(`~/.toard/state/last-update-check`)만 확인하고, 주기가 지났으면 업데이터를 double-spawn 으로 백그라운드 분리(좀비 없음)한 뒤 즉시 exec 한다. 업데이터는 releases/latest 의 302 Location 에서 태그를 읽고, 새 버전이면 다운로드 → `SHA256SUMS` 검증 → rename(원자적 교체). 개발 빌드(0.0.0)는 대상 제외.
- 즉시 실행: `toard-shim update`
- 끄기: `TOARD_SHIM_AUTO_UPDATE=0`
- 미러/에어갭: `TOARD_SHIM_RELEASE_BASE=<host>` (기본 `https://github.com`)

## 설치
가장 쉬운 방법은 toard의 **설정 → 컴퓨터 연결**에서 OS별 명령을 복사하는 것이다. macOS·Linux 직접 설치:

```sh
curl -fsSL https://github.com/devy1540/toard/releases/latest/download/install.sh | sh
```

Windows x64는 toard 서버가 제공하는 PowerShell 설치기를 사용한다:

```powershell
$env:TOARD_INGEST_TOKEN='<내 토큰>'; irm 'https://toard.example.com/install.ps1' | iex
```

macOS·Linux는 OS/arch를 자동 감지해 `~/.toard/bin/{claude,codex,toard-shim}`에 설치한다. Windows 설치기는 GitHub Release의 `toard-shim-x86_64-pc-windows-msvc.exe`를 내려받아 같은 릴리스의 `SHA256SUMS`와 대조한 뒤 `%USERPROFILE%\.toard\bin`에 사본을 설치한다. 릴리스 워크플로는 macOS·Linux arm64/x64와 Windows x64의 5개 바이너리를 게시한다. Windows 주기 수집 데몬은 아직 지원하지 않는다.

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
5-플랫폼 빌드는 GitHub Actions OS 네이티브 매트릭스로 수행한다. 배포는 macOS·Linux의 `install.sh`와 Windows의 toard 서버 `/install.ps1`을 기본 경로로 사용한다.

## 언어 선택 근거 (ADR-006)
PoC 로 Go·Rust 둘 다 측정: 바이너리 **Go 1.4MB vs Rust 312KB(4.4배)**, cold start Rust 우위. Go PoC 는 비교 자료로 git 히스토리(커밋 `5c01d18`)에 보존.

## 대역 테스트
`fake-claude.sh` 는 실제 Claude Code 없이 shim → 수집 흐름을 검증하는 대역 도구(주입된 OTEL env 로 OTLP/JSON 전송 — experimental OTLP 경로 검증용).

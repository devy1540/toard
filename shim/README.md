# toard shim

`claude`/`codex` 를 래핑하고, 로컬 세션 파일에서 **사용량·본문을 한 번 pull 수집한 뒤 등록된 임의 개수의 toard 서버로 독립 전송**하는 얇은 래퍼 (설계 ADR-001/006 · docs/design-usage-pull). **언어: Rust.** OTLP push 는 experimental 로 강등(`TOARD_EXPERIMENTAL_OTLP`).

## 동작
1. `~/.toard/bin/claude`(또는 `codex`) 로 설치되고 PATH 에서 우선한다.
2. wrap 실행에 편승해 **로컬 세션 파일 pull 수집**을 백그라운드로 킥한다(사용량 → `/api/v1/events`, 본문 opt-in → `/api/v1/prompts`). 파일은 한 번 파싱하고 각 target의 독립 커서 이후분을 각각 전송한다. 한 서버가 실패해도 다른 서버는 계속 전송하며, 실패한 서버만 다음 회차에 미전송분을 재시도한다.
3. PATH 에서 진짜 `claude` 를 찾아(자기 자신 제외) `exec` — 프로세스 대체(PTY 불필요). exec 는 PID 를 보존하므로 `TOARD_SHIM_GUARD_PID` 로 재귀 exec(자기 자신/사본 핑퐁)을 차단한다.
4. **experimental OTLP**(`TOARD_EXPERIMENTAL_OTLP=1` 일 때만): 옛 push 경로. claude 는 OTEL env 주입(`CLAUDE_CODE_ENABLE_TELEMETRY=1`·`OTEL_*`), codex 는 `~/.codex/config.toml` `[otel]` 멱등 주입. 서버 provider `collection_method` 도 `otel` 이어야 실제로 수집된다(대칭 게이트 §5.2). 켜지 않으면 env/config 주입 없이 순수 패스스루.
   - 사용자 env 존중·병합 규칙은 종전과 동일(이미 설정된 키는 덮지 않고, `OTEL_EXPORTER_OTLP_HEADERS`/`OTEL_RESOURCE_ATTRIBUTES` 는 병합, 사용자 Authorization 존재 시 미주입+경고).

진단 메시지는 TTY 에서만 stderr 로 출력한다(`TOARD_SHIM_DEBUG=1` 로 강제).

## 관리 CLI (`toard-shim`)
같은 바이너리가 `toard-shim` 이름으로도 설치되어 관리 커맨드를 받는다:
```sh
toard-shim targets list              # 등록 target·정책·최근 전송 상태 출력(토큰 제외)
toard-shim doctor                    # 모든 target의 연결·토큰과 공용 PATH·주기 수집 상태 진단
toard-shim doctor --target-env       # TOARD_INGEST_ENDPOINT와 일치하는 한 target만 진단(설치기용)
toard-shim target upsert             # installer env의 endpoint·token·정책 추가/갱신(고급·설치기용)
toard-shim target remove --machine   # installer env의 endpoint 제거 결과 출력(고급·제거기용)
toard-shim claude-env on|off|status  # settings.json OTEL 주입 관리 (experimental OTLP 전용 — 강등)
toard-shim collect [--dry-run]       # 로컬 사용량 수집(claude·codex·cursor·gemini·qwen) → /api/v1/events
toard-shim cursor-hook install|status|uninstall # Cursor 정확 토큰 stop hook 관리
toard-shim daemon install|uninstall|status  # 주기 수집 등록·해제·확인 (macOS launchd / Linux systemd·cron / Windows 작업 스케줄러)
toard-shim local start|stop|status   # 설정 UI용 loopback bridge 관리
toard-shim version                   # 배포 버전 (릴리스 CI 가 태그를 임베드)
```
`doctor` 의 endpoint 점검은 `POST <endpoint>/v1/logs` 에 빈 OTLP(`{}`)를 보내 연결·인증만 확인한다(레코드 0건 — 부작용 없음, curl 사용).

### 설정 UI 로컬 제어 bridge

최신 shim은 `127.0.0.1:38473`에만 작은 HTTP bridge를 열어 **설정 → 컴퓨터 연결** 화면에서 이 컴퓨터의 상태 확인, 즉시 수집, 진단, 업데이트를 실행할 수 있게 한다. `daemon install`은 bridge를 macOS launchd 또는 Linux systemd의 별도 사용자 서비스로 등록하고, Windows는 로그인 트리거, cron 폴백은 `@reboot`로 복구한다. 주기 `collect`도 꺼진 bridge를 안전망으로 다시 시작한다. `daemon uninstall`은 수집 스케줄과 bridge 등록을 함께 제거하고 프로세스를 종료한다.

- 브라우저 `Origin`이 설치 때 기록한 실제 UI origin과 정확히 일치하고 전체 target ID도 맞을 때만 응답한다. 경로가 다른 same-origin target이나 UI/ingest URL이 분리된 프록시에서도 현재 서버 target만 선택한다.
- 상태 연결 때 발급한 10분짜리 메모리 세션을 작업 요청의 `Authorization: Bearer`로 요구한다. 세션은 origin과 target ID에 함께 묶이고 재시작하면 사라진다.
- Safari처럼 HTTPS 페이지의 HTTP loopback fetch를 막는 브라우저는 사용자 클릭으로 작은 loopback helper 창을 연다. helper는 저장된 UI origin의 `postMessage`만 받고 target에 묶인 30초짜리 일회 capability로 동일-origin 요청을 실행한 뒤 결과만 원래 설정 UI에 돌려주고 닫힌다.
- ingest token, credentials, endpoint, 명령 출력, 원문 로그는 응답하지 않는다. 내부 종료 요청은 `~/.toard/state/local-bridge-secret`의 별도 0600 secret으로 인증한다.
- 직접 연결에는 CORS와 Private Network Access 응답 헤더를 제공한다. helper HTML은 외부 subresource·frame을 막는 CSP를 사용하며 구버전 shim에서만 기존 수동 명령 UI를 유지한다.

### target 저장 구조와 구버전 이전

서버별 자격증명과 전송 상태의 기준 저장소는 `~/.toard/targets/<sha256(endpoint)>/`다. 그 아래 `credentials`와 `state/`(usage/content/tool 커서·전송 상태)가 있으므로 회사와 개인 서버가 서로의 진행 위치를 덮어쓰지 않는다. `~/.toard/state/`에는 `last-collect` 같은 shim 전체 스케줄 상태만 둔다.

실패한 target의 미전송분은 로컬 원본 세션 로그가 남아 있는 동안 다음 수집에서 재구성한다. 별도 durable outbox는 없으므로 장기 장애 중 원본 로그를 삭제하면 그 target의 누락분은 복구할 수 없다. 실패 상태의 `toard-shim doctor`에도 이 한계를 표시한다.

기존 단일 서버 설치의 `~/.toard/credentials`와 서버별 상태는 신버전 설치 또는 첫 CLI 실행 때 해당 endpoint target으로 자동 이동하고 원본은 `~/.toard/legacy-backup/`에 보관한다. 이후 legacy 경로를 live mirror로 유지하지 않는다. 같은 endpoint의 설치 명령을 다시 실행하면 token·수집 정책만 갱신하고 그 target의 커서는 보존한다.

**(experimental OTLP 전용 — 강등)** `claude-env` 는 OTLP push 커버리지 갭(PATH 를 거치지 않는 IDE 확장·절대경로·alias 실행)을 메우던 장치로, Claude Code 가 직접 읽는 settings.json 의 `env` 에 OTEL 키를 병합 주입한다. 사용량이 이제 pull(트랜스크립트)로 수집되므로 **일반 사용엔 불필요**하고, `TOARD_EXPERIMENTAL_OTLP` + 서버 `collection_method='otel'` 로 push 를 되켤 때만 의미가 있다(`on` 실행 시 강등 경고 출력). 우리가 넣은 값은 `~/.toard/state/claude-env.json` 에 기록되며, 사용자가 직접 설정했거나 이후 변경한 키는 덮지도 지우지도 않는다(경고만). 토큰이 평문으로 들어가므로 settings.json 은 0600 으로 조정된다.

## 로컬 세션 파일 pull 수집 (사용량 기본 경로)
claude·codex·gemini·qwen의 로컬 세션 파일과 Cursor의 최소 stop hook 로그를 어댑터로 파싱해 `UsageEvent[]` 로 정규화하고 `POST /api/v1/events` 로 보낸다. 파서는 ccusage(MIT) Rust 어댑터에서 이식(`shim/NOTICE` attribution 참조).
- **소스·매핑**: claude=`~/.claude/projects/**/*.jsonl`(`assistant.message.usage`, Desktop 사용분 포함, `input_tokens` 는 캐시 제외), codex=`~/.codex/sessions/**/*.jsonl`(`token_count.info.last_token_usage`, 모델은 `turn_context.model`, `input−cached`, `total_token_usage` 변화 기준 중복 방출 dedup), cursor=`~/.toard/cursor/usage.jsonl`(stop hook의 정확 input/output/cache 토큰), gemini·qwen=각 CLI 로그.
- **Codex fork/subagent 재생 방어**: Codex가 새 rollout 앞에 부모 history를 복사하는 경우, subagent의 첫 `inter_agent_communication_metadata` 또는 vscode fork에서 현재 session UUIDv7 이상인 첫 `task_started.turn_id`를 구조적 경계로 사용한다. 경계 전 `token_count`는 신규 사용량에서 제외한다. 일반 root 세션의 inter-agent 메시지는 제외 대상이 아니다.
- **기존 재생 오염 1회 보정**: 업그레이드된 shim은 Codex usage cursor의 `reconciliation_version`을 보고 로그 전체를 한 번 다시 읽는다. 과거 parser와 동일한 session/model/token 승계로 재생분의 `dedup_key`만 재현해 인증된 `/api/v1/events/reconcile`로 최대 1,000개씩 보낸다. 정상 구간에서도 발견된 키는 절대 철회하지 않는다. 서버는 인증 토큰의 사용자 + `provider=codex` + `log_adapter=codex` 범위의 정확 키만 삭제하고 PostgreSQL daily mart 또는 ClickHouse dirty rollup/outbox를 함께 갱신한다. 직접 DB 삭제나 시간 기반 추정은 하지 않는다. 404/405 서버는 기존 usage 수집을 유지하고 24시간 뒤 다시 확인한다.
- **커서**: 로그가 append 가 아니라 세션 파일 제자리 갱신이라, target별 파일 stamp(mtime+size)를 `~/.toard/targets/<id>/state/cursors/`에 기록한다. 파일은 수집 회차당 한 번 파싱하고, 각 target은 자체 전송 진행(sent 개수 + dedup_key prefix 해시)을 기준으로 **자신에게 필요한 신규분만 전송**한다. 판정이 어긋나면(파일 재작성 등) 해당 target은 전체 전송으로 폴백하고 서버 dedup_key 멱등 저장이 흡수한다.
- **백필**: claude·codex·gemini·qwen은 usage 커서가 없으면 전 파일 스캔 → 과거 사용량 전량 백필(토큰 카운트라 민감정보 아님, 히스토리 가치↑). 이후엔 커서로 변한 파일만. Cursor 사용량은 hook 설치 이후부터다.
- **신뢰경계**: shim 은 토큰 카운트까지만(costUsd=0, userId=null) — user/cost 는 서버 권위(§10.1).
- **실행 모델**: 트리거 3중 — ① **주기 수집(권장, #65)**: `toard-shim daemon install` 이 OS 스케줄러에 단발 `collect` 를 등록(macOS launchd LaunchAgent / Linux systemd user timer·crontab / Windows 작업 스케줄러). 기본 300초, `--interval <초>`(하한 60) 조절. Desktop/IDE 처럼 PATH 를 안 거치는 사용도 주기 간격 안에 수집. **수집기는 상주 프로세스가 아니며** 스케줄러가 매번 단발 실행을 깨운다. 설정 UI용 loopback bridge만 재부팅 후에도 복구되는 별도 최소 사용자 서비스로 실행된다. 제거는 `daemon uninstall`, 상태는 `daemon status`/`doctor`. ② `claude`/`codex` wrap 실행 편승(10분 스로틀, double-spawn 분리 — `TOARD_SHIM_COLLECT=0` 끄기, `TOARD_SHIM_COLLECT_INTERVAL`(초) 조절). ③ `toard-shim collect` 즉시 실행. 세 트리거는 공용 `~/.toard/state/last-collect` 스탬프를 공유하고 전송 진행은 target별로 관리한다. 데몬 등록물은 `collect --quiet` 로 실행돼 **무변경 회차는 로그를 남기지 않고**(전송·오류만 출력), 데몬 로그(`~/.toard/state/daemon*.log`)는 **1년 주기로 `.1` 한 세대 로테이션**된다.
- **Cursor**: 설치기가 기존 `~/.cursor/hooks.json`을 보존하면서 user-global `stop` hook 하나를 병합한다. Cursor가 전달한 정확한 input/output/cache 토큰만 `~/.toard/cursor/usage.jsonl`에 기록하며 이메일·workspace 경로·transcript 경로·대화 본문은 버린다. 설치 이전 사용량은 소급 수집하지 않는다. `~/.cursor/projects/**/agent-transcripts/**/*.{jsonl,txt}`는 사용량을 추정하거나 중복 집계하지 않고 본문(opt-in)과 MCP·Skill 활동만 읽는다. 중간에 잘린 JSONL은 해당 줄만 건너뛰며, 결과 블록이 없는 도구 호출은 `unknown`으로 기록한다.

## 컴퓨터별 구분 (host — 기본 on)
같은 계정을 여러 컴퓨터에서 써도 사용량을 **컴퓨터별로 구분**해 볼 수 있게, shim 이 발생 기기의 라벨(호스트명)을 함께 보낸다. **기본 수집 경로는 `UsageEvent.host` 로 claude·codex·cursor·gemini·qwen 전부 자동 부착** — env 주입이 없어 host 누락 지점이 사라졌다. experimental OTLP push 는 OTEL resource attribute `toard.host`. 표시는 **본인 화면 한정**(내 사용량 · 설정 › 내 기기).
- **기본값**: 자동으로 `hostname` 을 `trim`+소문자화해 전송(대소문자·공백 차이로 버킷이 갈리지 않게).
- `TOARD_DISABLE_HOST=1`: 기기명 전송 끄기 → 서버에서 "(알 수 없음)" 으로 집계.
- `TOARD_HOST_LABEL=<별칭>`: 호스트명 대신 지정한 별칭 전송(대소문자 존중). 사내 기기명이 실명/직책을 담는 경우 대비.
- **Codex 주의(experimental OTLP 한정)**: Codex 는 `config.toml` 우선이라 push 시 env resource attribute 존중 여부가 버전마다 달라 host 가 "(알 수 없음)"이 될 수 있다. **기본 pull 경로는 host 자동 부착이라 무관**.

## 본문 수집 (서버 관리형 암호화 opt-in — 기본 off)
설정 화면에서 본문 수집을 선택하면 installer는 `collect_content=true`를 기록한다. **claude·codex·cursor·gemini·qwen** 로컬 세션 파일의 프롬프트/응답을 HTTPS(또는 localhost)로 `POST /api/v1/prompts`에 보내며, 서버는 저장 전에 `managed_v1`으로 암호화한다. Recovery Kit나 기기 승인은 필요하지 않다.

`TOARD_SHIM_COLLECT_CONTENT=1|true|on|yes|server_v1|managed_v1`은 모두 서버 관리형 모드다. usage 경로(`/v1/events`)와 커서(`{adapter}` vs `{adapter}-content`)는 완전히 분리되어 서로 영향을 주지 않는다.

### legacy-e2ee — 기존 사용자 호환

이미 `collect_content=e2ee_v1`을 사용하는 설치는 로컬 암호화와 기존 키를 그대로 유지한다. 마이그레이션이 끝날 때까지 아래 명령을 보존하지만, 실행 시 신규 연결에는 필요하지 않은 legacy 호환 명령이라는 경고가 먼저 표시된다.

이 기존 E2EE 관리 CLI는 등록 target이 정확히 하나일 때만 동작한다. 여러 target 환경에서는 잘못된 서버의 키 상태를 변경하지 않도록 명시적으로 중단한다.

```bash
toard-shim e2ee setup
toard-shim e2ee status
toard-shim e2ee approve
```

- **본문은 로컬 세션 파일 pull(설계 확정)**: OTLP 로는 응답을 얻을 수 없어(Codex 는 응답 이벤트 자체가 없고 — 실측·소스 확정) 본문은 전 도구가 로컬 세션 파일에서 pull 한다. 사용량은 claude/codex 트랜스크립트와 Cursor 최소 stop hook 등 각 어댑터의 정확 소스를 쓴다. usage·content 는 **커서(`{adapter}` vs `{adapter}-content`)·엔드포인트가 완전 분리**돼 서로 영향이 없다.
  - claude: `~/.claude/projects/**/*.jsonl` (Desktop 사용분 포함). codex: `~/.codex/sessions/**/*.jsonl`(CODEX_HOME 존중). cursor: `~/.cursor/projects/**/agent-transcripts/**/*.{jsonl,txt}`(`CURSOR_AGENT_HOME` override 지원). 각 도구가 남긴 프롬프트+응답 텍스트만 추출한다.
- **백필 컷오프 `collect_content_since`** (credentials 또는 env `TOARD_SHIM_COLLECT_CONTENT_SINCE`): 이 시점 이후 턴만 수집.
  - **미설정(기본) = "지금부터"** — target 활성화 시각을 `~/.toard/targets/<id>/state/content-since`에 기록해, 켜는 순간 과거 대화가 통째로 전송되지 않는다.
  - `collect_content_since=2026-06-01`(그 날짜부터) · `collect_content_since=all`(전량 백필). 진행 중 세션이 append 돼도 옛 턴은 컷오프로 제외된다.
- **설치 기본값**: 본문 수집은 opt-in이다. `TOARD_SHIM_COLLECT_CONTENT=0`으로 언제든 강제 해제할 수 있다.
- **신뢰경계**: 신규 서버 관리형 모드는 shim에서 서버까지 TLS로 보호하고 서버가 저장 전에 암호화한다. 기존 `e2ee_v1`만 UCK를 OS keyring에서 읽어 로컬 암호화를 유지한다.
- **전송 안전(https 강제)**: 본문과 인증 토큰은 `https://`(또는 로컬 `localhost`/`127.0.0.1`) endpoint로만 보낸다. 원격 `http://`에서는 본문 수집을 건너뛴다.
- **fail-closed**: 서버 관리형 저장 실패 시 서버가 503을 반환하고 content cursor를 갱신하지 않는다. 기존 `e2ee_v1`은 UCK, owner metadata, OS keyring 중 하나라도 없으면 전송과 cursor 갱신을 모두 중단한다.
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

macOS·Linux는 OS/arch를 자동 감지해 `~/.toard/bin/{claude,codex,toard-shim}`에 설치한다. Windows 설치기는 GitHub Release의 `toard-shim-x86_64-pc-windows-msvc.exe`를 내려받아 같은 릴리스의 `SHA256SUMS`와 대조한 뒤 `%USERPROFILE%\.toard\bin`에 사본을 설치한다. 릴리스 워크플로는 macOS·Linux arm64/x64와 Windows x64의 5개 바이너리를 게시한다. Windows는 작업 스케줄러에 주기 수집을 등록한다.

## 설정·제거

각 toard 서버의 **설정 → 컴퓨터 연결**에서 제공하는 설치 명령을 실행한다. 명령에 포함된 endpoint가 새 값이면 `~/.toard/targets/`에 추가하고, 이미 있으면 해당 target의 token·정책만 갱신한다. 여러 서버를 설치해도 shim 바이너리와 주기 수집 등록은 하나만 사용한다.

같은 화면의 제거 명령은 그 서버 target만 삭제한다. 다른 target이 남으면 shim·daemon·PATH를 유지하고, 실제 마지막 target을 제거할 때만 공용 설치물을 정리한다. 등록되지 않은 서버의 제거 명령은 아무 파일도 바꾸지 않는다. 기존 Claude/Codex 실행 파일과 원본 세션 로그는 모든 경우에 유지된다.

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

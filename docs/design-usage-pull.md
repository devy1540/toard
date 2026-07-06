# 설계: Claude Code·Codex 사용량 수집을 OTLP push → 트랜스크립트 pull 로 전환

상태: 제안(Proposed) · 2026-07-06
관련: [design-host-breakdown](./design-host-breakdown.md) · ADR-001(수집) · §5.6(로컬 로그 pull)

## 1. 배경 / 문제

현재 Claude Code·Codex **사용량**은 OTLP push(`/api/v1/logs`)로, gemini·qwen 은 로컬 로그 pull(`/api/v1/events`)로 수집한다. OTLP 경로는 운영에서 **구조적으로 취약**함이 실측으로 드러났다:

- **env 기반 · 재시작 필요**: 텔레메트리는 `CLAUDE_CODE_ENABLE_TELEMETRY`/`OTEL_*` env 로만 켜지고, 이 env 는 프로세스 시작 시 1회만 읽힌다(공식 문서: *"read at startup … no hot reload"*). 이미 떠 있는 Claude Code(특히 Desktop)는 **재시작 전엔 절대 수집 안 됨**.
- **Desktop/IDE 는 shim 미경유**: PATH shim 이 env 를 주입하지만 Desktop·IDE 는 shim 을 안 거쳐 `claude-env`(settings.json 주입)라는 별도 보완 장치가 필요하고, 그마저 host 라벨 누락·토큰 stale 등으로 계속 새는 지점이 생겼다.
- **host 주입 이중 관리**: wrap 경로와 claude-env 경로가 각각 `toard.host` 를 주입해야 해서, 한쪽만 고쳐도 Desktop 사용량이 "(알 수 없음)" 으로 샜다.
- **Codex 토큰 stale·config.toml 우선순위** 등 도구별 env 존중 편차.

반면 **로컬 세션 파일에는 사용량이 이미 전부 들어있다**(아래 §3). ccusage·day1co 모두 이 파일을 읽는 방식이다. 트랜스크립트 pull 로 옮기면 env·재시작·host 주입 dance 가 통째로 사라진다.

## 2. 목표 / 비목표

**목표**
- Claude Code·Codex 사용량을 **로컬 세션 파일 pull** 로 수집(gemini·qwen 과 동일 파이프라인, ccusage 방식).
- Desktop·IDE·CLI 구분 없이 **파일만 있으면 수집**(재시작·env 불필요).
- host(컴퓨터별 구분)를 pull 경로로 **자동 획득** → "(알 수 없음)" 문제 근본 해소.
- **과거 사용량 백필** 가능(파일에 남아있으므로).
- OTLP 경로는 **실험 기능(experimental)으로 강등**하되 코드·서버는 보존(opt-in).

**비목표**
- gemini·qwen 수집 방식 변경(그대로).
- 본문(프롬프트/응답) 수집 변경(그대로 `/v1/prompts` pull).
- day1co 처럼 Claude 를 **hook** 으로 거는 것(§10 대안에서 검토 — 이번엔 poll 유지).
- OTLP 코드 삭제(강등만).

## 3. 실측 근거 (2026-07-06 직접 확인)

### 3.1 Claude Code 트랜스크립트 — `~/.claude/projects/**/*.jsonl`
`type=="assistant"` 라인에 요청별 사용량 완비:
```
message.usage = { input_tokens, output_tokens,
                  cache_creation_input_tokens, cache_read_input_tokens,
                  cache_creation:{ ephemeral_5m_input_tokens, ephemeral_1h_input_tokens } }
message.model, message.id, requestId, sessionId, timestamp(ISO), isSidechain, entrypoint(cli|claude-desktop)
```
- `input_tokens` 는 **이미 캐시 제외**(cache_read/creation 별도) → toard `UsageEvent` 불변식과 일치, 이중계상 없음.
- `message.id`+`requestId` 로 dedup(ccusage 방식). `entrypoint` 로 CLI/Desktop 구분 가능. **Desktop 사용분도 이 파일에 그대로 기록됨**(실측).

### 3.2 Codex 세션 — `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
`event_msg` 의 `token_count` payload:
```
payload.info.last_token_usage = { input_tokens, cached_input_tokens,
                                  output_tokens, reasoning_output_tokens, total_tokens }   # 턴별 델타
payload.info.total_token_usage = { … }   # 누적(사용 안 함)
```
- **`last_token_usage`(델타)만** 합산. `total_token_usage`(누적)를 쓰면 과대계상.
- `total = input + output` 이고 `reasoning_output ⊂ output`(실측: out 84, reasoning 75, total=in+out) → **reasoning 을 따로 더하지 않음**.
- `cached_input_tokens` = 캐시 읽기. **캐시 생성 개념 없음** → `cacheCreationTokens=0`.
- 모델명은 이 이벤트에 없음 → **`turn_context.payload.model`** 에서 취득(§8.2 — session_meta 아님). `requestId` 없음 → session+ts dedup. 일부 버전은 같은 턴 `token_count` 를 중복 방출하므로 `total_token_usage` 변화 기준으로 재방출을 스킵(§8.2).

### 3.3 참고 구현
- **ccusage**(Rust): `~/.claude/projects/**/*.jsonl` 만 읽음(도구별 어댑터). dedup = `hash(message.id, requestId)` + 사이드체인 리플레이 처리. 비용 = LiteLLM(빌드 임베드+런타임 갱신)→models.dev, 200k tier, 캐시생성 5m@cache_create·1h@input×2, 캐시읽기, fast 배수. 모드 기본 `auto`(costUSD 있으면 사용). 일별=로컬 tz.
- **day1co-ai-usage-dashboard**: OTLP·ClickHouse **없음**. per-머신 zero-dep 스크립트가 **Claude=hook+트랜스크립트 증분파싱**, **Codex=`~/.codex/sessions` 5분 폴러(ccusage 방식)** → `POST /api/ingest/sessions` → Postgres(raw→정규화→일별 mart). 비용=LiteLLM(관리자 승인). 신원=토큰인증으로 덮어씀. **host 구분 없음**(toard 가 앞섬).

→ 두 참고 구현 모두 "로컬 파일에서 토큰을 읽어 서버로 POST" 이며, toard 는 이미 그 파이프라인(gemini/qwen)을 갖고 있다.

## 4. 설계

### 4.1 개요
`shim/rust/src/collect/` 의 **claude.rs·codex.rs 를 usage 도 방출하도록 확장**한다. `LogAdapter` trait 은 usage(`parse_file`→`/v1/events`)와 content(`parse_content`→`/v1/prompts`)를 **독립 루프·독립 커서**로 이미 지원하며 gemini 가 둘 다 한다. 즉 claude/codex 는 `collects_usage()→true` + `parse_file()` 구현만 추가하면 나머지(run 루프·커서·dedup·wire·POST·서버 `/v1/events`·비용·host·저장)는 **그대로 재사용**된다(§7).

### 4.2 필드 매핑 (핵심)

`RawUsage { ts_ms, session_id, model, message_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens }`

| RawUsage | Claude (`assistant.message.usage`) | Codex (`token_count.info.last_token_usage`) |
|---|---|---|
| `input_tokens` | `input_tokens` (캐시 **제외**) | **`input_tokens − cached_input_tokens`** ⚠ |
| `output_tokens` | `output_tokens` | `output_tokens` (reasoning ⊂ output → 따로 안 더함) |
| `cache_read_tokens` | `cache_read_input_tokens` | `cached_input_tokens` |
| `cache_creation_tokens` | `cache_creation_input_tokens` (또는 `ephemeral_5m+1h`) | `0` (Codex 캐시 생성 개념 없음) |
| `model` | `message.model` | **`turn_context.payload.model`** ⚠(session_meta 아님 — §8.2) |
| `message_id` | `message.id` | `None` |
| `session_id` | `sessionId` | `session_meta.payload.session_id` |
| `ts_ms` | `timestamp`(ISO→epoch) | `token_count` 이벤트 `timestamp` |

**수집 규칙**
- `usage` 없거나 토큰 전부 0 인 라인은 스킵.
- Claude: **`isSidechain` 은 스킵하지 않는다**(ccusage 방식). 실측(§8 검증)에서 서브에이전트 턴은 `isSidechain==true` + **고유 `message.id`** 로 실제 토큰을 쓴다 — 스킵하면 서브에이전트 사용량이 통째로 누락된다. 리플레이 중복은 `message.id` dedup 이 흡수하므로 스킵 불필요.
- **Codex 캐시 주의**: Codex `input_tokens` 는 `cached_input_tokens` 를 **포함**한다(실측: `total=input+output`, `cached ⊂ input`). toard 불변식은 `inputTokens` = 캐시 제외이므로 **`inputTokens = input_tokens − cached_input_tokens`** 로 빼서 매핑해야 캐시분이 input·cache_read 로 이중 가격되지 않는다(Claude 는 애초에 제외라 그대로). day1co 도 OpenAI cached/reasoning 을 subset 으로 처리.
- Codex: 모델은 **`turn_context.payload.model`**(§8.2 정정 — session_meta 엔 `model_provider` 만 있고 모델명 없음), session_id 는 `session_meta.payload.session_id`. `token_count` 의 `last_token_usage`(턴 델타)를 billing 하되 **`total_token_usage`(누적)가 직전과 같은 재방출은 스킵**한다 — 일부 Codex 버전이 같은 턴 `token_count` 를 2~3회 방출(last/total 값 동일·ts 만 다름)해 단순 델타 합산 시 2~3배가 되기 때문(§8.2). total 변화 시에만 billing 하면 authoritative total 과 정확히 일치(실측: input_excl+cache_read=total.input, output=total.output). `total_token_usage`(누적값 자체) 사용 금지는 유지(컴팩션 시 리셋).

### 4.3 Dedup (shim 스킴, `collect/mod.rs:144` — 실제 코드 확인)
- **Claude**(message_id 有): `sha256("claude_code:{message.id}:{model}:{in}:{out}:{cache_read}:{cache_create}")`.
- **Codex**(message_id 無): `sha256("codex:{session}:{ts_ms}:{model}:{in}:{out}")` — 실제 fallback 공식은 `{model}` 을 포함한다. 어댑터가 **턴당 1건**만 방출(§8.2 total-change dedup)하므로 `ts_ms`(그 턴 `token_count` 의 timestamp)는 재파싱에도 안정적이라 서버 `ON CONFLICT` 이 흡수.
- OTLP 스킴(`req|{requestId}|…` / `nat|{session}|{eventSequence}|…`, `dedup.ts`)과 접두·구분자·필드가 모두 달라 **서로 dedup 안 됨** → §5.2 게이트 필수.
- 재파싱(파일 제자리 갱신) 중복은 서버 `ON CONFLICT(dedup_key) DO NOTHING` 이 흡수(멱등). 커서(`{adapter}.json`, mtime+size)로 변한 파일만 재파싱.

### 4.4 비용 — 서버 권위(변경 없음)
- shim 은 토큰만(costUsd=0, userId=null) 전송. 서버 `/v1/events` 가 `resolveCost(mode:"calculate")` 로 확정(§7 재사용). `resolveCost` 는 이미 ccusage 이식판: input/output 200k tiered, 캐시생성=`cacheCreatePerM ?? input×1.25`, 캐시읽기=`cacheReadPerM ?? input×0.1`, fast 배수, LiteLLM/models.dev 가격.
- **캐시생성 5m/1h 차등(구현 완료 — 리스크 B 재평가)**: ccusage 처럼 5m=`cacheCreatePerM`(≈input×1.25)·1h=input×2 로 분리 가격한다. shim 이 `cache_creation.ephemeral_1h_input_tokens` 를 `cacheCreation1hTokens` 힌트로 전송(claude 만; 미제공=0=전량 5m, 구 클라·OTLP 하위호환). `resolveCost` 가 1h 를 input×2 로 가산. **실측 반증**: 초안 가정("대부분 5m")과 달리 실데이터의 캐시생성 토큰 **86.8% 가 1h** → 단일 요율은 캐시생성 34.3%·**총비용 15.3% 과소계상**(§8.2). DB 미영속(cost 는 인제스트 시 확정·저장, 재계산 경로 없음).
- **`mode` 주의**: pull 은 `calculate` 강제(OTLP 의 `auto`+providedCostUsd 와 달리). Claude 트랜스크립트의 `costUSD` 를 신뢰하지 않고 서버 LiteLLM 으로 재계산 → 가격 정책 일원화·신뢰경계 유지.

### 4.5 host — 자동 획득(핵심 이득)
pull 경로는 `to_usage_event` 에서 `host_label()` 을 `UsageEvent.host` 로 실어 보낸다(§7). 따라서 **claude/codex 사용량도 host 가 자동으로 붙어** Desktop "(알 수 없음)" 문제가 근본 해소된다 — OTLP 처럼 env 에 `toard.host` 를 주입할 필요가 없다. `TOARD_DISABLE_HOST`/`TOARD_HOST_LABEL` 규칙도 그대로 적용.

### 4.6 커서 · 스로틀 · 백필 (결정 확정)
- 커서: usage 는 `~/.toard/state/cursors/{claude_code|codex}.json`, content 는 `{…}-content.json`(분리).
- **수집 방식 = poll (결정)**: hook 이 아니라 기존 pull 파이프라인 유지. 근거 — ① Codex 는 hook 이 없어 어차피 poll·스케줄러 필요(Claude 만 hook 하면 이중 메커니즘), ② hook 도 결국 `settings.json` 주입이라 우리가 OTLP 에서 벗어난 취약성(주입·Desktop 발화 불확실·토큰 파일)을 재도입, ③ poll 은 커서·파일 기반이라 실행을 놓쳐도 다음 회차가 따라잡는 자가치유(hook 은 이벤트 유실 시 갭), ④ 사용량/비용은 초 단위 신선도 불필요(ccusage=on-demand, day1co Codex=5분). hook 은 초 단위 신선도·툴이벤트·세션경계 같은 richer 데이터가 필요해질 때 후속(§10).
- 스로틀·트리거: 기존 `maybe_spawn_background`(wrap 편승, 10분, `TOARD_SHIM_COLLECT_INTERVAL` 로 단축 가능) + `toard-shim collect` 수동 + **content 와 공유하는 launchd/cron 주기 실행 하나**로 usage+content 동시 커버(Desktop 미경유 보완). worst-case 지연 = 주기 간격(예 5분).
- **백필 = 전량 (결정)**: usage 커서가 없으면 전 파일 스캔 → **과거 사용량 전량 백필**(토큰 카운트라 민감정보 아님, 가치 큼). `TOARD_SHIM_USAGE_SINCE`(날짜) 컷오프 env 는 안전판으로 함께 제공하되 **기본은 전량**.

## 5. OTLP 강등 (experimental)

OTLP push 를 **기본 off·opt-in** 으로 강등하되 코드는 보존한다.

### 5.1 클라이언트(shim) — 주입 중단
claude/codex 에 대해 OTEL env·config 주입을 끈다(실험 플래그로만 켬):
- `otel::inject_env`(wrap, `otel.rs:81`) — CLAUDE_CODE_ENABLE_TELEMETRY/OTEL_* 주입 중단.
- `claude_env.rs`(settings.json) — OTEL 키 주입 중단(`claude-env` 는 no-op/deprecate).
- `codex::inject_config`(config.toml `[otel]`) — 주입 중단.
- 플래그: `TOARD_EXPERIMENTAL_OTLP=1` 일 때만 종전대로 주입.

### 5.2 서버 — 이중집계 차단(중요, 정정판)
OTLP dedup_key(`req|…`, `packages/ingest/src/dedup.ts`)와 pull dedup_key(`{adapter}:…`)는 **공식이 달라 같은 요청이 서로 dedup 되지 않는다** → 두 경로 동시 활성 시 **2배 계상**.

**⚠ provider 를 `enabled=false` 로 끄면 안 된다**(자기검토에서 확인): `/v1/events`(pull, `events/route.ts:37-42`)와 `/v1/logs`(OTLP)의 provider 실재 검증이 **둘 다 `loadProviders()`=`WHERE enabled=true`** 를 쓴다. provider 를 disable 하면 pull 까지 400 으로 깨진다. 게이트는 **enabled 유지** 한 채 push 경로에서만 막아야 한다:
- **① 마이그레이션/seed**: `claude_code`·`codex` 의 `collection_method` 를 `otel`→`logfile` 로(enabled 는 true 유지).
- **② `identifyProvider` 정정**: `packages/ingest/src/provider.ts:15` 는 현재 `enabled` 와 `service_name_patterns` 만 본다. **`collectionMethod !== 'otel'` 인 provider 를 스킵**하도록 한 줄 추가(`if (!p.enabled || p.collectionMethod !== 'otel') continue;`). 그러면 `/v1/logs` 는 claude/codex OTLP 를 provider 미식별로 드롭(=raw 저장·정규화 안 함)하되, `/v1/events` 의 `known` 집합에는 여전히 들어 있어 pull 은 정상. `Provider` 타입에 `collectionMethod` 노출 필요(loadProviders 는 이미 반환).
- **③ 대칭 게이트(experimental 대비, 최종검토 발견)**: `/v1/events`(pull, `events/route.ts:37-42`)는 현재 `enabled` 만 보고 `collection_method` 를 **안 본다**. experimental 로 OTLP 를 되켜(collection_method=`otel`) shim 이 pull 도 계속 보내면 또 2배. 따라서 `collection_method` 를 **provider 당 단일 소스 스위치**로 삼아 `/v1/events` 도 `collection_method!=='logfile'` 이벤트를 드롭하는 대칭 게이트를 둔다(기본 logfile 경로엔 영향 0). 그러면 클라가 무엇을 보내든 서버가 provider 당 한 소스만 저장 → 클라 상태와 무관하게 이중집계 불가능.
- 이는 "provider 당 단일 소스" 원칙을 push·pull **양 끝**에 대칭 적용하는 것.

### 5.3 컷오버(seam 최소화)
- shim 업그레이드 시점에 OTLP 주입이 멈추고 pull 이 시작된다. pull 은 **파일에서 과거를 백필**하므로 전환 창의 사용량도 채운다(OTLP 는 forward-only).
- 리스크: 업그레이드 전 이미 떠 있던 Claude Code 프로세스는 OTLP env 가 살아 있어, pull 시작과 겹쳐 **그 프로세스 세션분이 2배**될 수 있음. 완화: 서버에서 `collection_method=logfile` provider 의 OTLP 를 **드롭**(§5.2)하면 겹쳐도 OTLP 분이 저장되지 않아 안전. → **서버 게이트를 shim 강등보다 먼저 배포**한다.

## 6. 데이터 흐름 (전/후)

```
[이전]  claude/codex ──OTLP env──▶ /v1/logs ─(서버 정규화·dedup)─▶ usage_events
        gemini/qwen  ──shim pull──▶ /v1/events ─────────────────▶ usage_events

[이후]  claude/codex ──shim pull(파일)──▶ /v1/events ─(resolveCost)─▶ usage_events   (host 자동)
        gemini/qwen  ──shim pull──────────▶ /v1/events ────────────▶ usage_events
        (OTLP 는 experimental opt-in 으로만)
```

## 7. 재사용 표 (from infra 조사)

| 구성요소 | 위치 | 재사용 |
|---|---|---|
| `LogAdapter` trait(usage+content 동시) | `collect/mod.rs:82` | 그대로 |
| `run()` usage 루프·청킹·커서·재시도 | `collect/mod.rs:288` | 그대로 |
| `RawUsage` / `to_usage_event`(userId=null·cost=0·host·log_adapter) | `collect/mod.rs:56,161` | 그대로 |
| dedup_key(shim 스킴) | `collect/mod.rs:144` | 그대로 |
| 커서 `{adapter}.json` | `collect/cursor.rs` | 그대로 |
| wire `to_json`/`to_events_body` | `collect/usage_event.rs:88` | 그대로 |
| POST `post_events`(curl→`/v1/events`) | `collect/post.rs:85` | 그대로 |
| `/v1/events`(auth·검증·provider·cost·저장) | `apps/web/app/api/v1/events/route.ts` | 그대로 |
| `resolveCost` | `packages/pricing/src/cost.ts` | 그대로 |
| `saveUsageEvents` dedup(PG·CH) | `storage-*/src/storage.ts` | 그대로 |
| claude.rs·codex.rs `discover_files`·파일 루프 | `collect/{claude,codex}.rs` | 확장(발견·루프 재사용) |
| `parse_file()`(토큰 매핑) | `collect/{claude,codex}.rs` | **신규** |
| OTLP 주입(inject_env·claude_env·codex config) | `otel.rs`·`claude_env.rs` | 실험 플래그 뒤로 |
| provider `collection_method` | `scripts/seed.ts` + 마이그레이션 | 변경(otel→logfile) |
| OTLP 정규화기 claude.ts·codex.ts | `packages/ingest/src/normalizers/*` | 보존(experimental) |

## 8. 결정 · 리스크

- **결정 1 — 백필 범위 = 전량**: claude/codex usage 첫 수집(커서 없음) 시 **과거 전량 백필**(토큰 카운트라 민감정보 아님, 히스토리 가치↑). `TOARD_SHIM_USAGE_SINCE`(날짜) 컷오프 env 는 안전판으로 제공하되 기본은 전량. (2026-07-06 확정)
- **결정 2 — 수집 방식 = poll (hook 아님)**: 근거는 §4.6 — ① Codex 는 hook 부재로 어차피 poll·스케줄러 필요, ② hook 도 `settings.json` 주입이라 OTLP 취약성 재도입, ③ poll 은 자가치유(놓쳐도 따라잡음), ④ 사용량/비용은 초 단위 신선도 불필요. 실시간성은 launchd 주기 실행(content 와 공유)으로 보완. hook 은 후속 여지로만(§10). (2026-07-06 확정)
- **리스크 A — Codex 포맷 변동·null**: `token_count`/`last_token_usage` 스키마는 Codex 버전 의존. 골든 픽스처로 드리프트 검증 필요(§9). 모델명이 `session_meta` 에만 있어 누락 시 `model=None`(비용 0, 경고). **실측 robustness**: `info==null` 인 `token_count` 이벤트 존재(18,995개 중 4개) → 파서가 스킵 안 하면 크래시. `input − cached` 는 실측상 항상 ≥0(18,995개 중 위반 0)이나 **saturating sub** 로 방어.
- **리스크 B — 캐시생성 5m/1h 정밀도(해소됨)**: 초안은 "대개 작음"으로 후속으로 미뤘으나 **실측 반증** — 캐시생성 토큰 1h 비중 86.8%, 단일 요율 시 총비용 15.3% 과소계상. 5m/1h 차등 가격을 구현(§4.4·§8.2). shim 힌트(`cacheCreation1hTokens`)+`resolveCost`(1h=input×2), 하위호환(미제공=전량 5m).
- **리스크 C — 컷오버 이중집계**: §5.3 — 서버 게이트 선배포로 완화.
- **리스크 D — 대량 파일**: 966개+ jsonl 전량 스캔(백필). 커서 이후엔 변한 파일만. 초기 1회 비용은 수용 가능(실측 dry-run 133레코드/966파일 수 초).

### 8.1 자기검토 정정 (2026-07-06, 코드·실데이터 반증)
초안의 3개 오류를 실측으로 잡아 본문에 반영:
1. **OTLP 게이트 = provider disable (틀림)** → `/v1/events`·`/v1/logs` 둘 다 `enabled=true` provider 만 인정하므로 disable 시 pull 도 깨짐. 정정: enabled 유지 + `identifyProvider` 가 `collectionMethod!=='otel'` 스킵(§5.2).
2. **Codex `input_tokens` 매핑 (틀림)**: input 은 cached 를 **포함**(실측 `total=input+output`, `cached⊂input`). 정정: `inputTokens = input − cached`(§4.2), 아니면 캐시분 이중 가격.
3. **Claude `isSidechain` 스킵 (틀림)**: 실측 세션에서 서브에이전트 턴 24건이 모두 `isSidechain=true`+**고유 message.id**의 실사용. 스킵 시 누락. 정정: 스킵 안 함, message.id dedup(§4.2).
- 검증 통과: Codex `last_token_usage`=델타(합산 정당), dual usage+content 어댑터 인프라 실재, `/v1/events` mode=`calculate`, `resolveCost` 캐시가 처리.

### 8.2 구현 중 정정 (2026-07-06, 실데이터 반증 2건)
구현 착수 시 실 세션 파일을 다시 파싱해 초안의 Codex 가정 2개가 틀렸음을 확인·정정:
1. **Codex 모델 위치 (틀림)**: 초안은 "`session_meta` 의 모델"이라 했으나 실측상 `session_meta.payload` 엔 `model_provider`(예 `openai`)만 있고 **모델명은 `turn_context.payload.model`**(예 `gpt-5.5`)에 있다(이벤트 순서: session_meta → turn_context → token_count). 어댑터는 `turn_context` 의 모델을 승계해 이후 `token_count` 에 부여한다.
2. **Codex `token_count` 중복 방출 (치명)**: 일부 버전(예 2025-11 세션)이 **같은 턴의 `token_count` 를 2~3회 방출**한다(`last_token_usage`·`total_token_usage` 값 동일, `timestamp` 만 다름). 초안의 "`last_token_usage` 델타 단순 합산"은 이런 세션을 **2~3배 과금**한다(실측: 한 세션 sum(last.output)=231708 vs 실제 total.output=115112, 정확히 2×). 정정 규칙 = **`total_token_usage`(input,output)가 직전 이벤트와 다를 때만 그 이벤트의 `last_token_usage` 를 billing**(재방출은 스킵). 이 규칙이 authoritative total 을 정확히 재구성함을 dup/clean/reset(컴팩션) 세션 전부에서 확인(`input_excl+cache_read=total.input`, `output=total.output`).
3. **캐시생성 5m/1h "minor" 가정 (틀림 — 리스크 B)**: 초안 리스크 B 는 5m/1h 단일요율 오차를 "대개 작음"으로 미뤘으나, 실측상 Claude 캐시생성 토큰의 **86.8% 가 1h**(5m 13.2%)라 단일요율은 캐시생성 34.3%·**총비용 15.3% 과소계상**(opus 대표가). 정정: shim 이 `ephemeral_1h_input_tokens` 를 `cacheCreation1hTokens` 힌트로 전송하고 `resolveCost` 가 1h=input×2 로 차등 가격(§4.4). 선재 이슈(OTLP 경로에도 있던 가격 근사)라 push/pull 과 독립.
- **구현 후 검증(실측)**: shim `collect --dry-run` 이벤트 수 == 독립 Python(정정 규칙) 재현치 — **codex 33,665=33,665 정확 일치**, **claude 84,139=84,139 정확 일치**(동시 측정; 라이브 append 로 시점 차만큼만 증감). Codex 대량 세션(621MB·8,657 token_count 포함) 165파일 파싱 2.7초. 마이그레이션 up/down 실 DB(트랜잭션·롤백) 검증. `identifyProvider` 게이트 단위테스트 5건. 캐시 5m/1h 차등 가격 단위테스트(pricing 8건)·와이어 골든(1h 힌트 4번째 fixture, TS·Rust 양측).

## 9. 구현 계획 (단계)

1. **서버 게이트 먼저**: provider `collection_method` otel→logfile 마이그레이션 + `/v1/logs` 가 logfile provider OTLP 를 드롭. (배포 순서상 1순위 — §5.3)
2. **claude usage 어댑터**: `claude.rs` `collects_usage()→true` + `parse_file()`(§4.2). **isSidechain 스킵 안 함**(서브에이전트 사용량 보존, message.id dedup). 유닛테스트 + 골든 픽스처(실 jsonl 기반, 서브에이전트 세션 포함).
3. **codex usage 어댑터**: `codex.rs` 동일. **`inputTokens = input − cached`**(§4.2 캐시 주의), `last_token_usage` 델타 합산, `session_meta` 모델 추적. 골든 픽스처.
4. **OTLP 주입 강등**: `TOARD_EXPERIMENTAL_OTLP` 뒤로 inject_env·claude_env·codex config. `claude-env` deprecate 경고.
5. **검증**: 실 DB 로 pull→usage_events(host 포함) 확인, OTLP off 상태에서 이중집계 없음 확인, 백필 정확도(ccusage 대조).
6. **문서·릴리스**: shim README·온보딩 갱신(재시작·claude-env 불필요 안내), 릴리스.

## 10. 대안 검토

- **Claude 를 hook 으로(day1co 방식)**: `~/.claude/settings.json` hooks(PostToolUse/Stop/SessionEnd)로 즉시 수집 → 실시간·poll 불필요. 그러나 settings.json hook 설치(claude-env 와 유사한 주입)·Desktop hook 동작 편차가 새 취약점. **poll 이 shim 기존 인프라와 일치**하므로 우선 poll, hook 은 실시간성 요구 시 후속.
- **costUSD 신뢰(ccusage auto 모드)**: 트랜스크립트 `costUSD` 를 그대로 사용하면 서버 가격 동기화 불필요. 그러나 가격 정책 일원화·신뢰경계(클라 비용 불신)를 위해 **서버 재계산(calculate) 유지**.
- **OTLP 완전 제거**: 실시간 push 가 유리한 환경(중앙 수집기 있는 팀)도 있어 **강등(보존)** 이 낫다.

---
부록: 본 설계는 gemini/qwen pull(§5.6)·host-breakdown·본문 pull 과 동일 골격이며, 신규 코드는 어댑터 2개의 `parse_file()` + 서버 provider 게이트로 국한된다.

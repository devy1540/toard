# toard 설계: 사용자별 컴퓨터(호스트) 사용량 분해

> 상태: **구현 완료(Implemented)** · 2026-07-05 · 참조: `docs/ARCHITECTURE.md` §4.1·§4.4·§5.1·§5.6·§7·§10.1·ADR-006
>
> 이 문서의 결정은 ARCHITECTURE.md 에 **ADR-009** 및 §4.2 스키마 항목으로 흡수 예정.
>
> **구현·검증 결과:** 코어 계약(`host`·`byHost`·`getUserHosts`)·wire·shim(Rust: env `toard.host` + pull 경로 + `TOARD_DISABLE_HOST`/`TOARD_HOST_LABEL`)·ingest(logs 라우트 부착·events 살균)·마이그레이션 `1700000011`·PG/CH 두 저장 백엔드·프론트(내 사용량 "컴퓨터별 분해" + 설정 "내 기기") 전부 반영. 검증 = 전 패키지 typecheck + Rust 79 테스트 + wire 골든(TS↔Rust) + **PG·CH 실 DB 통합 증명**(같은 계정의 두 컴퓨터가 byHost 로 정확히 구분, 유휴 기기는 getUserHosts 에만 잔존). **미검증**: Codex 의 env resource attr 존중 여부(런타임 스파이크 필요 — 미존중 시 Codex host 만 "(알 수 없음)", 나머지 경로 무영향).

---

## 1. 배경 & 문제

토큰은 **사용자(계정)에 묶인다** — `ingest_tokens.user_id` 단일 소유(§4.2). 재발급은 이전 토큰을 폐기하는 "사용자당 활성 토큰 1개" 모델이라, **한 사람이 여러 컴퓨터에 같은 토큰을 심는 것이 정상 사용 패턴**이다.

현재 파이프라인에는 **"어느 컴퓨터에서 왔는가"라는 차원이 존재하지 않는다.**

- `UsageEvent` 계약(§4.1)에 host/machine 필드 없음 (`packages/core/src/storage.ts`)
- `usage_events` 테이블에 host 컬럼 없음 (`migrations/1700000002_events.sql`)
- OTLP 수신부·shim pull 경로 어디도 머신 식별자를 추출/저장하지 않음
- 집계는 전부 `user_id`/`team_id`/`session_id` 기준 (`packages/storage-postgres/src/storage.ts`)

결과적으로 **같은 계정을 여러 컴퓨터에서 쓰면 전부 한 사용자로 정확히 합산되지만**(유실·덮어쓰기 없음), 사용자가 "내 사용량을 회사 맥북 vs 집 데스크탑으로 나눠 보기"는 불가능하다.

이 문서는 **기본 계정 합산은 그대로 두고, "내 사용량" 화면에 컴퓨터별 드릴다운을 얹는** 최소 변경을 설계한다.

## 2. 목표 / 비목표

**목표**
- 각 UsageEvent 에 **발생 컴퓨터(호스트)** 를 부착한다 — OTLP push·shim pull **양 경로 모두**.
- "내 사용량"(`/`) 화면에 기존 **모델별 분해**와 대등한 **컴퓨터별 분해**를 추가한다.
- 기존 계정/팀 합산 의미론과 dedup 멱등성을 **깨지 않는다**.
- host 미상(마이그레이션 이전 이벤트, 식별 실패)을 안전하게 처리한다.

**비목표(1차 제외)**
- 팀/전체 현황(`/org`)·리더보드의 host 축 분해 — 카디널리티 폭증 + 타인 기기 가시성/프라이버시 이슈. 필요 시 별도 라운드.
- Mart(`usage_daily_*`)에 host 차원 추가 — 현재 서빙은 event-direct(§4.4 노트, Mart 미사용)라 불필요. Mart 서빙 전환 시 재검토.
- 머신 간 이벤트 **이동/재귀속**(한 기기에서 발생한 걸 다른 기기로 옮기기) — 개념상 무의미.

## 3. 결정 요약 (ADR-009 초안)

- **결정:** UsageEvent 에 선택적 `host` 필드(문자열, 표시용 라벨)를 추가한다. 값은 **shim 이 채운다** — pull 경로는 JSON 본문에, push 경로는 **도구별 OTEL 설정면**(Claude Code=env `OTEL_RESOURCE_ATTRIBUTES`, Codex=`config.toml` — §5)의 `toard.host` 로. 앱은 host 를 **신뢰경계 밖 서술 메타데이터**로 저장(§10.1 의 user_id/cost 권위와 달리 검증 대상 아님)하고, "내 사용량"에서만 `GROUP BY host` 로 분해한다.
- **식별자:** 1차는 **hostname(`uname -n`)** 단독. 사용자가 알아보는 라벨이 곧 키. 안정적 machine-id 는 충돌이 실제 문제로 드러나면 추가(§4, 진화 경로).
- **정규화:** **자동 감지 hostname** 은 shim 이 `trim` + **소문자화**(대소문자·공백 차이로 인한 버킷 분열 방지). **사용자 별칭(`TOARD_HOST_LABEL`) 은 `trim` 만** — 사용자가 고른 대소문자를 존중(강제 소문자화 금지). 어느 쪽이든 **FQDN 은 저장값에 보존**(도메인 스트립은 서로 다른 기기를 한 버킷으로 합칠 위험, 짧은 이름은 표시 시점 옵션 §8), **trim 후 빈 문자열은 미설정(None)** → "(알 수 없음)" 버킷.
- **기본값:** host 전송 **기본 on**, 손쉬운 옵트아웃(`TOARD_DISABLE_HOST=1`) + 별칭 오버라이드(`TOARD_HOST_LABEL`) 제공. 노출이 **본인 화면 한정**(§8·§11)이라 hostname 민감도가 낮아, "기능이 기본으로 동작"과 프라이버시의 균형점이 기본 on.
- **노출 위치:** 사용량 분해는 "내 사용량"(`/`), 기기 목록·별칭·옵트아웃 관리는 "내 설정"(`/settings`). **admin·팀 화면에는 노출하지 않는다**(타인 기기 비가시).
- **dedup 불변:** `host` 는 **dedup_key 구성에서 제외**한다(§9 근거). 순수 서술 차원.
- **근거:** 두 수집 경로 모두 shim 이 앞단에 있어(§ADR-006) host 를 한 곳에서 일관되게 주입할 수 있다. host 는 사용자 소유 기기의 자기 식별이라 서버가 위조 방지할 이유가 약하고, dedup 밖에 두면 기존 멱등·합산이 그대로 유지된다.
- **기각:** ① host 를 dedup_key 에 포함 — 불필요하고(경로별로 한 이벤트는 한 기기에서만 관측됨) 오히려 재전송 멱등을 깨뜨릴 위험. ② user.id 처럼 서버 권위 확정 — host 는 서버가 알 방법이 없음(토큰→user 만 확정 가능). ③ machine-id 우선 — 사용자에게 노출 시 무의미한 opaque 값.

## 4. 식별자 설계 — hostname 우선, machine-id 는 진화 경로

| 후보 | 장점 | 단점 | 판정 |
|---|---|---|---|
| **hostname** (`uname -n`) | 사람이 즉시 알아봄("Alice-MacBook"), 수집 공짜 | 변경 가능·이론상 충돌(같은 이름 두 대) | **1차 채택** |
| 안정 machine-id (`/etc/machine-id`, macOS `IOPlatformUUID`) | 불변·유일 | opaque — 화면에 그대로 못 씀, 라벨 별도 필요 | 진화 시 **키**로 승격, hostname 은 라벨로 |

**1차 판단:** 개인이 이름이 똑같은 기기를 둘 이상 갖는 경우는 드물고, "내 사용량" 개인 화면 한정이라 hostname 단독으로 충분하다. 충돌/기기명 변경이 실제 혼란을 일으키면 `host_id`(안정 machine-id)를 키로, `host`(hostname)를 라벨로 분리한다 — ADR-001 의 "진화 경로" 패턴과 동일하게 앱 코드 최소 변경(컬럼 1개 추가)으로 흡수.

## 5. 데이터 흐름 — 양 경로에서 host 주입

```
┌ pull 경로 (비-OTEL 도구, §5.6) ────────────────────────────┐
│ shim(Rust)  로컬 로그 파싱 → UsageEvent{…, host: uname -n} │
│   POST /api/v1/events  (Authorization: Bearer <token>)     │
└────────────────────────────────────────────────────────────┘
┌ push 경로 (OTEL 도구, §5.1) — 도구별 주입면이 다름 ────────┐
│ Claude Code : shim → OTEL_RESOURCE_ATTRIBUTES=…,toard.host │
│               (env 기반, 표준 OTEL 리소스 감지)             │
│ Codex       : shim → ~/.codex/config.toml [otel] 블록        │
│               (config.toml 우선 — env 미존중 시 TOML 에 주입)│
│   도구 텔레메트리 → POST /api/v1/logs (resource attr 동봉)  │
│   앱 정규화기: resourceAttrs['toard.host'] 읽어 UsageEvent  │
└────────────────────────────────────────────────────────────┘
                         ↓ 양쪽 수렴
         storage.saveUsageEvents([{…, host}])  (§5.5 멱등 저장)
```

핵심: **host 는 언제나 shim 에서 온다.** 다만 push 경로의 주입면은 **도구마다 다르다**:

- **Claude Code (env):** `merge_resource_attrs`(`shim/rust/src/otel.rs`)가 `OTEL_RESOURCE_ATTRIBUTES` 에 마커를 넣는 기존 메커니즘에 `toard.host` 를 얹는다. **반드시 기존 `toard.shim/toard.tool` 과 같은 문자열에 번들**해야 한다 — 이 함수의 멱등 가드가 `toard.tool` 마커 유무로 append 여부를 판정하므로, host 를 별도로 넣으면 이중 append/누락이 생긴다.
- **Codex (config.toml):** shim 은 env 가 아니라 `~/.codex/config.toml` 의 `[otel]` 블록을 직접 쓴다(`shim/rust/src/codex.rs` `render_block` — 현재 resource attr 필드 없음). **먼저 Codex 가 `OTEL_RESOURCE_ATTRIBUTES` env 를 존중하는지 검증**하고, 존중하면 env 로 끝, **미존중 시 `render_block` 의 TOML 블록에 resource attribute 항목을 추가**한다. 검증 전까지 Codex host 는 "(알 수 없음)" 가능(§12).

**앱 수신부 — host 부착 위치(실제 조립 흐름 반영):** OTLP 수신부는 `resource.attributes` 를 `resourceAttrs` 로 평탄화(`packages/ingest/src/otlp.ts:49`)해 넘기고, 그 전에 `sanitizeAttrs`(`apps/web/lib/sanitize.ts`)를 거친다 — 현재 **denylist** 라 `toard.host` 는 보존된다. ⚠️ 단 sanitize 주석에 "향후 화이트리스트 전환" 계획이 있어, **전환 시 `toard.host`(+`host.name`)를 보존 목록에 반드시 추가**해야 host 가 조용히 유실되지 않는다.

정규화기(`normalize`)는 `NormalizedUsage[]`(host 필드 **없음**)를 반환하고 **그 뒤 원본 레코드와의 연결이 끊긴다**(`provider.ts` 의 `service.name` 판정 지점엔 아직 결과 이벤트가 없다). 따라서 host 는 **`apps/web/app/api/v1/logs/route.ts` 의 provider 그룹 루프**에서 붙인다 — 그 루프는 `recs`(resourceAttrs 보유)가 스코프에 있고 이미 `normalized.map(u => UsageEvent)` 로 이벤트를 조립하므로, 여기서 `recs` 의 `toard.host`(폴백 `host.name`)를 읽어 각 이벤트에 실으면 된다. **어댑터/normalizer 15종은 무수정.**

> 전제: 한 POST = 한 머신(shim 이 자기 머신 텔레메트리를 직접 전송, Collector 없음 — ADR-001)이라 한 provider 그룹의 `recs` 는 모두 같은 host. 이 전제가 불편하면 `NormalizedUsage` 에 `host` 를 추가해 레코드별 정확도를 얻는 대안(정규화기 인터페이스 + Claude/Codex 2개 어댑터 수정)이 있다 — 1차는 전제 채택.

## 6. 데이터 모델 변경

### 6.1 와이어 계약 (`host` 선택 필드 추가)
`UsageEvent` 는 SSOT 가 TS(`packages/core`)이고 shim(Rust)이 미러하며, 양쪽을 `fixtures/usage-event.golden.json` 으로 CI 검증한다(§5.6). 따라서 **세 곳을 동시에** 바꾼다:

- `packages/core/src/storage.ts` — `UsageEvent` 에 `host?: string | null` 추가(**기존 `logAdapter?: string | null` 과 동일한 optional 컨벤션** — 선택 필드)
- `packages/core/src/wire.ts` — `parseUsageEventWire` 반환에 `host: nullableString(v.host, "host")` 추가(`logAdapter` 파싱과 동일 — 없으면 `null` 로 항상 채움, 하위호환)
- `shim/rust/src/usage_event.rs` — `host: Option<String>` 미러 + `to_json`/`from_json` 반영
- `fixtures/usage-event.golden.json` — 골든 항목에 `host` 추가(일부는 `null` 로 남겨 하위호환 검증)

> 하위호환: `host` 는 **선택 필드**. 구 shim(host 미전송)의 이벤트는 `host=null` 로 파싱되어 "미상" 버킷에 들어간다. 계약 위반 아님.

### 6.2 Postgres 스키마 — 마이그레이션 `1700000011_usage_event_host.sql`
```sql
-- Up
ALTER TABLE usage_events ADD COLUMN host TEXT;   -- 표시용 hostname, NULL=미상. dedup_key 미포함(§9)
-- byHost(기간-스코프)·getUserHosts(언바운드 MAX(ts)) 양쪽 커버: user_id→host→ts 순
CREATE INDEX idx_usage_events_user_host_ts ON usage_events (user_id, host, ts);

-- Down
DROP INDEX IF EXISTS idx_usage_events_user_host_ts;
ALTER TABLE usage_events DROP COLUMN IF EXISTS host;
```
- 최신 마이그레이션이 `1700000010_prompt_records.sql` 이므로 **`1700000011`**.
- 컬럼은 `NULL` 허용(백필 없음) — 기존 행은 자동 "미상". `NOT NULL`/기본값 강제 안 함.

### 6.3 ClickHouse 모드(옵트인) 미러
```sql
ALTER TABLE usage_events ADD COLUMN host LowCardinality(String) DEFAULT '';
-- ReplacingMergeTree ORDER BY 는 (user_id, ts, dedup_key) 유지 — host 는 정렬키 아님(dedup 불변)
```
> host 는 사용자당 소수(기기 수)라 `LowCardinality` 적합. CH `usage_daily_user_mv` 는 1차에서 host 축 미추가(비목표 §2).
>
> **재전송 시 host 확정 규칙이 백엔드마다 다름(문서화):** 같은 `dedup_key` 가 재전송되면 PG 는 `ON CONFLICT DO NOTHING`(**첫 삽입** host 유지), CH `ReplacingMergeTree` 는 **마지막/임의** host 유지. 재전송은 동일 기기에서 오므로 host 값이 같아 실무상 무해하나, 백엔드 간 미세한 의미 차이가 있음을 명시한다(§9). 또한 CH 의 빈 문자열 `''` 과 PG 의 `NULL` 은 **둘 다 "(알 수 없음)" 으로 정규화**해 표시·집계한다.

### 6.4 저장 계약 (`StorageBackend`)
**두 화면은 쿼리 의미가 달라 shape 를 분리한다** — 사용량 분해는 기간-스코프, 기기 목록은 기간 무관.

- **사용량 분해(기간-스코프):** `UserUsage` 반환에 `byHost: HostBreakdown[]` 추가.
  `HostBreakdown { host: string | null; label: string; costUsd: number; totalTokens: number; sessions: number }` — `ModelBreakdown` 과 대칭. `label` 은 `host ?? "(알 수 없음)"`. `PeriodQuery` 기간·`providerKey` 필터를 그대로 탄다.
- **기기 목록(기간 무관):** 신규 `getUserHosts(userId): DeviceInfo[]`.
  `DeviceInfo { host: string | null; label: string; lastSeenAt: Date; eventCount: number }` — **기간 필터 없이 전체 이력**에서 host 별 `MAX(ts)`·`COUNT(*)`. 기간-스코프 `byHost` 를 재사용하면 **선택 기간보다 오래 유휴인 기기가 목록에서 사라지므로**(§8) 재사용 금지 — 별도 언바운드 쿼리가 맞다.
- **host 저장 + 하드닝(수렴 지점 1곳):** host 는 검증하지 않되(신뢰경계 밖) **길이 상한(예: 255자) 절단 + 제어문자 제거 + trim-후-빈값→NULL** 로 살균한다. 살균은 **두 수집 경로가 수렴하고 두 백엔드(PG/CH)가 공유하는 지점** — 라우트의 finalize 단계(§7, events 의 `.map` / logs 의 post-normalize) 또는 `packages/core`/`ingest` 공용 헬퍼 — 에서 **1번** 수행한다. 특정 백엔드 `saveUsageEvents` 안에 넣으면 다른 백엔드가 누락되므로 금지.

## 7. 집계 & API

- **사용량 분해(기간-스코프)** — `getUserUsage` 반환에 `byHost` 추가. 구현은 **`modelBreakdown`(`storage.ts:234`) 을 그대로 복제하고 `GROUP BY` 대상만 host 로** 바꾸면 된다. provider 필터는 `modelBreakdown` 이 쓰는 **`this.periodWhere(q)` 헬퍼**(`q.providerKey` 있으면 `provider_key = $N` 을 동적으로 추가, `storage.ts:37`)를 그대로 재사용하므로 **자동 미러**된다 — 하드코딩 파라미터 불필요:
  ```sql
  SELECT host,                      -- raw(null 보존) — 라벨링은 앱 1곳에서(§6.4)
         COALESCE(SUM(cost_usd),0)  AS cost,
         COALESCE(SUM(input_tokens+output_tokens),0) AS tokens,
         COUNT(DISTINCT session_id) AS sessions
  FROM usage_events ${where}        -- periodWhere(q): user_id + 기간 + (선택)provider_key
  GROUP BY host ORDER BY cost DESC  -- SQL 은 NULL 을 한 그룹으로 묶음 → "(알 수 없음)" 단일 버킷
  ```
  > `modelBreakdown` 은 SQL 에서 `COALESCE(model,'(unknown)')` 로 치환하지만, host 는 **raw 로 반환하고 null→"(알 수 없음)" 라벨을 앱에서** 붙인다 — `HostBreakdown.host: string | null` 타입(§6.4)·CH `''` 흡수·한국어 라벨 i18n 을 한 곳으로 모으기 위함.
- **기기 목록(기간 무관)** — 신규 `getUserHosts(userId)`. **`periodWhere` 를 쓰지 않고 기간·provider 필터 없이 전체 이력**에서 집계(유휴 기기도 항상 노출, §6.4):
  ```sql
  SELECT host, MAX(ts) AS last_seen_at, COUNT(*) AS event_count
  FROM usage_events
  WHERE user_id = $1
  GROUP BY host
  ORDER BY last_seen_at DESC
  ```
- CH 저장 백엔드도 두 쿼리 동형 미러(옵트인 모드, `modelBreakdown` 상당부 `storage.ts:211`). CH 는 host 가 `''`(빈 문자열, DEFAULT)일 수 있으므로 **`nullIf(host,'')` 로 NULL 정규화 후** 반환 → 앱에서 PG 의 `NULL` 과 동일 "(알 수 없음)" 버킷.
- 수신 라우트 2곳은 host 를 통과만 시킴:
  - `apps/web/app/api/v1/events/route.ts` — 이미 `...e` 스프레드로 저장하므로 wire 파서가 host 를 실으면 자동 반영. `userId`/`costUsd` 서버 권위 확정 로직은 불변.
  - `apps/web/app/api/v1/logs/route.ts` — 정규화기가 `toard.host` 를 채우면 자동 반영.

## 8. 프론트엔드 — 본인 화면 한정(사용량은 `/`, 관리는 `/settings`)

**사용량 분해 — "내 사용량"(`/`, §7.3-①)**
- `apps/web/app/(dashboard)/page.tsx`: 기존 **모델별 분해** 옆/아래에 **컴퓨터별 분해** 섹션 추가 — 동일한 Recharts 막대 + 테이블 패턴 재사용.
- host 가 하나뿐이면(단일 기기 사용자) 섹션을 접거나 숨겨 노이즈 방지. 둘 이상일 때만 강조.
- `(알 수 없음)` 버킷은 항상 마지막에, 옅게 — "구 버전 shim 또는 미식별 이벤트" 툴팁.
- 표시 라벨은 **짧은 이름(도메인 스트립) 옵션** — 저장값 FQDN 은 그대로 두고 표시만 축약(§3 정규화).
- 필터(기간·도구)는 기존 `DashboardFilters` 그대로 상속(§7.4).

**기기 관리 — "내 설정"(`/settings`, §7.3-③)**
- 설정의 "설치·토큰" 탭에 **내 기기 목록**(host·마지막 수신·이벤트 수) 노출. admin 이 아니라 **본인이 자기 기기만** 본다(결정 §3).
- 여기에 host 전송 **옵트아웃 토글**(`TOARD_DISABLE_HOST`)·**별칭 설명**(`TOARD_HOST_LABEL`) 안내와 "전송 항목: 토큰 카운트·모델·기기명" 고지(§11).
- 기기 목록은 **`getUserHosts(userId)`**(기간 무관, §6.4·§7)로 렌더 — "host · 마지막 수신 · 이벤트 수". **기간-스코프 `byHost` 를 재사용하지 않는다**: 그러면 선택 기간보다 오래 유휴인 기기가 목록에서 사라져 "내 기기"를 못 보게 된다.

## 9. dedup·멱등 상호작용 (host 는 키가 아님 — 근거)

`dedup_key` 는 `hash(request_id, model, tokens…)` 또는 폴백 `hash(session.id, event.sequence, ts, tokens)`(§4.4, `packages/ingest/src/dedup.ts`). **host 를 여기 넣지 않는다:**

- **불필요:** 한 이벤트(한 request_id/session)는 **한 기기에서만 관측**된다 — 각 기기는 자기 로컬 로그만 읽고 자기 텔레메트리만 보냄. 서로 다른 기기가 같은 dedup_key 를 만들 실질 경로가 없다.
- **위험 회피:** host 를 키에 넣으면, 같은 이벤트가 정당하게 재전송될 때(shim 재시작 후 오프셋 재읽기 등) host 문자열이 미세히 달라지면(대소문자·FQDN 변화) **중복 저장**된다. 키 밖에 두면 `ON CONFLICT DO NOTHING` 이 그대로 흡수하고, **첫 삽입의 host 가 확정**된다(안정적).

결론: host 는 순수 서술 컬럼. 기존 멱등·합산 의미론 **완전 불변**.

## 10. 백필·마이그레이션 안전성

- 마이그레이션 이전 이벤트 → `host = NULL` → UI "(알 수 없음)". 팀 백필 부재(§4.4 노트)와 동일한, 이미 문서화된 패턴.
- 구 shim 사용자 → 신 앱: host 미전송이라 계속 `NULL`. 앱은 정상 동작(선택 필드).
- 신 shim → 구 앱(롤백): 구 앱 wire 파서가 미지 필드 `host` 를 **무시**(엄격 파싱은 알려진 필드만 읽음) — 안전. `/api/v1/logs` push 경로는 `toard.host` 가 그냥 안 읽히는 resource attr 로 남음 — 안전.
- 롤포워드/롤백 어느 방향도 데이터 유실 없음.

## 11. 프라이버시 (§10.3 연장)

- hostname 은 **새로 수집되는 기기 메타데이터**다. 프롬프트 미수집 원칙(§10.3)과 별개의 신규 항목이므로 명시적으로 다룬다.
- 노출 범위(결정): **본인 화면 한정** — 사용량은 "내 사용량"(`/`), 기기 목록은 "내 설정"(`/settings`). **admin·팀·리더보드 어디에도 host 를 노출하지 않는다**(타인 기기 비가시). 다중 테넌트/사내 배포에서도 사용자는 **자기 hostname 만** 본다.
- 기본값(결정): host 전송 **기본 on** + 손쉬운 옵트아웃. 노출이 본인 한정이라 노출 리스크가 낮고, 기본 on 이어야 기능이 즉시 동작한다. 사내 기기명이 실명/직책을 담는 조직은 아래 옵트아웃/별칭으로 대응.
- 옵트아웃: **`TOARD_DISABLE_HOST=1`**(미전송 → "(알 수 없음)" 버킷) 또는 **`TOARD_HOST_LABEL=<별칭>`**(hostname 대신 사용자 지정 라벨 전송). `TOARD_SHIM_COLLECT` 류 기존 env 컨벤션과 대칭.
- 설정 "설치·토큰" 탭(§7.3-③, §8) 프롬프트 미수집 고지 옆에 "전송 항목: 토큰 카운트·모델·**기기명(호스트)**" 한 줄 고지 + 옵트아웃 안내 추가.

## 12. 트레이드오프·기각안 (정직하게)

- **hostname 변경/충돌:** 기기명을 바꾸면 같은 물리 기기가 두 버킷으로 쪼개진다. 1차는 감수(개인 화면·저빈도). machine-id 진화 경로로 해소 가능(§4).
- **push 경로 host 정확도:** `OTEL_RESOURCE_ATTRIBUTES` 는 프로세스 env 라 shim 이 exec 하는 도구에만 적용된다. 사용자가 toard shim 을 안 거치고 도구를 직접 실행하면 host 누락 → "(알 수 없음)". 이는 수집 자체가 shim 전제(§ADR-006)라 새 한계가 아님.
- **Codex 주입면 불확실성(§5):** Codex 는 env 가 아니라 `~/.codex/config.toml` 로 OTEL 을 설정하므로, `toard.host` env 가 Codex 텔레메트리에 반영될지 **미검증**이다. 반영 안 되면 `render_block`(`shim/rust/src/codex.rs`) TOML 블록에 resource attr 항목 추가가 필요하고, 그 전까지 **Codex 사용량은 host="(알 수 없음)"** 로 떨어질 수 있다. Claude Code(env)는 영향 없음. → 구현 첫 단계로 "Codex env 존중 여부" 스파이크를 둔다(§14).
- **카디널리티:** 개인당 host 는 소수라 인덱스·`LowCardinality` 비용 무시 가능. 팀/org 축으로 확장하면 달라짐 → 그래서 비목표. 악용 폭주는 서버 하드닝(§6.4 길이 절단)으로 방어.

## 13. 결정된 사항 (2026-07-03)

앞선 열린 질문 3건은 아래로 확정 — §3·§8·§11 에 반영됨.

1. **노출 위치:** admin 미노출. 사용량은 "내 사용량"(`/`), 기기 목록·관리는 **"내 설정"(`/settings`)** 에서 **본인이 자기 기기만** 본다.
2. **전송 기본값:** **기본 on** + 손쉬운 옵트아웃(`TOARD_DISABLE_HOST=1`)·별칭(`TOARD_HOST_LABEL`). 노출이 본인 한정이라 민감도가 낮고, 기본 동작해야 기능 가치가 성립.
3. **정규화:** 자동 hostname 은 shim 에서 `trim`+소문자화, **사용자 별칭은 `trim` 만**(대소문자 존중). **FQDN 은 저장에 보존**(도메인 스트립 시 다른 기기 충돌 위험), 짧은 이름은 **표시 시점 옵션**으로 축약.

### 남은 후속(구현 중 판단)
- 표시 라벨 축약(도메인 스트립)을 기본으로 켤지 사용자 토글로 둘지 — UI 구현 시 결정.
- machine-id 승격 시점 — hostname 충돌/변경이 실제 혼란을 낳을 때(§4).

## 14. 구현 체크리스트 (승인 후, 파일 단위)

- [ ] **[스파이크 先행]** Codex 가 `OTEL_RESOURCE_ATTRIBUTES` env 를 존중하는지 검증 — 결과로 아래 otel.rs vs codex.rs 분기 확정(§5·§12)
- [ ] `packages/core/src/storage.ts` — `UsageEvent.host`, `HostBreakdown`(lean), `UserUsage.byHost`, 신규 `DeviceInfo`·`getUserHosts(userId)`
- [ ] `packages/core/src/wire.ts` — `host` 파싱(nullable)
- [ ] `shim/rust/src/usage_event.rs` — `host` 미러
- [ ] `shim/rust/src/otel.rs` — `merge_resource_attrs` 에서 `toard.host` 를 **기존 `toard.shim/toard.tool` 마커와 같은 문자열에 번들**(멱등 가드 커버, §5-B)
- [ ] `shim/rust/src/codex.rs` — (스파이크 결과 env 미존중 시) `render_block` `[otel]` 블록에 resource attribute 항목 추가
- [ ] shim — hostname 취득 + 정규화 유틸(`trim`+소문자, FQDN 보존) + `TOARD_DISABLE_HOST`/`TOARD_HOST_LABEL` env 처리
- [ ] `shim/rust/src/collect/mod.rs` — pull 경로 UsageEvent 조립 시 host 채움
- [ ] `fixtures/usage-event.golden.json` — host 항목(일부 null)
- [ ] **push 경로 host 부착** — `apps/web/app/api/v1/logs/route.ts` provider 그룹 루프의 `normalized.map(u => UsageEvent)` 에서 그룹 `recs` 의 `resourceAttrs['toard.host']`(폴백 `host.name`)를 읽어 각 이벤트에 실음. **normalizer/어댑터 무수정**(NormalizedUsage 는 host 없음 — §5)
- [ ] `apps/web/lib/sanitize.ts` — (현재 denylist 라 무변경이나) **주석에 "whitelist 전환 시 `toard.host`·`host.name` 보존 필수" 명시**
- [ ] **host 살균 공용 헬퍼(수렴 지점 1곳)** — 길이 절단(≤255)·제어문자 제거·trim-후-빈값→NULL 을 **양 라우트 finalize**(events `.map`/logs `.map`) 또는 core/ingest 공용 함수에서 수행. **특정 백엔드 안에 넣지 않음**(PG/CH 양쪽 커버)
- [ ] `migrations/1700000011_usage_event_host.sql` — 컬럼 + 인덱스(+ CH 미러)
- [ ] `packages/storage-postgres/src/storage.ts` — `byHost`(=`modelBreakdown` 복제, `periodWhere` 재사용 → provider 필터 자동 미러) + **`getUserHosts`(언바운드 `MAX(ts)`·`COUNT(*)`)** + `getUserUsage` 확장 + INSERT 에 `host` 컬럼·`$14`(=`e.host ?? null`, `log_adapter` 와 동형)
- [ ] `packages/storage-clickhouse/src/storage.ts` — 이벤트 row 객체에 `host` + `byHost`·`getUserHosts` 동형(ReplacingMergeTree+FINAL), `NULL`/`''` 를 동일 "(알 수 없음)" 정규화
- [ ] `apps/web/app/(dashboard)/page.tsx` — 컴퓨터별 사용량 분해 섹션(표시 라벨 축약 옵션)
- [ ] `apps/web/app/(dashboard)/settings/` — "설치·토큰" 탭에 **내 기기 목록**(`getUserHosts`: host·마지막 수신·이벤트 수) + 전송 항목 고지 + 옵트아웃/별칭 안내
- [ ] `.env.example` / 설치 안내 — `TOARD_DISABLE_HOST`·`TOARD_HOST_LABEL` 문서화
- [ ] 테스트: wire 골든 왕복(TS↔Rust), dedup 불변 회귀, `byHost` 단위(provider 필터·NULL 버킷·기간 스코프), **`getUserHosts` 단위(유휴 기기 노출·언바운드 `MAX(ts)`)**, host 살균(길이 절단·빈값→NULL), 백필 NULL 처리

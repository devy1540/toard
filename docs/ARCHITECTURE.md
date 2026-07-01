# toard 아키텍처 설계

> **상태:** v2 (4개 정밀 검토 반영) · **최종 수정:** 2026-06-30 · **범위:** 1차 설계
>
> v1 대비: dedup 키 교정(`request_id`), shim env 정정, 수집 방식 확정(앱 직접 + JSON only), 인증 확정(Auth.js), 비용 계산 정확화(tiered/캐시/단위), 보안 강화. 가장 되돌리기 비싼 부분은 **§4 데이터 모델**과 **§5 수집 계약**이다.

---

## 1. 개요 & 목표

### 1.1 정의
toard는 사내 AI 코딩 도구(Claude Code, Codex 등)의 **사용량·비용을 추적하는 경량 멀티 프로바이더 대시보드**다. day1co(사내) · zeude · ccusage를 벤치마킹해 **"더 가볍고 잘 만든"** 버전을 목표로 한다.

### 1.2 배경 — 세 레퍼런스 벤치마킹

| 프로젝트 | 구현 | 수집 | 저장 | toard가 가져온 것 |
|---|---|---|---|---|
| **day1co** | TS/Next, `pg`, 최소 의존성(~십수~20개) | Hook script (push) | PostgreSQL + Mart | 의존성 미니멀리즘, Mart 집계·upsert, LiteLLM 동기화, KST 처리 |
| **zeude** | Go shim + TS/Next | OTEL shim → Collector | PostgreSQL + ClickHouse | OTEL 표준, 프로바이더 정규화, TanStack Query |
| **ccusage** | TS(+Rust 포팅 진행), npx | 로컬 JSONL (pull) | 영속 없음 | 비용 모드(display/auto/calculate), `message.id+request_id` dedup |

> 검증 노트: ccusage는 TypeScript 본체(+Rust 포팅)이며 가격 소스로 LiteLLM과 **models.dev를 동급으로** prefetch한다. 모델 별칭은 ccusage가 8자리(YYYYMMDD) 날짜접미사 정규화를 실제로 수행하므로 그 패턴을 차용한다(§6.4).

### 1.3 설계 철학
1. **가볍게 시작, 무손실 확장** — 불확실한 규모를 위해 미리 짊어지지 않되, 이관을 봉쇄하는 결정은 피한다.
2. **표준 우선** — 수집은 OTLP 표준. 단 1차는 디코딩 부담이 적은 **OTLP/JSON**만 1급 지원.
3. **역할 분리** — OLTP(메타·인증)는 Postgres, OLAP(이벤트 집계)는 필요 시 ClickHouse.
4. **의존성 미니멀리즘** — day1co의 최소 의존성 수준 지향.
5. **되돌리기 비싼 것만 신중히** — 데이터 모델·수집 계약은 정밀하게, 화면·표현은 가볍게.

### 1.4 1차 범위 / 비범위

**1차 범위 (In Scope)**
- **shim** — Claude Code 텔레메트리 활성화 + 식별자 주입 (투명 wrapping)
- 멀티 프로바이더 **수집** (앱 직접 OTLP/JSON 수신)
- **비용/사용량 차트** (KPI 카드 + 시계열)
- **개인 마이페이지** (자기 사용량 + 모델별 분해)
- **리더보드 / 부서별 비교**

**1차 비범위 (Out of Scope, 추후)**
- OTEL Collector(진화 경로 — §ADR-001) · ClickHouse 모드(옵트인) · metrics 수신(logs만)
- 중앙 설정 배포(zeude Delivery) · LLM 분류/해석(day1co 2차) · Tier 2 로그파일 adapter

---

## 2. 아키텍처 결정 기록 (ADR)

### ADR-001 — 수집: 앱이 OTLP/JSON 직접 수신 (Collector는 진화 경로)
- **결정:** shim이 Claude Code 텔레메트리를 켜고, 텔레메트리는 toard 앱의 OTLP/HTTP 엔드포인트가 **`http/json`으로 직접 수신**한다. **Collector를 두지 않는다.**
- **근거:** Claude Code는 `http/json` 프로토콜을 지원하므로 앱은 표준 `JSON.parse`로 OTLP 로그 트리를 읽을 수 있다(protobuf 디코더 자체구현 불필요). 인프라가 앱 하나로 끝난다.
- **트레이드오프(정직하게):** Collector의 retry 버퍼가 없어 **앱 재시작·배포 중 도착 배치가 유실**될 수 있다. → **무중단 배포(rolling/blue-green)를 운영 제약으로 강제**(단일 인스턴스가 순간 0이 되는 배포 금지)해 유실을 0에 수렴시킨다.
- **기각/진화:** ① 경량 Collector(zeude식) — 유실 0·검증됨이지만 인프라 +1, 1차엔 과함. **유실이 실제 문제로 드러나면 Collector를 추가**(앱 코드 무변경, shim endpoint만 Collector로). ② protobuf 수신 — 디코더 유지부담으로 1차 제외(JSON only).

### ADR-002 — 멀티 프로바이더: 2-tier 수집
- **결정:** OTEL 지원 도구(Claude Code·Codex)는 **OTLP 수신 + 앱 정규화**, OTEL 미지원 도구는 **로컬 로그 adapter 파싱**(ccusage식)을 폴백으로(2차).
- **근거:** 정규화 지점을 앱(`packages/ingest`)에 두면 프로바이더 추가가 normalizer 하나 단위로 선형 확장.

### ADR-003 — 저장: Pluggable backend (기본 PG, 옵트인 CH)
- **결정:** `StorageBackend` 인터페이스로 저장을 추상화. **기본 = Postgres 단일**(메타+이벤트+Mart). **옵트인 = ClickHouse 모드**(이벤트·집계만 CH, 메타·인증은 항상 PG).
- **근거:** 연 수천만~1억 행까진 PG로 충분(day1co 증거). OLTP는 어느 모드든 PG.
- **기각:** ClickHouse 단일 — 트랜잭션·FK·인증·도구 부재로 기각(PostHog도 메타는 PG).

### ADR-004 — 비용: LiteLLM 기반 엔진 (per-million 저장)
- **결정:** LiteLLM(+models.dev 보조) 가격을 **per-million USD로 저장**하고 토큰→USD 계산. 캐시·fast·200k+ 차등 지원.
- **근거:** day1co·zeude 모두 per-million 저장으로 float 정밀도 손실을 줄인다. ccusage 비용 모드(display/auto/calculate)는 정합.

### ADR-005 — 프론트엔드: Next.js 15 + TanStack Query + shadcn/ui + Recharts
- **결정/근거:** 세 벤치마크 공통 스택. TanStack Query는 zeude 검증.

### ADR-006 — shim: 1차 범위 포함, 언어 Rust 확정
- **결정:** shim을 1차부터 포함(투명 wrapping + 자동 업데이트). **언어 = Rust**(2026-06-30 확정 — PoC 측정 + 팀 선택). `claude`/`codex` 이름으로 설치돼 PATH resolver 로 진짜 바이너리를 exec(자기 자신 제외)하며, `~/.toard/credentials`(또는 env)에서 token·endpoint 를 로딩한다.
- **근거:** shim은 OTEL SDK 없는 얇은 래퍼. Go=크로스컴파일 간편, Rust=바이너리 작음. (배포는 Rust/Go 바이너리를 npm `optionalDependencies`로 푸는 일반 패턴 활용 — 이는 ccusage 고유가 아닌 esbuild/swc류 표준 기법.)
- **기각:** "1차엔 설치 스크립트만" — 매 실행 동기화·자동 업데이트 부재로 기각.
- **PoC 결과(2026-06-30, `shim/`):** Go·Rust 동일 기능 구현·측정 — 바이너리 **Go 1.4MB vs Rust 312KB(4.4배 작음)**, cold start **Rust 우위**(20회 exec 0.17s vs Go 0.27s). 둘 다 env 주입 + exec end-to-end 동작(shim → 대역 도구 → toard 수신, 멱등 dedup까지 검증). → 크기·cold start 우위로 **Rust 채택**(L70 확정). 배포 파이프라인(GitHub Actions OS 네이티브 매트릭스 4-플랫폼 + `install.sh`/`npx @toard/shim`)까지 구축 완료.

### ADR-007 — 인증: Auth.js (NextAuth), AUTH_MODE + JWT 세션
- **결정:** 인증은 **Auth.js**. 계정·user 는 **Postgres**(adapter), 세션은 **JWT**(Credentials 는 database 세션 미지원). `AUTH_MODE` 로 배포 시 선택: `oauth`(GitHub/Google **+ id/pw credentials**)·`open`(인증 없음·내부망 전제). credentials 는 `AUTH_CREDENTIALS_ENABLED`(기본 on)로 토글 — 로그인 `/login`·가입 `/signup`(도메인 게이팅)·비번 변경/설정 `/settings`. 비번은 **bcrypt(cost 12)** 해시로만 저장. magic-link 는 확장 예정. 이메일 도메인 제한 + 검증된 identity.
- **근거:** ADR-003(메타·계정은 항상 PG)과 일치. 조직마다 인증 요구가 달라(OAuth 불필요한 내부망 조직도 존재) 모드 선택이 필요. Supabase Auth(zeude·day1co) 대비 외부 종속 없음. **JWT 트레이드오프:** 강제 로그아웃 즉시성은 토큰 만료/블랙리스트로 보완(database 세션의 즉시 무효화는 포기). **credentials 보안:** 기존 OAuth 이메일로는 가입 불가(계정 탈취 방지), 미존재/OAuth 전용 계정도 더미 해시 비교로 사용자 열거(timing) 완화.

---

## 3. 모노레포 구조

### 3.1 디렉토리 레이아웃 (pnpm workspace)

```
toard/
├── apps/
│   └── web/                      # Next.js 15 (App Router)
│       ├── app/
│       │   ├── api/v1/logs/route.ts   # OTLP/JSON 수신 (logs only)
│       │   ├── api/tokens/route.ts    # ingest token 발급/폐기
│       │   ├── api/stats/...           # 대시보드 쿼리 API
│       │   ├── (dashboard)/            # 대시보드 레이아웃 (+ /settings 비번 변경)
│       │   └── login/ · signup/        # 로그인·가입 (OAuth + id/pw)
│       └── components/
├── packages/
│   ├── core/                     # 도메인 타입 + StorageBackend 인터페이스 (의존성 0)
│   ├── ingest/                   # OTLP/JSON 파싱 + 프로바이더 정규화 (provider 식별·dedup키 생성)
│   ├── pricing/                  # LiteLLM 비용 엔진 (resolveCost)
│   └── storage-postgres/         # PG 구현체 (추후: storage-clickhouse)
├── shim/                         # OTEL shim (Rust — ADR-006)
├── migrations/                   # 순수 SQL 마이그레이션 (node-pg-migrate)
├── docker-compose.dev.yml        # 로컬 Postgres
├── .env.example
├── docs/ARCHITECTURE.md
├── package.json · pnpm-workspace.yaml
```

### 3.2 패키지 책임과 의존 방향

| 패키지 | 책임 | 의존 |
|---|---|---|
| `core` | 도메인 타입, `StorageBackend` 인터페이스, enum | **없음** |
| `ingest` | OTLP/JSON 트리 파싱, provider 식별, 정규화(`UsageEvent[]`), dedup_key 생성 | `core` |
| `pricing` | LiteLLM 동기화, `resolveCost`(토큰→USD) | `core` |
| `storage-postgres` | `StorageBackend` PG 구현(이벤트 저장 + Mart + 쿼리) | `core` |
| `apps/web` | route handler(bytes→`ingest`), 대시보드, Auth.js, 비용 채움 | 위 전부 |
| `shim` | 텔레메트리 env 주입 + exec (별도 빌드) | 독립 |

- **의존은 항상 `core`로** 흐른다(순환 없음). 비용 계산은 `ingest`가 아니라 **수집 라우트에서 정규화 직후 `pricing.resolveCost`를 별도 단계로 호출**(테스트 격리 — `ingest`는 토큰까지만).
- route handler는 raw bytes를 `ingest`에 넘기고, `ingest`가 JSON 파싱·정규화를 책임진다.

### 3.3 빌드 도구
- **pnpm workspace** + **TypeScript(strict)**. 마이그레이션 = **순수 SQL + node-pg-migrate**, 쿼리 = `pg` raw(StorageBackend 내부). `shim`은 별도 툴체인.

---

## 4. 데이터 모델

> **가장 되돌리기 비싼 섹션.** `StorageBackend` 계약과 스키마는 수집·비용·프론트가 모두 의존한다.

### 4.1 `StorageBackend` 인터페이스 (`packages/core`)

```ts
// packages/core/src/storage.ts

export interface PeriodQuery {
  from: Date;             // UTC, inclusive
  to: Date;               // UTC, exclusive
  providerKey?: string;   // 미지정 = 전체
}

/** 정규화된 사용 이벤트 — 모든 프로바이더가 이 형태로 수렴.
 *  불변식: inputTokens는 항상 "캐시 제외 신규 입력 토큰"(normalizer가 프로바이더별로 보정).
 *          Claude는 cache_read/creation이 input과 별개(가산), OpenAI/Codex는 cached가 input의 부분집합이므로
 *          Codex normalizer가 inputTokens = input_token_count - cached_token_count 로 보정한다. */
export interface UsageEvent {
  dedupKey: string;           // hash(request_id, model, input,output,cacheRead,cacheCreation). request_id 없으면 hash(session.id, event.sequence, ts, input+output) — prompt.id는 api_request에 없을 수 있어 미사용
  providerKey: string;        // 'claude_code' | 'codex'
  userId: string | null;      // 미식별 시 null (등록 후 소급)
  sessionId: string | null;
  model: string | null;
  ts: Date;                   // 발생 시각 (UTC)
  inputTokens: number;        // 캐시 제외 신규 입력
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;            // pricing이 채움
}

export interface OverviewStats {
  totalSessions: number;
  activeUsers: number;        // 기간 내 DISTINCT user
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export interface DailyPoint { day: string; sessions: number; costUsd: number; inputTokens: number; outputTokens: number; }
export interface ModelBreakdown { model: string; costUsd: number; totalTokens: number; sessions: number; }
export interface LeaderRow { key: string; label: string; costUsd: number; totalTokens: number; sessions: number; }

export interface StorageBackend {
  // ─ 쓰기 ─
  saveRawEvent(providerKey: string, payload: unknown): Promise<number>;
  /** 멱등 저장(dedup) + 일별 Mart 증분(SUM 지표) — 동일 트랜잭션 */
  saveUsageEvents(events: UsageEvent[]): Promise<{ inserted: number; deduped: number }>;
  /** 마감된 날짜의 Mart 전체 재계산(SUM+DISTINCT) — dirty 집합 대상 */
  recomputeDaily(days: { day: string }[]): Promise<void>;

  // ─ 읽기 ─
  getOverview(q: PeriodQuery): Promise<OverviewStats>;
  getDailyTimeseries(q: PeriodQuery & { scope?: 'all' | 'department'; departmentId?: string }): Promise<DailyPoint[]>;
  getUserUsage(userId: string, q: PeriodQuery): Promise<{ overview: OverviewStats; daily: DailyPoint[]; byModel: ModelBreakdown[] }>;
  getLeaderboard(q: PeriodQuery & { scope: 'user' | 'department' }): Promise<LeaderRow[]>;
}
```

> 메타(users/departments) CRUD·인증은 인터페이스 밖(항상 PG, ADR-003). `StorageBackend`는 "이벤트 저장 + 분석 쿼리"만.

### 4.2 Postgres 스키마 (기본 모드)

#### 메타데이터 (항상 PG)
```sql
CREATE TABLE departments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  parent_id UUID REFERENCES departments(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  department_id UUID REFERENCES departments(id),
  role TEXT NOT NULL DEFAULT 'member',          -- 'member' | 'admin'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 부서 이동 이력(1차 비활성, users.department_id로 운영)
CREATE TABLE user_department_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  department_id UUID NOT NULL REFERENCES departments(id),
  effective_from DATE NOT NULL, effective_to DATE,
  UNIQUE (user_id, effective_from)
);

CREATE TABLE providers (
  key TEXT PRIMARY KEY,                           -- 'claude_code' | 'codex'
  display_name TEXT NOT NULL,
  service_name_patterns TEXT[] NOT NULL,          -- OTLP service.name → provider 식별 (예: ['claude-code'], ['codex','codex_cli_rs'])
  collection_method TEXT NOT NULL,                -- 'otel' | 'logfile'
  enabled BOOLEAN NOT NULL DEFAULT true
);

-- shim 인증 토큰 (SHA-256 해시 저장, 평문 1회만 노출)
CREATE TABLE ingest_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,                -- sha256(고엔트로피 랜덤), 상수시간 조회
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,                          -- 만료
  revoked_at TIMESTAMPTZ                           -- 폐기/회전
);
```

#### 이벤트
```sql
CREATE TABLE raw_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  provider_key TEXT NOT NULL,
  payload JSONB NOT NULL,                          -- OTLP/JSON 원형(프롬프트 필드는 수신 단계에서 이미 제거 — §10.3)
  processed BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX ON raw_events (processed, received_at);

CREATE TABLE usage_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dedup_key TEXT NOT NULL UNIQUE,                  -- §4.4 (request_id 기반)
  provider_key TEXT NOT NULL REFERENCES providers(key),
  user_id UUID REFERENCES users(id),
  session_id TEXT, model TEXT,
  ts TIMESTAMPTZ NOT NULL,
  input_tokens BIGINT NOT NULL DEFAULT 0,          -- 캐시 제외 신규 입력
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens BIGINT NOT NULL DEFAULT 0,
  cache_creation_tokens BIGINT NOT NULL DEFAULT 0,
  cost_usd NUMERIC(14,8) NOT NULL DEFAULT 0,       -- 정밀도 확대(소액 캐시 라운딩 방지)
  raw_event_id BIGINT REFERENCES raw_events(id)
);
CREATE INDEX ON usage_events (user_id, ts);
CREATE INDEX ON usage_events (provider_key, ts);   -- 프로바이더 필터 + 기간
CREATE INDEX ON usage_events (ts, provider_key, user_id);  -- 재계산 커버링
CREATE INDEX ON usage_events (session_id);
-- 규모 증가 시 ts 월별 RANGE 파티셔닝
```

#### Mart (일별 집계)
```sql
CREATE TABLE usage_daily_user (
  user_id UUID NOT NULL REFERENCES users(id),
  day DATE NOT NULL,                              -- KST: (ts AT TIME ZONE 'Asia/Seoul')::date
  provider_key TEXT NOT NULL REFERENCES providers(key),
  request_count BIGINT NOT NULL DEFAULT 0,        -- 증분 SUM
  sessions INT NOT NULL DEFAULT 0,                -- DISTINCT → 재계산만
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens BIGINT NOT NULL DEFAULT 0,
  cache_creation_tokens BIGINT NOT NULL DEFAULT 0,
  cost_usd NUMERIC(16,8) NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, provider_key)
);

CREATE TABLE usage_daily_department (
  department_id UUID NOT NULL REFERENCES departments(id),
  day DATE NOT NULL,
  provider_key TEXT NOT NULL REFERENCES providers(key),
  request_count BIGINT NOT NULL DEFAULT 0,
  active_users INT NOT NULL DEFAULT 0,            -- DISTINCT → 재계산만
  sessions INT NOT NULL DEFAULT 0,               -- DISTINCT → 재계산만
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cost_usd NUMERIC(16,8) NOT NULL DEFAULT 0,
  PRIMARY KEY (department_id, day, provider_key)
);
CREATE INDEX ON usage_daily_user (day, provider_key);
CREATE INDEX ON usage_daily_department (day, provider_key);
```

### 4.3 ClickHouse 모드 (옵트인)
메타는 PG에 그대로. 이벤트·집계만 CH. **부서 시점 귀속을 위해 수집 시점의 `department_id`를 비정규화**한다.
```sql
CREATE TABLE usage_events (
  dedup_key String, provider_key LowCardinality(String),
  user_id String, department_id String,           -- 수집 시점 스냅샷(시점 귀속)
  session_id String, model LowCardinality(String),
  ts DateTime64(3,'UTC'),
  input_tokens UInt64, output_tokens UInt64, cache_read_tokens UInt64, cache_creation_tokens UInt64,
  cost_usd Decimal(18,8)
) ENGINE = ReplacingMergeTree ORDER BY (user_id, ts, dedup_key);

CREATE MATERIALIZED VIEW usage_daily_user_mv ENGINE = SummingMergeTree
ORDER BY (user_id, day, provider_key) AS
SELECT user_id, toDate(ts,'Asia/Seoul') AS day, provider_key,
  uniqState(session_id) AS sessions, sum(input_tokens) AS input_tokens, /* … */ sum(cost_usd) AS cost_usd
FROM usage_events GROUP BY user_id, day, provider_key;
```
> CH는 `department_id`를 이벤트에 동봉하므로 부서 GROUP BY가 PG 모드와 **동일 의미**(시점 귀속)로 성립한다. 리더보드 라벨(이름)만 PG에서 머지. 부서별 DISTINCT(`active_users`·`sessions`)는 `usage_daily_department_mv`(AggregatingMergeTree, `uniqState(user_id)`/`uniqState(session_id)`, `department_id` GROUP BY) 또는 `usage_events`에서 `uniq()` 직접 쿼리로 산출.

### 4.4 핵심 설계 노트

| 항목 | 결정 |
|---|---|
| **dedup** | `dedup_key = hash(request_id, model, input/output/cache_read/cache_creation tokens)`. `request_id`(= Anthropic API request-id, `claude_code.api_request` 로그 이벤트에 실재)가 1차 키. 없으면 `hash(session.id, event.sequence, ts, input+output 토큰)`(`prompt.id`는 `api_request`에 없을 수 있어 미사용). **TraceId/SpanId는 베타에서만 생기고 기본 모드엔 비어 있어 키로 부적합 → 미사용.** PG=`UNIQUE`+`ON CONFLICT DO NOTHING`, CH=`ReplacingMergeTree`. |
| **provider 식별** | OTLP `ResourceAttributes['service.name']`을 `providers.service_name_patterns`와 매칭해 `provider_key` 도출. (Codex는 `service.name`이 `codex`/`codex_cli_rs`.) |
| **무손실 보존** | `raw_events`에 OTLP/JSON 원형(프롬프트 제거 후) 저장 → 재처리·CH 백필. raw 멱등은 비강제(원형 보존 목적), 중복분은 usage dedup이 흡수·재처리 시 무해. |
| **토큰·비용 권위 소스** | **logs**(`api_request` 이벤트). metrics에도 토큰 카운터가 있으나 per-event 정확도·dedup·세션 귀속 위해 logs를 SSOT로 채택, **metrics는 1차 미수신**(§5.2). 비용은 `pricing_models`로 재계산(제공 `cost_usd`는 `auto` 모드 fallback). |
| **Mart 갱신** | SUM 지표(토큰·비용·`request_count`)는 **당일(미마감)에만** 증분 upsert. DISTINCT(`sessions`·`active_users`)와 **마감된 과거 날짜**는 항상 `recomputeDaily`(DELETE 후 `usage_events`에서 통째 재INSERT). 재처리·지연도착이 건드린 `(user_id, day)`를 dirty로 마킹 → cron이 그 집합만 재계산. |
| **데이터 보존(TTL)** | `raw_events`=처리 후 14일. `usage_events`=365일(파티션 드롭). Mart=영속. |
| **타임존** | `ts`=UTC `timestamptz`. Mart `day`=`(ts AT TIME ZONE 'Asia/Seoul')::date`로 **SQL 고정**(서버 TZ 비의존). 필터의 KST→UTC 환산은 앱이 책임. |
| **사용자 매칭** | **인증 토큰의 user_id가 유일·최종 권위.** resource attribute의 user.id/email은 **신뢰하지 않음**(토큰 없을 때만 email로 임시 귀속 후 등록 시 소급). §10.1과 일치. |

> **1차 구현 한계 (검증 반영, 2026-06-30)**
> - **서빙은 event-direct**: 대시보드 쿼리는 `usage_events`를 직접 집계하며 Mart(`usage_daily_*`)·`bumpDailyUser`·`recomputeDaily`는 **미래 서빙 레이어로 현재 미사용**(데이터 규모가 커지면 읽기를 Mart로 전환). 따라서 "당일 증분 vs 마감 재계산 정합"은 현재 사용자 화면과 무관.
> - **재처리 미구현**: `raw_events.processed`·`usage_events.raw_event_id` 연결과 raw→usage 재생성은 2차 목표. 현재 `processed`는 항상 false, `raw_event_id`는 NULL.
> - **부서 백필 없음**: `department_id` 비정규화는 수집(INSERT) 시점부터 적용되어, 마이그레이션 이전 이벤트는 부서 집계에서 제외(과거 시점 부서를 알 수 없어 NULL 유지).
> - **기간 필터 KST 미정렬**: `recentPeriod`는 UTC 롤링 윈도라 KST 일경계와 어긋나 일별 차트 양끝이 부분일로 표시(향후 KST 일경계 스냅 예정).

---

## 5. 수집 파이프라인

### 5.1 전체 흐름 + shim env
```
[개발자 머신] shim (claude 래핑)
  주입 env:
    CLAUDE_CODE_ENABLE_TELEMETRY=1
    OTEL_LOGS_EXPORTER=otlp                 # ← 없으면 logs 미방출(필수)
    OTEL_METRICS_EXPORTER=none              # 1차 logs only
    OTEL_EXPORTER_OTLP_PROTOCOL=http/json   # ← 앱이 JSON 파싱(필수)
    OTEL_EXPORTER_OTLP_ENDPOINT=https://toard.example.com/api    # base — SDK가 /v1/logs 자동 append
    OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <ingest_token>
    OTEL_RESOURCE_ATTRIBUTES=toard.user.id=…(표시용)  # 권위는 토큰(§10.1)
  └ exec 실제 claude
       ↓ (OTLP/HTTP JSON, POST …/api/v1/logs)
[toard 앱] app/api/v1/logs/route.ts
  1. 인증        ingest_token(SHA-256) → user_id 확정
  2. raw 저장     프롬프트 필드 제거 후 raw_events INSERT → 빠른 2xx
  3. 파싱·정규화  ingest: JSON 트리(ResourceLogs→…)→ provider 식별 → UsageEvent[]
  4. 비용        pricing.resolveCost로 costUsd 채움
  5. 멱등 저장    storage.saveUsageEvents (dedup + 당일 Mart 증분)
```

### 5.2 수신 엔드포인트
- `POST /api/v1/logs`만 1차 구현(**OTLP/JSON**). `OTEL_EXPORTER_OTLP_ENDPOINT`는 **base URL**(`…/api`)이고 SDK가 `/v1/logs`를 붙인다 → 라우트 `app/api/v1/logs/route.ts`와 정합. **`/api/v1/metrics`는 1차 미구현**(`OTEL_METRICS_EXPORTER=none`으로 애초에 안 옴).
- **수신 신뢰성:** Collector가 없어 앱 다운·배포 중 배치는 유실 가능(SDK 무한버퍼 아님). → **무중단 배포 필수**(ADR-001). raw 진입 후는 무손실(`processed` 재처리). 유실이 문제화되면 Collector 추가.

### 5.3 정규화 (`packages/ingest`)
```ts
export interface ProviderNormalizer { providerKey: string; normalize(input: NormalizeInput, ctx: NormalizeContext): UsageEvent[]; }
```
- **`claude_code.api_request` 이벤트만**(prefix 포함, `event.name` 매칭) `UsageEvent`로(토큰 0·prompt/tool 이벤트 제외 → `request_count` 정확).
- **Claude Code:** `input_tokens`/`output_tokens`/`cache_read_tokens`/`cache_creation_tokens` 그대로(input과 캐시는 별개·가산).
- **Codex:** `input_token_count→inputTokens`, `output_token_count→outputTokens`, `cached_token_count→cacheReadTokens`, `conversation.id→sessionId`. **`inputTokens = input_token_count − cached_token_count`**(부분집합 보정), `cacheCreationTokens=0`(Codex 미제공), `cost 없음→pricing 계산`. (Codex는 env가 아니라 config.toml 주입 — 2차 §9.)

### 5.4 인증
- `Authorization: Bearer <ingest_token>` → `sha256` 조회 → `user_id` 확정, `last_used_at` 갱신. 만료/폐기 토큰은 401.
- resource attribute의 user.id/email은 **무시**(표시·디버그용). 토큰 없을 때만 email 보조 귀속(미식별 NULL 수용).

### 5.5 처리 순서·멱등성
1. raw 저장(프롬프트 제거) → 2xx  2. 정규화(`dedup_key` 생성)  3. `pricing.resolveCost`  4. `saveUsageEvents`(`ON CONFLICT (dedup_key) DO NOTHING` + 당일 Mart 증분, 동일 트랜잭션)  5. `processed=true`
- 멱등성: `dedup_key`(request_id 기반) UNIQUE. 복구: `processed=false` 재처리(정규화 변경 시 raw에서 재생성).

---

## 6. 비용 엔진 (`packages/pricing`)

### 6.1 가격 소스
- LiteLLM `model_prices_and_context_window.json` + **models.dev(동급 보조소스)**. 둘 다 prefetch해 머지(ccusage 패턴). **단위 주의:** LiteLLM은 per-token, models.dev는 per-million → **저장은 per-million으로 통일**(ADR-004).

### 6.2 동기화 & 스키마
- 일일 cron + 배포 스냅샷 fallback. **fetch 실패뿐 아니라 "200+0건 파싱"도 스냅샷 유지**(가드). 동기화 후 sanity check(±N% 초과 변동 경보).
```sql
CREATE TABLE pricing_models (
  model_id TEXT NOT NULL,
  input_price_per_mtok NUMERIC NOT NULL,          -- per-million USD
  output_price_per_mtok NUMERIC NOT NULL,
  cache_read_price_per_mtok NUMERIC,
  cache_creation_price_per_mtok NUMERIC,
  input_price_above_200k_per_mtok NUMERIC,
  output_price_above_200k_per_mtok NUMERIC,
  fast_multiplier NUMERIC NOT NULL DEFAULT 1,      -- LiteLLM 부재 → 수동 override 시드
  effective_date DATE NOT NULL,
  source TEXT NOT NULL DEFAULT 'litellm',
  PRIMARY KEY (model_id, effective_date)
);
-- 최신가 조회(PG): DISTINCT ON (model_id) … ORDER BY model_id, effective_date DESC  (argMax는 CH 전용)
```

### 6.3 계산 (`resolveCost`)
```ts
export type CostMode = 'display' | 'auto' | 'calculate';

// 구간 누적: 처음 200k는 기본가, 초과분만 차등가 (ccusage tiered_cost)
function tiered(tokens: number, basePerM: number, abovePerM?: number): number {
  const TIER = 200_000;
  if (abovePerM == null || tokens <= TIER) return tokens * basePerM / 1e6;
  return (TIER * basePerM + (tokens - TIER) * abovePerM) / 1e6;
}

export function resolveCost(a: {
  model: string|null; inputTokens; outputTokens; cacheReadTokens; cacheCreationTokens;
  isFast?: boolean; providedCostUsd?: number|null; pricing: PricingMap; mode?: CostMode;
}): number {
  const mode = a.mode ?? 'auto';
  if (mode === 'display') return a.providedCostUsd ?? 0;
  if (mode === 'auto' && a.providedCostUsd != null) return a.providedCostUsd;
  const p = resolvePricing(a.model, a.pricing);          // 풀ID 우선 조회 → 미스 시 별칭(§6.4)
  if (!p) return 0;                                       // 미상 모델 0 + 경고
  // 캐시생성 fallback = input × 1.25(Anthropic 표준), 캐시읽기 = input × 0.1. 단 OpenAI/Codex는 cacheCreation=0 고정.
  const cacheCreateBase = p.cacheCreatePerM ?? p.inputPerM * 1.25;
  const cacheReadBase   = p.cacheReadPerM   ?? p.inputPerM * 0.1;
  let cost = tiered(a.inputTokens,  p.inputPerM,  p.inputAbove200kPerM)
           + tiered(a.outputTokens, p.outputPerM, p.outputAbove200kPerM)
           + a.cacheReadTokens     * cacheReadBase   / 1e6   // 캐시는 200k tiered 미적용(아래 주석)
           + a.cacheCreationTokens * cacheCreateBase / 1e6;
  return a.isFast ? cost * (p.fastMultiplier ?? 1) : cost;
}
```
- **모드:** display/auto/calculate (ccusage 정합).
- **프로바이더 차이:** Claude는 cost 제공→`auto` 그대로 / Codex는 미제공→계산, `cacheCreationTokens=0`(§5.3). `inputTokens`는 이미 캐시 제외(§4.1 불변식)이므로 이중계상 없음.
- **fast:** `api_request`의 `speed` 어트리뷰트로 `isFast` 판정. 단위는 전부 per-million → `/1e6`.
- **캐시 200k 차등(ccusage와 의도적 차이):** ccusage는 캐시 토큰에도 tiered를 적용하지만, toard는 **캐시는 단순 곱(200k tiered 미적용)**. 사내 주력 모델에서 캐시 above-200k 영향이 미미하다고 판단해 `pricing_models`에 `cache_*_above_200k` 컬럼을 두지 않는다. 정밀도가 필요해지면 컬럼+tiered 추가.

### 6.4 모델 별칭 (ccusage 8자리 날짜 정규화 패턴 차용)
- **풀 모델ID로 LiteLLM 직접 조회 우선**(LiteLLM 키는 날짜 포함 풀ID). 미스 시에만 폴백: ① 벤더 프리픽스 strip(`anthropic.`, `openai/`, `bedrock/`), ② **8자리(YYYYMMDD) 접미사일 때만 날짜 제거**(ccusage `MODEL_DATE_SUFFIX_DIGITS=8` 패턴), ③ 부분문자열 fuzzy(가장 긴 키 우선), ④ 수동 별칭 맵.

---

## 7. 프론트엔드 (`apps/web`)

### 7.1 데이터 흐름
- 초기: Server Component가 `StorageBackend` 직접 호출(SSR). 갱신: TanStack Query가 `/api/stats/*` 호출.
- 컴포넌트는 백엔드(PG/CH) 모름(ADR-003).

### 7.2 라우트
```
app/
├── (auth)/login/page.tsx                # Auth.js
├── (dashboard)/{layout,page,me,leaderboard}
└── api/
    ├── v1/logs/route.ts                  # OTLP/JSON 수신 (metrics 1차 미구현)
    ├── tokens/route.ts                   # POST 발급(평문 1회) · DELETE 폐기
    └── stats/{overview,timeseries,leaderboard}/route.ts
```

### 7.3 1차 화면
- **① 개요(`/`)**: KPI(총비용·총토큰·세션수·**활성 사용자**) + 일별 시계열 + 미니 리더보드. `getOverview`+`getDailyTimeseries`+`getLeaderboard`.
- **② 마이페이지(`/me`)**: 개인 KPI + 시계열 + **모델별 분해**. `getUserUsage`(`{overview, daily, byModel}`).
- **③ 리더보드/부서별(`/leaderboard`)**: 개인↔부서 토글, 정렬, 부서 비교 막대 + 부서 시계열. `getLeaderboard({scope})` + `getDailyTimeseries({scope:'department'})`.
- **④ 로그인(`/login`)**: Auth.js, 도메인 제한, setup(토큰 발급 + shim 설치).

### 7.4 공통/상태
- `DateRangeFilter`(KST), `ProviderFilter`. shadcn/ui + Recharts. TanStack Query(staleTime 30~60s). 필터는 URL searchParams.

### 7.5 권한
- `member`: 자기 마이페이지 + 공개 리더보드. `admin`: 전체 + 사용자/부서/프로바이더/토큰 관리. role은 **Auth.js 세션 클레임**으로 서버 검증.

### 7.6 온보딩
1. `/login`(Auth.js, 도메인 제한) → 2. 첫 로그인 시 `users` 생성 → 3. setup에서 `POST /api/tokens`로 ingest_token 발급(평문 1회) + OS별 shim 설치 → 4. 첫 텔레메트리 도착 시 `user_id` 매칭 → 5. 미식별(`NULL`) 이벤트는 email 매칭으로 소급.

---

## 8. 배포 · 인프라 · 로컬 개발

### 8.1 환경 변수
```bash
STORAGE_BACKEND=postgres                 # 'postgres'(기본) | 'clickhouse'
DATABASE_URL=postgres://…
CLICKHOUSE_URL=                          # CH 모드만
AUTH_SECRET=…                            # Auth.js
AUTH_TRUST_HOST=true
ALLOWED_EMAIL_DOMAINS=day1company.co.kr
INGEST_BASE_URL=https://toard.example.com/api   # shim OTEL_EXPORTER_OTLP_ENDPOINT (base)
LITELLM_PRICING_URL=…
BOOTSTRAP_ADMIN_EMAIL=…                  # 최초 admin 부트스트랩
```

### 8.2 배포
- Next.js **standalone** 단일 Docker 이미지 + 매니지드 Postgres. **무중단 배포(rolling/blue-green) 필수**(ADR-001 — 수집 유실 방지).
- cron: ① 가격 동기화(+sanity) ② 미처리 raw 재처리 ③ dirty 날짜 Mart 재계산.

### 8.3 로컬 개발 (스캐폴딩 대상)
- `docker-compose.dev.yml`(Postgres 16) + `.env.example`.
- 마이그레이션: `migrations/*.sql` + node-pg-migrate.
- seed: `providers`(`claude_code`/otel/`['claude-code']`, `codex`/otel/`['codex','codex_cli_rs']`) + `BOOTSTRAP_ADMIN_EMAIL` admin 1명 + dev ingest_token 1개.
- shim: `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3000/api`로 로컬 수신 테스트.

### 8.4 shim 배포
- Rust 바이너리(ADR-006), 4-플랫폼(OS 네이티브 매트릭스). 설치 스크립트(`install.sh`) 또는 `npx @toard/shim`. 온보딩은 §7.6.

---

## 9. 로드맵

| 단계 | 내용 |
|---|---|
| **1차 (MVP)** | shim + 앱 직접 수신(Claude Code, JSON) · PG 단일 · LiteLLM 비용 · 4개 화면 · Auth.js |
| **2차 (확장)** | Codex(config.toml 주입) · Tier2 로그파일 adapter · 부서 이동 이력 · OTEL Collector(유실 문제화 시) |
| **3차 (스케일·기능)** | ClickHouse 모드 · 중앙 설정 배포 · LLM 분류/해석 |

---

## 10. 보안 & 프라이버시

### 10.1 수집 인증 & 토큰 SSOT
- `ingest_token` = 고엔트로피(≥256bit) 랜덤, 저장은 **SHA-256**(상수시간·결정적·인덱스 조회), 발급 시 평문 1회만 노출.
- **이벤트 `user_id`는 인증 토큰 소유자로 강제.** resource attribute의 user.id/email은 신뢰하지 않음(공개 엔드포인트 위협모델 — env 위조 방지). §4.4·§5.4와 일치.

### 10.2 토큰 수명주기 & Rate limit
- `ingest_tokens.expires_at`(만료)·`revoked_at`(폐기/회전). 주기적 재발급 권장. admin이 타인 토큰 폐기 가능(§7.5).
- **Rate limit(수치):** 토큰당 ≤ N req/min(예 120), 일일 이벤트 상한, OTLP 배치 페이로드 ≤ 4MB(초과 413). 초과 시 429 + Retry-After. 카운터는 단일 인스턴스 인메모리(다중 시 Redis). 이상 탐지: 토큰별 IP 수·이벤트율 급증 경보.

### 10.3 PII / 프롬프트 미수집
- shim은 `OTEL_LOG_USER_PROMPTS`를 켜지 않음. **수신 최초 단계(raw_events INSERT 이전)에서** 프롬프트를 제거한다 — 권장은 **화이트리스트**(토큰/비용/식별 attribute만 보존, 나머지 자유텍스트 전부 폐기)로 신규 필드 누락 위험을 없앤다. 차선은 denylist(`prompt`, `prompt_text`, `Body`, `latest_user_message` 등). 결과적으로 프롬프트가 raw에도 남지 않음. (shim 우회 + 자기 토큰으로 직접 켜는 경우만 자기 프롬프트 유입, 위협 낮음.)

### 10.4 접근 제어
- Auth.js OAuth/이메일 identity 기반 도메인 제한(자칭 이메일 불가). 최초 admin은 `BOOTSTRAP_ADMIN_EMAIL`로 시드, 이후 role 변경은 감사 로그. ingest(토큰)와 dashboard(세션) 인증 분리.

---

## 11. 운영 · 관측 · 테스트

### 11.1 관측
- 수집 헬스(최근 수신 시각·분당 이벤트), raw 적체(`processed=false` 카운트), dirty Mart 적체, 가격 동기화 성공 시각.

### 11.2 테스트 (핵심만)
- `pricing`: tiered·캐시 fallback(1.25/0.1)·OpenAI cacheCreation=0·모드별·단위(per-million).
- `ingest`: provider 식별(service.name)·api_request 필터·Codex subset 보정·dedup_key 멱등.
- `storage-postgres`: 당일 증분 vs 마감 재계산 정합·dirty 재계산·KST day 경계.

---

## 부록 — 결정의 출처
- 의사결정 기록: 메모리 `toard-project-direction`, `benchmark-day1co-zeude`
- 벤치마킹 원본: `day1co-ai-usage-dashboard`, `zeude`, `ccusage`(`/Users/hjyoon/Develop/workspace/`)
- v2 근거: 4개 정밀 검토(데이터모델·수집/OTEL·비용/보안·일관성) + Claude Code OTEL 공식 스펙
- **변경 시 주의:** §4 데이터 모델·§5 수집 계약·§2 ADR을 함께 갱신(나머지가 의존).

# toard 아키텍처 설계

> **상태:** 현재 구현 SSOT · **최종 수정:** 2026-08-25
>
> 기본 사용량 수집은 Rust shim이 Claude Code·Codex·Gemini·Qwen의 로컬 session/transcript와 Cursor stop-hook 로그를 읽고 `UsageEvent[]`로 정규화해 `POST /api/v1/events`로 보내는 **pull-primary** 구조다. `POST /api/v1/logs` OTLP/JSON 수신은 `TOARD_EXPERIMENTAL_OTLP`로 명시적으로 켜는 experimental 호환 경로다.
>
> 과거 OTLP-first 설계와 1차·2차·3차 계획은 현재 실행 지침이 아니다. 전환 근거는 [design-usage-pull.md](design-usage-pull.md)에 변경 이력으로 보존한다.

---

## 1. 개요 & 목표

### 1.1 정의
toard는 조직(팀·회사)의 AI 코딩 도구 전반(Claude Code · Codex · Cursor · Gemini · Qwen 등)의 **사용량·비용을 추적하는 경량·범용 멀티 프로바이더 대시보드**다. **오픈소스·셀프호스팅이 전제**이며, 특정 조직에 묶인 가정은 설정으로 밀어낸다. 기본 경로는 로컬 파일 pull이고, OTLP push는 호환이 필요한 환경에서만 선택적으로 사용한다.

### 1.2 배경 — 세 레퍼런스 벤치마킹

| 프로젝트 | 구현 | 수집 | 저장 | toard가 가져온 것 |
|---|---|---|---|---|
| **day1co**(비공개 사내 선행작) | TS/Next, `pg`, 최소 의존성(~십수~20개) | Hook script (push) | PostgreSQL + Mart | 의존성 미니멀리즘, Mart 집계·upsert, LiteLLM 동기화, 타임존 일경계 처리 |
| **zeude** | Go shim + TS/Next | OTEL shim → Collector | PostgreSQL + ClickHouse | OTEL 표준, 프로바이더 정규화, TanStack Query |
| **ccusage** | TS(+Rust 포팅 진행), npx | 로컬 JSONL (pull) | 영속 없음 | 비용 모드(display/auto/calculate), `message.id+request_id` dedup |

> 검증 노트: ccusage는 TypeScript 본체(+Rust 포팅)이며 가격 소스로 LiteLLM과 **models.dev를 동급으로** prefetch한다. 모델 별칭은 ccusage가 8자리(YYYYMMDD) 날짜접미사 정규화를 실제로 수행하므로 그 패턴을 차용한다(§6.4).

### 1.3 설계 철학
1. **가볍게 시작, 무손실 확장** — 불확실한 규모를 위해 미리 짊어지지 않되, 이관을 봉쇄하는 결정은 피한다.
2. **pull-primary, 단일 수렴** — shim이 로컬 session/transcript를 읽어 모든 기본 provider를 **`UsageEvent[]` 한 형태로 수렴**시킨다(§4.1). OTLP/JSON push는 experimental이며 기본 수집의 우선 경로나 필수조건이 아니다.
3. **역할 분리** — OLTP(메타·인증)는 Postgres, OLAP(이벤트 집계)는 필요 시 ClickHouse.
4. **의존성 미니멀리즘** — 선행 벤치마크(day1co)의 최소 의존성 수준 지향.
5. **되돌리기 비싼 것만 신중히** — 데이터 모델·수집 계약은 정밀하게, 화면·표현은 가볍게.
6. **특정 조직 비의존** — 타임존·이메일 도메인 등 조직 고유 값은 하드코딩하지 않고 설정(env)으로 받는다. 어느 조직이든 그대로 배포 가능해야 한다(v4).

### 1.4 현재 지원 범위

| 상태 | 범위 |
|---|---|
| **기본 지원** | Rust shim 로컬 pull, Claude Code·Codex·Cursor·Gemini·Qwen 사용량, opt-in 본문, Claude/Codex/Cursor 도구 메타데이터, PostgreSQL, opt-in ClickHouse, 개인·팀·조직 화면 |
| **Experimental** | 단일 target의 Claude Code·Codex OTLP/JSON push(`/api/v1/logs`), 자동 도구 배포 |
| **미지원·향후** | OTEL metrics 수신, Collector 번들, 모든 provider의 동일한 tool/inventory coverage, 중앙 설정 배포 |

---

## 2. 아키텍처 결정 기록 (ADR)

### ADR-001 — 수집: 로컬 pull 기본, 앱 직접 수신
- **결정:** shim이 로컬 원본을 읽어 `/api/v1/events`로 직접 전송한다. Collector는 두지 않는다. 서버는 개발자 머신에 접속하지 않으며 개발자 머신에서 서버로의 단방향 HTTPS만 필요하다.
- **재전송 경계:** 원본 session 파일과 target별 cursor가 SSOT다. 전송 실패 시 해당 target cursor를 전진시키지 않고 다음 회차에 다시 구성한다. 별도 durable shim outbox는 없으므로 장애 중 원본 파일을 삭제하면 누락분을 복구할 수 없다.
- **OTLP 호환:** `/api/v1/logs` 직접 수신은 experimental로 보존한다. Collector를 추가하더라도 이 선택 경로의 endpoint 앞에 둘 수 있다.

### ADR-002 — 멀티 프로바이더: shim 정규화 후 `UsageEvent[]`로 수렴
- **결정:** 기본 provider 5종은 shim의 고정 adapter가 로컬 파일을 정규화해 `/api/v1/events`로 보낸다. 앱은 인증 토큰으로 `user_id`를, 가격표로 비용을 다시 확정한다.
- **대칭 gate:** provider `collection_method='logfile'`이면 `/events`만 저장하고 OTLP는 버린다. experimental 전환으로 `collection_method='otel'`이면 `/logs`만 저장하고 같은 provider의 `/events`는 저장하지 않는다.
- **확장:** 기본 pull provider는 shim adapter와 provider baseline을 함께 추가한다. experimental OTLP provider는 서버 normalizer도 필요하다.

### ADR-003 — 저장: Pluggable backend (기본 PG, 옵트인 CH)
- **결정:** `StorageBackend` 인터페이스로 저장을 추상화. **기본 = Postgres 단일**(메타+이벤트+Mart). **옵트인 = ClickHouse 모드**(이벤트·집계만 CH, 메타·인증은 항상 PG).
- **근거:** 연 수천만~1억 행까진 PG로 충분(day1co 증거). OLTP는 어느 모드든 PG.
- **기각:** ClickHouse 단일 — 트랜잭션·FK·인증·도구 부재로 기각(PostHog도 메타는 PG).

### ADR-004 — 비용: LiteLLM 기반 엔진 (per-million 저장)
- **결정:** LiteLLM(+models.dev 보조) 가격을 **per-million USD로 저장**하고 토큰→USD 계산. 캐시·fast·200k+ 차등 지원.
- **근거:** day1co·zeude 모두 per-million 저장으로 float 정밀도 손실을 줄인다. ccusage 비용 모드(display/auto/calculate)는 정합.

### ADR-005 — 프론트엔드: Next.js 15 + TanStack Query + shadcn/ui + Recharts
- **결정/근거:** 세 벤치마크 공통 스택. TanStack Query는 zeude 검증.

### ADR-006 — shim: Rust 범용 수집 에이전트
- **결정:** Rust shim은 `claude`/`codex`를 투명 wrapping하고 OS scheduler의 단발 `collect`를 실행한다. Claude Code·Codex·Cursor·Gemini·Qwen adapter, target별 자격증명·cursor, 자동 업데이트를 포함한다.
- **기본 동작:** 로컬 파일은 회차당 한 번 파싱하고 각 target의 독립 cursor 이후분만 보낸다. 한 target 실패가 다른 target을 막지 않는다.
- **Experimental OTLP:** 단일 target에서 `TOARD_EXPERIMENTAL_OTLP=1`일 때만 Claude env와 Codex config를 주입한다. 기본 실행에는 OTEL 설정을 주입하지 않는다.
- **배포:** 플랫폼별 바이너리와 checksum을 GitHub Release로 제공하며 ccusage MIT adapter attribution은 `shim/NOTICE`에 유지한다.

### ADR-007 — 인증: Auth.js (NextAuth), AUTH_MODE + JWT 세션
- **결정:** 인증은 **Auth.js**. 계정·user 는 **Postgres**(adapter), 세션은 **JWT**(Credentials 는 database 세션 미지원). `AUTH_MODE` 로 배포 시 선택: `oauth`(GitHub/Google **+ id/pw credentials**)·`open`(인증 없음·내부망 전제). credentials 는 `AUTH_CREDENTIALS_ENABLED`(기본 on)로 토글 — 로그인 `/login`·가입 `/signup`(도메인 게이팅)·비번 변경/설정 `/settings`. 비번은 **bcrypt(cost 12)** 해시로만 저장. magic-link 는 확장 예정. 이메일 도메인 제한 + 검증된 identity.
- **초기화 경계:** browser `/setup`은 32자 이상의 별도 `BOOTSTRAP_SETUP_TOKEN`을 요구하고, 첫 admin 생성은 PostgreSQL transaction advisory lock 안에서 admin 존재 여부를 재검사한다. admin 전에는 credentials 가입과 OAuth adapter `createUser`를 차단한다. 일반 member 행은 초기화 완료로 보지 않는다. credentials 모드는 admin 생성 뒤 setup token을 제거한다. OAuth-only 모드는 passwordless admin의 이메일과 GitHub verified primary/Google `email_verified=true` 이메일이 일치할 때만 admin row를 자동 연결하며 member same-email 자동 연결은 차단한다. browser setup token은 admin row 생성 뒤 제거하고, headless OAuth-only admin은 browser token 없이 verified same-email provider를 직접 연결할 수 있다.
- **근거:** ADR-003(메타·계정은 항상 PG)과 일치. 조직마다 인증 요구가 달라(OAuth 불필요한 내부망 조직도 존재) 모드 선택이 필요. Supabase Auth(zeude·day1co) 대비 외부 종속 없음. **JWT 트레이드오프:** 강제 로그아웃 즉시성은 토큰 만료/블랙리스트로 보완(database 세션의 즉시 무효화는 포기). **credentials 보안:** 기존 OAuth 이메일로는 가입 불가(계정 탈취 방지), 미존재/OAuth 전용 계정도 더미 해시 비교로 사용자 열거(timing) 완화. login/signup은 bcrypt 전에 PostgreSQL 공유 global·IP·channel-account budget을 원자 소비하고 15분 window에서 5/60/300회 뒤 30초~15분 backoff한다. raw email/IP는 저장하지 않고 `AUTH_SECRET` HMAC-SHA256 digest만 저장하며, 성공 시 해당 account budget만 해제한다. reverse proxy는 client IP header를 덮어써야 하고 header가 없어도 account/global limit은 유지된다.
- **MFA 확장:** 자체 credentials 로그인은 비밀번호 확인 뒤 WebAuthn 패스키 사용자 검증을 선택적으로 요구한다. OAuth 로그인은 IdP 인증을 중복하지 않되, OAuth 사용자도 `내 히스토리` 전용 패스키 잠금을 켤 수 있다. 로그인과 히스토리는 같은 패스키 목록을 사용하지만 정책은 독립적이다. RP ID·origin·5분 일회용 challenge와 사용자 검증을 필수로 확인하며 서버에는 public key와 counter만 저장한다. 히스토리 잠금 해제는 현재 로그인 세션 ID·사용자·MFA 설정 버전·30분 만료에 결합한 서명 HttpOnly 쿠키이며 서버 렌더링과 `/api/content/history/*`가 같은 검사를 수행한다. 새 로그인 세션은 이전 잠금 해제 쿠키를 승계하지 않는다. 이 인증용 패스키는 기존 E2EE 콘텐츠 키 PRF wrapper와 분리한다.

### ADR-008 — 타임존: 조직 단위 설정 (`ORG_TIMEZONE`), 기본 UTC (v4) · **표출은 뷰어 타임존 (v4 개정)**
- **결정:** 이벤트 `ts`는 항상 **UTC `timestamptz`** 저장(불변). 일별 집계·리더보드의 "하루" 경계는 **조직 단위 타임존 설정 `ORG_TIMEZONE`**(IANA, 기본 `UTC`)으로 결정한다. 앱이 env를 읽어 검증(무효 시 UTC 폴백) 후 `StorageBackend` 생성자에 주입 — 패키지는 env를 직접 읽지 않는다(core 의존성 0 유지).
- **근거:** v3까지는 KST(Asia/Seoul)가 storage 쿼리·Mart 정의에 하드코딩돼 있었다(선행작 day1co 유산). 오픈소스 범용화(v4)에서 특정 타임존 가정은 성립하지 않는다. 서빙이 event-direct(§4.4 — Mart 미사용)인 지금이 전환 비용이 가장 싼 시점이다.
- **트레이드오프:** `ORG_TIMEZONE` 변경 시 과거 일별 뷰의 버킷이 바뀐다 — event-direct 서빙은 쿼리 시점 계산이라 자동 반영, Mart를 서빙으로 전환한 후라면 전체 `recomputeDaily` 필요(운영 문서에 명시).

**개정 — 대시보드 표출은 뷰어 타임존 (2026-07):**
- **결정:** 모든 대시보드 화면(개인·조직)의 기간 경계("오늘")·시간/일 버킷·시각 포맷은 **뷰어 타임존** 기준으로 표출한다. 해석 우선순위: **사용자 설정(`users.timezone`, NULL=자동) → 브라우저 쿠키(`toard.tz`, `TimezoneSync`가 기록) → `ORG_TIMEZONE`**. 타임존은 `parseFilters`가 기간에 실어 storage 쿼리(`BucketOptions.timezone`)까지 요청 단위로 흐른다. 필터 바에 적용 타임존을 상시 표기(조용한 타임존 방지).
- **근거:** 초기 결정은 "리더보드의 같은 하루 비교 가능성"을 들어 per-user를 기각했으나, 셀프호스팅 오픈소스에서는 신규 설치자가 기본값(UTC) 상태에서 "미래 시간에 데이터가 있는" 첫인상 결함을 겪고 조용히 이탈한다 — 수요 신호가 잡히지 않는 시장에서 표출 개인화는 선택 기능이 아니라 기본기다. 뷰어별로 집계 숫자가 달라질 수 있음은 감수한다(운영자 결정).
- **불변 조건:** Mart 물질화(`saveUsageEvents` 증분·`recomputeDaily`)와 cron 마감 일자는 계속 **조직 타임존**(`StorageBackend` 생성자 주입값) — Mart의 `day`는 단일 타임존으로만 성립한다. 따라서 **뷰어 타임존 화면은 event-direct 서빙 전제** — Mart를 서빙으로 전환하더라도 버킷 시계열은 event-direct 로 남긴다(또는 시간 단위 롤업 신설 필요, 단 30분 오프셋 타임존 한계).

---

## 3. 모노레포 구조

### 3.1 디렉토리 레이아웃 (pnpm workspace)

```
toard/
├── apps/
│   └── web/                      # Next.js 15 (App Router)
│       ├── app/
│       │   ├── api/v1/events/route.ts # 기본 사용량: shim이 정규화한 UsageEvent[]
│       │   ├── api/v1/logs/route.ts   # experimental OTLP/JSON
│       │   ├── api/v1/prompts/        # opt-in 본문
│       │   ├── api/v1/tool-{events,inventory}/ # 도구 메타데이터
│       │   ├── api/tokens/route.ts    # ingest token 발급/폐기
│       │   ├── api/stats/...           # 대시보드 쿼리 API
│       │   ├── (dashboard)/            # 대시보드 레이아웃 (+ /settings 비번 변경)
│       │   └── login/ · signup/        # 로그인·가입 (OAuth + id/pw)
│       └── components/
├── packages/
│   ├── core/                     # 도메인 타입 + StorageBackend 인터페이스 (의존성 0)
│   ├── ingest/                   # experimental OTLP 파싱·provider 식별·정규화
│   ├── pricing/                  # LiteLLM 비용 엔진 (resolveCost)
│   ├── storage-postgres/         # 기본 PG 구현체
│   └── storage-clickhouse/       # opt-in CH 구현체
├── shim/                         # 범용 수집 에이전트 (Rust — ADR-006; ccusage 어댑터 벤더링)
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
| `ingest` | experimental OTLP/JSON 트리 파싱, provider 식별, 정규화(`UsageEvent[]`) | `core` |
| `pricing` | LiteLLM 동기화, `resolveCost`(토큰→USD) | `core` |
| `storage-postgres` | `StorageBackend` PG 구현(이벤트 저장 + Mart + 쿼리) | `core` |
| `apps/web` | 수집 route, 대시보드, Auth.js, 서버 권위 user·비용 확정 | 위 전부 |
| `shim` | (Rust) 기본 로컬 파일 pull·정규화·target별 전송, experimental OTLP 주입 | 독립(별도 툴체인) |

- **의존은 항상 `core`로** 흐른다(순환 없음). 비용 계산은 `ingest`가 아니라 **수집 라우트에서 정규화 직후 `pricing.resolveCost`를 별도 단계로 호출**(테스트 격리 — `ingest`는 토큰까지만).
- `/events`는 shim이 정규화한 wire를 core parser로 검증하고, `/logs`만 raw OTLP bytes를 `ingest`에 넘긴다.

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
  providerKey: string;        // 등록된 provider key (열린 집합: 'claude_code'|'codex'|'gemini'|'opencode'|… — providers 테이블)
  userId: string | null;      // client wire에서는 null 가능, 서버가 bearer token 소유자로 덮어씀
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
  getDailyTimeseries(q: PeriodQuery & { scope?: 'all' | 'team'; teamId?: string }): Promise<DailyPoint[]>;
  getUserUsage(userId: string, q: PeriodQuery): Promise<{ overview: OverviewStats; daily: DailyPoint[]; byModel: ModelBreakdown[] }>;
  getLeaderboard(q: PeriodQuery & { scope: 'user' | 'team' }): Promise<LeaderRow[]>;
}
```

> 메타(users/teams) CRUD·인증은 인터페이스 밖(항상 PG, ADR-003). `StorageBackend`는 "이벤트 저장 + 분석 쿼리"만.

### 4.2 Postgres 스키마 (기본 모드)

#### 메타데이터 (항상 PG)
> 용어: 부서(departments)→팀(teams) 범용 리네임 — 2026-07-02, 마이그레이션 `1700000007`(오픈소스 재포지셔닝 §1.3-6).
```sql
CREATE TABLE teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  parent_id UUID REFERENCES teams(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  team_id UUID REFERENCES teams(id),
  role TEXT NOT NULL DEFAULT 'member',          -- 'member' | 'admin'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 이벤트 발생 시각 기준 팀 소속 원장. 기간은 [effective_from, effective_to).
CREATE TABLE user_team_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  team_id UUID NOT NULL REFERENCES teams(id),
  effective_from TIMESTAMPTZ NOT NULL,
  effective_to TIMESTAMPTZ,
  assignment_kind TEXT NOT NULL,                 -- 'onboarding' | 'admin' | 'legacy_seed'
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE providers (
  key TEXT PRIMARY KEY,                           -- 열린 집합: 'claude_code'|'codex'|'gemini'|'opencode'|'goose'|… (도구별)
  display_name TEXT NOT NULL,
  service_name_patterns TEXT[] NOT NULL DEFAULT '{}',  -- otel 전용: OTLP service.name 매칭(예 ['claude-code']). logfile 프로바이더는 '{}'
  collection_method TEXT NOT NULL,                -- 'otel'(OTLP push) | 'logfile'(shim 로컬 로그 pull)
  log_adapter TEXT,                               -- logfile 전용: shim 벤더 어댑터 식별자(ccusage adapter명, 예 'gemini'). otel은 NULL
  enabled BOOLEAN NOT NULL DEFAULT true           -- 파서는 다 포함하되 실사용 도구만 켬(§9)
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
  day DATE NOT NULL,                              -- 조직 타임존(ORG_TIMEZONE, 기본 UTC): (ts AT TIME ZONE <tz>)::date
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

CREATE TABLE usage_daily_team (
  team_id UUID NOT NULL REFERENCES teams(id),
  day DATE NOT NULL,
  provider_key TEXT NOT NULL REFERENCES providers(key),
  request_count BIGINT NOT NULL DEFAULT 0,
  active_users INT NOT NULL DEFAULT 0,            -- DISTINCT → 재계산만
  sessions INT NOT NULL DEFAULT 0,               -- DISTINCT → 재계산만
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cost_usd NUMERIC(16,8) NOT NULL DEFAULT 0,
  PRIMARY KEY (team_id, day, provider_key)
);
CREATE INDEX ON usage_daily_user (day, provider_key);
CREATE INDEX ON usage_daily_team (day, provider_key);
```

### 4.3 ClickHouse 모드 (옵트인)
메타는 PG에 그대로. 이벤트·집계만 CH. **이벤트 발생 시각에 유효한 소속 이력을 조회한 `team_id`를 비정규화**한다.
```sql
CREATE TABLE usage_events (
  dedup_key String, provider_key LowCardinality(String),
  user_id String, team_id String,           -- 이벤트 발생 시각 기준 소속
  session_id String, model LowCardinality(String),
  ts DateTime64(3,'UTC'),
  input_tokens UInt64, output_tokens UInt64, cache_read_tokens UInt64, cache_creation_tokens UInt64,
  cost_usd Decimal(18,8)
) ENGINE = ReplacingMergeTree ORDER BY (user_id, ts, dedup_key);

CREATE MATERIALIZED VIEW usage_daily_user_mv ENGINE = SummingMergeTree
ORDER BY (user_id, day, provider_key) AS
SELECT user_id, toDate(ts, <ORG_TIMEZONE>) AS day, provider_key,   -- 조직 타임존 (ADR-008)
  uniqState(session_id) AS sessions, sum(input_tokens) AS input_tokens, /* … */ sum(cost_usd) AS cost_usd
FROM usage_events GROUP BY user_id, day, provider_key;
```
> CH는 `team_id`를 이벤트에 동봉하므로 팀 GROUP BY가 PG 모드와 **동일 의미**(이벤트 시각 귀속)로 성립한다. 리더보드 라벨(이름)만 PG에서 머지. 팀별 DISTINCT(`active_users`·`sessions`)는 `usage_daily_team_mv`(AggregatingMergeTree, `uniqState(user_id)`/`uniqState(session_id)`, `team_id` GROUP BY) 또는 `usage_events`에서 `uniq()` 직접 쿼리로 산출.

### 4.4 핵심 설계 노트

| 항목 | 결정 |
|---|---|
| **dedup** | shim adapter가 provider·session·원본 이벤트 위치·토큰에서 안정적인 `dedup_key`를 생성한다. 파일 재작성이나 부분 성공 뒤 전체 전송으로 폴백해도 PG=`UNIQUE`+`ON CONFLICT DO NOTHING`, CH outbox/`ReplacingMergeTree`가 중복을 흡수한다. experimental OTLP normalizer도 자체 안정 키를 만든다. |
| **provider 식별** | **otel 경로:** OTLP `ResourceAttributes['service.name']`을 `providers.service_name_patterns`와 매칭해 `provider_key` 도출(Codex는 `codex`/`codex_cli_rs`). **logfile 경로:** shim이 어떤 어댑터로 읽었는지가 곧 `provider_key`(매칭 불필요, shim이 POST 시 명시). |
| **재전송 원본** | 기본 경로의 SSOT는 개발자 머신의 local source file과 target별 cursor다. 별도 durable shim outbox는 없다. 실패 target은 cursor를 전진시키지 않고 다음 회차에 재구성하지만, 장애 중 원본을 삭제하면 복구할 수 없다. experimental OTLP만 프롬프트 제거 후 `raw_events`에 보조 원형을 남긴다. |
| **토큰·비용 권위 소스** | token count는 각 shim adapter가 정확한 로컬 이벤트를 해석한다. `user_id`는 bearer token 소유자, 비용은 서버 pricing revision이 최종 권위다. OTEL metrics endpoint는 지원하지 않는다. |
| **Mart 갱신** | SUM 지표(토큰·비용·`request_count`)는 **당일(미마감)에만** 증분 upsert. DISTINCT(`sessions`·`active_users`)와 **마감된 과거 날짜**는 항상 `recomputeDaily`(DELETE 후 `usage_events`에서 통째 재INSERT). 재처리·지연도착이 건드린 `(user_id, day)`를 dirty로 마킹 → cron이 그 집합만 재계산. |
| **데이터 보존(TTL)** | `raw_events`=처리 후 14일. `usage_events`=365일(파티션 드롭). Mart=영속. |
| **타임존** | `ts`=UTC `timestamptz`. 일별 `day`=`(ts AT TIME ZONE <ORG_TIMEZONE>)::date` — 타임존은 **`ORG_TIMEZONE` 설정(기본 UTC)을 앱이 검증 후 `StorageBackend` 생성자로 주입**(SQL에 서버 TZ 비의존, ADR-008). 필터의 조직 타임존→UTC 환산은 앱이 책임. |
| **사용자 매칭** | **인증 토큰의 user_id가 유일·최종 권위.** POST 본문의 userId와 experimental OTLP resource identity는 신뢰하지 않는다. |
| **팀 귀속** | 신규 이벤트는 수집 시각의 현재 팀이 아니라 이벤트 `ts`에 유효한 `user_team_assignments` 기간으로 귀속한다. 최초 `팀 없음 → 팀`은 아직 미배정인 과거 사용량을 durable worker가 소급 귀속하고, 이후 이동·해제·재배정은 변경 시각 이후에만 적용한다. 기존 설치의 `legacy_seed` 사용자는 관리자가 preview를 확인한 뒤 `legacy_adoption`을 명시 실행해야 한다. |

> **현재 구현 경계**
> - **서빙은 event-direct**: 대시보드 쿼리는 `usage_events`를 직접 집계하며 Mart(`usage_daily_*`)·`bumpDailyUser`·`recomputeDaily`는 **미래 서빙 레이어로 현재 미사용**(데이터 규모가 커지면 읽기를 Mart로 전환). 따라서 "당일 증분 vs 마감 재계산 정합"은 현재 사용자 화면과 무관.
> - **OTLP raw 재처리 미구현**: `raw_events.processed`·`usage_events.raw_event_id` 연결과 raw→usage 재생성 경로는 없다. 기본 pull의 재전송은 shim 원본·cursor 계약으로 처리한다.
> - **팀 귀속 백필**: 최초 팀 배정은 아직 미배정인 과거 이벤트만 batch 백필한다. 작업은 PostgreSQL durable queue에서 재시도되며, ClickHouse rollup-only 보정 중에는 read fence로 영향 기간의 불완전한 팀 집계를 숨긴다. 기존 설치의 현재 팀은 `legacy_seed`로 보존하고 자동 백필하지 않는다.
> - **기간 프리셋**: 기본 UI 는 뷰어 타임존 기준 캘린더 프리셋(`오늘`·`이번 주`·`이번 달`·`최근 3개월`·`최근 12개월`)을 사용한다. 구 URL 호환용 `period=7|30|90`은 현재 시각 기준 롤링 윈도우로 계속 해석한다.

---

## 5. 수집 파이프라인

### 5.1 기본 흐름 (pull-primary)

```text
[개발자 머신]
  Claude ~/.claude/projects/**/*.jsonl
  Codex  ~/.codex/sessions/**/*.jsonl
  Gemini/Qwen session logs
  Cursor ~/.toard/cursor/usage.jsonl (stop hook exact tokens)
        ↓ shim이 회차당 한 번 파싱·UsageEvent[] 정규화
        ↓ target별 HTTPS POST /api/v1/events
[toard 앱]
  bearer 인증 → provider gate → user/cost 서버 권위 확정 → 멱등 저장
```

"pull"은 shim이 로컬 파일을 읽는 방식을 뜻한다. 서버 전달은 개발자 머신에서 서버로 향하는 단방향 HTTPS POST이며 서버가 개발자 머신에 접속하지 않는다.

### 5.2 endpoint와 지원 수준

| Method | Endpoint | 용도 | 수준 |
|---|---|---|---|
| `POST` | `/api/v1/events` | 정규화된 사용량 | **기본** |
| `POST` | `/api/v1/events/reconcile` | Codex replay exact-key 정정 | 기본 호환 |
| `POST` | `/api/v1/prompts` | opt-in 대화 본문 | 선택 |
| `POST` | `/api/v1/prompts/reconcile` | prompt agent metadata 정정 | 선택 호환 |
| `POST` | `/api/v1/tool-events` | MCP·Skill 활동 메타데이터 | 기본(지원 provider만) |
| `PUT` | `/api/v1/tool-inventory` | 기기별 설치 메타데이터 | 기본(지원 provider만) |
| `POST` | `/api/v1/logs` | OTLP/JSON logs | **Experimental** |

OTEL metrics endpoint는 지원하지 않는다. `doctor`가 빈 `/v1/logs`를 보내는 것은 인증·연결 probe일 뿐 기본 수집 경로를 의미하지 않는다.

### 5.3 provider 대칭 gate

- 기본 baseline의 Claude Code·Codex·Cursor·Gemini·Qwen은 모두 `collection_method='logfile'`이다.
- `/events`는 등록된 provider 중 `logfile`만 저장한다. `otel` provider의 pull event는 shim cursor 전진을 위해 200으로 응답하지만 저장하지 않는다.
- `/logs`는 enabled이면서 `collection_method='otel'`인 provider만 식별한다. 기본 `logfile` provider의 OTLP는 저장하지 않는다.
- Experimental OTLP는 단일 target에서 client `TOARD_EXPERIMENTAL_OTLP=1`과 서버 provider `collection_method='otel'`을 함께 전환해야 한다.

### 5.4 인증·서버 권위

- `Authorization: Bearer <ingest_token>`의 SHA-256 hash로 소유자를 찾고 만료·폐기를 확인한다.
- shim payload의 `userId`, OTLP resource identity, client 비용은 권위가 아니다. 서버가 token 소유자와 event-time pricing revision으로 덮어쓴다.
- batch는 4MB로 제한하며 stable `dedup_key`를 PG unique constraint 또는 CH outbox가 흡수한다.

### 5.5 cursor·장애·재전송

- target별 cursor는 파일 stamp(`mtime+size`), 전송 개수, dedup prefix hash를 기록한다. 전송 성공 뒤에만 해당 target 진행 위치를 전진시킨다.
- 한 target 실패는 다른 target을 막지 않는다. 실패 target만 다음 수집에서 미전송 범위를 로컬 원본으로부터 다시 구성한다.
- 별도 durable shim outbox는 없다. 장애 중 원본 session 파일을 삭제하면 그 target의 누락분은 복구할 수 없다.
- 파일 재작성이나 부분 성공 때문에 전체 전송으로 폴백해도 서버 dedup이 중복을 흡수한다.

### 5.6 Experimental OTLP

Claude Code·Codex의 과거 OTLP-first 구현은 호환 경로로 보존한다. 단일 target에서 opt-in하면 Claude env 또는 Codex config를 주입하고 `/api/v1/logs`가 OTLP/JSON을 정규화한다. 이 경로에는 shim local cursor 재전송 계약이 적용되지 않으므로 운영자는 실험 기능의 SDK retry·배포 경계를 별도로 검토해야 한다.

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
- **캐시 200k 차등(ccusage와 의도적 차이):** ccusage는 캐시 토큰에도 tiered를 적용하지만, toard는 **캐시는 단순 곱(200k tiered 미적용)**. 주류 사용 패턴(코딩 에이전트 CLI)에서 캐시 above-200k 영향이 미미하다고 판단해 `pricing_models`에 `cache_*_above_200k` 컬럼을 두지 않는다. 정밀도가 필요해지면 컬럼+tiered 추가.

### 6.4 모델 별칭 (ccusage 8자리 날짜 정규화 패턴 차용)
- **풀 모델ID로 LiteLLM 직접 조회 우선**(LiteLLM 키는 날짜 포함 풀ID). 미스 시에만 폴백: ① 벤더 프리픽스 strip(`anthropic.`, `openai/`, `bedrock/`), ② **8자리(YYYYMMDD) 접미사일 때만 날짜 제거**(ccusage `MODEL_DATE_SUFFIX_DIGITS=8` 패턴), ③ 부분문자열 fuzzy(가장 긴 키 우선), ④ 수동 별칭 맵.

---

## 7. 프론트엔드 (`apps/web`)

### 7.1 데이터 흐름
- 초기: Server Component가 `StorageBackend` 직접 호출(SSR). 갱신: TanStack Query가 `/api/stats/*` 호출.
- 컴포넌트는 백엔드(PG/CH) 모름(ADR-003).

### 7.2 라우트 (역할 축 IA — 2026-07-02 개편)
```
app/
├── (auth)/login/page.tsx                # Auth.js
├── (dashboard)/
│   ├── page.tsx                          # 내 사용량 (랜딩 — 멤버 관점 우선)
│   ├── org/page.tsx                      # 전체 현황 — 탭: 개요 | 순위(개인·팀)
│   ├── settings/page.tsx                 # 설정 — 탭: 계정 | 설치·토큰
│   ├── admin/page.tsx                    # 관리(admin 전용) — 탭: 멤버 | 팀 | 초대 | 시스템(가격 동기화)
│   └── {me,onboarding,leaderboard}/      # 구 경로 — 리다이렉트(호환)
└── api/
    ├── v1/events/route.ts                # 기본 정규화 사용량
    ├── v1/logs/route.ts                  # experimental OTLP/JSON
    ├── v1/prompts/route.ts               # opt-in 본문
    ├── v1/tool-events/route.ts           # 활동 메타데이터
    ├── v1/tool-inventory/route.ts        # 설치 인벤토리
    ├── tokens/route.ts                   # POST 발급(평문 1회) · DELETE 폐기
    └── stats/{overview,timeseries,leaderboard}/route.ts
```

### 7.3 현재 화면
- **① 내 사용량(`/`, 랜딩)**: 개인 KPI + 일별 시계열 + **모델별 분해**. 미설치(토큰 없음/수신 이력 없음) 시 빈 상태에 설치 CTA. `getUserUsage`.
- **② 전체 현황(`/org`)**: **개요 탭** — KPI(총비용·총토큰·세션수·활성 사용자) + 일별 시계열 + 상위 사용자(→ 순위 탭 링크). **순위 탭** — 개인↔팀 토글, 비교 막대 + 순위 테이블. `getOverview`+`getDailyTimeseries`+`getLeaderboard`.
- **③ 설정(`/settings`)**: 계정(비밀번호) · 설치·토큰(shim 설치, 구 온보딩) 탭. 설치 탭에 **연결 확인**(내 토큰 `last_used_at` 폴링 — 설치 직후 실수신 셀프 점검)과 **프롬프트 미수집 고지**(메타데이터만 전송) 포함.
- **④ 관리(`/admin`, admin 전용)**: 멤버 목록(역할·팀·**마지막 수신** = 수집 연결 상태) + 팀 + 초대 + **시스템 탭**(가격 동기화 상태·수동 실행 — cron 미등록 시 비용 $0 함정 대응, 미동기화 시 대시보드 경고 배너). 서버 가드(비 admin 은 `/` 리다이렉트).
- **⑤ 로그인(`/login`)**: Auth.js, 도메인 제한.

### 7.4 공통/상태
- `PageHeader`(제목 + 우측 필터) · `LinkTabs`(URL 쿼리 기반 탭 — shadcn Tabs 스타일 미러) · `DashboardFilters`(기간 세그먼트 + 도구 셀렉트, providers 테이블 동적 로딩). shadcn/ui + Recharts. 필터·탭은 URL searchParams(페이지 스코프).
- 액션 피드백은 **sonner 토스트**(복사·발급·팀 생성/배정/삭제·초대 — `CopyButton` 공용), 파괴적 동작은 **alert-dialog 확인**(개별 토큰 폐기, 팀 삭제). 새 기기용 토큰 발급은 기존 활성 토큰을 유지한다.

### 7.5 권한
- `member`: 내 사용량 + 공개 전체 현황. `admin`: 전체 + 관리(`/admin` — 멤버·초대, 향후 수집 상태·도구·토큰 관리). role은 **Auth.js 세션 클레임**으로 서버 검증.

### 7.6 온보딩
1. `/login`(Auth.js, 도메인 제한) → 2. 첫 로그인 시 `users` 생성 → 3. Settings → Connect computer에서 ingest token 발급(평문 1회) + OS별 shim 설치 → 4. 첫 인증 수집 요청으로 연결 확인. 모든 수집은 token 소유자에게 귀속하며 email 기반 미식별 소급은 사용하지 않는다.

---

## 8. 배포 · 인프라 · 로컬 개발

### 8.1 환경 변수
```bash
ORG_TIMEZONE=UTC                         # 일별 집계 "하루" 경계 (IANA, 예 Asia/Seoul) — ADR-008
STORAGE_BACKEND=postgres                 # 'postgres'(기본) | 'clickhouse'
DATABASE_URL=postgres://…
CLICKHOUSE_URL=                          # CH 모드만
AUTH_SECRET=…                            # Auth.js
AUTH_TRUST_HOST=true
ALLOWED_EMAIL_DOMAINS=example.com        # (선택) 가입 허용 도메인
BOOTSTRAP_SETUP_TOKEN=…                  # browser 최초 admin용 1회 token(32자 이상, 완료 후 제거)
TOARD_PUBLIC_URL=https://toard.example.com      # 프록시에서 browser URL과 ingest URL이 다를 때만
LITELLM_PRICING_URL=…
BOOTSTRAP_ADMIN_EMAIL=…                  # 최초 admin 부트스트랩
```

### 8.2 배포
- Next.js standalone runner와 migrator, 기본 Postgres, opt-in ClickHouse를 제공한다. rolling/blue-green은 가용성과 schema 호환을 위해 권장하지만 pull 재전송 정확성의 필수조건은 아니다.
- cron/worker: 가격 동기화·가격 복구, ClickHouse outbox/rollup, retention cleanup을 담당한다. OTLP raw 재처리 worker는 없다.

### 8.3 로컬 개발
- `docker-compose.dev.yml`(Postgres 16) + `.env.example`.
- 마이그레이션: `migrations/*.sql` + node-pg-migrate.
- seed: provider/pricing baseline + 선택한 `BOOTSTRAP_ADMIN_EMAIL` admin 1명. ingest token은 seed·배포 로그에서 생성하거나 출력하지 않고, 로그인한 관리자가 Settings → Computers에서 1회 발급한다.
- shim: 로컬 target을 등록하고 `toard-shim collect --dry-run` 또는 `collect`로 `/api/v1/events` 기본 경로를 검증한다. OTLP fixture는 experimental 경로를 따로 검사할 때만 사용한다.

### 8.4 shim 배포
- Rust 바이너리(ADR-006), OS 네이티브 매트릭스. macOS·Linux는 `install.sh`, Windows는 toard 서버의 `/install.ps1`을 사용한다. 온보딩은 §7.6.

---

## 9. 지원 상태와 변경 이력

현재 지원 범위는 §1.4와 §5가 SSOT다. pull-primary, ClickHouse opt-in, ccusage attribution, 팀 귀속과 공개 배포는 구현 완료 상태다. 향후 범위에는 신규 provider adapter, provider별 tool/inventory coverage 확대, 필요 시 Collector 연동이 있다.

과거 OTLP-first MVP와 1차·2차·3차 단계 계획은 [design-usage-pull.md](design-usage-pull.md)의 역사적 전환 근거로만 보존하며 현재 운영 상태를 나타내지 않는다.

---

## 10. 보안 & 프라이버시

### 10.1 수집 인증 & 토큰 SSOT
- `ingest_token` = 고엔트로피(≥256bit) 랜덤, 저장은 **SHA-256**(상수시간·결정적·인덱스 조회), 발급 시 평문 1회만 노출.
- **이벤트 `user_id`는 인증 토큰 소유자로 강제.** resource attribute의 user.id/email(otel)·POST 본문의 userId(shim events)는 신뢰하지 않음(공개 엔드포인트 위협모델 — env·본문 위조 방지). `/api/v1/logs`·`/api/v1/events` 모두 토큰으로만 귀속. §4.4·§5.4·§5.6과 일치.

### 10.2 토큰 수명주기 & Rate limit
- `ingest_tokens.expires_at`(만료)·`revoked_at`(폐기/회전). 새 토큰 발급은 additive 이며, 폐기는 특정 토큰 단위로 수행한다. 주기적 재발급 권장. admin의 타인 토큰 폐기는 별도 관리 기능으로 확장 가능(§7.5).
- **Rate limit(수치):** 토큰당 ≤ N req/min(예 120), 일일 이벤트 상한. 수집 배치 페이로드(logs·events)는 Content-Length를 먼저 거부하고 chunked stream도 읽는 도중 ≤4MB를 강제한다(초과 413). rate 초과 시 429 + Retry-After. 카운터는 단일 인스턴스 인메모리(다중 시 Redis). 이상 탐지: 토큰별 IP 수·이벤트율 급증 경보.

### 10.3 본문 opt-in과 메타데이터 경계
- 기본 사용량·도구 메타데이터 경로는 프롬프트, 도구 인자·출력, 환경변수, 절대경로를 전송하지 않는다.
- 대화 본문은 사용자가 명시적으로 켠 `/api/v1/prompts` 경로로만 보내며 서버 관리형 암호화와 사용자 RLS를 적용한다.
- Experimental OTLP route는 raw 저장 전에 prompt/free-text 필드를 제거한다.

### 10.4 접근 제어
- Auth.js OAuth/이메일 identity 기반 도메인 제한(자칭 이메일 불가). 최초 admin은 `BOOTSTRAP_ADMIN_EMAIL`로 시드, 이후 role 변경은 감사 로그. ingest(토큰)와 dashboard(세션) 인증 분리.

---

## 11. 운영 · 관측 · 테스트

### 11.1 관측
- 수집 헬스(최근 수신 시각·분당 이벤트), target별 shim delivery 상태, ClickHouse outbox·rollup 적체, 가격 동기화 성공 시각.

### 11.2 테스트 (핵심만)
- `pricing`: tiered·캐시 fallback(1.25/0.1)·OpenAI cacheCreation=0·모드별·단위(per-million).
- `ingest`: experimental OTLP provider 식별·api_request 필터·Codex subset 보정.
- `storage-postgres`: 당일 증분 vs 마감 재계산 정합·dirty 재계산·조직 타임존(`ORG_TIMEZONE`) day 경계.
- `shim`: 5개 usage adapter, provider별 본문/tool/inventory parser, `UsageEvent` 계약 미러, target별 cursor·부분 성공·재전송 멱등.

---

## 12. 오픈소스 운영 (v4)

### 12.1 라이선스
- **본체 라이선스: MIT**(2026-07-02 확정, 루트 `LICENSE`). 선정 근거 — 채택 극대화가 목표이고, 벤더링 대상 ccusage 와 동일 계열이라 호환 부담 최소, 특허 민감도·SaaS 경쟁 위협이 낮아 Apache-2.0/AGPL 의 추가 조항 실익이 작음.
- **서드파티 attribution:** ccusage(MIT) Rust adapter 고지는 `shim/NOTICE`에 포함한다. LiteLLM 가격 데이터는 원격 fetch라 코드 벤더링 고지 대상이 아니다.

### 12.2 언어 정책
- **한국어 1급**(문서·UI·커밋). 영어 README·UI i18n은 **백로그**로 관리(GitHub Projects) — 다국어화 시 next-intl류 도입과 UI 문자열(~320곳) 추출이 선행 과제.

### 12.3 공개 체크리스트 (2026-07-02 구비 완료)
- `LICENSE`(MIT) · `SECURITY.md` · `CONTRIBUTING.md` · 이슈/PR 템플릿 · PR 검증 CI · `shim/NOTICE`를 유지한다.
- 조직 고유 값 하드코딩 금지(§1.3-6): 타임존(ADR-008)·이메일 도메인·데모 데이터는 env/예시값(example.com)으로 완료.

### 12.4 배포 채널
- GitHub Releases(플랫폼별 shim + install.sh) · 컨테이너 이미지. 리포 경로는 shim `install.sh`와 Rust updater에 상수로 존재 — org 이전 시 일괄 변경 지점.

---

## 부록 — 결정의 출처
- 벤치마킹 레퍼런스: day1co(비공개 사내 선행작) · zeude · [ccusage](https://github.com/ryoppippi/ccusage)(MIT) — §1.2 표 참조
- v2 근거: 4개 정밀 검토(데이터모델·수집/OTEL·비용/보안·일관성) + Claude Code OTEL 공식 스펙
- v3 근거: ccusage 어댑터 15종 실측(`ccusage rust/crates/ccusage/src/adapter/`, MIT) + 수집 3전략(push/pull/proxy) 범용성·비용 비교
- v4 근거: 오픈소스 재포지셔닝 결정(2026-07-02) — "사내 전제" 전수 조사(타임존 하드코딩 7파일·조직 도메인 예시·비공개 레퍼런스 경로) 및 OSS 공개 요건 갭 분석
- **변경 시 주의:** §4 데이터 모델·§5 수집 계약·§2 ADR을 함께 갱신(나머지가 의존). **UsageEvent 계약은 TS(`core`)와 shim(Rust) 양쪽 미러 — 동시 갱신**(§5.6).

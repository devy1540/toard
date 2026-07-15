# Codex Replay Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Codex fork/subagent rollout에 복사된 부모 `token_count`를 신규 사용량에서 제외하고, 이미 저장된 중복 이벤트를 원본 로그에서 계산한 정확한 `dedup_key`로 안전하게 철회한다.

**Architecture:** shim이 rollout 파일의 구조적 경계(subagent의 `inter_agent_communication_metadata`, 또는 vscode fork에서 현재 session UUIDv7 이상인 첫 `task_started.turn_id`)를 이용해 정상 사용량과 재생 사용량을 분리한다. 정상 사용량은 기존 `/v1/events`로 보내고, 재생 사용량은 기존 파서와 같은 키 계산을 거쳐 인증된 사용자 범위의 `/v1/events/reconcile`로 철회한다. 서버는 추정 조건으로 행을 찾지 않고 전달받은 키만 삭제하며, PostgreSQL 일별 mart 또는 ClickHouse 15분·시간대별 dirty bucket을 함께 갱신한다.

**Tech Stack:** Rust shim, TypeScript/Next.js Route Handler, PostgreSQL, ClickHouse, Node test runner, Cargo test

**Status (2026-07-15):** 구현 완료. 로컬 전체 corpus dry-run에서 재생 이벤트 41,706건·재생 토큰 5,583,198,139·철회 키 41,635건을 식별했으며, 오늘 범위에서는 재생 이벤트 14,448건·재생 토큰 1,955,040,513·철회 키 14,408건을 식별했다. 운영 데이터는 직접 변경하지 않았고, 배포 후 인증된 shim의 1회 reconciliation으로만 정리된다.

## Global Constraints

- 운영 데이터베이스에 직접 접속하거나 수동 `DELETE`를 실행하지 않는다.
- 철회 API는 인증된 ingest token의 `user_id`와 `provider_key='codex'`, `log_adapter='codex'` 범위만 변경한다.
- 서버는 시간 밀도나 토큰 값 유사성으로 삭제 대상을 추정하지 않고 shim이 재현한 64자리 SHA-256 `dedup_key`만 사용한다.
- 요청은 최대 1,000개 키로 제한하고, 빈 요청과 반복 요청은 멱등 성공한다.
- 구버전 서버의 404/405는 기존 사용량 수집을 막지 않으며 24시간 뒤 재시도한다.
- 모든 구현은 RED→GREEN 순서로 진행하고 전체 테스트·typecheck·build·실제 로컬 corpus dry-run을 완료한다.

---

### Task 1: Rollout 재생 구간을 정상 사용량과 분리

**Files:**
- Modify: `shim/rust/src/collect/mod.rs`
- Modify: `shim/rust/src/collect/codex.rs`

**Interfaces:**
- Produces: `ParsedLog.replayed_usage: Vec<RawUsage>`
- Produces: `Codex::parse_changed()`가 `usage`에는 현재 파일의 정상 사용량만, `replayed_usage`에는 과거 파서가 전송했던 부모 재생분만 반환

- [x] **Step 1: 실제 사고 형태를 축약한 실패 테스트 추가**

```rust
#[test]
fn separates_full_fork_replay_from_live_subagent_usage() {
    // 첫 session_meta는 현재 rollout, 이어지는 session_meta/turn_context/token_count는 부모 복사본.
    // inter_agent_communication_metadata 뒤 token_count만 정상 사용량이어야 한다.
    let parsed = Codex.parse_changed(&path, false, false);
    assert_eq!(parsed.replayed_usage.len(), 1);
    assert_eq!(parsed.usage.len(), 1);
    assert_eq!(parsed.usage[0].output_tokens, 20);
}
```

- [x] **Step 2: 테스트가 현재 구현에서 실패하는지 확인**

Run: `cargo test --manifest-path shim/rust/Cargo.toml collect::codex::tests::separates_full_fork_replay_from_live_subagent_usage -- --exact`

Expected: `ParsedLog`에 `replayed_usage`가 없거나 재생 이벤트가 `usage`에 포함되어 FAIL.

- [x] **Step 3: 구조적 replay cutoff 구현**

```rust
#[derive(Debug, Default)]
pub struct ParsedLog {
    pub usage: Vec<RawUsage>,
    pub replayed_usage: Vec<RawUsage>,
    pub content: Vec<RawContent>,
    pub tools: Vec<RawToolActivity>,
}

// 우선순위:
// 1) subagent rollout의 첫 inter_agent_communication_metadata
// 2) foreign session_meta가 있는 vscode fork에서 현재 session UUIDv7 이상인 첫 task_started.turn_id
// 경계가 없으면 기존 pre-turn-context 방어만 유지한다.
```

파서는 경계 전후 모두 기존 `session_id`·모델 승계와 `total_token_usage` 중복 방출 제거 규칙으로 `RawUsage`를 만들고, 위치에 따라 `replayed_usage` 또는 `usage`에 넣는다. 시간 기반 1초 휴리스틱은 사용하지 않는다.

- [x] **Step 4: 정상 단일 session, subagent marker, multi-session resume 테스트 통과 확인**

Run: `cargo test --manifest-path shim/rust/Cargo.toml collect::codex::tests`

Expected: 신규 테스트와 기존 Codex 테스트 전부 PASS.

### Task 2: 정확한 키 철회를 위한 core/storage 계약 구현

**Files:**
- Modify: `packages/core/src/storage.ts`
- Modify: `packages/storage-postgres/src/storage.ts`
- Modify: `packages/storage-postgres/src/storage.test.ts`
- Modify: `packages/storage-clickhouse/src/storage.ts`
- Modify: `packages/storage-clickhouse/src/storage.test.ts`

**Interfaces:**
- Produces: `reconcileUsageEvents(request: UsageEventReconciliationRequest): Promise<UsageEventReconciliationResult>`
- Request: `{ userId: string; providerKey: "codex"; logAdapter: "codex"; dedupKeys: string[] }`
- Result: `{ reconciled: number; affectedBuckets: Date[] }`

- [x] **Step 1: PostgreSQL과 ClickHouse 실패 테스트 추가**

```typescript
await storage.reconcileUsageEvents({
  userId: "user-1",
  providerKey: "codex",
  logAdapter: "codex",
  dedupKeys: ["a".repeat(64)],
});
```

PostgreSQL 테스트는 `user_id/provider_key/log_adapter/dedup_key`를 모두 제한하고 같은 transaction에서 영향 날짜의 daily mart를 재계산하는지 검사한다. ClickHouse 테스트는 삭제 전후 `mark15mRollupDirty`가 실행되고 동기 mutation도 동일한 소유권 조건을 포함하는지 검사한다.

- [x] **Step 2: 저장소 테스트가 메서드 부재로 실패하는지 확인**

Run: `pnpm --filter @toard/storage-postgres test && pnpm --filter @toard/storage-clickhouse test`

Expected: `reconcileUsageEvents` 부재로 FAIL.

- [x] **Step 3: PostgreSQL 멱등 철회 구현**

```sql
SELECT dedup_key, ts,
       to_char((ts AT TIME ZONE $5)::date, 'YYYY-MM-DD') AS local_day
FROM usage_events
WHERE user_id = $1
  AND provider_key = $2
  AND log_adapter = $3
  AND dedup_key = ANY($4::text[])
FOR UPDATE;

DELETE FROM usage_events
WHERE user_id = $1
  AND provider_key = $2
  AND log_adapter = $3
  AND dedup_key = ANY($4::text[]);
```

선택된 날짜만 `recomputeDailyWithClient`로 다시 만들고 transaction을 commit한다. 없는 키는 `reconciled: 0`으로 성공한다.

- [x] **Step 4: ClickHouse dirty-first 동기 철회 구현**

```sql
SELECT dedup_key, ts
FROM usage_events FINAL
WHERE user_id = {user_id:String}
  AND provider_key = {provider_key:String}
  AND log_adapter = {log_adapter:String}
  AND dedup_key IN {dedup_keys:Array(String)};
```

후보에 대해 dirty를 먼저 기록하고, 동일 소유권 조건의 `ALTER TABLE usage_events DELETE ...`를 `mutations_sync=1`로 실행한 뒤 dirty를 다시 기록한다.

- [x] **Step 5: 저장소 테스트 GREEN 확인**

Run: `pnpm --filter @toard/storage-postgres test && pnpm --filter @toard/storage-clickhouse test`

Expected: 두 패키지 모두 0 failures.

### Task 3: 인증·검증된 reconciliation API 추가

**Files:**
- Create: `apps/web/app/api/v1/events/reconcile/route.ts`
- Create: `apps/web/app/api/v1/events/reconcile/route.test.ts`

**Interfaces:**
- Consumes: `StorageBackend.reconcileUsageEvents`
- Produces: `POST /api/v1/events/reconcile`
- Body: `{ "dedupKeys": ["<64 lowercase hex>"] }`
- Response: `{ "reconciled": number }`

- [x] **Step 1: 인증/소유권/상한/멱등 실패 테스트 작성**

```typescript
test("Codex reconciliation은 인증 사용자 범위와 검증된 키만 저장소에 전달한다", async () => {
  const response = await POST.withDependencies({...})(new Request(url, {
    method: "POST",
    headers: { authorization: "Bearer token" },
    body: JSON.stringify({ dedupKeys: ["a".repeat(64)] }),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(captured, {
    userId: "server-user",
    providerKey: "codex",
    logAdapter: "codex",
    dedupKeys: ["a".repeat(64)],
  });
});
```

401, 잘못된 JSON, 비-hex 키, 1,001개 초과, 중복 키 정규화, 빈 배열을 각각 검증한다.

- [x] **Step 2: route 테스트 RED 확인**

Run: `pnpm --filter @toard/web test -- app/api/v1/events/reconcile/route.test.ts`

Expected: route 모듈 부재로 FAIL.

- [x] **Step 3: 최소 route 구현**

인증 헤더에서 `userId`를 얻고, 본문에는 `userId/provider/logAdapter` 입력을 받지 않는다. `dedupKeys`는 중복 제거 후 최대 1,000개, 각 키는 `/^[a-f0-9]{64}$/`로 검증한다.

- [x] **Step 4: route 테스트 GREEN 확인**

Run: `pnpm --filter @toard/web test -- app/api/v1/events/reconcile/route.test.ts`

Expected: 0 failures.

### Task 4: shim의 1회 전수 reconciliation과 재시도 구현

**Files:**
- Modify: `shim/rust/src/collect/cursor.rs`
- Modify: `shim/rust/src/collect/post.rs`
- Modify: `shim/rust/src/collect/mod.rs`

**Interfaces:**
- Consumes: `ParsedLog.replayed_usage`
- Produces: cursor `reconciliation_version: u32` (`CODEX_REPLAY_RECONCILIATION_VERSION = 1`)
- Produces: `post_usage_reconciliation()`와 `EndpointResult`

- [x] **Step 1: cursor 이전 버전·강제 scan·멱등 전송 실패 테스트 작성**

```rust
#[test]
fn legacy_cursor_requires_one_reconciliation_scan() {
    let cursor: Cursor = serde_json::from_str(r#"{"files":{}}"#).unwrap();
    assert_eq!(cursor.reconciliation_version, 0);
}
```

추가로 정상 사용량 키와 replay 철회 키가 서로 분리되고, reconciliation 성공 전에는 version이 올라가지 않으며 404/405는 unsupported backoff로 전환되는지 검사한다.

- [x] **Step 2: 신규 테스트 RED 확인**

Run: `cargo test --manifest-path shim/rust/Cargo.toml collect::`

Expected: cursor 필드와 reconciliation 전송 경로 부재로 FAIL.

- [x] **Step 3: 1회 scan과 batch 전송 구현**

```rust
const CODEX_REPLAY_RECONCILIATION_VERSION: u32 = 1;

let reconcile_active = key == "codex"
    && cur.reconciliation_version < CODEX_REPLAY_RECONCILIATION_VERSION
    && post::unsupported_probe_due("usage-reconciliation");
```

`reconcile_active`이면 stamp가 같아도 모든 Codex 파일을 파싱한다. 정상 이벤트는 기존 경로로 보내고, `replayed_usage`는 기존 `dedup_key()`로 키만 만들어 1,000개씩 reconciliation API에 보낸다. 사용량 전송과 철회가 모두 성공한 경우에만 cursor 파일 상태와 version을 저장한다. 404/405는 기존 수집 성공을 유지하면서 unsupported stamp를 기록하고 version은 0으로 남긴다.

- [x] **Step 4: dry-run에 정상/철회 수량을 함께 출력**

```text
codex: 파일 236개 (...) → 정상 이벤트 N건, 재생 철회 M건 [dry-run]
```

토큰·키·세션 본문은 로그에 출력하지 않는다.

- [x] **Step 5: Rust 테스트 GREEN 확인**

Run: `cargo test --manifest-path shim/rust/Cargo.toml`

Expected: 0 failures, 성능 benchmark ignored 유지.

### Task 5: 운영 문서와 실데이터 검증기준 정리

**Files:**
- Modify: `shim/README.md`
- Modify: `docs/design-usage-pull.md`

**Interfaces:**
- Documents: 구조적 replay 제외, 인증 사용자 범위 철회, 404/405 재시도, direct DB delete 금지

- [x] **Step 1: 문서 계약 테스트 또는 기존 문서 assertion 위치 확인**

Run: `rg -n "Codex|replay|재생|dedup" shim/README.md docs/design-usage-pull.md apps/web/lib/*.test.ts`

- [x] **Step 2: 문서 수정**

README에는 신규 수집 차단과 기존 오염의 1회 reconciliation을 구분해 기록한다. 설계 문서에는 서버가 휴리스틱 삭제를 하지 않고 클라이언트가 재현한 키만 철회한다는 신뢰 경계를 명시한다.

- [x] **Step 3: 실제 로컬 corpus dry-run 검증**

Run: 개발 바이너리를 `toard-shim` argv0로 실행해 `collect --adapter codex --dry-run`

Expected: 오늘 사고 corpus에서 재생 14,448건, 재생 토큰 `1,955,040,513`, 정상 키 교집합·중복 제외 철회 키 14,408개가 검출된다. 실제 서버에는 전송하지 않는다.

### Task 6: 전체 회귀·빌드 검증

**Files:**
- Verify only

**Interfaces:**
- Verifies: parser, API, storage, rollup invalidation, cursor migration, docs

- [x] **Step 1: formatting과 diff 검사**

Run: `cargo fmt --manifest-path shim/rust/Cargo.toml -- --check && git diff --check`

Expected: exit 0.

- [x] **Step 2: 전체 테스트**

Run: `cargo test --manifest-path shim/rust/Cargo.toml && pnpm test`

Expected: 0 failures.

- [x] **Step 3: typecheck**

Run: `pnpm typecheck`

Expected: exit 0.

- [x] **Step 4: production build**

Run: `pnpm build`

Expected: exit 0.

- [x] **Step 5: 계획 요구사항 대조**

신규 중복 차단, 정확 키 기반 기존 데이터 철회, 인증 소유권, PostgreSQL mart 재계산, ClickHouse dirty-first, 멱등성, 구버전 서버 호환, dry-run, 비밀값 비노출을 diff와 테스트 이름에 각각 대응시킨다.

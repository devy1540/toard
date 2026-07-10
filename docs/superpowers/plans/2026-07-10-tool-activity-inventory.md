# AI Tool Activity and Device Inventory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 토큰·비용 수집 부하를 늘리지 않으면서 MCP·스킬·플러그인 활동과 기기별 설치 현황을 수집하고 개인·조직 대시보드에 표시한다.

**Architecture:** 기존 shim의 변경 파일 탐색과 JSON 파싱을 재사용해 사용량·본문·도구 활동을 한 번에 분리하고, 도구 활동과 인벤토리는 별도 API로 Postgres에 저장한다. 활동은 append-only, 인벤토리는 기기별 최신 스냅샷이며, 조직 조회는 개인 식별자를 포함하지 않는 전용 집계만 제공한다.

**Tech Stack:** Rust 2021 (`serde`, `serde_json`, `sha2`), TypeScript, Next.js App Router, PostgreSQL/node-pg-migrate, React Server Components, next-intl, Node test runner.

## Global Constraints

- 새 daemon, watcher, 별도 스케줄러를 만들지 않는다.
- 호출 인자·실행 명령·파일 경로·도구 출력·프롬프트를 도구 메타데이터 wire 또는 DB에 넣지 않는다.
- 일반 내장 도구(Bash·Read·Edit·`exec_command`)는 v1에서 수집하지 않는다.
- Codex `SKILL.md` 접근은 `derived_load`, Claude `Skill` 호출은 `explicit`로 구분한다.
- 최초 활성화 이전 과거 활동을 자동 백필하지 않는다.
- 유휴 실행에서 추가 로그 read와 활동 HTTP 요청은 0건이어야 한다.
- 인벤토리 무변경 시 전체 walk와 PUT 요청을 하지 않는다.
- 대형 fixture의 wall time과 CPU time 증가는 현재 대비 각각 10% 이내여야 한다.
- 개인 상세 이름은 본인에게만 보이고 조직 API에는 범주별 익명 집계만 노출한다.
- 한국어·영어 메시지를 함께 변경한다.

## File Map

- `packages/core/src/tool-metadata.ts`: 공유 활동·인벤토리 도메인 타입.
- `packages/core/src/tool-wire.ts`: strict allowlist wire parser.
- `fixtures/tool-{activity,inventory}.golden.json`: Rust/TypeScript 공통 계약.
- `migrations/1700000019_tool_activity_inventory.sql`: 활동·스냅샷·항목 테이블.
- `apps/web/lib/tool-metadata.ts`: Postgres 저장·개인 조회·조직 집계.
- `apps/web/lib/tool-ingest.ts`: 인증된 소유권을 적용하는 ingest service.
- `apps/web/app/api/v1/tool-{events,inventory}/route.ts`: 활동 POST, 인벤토리 PUT.
- `shim/rust/src/tool_event.rs`: Rust wire 타입과 직렬화.
- `shim/rust/src/collect/inventory.rs`: allowlist 인벤토리 scanner/fingerprint.
- `shim/rust/src/collect/{mod,claude,codex,gemini,qwen,post,cursor}.rs`: 단일 파싱·커서·전송.
- `apps/web/components/dashboard/tool-activity-card.tsx`: A안 개요 카드.
- `apps/web/app/(dashboard)/tools/page.tsx`: 개인 활동 상세.
- `apps/web/app/(dashboard)/settings/device-inventory.tsx`: 기기 설치 현황.
- `apps/web/app/(dashboard)/org/page.tsx`: 조직 익명 집계.
- `docs/tool-metadata-collection.md`: 개인정보·정확성·opt-out 문서.

---

### Task 1: Strict core contracts and golden fixtures

**Files:**
- Create: `packages/core/src/tool-metadata.ts`
- Create: `packages/core/src/tool-wire.ts`
- Create: `packages/core/src/tool-wire.test.ts`
- Create: `fixtures/tool-activity.golden.json`
- Create: `fixtures/tool-inventory.golden.json`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `ToolActivityEvent`, `ToolInventorySnapshot`, `ToolActivitySummary`, `ToolActivityRow`, `DeviceToolInventory`.
- Produces: `parseToolActivityBody(value)`, `parseToolInventoryBody(value)`.

- [ ] **Step 1: Write failing parser tests**

```ts
const validActivity = { dedupKey: "a".repeat(64), providerKey: "codex", sessionId: "s1", host: "box", ts: "2026-07-10T00:00:00Z", activityKind: "skill", itemKey: "brainstorming", displayName: "brainstorming", pluginKey: "superpowers", outcome: "unknown", detection: "derived_load" };
const validItem = { kind: "skill", itemKey: "brainstorming", displayName: "brainstorming", sourceProvider: "codex", pluginKey: "superpowers", version: null, enabled: true };
const validInventory = { host: "box", fingerprint: "b".repeat(64), observedAt: "2026-07-10T00:00:00Z", items: [validItem] };

test("activity accepts safe metadata", () => {
  const [event] = parseToolActivityBody([validActivity]);
  assert.equal(event.activityKind, "skill");
});

test("activity rejects raw inputs", () => {
  assert.throws(() => parseToolActivityBody([{ ...validActivity, arguments: "secret" }]), /허용되지 않은 필드: arguments/);
  assert.throws(() => parseToolActivityBody([{ ...validActivity, output: "secret" }]), /허용되지 않은 필드: output/);
});

test("inventory rejects endpoint and path", () => {
  assert.throws(() => parseToolInventoryBody({ ...validInventory, items: [{ ...validItem, endpoint: "https://internal" }] }), /endpoint/);
  assert.throws(() => parseToolInventoryBody({ ...validInventory, items: [{ ...validItem, path: "/Users/me/.codex" }] }), /path/);
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @toard/core test`

Expected: FAIL because `tool-wire.ts` does not exist.

- [ ] **Step 3: Implement domain types and strict allowlists**

```ts
export type ToolActivityKind = "mcp" | "skill";
export type ToolOutcome = "success" | "failure" | "unknown";
export type ToolDetection = "explicit" | "derived_load";
export type InventoryKind = "mcp" | "skill" | "plugin";

export interface ToolActivityEvent {
  dedupKey: string;
  providerKey: string;
  sessionId: string | null;
  host: string | null;
  ts: Date;
  activityKind: ToolActivityKind;
  itemKey: string;
  displayName: string;
  pluginKey: string | null;
  outcome: ToolOutcome;
  detection: ToolDetection;
}

function rejectUnknown(record: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  const key = Object.keys(record).find((candidate) => !allowed.has(candidate));
  if (key) throw new WireParseError(`허용되지 않은 필드: ${key}`);
}
```

Require 64 lowercase hex characters for `dedupKey`; cap names at 200 characters; cap activity batches at 500 and inventory items at 2,000; reject all unknown fields.

- [ ] **Step 4: Add golden fixtures and exports**

Activity fixture contains Claude MCP, Claude explicit skill, and Codex derived skill. Inventory fixture contains one MCP, skill, and plugin without URL, command, env, args, output, or path. Export both modules from `packages/core/src/index.ts`.

- [ ] **Step 5: Verify GREEN**

Run: `pnpm --filter @toard/core test && pnpm --filter @toard/core typecheck`

Expected: all core tests PASS and typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src fixtures/tool-activity.golden.json fixtures/tool-inventory.golden.json
git commit -m "feat(core): AI 도구 메타데이터 계약 추가"
```

---

### Task 2: Postgres schema, repository, and authenticated APIs

**Files:**
- Create: `migrations/1700000019_tool_activity_inventory.sql`
- Create: `apps/web/lib/tool-metadata.ts`
- Create: `apps/web/lib/tool-metadata.test.ts`
- Create: `apps/web/lib/tool-ingest.ts`
- Create: `apps/web/lib/tool-ingest.test.ts`
- Create: `apps/web/app/api/v1/tool-events/route.ts`
- Create: `apps/web/app/api/v1/tool-inventory/route.ts`

**Interfaces:**
- Consumes: Task 1 parsers/types.
- Produces: `insertToolActivity`, `replaceDeviceInventory`, `getMyToolActivity`, `getMyDeviceInventories`, `getOrgToolSummary`.
- Produces: `readBoundedJson(req: Request, maxBytes: number): Promise<unknown>`, `ingestToolActivity(auth, events)`.
- Produces: `POST /api/v1/tool-events`, `PUT /api/v1/tool-inventory`.

- [ ] **Step 1: Write failing ownership and privacy tests**

```ts
class RecordingDb {
  calls: Array<{ sql: string; params?: unknown[] }> = [];
  constructor(private readonly rows: Record<string, unknown>[] = []) {}
  async query(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params });
    return { rows: this.rows };
  }
}
const period = { from: new Date("2026-07-01T00:00:00Z"), to: new Date("2026-07-11T00:00:00Z") };
const event: ToolActivityEvent = { dedupKey: "a".repeat(64), providerKey: "codex", sessionId: "s1", host: "box", ts: new Date("2026-07-10T00:00:00Z"), activityKind: "skill", itemKey: "brainstorming", displayName: "brainstorming", pluginKey: "superpowers", outcome: "unknown", detection: "derived_load" };

test("activity insert uses authenticated ownership", async () => {
  const db = new RecordingDb();
  await insertToolActivity(db, { userId: "auth-user", tokenId: "auth-token" }, [event]);
  assert.deepEqual(db.calls[0]!.params?.slice(0, 2), ["auth-user", "auth-token"]);
  assert.doesNotMatch(db.calls[0]!.sql, /arguments|output|payload/i);
});

test("org query never returns identities", async () => {
  const db = new RecordingDb([{ activity_kind: "mcp", activities: "3", active_users: "2", active_devices: "2", failures: "0" }]);
  const value = await getOrgToolSummary(db, period);
  assert.doesNotMatch(JSON.stringify(value), /itemKey|displayName|userId|tokenId|host|sessionId/);
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @toard/web test`

Expected: FAIL because repository/service modules do not exist.

- [ ] **Step 3: Add schema with no raw payload columns**

```sql
CREATE TABLE tool_activity_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dedup_key TEXT NOT NULL UNIQUE,
  provider_key TEXT NOT NULL REFERENCES providers(key),
  user_id UUID NOT NULL REFERENCES users(id),
  ingest_token_id UUID NOT NULL REFERENCES ingest_tokens(id),
  session_id TEXT,
  host TEXT,
  ts TIMESTAMPTZ NOT NULL,
  activity_kind TEXT NOT NULL CHECK (activity_kind IN ('mcp','skill')),
  item_key TEXT NOT NULL CHECK (char_length(item_key) BETWEEN 1 AND 200),
  display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 200),
  plugin_key TEXT CHECK (plugin_key IS NULL OR char_length(plugin_key) BETWEEN 1 AND 200),
  outcome TEXT NOT NULL CHECK (outcome IN ('success','failure','unknown')),
  detection TEXT NOT NULL CHECK (detection IN ('explicit','derived_load'))
);
CREATE INDEX idx_tool_activity_user_ts ON tool_activity_events (user_id, ts DESC);
CREATE INDEX idx_tool_activity_org_ts_kind ON tool_activity_events (ts, activity_kind);

CREATE TABLE device_tool_inventory_snapshots (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  ingest_token_id UUID NOT NULL REFERENCES ingest_tokens(id),
  host TEXT NOT NULL DEFAULT '',
  fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  observed_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ingest_token_id, host)
);

CREATE TABLE device_tool_inventory_items (
  snapshot_id BIGINT NOT NULL REFERENCES device_tool_inventory_snapshots(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('mcp','skill','plugin')),
  item_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  source_provider TEXT NOT NULL,
  plugin_key TEXT,
  version TEXT,
  enabled BOOLEAN NOT NULL,
  PRIMARY KEY (snapshot_id, kind, item_key, source_provider)
);
```

Add a symmetric down migration.

- [ ] **Step 4: Implement repository and service boundaries**

Use `ON CONFLICT (dedup_key) DO NOTHING`. Inventory replacement uses one transaction: lock latest snapshot, return unchanged on equal fingerprint, otherwise upsert header, delete old items, insert current items. Personal queries always require `WHERE user_id = $1`. Organization query returns only category counts, active user/device counts, and failures.

Routes authenticate first with `authenticateIngestToken`, enforce 512 KiB activity and 1 MiB inventory bodies, parse strict wire data, validate provider keys, sanitize host, and inject authenticated `userId`/`tokenId` without spreading raw JSON.

```ts
export async function POST(req: Request): Promise<Response> {
  const auth = await authenticateIngestToken(req.headers.get("authorization"));
  if (!auth) return new Response("unauthorized", { status: 401 });
  const events = parseToolActivityBody(await readBoundedJson(req, 512 * 1024));
  return Response.json(await ingestToolActivity(auth, events));
}
```

- [ ] **Step 5: Verify GREEN**

Run: `pnpm --filter @toard/web test && pnpm --filter @toard/web typecheck`

Expected: repository/service tests PASS and routes typecheck.

- [ ] **Step 6: Commit**

```bash
git add migrations/1700000019_tool_activity_inventory.sql apps/web/lib/tool-* apps/web/app/api/v1/tool-events apps/web/app/api/v1/tool-inventory
git commit -m "feat(api): AI 도구 메타데이터 저장과 수집 추가"
```

---

### Task 3: Rust one-pass log parser and safe activity classification

**Files:**
- Create: `shim/rust/src/tool_event.rs`
- Modify: `shim/rust/src/main.rs`
- Modify: `shim/rust/src/collect/mod.rs`
- Modify: `shim/rust/src/collect/claude.rs`
- Modify: `shim/rust/src/collect/codex.rs`
- Modify: `shim/rust/src/collect/gemini.rs`
- Modify: `shim/rust/src/collect/qwen.rs`

**Interfaces:**
- Consumes: Task 1 activity golden fixture.
- Produces: `ParsedLog`, `RawToolActivity`, `ToolActivityWire`, `to_tool_events_body`.

- [ ] **Step 1: Write failing parser tests**

```rust
#[test]
fn codex_skill_read_is_derived_without_raw_command() {
    let parsed = Codex.parse_changed(&fixture, false, true);
    assert_eq!(parsed.tools[0].item_key, "brainstorming");
    assert_eq!(parsed.tools[0].detection, Detection::DerivedLoad);
    let body = to_tool_events_body("codex", Some("box"), &parsed.tools);
    assert!(!body.contains("sed -n"));
    assert!(!body.contains("/Users/"));
}

#[test]
fn claude_mcp_and_skill_are_explicit() {
    let parsed = Claude.parse_changed(&fixture, false, true);
    assert_eq!(parsed.tools.len(), 2);
    assert_eq!(parsed.tools[1].detection, Detection::Explicit);
}
```

- [ ] **Step 2: Verify RED**

Run: `cargo test --manifest-path shim/rust/Cargo.toml tool_ -- --nocapture`

Expected: compilation FAIL because the new parser contract is absent.

- [ ] **Step 3: Introduce a single-read adapter contract**

```rust
#[derive(Debug, Default)]
pub struct ParsedLog {
    pub usage: Vec<RawUsage>,
    pub content: Vec<RawContent>,
    pub tools: Vec<RawToolActivity>,
}

pub trait LogAdapter {
    fn key(&self) -> &'static str;
    fn discover_files(&self) -> Vec<PathBuf>;
    fn parse_changed(&self, path: &Path, include_content: bool, include_tools: bool) -> ParsedLog;
}
```

Each adapter calls `std::fs::read(path)` once. Gemini/Qwen return no tools. Claude/Codex route each parsed line into usage/content/tool vectors. Remove old separate reads after tests migrate.

- [ ] **Step 4: Implement allowlist classification and wire serialization**

```rust
pub struct RawToolActivity {
    pub ts_ms: i64,
    pub session_id: Option<String>,
    pub call_id: String,
    pub kind: ActivityKind,
    pub item_key: String,
    pub display_name: String,
    pub plugin_key: Option<String>,
    pub outcome: Outcome,
    pub detection: Detection,
}
```

Recognize MCP only by provider naming rules/provenance. Recognize Codex skill loads only when a normalized path resolves under known skill roots and ends with `SKILL.md`. Emit only the parent skill name. Pair Claude tool results by call ID and use structured statuses only; never inspect output text.

- [ ] **Step 5: Verify GREEN**

Run: `cargo test --manifest-path shim/rust/Cargo.toml`

Expected: all old usage/content and new tool tests PASS; golden contract matches.

- [ ] **Step 6: Commit**

```bash
git add shim/rust/src fixtures/tool-activity.golden.json
git commit -m "refactor(shim): 로그를 한 번에 파싱하도록 통합"
```

---

### Task 4: Independent activity delivery, inventory scanner, and load guards

**Files:**
- Create: `shim/rust/src/collect/inventory.rs`
- Modify: `shim/rust/src/collect/mod.rs`
- Modify: `shim/rust/src/collect/cursor.rs`
- Modify: `shim/rust/src/collect/post.rs`
- Modify: `shim/rust/src/credentials.rs`
- Modify: `shim/rust/src/cli.rs`
- Modify: `apps/web/app/install.sh/route.ts`

**Interfaces:**
- Consumes: Task 3 `ParsedLog.tools`, Task 2 endpoints.
- Produces: `{adapter}-tools` cursor, `tool-since`, `post_tool_events`, `put_tool_inventory`, `TOARD_SHIM_COLLECT_TOOLS` opt-out.

- [ ] **Step 1: Write failing baseline/backoff/inventory tests**

```rust
#[test]
fn first_run_seeds_tool_baseline_without_backfill() {
    let plan = plan_tool_collection(&files, Cursor::default(), None, now_ms);
    assert!(plan.events.is_empty());
    assert_eq!(plan.cursor.files.len(), files.len());
}

#[test]
fn unsupported_endpoint_backs_off_for_24_hours() {
    remember_unsupported("tool-events", now);
    assert!(!should_probe("tool-events", now + 23 * 3600));
    assert!(should_probe("tool-events", now + 24 * 3600));
}

#[test]
fn unchanged_inventory_skips_walk_and_put() {
    assert_eq!(inventory_decision(&state, &same_stamps, now), InventoryDecision::Skip);
}
```

- [ ] **Step 2: Verify RED**

Run: `cargo test --manifest-path shim/rust/Cargo.toml first_run_seeds unsupported_endpoint unchanged_inventory`

Expected: FAIL because planning/backoff/inventory helpers are missing.

- [ ] **Step 3: Implement isolated activity delivery**

Use the same file discovery and `ParsedLog` objects as usage. On first activation, persist current stamps plus `tool-since=now` without emitting history. Advance `{adapter}-tools` only after successful tool POST. Usage cursor must still advance when tool POST fails.

Refactor HTTP helper to accept method and map 404/405 to `Unsupported`:

```rust
pub enum EndpointResult<T> { Ok(T), Disabled, Unsupported, Unauthorized, Err(String) }
pub fn post_tool_events(endpoint: &str, token: &str, body: &str) -> EndpointResult<PostResult> {
    send_json(endpoint, token, "POST", "/v1/tool-events", "tool-events", body)
}
```

Persist unsupported timestamps and suppress retries/logs for 24 hours.

- [ ] **Step 4: Implement privacy-safe inventory and throttle**

```rust
#[derive(Debug, Clone, Serialize, PartialEq, Eq, PartialOrd, Ord)]
pub struct InventoryItem {
    pub kind: InventoryKind,
    pub item_key: String,
    pub display_name: String,
    pub source_provider: String,
    pub plugin_key: Option<String>,
    pub version: Option<String>,
    pub enabled: bool,
}
```

Claude/Codex scanners read only names, enabled state, safe version, and provenance. Never copy endpoint, command, args, env, or paths. Check config/root stamps every run; full scan only on stamp change, missing state, install/update, or 24 hours elapsed. Sort safe items before SHA-256; skip PUT when fingerprint matches.

- [ ] **Step 5: Add default-on opt-out**

`TOARD_SHIM_COLLECT_TOOLS=0|false|off` overrides `collect_tools=false` in credentials. Disabled mode skips tool parser flags, cursor, inventory stamps, and requests but preserves usage/content.

- [ ] **Step 6: Verify GREEN**

Run: `cargo test --manifest-path shim/rust/Cargo.toml`

Expected: all tests PASS, including usage-success/tool-failure isolation and forbidden field assertions.

- [ ] **Step 7: Commit**

```bash
git add shim/rust/src apps/web/app/install.sh/route.ts fixtures/tool-inventory.golden.json
git commit -m "feat(shim): AI 도구 활동과 인벤토리 수집 추가"
```

---

### Task 5: Personal overview card and activity detail

**Files:**
- Create: `apps/web/components/dashboard/tool-activity-card.tsx`
- Create: `apps/web/components/dashboard/tool-activity-list.tsx`
- Create: `apps/web/app/(dashboard)/tools/page.tsx`
- Modify: `apps/web/components/dashboard/overview-view.tsx`
- Modify: `apps/web/messages/ko/dashboard.json`
- Modify: `apps/web/messages/en/dashboard.json`
- Modify: `apps/web/lib/ui-commonization.test.ts`

**Interfaces:**
- Consumes: Task 2 `getMyToolActivity(userId, period)`.
- Produces: A안 summary card and `/tools` detail route.

- [ ] **Step 1: Write failing copy/layout tests**

```ts
test("skill copy stays evidence-aware", () => {
  const ko = readMessages("ko", "dashboard");
  assert.equal(ko.toolActivity.skillLabel, "스킬 활동");
  assert.equal(ko.toolActivity.explicitBadge, "명시 호출");
  assert.equal(ko.toolActivity.loadedBadge, "로드");
  assert.doesNotMatch(JSON.stringify(ko.toolActivity), /사용한 스킬/);
});

test("overview uses the tool activity card", () => {
  assert.match(readFile("components/dashboard/overview-view.tsx"), /ToolActivityCard/);
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @toard/web test`

Expected: FAIL because messages/components do not exist.

- [ ] **Step 3: Add the A안 card below primary usage content**

Render MCP calls, distinct skill activities, distinct plugins, top three names, empty state, and a `자세히` link that preserves period/provider. Do not move or resize token/cost/session summary.

```tsx
<ToolActivityCard userId={userId} period={period} className="mt-4" />
```

- [ ] **Step 4: Add `/tools` without a sidebar entry**

Reuse `DashboardFilters`; query current user only. Rows show name, category, count, last activity, outcome, device, and `명시 호출`/`로드`. Empty activity and empty inventory are separate states.

- [ ] **Step 5: Verify GREEN**

Run: `pnpm --filter @toard/web test && pnpm --filter @toard/web typecheck`

Expected: tests PASS and TypeScript exits 0.

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/dashboard apps/web/app/'(dashboard)'/tools apps/web/messages apps/web/lib/ui-commonization.test.ts
git commit -m "feat(dashboard): AI 도구 활동 카드와 상세 추가"
```

---

### Task 6: Device inventory and anonymous organization summary

**Files:**
- Create: `apps/web/app/(dashboard)/settings/device-inventory.tsx`
- Modify: `apps/web/app/(dashboard)/settings/page.tsx`
- Modify: `apps/web/app/(dashboard)/org/page.tsx`
- Modify: `apps/web/messages/ko/settings.json`
- Modify: `apps/web/messages/en/settings.json`
- Modify: `apps/web/messages/ko/org.json`
- Modify: `apps/web/messages/en/org.json`
- Modify: `apps/web/lib/tool-metadata.test.ts`
- Modify: `apps/web/lib/ui-commonization.test.ts`

**Interfaces:**
- Consumes: Task 2 device inventories and org summary.
- Produces: per-device inventory disclosure and identity-free org card.

- [ ] **Step 1: Write failing privacy/UI tests**

```ts
test("device inventory is not period activity", () => {
  const source = readFile("app/(dashboard)/settings/device-inventory.tsx");
  assert.doesNotMatch(source, /period|fromDate|toDate/);
});

test("org DTO has no item or identity fields", async () => {
  const db = new RecordingDb([{ activity_kind: "mcp", activities: "3", active_users: "2", active_devices: "2", failures: "0" }]);
  const period = { from: new Date("2026-07-01T00:00:00Z"), to: new Date("2026-07-11T00:00:00Z") };
  const json = JSON.stringify(await getOrgToolSummary(db, period));
  for (const key of ["itemKey", "displayName", "userId", "tokenId", "host", "sessionId"]) assert.equal(json.includes(key), false);
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @toard/web test`

Expected: FAIL until the component and strict org DTO exist.

- [ ] **Step 3: Add per-device inventory disclosure**

Map inventories by authenticated token/host ownership. Show MCP/skill/plugin counts and grouped items. Status is `최신` within 48 hours, `지연` after 48 hours, or `아직 수신되지 않음`. The render type contains no endpoint, command, path, or environment.

- [ ] **Step 4: Add category-only organization card**

Show category totals, active user/device counts, and failure rate. Plugin count derives from non-null `plugin_key`; names are omitted. Add no personal drill-down link.

- [ ] **Step 5: Verify GREEN**

Run: `pnpm --filter @toard/web test && pnpm --filter @toard/web typecheck`

Expected: tests PASS and both pages typecheck.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/'(dashboard)'/settings apps/web/app/'(dashboard)'/org/page.tsx apps/web/messages apps/web/lib
git commit -m "feat(web): 기기 인벤토리와 조직 익명 집계 추가"
```

---

### Task 7: Performance guard and collection documentation

**Files:**
- Create: `shim/rust/benches/collect_fixture.rs`
- Create: `docs/tool-metadata-collection.md`
- Modify: `README.md`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces: repeatable performance measurement and user-facing privacy/opt-out contract.

- [ ] **Step 1: Write failing read-count test**

```rust
#[test]
fn one_changed_file_reads_once_and_idle_reads_zero() {
    let io = CountingIo::default();
    collect_with_io(&adapter, &io, changed_once());
    assert_eq!(io.read_count(), 1);
    collect_with_io(&adapter, &io, unchanged());
    assert_eq!(io.read_count(), 1, "idle run must not read bodies");
}
```

- [ ] **Step 2: Verify RED**

Run: `cargo test --manifest-path shim/rust/Cargo.toml one_changed_file_reads_once`

Expected: FAIL until the narrow counting-I/O seam exists.

- [ ] **Step 3: Add counting seam and benchmark**

Production uses the default filesystem reader. The ignored release test prints `files`, `bytes`, `wall_ms`, and `cpu_ms` for the same generated large fixture without network.

Run: `cargo test --manifest-path shim/rust/Cargo.toml --release benchmark_collect_fixture -- --ignored --nocapture`

Expected: one file read; wall/CPU deltas against the pre-tool baseline are each `<= 10%`.

- [ ] **Step 4: Document the exact boundary**

`docs/tool-metadata-collection.md` lists every transmitted field, every forbidden field, `명시 호출` versus `로드`, no backfill, `TOARD_SHIM_COLLECT_TOOLS=0`, 24-hour unsupported backoff, and 24-hour inventory verification. Link it from README. Add `.superpowers/` to `.gitignore` so brainstorming artifacts stay local.

- [ ] **Step 5: Commit**

```bash
git add shim/rust/benches/collect_fixture.rs docs/tool-metadata-collection.md README.md .gitignore
git commit -m "test(shim): AI 도구 수집 성능 기준 검증"
```

---

### Task 8: Full verification and final privacy audit

**Files:**
- Modify only files that fail verification; do not broaden scope.

**Interfaces:**
- Consumes: all tasks.
- Produces: a verified feature ready for branch finish/review.

- [ ] **Step 1: Run all relevant tests**

```bash
pnpm --filter @toard/core test
pnpm --filter @toard/web test
pnpm --filter @toard/core typecheck
pnpm --filter @toard/web typecheck
cargo test --manifest-path shim/rust/Cargo.toml
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 2: Audit forbidden-field surfaces**

```bash
rg -n "arguments|command|endpoint|environment|output|absolutePath|rawPayload" packages/core/src/tool-* apps/web/lib/tool-* migrations/1700000019_tool_activity_inventory.sql shim/rust/src/tool_event.rs shim/rust/src/collect/inventory.rs
```

Expected: matches occur only in rejection tests, comments, or forbidden-field lists; no wire type, SQL column, or serialized Rust field carries them.

- [ ] **Step 3: Verify no-load behavior**

Run two consecutive dry collections against unchanged fixture state and record counters.

```bash
cargo test --manifest-path shim/rust/Cargo.toml --release benchmark_collect_fixture -- --ignored --nocapture
```

Expected: second idle pass reports `body_reads=0`, `tool_posts=0`, `inventory_walks=0`, `inventory_puts=0`; changed-file pass reads each changed file once.

- [ ] **Step 4: Verify clean scope**

Run: `git status --short && git log --oneline -10`

Expected: only intentional feature files or local ignored artifacts; commits follow the task boundaries above.

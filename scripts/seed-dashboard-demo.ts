// 대시보드 레이아웃 검증용 데모 시드.
// 기존 seed:demo 는 GitHub Pages 정적 데모와 숫자가 맞물려 있으므로 건드리지 않는다.
import "dotenv/config";
import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { Pool } from "pg";
import { encryptContent, loadKek } from "../apps/web/lib/content-crypto";

const DEFAULT_DATABASE_URL = "postgresql://toard:toard@localhost:5432/toard";
const DEMO_PREFIX = "dashboard-demo";
const DAYS = Number(process.env.TOARD_DEMO_DAYS ?? 14);
const VIEWER_EMAIL = "demo.viewer@toard.local";
const VIEWER_PASSWORD = process.env.TOARD_DEMO_PASSWORD;

type Args = {
  dryRun: boolean;
  allowNonLocal: boolean;
  allowProduction: boolean;
};

type ProviderKey = "claude_code" | "codex" | "gemini" | "qwen";

type ModelDef = {
  provider: ProviderKey;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
};

type Person = {
  email: string;
  name: string;
  team: string;
  role: "admin" | "member";
  weight: number;
  hosts: string[];
};

type UsageSeed = {
  dedupKey: string;
  providerKey: ProviderKey;
  userEmail: string;
  teamName: string;
  sessionId: string;
  model: string;
  host: string;
  ts: Date;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  logAdapter: string;
};

type PromptSeed = {
  dedupKey: string;
  userEmail: string;
  sessionId: string;
  providerKey: ProviderKey;
  role: "user" | "assistant";
  ts: Date;
  text: string;
};

const PROVIDERS: Array<{ key: ProviderKey; label: string }> = [
  { key: "claude_code", label: "Claude Code" },
  { key: "codex", label: "Codex" },
  { key: "gemini", label: "Gemini CLI" },
  { key: "qwen", label: "Qwen Code" },
];

const MODELS: ModelDef[] = [
  { provider: "claude_code", model: "claude-sonnet-4-5", input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 },
  { provider: "claude_code", model: "claude-opus-4-5", input: 15, output: 75, cacheRead: 1.5, cacheCreate: 18.75 },
  { provider: "codex", model: "gpt-5-codex", input: 1.25, output: 10, cacheRead: 0.125, cacheCreate: 1.25 },
  { provider: "gemini", model: "gemini-2.5-pro", input: 1.25, output: 10, cacheRead: 0.125, cacheCreate: 1.25 },
  { provider: "qwen", model: "qwen3-coder-plus", input: 0.6, output: 2.4, cacheRead: 0.06, cacheCreate: 0.6 },
];

const PEOPLE: Person[] = [
  {
    email: VIEWER_EMAIL,
    name: "Demo Viewer",
    team: "Engineering",
    role: "admin",
    weight: 1.35,
    hosts: ["viewer-macbook", "office-mac-mini", "linux-workstation"],
  },
  {
    email: "demo.backend@toard.local",
    name: "Backend Demo",
    team: "Engineering",
    role: "member",
    weight: 1.05,
    hosts: ["backend-linux"],
  },
  {
    email: "demo.product@toard.local",
    name: "Product Demo",
    team: "Product",
    role: "member",
    weight: 0.72,
    hosts: ["product-macbook"],
  },
  {
    email: "demo.design@toard.local",
    name: "Design Demo",
    team: "Design",
    role: "member",
    weight: 0.48,
    hosts: ["design-imac"],
  },
];

function parseArgs(argv: string[]): Args {
  return {
    dryRun: argv.includes("--dry-run"),
    allowNonLocal: argv.includes("--allow-non-local"),
    allowProduction: argv.includes("--allow-production"),
  };
}

function assertSafeDatabaseUrl(url: string, args: Args): void {
  if (process.env.NODE_ENV === "production" && !args.allowProduction) {
    throw new Error("NODE_ENV=production 에서는 실행하지 않습니다. 정말 데모 DB라면 --allow-production 을 명시하세요.");
  }
  const parsed = new URL(url);
  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  if (!localHosts.has(parsed.hostname) && !args.allowNonLocal) {
    throw new Error(
      `DATABASE_URL 이 로컬이 아닙니다(${parsed.hostname}). 데모 데이터는 로컬 DB에서만 기본 허용됩니다. ` +
        "정말 안전한 데모 DB라면 --allow-non-local 을 명시하세요.",
    );
  }
}

function hash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function hashInt(input: string, max: number): number {
  return Number.parseInt(hash(input).slice(0, 8), 16) % max;
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

function atLocalHour(day: Date, hour: number, minute: number): Date {
  const d = new Date(day);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function clampHour(hour: number): number {
  return Math.max(0, Math.min(23, hour));
}

function ymd(day: Date): string {
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}

function slotsFor(dayOffset: number, person: Person, now: Date): number[] {
  const currentHour = now.getHours();
  if (dayOffset === 0) {
    const today = [currentHour - 10, currentHour - 7, currentHour - 5, currentHour - 3, currentHour - 1, currentHour];
    return [...new Set(today.map(clampHour))].filter((h) => person.email === VIEWER_EMAIL || hashInt(`${person.email}:today:${h}`, 3) === 0);
  }
  const base = person.email === VIEWER_EMAIL ? [8, 10, 13, 15, 18, 22] : [9, 14, 17];
  return base.filter((h) => hashInt(`${person.email}:${dayOffset}:${h}`, person.email === VIEWER_EMAIL ? 5 : 3) !== 0);
}

function usageNumbers(seed: string, weight: number): Pick<
  UsageSeed,
  "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheCreationTokens"
> {
  const inputTokens = Math.round((900 + hashInt(`${seed}:input`, 9_000)) * weight);
  const outputTokens = Math.round((240 + hashInt(`${seed}:output`, 2_700)) * weight);
  const cacheReadTokens = Math.round((inputTokens * (15 + hashInt(`${seed}:cache-read`, 55))) / 100);
  const cacheCreationTokens = Math.round((inputTokens * hashInt(`${seed}:cache-create`, 30)) / 100);
  return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens };
}

function costUsd(tokens: ReturnType<typeof usageNumbers>, model: ModelDef): number {
  const raw =
    tokens.inputTokens * model.input +
    tokens.outputTokens * model.output +
    tokens.cacheReadTokens * model.cacheRead +
    tokens.cacheCreationTokens * model.cacheCreate;
  return Number((raw / 1_000_000).toFixed(8));
}

function generateUsage(now = new Date()): UsageSeed[] {
  const events: UsageSeed[] = [];
  for (let dayOffset = 0; dayOffset < DAYS; dayOffset++) {
    const day = addDays(now, -dayOffset);
    for (const person of PEOPLE) {
      const slots = slotsFor(dayOffset, person, now);
      for (const [slotIndex, hour] of slots.entries()) {
        const seed = `${person.email}:d${dayOffset}:h${hour}:i${slotIndex}`;
        const model = MODELS[hashInt(`${seed}:model`, MODELS.length)]!;
        const host = person.hosts[hashInt(`${seed}:host`, person.hosts.length)]!;
        const minute = hashInt(`${seed}:minute`, 48) + 6;
        const tokens = usageNumbers(seed, person.weight);
        const sessionId = `${DEMO_PREFIX}-${person.email.split("@")[0]}-d${dayOffset}-s${Math.floor(hour / 4)}`;
        events.push({
          dedupKey: hash(`${DEMO_PREFIX}:usage:${seed}`),
          providerKey: model.provider,
          userEmail: person.email,
          teamName: person.team,
          sessionId,
          model: model.model,
          host,
          ts: atLocalHour(day, hour, minute),
          ...tokens,
          costUsd: costUsd(tokens, model),
          logAdapter: model.provider === "claude_code" ? "claude" : model.provider,
        });
      }
    }
  }
  return events.sort((a, b) => a.ts.getTime() - b.ts.getTime());
}

function generatePrompts(events: UsageSeed[]): PromptSeed[] {
  const recentViewerSessions = [...new Map(
    events
      .filter((e) => e.userEmail === VIEWER_EMAIL)
      .sort((a, b) => b.ts.getTime() - a.ts.getTime())
      .map((e) => [e.sessionId, e]),
  ).values()].slice(0, 6);

  return recentViewerSessions.flatMap((e, idx) => {
    const topic = [
      "대시보드 요약 스트립에서 비용 변화가 어떻게 보이는지 확인",
      "모델별 비용 분해와 기기별 비중을 비교",
      "오늘 시간대별 사용량 피크를 해석",
      "최근 세션 목록에서 히스토리 링크 동작 확인",
      "캐시 토큰이 토큰 합계에 반영되는지 점검",
      "필터 변경 후 차트 간격이 유지되는지 확인",
    ][idx]!;
    return [
      {
        dedupKey: hash(`${DEMO_PREFIX}:prompt:${e.sessionId}:user`),
        userEmail: e.userEmail,
        sessionId: e.sessionId,
        providerKey: e.providerKey,
        role: "user" as const,
        ts: new Date(e.ts.getTime() - 120_000),
        text: topic,
      },
      {
        dedupKey: hash(`${DEMO_PREFIX}:prompt:${e.sessionId}:assistant`),
        userEmail: e.userEmail,
        sessionId: e.sessionId,
        providerKey: e.providerKey,
        role: "assistant" as const,
        ts: new Date(e.ts.getTime() - 30_000),
        text: `데모 응답입니다. ${e.model} / ${e.host} / ${e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheCreationTokens} tokens.`,
      },
    ];
  });
}

async function upsertProviders(pool: Pool): Promise<void> {
  for (const p of PROVIDERS) {
    await pool.query(
      `INSERT INTO providers (key, display_name, service_name_patterns, collection_method, enabled)
       VALUES ($1, $2, ARRAY[]::text[], 'logfile', true)
       ON CONFLICT (key) DO UPDATE SET display_name = EXCLUDED.display_name, enabled = true`,
      [p.key, p.label],
    );
  }
}

async function upsertPricing(pool: Pool): Promise<void> {
  for (const m of MODELS) {
    await pool.query(
      `INSERT INTO pricing_revisions
         (model_id, input_price_per_mtok, output_price_per_mtok, cache_read_price_per_mtok,
          cache_creation_price_per_mtok, effective_at, source)
       VALUES ($1, $2, $3, $4, $5, TIMESTAMPTZ '2026-01-01T00:00:00Z', 'dashboard-demo')
       ON CONFLICT (model_id, effective_at, source) DO NOTHING`,
      [m.model, m.input, m.output, m.cacheRead, m.cacheCreate],
    );
  }
}

async function upsertTeamsAndUsers(pool: Pool): Promise<Map<string, { userId: string; teamId: string }>> {
  const passwordHash = VIEWER_PASSWORD ? await bcrypt.hash(VIEWER_PASSWORD, 12) : null;
  const teams = new Map<string, string>();
  for (const team of [...new Set(PEOPLE.map((p) => p.team))]) {
    const existing = await pool.query<{ id: string }>("SELECT id FROM teams WHERE name = $1 ORDER BY created_at LIMIT 1", [
      team,
    ]);
    if (existing.rows[0]) {
      teams.set(team, existing.rows[0].id);
      continue;
    }
    const created = await pool.query<{ id: string }>("INSERT INTO teams (name) VALUES ($1) RETURNING id", [team]);
    teams.set(team, created.rows[0]!.id);
  }

  const users = new Map<string, { userId: string; teamId: string }>();
  for (const person of PEOPLE) {
    const teamId = teams.get(person.team)!;
    const hashForUser = person.email === VIEWER_EMAIL ? passwordHash : null;
    const r = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name, role, team_id, password_hash, timezone, team_onboarding_completed_at)
       VALUES ($1, $2, $3, $4, $5, 'Asia/Seoul', now())
       ON CONFLICT (email) DO UPDATE SET
         name = EXCLUDED.name,
         role = EXCLUDED.role,
         team_id = EXCLUDED.team_id,
         password_hash = COALESCE(EXCLUDED.password_hash, users.password_hash),
         timezone = EXCLUDED.timezone,
         team_onboarding_completed_at = COALESCE(users.team_onboarding_completed_at, now())
       RETURNING id`,
      [person.email, person.name, person.role, teamId, hashForUser],
    );
    users.set(person.email, { userId: r.rows[0]!.id, teamId });
  }
  return users;
}

async function upsertUsage(pool: Pool, events: UsageSeed[], users: Map<string, { userId: string; teamId: string }>): Promise<number> {
  let upserted = 0;
  for (const e of events) {
    const owner = users.get(e.userEmail)!;
    const res = await pool.query(
      `INSERT INTO usage_events
         (dedup_key, provider_key, user_id, team_id, session_id, model, ts,
          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd,
          log_adapter, host)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (dedup_key) DO UPDATE SET
         provider_key = EXCLUDED.provider_key,
         user_id = EXCLUDED.user_id,
         team_id = EXCLUDED.team_id,
         session_id = EXCLUDED.session_id,
         model = EXCLUDED.model,
         ts = EXCLUDED.ts,
         input_tokens = EXCLUDED.input_tokens,
         output_tokens = EXCLUDED.output_tokens,
         cache_read_tokens = EXCLUDED.cache_read_tokens,
         cache_creation_tokens = EXCLUDED.cache_creation_tokens,
         cost_usd = EXCLUDED.cost_usd,
         log_adapter = EXCLUDED.log_adapter,
         host = EXCLUDED.host`,
      [
        e.dedupKey,
        e.providerKey,
        owner.userId,
        owner.teamId,
        e.sessionId,
        e.model,
        e.ts,
        e.inputTokens,
        e.outputTokens,
        e.cacheReadTokens,
        e.cacheCreationTokens,
        e.costUsd,
        e.logAdapter,
        e.host,
      ],
    );
    upserted += res.rowCount ?? 0;
  }
  return upserted;
}

async function upsertPrompts(pool: Pool, prompts: PromptSeed[], users: Map<string, { userId: string; teamId: string }>): Promise<number> {
  let kek: Buffer;
  try {
    kek = loadKek();
  } catch {
    console.log("⚠ TOARD_CONTENT_KEK_B64 미설정 — prompt_records 데모는 건너뜀");
    return 0;
  }

  let upserted = 0;
  await pool.query("BEGIN");
  try {
    const viewer = users.get(VIEWER_EMAIL)!.userId;
    await pool.query("SELECT set_config('app.current_user_id', $1, true)", [viewer]);
    for (const p of prompts) {
      const userId = users.get(p.userEmail)!.userId;
      const enc = encryptContent(p.text, kek);
      const res = await pool.query(
        `INSERT INTO prompt_records
           (dedup_key, user_id, session_id, provider_key, turn_role, ts,
            key_version, wrapped_dek, iv, ciphertext, auth_tag)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (dedup_key) DO UPDATE SET
           user_id = EXCLUDED.user_id,
           session_id = EXCLUDED.session_id,
           provider_key = EXCLUDED.provider_key,
           turn_role = EXCLUDED.turn_role,
           ts = EXCLUDED.ts,
           key_version = EXCLUDED.key_version,
           wrapped_dek = EXCLUDED.wrapped_dek,
           iv = EXCLUDED.iv,
           ciphertext = EXCLUDED.ciphertext,
           auth_tag = EXCLUDED.auth_tag`,
        [
          p.dedupKey,
          userId,
          p.sessionId,
          p.providerKey,
          p.role,
          p.ts,
          enc.keyVersion,
          enc.wrappedDek,
          enc.iv,
          enc.ciphertext,
          enc.authTag,
        ],
      );
      upserted += res.rowCount ?? 0;
    }
    await pool.query("COMMIT");
  } catch (e) {
    await pool.query("ROLLBACK");
    throw e;
  }
  return upserted;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const usage = generateUsage();
  const prompts = generatePrompts(usage);

  console.log(`dashboard demo seed: users=${PEOPLE.length}, days=${DAYS}, usage_events=${usage.length}, prompt_records=${prompts.length}`);
  console.log(`viewer email: ${VIEWER_EMAIL}`);
  if (VIEWER_PASSWORD) console.log("viewer password: TOARD_DEMO_PASSWORD 값 사용");
  if (args.dryRun) {
    const byProvider = new Map<string, number>();
    const byHost = new Map<string, number>();
    for (const e of usage) {
      byProvider.set(e.providerKey, (byProvider.get(e.providerKey) ?? 0) + 1);
      byHost.set(e.host, (byHost.get(e.host) ?? 0) + 1);
    }
    console.log("dry-run: DB 쓰기 없음");
    console.log("providers:", Object.fromEntries(byProvider));
    console.log("hosts:", Object.fromEntries(byHost));
    return;
  }

  const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  assertSafeDatabaseUrl(databaseUrl, args);
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await upsertProviders(pool);
    await upsertPricing(pool);
    const users = await upsertTeamsAndUsers(pool);
    const usageCount = await upsertUsage(pool, usage, users);
    const promptCount = await upsertPrompts(pool, prompts, users);
    console.log(`✓ providers ${PROVIDERS.length}, pricing ${MODELS.length}, users ${PEOPLE.length}`);
    console.log(`✓ usage_events upserted ${usageCount}`);
    console.log(`✓ prompt_records upserted ${promptCount}`);
    console.log(`AUTH_OPEN_USER_EMAIL=${VIEWER_EMAIL} 로 열면 내 사용량 화면이 이 사용자 기준으로 보입니다.`);
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});

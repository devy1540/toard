import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { cp, mkdtemp, realpath, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { promisify } from "node:util";
import bcrypt from "bcryptjs";
import { startTestPostgres } from "./test-support/postgres";
import { createInvite } from "../apps/web/lib/invites";
import { syncPricingRevisions } from "../apps/web/lib/pricing-sync";
import { fromLiteLLM } from "../packages/pricing/src/sync";

const exec = promisify(execFile);

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("TEST_PORT_MISSING");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

// Next standalone tracing must use the same local virtual store as Docker/CI.
// A shared store outside outputFileTracingRoot produces non-portable artifacts.
if (!(await realpath("apps/web/node_modules/next")).startsWith(`${await realpath("node_modules")}${sep}`)) {
  console.log("Preparing the local dependency layout used by Docker/CI…");
  await exec("pnpm", ["--config.enable-global-virtual-store=false", "install", "--frozen-lockfile"], {
    env: { ...process.env, CI: "1", PNPM_CONFIG_ENABLE_GLOBAL_VIRTUAL_STORE: "false" },
    maxBuffer: 4 * 1024 * 1024,
  });
  const backup = await mkdtemp(join(tmpdir(), "toard-browser-build-backup-"));
  await rename("apps/web/.next", join(backup, "next")).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

const db = await startTestPostgres("browser");
let child: ReturnType<typeof spawn> | undefined;
let interrupted = false;
const buildAbort = new AbortController();
const onSignal = () => { interrupted = true; buildAbort.abort(); child?.kill("SIGTERM"); };
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);

try {
  const directory = await mkdtemp(join(tmpdir(), "toard-browser-"));
  const emptyEnv = join(directory, "empty.env");
  await writeFile(emptyEnv, "", { mode: 0o600 });
  const password = randomBytes(24).toString("base64url");
  const token = randomBytes(24).toString("base64url");
  const origin = `http://127.0.0.1:${await availablePort()}`;
  // Do not inherit deployment credentials. Keep only OS/toolchain environment.
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "PNPM_HOME", "CI", "LANG", "LC_ALL", "SYSTEMROOT"].flatMap((key) => process.env[key] == null ? [] : [[key, process.env[key]!]]),
  );
  Object.assign(env, {
    DATABASE_URL: db.connectionString, DOTENV_CONFIG_PATH: emptyEnv,
    AUTH_SECRET: randomBytes(48).toString("base64url"), CRON_SECRET: randomBytes(32).toString("base64url"),
    AUTH_MODE: "oauth", AUTH_CREDENTIALS_ENABLED: "true", AUTH_REGISTRATION_MODE: "invite_only",
    AUTH_TRUST_HOST: "true", AUTH_URL: origin, TOARD_PUBLIC_URL: origin,
    AUTH_GITHUB_ID: "", AUTH_GITHUB_SECRET: "", AUTH_GOOGLE_ID: "", AUTH_GOOGLE_SECRET: "",
    ALLOWED_EMAIL_DOMAINS: "example.test", BOOTSTRAP_SETUP_TOKEN: "", BOOTSTRAP_ADMIN_EMAIL: "", BOOTSTRAP_ADMIN_PASSWORD: "",
    TOARD_KEY_ACTIVE_PROVIDER: "", TOARD_KEY_MIGRATION_PROVIDER: "", TOARD_CONTENT_KEK_B64: "",
    TOARD_UPDATER_URL: "", TOARD_UPDATER_SECRET: "", GITHUB_TOKEN: "",
    STORAGE_BACKEND: "postgres", PRICING_AUTO_SYNC: "off", TOARD_TOOL_DEPLOYMENT_EXPERIMENTAL: "0",
    TOARD_DEPLOYMENT_RELEASE_ID: "", TOARD_DEPLOYMENT_SCHEMA_VERSION: "", TOARD_DEPLOYMENT_IMAGE_TAG: "",
    ORG_TIMEZONE: "Asia/Seoul", NEXT_TELEMETRY_DISABLED: "1",
    PNPM_CONFIG_ENABLE_GLOBAL_VIRTUAL_STORE: "false",
    TOARD_DEMO_PASSWORD: password, TOARD_DEMO_DAYS: "35",
    TOARD_BROWSER_TEST_URL: origin, TOARD_BROWSER_TEST_PASSWORD: password,
    TOARD_BROWSER_TEST_TOKEN: token,
    ...(process.env.TOARD_UPDATE_DEMO === "1" ? { TOARD_UPDATE_DEMO: "1" } : {}),
  });
  await exec("pnpm", ["seed:dashboard-demo"], { env, maxBuffer: 4 * 1024 * 1024 });
  await syncPricingRevisions(db.pool, fromLiteLLM({
    "gemini-2.5-pro": {
      input_cost_per_token: 1.25e-6, output_cost_per_token: 10e-6,
      input_cost_per_token_above_200k_tokens: 2.5e-6, output_cost_per_token_above_200k_tokens: 15e-6,
      cache_read_input_token_cost: 0.125e-6, cache_read_input_token_cost_above_200k_tokens: 0.25e-6,
    },
  }), new Date(Date.now() - 60_000));
  const owner = (await db.pool.query("SELECT id FROM users WHERE email='demo.viewer@toard.local'")).rows[0].id;
  const team = (await db.pool.query("SELECT id FROM teams ORDER BY name LIMIT 1")).rows[0].id;
  const member = (await db.pool.query(
    "INSERT INTO users(email, name, password_hash, role, team_onboarding_completed_at) VALUES('browser.member@example.test','Browser Member',$1,'member',now()) RETURNING id",
    [await bcrypt.hash(password, 12)],
  )).rows[0].id;
  await db.pool.query("INSERT INTO ingest_tokens(user_id, token_hash) VALUES($1,$2)", [owner, createHash("sha256").update(token).digest("hex")]);
  const invite = await createInvite("browser.invited@example.test", "member", team, owner, db.pool);
  if (!invite.ok) throw new Error("TEST_INVITATION_FAILED");
  env.TOARD_BROWSER_TEST_INVITE = invite.token;
  env.TOARD_BROWSER_TEST_MEMBER_ID = member;
  env.TOARD_BROWSER_TEST_OWNER_ID = owner;

  console.log("Building the production app for the isolated browser fixture…");
  try {
    const built = await exec("pnpm", ["build"], { env, maxBuffer: 8 * 1024 * 1024, timeout: 240_000, signal: buildAbort.signal });
    await writeFile(join(directory, "build.log"), `${built.stdout}\n${built.stderr}`, { mode: 0o600 });
  } catch (error) {
    const output = error as { stdout?: string; stderr?: string };
    await writeFile(join(directory, "build.log"), `${output.stdout ?? ""}\n${output.stderr ?? ""}`, { mode: 0o600 });
    throw new Error(`Browser fixture build failed. Inspect ${join(directory, "build.log")}`);
  }
  if (interrupted) throw new Error("BROWSER_TEST_INTERRUPTED");
  await cp("apps/web/.next/static", "apps/web/.next/standalone/apps/web/.next/static", { recursive: true });
  await cp("apps/web/public", "apps/web/.next/standalone/apps/web/public", { recursive: true });
  child = spawn("pnpm", ["exec", "playwright", "test", ...process.argv.slice(2)], { env, stdio: "inherit" });
  const code = await new Promise<number>((resolve, reject) => { child!.once("error", reject); child!.once("exit", (code) => resolve(code ?? 1)); });
  if (code !== 0) process.exitCode = code;
} finally {
  await db.close();
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
  if (interrupted) process.exitCode = 130;
}

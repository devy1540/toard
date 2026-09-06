import { expect, test, type Page } from "@playwright/test";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

const exec = promisify(execFile);
const appOrigin = process.env.TOARD_BROWSER_TEST_URL!;
const port = Number(process.env.TOARD_BROWSER_TEST_SHIM_PORT);
const fixtureParent = process.env.TOARD_BROWSER_TEST_FIXTURE_DIR;
if (!fixtureParent || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Use the isolated browser test runner.");
const localOrigin = `http://127.0.0.1:${port}`;

async function fixture() {
  const root = await mkdtemp(join(fixtureParent!, "local-scope-"));
  const home = join(root, "home");
  await mkdir(join(home, ".codex", "sessions"), { recursive: true });
  const shim = join(root, process.platform === "win32" ? "toard-shim.exe" : "toard-shim");
  const source = resolve("shim/rust/target/debug", process.platform === "win32" ? "shim.exe" : "shim");
  if (process.platform === "win32") await copyFile(source, shim); else await symlink(source, shim);
  const env: NodeJS.ProcessEnv = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TMPDIR", "TMP", "TEMP"].flatMap(key => process.env[key] == null ? [] : [[key, process.env[key]!]]));
  Object.assign(env, {
    HOME: home, USERPROFILE: home, CODEX_HOME: join(home, ".codex"), CURSOR_AGENT_HOME: join(home, ".cursor"),
    APPDATA: join(home, "AppData/Roaming"), LOCALAPPDATA: join(home, "AppData/Local"),
    TOARD_SHIM_LOCAL_PORT: String(port), TOARD_SHIM_LOCAL_ACTION: "1", TOARD_SHIM_AUTO_UPDATE: "off",
    TOARD_INGEST_ENDPOINT: `${appOrigin}/api`, TOARD_UI_ORIGIN: appOrigin,
    TOARD_SHIM_COLLECT_CONTENT: "0", TOARD_SHIM_COLLECT_TOOLS: "0", TOARD_SHIM_SCOPE: "review",
    TOARD_HOST_LABEL: "scope-browser-fixture",
  });
  let child: ChildProcess | undefined;
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}) => exec(shim, args, { env: { ...env, ...extra }, cwd: root, timeout: 20_000, maxBuffer: 2 * 1024 * 1024 });
  return {
    root, home, run,
    async writeLogs() {
      for (const kind of ["work", "private"]) {
        const rows = [
          { type: "session_meta", payload: { session_id: `scope-${kind}`, cwd: `/fixture/${kind}-project` } },
          { type: "turn_context", payload: { model: `scope-${kind}-model` } },
          { timestamp: new Date().toISOString(), type: "event_msg", payload: { type: "token_count", info: {
            last_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20 }, total_token_usage: { input_tokens: 100, output_tokens: 20 },
          } } },
        ];
        await writeFile(join(home, ".codex/sessions", `${kind}.jsonl`), rows.map(row => JSON.stringify(row)).join("\n"), { mode: 0o600 });
      }
    },
    async start() {
      child = spawn(shim, ["local", "serve"], { env, cwd: root, stdio: "ignore" });
      await expect.poll(async () => {
        if (child!.exitCode != null) throw new Error("Fixture bridge exited before becoming ready");
        try {
          const secret = (await readFile(join(home, ".toard/state/local-bridge-secret"), "utf8")).trim();
          const response = await fetch(`${localOrigin}/internal/ping`, { headers: { "X-Toard-Local-Secret": secret }, signal: AbortSignal.timeout(500) });
          return response.ok && (await response.json()).ok === true;
        } catch { return false; }
      }).toBe(true);
    },
    async close() {
      if (child && child.exitCode == null) {
        const closed = new Promise<void>(resolve => child!.once("exit", () => resolve()));
        child.kill("SIGTERM");
        const timeout = setTimeout(() => child?.kill("SIGKILL"), 5_000);
        await closed; clearTimeout(timeout);
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("이메일", { exact: true }).fill("browser.scope@example.test");
  await page.getByLabel("비밀번호", { exact: true }).fill(process.env.TOARD_BROWSER_TEST_PASSWORD!);
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

test("review installation pauses delivery until the local project selection is applied", async ({ page, context }, testInfo) => {
  const local = await fixture();
  try {
    await local.writeLogs(); await local.start(); await login(page);
    await page.goto("/settings?tab=install");
    await page.getByRole("button", { name: "이 컴퓨터 연결하기", exact: true }).click();
    await page.getByRole("button", { name: "macOS", exact: true }).click();
    await expect(page.getByLabel("이 서버로 보낼 기록", { exact: true })).toHaveValue("review");
    await page.getByRole("button", { name: "네, 계속할게요", exact: true }).click();
    const command = await page.locator("pre code").first().innerText();
    expect(command).toContain("TOARD_SHIM_SCOPE='review'");
    const token = command.match(/tk_[a-f0-9]{48}/)?.[0];
    expect(Boolean(token)).toBeTruthy();
    await local.run(["target", "upsert"], { TOARD_INGEST_TOKEN: token });
    // The same new collector can run immediately after installation without
    // sending either project before the user has reviewed their scope.
    await local.run(["collect", "--adapter", "codex", "--target-env"]);
    const evidence = await context.newPage();
    await evidence.goto("/costs");
    await expect(evidence.getByText("scope-work-model", { exact: true })).toHaveCount(0);
    await expect(evidence.getByText("scope-private-model", { exact: true })).toHaveCount(0);
    await evidence.close();

    const opened = page.waitForEvent("popup");
    await page.getByRole("button", { name: "명령을 실행했어요 · 범위 선택", exact: true }).click();
    const popup = await opened;
    await expect(popup).toHaveURL(new RegExp(`^${localOrigin}/v1/helper\\?.*mode=scope`));
    await expect(popup.getByRole("button", { name: "이 범위 적용", exact: true })).toBeVisible();
    await popup.locator("#mode").selectOption("custom");
    await popup.getByLabel("Codex 수집 범위", { exact: true }).selectOption("include");
    await popup.getByRole("checkbox", { name: /\/fixture\/work-project/ }).check();
    await expect(popup.locator("#summary")).toContainText("사용량 1건");
    await popup.setViewportSize({ width: 900, height: 850 });
    await popup.screenshot({ path: testInfo.outputPath("scope-preview.png"), fullPage: true });
    await popup.setViewportSize({ width: 390, height: 844 });
    expect(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
    const closed = popup.waitForEvent("close");
    await popup.getByRole("button", { name: "이 범위 적용", exact: true }).click();
    await closed;
    await local.run(["collect", "--adapter", "codex", "--target-env"]);
    await expect(page.getByRole("heading", { name: "첫 사용량 저장을 확인했습니다", exact: true })).toBeVisible();
    await page.goto("/costs");
    await expect(page.getByText("scope-work-model", { exact: true })).toBeVisible();
    await expect(page.getByText("scope-private-model", { exact: true })).toHaveCount(0);
    expect(await page.locator("body").innerText()).not.toContain("/fixture/");
  } finally { await local.close(); }
});

test("local scope confirmation rejects foreign origins, stale windows, replay and label markup", async ({ page, request }) => {
  const local = await fixture();
  try {
    await local.writeLogs();
    const maliciousLabel = '/fixture/<img src=x onerror="globalThis.scopeXss=true">';
    await writeFile(join(local.home, ".codex/sessions/label.jsonl"), [
      { type: "session_meta", payload: { session_id: "label-test", cwd: maliciousLabel } },
      { type: "turn_context", payload: { model: "fixture-model" } },
    ].map(value => JSON.stringify(value)).join("\n"));
    await local.run(["target", "upsert"], { TOARD_INGEST_TOKEN: "fixture-local-only-token" });
    await local.start();
    const target = createHash("sha256").update(`${appOrigin}/api`).digest("hex");
    await page.goto(`${localOrigin}/v1/helper?target=${target}&nonce=${"a".repeat(32)}&mode=scope`);
    await expect(page.getByRole("button", { name: "이 범위 적용", exact: true })).toBeVisible();
    await page.locator("#mode").selectOption("custom");
    expect(await page.evaluate("globalThis.scopeXss === true")).toBe(false);
    await expect(page.locator(".projects img")).toHaveCount(0);
    expect(await page.locator(".projects").allTextContents()).toEqual(expect.arrayContaining([expect.stringContaining(maliciousLabel)]));
    const capability = await page.evaluate("boot.capability") as string;
    const policy = { schemaVersion: 1, mode: "all", providers: {} };
    const authorization = `Bearer ${capability}`;
    expect((await request.post(`${localOrigin}/v1/scope/apply`, { headers: { Authorization: authorization, Origin: appOrigin }, data: policy })).status()).toBe(403);
    expect((await request.post(`${localOrigin}/v1/scope/apply`, { headers: { Authorization: authorization, Origin: localOrigin, Host: "untrusted.example" }, data: policy })).status()).toBe(403);
    await local.run(["target", "upsert"], { TOARD_INGEST_TOKEN: "replacement-fixture-token" });
    await page.getByRole("button", { name: "이 범위 적용", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("서버 연결 설정이 변경되었습니다");
    const unchanged = JSON.parse((await local.run(["scope", "preview", "--target-env"])).stdout);
    expect(unchanged.policy.mode).toBe("paused");
    await page.reload();
    await expect(page.getByRole("button", { name: "이 범위 적용", exact: true })).toBeVisible();
    const fresh = await page.evaluate("boot.capability") as string;
    await page.locator("#mode").selectOption("all");
    await page.getByRole("button", { name: "이 범위 적용", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("수집 범위를 저장했습니다");
    expect((await request.post(`${localOrigin}/v1/scope/apply`, { headers: { Authorization: `Bearer ${fresh}`, Origin: localOrigin }, data: policy })).status()).toBe(401);
  } finally { await local.close(); }
});

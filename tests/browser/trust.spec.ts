import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const password = process.env.TOARD_BROWSER_TEST_PASSWORD!;
const token = process.env.TOARD_BROWSER_TEST_TOKEN!;
if (!password || !token) throw new Error("Browser fixture credentials are required.");

async function login(page: Page, email = "demo.viewer@toard.local") {
  await page.goto("/login");
  await page.getByLabel("이메일", { exact: true }).fill(email);
  await page.getByLabel("비밀번호", { exact: true }).fill(password);
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page).not.toHaveURL(/\/login(?:\?|$)/);
}

test("public password signup is closed and unauthenticated cost access requires login", async ({ page }) => {
  await page.goto("/signup");
  await expect(page.getByText(/관리자에게 초대 링크를 요청/)).toBeVisible();
  await expect(page.locator('input[name="password"]')).toHaveCount(0);
  await page.goto("/costs");
  await expect(page).toHaveURL(/\/login(?:\?|$)/);
});

test("password login works, personal ledger ignores forged user scope, and members cannot assign a team", async ({ page }) => {
  await login(page, "browser.member@example.test");
  await page.goto(`/costs?period=30&userId=${process.env.TOARD_BROWSER_TEST_OWNER_ID}`);
  await expect(page.getByText("이 기간에 보존된 사용량 기록이 없습니다.")).toBeVisible();
  await page.goto("/onboarding/team");
  await expect(page.getByText(/팀 소속은 관리자가 배정/)).toBeVisible();
  await expect(page.locator('input[name="teamId"]')).toHaveCount(0);
  await page.goto("/admin");
  await expect(page).not.toHaveURL(/\/admin(?:\?|$)/);
});

test("one-time invitation creates an account and cannot be reused", async ({ page, browser }) => {
  const invitePath = `/invite/${process.env.TOARD_BROWSER_TEST_INVITE}`;
  await page.goto(invitePath);
  await page.locator('input[name="name"]').fill("Invited Browser Member");
  await page.locator('input[name="password"]').fill(password);
  await page.locator('input[name="confirm"]').fill(password);
  await page.getByRole("button", { name: "가입하고 시작", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\?tab=install/);
  const anonymous = await browser.newContext({ locale: "ko-KR" });
  try {
    const otherPage = await anonymous.newPage();
    await otherPage.goto(new URL(invitePath, process.env.TOARD_BROWSER_TEST_URL).href);
    await expect(otherPage.getByText(/유효하지 않거나 만료된 초대/)).toBeVisible();
    await expect(otherPage.locator('input[name="password"]')).toHaveCount(0);
  } finally { await anonymous.close(); }
});

test("real ingestion renders unpriced coverage and a personal cost ledger without collecting content", async ({ page, request }) => {
  const event = {
    dedupKey: `browser-unknown-${Date.now()}`, providerKey: "gemini", userId: process.env.TOARD_BROWSER_TEST_MEMBER_ID,
    sessionId: "browser-cost-session", model: "unpriced-test-model", ts: new Date().toISOString(),
    inputTokens: 123, outputTokens: 45, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 999,
  };
  const priced = { ...event, dedupKey: `browser-priced-${Date.now()}`, model: "gemini-2.5-pro", inputTokens: 300_000, outputTokens: 10_000 };
  const invalid = await request.post("/api/v1/events", { headers: { Authorization: `Bearer ${token}` }, data: [{ ...event, cacheCreationTokens: 1, cacheCreation1hTokens: 2 }] });
  expect(invalid.status()).toBe(400);
  const response = await request.post("/api/v1/events", { headers: { Authorization: `Bearer ${token}` }, data: [event, priced] });
  expect(response.ok()).toBeTruthy();
  expect((await response.json()).inserted).toBe(2);
  await login(page);
  await page.goto("/?period=30");
  await expect(page.locator('[data-dashboard-ready="user-overview"]')).toBeVisible();
  await expect(page.locator('[data-cost-basis="api-equivalent"]')).toBeVisible();
  await expect(page.locator('[data-cost-basis="api-equivalent"]')).toContainText(/API 요율로 환산한 추정액/);
  await expect(page.getByText(/가격.*미확정/).first()).toBeVisible();
  await page.getByRole("link", { name: "내 비용 계산 내역", exact: true }).click();
  await expect(page.locator('[data-cost-evidence="personal"]')).toBeVisible();
  await expect(page.getByText("unpriced-test-model", { exact: true })).toBeVisible();
  await expect(page.locator('[data-cost-status="unpriced"]')).toContainText("가격 미확정");
  const calculation = page.locator('[data-cost-status="priced"]').filter({ hasText: "gemini-2.5-pro" }).first();
  await expect(calculation.getByRole("button")).toContainText("$0.90");
  await calculation.getByRole("button").click();
  await expect(calculation.getByText("cost-v2", { exact: true })).toBeVisible();
  await expect(calculation.getByText("$0.750000", { exact: true })).toBeVisible();
  await expect(calculation.getByText("$0.150000", { exact: true })).toBeVisible();
  if (process.env.TOARD_UPDATE_DEMO === "1") {
    await mkdir(resolve("site/assets/screenshots"), { recursive: true });
    await page.screenshot({ path: resolve("site/assets/screenshots/cost-ledger.png") });
  }
});

test("sample dashboard renders at desktop and mobile widths", async ({ page }) => {
  await login(page);
  await page.goto("/?period=30");
  await expect(page.locator('[data-dashboard-ready="user-overview"]')).toBeVisible();
  if (process.env.TOARD_UPDATE_DEMO === "1") {
    await mkdir(resolve("site/assets/screenshots"), { recursive: true });
    await page.screenshot({ path: resolve("site/assets/screenshots/my-usage.png"), fullPage: true });
    await page.goto("/org?period=30");
    await expect(page.locator('[data-dashboard-ready="org-overview"]')).toBeVisible();
    await page.screenshot({ path: resolve("site/assets/screenshots/team-usage.png"), fullPage: true });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?period=30");
  await expect(page.locator('[data-dashboard-ready="user-overview"]')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBeTruthy();
});

test("landing and preview link to actual synthetic app screenshots without horizontal overflow", async ({ page }, testInfo) => {
  await page.goto(pathToFileURL(resolve("site/index.html")).href);
  await expect(page.getByRole("link", { name: "실제 화면 미리보기", exact: true })).toHaveAttribute("href", "demo/");
  await expect.poll(() => page.locator("main img").first().evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath("landing.png"), fullPage: true });
  await page.goto(pathToFileURL(resolve("site/demo/index.html")).href);
  await expect(page.getByText(/정적 화면 미리보기/)).toBeVisible();
  for (const image of await page.locator("main img").all()) {
    await image.scrollIntoViewIfNeeded();
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBeTruthy();
});

test("onboarding distinguishes an authenticated connection and health report from committed usage", async ({ page, request }) => {
  await login(page, "browser.member@example.test");
  await page.goto("/settings?tab=install");
  await page.getByRole("button", { name: "이 컴퓨터 연결하기", exact: true }).click();
  await page.getByRole("button", { name: "macOS", exact: true }).click();
  await page.getByLabel("이 서버로 보낼 기록", { exact: true }).selectOption("all");
  await page.getByRole("button", { name: "네, 계속할게요", exact: true }).click();
  const command = await page.locator("pre code").first().innerText();
  const deviceToken = command.match(/tk_[a-f0-9]{48}/)?.[0];
  expect(Boolean(deviceToken)).toBeTruthy();
  const headers = { Authorization: `Bearer ${deviceToken}` };
  expect((await request.post("/api/v1/events", { headers, data: [] })).ok()).toBeTruthy();
  const health = await request.post("/api/v1/collection-status", { headers, data: {
    schemaVersion: 1, host: "fixture-computer", collectors: [{ providerKey: "gemini", state: "no_records", scannedFiles: 0, parsedEvents: 0, parseErrors: 0, pendingEvents: 0 }],
  } });
  expect(health.ok()).toBeTruthy();
  await page.getByRole("button", { name: "명령을 실행했어요", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "컴퓨터 연결 확인" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "첫 사용량 저장을 확인했습니다" })).toHaveCount(0);
  expect((await request.post("/api/v1/events", { headers, data: [{
    dedupKey: `first-device-usage-${Date.now()}`, providerKey: "gemini", model: "gemini-2.5-pro",
    ts: new Date().toISOString(), host: "fixture-computer", inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0,
  }] })).ok()).toBeTruthy();
  await expect(page.getByRole("heading", { name: "첫 사용량 저장을 확인했습니다" })).toBeVisible();
  await page.reload();
  await expect(page.locator('[data-collection-health="personal"]')).toContainText("fixture-computer");
  await expect(page.locator('[data-collection-health="personal"]')).toContainText("Gemini");
});

import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

const week = process.env.TOARD_BROWSER_REPORT_WEEK!;
if (!week) throw new Error("Use the isolated browser report fixture.");
async function login(page: Page, email = "browser.report@example.test") {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("이메일", { exact: true }).fill(email);
  await page.getByLabel("비밀번호", { exact: true }).fill(process.env.TOARD_BROWSER_TEST_PASSWORD!);
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

test("weekly report shows reproducible drivers, incomplete pricing and a formula-safe CSV", async ({ page }, testInfo) => {
  await login(page);
  await page.goto(`/reports?week=${week}&userId=${process.env.TOARD_BROWSER_TEST_OWNER_ID}`);
  await expect(page.locator('[data-weekly-report="user"]')).toBeVisible();
  await expect(page.locator('[data-cost-driver="volume"]')).toHaveText("$1.00");
  await expect(page.getByText("report-browser-model", { exact: true })).toBeVisible();
  await expect(page.getByText(/가격이 없는 기록의 금액은 합계에 반영되지 않습니다/)).toBeVisible();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("link", { name: "CSV 다운로드", exact: true }).click();
  const download = await downloaded;
  const path = testInfo.outputPath("weekly-report.csv");
  await download.saveAs(path);
  const csv = await readFile(path, "utf8");
  expect(csv).toContain('"\'=report-formula"');
  expect(csv).toContain("report-browser-model");
  expect(csv).toContain("cost-drivers-v1");
  expect(csv).not.toContain("demo.viewer@toard.local");
  await page.screenshot({ path: testInfo.outputPath("weekly-report.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
});

test("report downloads enforce personal, leader and administrator boundaries", async ({ page, request }) => {
  const base = `/api/reports/weekly?week=${week}`;
  expect((await request.get(base)).status()).toBe(401);
  await login(page);
  expect((await page.request.get(`${base}&scope=organization`)).status()).toBe(403);
  expect((await page.request.get(`${base}&scope=team:${process.env.TOARD_BROWSER_REPORT_OTHER_TEAM}`)).status()).toBe(403);
  const ownTeam = await page.request.get(`${base}&scope=team:${process.env.TOARD_BROWSER_REPORT_TEAM}`);
  expect(ownTeam.status()).toBe(200);
  expect(ownTeam.headers()["cache-control"]).toContain("no-store");
  await page.goto(`/reports?week=${week}&scope=organization`);
  await expect(page.getByRole("alert").filter({ hasText: "보고서를 볼 권한이 없습니다" })).toBeVisible();
  await login(page, "demo.viewer@toard.local");
  expect((await page.request.get(`${base}&scope=organization`)).status()).toBe(200);
  expect((await page.request.get(`${base}&scope=team:${process.env.TOARD_BROWSER_REPORT_OTHER_TEAM}`)).status()).toBe(200);
  expect((await page.request.get("/api/reports/weekly?week=2026-02-30")).status()).toBe(400);
});

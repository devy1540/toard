import { defineConfig, devices } from "@playwright/test";

const url = process.env.TOARD_BROWSER_TEST_URL;
if (!url) throw new Error("Use pnpm test:browser to create an isolated test database and server.");
const target = new URL(url);
if (target.hostname !== "127.0.0.1" || target.protocol !== "http:" || !/^\d+$/.test(target.port) || target.username || target.password || target.search || target.hash || target.pathname !== "/") {
  throw new Error("Browser tests only accept their runner's exact loopback origin.");
}

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: "list",
  use: {
    baseURL: target.origin,
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } } }],
  webServer: {
    command: "node apps/web/.next/standalone/apps/web/server.js",
    env: { PORT: target.port, HOSTNAME: "127.0.0.1" },
    url: `${target.origin}/api/ready`,
    reuseExistingServer: false,
    timeout: 60_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
  },
});

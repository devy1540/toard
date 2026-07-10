export type DashboardBenchmarkOptions = {
  fixture: string;
  events: number;
  days: number;
  users: number;
  providers: number;
  models: number;
  runs: number;
  app: "start";
};

export function dashboardFixtureStart(now = new Date()): Date {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const elapsedToday = now.getTime() - today.getTime();
  if (elapsedToday >= 2 * 60 * 60 * 1_000) {
    return new Date(today.getTime() - 399 * 86_400_000);
  }
  return new Date(today.getTime() - 400 * 86_400_000 + 2 * 60 * 60 * 1_000);
}

export function parseDashboardBenchmarkOptions(_args: readonly string[]): DashboardBenchmarkOptions {
  const options: DashboardBenchmarkOptions = {
    fixture: "dashboard-http-v1",
    events: 1_000_000,
    days: 400,
    users: 100,
    providers: 5,
    models: 10,
    runs: 100,
    app: "start",
  };
  const expected = new Map<string, number | string>([
    ["--fixture", options.fixture],
    ["--events", options.events],
    ["--days", options.days],
    ["--users", options.users],
    ["--providers", options.providers],
    ["--models", options.models],
    ["--runs", options.runs],
  ]);
  for (const arg of _args) {
    if (arg === "--") continue;
    const [name, value] = arg.split("=", 2);
    if (!name || !value) throw new Error(`invalid dashboard benchmark argument: ${arg}`);
    const required = expected.get(name);
    if (required == null) throw new Error(`unsupported dashboard benchmark argument: ${arg}`);
    if (String(required) !== value) throw new Error(`${name} must be ${required}`);
  }
  return options;
}

export function assertLocalBenchmarkTarget(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid localhost URL`);
  }
  if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    throw new Error(`${name} must point at localhost/127.0.0.1/::1`);
  }
  return value;
}

export function assertNonProductionBenchmarkEnvironment(env: NodeJS.ProcessEnv): void {
  for (const name of ["NODE_ENV", "TOARD_ENV", "ENVIRONMENT", "VERCEL_ENV"] as const) {
    const value = env[name]?.trim().toLowerCase();
    if (value === "prod" || value === "production") {
      throw new Error(`dashboard HTTP benchmark is forbidden in production (${name})`);
    }
  }
}

export function benchmarkPercentiles(durations: readonly number[]): { p50: number; p95: number } {
  if (durations.length !== 100 || durations.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("dashboard benchmark requires exactly 100 finite non-negative durations");
  }
  const sorted = [...durations].sort((a, b) => a - b);
  return { p50: sorted[49]!, p95: sorted[94]! };
}

export async function assertDashboardResponse(response: Response, expectedMarker: string): Promise<string> {
  const location = response.headers.get("location") ?? "";
  if (response.status >= 300 && response.status < 400 && /\/login(?:\?|$)/.test(location)) {
    throw new Error(`dashboard benchmark received login redirect: ${location}`);
  }
  if (response.status !== 200) {
    throw new Error(`dashboard benchmark expected HTTP 200, received ${response.status}`);
  }
  if (/\/login(?:\?|$)/.test(new URL(response.url || "http://localhost/").pathname)) {
    throw new Error("dashboard benchmark followed a login redirect");
  }
  const body = await response.text();
  if (!body.includes(expectedMarker)) {
    throw new Error(`dashboard benchmark response missing expected page marker: ${expectedMarker}`);
  }
  return body;
}

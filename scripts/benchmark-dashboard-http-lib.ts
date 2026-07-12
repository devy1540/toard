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

export type BenchmarkExecutionMode = "diagnostic" | "release";

export type ContainerResourceLimit = {
  service: "app" | "postgres" | "clickhouse";
  nanoCpus: number;
  memoryBytes: number;
};

export const REFERENCE_RESOURCE_LIMITS: readonly ContainerResourceLimit[] = [
  { service: "app", nanoCpus: 1_500_000_000, memoryBytes: 2 * 1024 ** 3 },
  { service: "postgres", nanoCpus: 1_000_000_000, memoryBytes: 2 * 1024 ** 3 },
  { service: "clickhouse", nanoCpus: 1_500_000_000, memoryBytes: 4 * 1024 ** 3 },
];

export function assertReferenceContainerLimits(_limits: readonly ContainerResourceLimit[]): void {
  const actual = new Map(_limits.map((limit) => [limit.service, limit]));
  for (const expected of REFERENCE_RESOURCE_LIMITS) {
    const limit = actual.get(expected.service);
    if (!limit || limit.nanoCpus !== expected.nanoCpus || limit.memoryBytes !== expected.memoryBytes) {
      throw new Error(
        `resource limit mismatch for ${expected.service}: expected cpu=${expected.nanoCpus} memory=${expected.memoryBytes}; actual=${JSON.stringify(limit ?? null)}`,
      );
    }
  }
  if (actual.size !== REFERENCE_RESOURCE_LIMITS.length) {
    throw new Error(`resource limit mismatch: expected exactly ${REFERENCE_RESOURCE_LIMITS.length} services`);
  }
  const totalCpu = _limits.reduce((sum, limit) => sum + limit.nanoCpus, 0);
  const totalMemory = _limits.reduce((sum, limit) => sum + limit.memoryBytes, 0);
  if (totalCpu !== 4_000_000_000 || totalMemory !== 8 * 1024 ** 3) {
    throw new Error(`resource limit mismatch for total: cpu=${totalCpu} memory=${totalMemory}`);
  }
}

export function effectiveNanoCpus(_hostConfig: { NanoCpus?: number; CpuQuota?: number; CpuPeriod?: number }): number {
  if ((_hostConfig.NanoCpus ?? 0) > 0) return _hostConfig.NanoCpus!;
  const quota = _hostConfig.CpuQuota ?? 0;
  const period = _hostConfig.CpuPeriod ?? 0;
  return quota > 0 && period > 0 ? Math.round((quota / period) * 1_000_000_000) : 0;
}

export function assertAppCgroupLimits(_cpuMax: string, _memoryMax: string): void {
  const [quotaRaw, periodRaw] = _cpuMax.trim().split(/\s+/, 2);
  const quota = Number(quotaRaw);
  const period = Number(periodRaw);
  const nanoCpus = Number.isFinite(quota) && Number.isFinite(period) && period > 0
    ? Math.round((quota / period) * 1_000_000_000)
    : 0;
  if (nanoCpus !== 1_500_000_000) {
    throw new Error(`app cgroup CPU limit mismatch: ${_cpuMax.trim()}`);
  }
  if (Number(_memoryMax.trim()) !== 2 * 1024 ** 3) {
    throw new Error(`app cgroup memory limit mismatch: ${_memoryMax.trim()}`);
  }
}

export function benchmarkExecutionMode(_env: NodeJS.ProcessEnv): BenchmarkExecutionMode {
  if (_env.BENCHMARK_RELEASE_MODE !== "1") return "diagnostic";
  if (_env.BENCHMARK_LIMITS_VERIFIED !== "docker-inspect") {
    throw new Error("release benchmark Docker limits were not verified");
  }
  return "release";
}

export function assertBenchmarkTarget(
  _name: "APP_BASE_URL" | "DATABASE_URL" | "CLICKHOUSE_URL",
  _value: string,
  _mode: BenchmarkExecutionMode,
): string {
  if (_mode === "diagnostic" || _name === "APP_BASE_URL") {
    return assertLocalBenchmarkTarget(_name, _value);
  }
  let url: URL;
  try {
    url = new URL(_value);
  } catch {
    throw new Error(`${_name} must be a valid benchmark compose service URL`);
  }
  const expectedHostname = _name === "DATABASE_URL" ? "postgres" : "clickhouse";
  if (url.hostname !== expectedHostname) {
    throw new Error(`${_name} must point at the ${expectedHostname} benchmark compose service`);
  }
  return _value;
}

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
  if (body.includes("data-dashboard-error")) {
    throw new Error("dashboard benchmark received a streamed dashboard error");
  }
  if (!body.includes(expectedMarker)) {
    throw new Error(`dashboard benchmark response missing expected page marker: ${expectedMarker}`);
  }
  return body;
}

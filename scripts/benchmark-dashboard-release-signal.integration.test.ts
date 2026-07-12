import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { assertReferenceContainerLimits, effectiveNanoCpus } from "./benchmark-dashboard-http-lib";

const execFileAsync = promisify(execFile);
const COMPOSE_FILE = "docker-compose.benchmark.yml";

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, { maxBuffer: 20 * 1024 * 1024 });
  return stdout;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: () => string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message())), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function waitForLimitedStack(project: string, diagnostics: () => string): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const ids = (await docker([
      "compose", "-p", project, "-f", COMPOSE_FILE, "--profile", "benchmark", "ps", "-q",
    ]).catch(() => "")).trim().split(/\s+/).filter(Boolean);
    if (ids.length === 3) {
      const inspected = JSON.parse(await docker(["inspect", ...ids])) as Array<{
        Config?: { Labels?: Record<string, string> };
        HostConfig?: { NanoCpus?: number; CpuQuota?: number; CpuPeriod?: number; Memory?: number };
      }>;
      assertReferenceContainerLimits(inspected.map((container) => ({
        service: container.Config?.Labels?.["com.docker.compose.service"] as "app" | "postgres" | "clickhouse",
        nanoCpus: effectiveNanoCpus(container.HostConfig ?? {}),
        memoryBytes: container.HostConfig?.Memory ?? 0,
      })));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`benchmark stack did not reach three limited containers\n${diagnostics()}`);
}

test("SIGTERM removes the real resource-limited Compose project before exit 143", {
  skip: process.env.RUN_DOCKER_SIGNAL_INTEGRATION !== "1",
  timeout: 180_000,
}, async () => {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/benchmark-dashboard-release.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: "test" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.ok(child.pid);
  const project = `toard-benchmark-http-${child.pid}`;
  let output = "";
  let exited = false;
  child.stdout.on("data", (chunk: Buffer) => { output = `${output}${chunk.toString()}`.slice(-40_000); });
  child.stderr.on("data", (chunk: Buffer) => { output = `${output}${chunk.toString()}`.slice(-40_000); });
  const exitResult = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
  });

  try {
    await waitForLimitedStack(project, () => output);
    assert.equal(child.kill("SIGTERM"), true);
    const result = await withTimeout(
      exitResult,
      60_000,
      () => `benchmark wrapper did not exit after SIGTERM\n${output}`,
    );
    assert.deepEqual(result, { code: 143, signal: null }, output);

    const [containers, networks] = await Promise.all([
      docker(["ps", "-a", "-q", "--filter", `label=com.docker.compose.project=${project}`]),
      docker(["network", "ls", "-q", "--filter", `label=com.docker.compose.project=${project}`]),
    ]);
    assert.equal(containers.trim(), "", `containers remain for ${project}\n${output}`);
    assert.equal(networks.trim(), "", `networks remain for ${project}\n${output}`);
  } finally {
    if (!exited) child.kill("SIGKILL");
    await docker([
      "compose", "-p", project, "-f", COMPOSE_FILE, "--profile", "benchmark", "down", "--remove-orphans",
    ]).catch(() => undefined);
  }
});

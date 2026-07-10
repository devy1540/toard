import { spawn } from "node:child_process";
import {
  assertNonProductionBenchmarkEnvironment,
  assertReferenceContainerLimits,
  effectiveNanoCpus,
  type ContainerResourceLimit,
} from "./benchmark-dashboard-http-lib";

const COMPOSE_FILE = "docker-compose.benchmark.yml";
const PROJECT = `toard-benchmark-http-${process.pid}`;
const SERVICES = ["app", "postgres", "clickhouse"] as const;

async function runCapture(command: string, args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} ${args.join(" ")} failed (${code ?? "signal"})\n${stderr.slice(-20_000)}`));
    });
  });
}

async function runStreaming(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed (${code ?? "signal"})`));
    });
  });
}

function composeArgs(...args: string[]): string[] {
  return ["compose", "-p", PROJECT, "-f", COMPOSE_FILE, "--profile", "benchmark", ...args];
}

async function inspectLimits(): Promise<ContainerResourceLimit[]> {
  const limits: ContainerResourceLimit[] = [];
  for (const service of SERVICES) {
    const id = (await runCapture("docker", composeArgs("ps", "-q", service))).trim();
    if (!id) throw new Error(`benchmark ${service} container is not running`);
    const inspected = JSON.parse(await runCapture("docker", ["inspect", id])) as Array<{
      HostConfig?: { NanoCpus?: number; CpuQuota?: number; CpuPeriod?: number; Memory?: number };
    }>;
    const host = inspected[0]?.HostConfig;
    if (!host) throw new Error(`benchmark ${service} Docker HostConfig is missing`);
    limits.push({
      service,
      nanoCpus: effectiveNanoCpus(host),
      memoryBytes: host.Memory ?? 0,
    });
  }
  assertReferenceContainerLimits(limits);
  return limits;
}

async function main(): Promise<void> {
  assertNonProductionBenchmarkEnvironment(process.env);
  console.log("[dashboard-release] starting isolated 4 vCPU / 8 GiB Compose stack");
  try {
    await runStreaming("docker", composeArgs("up", "-d", "--build", "--wait"));
    const limits = await inspectLimits();
    console.log(`[dashboard-release] Docker limits verified ${JSON.stringify(limits)}`);
    await runStreaming("docker", composeArgs(
      "exec",
      "-T",
      "-e",
      "BENCHMARK_LIMITS_VERIFIED=docker-inspect",
      "app",
      "pnpm",
      "benchmark:dashboard-http:inner",
    ));
  } finally {
    await runStreaming("docker", composeArgs("down", "--remove-orphans")).catch((error) => {
      console.error(`[dashboard-release] isolated stack cleanup failed: ${String(error)}`);
    });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

import type { SpawnOptions } from "node:child_process";
import type { EventEmitter } from "node:events";
import {
  assertReferenceContainerLimits,
  effectiveNanoCpus,
  type ContainerResourceLimit,
} from "./benchmark-dashboard-http-lib";

const COMPOSE_FILE = "docker-compose.benchmark.yml";
const SERVICES = ["app", "postgres", "clickhouse"] as const;
type HandledSignal = "SIGINT" | "SIGTERM";

export type SpawnedChild = EventEmitter & {
  stdout?: EventEmitter | null;
  stderr?: EventEmitter | null;
  kill(signal: NodeJS.Signals): boolean;
};

export type ReleaseBenchmarkDependencies = {
  spawn(command: string, args: string[], options: SpawnOptions): SpawnedChild;
  exit(code: number): void;
  onSignal(signal: HandledSignal, listener: () => void): void;
  offSignal(signal: HandledSignal, listener: () => void): void;
  log(message: string): void;
  reportError(error: unknown): void;
};

function composeArgs(project: string, ...args: string[]): string[] {
  return ["compose", "-p", project, "-f", COMPOSE_FILE, "--profile", "benchmark", ...args];
}

function commandError(command: string, args: readonly string[], code: number | null, signal: NodeJS.Signals | null, stderr: string): Error {
  const outcome = code == null ? `signal ${signal ?? "unknown"}` : String(code);
  const detail = stderr.trim() ? `\n${stderr.slice(-20_000)}` : "";
  return new Error(`${command} ${args.join(" ")} failed (${outcome})${detail}`);
}

export async function runReleaseBenchmark(
  dependencies: ReleaseBenchmarkDependencies,
  project: string,
): Promise<void> {
  let current: { child: SpawnedChild; cleanup: boolean } | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let signalTask: Promise<void> | undefined;
  let acceptingSignals = true;

  async function runChild(command: string, args: string[], capture: boolean, cleanup = false): Promise<string> {
    const child = dependencies.spawn(command, args, {
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    const active = { child, cleanup };
    current = active;
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer | string) => { stderr += chunk.toString(); });
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const settle = (callback: () => void) => {
          if (settled) return;
          settled = true;
          callback();
        };
        child.once("error", (error: Error) => settle(() => reject(error)));
        child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => settle(() => {
          if (code === 0) resolve();
          else reject(commandError(command, args, code, signal, stderr));
        }));
      });
      return stdout;
    } finally {
      if (current === active) current = undefined;
    }
  }

  const runStreaming = (command: string, args: string[], cleanup = false) =>
    runChild(command, args, false, cleanup).then(() => undefined);
  const runCapture = (command: string, args: string[]) => runChild(command, args, true);

  async function inspectLimits(): Promise<ContainerResourceLimit[]> {
    const limits: ContainerResourceLimit[] = [];
    for (const service of SERVICES) {
      const id = (await runCapture("docker", composeArgs(project, "ps", "-q", service))).trim();
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

  function cleanup(): Promise<void> {
    cleanupPromise ??= runStreaming(
      "docker",
      composeArgs(project, "down", "--remove-orphans"),
      true,
    );
    return cleanupPromise;
  }

  function startSignal(signal: HandledSignal): void {
    if (!acceptingSignals || signalTask) return;
    signalTask = (async () => {
      const signalErrors: unknown[] = [];
      const active = current;
      if (active && !active.cleanup) {
        try {
          active.child.kill(signal);
        } catch (error) {
          signalErrors.push(error);
        }
      }
      try {
        await cleanup();
      } catch (error) {
        signalErrors.push(error);
      }
      if (signalErrors.length === 1) dependencies.reportError(signalErrors[0]);
      if (signalErrors.length > 1) {
        dependencies.reportError(new AggregateError(signalErrors, `${signal} forwarding and cleanup failed`));
      }
      dependencies.exit(signal === "SIGINT" ? 130 : 143);
    })();
  }

  const onSigint = () => startSignal("SIGINT");
  const onSigterm = () => startSignal("SIGTERM");
  dependencies.onSignal("SIGINT", onSigint);
  dependencies.onSignal("SIGTERM", onSigterm);

  try {
    let primaryError: unknown;
    let cleanupError: unknown;
    try {
      dependencies.log(`[dashboard-release] starting isolated 4 vCPU / 8 GiB Compose stack project=${project}`);
      await runStreaming("docker", composeArgs(project, "up", "-d", "--build", "--wait"));
      const limits = await inspectLimits();
      dependencies.log(`[dashboard-release] Docker limits verified ${JSON.stringify(limits)}`);
      await runStreaming("docker", composeArgs(
        project,
        "exec",
        "-T",
        "-e",
        "BENCHMARK_LIMITS_VERIFIED=docker-inspect",
        "app",
        "pnpm",
        "benchmark:dashboard-http:inner",
      ));
    } catch (error) {
      primaryError = error;
    }

    try {
      await cleanup();
    } catch (error) {
      cleanupError = error;
    }
    acceptingSignals = false;

    if (signalTask) {
      await signalTask;
      return;
    }
    if (primaryError && cleanupError) {
      throw new AggregateError(
        [primaryError, cleanupError],
        "release benchmark and isolated stack cleanup both failed",
      );
    }
    if (primaryError) throw primaryError;
    if (cleanupError) throw cleanupError;
  } finally {
    acceptingSignals = false;
    dependencies.offSignal("SIGINT", onSigint);
    dependencies.offSignal("SIGTERM", onSigterm);
  }
}

export async function releaseBenchmarkMain(
  dependencies: ReleaseBenchmarkDependencies,
  project: string,
): Promise<void> {
  try {
    await runReleaseBenchmark(dependencies, project);
  } catch (error) {
    dependencies.reportError(error);
    dependencies.exit(1);
  }
}

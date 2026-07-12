import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { releaseBenchmarkMain, type ReleaseBenchmarkDependencies } from "./benchmark-dashboard-release-lib";

type PlannedChild = {
  match: string;
  code?: number;
  stdout?: string;
  stderr?: string;
  hold?: boolean;
};

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly killSignals: NodeJS.Signals[] = [];
  private ended = false;

  constructor(readonly commandLine: string, private readonly plan: PlannedChild) {
    super();
    if (!plan.hold) queueMicrotask(() => this.finish(plan.code ?? 0));
  }

  kill(signal: NodeJS.Signals): boolean {
    this.killSignals.push(signal);
    this.finish(null, signal);
    return true;
  }

  finish(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.ended) return;
    this.ended = true;
    if (this.plan.stdout) this.stdout.emit("data", Buffer.from(this.plan.stdout));
    if (this.plan.stderr) this.stderr.emit("data", Buffer.from(this.plan.stderr));
    this.emit("exit", code, signal);
  }
}

function inspectResult(nanoCpus: number, memoryBytes: number): string {
  return JSON.stringify([{ HostConfig: { NanoCpus: nanoCpus, Memory: memoryBytes } }]);
}

function benchmarkPlans(options: {
  innerCode?: number;
  innerHold?: boolean;
  downCode?: number;
  downHold?: boolean;
} = {}): PlannedChild[] {
  return [
    { match: "up -d --build --wait" },
    { match: "ps -q app", stdout: "app-id\n" },
    { match: "inspect app-id", stdout: inspectResult(1_500_000_000, 2 * 1024 ** 3) },
    { match: "ps -q postgres", stdout: "postgres-id\n" },
    { match: "inspect postgres-id", stdout: inspectResult(1_000_000_000, 2 * 1024 ** 3) },
    { match: "ps -q clickhouse", stdout: "clickhouse-id\n" },
    { match: "inspect clickhouse-id", stdout: inspectResult(1_500_000_000, 4 * 1024 ** 3) },
    { match: "exec -T -e BENCHMARK_LIMITS_VERIFIED=docker-inspect app", code: options.innerCode, hold: options.innerHold },
    { match: "down --remove-orphans", code: options.downCode, hold: options.downHold },
  ];
}

function createHarness(plans: PlannedChild[]) {
  const remaining = [...plans];
  const children: FakeChild[] = [];
  const exits: number[] = [];
  const errors: unknown[] = [];
  const listeners = new Map<NodeJS.Signals, Set<() => void>>();
  const spawnWaiters: Array<{ match: string; resolve: (child: FakeChild) => void }> = [];

  const dependencies: ReleaseBenchmarkDependencies = {
    spawn(command, args) {
      const plan = remaining.shift();
      assert.ok(plan, `unexpected child: ${command} ${args.join(" ")}`);
      const commandLine = `${command} ${args.join(" ")}`;
      assert.match(commandLine, new RegExp(plan.match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      const child = new FakeChild(commandLine, plan);
      children.push(child);
      for (const waiter of [...spawnWaiters]) {
        if (commandLine.includes(waiter.match)) waiter.resolve(child);
      }
      return child;
    },
    exit(code) {
      exits.push(code);
    },
    onSignal(signal, listener) {
      const signalListeners = listeners.get(signal) ?? new Set();
      signalListeners.add(listener);
      listeners.set(signal, signalListeners);
    },
    offSignal(signal, listener) {
      listeners.get(signal)?.delete(listener);
    },
    log() {},
    reportError(error) {
      errors.push(error);
    },
  };

  return {
    dependencies,
    children,
    exits,
    errors,
    emitSignal(signal: NodeJS.Signals) {
      for (const listener of listeners.get(signal) ?? []) listener();
    },
    waitForSpawn(match: string): Promise<FakeChild> {
      const existing = children.find((child) => child.commandLine.includes(match));
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => spawnWaiters.push({ match, resolve }));
    },
    assertConsumed() {
      assert.equal(remaining.length, 0, `unconsumed plans: ${remaining.map(({ match }) => match).join(", ")}`);
    },
  };
}

test("successful inner benchmark plus failed cleanup exits non-zero", async () => {
  const harness = createHarness(benchmarkPlans({ downCode: 7 }));

  await releaseBenchmarkMain(harness.dependencies, "test-project");

  assert.deepEqual(harness.exits, [1]);
  assert.equal(harness.errors.length, 1);
  assert.match(String(harness.errors[0]), /down --remove-orphans failed \(7\)/);
  harness.assertConsumed();
});

test("primary benchmark and cleanup failures are preserved in AggregateError", async () => {
  const harness = createHarness(benchmarkPlans({ innerCode: 9, downCode: 7 }));

  await releaseBenchmarkMain(harness.dependencies, "test-project");

  assert.deepEqual(harness.exits, [1]);
  const aggregate = harness.errors[0];
  assert.ok(aggregate instanceof AggregateError);
  assert.equal(aggregate.errors.length, 2);
  assert.match(String(aggregate.errors[0]), /benchmark:dashboard-http:inner failed \(9\)/);
  assert.match(String(aggregate.errors[1]), /down --remove-orphans failed \(7\)/);
  harness.assertConsumed();
});

test("SIGTERM is forwarded to the active child and exits 143 after cleanup", async () => {
  const harness = createHarness(benchmarkPlans({ innerHold: true }));
  const completion = releaseBenchmarkMain(harness.dependencies, "test-project");
  const inner = await Promise.race([
    harness.waitForSpawn("benchmark:dashboard-http:inner"),
    completion.then(() => { throw new Error("active benchmark child was not started"); }),
  ]);

  harness.emitSignal("SIGTERM");
  await completion;

  assert.deepEqual(inner.killSignals, ["SIGTERM"]);
  assert.deepEqual(harness.exits, [143]);
  assert.equal(harness.children.filter(({ commandLine }) => commandLine.includes("down --remove-orphans")).length, 1);
  assert.deepEqual(harness.errors, []);
  harness.assertConsumed();
});

test("duplicate SIGINT during cleanup forwards and runs down only once", async () => {
  const harness = createHarness(benchmarkPlans({ innerHold: true, downHold: true }));
  const completion = releaseBenchmarkMain(harness.dependencies, "test-project");
  const inner = await Promise.race([
    harness.waitForSpawn("benchmark:dashboard-http:inner"),
    completion.then(() => { throw new Error("active benchmark child was not started"); }),
  ]);

  harness.emitSignal("SIGINT");
  harness.emitSignal("SIGINT");
  const down = await harness.waitForSpawn("down --remove-orphans");
  down.finish(0);
  await completion;

  assert.deepEqual(inner.killSignals, ["SIGINT"]);
  assert.equal(harness.children.filter(({ commandLine }) => commandLine.includes("down --remove-orphans")).length, 1);
  assert.deepEqual(harness.exits, [130]);
  harness.assertConsumed();
});

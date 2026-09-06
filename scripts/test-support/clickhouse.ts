import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function startTestClickHouse() {
  const container = `toard-test-pricing-ch-${randomUUID().slice(0, 8)}`;
  const password = randomUUID();
  let started = false;
  const close = async () => {
    if (started) {
      await exec("docker", ["stop", "--time", "5", container]);
      started = false;
    }
  };
  try {
    await exec("docker", [
      "run", "-d", "--rm", "--name", container, "--cpus", "2", "--memory", "2g",
      "--tmpfs", "/var/lib/clickhouse", "--tmpfs", "/var/log/clickhouse-server",
      "-v", `${resolve("clickhouse/init")}:/docker-entrypoint-initdb.d:ro`,
      "-e", "CLICKHOUSE_USER=fixture", "-e", "CLICKHOUSE_PASSWORD",
      "-e", "CLICKHOUSE_DB=toard", "-e", "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1",
      "-p", "127.0.0.1::8123", "clickhouse/clickhouse-server:24-alpine",
    ], { env: { ...process.env, CLICKHOUSE_PASSWORD: password } });
    started = true;
    const { stdout } = await exec("docker", ["port", container, "8123/tcp"]);
    const port = stdout.trim().match(/:(\d+)$/)?.[1];
    if (!port) throw new Error("TEST_CLICKHOUSE_PORT_MISSING");
    const url = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        const response = await fetch(`${url}/?database=toard`, {
          method: "POST", body: "SELECT count() FROM usage_events",
          headers: { Authorization: `Basic ${Buffer.from(`fixture:${password}`).toString("base64")}` },
          signal: AbortSignal.timeout(1000),
        });
        await response.text();
        if (response.ok) return { url, username: "fixture", password, close };
      } catch { /* initialization can temporarily close the HTTP port */ }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("TEST_CLICKHOUSE_NOT_READY");
  } catch (error) {
    await close();
    throw error;
  }
}

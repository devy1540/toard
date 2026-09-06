import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

test("installer fixture acknowledges whole batches and deduplicates without persisting secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "toard-server-fixture-"));
  const portFile = join(root, "port"), capture = join(root, "capture");
  const child = spawn(process.execPath, [new URL("./shim-e2e-server.mjs", import.meta.url).pathname, root, portFile, capture], { stdio: "ignore" });
  try {
    let port;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { port = (await readFile(portFile, "utf8")).trim(); break; } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    assert.match(port ?? "", /^\d+$/);
    const send = () => fetch(`http://127.0.0.1:${port}/company/api/v1/events`, {
      method: "POST", headers: { Authorization: "Bearer fixture-private-token" },
      body: JSON.stringify([{ dedupKey: "fixture-key-alpha", privateField: "private-event-text" }, { dedupKey: "fixture-key-beta" }]),
    }).then(response => response.json());
    assert.deepEqual(await send(), { inserted: 2, deduped: 0, reconciled: 1 });
    assert.deepEqual(await send(), { inserted: 0, deduped: 2, reconciled: 1 });
    const stored = await readFile(capture, "utf8");
    for (const secret of ["fixture-private-token", "fixture-key-alpha", "private-event-text"]) assert.equal(stored.includes(secret), false);
    const rows = stored.trim().split("\n").map(JSON.parse);
    assert.equal(rows[0].eventKeyHashes.length, 2);
    assert.deepEqual(rows[0].eventKeyHashes, rows[1].eventKeyHashes);
  } finally {
    if (child.exitCode == null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; }
    await rm(root, { recursive: true, force: true });
  }
});

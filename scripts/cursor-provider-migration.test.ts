import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const MIGRATION = "migrations/1700000043_cursor_provider.sql";

test("migration 43은 기존 설치에 Cursor logfile provider를 멱등 등록한다", async () => {
  const sql = await readFile(MIGRATION, "utf8");
  const [up, down] = sql.split("-- Down Migration", 2);

  assert.match(up ?? "", /INSERT INTO providers/);
  assert.match(up ?? "", /'cursor', 'Cursor'/);
  assert.match(up ?? "", /'logfile'/);
  assert.match(up ?? "", /ON CONFLICT \(key\) DO UPDATE/);
  assert.match(down ?? "", /DELETE FROM providers WHERE key = 'cursor'/);
});

test("fresh seed에도 Cursor provider가 포함된다", async () => {
  const seed = await readFile("scripts/seed.ts", "utf8");
  assert.match(seed, /\('cursor', 'Cursor', ARRAY\[\]::text\[\], 'logfile', true\)/);
});

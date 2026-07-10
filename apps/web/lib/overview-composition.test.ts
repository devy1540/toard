import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { orderByTokens, tokenShare } from "./composition";

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("overview composition ranks rows and calculates shares by total tokens", () => {
  const view = source("components/dashboard/overview-view.tsx");

  assert.match(view, /const modelComposition = orderByTokens\(byModel\)/);
  assert.match(view, /const hostComposition = orderByTokens\(byHost\)/);
  assert.match(view, /share=\{tokenShare\(m\.totalTokens, modelTokenSum\)\}/);
  assert.match(view, /share=\{tokenShare\(h\.totalTokens, hostTokenSum\)\}/);
});

test("composition keeps token total on the right and cost plus sessions together below the model", () => {
  const view = source("components/dashboard/overview-view.tsx");

  assert.match(view, /tokens: string;\n  cost: string;\n  sessions: string;/);
  assert.match(view, /<span className="ml-auto shrink-0 font-medium tabular-nums">\{tokens\}<\/span>/);
  assert.match(
    view,
    /<span className="text-foreground font-medium tabular-nums">\{cost\}<\/span>\s*\{" · "\}\s*\{sessions\}/,
  );
  assert.match(view, /tokens=\{fmtCompact\(m\.totalTokens\)\}/);
  assert.match(view, /sessions=\{t\("sessionCount", \{ count: fmtNum\(m\.sessions\) \}\)\}/);
});

test("token composition places the highest-token model first even when it costs less", () => {
  const rows = [
    { model: "GPT-5.5", totalTokens: 90_400_000, costUsd: 78.2 },
    { model: "GPT-5.6-sol", totalTokens: 147_200_000, costUsd: 28.72 },
    { model: "Claude Opus 4.8", totalTokens: 41_800_000, costUsd: 48.26 },
  ];

  const ordered = orderByTokens(rows);
  const totalTokens = rows.reduce((sum, row) => sum + row.totalTokens, 0);

  assert.deepEqual(ordered.map((row) => row.model), ["GPT-5.6-sol", "GPT-5.5", "Claude Opus 4.8"]);
  assert.equal(Math.round(tokenShare(ordered[0]!.totalTokens, totalTokens) * 100), 53);
});

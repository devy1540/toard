import assert from "node:assert/strict";
import test from "node:test";
import { resolveInsightProvider, type ProviderOption } from "./providers";

const providers: ProviderOption[] = [
  { key: "claude", label: "Claude" },
  { key: "codex", label: "Codex" },
];

test("enabled provider 요청은 그대로 통과시킨다", () => {
  assert.equal(resolveInsightProvider("codex", providers), "codex");
});

test("unknown 또는 disabled provider 요청은 all로 정규화한다", () => {
  assert.equal(resolveInsightProvider("gemini", providers), undefined);
});

test("all과 미지정 provider 요청은 all로 정규화한다", () => {
  assert.equal(resolveInsightProvider("all", providers), undefined);
  assert.equal(resolveInsightProvider(undefined, providers), undefined);
});

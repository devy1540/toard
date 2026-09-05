import assert from "node:assert/strict";
import test from "node:test";
import { parseCollectionHealthReport } from "./collection-health";

const valid = { schemaVersion: 1, host: "test-laptop", collectors: [{ providerKey: "codex", state: "no_records", scannedFiles: 0, parsedEvents: 0, parseErrors: 0, pendingEvents: 0, errorCode: null }] };

test("collection health preserves observed zero separately from unknown values", () => {
  assert.equal(parseCollectionHealthReport(valid).collectors[0]!.parsedEvents, 0);
  const unknown = parseCollectionHealthReport({ ...valid, collectors: [{ providerKey: "codex", state: "unsupported" }] });
  assert.equal(unknown.collectors[0]!.parsedEvents, null);
});

test("private or raw fields, paths and inconsistent success claims are rejected", () => {
  assert.throws(() => parseCollectionHealthReport({ ...valid, rawLogs: "private" }), /unsupported collection health field/);
  assert.throws(() => parseCollectionHealthReport({ ...valid, host: "/Users/private/project" }), /invalid collection host/);
  assert.throws(() => parseCollectionHealthReport({ ...valid, collectors: [{ ...valid.collectors[0], state: "ok", parseErrors: 1 }] }), /inconsistent/);
  assert.throws(() => parseCollectionHealthReport({ ...valid, collectors: [{ ...valid.collectors[0], errorCode: "private path or error body" }] }), /invalid collection error/);
  assert.throws(() => parseCollectionHealthReport({ ...valid, collectors: [{ ...valid.collectors[0], pendingEvents: -1 }] }), /invalid collection health count/);
  assert.throws(() => parseCollectionHealthReport({ ...valid, collectors: [valid.collectors[0], valid.collectors[0]] }), /repeated/);
});

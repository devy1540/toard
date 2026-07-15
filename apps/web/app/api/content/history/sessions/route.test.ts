import assert from "node:assert/strict";
import test from "node:test";
import type { SessionUsageSummary } from "@toard/core";
import type { E2eeHistoryPage } from "@/lib/e2ee-history";
import { loadE2eeHistoryPage } from "@/lib/e2ee-history-page";

const encryptedPage: E2eeHistoryPage = {
  totalSessions: 21,
  sessions: [
    {
      key: "session-1",
      isSession: true,
      providerKey: "codex",
      turnCount: 2,
      firstTs: "2026-07-14T00:00:00.000Z",
      latestTs: "2026-07-14T00:01:00.000Z",
      previewRecord: null,
      usage: null,
    },
    {
      key: "solo-1",
      isSession: false,
      providerKey: "codex",
      turnCount: 1,
      firstTs: "2026-07-14T00:02:00.000Z",
      latestTs: "2026-07-14T00:02:00.000Z",
      previewRecord: null,
      usage: null,
    },
  ],
};

const usage: SessionUsageSummary = {
  sessionId: "session-1",
  models: ["gpt-5.6-sol"],
  hosts: ["hjyoon-macbookpro.local"],
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 20,
  cacheCreationTokens: 0,
  costUsd: 0.25,
  eventCount: 1,
  costCoverage: { pricedEvents: 1, unpricedEvents: 0, legacyEvents: 0 },
};

test("E2EE history route applies filters and joins usage only for real sessions", async () => {
  let sessionOptions: unknown;
  let requestedSessionIds: string[] = [];

  const result = await loadE2eeHistoryPage({
    userId: "user-1",
    searchParams: new URLSearchParams("period=month&provider=codex&page=2"),
    timezone: "Asia/Seoul",
    loadSessions: async (_userId, options) => {
      sessionOptions = options;
      return encryptedPage;
    },
    loadUsage: async (_userId, sessionIds) => {
      requestedSessionIds = sessionIds;
      return [usage];
    },
  });

  assert.deepEqual(requestedSessionIds, ["session-1"]);
  assert.equal(result.sessions[0]?.usage?.models[0], "gpt-5.6-sol");
  assert.equal(result.sessions[1]?.usage, null);
  assert.equal((sessionOptions as { limit: number }).limit, 20);
  assert.equal((sessionOptions as { offset: number }).offset, 20);
  assert.equal((sessionOptions as { filter: { providerKey?: string } }).filter.providerKey, "codex");
});

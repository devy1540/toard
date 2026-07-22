import assert from "node:assert/strict";
import test from "node:test";
import { NextIntlClientProvider } from "next-intl";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ko from "../../../messages/ko/admin.json" with { type: "json" };
import type { ServerUpdateStatus } from "../../../lib/server-update";
import { ServerUpdatePanel } from "./server-update-panel";

const unavailableStatus: ServerUpdateStatus = {
  available: false,
  configured: false,
  running: false,
  phase: "unavailable",
  message: "updater unavailable",
  currentVersion: null,
  latestVersion: null,
  targetVersion: null,
  startedAt: null,
  finishedAt: null,
  error: null,
  logs: [],
};

function render(status: ServerUpdateStatus, currentVersion = "0.15.45"): string {
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale: "ko",
      messages: { admin: ko },
      timeZone: "UTC",
      children: createElement(ServerUpdatePanel, { currentVersion, initialStatus: status }),
    }),
  );
}

test("업데이트 에이전트가 없는 Kubernetes 배포도 현재 서버 버전을 표시한다", () => {
  const html = render(unavailableStatus);

  assert.match(html, /현재/);
  assert.match(html, /v0\.15\.45/);
  assert.match(html, /서버 업데이트 에이전트가 설정되지 않았습니다/);
});

test("업데이트 상태가 제공한 현재 버전을 우선 표시한다", () => {
  const html = render({ ...unavailableStatus, currentVersion: "0.15.46" });

  assert.match(html, /v0\.15\.46/);
  assert.doesNotMatch(html, /v0\.15\.45/);
});

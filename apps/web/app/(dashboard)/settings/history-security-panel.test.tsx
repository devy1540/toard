import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import en from "../../../messages/en/settings.json";
import ko from "../../../messages/ko/settings.json";
import type { UserHistorySecurityStatus } from "../../../lib/user-history-security";
import { HistorySecurityPanelView } from "./history-security-panel";

const PROTECTED: UserHistorySecurityStatus = {
  managed: {
    configured: true,
    state: "protected",
    activeKeyVersion: 3,
    managedRecords: 12,
  },
  legacy: null,
};

function render(
  locale: "ko" | "en",
  status: UserHistorySecurityStatus | null,
): string {
  const messages = locale === "ko" ? ko.historySecurity : en.historySecurity;
  return renderToStaticMarkup(
    <HistorySecurityPanelView
      status={status}
      translate={(key, values) => {
        let message = messages[key];
        for (const [name, value] of Object.entries(values ?? {})) {
          message = message.replace(`{${name}}`, String(value));
        }
        return message;
      }}
      formatDate={(date) => date.toISOString()}
    />,
  );
}

test("관리형 암호화 사용자는 E2EE 기기 대신 보호 방식과 키 버전을 본다", () => {
  for (const locale of ["ko", "en"] as const) {
    const html = render(locale, PROTECTED);
    assert.match(html, locale === "ko" ? /서버 관리형 암호화/ : /Server-managed encryption/i);
    assert.match(html, /v3/);
    assert.doesNotMatch(html, /E2EE|Recovery Kit|승인된 기기|Approved devices/i);
    assert.doesNotMatch(html, /provider|fingerprint|key ref|credential|wrapped/i);
  }
});

test("차단된 레거시 E2EE가 있을 때만 Recovery Kit와 승인 기기를 표시한다", () => {
  const html = render("ko", {
    ...PROTECTED,
    legacy: {
      state: "blocked",
      e2eeRecords: 2,
      serverRecords: 1,
      recoveryConfirmedAt: new Date("2026-07-14T00:00:00.000Z"),
      devices: [{
        id: "018f47d0-4d47-7b04-950b-7d18a86e1b44",
        kind: "shim",
        label: "MacBook",
        platform: "macos",
        lastUsedAt: null,
      }],
    },
  });

  assert.match(html, /이전 E2EE 데이터/);
  assert.match(html, /전환이 중단/);
  assert.match(html, /Recovery Kit/);
  assert.match(html, /승인된 기기/);
  assert.match(html, /MacBook/);
});

test("상태 조회 실패는 보호됨이나 꺼짐으로 가장하지 않는다", () => {
  const html = render("ko", null);
  assert.match(html, /확인할 수 없습니다/);
  assert.doesNotMatch(html, /보호됨|꺼짐|v\d/);
});

test("히스토리 보안 번역은 양 언어에 대칭이며 온보딩 설명은 서버 관리형이다", () => {
  assert.deepEqual(
    Object.keys(ko.historySecurity).sort(),
    Object.keys(en.historySecurity).sort(),
  );
  assert.match(ko.wizard.contentWithPrompts, /서버가 저장 전에 암호화/);
  assert.match(en.wizard.contentWithPrompts, /server encrypts.*before storage/i);
  assert.doesNotMatch(ko.wizard.contentWithPrompts, /서버 키로 복호화할 수 없습니다/);
  assert.doesNotMatch(en.wizard.contentWithPrompts, /cannot decrypt/i);
});

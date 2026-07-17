import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { NextIntlClientProvider } from "next-intl";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ko from "../../../messages/ko/admin.json" with { type: "json" };
import en from "../../../messages/en/admin.json" with { type: "json" };
import type { EncryptionAdminStatus } from "../../../lib/encryption-admin-status";
import { EncryptionPanel } from "./encryption-panel";

const STATUS: EncryptionAdminStatus = {
  enabled: true,
  provider: "aws-kms",
  keyRef: "arn:aws:kms:ap-northeast-2:123456789012:key/00000000-0000-0000-0000-000000000001",
  fingerprint: "aws-kms:0123456789abcdef01234567",
  credentialSource: { kind: "aws-default-provider-chain", staticCredential: false },
  health: { status: "healthy", latencyMs: 12, checkedAt: new Date("2026-07-17T00:00:00.000Z") },
  records: { serverV1: 4, e2eeV1: 5, managedV1: 6 },
  userKeys: { active: 7, pending: 8, retiring: 9 },
  migrations: { e2eePending: 10, e2eeBlocked: 11 },
  operations30d: [{ operation: "wrap", outcome: "success", count: 20000, averageLatencyMs: 3.2 }],
  cache30d: { hit: 75, miss: 20, singleFlight: 5 },
  costEstimate: {
    currency: "USD",
    requestCost: 0.06,
    monthlyKeyCost: 1,
    total: 1.06,
    source: "reference",
    asOf: "2026-07-17",
    grossReference: true,
  },
};

function render(locale: "ko" | "en", status: EncryptionAdminStatus | null = STATUS): string {
  const messages = locale === "ko" ? ko : en;
  return renderToStaticMarkup(
    createElement(
      NextIntlClientProvider,
      {
        locale,
        messages: { admin: messages },
        timeZone: "UTC",
        children: createElement(EncryptionPanel, { status }),
      },
    ),
  );
}

test("관리형 암호화 패널은 ko/en에서 상태와 gross reference 기준일을 표시한다", () => {
  const koHtml = render("ko");
  const enHtml = render("en");

  assert.match(koHtml, /AWS KMS|aws-kms/);
  assert.match(koHtml, /2026-07-17/);
  assert.match(koHtml, /무료 구간|세금/);
  assert.match(enHtml, /2026-07-17/);
  assert.match(enHtml, /free tier|tax/i);
  assert.match(koHtml, /75\.0%/);
});

test("패널은 read-only이며 secret control과 비밀값을 렌더하지 않는다", () => {
  const source = readFileSync(new URL("./encryption-panel.tsx", import.meta.url), "utf8");
  const html = render("ko");

  assert.doesNotMatch(source, /<input|type=["']password|<select|<button|\bButton\b/);
  assert.doesNotMatch(html, /<input|<select|<button|password|client_secret|token=/i);
});

test("상태 조회 실패는 unavailable로 표시하고 0이나 healthy로 가장하지 않는다", () => {
  const html = render("ko", null);
  assert.match(html, /확인할 수 없습니다/);
  assert.doesNotMatch(html, /정상|\$0\.00|0건/);
});

test("모든 패널 번역 키가 ko/en에 대칭으로 존재한다", () => {
  const koKeys = Object.keys(ko.encryption).sort();
  const enKeys = Object.keys(en.encryption).sort();
  assert.deepEqual(koKeys, enKeys);
  for (const value of [...Object.values(ko.encryption), ...Object.values(en.encryption)]) {
    if (typeof value === "string") assert.ok(value.length > 0);
  }
});

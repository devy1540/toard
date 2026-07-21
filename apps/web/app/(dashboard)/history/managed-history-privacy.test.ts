import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const pageSource = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const detailSource = readFileSync(new URL("./session-detail.tsx", import.meta.url), "utf8");
const linkUrl = new URL("./history-security-link.tsx", import.meta.url);
const linkSource = existsSync(linkUrl) ? readFileSync(linkUrl, "utf8") : "";
const settingsPanelSource = readFileSync(
  new URL("../settings/history-security-panel.tsx", import.meta.url),
  "utf8",
);
const ko = JSON.parse(
  readFileSync(new URL("../../../messages/ko/dashboard.json", import.meta.url), "utf8"),
) as { history: Record<string, string> };
const en = JSON.parse(
  readFileSync(new URL("../../../messages/en/dashboard.json", import.meta.url), "utf8"),
) as { history: Record<string, string> };
const koSettings = JSON.parse(
  readFileSync(new URL("../../../messages/ko/settings.json", import.meta.url), "utf8"),
) as { historySecurity: Record<string, string> };
const enSettings = JSON.parse(
  readFileSync(new URL("../../../messages/en/settings.json", import.meta.url), "utf8"),
) as { historySecurity: Record<string, string> };

test("history screens link to detailed security settings instead of repeating privacy copy", () => {
  assert.equal(ko.history.securityInfo, "보안 안내");
  assert.equal(en.history.securityInfo, "Security info");
  assert.match(linkSource, /\/settings\?tab=account#history-security/);
  assert.match(settingsPanelSource, /id=["']history-security["']/);
  assert.match(pageSource, /<HistorySecurityLink/);
  assert.doesNotMatch(pageSource, /history\.(privacyNote|managedPrivacyNote|legacyPrivacyNote)/);
  assert.doesNotMatch(detailSource, /history\.(privacyNote|managedPrivacyNote|legacyPrivacyNote)/);
  assert.equal("privacyNote" in ko.history, false);
  assert.equal("managedPrivacyNote" in ko.history, false);
  assert.equal("legacyPrivacyNote" in ko.history, false);

  assert.match(koSettings.historySecurity.privacyBoundary ?? "", /DB와 백업|KMS 권한/);
  assert.match(enSettings.historySecurity.privacyBoundary ?? "", /database and backups|KMS permissions/i);
});

test("Korean and English history messages keep the same keys", () => {
  assert.deepEqual(Object.keys(en.history).sort(), Object.keys(ko.history).sort());
});

test("session detail distinguishes disabled decryption from a missing conversation", () => {
  assert.match(detailSource, /enabled[\s\S]*history\.disabledTitle/);
  assert.ok(
    detailSource.indexOf("if (!enabled)") < detailSource.indexOf("if (!session)"),
    "disabled capability must be handled before not-found",
  );
});

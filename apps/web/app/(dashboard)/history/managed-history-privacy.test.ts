import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pageSource = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const detailSource = readFileSync(new URL("./session-detail.tsx", import.meta.url), "utf8");
const ko = JSON.parse(
  readFileSync(new URL("../../../messages/ko/dashboard.json", import.meta.url), "utf8"),
) as { history: Record<string, string> };
const en = JSON.parse(
  readFileSync(new URL("../../../messages/en/dashboard.json", import.meta.url), "utf8"),
) as { history: Record<string, string> };

test("managed history wording states the actual application and infrastructure boundary", () => {
  assert.equal(
    ko.history.privacyNote,
    "나만 볼 수 있습니다 — 앱의 관리자 화면과 다른 사용자는 조회할 수 없습니다.",
  );
  assert.equal(
    ko.history.managedPrivacyNote,
    "DB와 백업에는 암호문으로 저장됩니다. 앱 서버와 KMS 권한을 함께 가진 인프라 운영자는 복호화할 수 있습니다.",
  );
  assert.equal(
    ko.history.contentUnavailable,
    "본문을 열 수 없습니다. 키 관리 공급자 상태를 확인하세요.",
  );
  assert.match(en.history.privacyNote ?? "", /administrator screens|other users/i);
  assert.match(en.history.managedPrivacyNote ?? "", /database|backups/i);
  assert.match(en.history.managedPrivacyNote ?? "", /application server|KMS permissions/i);
  assert.match(en.history.contentUnavailable ?? "", /key management provider/i);
});

test("Korean and English history messages keep the same keys", () => {
  assert.deepEqual(Object.keys(en.history).sort(), Object.keys(ko.history).sort());
});

test("server-decrypted history renders managed boundary and legacy note only conditionally", () => {
  assert.match(pageSource, /history\.privacyNote/);
  assert.match(pageSource, /history\.managedPrivacyNote/);
  assert.match(pageSource, /hasLegacyContent[\s\S]*history\.legacyPrivacyNote/);
  assert.match(detailSource, /getMyHistorySession/);
  assert.match(detailSource, /hasManagedContent[\s\S]*history\.managedPrivacyNote/);
  assert.match(detailSource, /hasLegacyContent[\s\S]*history\.legacyPrivacyNote/);
  assert.doesNotMatch(pageSource, /관리자도 절대|administrators can never/i);
});

test("session detail distinguishes disabled decryption from a missing conversation", () => {
  assert.match(detailSource, /enabled[\s\S]*history\.disabledTitle/);
  assert.ok(
    detailSource.indexOf("if (!enabled)") < detailSource.indexOf("if (!session)"),
    "disabled capability must be handled before not-found",
  );
});

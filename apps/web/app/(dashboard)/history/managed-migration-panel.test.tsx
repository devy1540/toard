import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { NextIntlClientProvider } from "next-intl";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import en from "../../../messages/en/dashboard.json";
import ko from "../../../messages/ko/dashboard.json";
import {
  managedMigrationStateBody,
  ManagedMigrationPanel,
} from "./managed-migration-panel";

function render(locale: "ko" | "en", state: "pending" | "running" | "blocked") {
  const dashboard = locale === "ko" ? ko : en;
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={{ dashboard }} timeZone="UTC">
      <ManagedMigrationPanel
        state={state}
        migrated={7}
        remaining={3}
        busy={false}
        error={null}
        onResume={() => undefined}
        onBlock={() => undefined}
      />
    </NextIntlClientProvider>,
  );
}

test("migration panel shows progress without rendering partial history", () => {
  const html = render("ko", "running");
  assert.match(html, /히스토리 보안 전환 중/);
  assert.match(html, /7/);
  assert.match(html, /3/);
  assert.match(
    html,
    /role="progressbar"[^>]*aria-valuemin="0"[^>]*aria-valuemax="100"[^>]*aria-valuenow="70"/,
  );
  assert.match(html, /암호문은 서버에 그대로 보존/);
  assert.doesNotMatch(html, /삭제/);
});

test("blocked panel says content is unavailable, preserves ciphertext, and offers resume", () => {
  for (const locale of ["ko", "en"] as const) {
    const html = render(locale, "blocked");
    assert.match(html, locale === "ko" ? /본문을 열람할 수 없습니다/ : /content cannot be viewed/i);
    assert.match(html, locale === "ko" ? /암호문은 서버에 그대로 보존/ : /ciphertext remains stored/i);
    assert.match(html, locale === "ko" ? /키를 다시 찾았습니다/ : /I found the key/i);
  }
});

test("state request payloads are exact and blocking requires KEY_UNAVAILABLE", () => {
  assert.deepEqual(managedMigrationStateBody("resume"), { action: "resume" });
  assert.deepEqual(managedMigrationStateBody("block"), {
    action: "block",
    confirmation: "KEY_UNAVAILABLE",
  });
  assert.deepEqual(Object.keys(managedMigrationStateBody("block")).sort(), ["action", "confirmation"]);
});

test("panel source uses a confirmation dialog and has no destructive delete action", async () => {
  const source = await readFile(new URL("./managed-migration-panel.tsx", import.meta.url), "utf8");
  assert.match(source, /AlertDialog/);
  assert.match(source, /onBlock\(managedMigrationStateBody\("block"\)\.confirmation\)/);
  assert.doesNotMatch(source, /onDelete|deleteMigration|DELETE/);
});

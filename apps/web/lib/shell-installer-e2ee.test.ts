import assert from "node:assert/strict";
import test from "node:test";
import { installScript } from "./shell-installer";

test("POSIX content opt-in records server-managed collection without E2EE setup", () => {
  const script = installScript("https://toard.example/api", false);
  assert.match(script, /1\|true\|on\|yes\).*collect_content=true/);
  assert.doesNotMatch(
    script,
    /e2ee_v1|e2ee_setup_requested|e2ee setup|mnemonic|recovery_secret|content_owner_id=/i,
  );
});

test("POSIX usage-only install does not persist a content opt-in", () => {
  const script = installScript("https://toard.example/api", false);
  assert.doesNotMatch(script, /0\|false\|off\|no\).*collect_content=true/);
});

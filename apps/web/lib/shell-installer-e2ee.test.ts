import assert from "node:assert/strict";
import test from "node:test";
import { installScript } from "./shell-installer";

test("POSIX E2EE install records only a pending setup request", () => {
  const script = installScript("https://toard.example/api", false);
  assert.match(script, /e2ee_v1\)/);
  assert.match(script, /collect_content=off/);
  assert.match(script, /e2ee_setup_requested=true/);
  assert.doesNotMatch(script, /mnemonic|recovery_secret|content_owner_id=/i);
});

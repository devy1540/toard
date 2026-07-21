import assert from "node:assert/strict";
import test from "node:test";
import { installScript } from "./shell-installer";

test("POSIX server-managed policy is delegated to target upsert without E2EE metadata", () => {
  const script = installScript("https://toard.example/api", false);
  assert.match(script, /TOARD_SHIM_COLLECT_CONTENT="\$COLLECT"/);
  assert.match(script, /target upsert/);
  assert.doesNotMatch(
    script,
    /e2ee_v1|e2ee_setup_requested|e2ee setup|mnemonic|recovery_secret|content_owner_id=|agent_key=/i,
  );
});

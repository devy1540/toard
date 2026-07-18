import assert from "node:assert/strict";
import test from "node:test";
import { installScript } from "./shell-installer";

test("POSIX installer upserts target before daemon and selected doctor", () => {
  const script = installScript("https://personal.example/api", true);

  assert.match(script, /TOARD_INSTALL_DAEMON=0 sh/);
  assert.match(script, /"\$SHIM" capabilities/);
  assert.match(script, /"\$SHIM" target upsert/);
  assert.match(script, /"\$SHIM" daemon install/);
  assert.match(script, /"\$SHIM" doctor --target-env/);
  assert.doesNotMatch(script, />\s*"\$HOME\/\.toard\/credentials"/);
  assert.doesNotMatch(script, /agent_key=/);
  assert.doesNotMatch(script, /target upsert[^\n]*\$TOKEN/);

  const capability = script.indexOf('"$SHIM" capabilities');
  const upsert = script.indexOf('"$SHIM" target upsert');
  const pathChange = script.indexOf("printf '\\nexport PATH=");
  const daemon = script.indexOf('"$SHIM" daemon install');
  const doctor = script.indexOf('"$SHIM" doctor --target-env');
  assert.ok(capability >= 0);
  assert.ok(capability < upsert);
  assert.ok(capability < pathChange);
  assert.ok(upsert < daemon);
  assert.ok(daemon < doctor);
});

test("POSIX installer passes policy through environment without embedding a token", () => {
  const script = installScript("https://personal.example/api", false);

  assert.match(script, /TOARD_INGEST_ENDPOINT="\$ENDPOINT"/);
  assert.match(script, /TOARD_INGEST_TOKEN="\$TOKEN"/);
  assert.match(script, /TOARD_SHIM_COLLECT_CONTENT="\$COLLECT"/);
  assert.match(script, /TOARD_SHIM_COLLECT_TOOLS="\$COLLECT_TOOLS"/);
  assert.match(script, /TOARD_SHIM_COLLECT_CONTENT_SINCE="\$COLLECT_SINCE"/);
  assert.match(script, /TOARD_INGEST_TOKEN 이 필요합니다/);
});

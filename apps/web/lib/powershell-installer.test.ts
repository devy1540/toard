import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPowerShellInstallScript,
  buildPowerShellUninstallScript,
} from "./powershell-installer";

test("installer verifies checksum before credentials and PATH", () => {
  const script = buildPowerShellInstallScript("https://toard.example/api", false);

  assert.match(script, /toard-shim-x86_64-pc-windows-msvc\.exe/);
  assert.match(script, /SHA256SUMS/);
  assert.match(script, /Get-FileHash -Algorithm SHA256/);
  assert.ok(script.indexOf("checksum mismatch") < script.indexOf("WriteAllLines"));
  assert.ok(script.indexOf("checksum mismatch") < script.indexOf("SetEnvironmentVariable"));
  assert.match(script, /UTF8Encoding\(\$false\)/);
  assert.match(script, /toard-shim\.exe.*doctor/s);
  assert.doesNotMatch(script, /Write-Host.*agent_key/);
});

test("installer escapes endpoint and applies content default only when absent", () => {
  const script = buildPowerShellInstallScript("https://toard.example/o'hare/api", true);

  assert.match(script, /https:\/\/toard\.example\/o''hare\/api/);
  assert.match(
    script,
    /if \(-not \$env:TOARD_SHIM_COLLECT_CONTENT\) \{ \$env:TOARD_SHIM_COLLECT_CONTENT = '1' \}/,
  );
});

test("installer uses USERPROFILE for the persistent Windows home", () => {
  const script = buildPowerShellInstallScript("https://toard.example/api", false);

  assert.match(
    script,
    /\$userHome = if \(\$env:USERPROFILE\) \{ \$env:USERPROFILE \} else \{ \$HOME \}/,
  );
  assert.match(script, /\$toardDir = Join-Path \$userHome '\.toard'/);
});

test("installer doctor verifies persisted credentials and gates success", () => {
  const script = buildPowerShellInstallScript("https://toard.example/api", false);

  assert.match(script, /Remove-Item Env:TOARD_INGEST_TOKEN/);
  assert.match(script, /Remove-Item Env:TOARD_INGEST_ENDPOINT/);
  assert.match(script, /\$doctorExit = \$LASTEXITCODE/);
  assert.match(script, /if \(\$doctorExit -ne 0\) \{ throw/);
  assert.ok(script.indexOf("$doctorExit -ne 0") < script.indexOf("toard 연결 완료"));
});

test("uninstaller only targets toard-owned aliases, credentials, and PATH", () => {
  const script = buildPowerShellUninstallScript();

  assert.match(
    script,
    /\$userHome = if \(\$env:USERPROFILE\) \{ \$env:USERPROFILE \} else \{ \$HOME \}/,
  );
  assert.match(script, /\$toardDir = Join-Path \$userHome '\.toard'/);
  for (const name of ["claude.exe", "codex.exe", "toard-shim.exe"]) {
    assert.match(script, new RegExp(name.replace(".", "\\.")));
  }
  assert.match(script, /credentials/);
  assert.match(script, /SetEnvironmentVariable/);
  assert.doesNotMatch(script, /AppData|Program Files|npm uninstall/);
});

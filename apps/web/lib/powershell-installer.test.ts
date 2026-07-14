import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

test("E2EE installer remains off until local setup completes", () => {
  const script = buildPowerShellInstallScript("https://toard.example/api", false);
  assert.match(script, /-eq 'e2ee_v1'/);
  assert.match(script, /collect_content=off/);
  assert.match(script, /e2ee_setup_requested=true/);
  assert.doesNotMatch(script, /mnemonic|recovery_secret|content_owner_id=/i);
});

const testPowerShell =
  process.env.TOARD_TEST_PWSH ?? (process.platform === "win32" ? "pwsh" : undefined);

test(
  "installer writes token and endpoint as separate credential lines",
  { skip: !testPowerShell },
  () => {
    assert.ok(testPowerShell, "PowerShell executable must be configured");
    const script = buildPowerShellInstallScript("https://toard.example/api", false);
    const assignment = script.match(
      /\$lines = @\([\s\S]*?\)(?=\r?\n  if \(\$env:TOARD_SHIM_COLLECT_CONTENT)/,
    )?.[0];
    assert.ok(assignment, "credential line assignment must be present");

    const probe = [
      "$token = 'tk_test'",
      "$endpoint = 'https://toard.example/api'",
      assignment,
      "$lines | ConvertTo-Json -Compress",
    ].join("\n");
    const result = spawnSync(testPowerShell, ["-NoProfile", "-NonInteractive", "-Command", probe], {
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), [
      "agent_key=tk_test",
      "endpoint=https://toard.example/api",
    ]);
  },
);

test(
  "installer uses an explicit release mirror when configured",
  { skip: !testPowerShell },
  () => {
    assert.ok(testPowerShell, "PowerShell executable must be configured");
    const script = buildPowerShellInstallScript("https://toard.example/api", false);
    const assignment = script.match(/^\$release = .*$/m)?.[0];
    assert.ok(assignment, "release assignment must be present");

    const probe = [
      "$env:TOARD_SHIM_RELEASE_BASE = 'http://127.0.0.1:43123/release'",
      assignment,
      "$release",
    ].join("\n");
    const result = spawnSync(testPowerShell, ["-NoProfile", "-NonInteractive", "-Command", probe], {
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "http://127.0.0.1:43123/release");
  },
);

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

test("installer registers Windows periodic collection before doctor", () => {
  const script = buildPowerShellInstallScript("https://toard.example/api", false);

  assert.match(script, /'daemon' 'install'/);
  assert.match(script, /\$daemonExit = \$LASTEXITCODE/);
  assert.match(script, /if \(\$daemonExit -ne 0\) \{ throw/);
  assert.ok(script.indexOf("'daemon' 'install'") < script.indexOf("'doctor'"));
  assert.ok(script.indexOf("$daemonExit -ne 0") < script.indexOf("toard 연결 완료"));
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

test("uninstaller removes the scheduled task before binaries", () => {
  const script = buildPowerShellUninstallScript();

  assert.match(script, /'daemon' 'uninstall'/);
  assert.match(script, /\$daemonExit = \$LASTEXITCODE/);
  assert.match(script, /if \(\$daemonExit -ne 0\) \{ throw/);
  assert.ok(script.indexOf("'daemon' 'uninstall'") < script.indexOf("Remove-Item -Force"));
});

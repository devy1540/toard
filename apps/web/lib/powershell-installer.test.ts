import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  buildPowerShellInstallScript,
  buildPowerShellUninstallScript,
} from "./powershell-installer";

test("PowerShell installer verifies checksum before target, ACL, and PATH", () => {
  const script = buildPowerShellInstallScript("https://toard.example/api", false);

  assert.match(script, /toard-shim-x86_64-pc-windows-msvc\.exe/);
  assert.match(script, /SHA256SUMS/);
  assert.match(script, /Get-FileHash -Algorithm SHA256/);
  assert.doesNotMatch(script, /WriteAllLines[^\n]*credentials/);
  assert.doesNotMatch(script, /agent_key=/);
  assert.ok(script.indexOf("checksum mismatch") < script.indexOf("'capabilities'"));
  assert.ok(
    script.indexOf("checksum mismatch") <
      script.indexOf("$userPath = [Environment]::GetEnvironmentVariable"),
  );
  assert.match(script, /SetAccessRuleProtection\(\$true, \$false\)/);
  assert.match(script, /WindowsIdentity.*GetCurrent/);
});

test("PowerShell installer upserts target before PATH, daemon, and selected doctor", () => {
  const script = buildPowerShellInstallScript(
    "https://personal.example/api",
    false,
  );

  assert.match(script, /'capabilities'/);
  assert.match(script, /'target', 'upsert'/);
  assert.match(script, /'daemon', 'install'/);
  assert.match(script, /'doctor', '--target-env'/);
  assert.doesNotMatch(script, /'target', 'upsert'[^\n]*\$token/);
  const capability = script.indexOf("'capabilities'");
  const upsert = script.indexOf("'target', 'upsert'");
  const path = script.indexOf(
    "$userPath = [Environment]::GetEnvironmentVariable",
  );
  const daemon = script.indexOf("'daemon', 'install'");
  const doctor = script.indexOf("'doctor', '--target-env'");
  assert.ok(capability < upsert);
  assert.ok(capability < path);
  assert.ok(upsert < path);
  assert.ok(path < daemon);
  assert.ok(daemon < doctor);
});

test("PowerShell installer escapes endpoint and delegates all target policies", () => {
  const script = buildPowerShellInstallScript(
    "https://toard.example/o'hare/api",
    true,
  );

  assert.match(script, /https:\/\/toard\.example\/o''hare\/api/);
  assert.match(
    script,
    /if \(-not \$env:TOARD_SHIM_COLLECT_CONTENT\) \{ \$env:TOARD_SHIM_COLLECT_CONTENT = '1' \}/,
  );
  assert.match(script, /TOARD_SHIM_COLLECT_TOOLS/);
  assert.match(script, /TOARD_SHIM_COLLECT_CONTENT_SINCE/);
  assert.doesNotMatch(
    script,
    /e2ee_v1|e2ee_setup_requested|e2ee setup|mnemonic|recovery_secret|content_owner_id=|agent_key=/i,
  );
});

const testPowerShell =
  process.env.TOARD_TEST_PWSH ??
  (process.platform === "win32" ? "pwsh" : undefined);

test(
  "PowerShell installer uses an explicit release mirror when configured",
  { skip: !testPowerShell },
  () => {
    assert.ok(testPowerShell);
    const script = buildPowerShellInstallScript(
      "https://toard.example/api",
      false,
    );
    const assignment = script.match(/^\$release = .*$/m)?.[0];
    assert.ok(assignment);
    const result = spawnSync(
      testPowerShell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        [
          "$env:TOARD_SHIM_RELEASE_BASE = 'http://127.0.0.1:43123/release'",
          assignment,
          "$release",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "http://127.0.0.1:43123/release");
  },
);

test("PowerShell installer uses USERPROFILE for persistent Windows state", () => {
  const script = buildPowerShellInstallScript("https://toard.example/api", false);
  assert.match(
    script,
    /\$userHome = if \(\$env:USERPROFILE\) \{ \$env:USERPROFILE \} else \{ \$HOME \}/,
  );
  assert.match(script, /\$toardDir = Join-Path \$userHome '\.toard'/);
});

test("PowerShell uninstaller gates full cleanup on the last removed target", () => {
  const script = buildPowerShellUninstallScript(
    "https://personal.example/api",
  );

  assert.match(script, /'target', 'remove', '--machine'/);
  assert.match(script, /\^removed=\(\[01\]\)\$/);
  assert.match(script, /\^remaining=\(\\d\+\)\$/);
  assert.match(script, /\$removed -eq 0/);
  assert.match(script, /\$remaining -gt 0/);
  assert.ok(
    script.indexOf("'target', 'remove', '--machine'") <
      script.indexOf("'daemon', 'uninstall'"),
  );
  assert.ok(
    script.indexOf("$remaining -gt 0") <
      script.indexOf("Remove-Item -Recurse"),
  );
  assert.match(script, /cleanup receipt was not found/);
  assert.ok(
    script.indexOf("SetEnvironmentVariable('Path'") <
      script.indexOf("if (Test-Path $shim) { Remove-Item -Force $shim }"),
  );
  assert.ok(
    script.indexOf("if (Test-Path $shim) { Remove-Item -Force $shim }") <
      script.indexOf(
        "if (Test-Path $pendingFile) { Remove-Item -Force $pendingFile }",
      ),
  );
  assert.doesNotMatch(
    script,
    /Remove-Item -Recurse -Force -ErrorAction SilentlyContinue/,
  );
});

test("PowerShell uninstaller removes only toard-owned state during full cleanup", () => {
  const script = buildPowerShellUninstallScript("https://toard.example/api");
  for (const value of [
    "targets",
    "legacy-backup",
    "state",
    "registry.lock",
    "cleanup-pending",
    "claude.exe",
    "codex.exe",
    "toard-shim.exe",
  ]) {
    assert.match(script, new RegExp(value.replace(".", "\\.")));
  }
  assert.match(script, /SetEnvironmentVariable/);
  assert.doesNotMatch(script, /AppData|Program Files|npm uninstall/);
});

test("PowerShell uninstall route injects the current endpoint dynamically", () => {
  const route = readFileSync(
    new URL("../app/uninstall.ps1/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /getIngestEndpoint/);
  assert.match(route, /buildPowerShellUninstallScript.*endpoint/s);
  assert.match(route, /force-dynamic/);
});

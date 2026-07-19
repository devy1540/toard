import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInstallCommand,
  buildManagementCommands,
  detectInstallPlatform,
} from "./onboarding-install";

test("detects Windows, macOS, Linux, and unknown", () => {
  assert.equal(detectInstallPlatform({ userAgentDataPlatform: "Windows" }), "windows");
  assert.equal(detectInstallPlatform({ platform: "MacIntel" }), "macos");
  assert.equal(detectInstallPlatform({ userAgent: "Mozilla/5.0 (X11; Linux x86_64)" }), "linux");
  assert.equal(detectInstallPlatform({ userAgent: "Mozilla/5.0" }), null);
});

test("content opt-in Windows command selects server-managed collection and escapes apostrophes", () => {
  const command = buildInstallCommand({
    platform: "windows",
    baseUrl: "https://toard.example",
    token: "tk_a'b",
    collectContent: true,
  });

  assert.equal(
    command,
    "$env:TOARD_INGEST_TOKEN='tk_a''b'; $env:TOARD_SHIM_COLLECT_CONTENT='1'; irm 'https://toard.example/install.ps1' | iex",
  );
  assert.doesNotMatch(command, /\bsh\b|install\.sh/);
  assert.doesNotMatch(command, /e2ee_v1|recovery|mnemonic|uck/i);
});

test("content opt-in POSIX command selects server-managed collection", () => {
  const command = buildInstallCommand({
    platform: "macos",
    baseUrl: "https://toard.example/",
    token: "tk_test",
    collectContent: true,
  });

  assert.match(command, /TOARD_SHIM_COLLECT_CONTENT='1'/);
  assert.doesNotMatch(command, /e2ee_v1|Recovery Kit|e2ee setup/i);
});

test("macOS and Linux commands use safely quoted POSIX shell", () => {
  for (const platform of ["macos", "linux"] as const) {
    assert.equal(
      buildInstallCommand({
        platform,
        baseUrl: "https://toard.example",
        token: "tk_a'b",
        collectContent: false,
      }),
      "curl -fsSL 'https://toard.example/install.sh' | TOARD_INGEST_TOKEN='tk_a'\"'\"'b' TOARD_SHIM_COLLECT_CONTENT='0' sh",
    );
  }
});

test("management manual setup reuses target-aware installers instead of legacy credentials", () => {
  const windows = buildManagementCommands("windows", "https://toard.example/o'hare/");
  assert.equal(
    windows.manual,
    "$env:TOARD_INGEST_TOKEN='<내 토큰>'; irm 'https://toard.example/o''hare/install.ps1' | iex",
  );
  assert.equal(windows.uninstall, "irm 'https://toard.example/o''hare/uninstall.ps1' | iex");

  for (const platform of ["macos", "linux"] as const) {
    const commands = buildManagementCommands(platform, "https://toard.example/o'hare/");
    assert.equal(
      commands.manual,
      "curl -fsSL 'https://toard.example/o'\"'\"'hare/install.sh' | TOARD_INGEST_TOKEN='<내 토큰>' sh",
    );
    assert.equal(
      commands.uninstall,
      "curl -fsSL 'https://toard.example/o'\"'\"'hare/uninstall.sh' | sh",
    );
  }

  for (const command of [windows.manual, windows.uninstall]) {
    assert.doesNotMatch(command, /\.toard[\\/]credentials|agent_key=/);
  }
});

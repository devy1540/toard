import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { uninstallScript } from "./shell-uninstaller";

test("POSIX uninstaller removes only its endpoint unless it was last", () => {
  const script = uninstallScript("https://personal.example/api");

  assert.match(script, /TOARD_INGEST_ENDPOINT="\$ENDPOINT"/);
  assert.match(script, /target remove --machine/);
  assert.match(script, /\$REMOVED.*0/);
  assert.match(script, /\$REMAINING.*-gt 0/);
  assert.match(script, /REMOVED=.*removed=/);
  assert.match(script, /REMAINING=.*remaining=/);
  assert.ok(
    script.indexOf("target remove --machine") <
      script.indexOf("daemon uninstall"),
  );
  assert.ok(script.indexOf('"$REMOVED" = "0"') < script.indexOf('rm -rf'));
  assert.ok(script.indexOf('"$REMAINING" -gt 0') < script.indexOf('rm -rf'));
});

test("POSIX uninstaller validates the exact machine output before cleanup", () => {
  const script = uninstallScript("https://personal.example/api");

  assert.match(script, /LINE_COUNT/);
  assert.match(script, /machine 출력이 올바르지 않습니다/);
  assert.match(script, /\*\[!0-9\]\*/);
  assert.match(script, /legacy-backup/);
  assert.match(script, /targets/);
  assert.match(script, /state/);
});

test("POSIX uninstall route injects its current public endpoint dynamically", () => {
  const route = readFileSync(
    new URL("../app/uninstall.sh/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /getIngestEndpoint/);
  assert.match(route, /uninstallScript\(endpoint\)/);
  assert.match(route, /force-dynamic/);
  assert.match(route, /cache-control.*no-store/s);
});

test(
  "POSIX uninstaller keeps shared files for missing or non-last targets and cleans the last",
  { skip: process.platform === "win32" },
  () => {
    for (const scenario of [
      { output: "removed=0\nremaining=0", cleaned: false },
      { output: "removed=1\nremaining=1", cleaned: false },
      { output: "removed=1\nremaining=0", cleaned: true },
    ]) {
      const root = mkdtempSync(join(tmpdir(), "toard-uninstall-test-"));
      const home = join(root, "home");
      const bin = join(home, ".toard", "bin");
      mkdirSync(join(home, ".toard", "targets", "keep"), { recursive: true });
      mkdirSync(join(home, ".toard", "state"), { recursive: true });
      mkdirSync(bin, { recursive: true });
      writeFileSync(
        join(bin, "toard-shim"),
        [
          "#!/bin/sh",
          'if [ "$1 $2 $3" = "target remove --machine" ]; then',
          '  printf "%s\\n" "$MACHINE_OUTPUT"',
          'elif [ "$1 $2" = "daemon uninstall" ]; then',
          '  : > "$TEST_ROOT/daemon-called"',
          'elif [ "$1 $2" = "claude-env off" ]; then',
          '  : > "$TEST_ROOT/claude-env-called"',
          "fi",
          "",
        ].join("\n"),
      );
      chmodSync(join(bin, "toard-shim"), 0o755);
      writeFileSync(join(home, ".zshrc"), 'export PATH="x"  # toard shim\n');
      const script = join(root, "uninstall.sh");
      writeFileSync(script, uninstallScript("https://personal.example/api"));

      try {
        try {
          execFileSync("/bin/sh", [script], {
            env: {
              ...process.env,
              HOME: home,
              MACHINE_OUTPUT: scenario.output,
              TEST_ROOT: root,
            },
            stdio: "pipe",
          });
        } catch (error) {
          const failure = error as { stdout?: Buffer; stderr?: Buffer };
          assert.fail(
            `scenario ${JSON.stringify(scenario)} failed\nstdout:\n${failure.stdout?.toString() ?? ""}\nstderr:\n${failure.stderr?.toString() ?? ""}`,
          );
        }
        assert.equal(existsSync(join(bin, "toard-shim")), !scenario.cleaned);
        assert.equal(existsSync(join(root, "daemon-called")), scenario.cleaned);
        assert.equal(
          readFileSync(join(home, ".zshrc"), "utf8").includes("toard shim"),
          !scenario.cleaned,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  },
);

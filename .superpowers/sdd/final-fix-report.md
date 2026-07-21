# Final Whole-Branch Review Fix Report

- Date: 2026-07-20 KST
- Review base/head before this fix wave: `2dd770f`
- Scope: Windows two-file self-update rollback and legacy Windows scheduled-task migration E2E
- Production database, remote branch, tags, and releases were not touched.

## Finding 1 — Windows helper/main update transaction

### Root cause

`download_and_replace` replaced `toard-shim-background.exe` before calling `replace_exe` for the main shim. The main replacement error branch only called `cleanup_downloads`, so a successful helper replacement remained installed when the main replacement failed. This could leave a new helper paired with an old main shim.

### RED evidence

Test-first change: added injected main-replacement failure cases for both an existing helper and a first-time helper install.

Command:

```text
cargo test main_replace_failure -- --nocapture
```

Observed result before implementation:

```text
exit code: 101
error[E0425]: cannot find function `replace_windows_pair` in this scope
src/update.rs:493:21
src/update.rs:531:21
error: could not compile `toard-shim` (bin "shim" test) due to 2 previous errors
```

The failure was expected: the tests described a helper/main replacement boundary that did not yet exist.

### Implementation

- Added `WindowsFileReplacement`, a must-use transaction token that records the helper destination, backup path, and whether an old helper existed.
- `replace_windows_file` still restores the old helper if installing the downloaded helper itself fails, but now returns the live transaction token after success.
- Added `replace_windows_pair`, which commits and deletes the helper backup only after the main replacement succeeds.
- If the main replacement fails, the pair transaction removes the new helper and restores the previous helper. If no helper existed before the update, it removes the newly installed helper.
- A rollback failure is appended to the original main replacement error instead of hiding either failure.
- The common error branch still cleans remaining downloads. Alias synchronization still runs only after both replacements succeed. The Unix path still calls its original single-file `replace_exe` flow.

### GREEN evidence

Commands and observed results:

```text
cargo test main_replace_failure -- --nocapture
2 passed; 0 failed

cargo test update::tests:: -- --nocapture
14 passed; 0 failed
```

The injected failure tests confirmed both required rollback states:

- Existing helper: old helper content restored, helper backup removed, old main unchanged, main download retained for outer cleanup.
- No existing helper: newly installed helper removed, no helper backup left, old main unchanged, main download retained for outer cleanup.

## Finding 2 — Legacy scheduled-task migration E2E

### Root cause

The Windows installer E2E prepared legacy credentials and cursors but did not prepare the legacy `toard-collect` scheduled task. Its post-install XML assertions therefore proved only fresh task creation, not in-place migration of the existing task name and action.

### RED evidence

Test-first change: added a source contract requiring the E2E to create the legacy main-shim path, register `toard-collect` with `collect --quiet` before running the installer, use a non-firing future trigger, and retain idempotent cleanup.

Command:

```text
corepack pnpm --filter @toard/web exec tsx --test lib/ui-commonization.test.ts
```

Observed result before implementation:

```text
tests 54
pass 53
fail 1
exit code: 1
AssertionError: input did not match
/\$legacyShim\s*=\s*Join-Path \$legacyBinDir 'toard-shim\.exe'/
```

The only failing test was `Windows installer E2E migrates an existing legacy scheduled task`, and it failed on the first missing legacy-task setup contract.

### Implementation

- Created the isolated legacy `~/.toard/bin` directory before installation.
- Copied the built console shim to the exact future install path `~/.toard/bin/toard-shim.exe`.
- Registered the existing task name `toard-collect` with that main shim and arguments `collect --quiet`.
- Used a once-only trigger at `(Get-Date).AddYears(1)`, so registration itself cannot trigger collection during setup.
- Registered the task before invoking the installer. The installer overwrites the shim at the same path and force-registers the same task name.
- Kept the existing exact post-install XML assertions: the same task must point to `toard-shim-background.exe` and have no arguments.
- Kept idempotent `finally` cleanup via `schtasks.exe /Delete /TN toard-collect /F` with errors suppressed.

### GREEN evidence

Command and observed result:

```text
corepack pnpm --filter @toard/web exec tsx --test lib/ui-commonization.test.ts
tests 54
pass 54
fail 0
exit code: 0
```

## Full verification

### Native Rust

```text
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo build --release
```

Observed:

- rustfmt: pass
- clippy with warnings denied: pass
- main unit tests: 196 passed, 0 failed, 1 explicitly ignored performance test
- background helper unit tests: 2 passed
- doctor CLI integration: 1 passed
- multi-target CLI integration: 6 passed
- release build: pass

### Windows Rust target

Installed target confirmed: `x86_64-pc-windows-msvc`.

```text
cargo clippy --all-targets --target x86_64-pc-windows-msvc -- -D warnings
cargo check --all-targets --target x86_64-pc-windows-msvc
```

Observed: both commands passed.

### Web and PowerShell contracts

```text
corepack pnpm --filter @toard/web exec tsx --test \
  lib/powershell-installer.test.ts lib/ui-commonization.test.ts
corepack pnpm --filter @toard/web typecheck
```

Observed:

- Combined tests: 63 passed, 0 failed, 1 pre-existing explicit skip
- TypeScript `tsc --noEmit`: pass

### YAML and diff hygiene

```text
ruby -e 'require "yaml"; files = Dir[".github/workflows/*.{yml,yaml}"]; files.each { |file| Psych.parse_file(file) }; puts "parsed #{files.length} workflow YAML files"'
cargo fmt --manifest-path shim/rust/Cargo.toml --check
git diff --check
```

Observed:

- Parsed 6 workflow YAML files
- rustfmt check passed
- diff whitespace check passed

## Final self-review

- Helper install failure still attempts its original immediate rollback and its existing regression test passes.
- Main Windows replacement retains its own `.old` rollback behavior and the Windows target compiles with warnings denied.
- Helper backup commit occurs only after main success; main failure covers both prior-helper states.
- Temporary download cleanup and post-success sibling alias synchronization retain their original ordering.
- Unix remains a single-asset/single-replacement path; its contract test passes.
- The legacy task uses the exact production task name and legacy console action, is registered before installation, and cannot fire during setup.
- The post-install XML checks still require the GUI helper command and empty arguments, and cleanup remains idempotent.

## Remaining validation boundary

The current host is macOS and has no `pwsh`, so the real Windows Task Scheduler E2E and generated PowerShell parser cannot run locally. The Windows cross-target clippy/check and all TypeScript/source contracts passed; the actual scheduled-task lifecycle remains covered by the existing `windows-latest` CI job when this commit is evaluated there.

# Friendly Device Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the token-first settings experience with a three-step, OS-aware device connection wizard that supports native Windows PowerShell installation and confirms the first authenticated request automatically.

**Architecture:** Keep platform detection, command generation, token issuance/status lookup, and PowerShell generation as pure units with focused tests. The client wizard calls authenticated server actions, displays one platform command, polls the issued token ID for `last_used_at`, and leaves maintenance in the existing settings sections.

**Tech Stack:** Next.js 15, React 19, TypeScript 5.7, next-intl, Node test runner with tsx, PowerShell 5.1, Rust shim doctor, GitHub Actions windows-latest.

## Global Constraints

- Support Windows x64, macOS arm64/x64, and Linux arm64/x64; do not present Windows arm64 as supported.
- Do not require a signed installer, GUI installer, or npm publication.
- Preserve the existing content-collection policy and explicit user selection.
- Plaintext tokens may appear only in the one-time install command, never in logs, errors, status responses, or management tables.
- New device token issuance remains additive and must not revoke existing active tokens.
- Windows credentials must be UTF-8 without BOM.
- Checksum failures must stop before credentials or PATH are changed.
- Follow RED-GREEN-REFACTOR and observe every focused test fail before production code is written.
- Do not modify production data or run destructive database commands.

---

### Task 1: Platform Detection and Safe Install Commands

**Files:**
- Create: `apps/web/lib/onboarding-install.ts`
- Create: `apps/web/lib/onboarding-install.test.ts`

**Interfaces:**
- Produces: `InstallPlatform`, `detectInstallPlatform()`, and `buildInstallCommand()`.
- Consumed by: Task 4 client wizard.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/lib/onboarding-install.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { buildInstallCommand, detectInstallPlatform } from "./onboarding-install";

test("detects Windows, macOS, Linux, and unknown", () => {
  assert.equal(detectInstallPlatform({ userAgentDataPlatform: "Windows" }), "windows");
  assert.equal(detectInstallPlatform({ platform: "MacIntel" }), "macos");
  assert.equal(detectInstallPlatform({ userAgent: "Mozilla/5.0 (X11; Linux x86_64)" }), "linux");
  assert.equal(detectInstallPlatform({ userAgent: "Mozilla/5.0" }), null);
});

test("Windows command contains PowerShell only and escapes apostrophes", () => {
  const command = buildInstallCommand({
    platform: "windows",
    baseUrl: "https://toard.example",
    token: "tk_a'b",
    collectContent: true,
  });
  assert.equal(command, "$env:TOARD_INGEST_TOKEN='tk_a''b'; $env:TOARD_SHIM_COLLECT_CONTENT='1'; irm 'https://toard.example/install.ps1' | iex");
  assert.doesNotMatch(command, /\bsh\b|install\.sh/);
});

test("macOS and Linux commands use safely quoted POSIX shell", () => {
  for (const platform of ["macos", "linux"] as const) {
    assert.equal(
      buildInstallCommand({ platform, baseUrl: "https://toard.example", token: "tk_a'b", collectContent: false }),
      "curl -fsSL 'https://toard.example/install.sh' | TOARD_INGEST_TOKEN='tk_a'\"'\"'b' TOARD_SHIM_COLLECT_CONTENT='0' sh",
    );
  }
});
```

- [ ] **Step 2: Verify RED**

```bash
pnpm --filter @toard/web exec node --import tsx --test lib/onboarding-install.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the helpers**

Create `apps/web/lib/onboarding-install.ts`:

```ts
export type InstallPlatform = "windows" | "macos" | "linux";
export type PlatformSignals = {
  userAgentDataPlatform?: string | null;
  platform?: string | null;
  userAgent?: string | null;
};
export type InstallCommandInput = {
  platform: InstallPlatform;
  baseUrl: string;
  token: string;
  collectContent: boolean;
};

export function detectInstallPlatform(input: PlatformSignals): InstallPlatform | null {
  const value = [input.userAgentDataPlatform, input.platform, input.userAgent]
    .filter((item): item is string => Boolean(item)).join(" ").toLowerCase();
  if (/windows|win32|win64/.test(value)) return "windows";
  if (/macintosh|macintel|mac os/.test(value)) return "macos";
  if (/linux|x11/.test(value)) return "linux";
  return null;
}

const trimBaseUrl = (value: string) => value.replace(/\/+$/, "");
const quotePowerShell = (value: string) => `'${value.replaceAll("'", "''")}'`;
const quotePosix = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

export function buildInstallCommand(input: InstallCommandInput): string {
  const collect = input.collectContent ? "1" : "0";
  const baseUrl = trimBaseUrl(input.baseUrl);
  if (input.platform === "windows") {
    return [
      `$env:TOARD_INGEST_TOKEN=${quotePowerShell(input.token)}`,
      `$env:TOARD_SHIM_COLLECT_CONTENT=${quotePowerShell(collect)}`,
      `irm ${quotePowerShell(`${baseUrl}/install.ps1`)} | iex`,
    ].join("; ");
  }
  return `curl -fsSL ${quotePosix(`${baseUrl}/install.sh`)} | TOARD_INGEST_TOKEN=${quotePosix(input.token)} TOARD_SHIM_COLLECT_CONTENT=${quotePosix(collect)} sh`;
}
```

- [ ] **Step 4: Verify GREEN and commit**

```bash
pnpm --filter @toard/web exec node --import tsx --test lib/onboarding-install.test.ts
git add apps/web/lib/onboarding-install.ts apps/web/lib/onboarding-install.test.ts
git commit -m "feat(onboarding): OS별 설치 명령 생성"
```

Expected: 3 tests PASS before commit.

---

### Task 2: Token Metadata and Ownership-Safe Connection Polling

**Files:**
- Modify: `apps/web/lib/tokens.ts`
- Modify: `apps/web/lib/tokens.test.ts`
- Modify: `apps/web/app/(dashboard)/settings/token-actions.ts`

**Interfaces:**
- Produces: `IssuedIngestToken`, `TokenConnectionStatus`, `issueDeviceToken()`, and `getTokenConnectionStatus()`.
- Produces: `issueOnboardingTokenAction()` and `checkTokenConnectionAction()`.
- Consumed by: Task 4 client wizard.

- [ ] **Step 1: Add failing token tests**

Extend the imports and append to `apps/web/lib/tokens.test.ts`:

```ts
test("issueDeviceToken returns token ID without revoking existing tokens", async () => {
  const queries: Query[] = [];
  const pool = { async query(sql: string, params?: unknown[]) {
    queries.push({ sql, params });
    return { rows: [{ id: "token-new" }] };
  } };
  const issued = await issueDeviceTokenWithPool("user-1", pool);
  assert.match(issued.token, /^tk_[0-9a-f]{48}$/);
  assert.equal(issued.tokenId, "token-new");
  assert.match(queries[0]!.sql, /RETURNING id/);
  assert.equal(queries.some((query) => /revoked_at = now/.test(query.sql)), false);
});

test("connection status lookup requires both owner and token ID", async () => {
  const queries: Query[] = [];
  const usedAt = new Date("2026-07-13T01:00:00Z");
  const pool = { async query(sql: string, params?: unknown[]) {
    queries.push({ sql, params });
    return { rows: [{ last_used_at: usedAt, last_host: null }] };
  } };
  assert.deepEqual(await getTokenConnectionStatusWithPool("user-1", "token-1", pool), {
    connected: true, lastUsedAt: usedAt, lastHost: null,
  });
  assert.match(queries[0]!.sql, /user_id = \$1 AND id = \$2/);
  assert.deepEqual(queries[0]!.params, ["user-1", "token-1"]);
});
```

Import `issueDeviceTokenWithPool` and `getTokenConnectionStatusWithPool`. Update the existing issuance fake to return `{ rows: [{ id: "token-1" }] }` for the new `RETURNING id` contract.

- [ ] **Step 2: Verify RED**

```bash
pnpm --filter @toard/web exec node --import tsx --test lib/tokens.test.ts
```

Expected: FAIL because the new functions are missing.

- [ ] **Step 3: Implement metadata issuance and status lookup**

Add these public types and functions to `apps/web/lib/tokens.ts`:

```ts
export type IssuedIngestToken = { token: string; tokenId: string };
export type TokenConnectionStatus = { connected: boolean; lastUsedAt: Date | null; lastHost: string | null };

async function createTokenWithPool(userId: string, pool: Queryable, label?: string | null): Promise<IssuedIngestToken> {
  const token = genToken();
  const result = await pool.query(
    "INSERT INTO ingest_tokens (user_id, token_hash, device_label) VALUES ($1, $2, $3) RETURNING id",
    [userId, hashToken(token), normalizeLabel(label)],
  );
  const tokenId = result?.rows[0]?.id;
  if (typeof tokenId !== "string") throw new Error("ingest token id missing");
  return { token, tokenId };
}

export const issueDeviceToken = (userId: string) => issueDeviceTokenWithPool(userId, getPool());
export const issueDeviceTokenWithPool = (userId: string, pool: Queryable) => createTokenWithPool(userId, pool, null);

export const getTokenConnectionStatus = (userId: string, tokenId: string) =>
  getTokenConnectionStatusWithPool(userId, tokenId, getPool());

export async function getTokenConnectionStatusWithPool(userId: string, tokenId: string, pool: Queryable): Promise<TokenConnectionStatus> {
  const result = await pool.query(
    `SELECT last_used_at, last_host FROM ingest_tokens
     WHERE user_id = $1 AND id = $2 AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > now())`,
    [userId, tokenId],
  );
  const row = result?.rows[0] as { last_used_at: Date | null; last_host: string | null } | undefined;
  return { connected: Boolean(row?.last_used_at), lastUsedAt: row?.last_used_at ?? null, lastHost: row?.last_host ?? null };
}
```

Refactor `issueTokenWithPool` to return `(await createTokenWithPool(userId, pool, label)).token`, preserving its string API.

- [ ] **Step 4: Verify GREEN**

Run the Step 2 command. Expected: all token tests PASS.

- [ ] **Step 5: Add authenticated server actions**

In `token-actions.ts`, keep `revokeTokenAction` and replace form-based issuance with:

```ts
export type TokenState = { token?: string; tokenId?: string; error?: string };

export async function issueOnboardingTokenAction(): Promise<TokenState> {
  const t = await getTranslations("settings");
  const userId = (await auth())?.user?.id;
  if (!userId) return { error: t("errors.loginRequired") };
  try {
    const issued = await issueDeviceToken(userId);
    revalidatePath("/settings");
    return issued;
  } catch {
    return { error: t("errors.issueTokenFailed") };
  }
}

export async function checkTokenConnectionAction(tokenId: string): Promise<TokenConnectionStatus> {
  const userId = (await auth())?.user?.id;
  if (!userId || !tokenId) return { connected: false, lastUsedAt: null, lastHost: null };
  return getTokenConnectionStatus(userId, tokenId);
}
```

Import `issueDeviceToken`, `getTokenConnectionStatus`, and `TokenConnectionStatus` from `@/lib/tokens`.

- [ ] **Step 6: Verify and commit**

```bash
pnpm --filter @toard/web test
pnpm --filter @toard/web typecheck
git add apps/web/lib/tokens.ts apps/web/lib/tokens.test.ts 'apps/web/app/(dashboard)/settings/token-actions.ts'
git commit -m "feat(onboarding): 연결 상태 확인용 토큰 발급"
```

Expected: tests and typecheck PASS. If `ERR_PNPM_IGNORED_BUILDS` blocks the wrapper, run the focused Node test and `pnpm --filter @toard/web exec tsc --noEmit`, and report the wrapper blocker separately.

---

### Task 3: Native PowerShell Install and Uninstall Routes

**Files:**
- Create: `apps/web/lib/powershell-installer.ts`
- Create: `apps/web/lib/powershell-installer.test.ts`
- Create: `apps/web/app/install.ps1/route.ts`
- Create: `apps/web/app/uninstall.ps1/route.ts`
- Modify: `.github/workflows/shim-ci.yml`

**Interfaces:**
- Produces: `buildPowerShellInstallScript(endpoint, contentDefaultOn)` and `buildPowerShellUninstallScript()`.
- Produces: GET `/install.ps1` and `/uninstall.ps1` with no-store text responses.
- Consumed by: Task 1 Windows command and Task 4 management removal command.

- [ ] **Step 1: Write failing script contract tests**

Create `apps/web/lib/powershell-installer.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { buildPowerShellInstallScript, buildPowerShellUninstallScript } from "./powershell-installer";

test("installer verifies checksum before credentials and PATH", () => {
  const script = buildPowerShellInstallScript("https://toard.example/api", false);
  assert.match(script, /toard-shim-x86_64-pc-windows-msvc\.exe/);
  assert.match(script, /SHA256SUMS/);
  assert.match(script, /Get-FileHash -Algorithm SHA256/);
  assert.ok(script.indexOf("checksum mismatch") < script.indexOf("WriteAllLines"));
  assert.ok(script.indexOf("checksum mismatch") < script.indexOf("SetEnvironmentVariable"));
  assert.match(script, /UTF8Encoding\(\$false\)/);
  assert.match(script, /toard-shim\.exe.*doctor/);
});

test("uninstaller only targets toard-owned aliases, credentials, and PATH", () => {
  const script = buildPowerShellUninstallScript();
  for (const name of ["claude.exe", "codex.exe", "toard-shim.exe"]) {
    assert.match(script, new RegExp(name.replace(".", "\\.")));
  }
  assert.match(script, /credentials/);
  assert.match(script, /SetEnvironmentVariable/);
  assert.doesNotMatch(script, /AppData|Program Files|npm uninstall/);
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
pnpm --filter @toard/web exec node --import tsx --test lib/powershell-installer.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the PowerShell builders**

Create `powershell-installer.ts` with PowerShell single-quote escaping and CRLF output. The install builder emits these operations in order:

```powershell
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$endpoint = if ($env:TOARD_INGEST_ENDPOINT) { $env:TOARD_INGEST_ENDPOINT } else { '<server endpoint>' }
$token = $env:TOARD_INGEST_TOKEN
if (-not $token) { throw 'toard token is missing. Copy the install command again.' }
$asset = 'toard-shim-x86_64-pc-windows-msvc.exe'
$release = 'https://github.com/devy1540/toard/releases/latest/download'
$temp = Join-Path ([IO.Path]::GetTempPath()) ('toard-' + [guid]::NewGuid())
$toardDir = Join-Path $HOME '.toard'
$binDir = Join-Path $toardDir 'bin'
New-Item -ItemType Directory -Force -Path $temp | Out-Null
try {
  Invoke-WebRequest -UseBasicParsing -Uri "$release/$asset" -OutFile (Join-Path $temp $asset)
  Invoke-WebRequest -UseBasicParsing -Uri "$release/SHA256SUMS" -OutFile (Join-Path $temp 'SHA256SUMS')
  $match = [regex]::Match([IO.File]::ReadAllText((Join-Path $temp 'SHA256SUMS')), '(?im)^([a-f0-9]{64})\s+\*?toard-shim-x86_64-pc-windows-msvc\.exe\s*$')
  if (-not $match.Success) { throw 'checksum entry missing' }
  $actual = (Get-FileHash -Algorithm SHA256 -Path (Join-Path $temp $asset)).Hash.ToLowerInvariant()
  if ($actual -ne $match.Groups[1].Value.ToLowerInvariant()) { throw 'checksum mismatch' }
  New-Item -ItemType Directory -Force -Path $binDir | Out-Null
  foreach ($name in @('claude.exe', 'codex.exe', 'toard-shim.exe')) { Copy-Item -Force (Join-Path $temp $asset) (Join-Path $binDir $name) }
  $lines = @('agent_key=' + $token, 'endpoint=' + $endpoint)
  if ($env:TOARD_SHIM_COLLECT_CONTENT -match '^(1|true|on|yes)$') { $lines += 'collect_content=true' }
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllLines((Join-Path $toardDir 'credentials'), $lines, $utf8)
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = @($userPath -split ';' | Where-Object { $_ })
  if (-not ($parts | Where-Object { $_.TrimEnd('\') -ieq $binDir.TrimEnd('\') })) { [Environment]::SetEnvironmentVariable('Path', ($binDir + ';' + ($parts -join ';')), 'User') }
  if (-not (($env:Path -split ';') | Where-Object { $_.TrimEnd('\') -ieq $binDir.TrimEnd('\') })) { $env:Path = $binDir + ';' + $env:Path }
  & (Join-Path $binDir 'toard-shim.exe') 'doctor'
  Write-Host 'toard 연결 완료'
} finally {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $temp
}
```

The builder sets `TOARD_SHIM_COLLECT_CONTENT` to the server default only when the environment variable is absent. `buildPowerShellUninstallScript()` runs `toard-shim.exe claude-env off` when present, deletes only the three aliases, `.old` siblings, credentials, and `state/claude-env.json`, removes empty toard directories, removes PATH entries exactly equal to `$HOME\.toard\bin`, updates current-process PATH, and prints `toard 제거 완료`. It never searches outside `.toard`.

- [ ] **Step 4: Verify GREEN**

Run the Step 2 command. Expected: 2 tests PASS.

- [ ] **Step 5: Add dynamic routes**

Create `install.ps1/route.ts`:

```ts
import { contentCollectionDefaultOn } from "@/lib/content-crypto";
import { buildPowerShellInstallScript } from "@/lib/powershell-installer";
import { getIngestEndpoint } from "@/lib/public-url";
export const dynamic = "force-dynamic";
export async function GET() {
  return new Response(buildPowerShellInstallScript(await getIngestEndpoint(), contentCollectionDefaultOn()), {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
```

Create `uninstall.ps1/route.ts`:

```ts
import { buildPowerShellUninstallScript } from "@/lib/powershell-installer";
export const dynamic = "force-static";
export function GET() {
  return new Response(buildPowerShellUninstallScript(), {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
```

- [ ] **Step 6: Parse generated scripts in Windows CI**

Add the new builder and route paths to both shim-ci path filters. In `check-windows`, add Node 20, pnpm setup, root workspace install, generate both scripts into `$env:RUNNER_TEMP`, and parse them:

```powershell
[scriptblock]::Create((Get-Content -Raw "$env:RUNNER_TEMP/install.ps1")) | Out-Null
[scriptblock]::Create((Get-Content -Raw "$env:RUNNER_TEMP/uninstall.ps1")) | Out-Null
```

Remove job-level `working-directory: shim/rust`; set it explicitly on Rust clippy/test/build so root workspace steps execute from the repository root.

- [ ] **Step 7: Verify and commit**

```bash
pnpm --filter @toard/web exec node --import tsx --test lib/powershell-installer.test.ts
pnpm --filter @toard/web typecheck
git diff --check
git add apps/web/lib/powershell-installer.ts apps/web/lib/powershell-installer.test.ts apps/web/app/install.ps1/route.ts apps/web/app/uninstall.ps1/route.ts .github/workflows/shim-ci.yml
git commit -m "feat(shim): Windows PowerShell 설치기 추가"
```

Expected: tests, typecheck, and diff check PASS before commit.

---

### Task 4: Three-Step Wizard and Management Separation

**Files:**
- Create: `apps/web/app/(dashboard)/settings/onboarding-flow.ts`
- Create: `apps/web/app/(dashboard)/settings/onboarding-flow.test.ts`
- Create: `apps/web/app/(dashboard)/settings/onboarding-wizard.tsx`
- Modify: `apps/web/app/(dashboard)/settings/onboarding-panel.tsx`
- Modify: `apps/web/app/(dashboard)/settings/page.tsx`
- Modify: `apps/web/messages/ko/settings.json`
- Modify: `apps/web/messages/en/settings.json`
- Modify: `apps/web/lib/ui-commonization.test.ts`

**Interfaces:**
- Produces: `OnboardingWizard` and pure `onboardingReducer`.
- Consumes: Task 1 helpers and Task 2 server actions.
- Keeps: `OnboardingPanel` as management-only disclosure.

- [ ] **Step 1: Write failing reducer tests**

Create `onboarding-flow.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { initialOnboardingState, onboardingReducer } from "./onboarding-flow";

test("does not issue before platform selection", () => {
  const state = onboardingReducer(initialOnboardingState, { type: "continue" });
  assert.equal(state.step, "platform");
  assert.equal(state.token, null);
});

test("advances install through verification to success", () => {
  let state = onboardingReducer(initialOnboardingState, { type: "start" });
  state = onboardingReducer(state, { type: "select-platform", platform: "windows" });
  state = onboardingReducer(state, { type: "issued", token: "tk_test", tokenId: "token-1" });
  state = onboardingReducer(state, { type: "verify" });
  state = onboardingReducer(state, { type: "connected", lastHost: null });
  assert.equal(state.step, "success");
});

test("shows recovery after polling timeout", () => {
  const state = onboardingReducer(
    { ...initialOnboardingState, step: "verifying", platform: "linux", token: "tk_test", tokenId: "token-1" },
    { type: "timeout" },
  );
  assert.equal(state.step, "stalled");
});
```

- [ ] **Step 2: Verify RED**

```bash
pnpm --filter @toard/web exec node --import tsx --test 'app/(dashboard)/settings/onboarding-flow.test.ts'
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the reducer**

Create `onboarding-flow.ts`:

```ts
import type { InstallPlatform } from "@/lib/onboarding-install";
export type OnboardingStep = "intro" | "platform" | "install" | "verifying" | "success" | "stalled";
export type OnboardingState = {
  step: OnboardingStep;
  platform: InstallPlatform | null;
  token: string | null;
  tokenId: string | null;
  lastHost: string | null;
};
export type OnboardingAction =
  | { type: "start" }
  | { type: "select-platform"; platform: InstallPlatform }
  | { type: "continue" }
  | { type: "issued"; token: string; tokenId: string }
  | { type: "verify" }
  | { type: "connected"; lastHost: string | null }
  | { type: "timeout" }
  | { type: "retry" }
  | { type: "reset" };
export const initialOnboardingState: OnboardingState = {
  step: "intro", platform: null, token: null, tokenId: null, lastHost: null,
};
export function onboardingReducer(state: OnboardingState, action: OnboardingAction): OnboardingState {
  switch (action.type) {
    case "start": return { ...state, step: "platform" };
    case "select-platform": return { ...state, platform: action.platform };
    case "continue": return state.platform ? state : { ...state, step: "platform" };
    case "issued": return { ...state, step: "install", token: action.token, tokenId: action.tokenId };
    case "verify": return state.tokenId ? { ...state, step: "verifying" } : state;
    case "connected": return { ...state, step: "success", lastHost: action.lastHost };
    case "timeout": return { ...state, step: "stalled" };
    case "retry": return { ...state, step: "install" };
    case "reset": return initialOnboardingState;
  }
}
```

- [ ] **Step 4: Verify GREEN**

Run the Step 2 command. Expected: 3 tests PASS.

- [ ] **Step 5: Implement `OnboardingWizard`**

Create a client component with these exact behaviors:

- detect once from `navigator.userAgentData?.platform`, `navigator.platform`, and `navigator.userAgent`;
- render intro, three accessible `aria-pressed` OS buttons, install, verifying, success, and stalled states;
- call `issueOnboardingTokenAction()` only after OS confirmation;
- generate and display exactly one command with `buildInstallCommand()`;
- copy with Clipboard API and show visible copied text plus toast feedback;
- poll `checkTokenConnectionAction(tokenId)` every `2_000` ms for at most `120_000` ms, cancelling timers and ignoring stale results on cleanup;
- show host only when non-null, otherwise show the translated OS label;
- provide retry, platform-specific doctor copy, and OS reselection in stalled state;
- preserve the content toggle and always show privacy copy matching its value;
- render plaintext token only inside the generated command;
- show text `1/3`, `2/3`, `3/3` with an accessible progress label;
- keep buttons full-width below 640px and horizontal scrolling limited to the command block.

Use existing `Button`, `Switch`, `CopyButton`, `toast`, next-intl, `useReducer`, `useEffect`, and `useTransition`. The Windows doctor command is `& "$HOME\.toard\bin\toard-shim.exe" doctor`; macOS/Linux use `toard-shim doctor`.

- [ ] **Step 6: Make `OnboardingPanel` management-only**

Remove issuance, label input, one-line install, and new-token notice. Keep manual configuration and removal inside `연결된 컴퓨터 관리`. Manual configuration must be OS-aware and must never show POSIX commands while Windows is selected; the Windows advanced view shows the `.toard\credentials` location and PowerShell doctor/update commands, while macOS/Linux retain the existing shell snippet. Add OS detection/selection for removal commands: Windows uses `irm '<baseUrl>/uninstall.ps1' | iex`; macOS/Linux use `/uninstall.sh`. Keep token management and device list as existing separate cards.

Render `OnboardingWizard` first and the management panel below it in `settings/page.tsx`. Replace the technical installation card title/description with result-first copy (`내 컴퓨터 연결` / `Claude와 Codex 사용량을 내 계정에서 확인할 수 있습니다`) so the card header does not reintroduce `shim`, `ingest`, or `token`. Remove the unused `getActiveTokenMeta` query and obsolete `hasToken`, `createdAt`, and `lastUsedAt` props after the wizard no longer consumes them.

- [ ] **Step 7: Add matching Korean and English copy**

Both catalogs must have the same `wizard` shape with these leaves:

```text
introTitle, introDescription, introPrivacyMetadata, introPrivacyContent, start,
platformTitle, platformDescription, detected, windows, macos, linux, continue,
issuing, installTitle.windows, installTitle.macos, installTitle.linux,
openTerminal.windows, openTerminal.macos, openTerminal.linux, copyInstall,
copiedInstall, pasteAndRun, ranCommand, verifyTitle, verifyDescription,
connectedTitle, connectedDescription, viewUsage, connectAnother, stalledTitle,
stalledDescription, copyAgain, copyDoctor, choosePlatformAgain, progress,
contentLabel, contentMetadataOnly, contentWithPrompts
```

Primary Korean wizard copy uses `연결`, `컴퓨터`, `PowerShell`, and `터미널`, avoiding `ingest`, `shim`, and `token`. Technical terms remain in management and diagnostics.

- [ ] **Step 8: Add UI and locale-shape assertions**

Extend `ui-commonization.test.ts`:

```ts
test("device onboarding uses OS-aware wizard and separate management", () => {
  const wizard = source("app/(dashboard)/settings/onboarding-wizard.tsx");
  const panel = source("app/(dashboard)/settings/onboarding-panel.tsx");
  assert.match(wizard, /detectInstallPlatform/);
  assert.match(wizard, /issueOnboardingTokenAction/);
  assert.match(wizard, /checkTokenConnectionAction/);
  assert.match(wizard, /2_000/);
  assert.match(wizard, /120_000/);
  assert.match(panel, /uninstall\.ps1/);
  assert.doesNotMatch(panel, /issueOnboardingTokenAction/);
});

test("visible onboarding privacy choice uses the shared switch", () => {
  assert.match(source("app/(dashboard)/settings/onboarding-wizard.tsx"), /@\/components\/ui\/switch/);
});

test("settings catalogs keep wizard shape aligned", () => {
  const ko = JSON.parse(source("messages/ko/settings.json"));
  const en = JSON.parse(source("messages/en/settings.json"));
  assert.deepEqual(messageShape(ko.wizard), messageShape(en.wizard));
});
```

Update the pre-existing shared-switch assertion in the same file from `onboarding-panel.tsx` to `onboarding-wizard.tsx`; keep the disclosure assertion pointed at `onboarding-panel.tsx`.

- [ ] **Step 9: Verify and commit**

```bash
pnpm --filter @toard/web exec node --import tsx --test 'app/(dashboard)/settings/onboarding-flow.test.ts'
pnpm --filter @toard/web test
pnpm --filter @toard/web typecheck
git add 'apps/web/app/(dashboard)/settings/onboarding-flow.ts' 'apps/web/app/(dashboard)/settings/onboarding-flow.test.ts' 'apps/web/app/(dashboard)/settings/onboarding-wizard.tsx' 'apps/web/app/(dashboard)/settings/onboarding-panel.tsx' 'apps/web/app/(dashboard)/settings/page.tsx' apps/web/messages/ko/settings.json apps/web/messages/en/settings.json apps/web/lib/ui-commonization.test.ts
git commit -m "feat(onboarding): 단계형 기기 연결 마법사 추가"
```

Expected: focused reducer tests, full web tests, and typecheck PASS before commit.

---

### Task 5: Documentation and End-to-End Verification

**Files:**
- Modify: `README.md`
- Modify: `shim/README.md`
- Verify: all files changed in Tasks 1–4.

**Interfaces:**
- Consumes: all earlier tasks.
- Produces: aligned docs and recorded verification boundaries.

- [ ] **Step 1: Update docs**

Replace the unpublished npm-based Windows primary path with:

```powershell
$env:TOARD_INGEST_TOKEN='<내 토큰>'; irm '<toard 주소>/install.ps1' | iex
```

State that the settings wizard fills the real token, Windows x64 comes from GitHub Release, Windows scheduled collection is still unsupported, and macOS/Linux continue to use `/install.sh`.

- [ ] **Step 2: Run all automated checks**

```bash
pnpm --filter @toard/web exec node --import tsx --test lib/onboarding-install.test.ts lib/powershell-installer.test.ts lib/tokens.test.ts 'app/(dashboard)/settings/onboarding-flow.test.ts'
pnpm --filter @toard/web test
pnpm --filter @toard/web typecheck
cargo test --manifest-path shim/rust/Cargo.toml
git diff --check
```

Expected: PASS. Separate any `ERR_PNPM_IGNORED_BUILDS` wrapper failure from direct Node/tsc results.

- [ ] **Step 3: Verify local route content without installing**

```bash
curl -fsS http://localhost:3101/install.sh | sh -n
curl -fsS http://localhost:3101/install.ps1 | rg 'Get-FileHash|UTF8Encoding|toard-shim\.exe'
curl -fsS http://localhost:3101/uninstall.ps1 | rg 'claude\.exe|codex\.exe|toard-shim\.exe|SetEnvironmentVariable'
```

Expected: Unix syntax exits 0 and PowerShell routes contain all safety operations. Do not execute installers on the current machine.

- [ ] **Step 4: Perform local visual QA**

At open-auth port 3101, inspect intro; all three OS selections; each install command; verifying, success, and stalled states; 320px and desktop widths; and existing token/device management below the wizard. Only command blocks may scroll horizontally, primary actions remain visible, and technical token/shim terms stay out of the primary wizard.

- [ ] **Step 5: Record Windows verification boundary**

Confirm generated PowerShell parses in `windows-latest`. If no real Windows machine is available, explicitly leave download, replacement, persistent PATH, and doctor runtime as requiring live Windows verification.

- [ ] **Step 6: Commit docs and review final state**

```bash
git add README.md shim/README.md
git commit -m "docs(onboarding): OS별 연결 안내 정리"
git status --short
git log --oneline -6
git diff HEAD~4 --stat
git diff HEAD~4 --check
```

Expected: clean worktree, four implementation commits after the design/plan commits, and no whitespace errors.

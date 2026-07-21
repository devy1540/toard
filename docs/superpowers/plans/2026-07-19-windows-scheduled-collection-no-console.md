# Windows Scheduled Collection No-Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Windows의 `toard-collect` 예약 작업을 네이티브 GUI-subsystem helper로 실행해 5분마다 나타나는 콘솔 창을 제거한다.

**Architecture:** CLI용 `toard-shim.exe`는 Windows CUI로 유지하고, 별도 `toard-shim-background.exe`가 sibling shim을 `CREATE_NO_WINDOW`로 실행한다. PowerShell 설치기와 Task Scheduler는 helper를 설치·호출하며, 릴리스와 self-update는 두 Windows 자산을 함께 검증·배포한다.

**Tech Stack:** Rust 2021, `std::os::windows::process::CommandExt`, Windows Task Scheduler XML, TypeScript PowerShell generator, PowerShell E2E, GitHub Actions

## Global Constraints

- 예약 작업 이름은 `toard-collect`, 기본 주기는 정확히 300초(`PT5M`)다.
- principal은 현재 사용자 SID의 `InteractiveToken`과 `LeastPrivilege`를 유지한다.
- main shim PE subsystem은 `Windows CUI(3)`, background helper는 `Windows GUI(2)`다.
- helper는 token·endpoint·수집 정책을 갖지 않고 sibling `toard-shim.exe collect --quiet`만 `CREATE_NO_WINDOW`로 실행한다.
- 기존 Windows 설치의 최초 전환은 새 릴리스 배포 후 기존 `install.ps1` 연결 명령을 한 번 다시 실행한다.
- target이 남아 있으면 helper와 예약 작업을 유지하고 마지막 target 제거에서만 정리한다.
- Node 명령은 저장소에 고정된 pnpm 9.15.0을 사용하도록 `corepack pnpm`으로 실행한다.
- 프로덕션 DB와 원본 Claude/Codex 로그는 변경하지 않는다.

---

## File Map

- Create: `shim/rust/src/bin/toard-shim-background.rs` — GUI-subsystem helper와 child process 경계
- Modify: `shim/rust/src/daemon.rs` — Windows 예약 작업 action을 helper로 변경
- Modify: `shim/rust/src/update.rs` — Windows self-update에서 helper 자산도 검증·교체
- Modify: `apps/web/lib/powershell-installer.ts` — helper 다운로드·checksum·설치·제거
- Modify: `apps/web/lib/powershell-installer.test.ts` — 생성 PowerShell의 helper lifecycle 계약
- Modify: `.github/scripts/test-shim-installer-windows.ps1` — 네이티브 설치·예약 실행·제거 E2E
- Modify: `.github/workflows/shim-ci.yml` — PE subsystem과 Windows E2E 입력 검증
- Modify: `.github/workflows/shim-release.yml` — Windows helper 릴리스 자산 게시
- Modify: `apps/web/lib/ui-commonization.test.ts` — CI와 릴리스 workflow 정적 계약

---

### Task 1: 네이티브 무창 helper와 예약 작업 action

**Files:**
- Create: `shim/rust/src/bin/toard-shim-background.rs`
- Modify: `shim/rust/src/daemon.rs:18,139-157,285-357,854-873`

**Interfaces:**
- Produces: 설치 파일명 `toard-shim-background.exe`
- Produces: `launch_spec(current_exe: &Path) -> Result<LaunchSpec, &'static str>`
- Produces: Windows 작업 action `<Command>...\toard-shim-background.exe</Command>` with no arguments
- Consumes: sibling `toard-shim.exe` and existing `collect --quiet` CLI

- [ ] **Step 1: 예약 작업과 helper launch spec의 실패 테스트 작성**

`daemon.rs`의 기존 `windows_task_uses_current_user_limited_five_minute_schedule`에서 main shim 경로를 입력하되 helper command를 기대하도록 바꾼다.

```rust
#[test]
fn windows_task_uses_background_helper_without_arguments() {
    let script = windows_registration_script(
        r"C:\Users\GA\.toard\bin\toard-shim.exe",
        "S-1-5-21-1234-5678-9012-1001",
        DEFAULT_INTERVAL_SECS,
    );

    assert!(script.contains("<Interval>PT5M</Interval>"));
    assert!(script.contains("<LogonType>InteractiveToken</LogonType>"));
    assert!(script.contains("<RunLevel>LeastPrivilege</RunLevel>"));
    assert!(script.contains(
        r"<Command>C:\Users\GA\.toard\bin\toard-shim-background.exe</Command>"
    ));
    assert!(!script.contains("<Arguments>collect --quiet</Arguments>"));
}
```

새 helper 파일에는 순수 launch spec 테스트를 먼저 작성한다.

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launches_sibling_shim_without_a_console() {
        let spec = launch_spec(Path::new(
            r"C:\Users\GA\.toard\bin\toard-shim-background.exe",
        ))
        .expect("valid helper path");

        assert_eq!(
            spec.executable,
            PathBuf::from(r"C:\Users\GA\.toard\bin\toard-shim.exe")
        );
        assert_eq!(spec.args, ["collect", "--quiet"]);
        assert_eq!(spec.creation_flags, CREATE_NO_WINDOW);
    }

    #[test]
    fn refuses_a_path_without_a_parent() {
        assert_eq!(launch_spec(Path::new("")), Err("helper parent directory is missing"));
    }
}
```

- [ ] **Step 2: RED 확인**

Run:

```bash
cargo test --manifest-path shim/rust/Cargo.toml daemon::tests::windows_task_uses_background_helper_without_arguments
```

Expected: FAIL because XML still contains `toard-shim.exe` and `collect --quiet`.

Run:

```bash
cargo test --manifest-path shim/rust/Cargo.toml --bin toard-shim-background
```

Expected: FAIL because the new binary/functions do not exist yet.

- [ ] **Step 3: 최소 helper 구현**

Create `shim/rust/src/bin/toard-shim-background.rs`:

```rust
#![cfg_attr(windows, windows_subsystem = "windows")]

use std::path::{Path, PathBuf};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, PartialEq, Eq)]
struct LaunchSpec {
    executable: PathBuf,
    args: [&'static str; 2],
    creation_flags: u32,
}

fn launch_spec(current_exe: &Path) -> Result<LaunchSpec, &'static str> {
    let parent = current_exe
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or("helper parent directory is missing")?;
    Ok(LaunchSpec {
        executable: parent.join("toard-shim.exe"),
        args: ["collect", "--quiet"],
        creation_flags: CREATE_NO_WINDOW,
    })
}

#[cfg(windows)]
fn run() -> i32 {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    let current = match std::env::current_exe() {
        Ok(path) => path,
        Err(_) => return 1,
    };
    let spec = match launch_spec(&current) {
        Ok(spec) => spec,
        Err(_) => return 1,
    };
    match Command::new(spec.executable)
        .args(spec.args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(spec.creation_flags)
        .status()
    {
        Ok(status) => status.code().unwrap_or(1),
        Err(_) => 1,
    }
}

#[cfg(not(windows))]
fn run() -> i32 {
    1
}

fn main() {
    std::process::exit(run());
}
```

Keep the test module shown in Step 1 at the bottom of the file.

- [ ] **Step 4: 예약 작업이 helper를 사용하도록 최소 변경**

`daemon.rs`에 파일명 상수를 추가하고 `windows_registration_script`가 받은 main shim의 sibling helper를 XML에 기록하게 한다.

```rust
const WINDOWS_TASK_NAME: &str = "toard-collect";
const WINDOWS_BACKGROUND_EXE: &str = "toard-shim-background.exe";

fn windows_background_exe(shim: &str) -> PathBuf {
    PathBuf::from(shim).with_file_name(WINDOWS_BACKGROUND_EXE)
}
```

`windows_registration_script` 안에서는 다음 값을 사용한다.

```rust
let background = windows_background_exe(exe);
let background = background.display().to_string();
```

XML action은 다음과 같아야 한다.

```xml
<Actions Context="Author">
  <Exec>
    <Command>{background}</Command>
  </Exec>
</Actions>
```

`windows_install`은 UAC 요청 전에 helper 존재를 확인한다.

```rust
let background = windows_background_exe(exe);
if !background.is_file() {
    eprintln!(
        "toard-shim: Windows 무창 수집 실행 파일이 없습니다: {}",
        background.display()
    );
    return 1;
}
```

- [ ] **Step 5: GREEN 확인과 Rust 회귀 테스트**

Run:

```bash
cargo test --manifest-path shim/rust/Cargo.toml --bin toard-shim-background
cargo test --manifest-path shim/rust/Cargo.toml daemon::tests::windows_task
cargo test --manifest-path shim/rust/Cargo.toml
cargo clippy --manifest-path shim/rust/Cargo.toml --all-targets -- -D warnings
```

Expected: all PASS with no warnings.

- [ ] **Step 6: 커밋**

```bash
git add shim/rust/src/bin/toard-shim-background.rs shim/rust/src/daemon.rs
git commit -m "fix(shim): run Windows scheduled collection without a console"
```

---

### Task 2: PowerShell 설치·제거에 helper lifecycle 추가

**Files:**
- Modify: `apps/web/lib/powershell-installer.test.ts`
- Modify: `apps/web/lib/powershell-installer.ts:19-64,85-99,119-193`

**Interfaces:**
- Consumes: release asset `toard-shim-background-x86_64-pc-windows-msvc.exe`
- Produces: installed `%USERPROFILE%\.toard\bin\toard-shim-background.exe`
- Preserves: target upsert before daemon registration and last-target-only cleanup

- [ ] **Step 1: helper 다운로드·검증·제거 계약의 실패 테스트 작성**

Add to `powershell-installer.test.ts`:

```ts
test("PowerShell installer verifies both Windows executables before mutation", () => {
  const script = buildPowerShellInstallScript("https://toard.example/api", false);

  assert.match(script, /toard-shim-x86_64-pc-windows-msvc\.exe/);
  assert.match(script, /toard-shim-background-x86_64-pc-windows-msvc\.exe/);
  assert.match(script, /\$backgroundDownload/);
  assert.match(script, /\$backgroundExpected/);
  assert.match(script, /\$backgroundActual/);
  assert.match(script, /toard-shim-background\.exe/);

  const lastChecksum = Math.max(
    script.indexOf("shim checksum mismatch"),
    script.indexOf("background checksum mismatch"),
  );
  assert.ok(lastChecksum < script.indexOf("New-Item -ItemType Directory -Force -Path $binDir"));
  assert.ok(lastChecksum < script.indexOf("'target', 'upsert'"));
  assert.ok(lastChecksum < script.indexOf("'daemon', 'install'"));
});

test("PowerShell uninstaller removes the helper only after the last target", () => {
  const script = buildPowerShellUninstallScript("https://toard.example/api");
  const remainingGate = script.indexOf("$remaining -gt 0");
  const helperRemoval = script.indexOf("toard-shim-background.exe");

  assert.ok(remainingGate >= 0);
  assert.ok(helperRemoval > remainingGate);
  assert.match(script, /toard-shim-background\.exe\.old/);
});
```

- [ ] **Step 2: RED 확인**

Run:

```bash
corepack pnpm --filter @toard/web exec tsx --test lib/powershell-installer.test.ts
```

Expected: FAIL because the generated scripts contain only the main shim asset.

- [ ] **Step 3: 설치기에서 두 자산을 모두 검증한 뒤 배치**

Use these generated PowerShell variables:

```powershell
$asset = 'toard-shim-x86_64-pc-windows-msvc.exe'
$backgroundAsset = 'toard-shim-background-x86_64-pc-windows-msvc.exe'
$download = Join-Path $temp $asset
$backgroundDownload = Join-Path $temp $backgroundAsset
$background = Join-Path $binDir 'toard-shim-background.exe'
```

Download both before reading sums:

```powershell
Invoke-WebRequest -UseBasicParsing -Uri "$release/$asset" -OutFile $download
Invoke-WebRequest -UseBasicParsing -Uri "$release/$backgroundAsset" -OutFile $backgroundDownload
Invoke-WebRequest -UseBasicParsing -Uri "$release/SHA256SUMS" -OutFile $sums
```

Validate both exact asset lines before creating `$binDir`:

```powershell
$shimMatch = [regex]::Match($sumText, '(?im)^([a-f0-9]{64})\s+\*?toard-shim-x86_64-pc-windows-msvc\.exe\s*$')
$backgroundMatch = [regex]::Match($sumText, '(?im)^([a-f0-9]{64})\s+\*?toard-shim-background-x86_64-pc-windows-msvc\.exe\s*$')
if (-not $shimMatch.Success) { throw 'shim checksum entry missing' }
if (-not $backgroundMatch.Success) { throw 'background checksum entry missing' }
$expected = $shimMatch.Groups[1].Value.ToLowerInvariant()
$backgroundExpected = $backgroundMatch.Groups[1].Value.ToLowerInvariant()
$actual = (Get-FileHash -Algorithm SHA256 -Path $download).Hash.ToLowerInvariant()
$backgroundActual = (Get-FileHash -Algorithm SHA256 -Path $backgroundDownload).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw 'shim checksum mismatch' }
if ($backgroundActual -ne $backgroundExpected) { throw 'background checksum mismatch' }
```

After both validations, copy the helper alongside the existing aliases:

```powershell
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
foreach ($name in @('claude.exe', 'codex.exe', 'toard-shim.exe')) {
  Copy-Item -Force $download (Join-Path $binDir $name)
}
Copy-Item -Force $backgroundDownload $background
```

- [ ] **Step 4: 마지막 target cleanup에 helper 파일 추가**

The generated uninstaller cleanup list must be exactly extended with:

```powershell
'toard-shim-background.exe'
'toard-shim-background.exe.old'
```

Keep this list after the `$remaining -gt 0` early return and after successful `daemon uninstall`.

- [ ] **Step 5: GREEN 확인**

Run:

```bash
corepack pnpm --filter @toard/web exec tsx --test lib/powershell-installer.test.ts
corepack pnpm --filter @toard/web typecheck
```

Expected: all PASS.

- [ ] **Step 6: 커밋**

```bash
git add apps/web/lib/powershell-installer.ts apps/web/lib/powershell-installer.test.ts
git commit -m "fix(web): install Windows no-console collection helper"
```

---

### Task 3: Windows self-update에서 helper도 검증·교체

**Files:**
- Modify: `shim/rust/src/update.rs:40-44,135-197,204-242,244-269`

**Interfaces:**
- Consumes: `toard-shim-background-x86_64-pc-windows-msvc.exe` and `SHA256SUMS`
- Produces: sibling installed path `toard-shim-background.exe`
- Preserves: main shim rollback and alias synchronization

- [ ] **Step 1: 플랫폼별 release asset 집합의 실패 테스트 작성**

Add these tests against the wished-for pure asset naming function:

```rust
#[test]
fn windows_update_requires_main_and_background_assets() {
    assert_eq!(
        release_asset_names("x86_64-pc-windows-msvc", true),
        vec![
            "toard-shim-x86_64-pc-windows-msvc.exe".to_string(),
            "toard-shim-background-x86_64-pc-windows-msvc.exe".to_string(),
        ]
    );
}

#[test]
fn unix_update_keeps_the_single_asset_contract() {
    assert_eq!(
        release_asset_names("aarch64-apple-darwin", false),
        vec!["toard-shim-aarch64-apple-darwin".to_string()]
    );
}
```

Add a filesystem test for the installed helper destination:

```rust
#[test]
fn background_install_path_is_a_sibling_of_the_main_shim() {
    assert_eq!(
        background_install_path(std::path::Path::new(
            r"C:\Users\GA\.toard\bin\toard-shim.exe"
        )),
        std::path::PathBuf::from(
            r"C:\Users\GA\.toard\bin\toard-shim-background.exe"
        )
    );
}
```

- [ ] **Step 2: RED 확인**

Run:

```bash
cargo test --manifest-path shim/rust/Cargo.toml update::tests::windows_update_requires_main_and_background_assets
```

Expected: FAIL because Windows currently has one release asset.

- [ ] **Step 3: 다운로드와 검증을 교체보다 먼저 완료하도록 분리**

Introduce focused helpers with these implementations:

```rust
fn release_asset_names(target: &str, windows: bool) -> Vec<String> {
    let ext = if windows { ".exe" } else { "" };
    let mut assets = vec![format!("toard-shim-{target}{ext}")];
    if windows {
        assets.push(format!("toard-shim-background-{target}.exe"));
    }
    assets
}

fn fetch_sums(base: &str) -> Result<String, String> {
    let output = Command::new("curl")
        .args(["-fsSL", "--max-time", "30", &format!("{base}/SHA256SUMS")])
        .output()
        .map_err(|error| format!("curl 실행 불가: {error}"))?;
    if !output.status.success() {
        return Err("SHA256SUMS 다운로드 실패".into());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn download_asset(
    base: &str,
    asset: &str,
    dir: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    let path = dir.join(format!(".{asset}.update-{}", std::process::id()));
    let status = Command::new("curl")
        .args(["-fsSL", "--max-time", "120", "-o"])
        .arg(&path)
        .arg(format!("{base}/{asset}"))
        .status()
        .map_err(|error| format!("curl 실행 불가: {error}"))?;
    if !status.success() {
        let _ = std::fs::remove_file(&path);
        return Err(format!("바이너리 다운로드 실패: {base}/{asset}"));
    }
    Ok(path)
}

fn verify_asset(path: &std::path::Path, asset: &str, sums: &str) -> Result<(), String> {
    let expected = parse_sha_entry(sums, asset)
        .ok_or_else(|| format!("SHA256SUMS 에 {asset} 항목 없음"))?;
    let actual = sha256_file(path)?;
    if expected != actual {
        return Err(format!(
            "체크섬 불일치 — 교체 중단 (asset={asset} expected={expected} got={actual})"
        ));
    }
    Ok(())
}

fn background_install_path(main: &std::path::Path) -> std::path::PathBuf {
    main.with_file_name("toard-shim-background.exe")
}

fn cleanup_downloads(downloads: &[(String, std::path::PathBuf)]) {
    for (_, path) in downloads {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(windows)]
fn replace_windows_file(
    tmp: &std::path::Path,
    destination: &std::path::Path,
) -> Result<(), String> {
    let old = destination.with_extension("exe.old");
    let _ = std::fs::remove_file(&old);
    let moved_old = destination.is_file();
    if moved_old {
        std::fs::rename(destination, &old)
            .map_err(|error| format!("기존 helper 비켜두기 실패: {error}"))?;
    }
    std::fs::rename(tmp, destination).map_err(|error| {
        if moved_old {
            let _ = std::fs::rename(&old, destination);
        }
        format!("helper 교체 실패: {error}")
    })
}
```

`download_and_replace` must follow this ordering:

```rust
let assets = release_asset_names(TARGET, cfg!(windows));
let sums = fetch_sums(&base)?;
let mut downloads = Vec::with_capacity(assets.len());
for asset in &assets {
    let path = match download_asset(&base, asset, dir) {
        Ok(path) => path,
        Err(error) => {
            cleanup_downloads(&downloads);
            return Err(error);
        }
    };
    if let Err(error) = verify_asset(&path, asset, &sums) {
        let _ = std::fs::remove_file(&path);
        cleanup_downloads(&downloads);
        return Err(error);
    }
    downloads.push((asset.clone(), path));
}

#[cfg(windows)]
if let Some((_, helper_tmp)) = downloads.get(1) {
    if let Err(error) = replace_windows_file(helper_tmp, &background_install_path(&exe)) {
        cleanup_downloads(&downloads);
        return Err(error);
    }
}
if let Err(error) = replace_exe(&downloads[0].1, &exe) {
    cleanup_downloads(&downloads);
    return Err(error);
}
#[cfg(windows)]
sync_sibling_copies(&exe);
```

`fetch_sums` downloads `SHA256SUMS` once and returns decoded text. Every error path removes all `downloads` paths accumulated so far. `replace_windows_file` uses the existing `.exe.old` rename and rollback pattern without treating a missing destination as an error.

- [ ] **Step 4: checksum 오류와 Unix 단일 자산 회귀 테스트 추가**

Extend the existing `parses_sha_entry` test so both Windows asset lines are independently selected:

```rust
#[test]
fn parses_both_windows_sha_entries_exactly() {
    let sums = concat!(
        "aaa  toard-shim-x86_64-pc-windows-msvc.exe\n",
        "bbb  toard-shim-background-x86_64-pc-windows-msvc.exe\n",
    );
    assert_eq!(
        parse_sha_entry(sums, "toard-shim-x86_64-pc-windows-msvc.exe").as_deref(),
        Some("aaa")
    );
    assert_eq!(
        parse_sha_entry(
            sums,
            "toard-shim-background-x86_64-pc-windows-msvc.exe"
        )
        .as_deref(),
        Some("bbb")
    );
}
```

- [ ] **Step 5: GREEN 확인**

Run:

```bash
cargo test --manifest-path shim/rust/Cargo.toml update::tests
cargo test --manifest-path shim/rust/Cargo.toml
cargo clippy --manifest-path shim/rust/Cargo.toml --all-targets -- -D warnings
```

Expected: all PASS with no warnings.

- [ ] **Step 6: 커밋**

```bash
git add shim/rust/src/update.rs
git commit -m "fix(shim): update Windows background helper with the shim"
```

---

### Task 4: Windows installer E2E와 PE subsystem 검증

**Files:**
- Modify: `.github/scripts/test-shim-installer-windows.ps1`
- Modify: `.github/workflows/shim-ci.yml:78-115`
- Modify: `apps/web/lib/ui-commonization.test.ts:202-216`

**Interfaces:**
- Consumes: `shim.exe` and `toard-shim-background.exe` built by Cargo
- Verifies: installed helper, private ACL, Task Scheduler XML action, manual task completion, last-target cleanup
- Verifies: PE subsystem main=3 and helper=2

- [ ] **Step 1: workflow 정적 계약의 실패 테스트 작성**

Add to `ui-commonization.test.ts`:

```ts
test("Windows shim CI verifies GUI helper subsystem and scheduled action", () => {
  const workflow = repoSource(".github/workflows/shim-ci.yml");
  const e2e = repoSource(".github/scripts/test-shim-installer-windows.ps1");

  assert.match(workflow, /toard-shim-background\.exe/);
  assert.match(workflow, /Get-PeSubsystem/);
  assert.match(workflow, /expected Windows GUI subsystem 2/);
  assert.match(e2e, /BackgroundBinary/);
  assert.match(e2e, /toard-shim-background\.exe/);
  assert.match(e2e, /\/Query.*\/XML/s);
  assert.match(e2e, /Start-ScheduledTask/);
});
```

- [ ] **Step 2: RED 확인**

Run:

```bash
corepack pnpm --filter @toard/web exec tsx --test lib/ui-commonization.test.ts
```

Expected: FAIL because CI/E2E do not know the helper.

- [ ] **Step 3: Windows E2E가 helper release mirror와 lifecycle을 검사하도록 변경**

Extend the parameter block:

```powershell
param(
  [Parameter(Mandatory = $true)]
  [string]$Binary,
  [Parameter(Mandatory = $true)]
  [string]$BackgroundBinary
)
```

Copy and checksum both assets:

```powershell
$asset = 'toard-shim-x86_64-pc-windows-msvc.exe'
$backgroundAsset = 'toard-shim-background-x86_64-pc-windows-msvc.exe'
Copy-Item -Force $Binary (Join-Path $releaseDir $asset)
Copy-Item -Force $BackgroundBinary (Join-Path $releaseDir $backgroundAsset)
$hash = (Get-FileHash -Algorithm SHA256 (Join-Path $releaseDir $asset)).Hash.ToLowerInvariant()
$backgroundHash = (Get-FileHash -Algorithm SHA256 (Join-Path $releaseDir $backgroundAsset)).Hash.ToLowerInvariant()
[IO.File]::WriteAllLines((Join-Path $releaseDir 'SHA256SUMS'), @(
  "$hash  $asset",
  "$backgroundHash  $backgroundAsset"
))
```

After install, add `toard-shim-background.exe` to installed-file and ACL checks. Query exact task XML and require the helper action:

```powershell
$taskXml = schtasks.exe /Query /TN toard-collect /XML | Out-String
if ($LASTEXITCODE -ne 0) { throw 'scheduled task was not registered' }
if ($taskXml -notmatch [regex]::Escape((Join-Path $binDir 'toard-shim-background.exe'))) {
  throw 'scheduled task does not use the no-console helper'
}
if ($taskXml -match '<Arguments>collect --quiet</Arguments>') {
  throw 'scheduled task still invokes the console shim directly'
}
Start-ScheduledTask -TaskName 'toard-collect'
for ($i = 0; $i -lt 100; $i++) {
  $state = (Get-ScheduledTask -TaskName 'toard-collect').State
  if ($state -ne 'Running') { break }
  Start-Sleep -Milliseconds 100
}
$taskInfo = Get-ScheduledTaskInfo -TaskName 'toard-collect'
if ($taskInfo.LastTaskResult -ne 0) {
  throw "scheduled helper failed with result $($taskInfo.LastTaskResult)"
}
```

After non-last uninstall assert helper remains; after last uninstall assert it is removed.

- [ ] **Step 4: CI에서 PE subsystem을 직접 검사**

After the Windows release build, add this PowerShell step to `shim-ci.yml`:

```yaml
      - name: verify Windows PE subsystems
        shell: pwsh
        run: |
          function Get-PeSubsystem([string]$Path) {
            $bytes = [IO.File]::ReadAllBytes($Path)
            $peOffset = [BitConverter]::ToInt32($bytes, 0x3c)
            return [BitConverter]::ToUInt16($bytes, $peOffset + 4 + 20 + 68)
          }
          $main = Get-PeSubsystem 'shim/rust/target/release/shim.exe'
          $background = Get-PeSubsystem 'shim/rust/target/release/toard-shim-background.exe'
          if ($main -ne 3) { throw "expected Windows CUI subsystem 3, got $main" }
          if ($background -ne 2) { throw "expected Windows GUI subsystem 2, got $background" }
```

Pass both binaries to the E2E:

```yaml
      - name: installer E2E (Windows)
        shell: pwsh
        run: >-
          .github/scripts/test-shim-installer-windows.ps1
          -Binary shim/rust/target/release/shim.exe
          -BackgroundBinary shim/rust/target/release/toard-shim-background.exe
```

- [ ] **Step 5: GREEN 확인 가능한 로컬 테스트 실행**

Run:

```bash
corepack pnpm --filter @toard/web exec tsx --test lib/ui-commonization.test.ts
corepack pnpm --filter @toard/web exec tsx --test lib/powershell-installer.test.ts
cargo test --manifest-path shim/rust/Cargo.toml
```

Expected: all local tests PASS. PE와 예약 작업 실행은 `windows-latest` CI에서 PASS해야 한다.

- [ ] **Step 6: 커밋**

```bash
git add .github/scripts/test-shim-installer-windows.ps1 .github/workflows/shim-ci.yml apps/web/lib/ui-commonization.test.ts
git commit -m "test(shim): verify Windows no-console scheduled lifecycle"
```

---

### Task 5: Windows helper 릴리스 자산 게시와 전체 회귀 검증

**Files:**
- Modify: `.github/workflows/shim-release.yml:30-52`
- Modify: `apps/web/lib/ui-commonization.test.ts`

**Interfaces:**
- Produces: `toard-shim-background-x86_64-pc-windows-msvc.exe`
- Preserves: five existing main shim assets and shared `SHA256SUMS`

- [ ] **Step 1: 릴리스 자산 정적 계약의 실패 테스트 작성**

Add to `ui-commonization.test.ts`:

```ts
test("shim release publishes the Windows no-console helper", () => {
  const workflow = repoSource(".github/workflows/shim-release.yml");

  assert.match(workflow, /toard-shim-background-x86_64-pc-windows-msvc\.exe/);
  assert.match(workflow, /target\/\$t\/release\/toard-shim-background\.exe/);
  assert.match(workflow, /sha256sum toard-shim-\*/);
});
```

- [ ] **Step 2: RED 확인**

Run:

```bash
corepack pnpm --filter @toard/web exec tsx --test lib/ui-commonization.test.ts
```

Expected: FAIL because release workflow copies only `shim.exe`.

- [ ] **Step 3: Windows matrix 항목에서 helper 자산도 dist에 복사**

Extend the Windows branch in `.github/workflows/shim-release.yml`:

```bash
if [ -f "target/$t/release/shim.exe" ]; then
  cp "target/$t/release/shim.exe" "../../dist/toard-shim-$t.exe"
  cp "target/$t/release/toard-shim-background.exe" \
    "../../dist/toard-shim-background-$t.exe"
else
  cp "target/$t/release/shim" "../../dist/toard-shim-$t"
fi
```

The existing upload glob `dist/toard-shim-*`, checksum command, and `gh release create` glob include the new asset without further broadening.

- [ ] **Step 4: 전체 로컬 검증**

If dependencies are absent, first run:

```bash
corepack pnpm install --frozen-lockfile
```

Then run:

```bash
cargo fmt --manifest-path shim/rust/Cargo.toml --check
cargo clippy --manifest-path shim/rust/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path shim/rust/Cargo.toml
cargo build --manifest-path shim/rust/Cargo.toml --release
corepack pnpm --filter @toard/web exec tsx --test lib/powershell-installer.test.ts lib/ui-commonization.test.ts
corepack pnpm --filter @toard/web typecheck
git diff --check
```

Expected: all commands PASS with no warnings or whitespace errors.

- [ ] **Step 5: Windows CI 확인**

Push/PR 후 다음 job이 모두 PASS해야 한다.

```text
shim-ci / check
shim-ci / check-windows
shim-ci / check-macos
shim-ci / scripts
```

`check-windows`에서 특히 다음 로그를 확인한다.

```text
verify Windows PE subsystems: main=3, background=2
installer E2E (Windows): scheduled helper LastTaskResult=0
```

- [ ] **Step 6: 커밋**

```bash
git add .github/workflows/shim-release.yml apps/web/lib/ui-commonization.test.ts
git commit -m "build(shim): publish Windows background helper"
```

---

## Final Verification Checklist

- [ ] `toard-shim.exe` remains a console executable and all manual CLI output works.
- [ ] `toard-shim-background.exe` is a GUI executable and passes child exit codes.
- [ ] `toard-collect` action points only to the helper and retains `PT5M`/`InteractiveToken`/`LeastPrivilege`.
- [ ] Both release assets are checksum-verified before installer mutation.
- [ ] Re-running `install.ps1` preserves pre-existing target directories and cursors.
- [ ] Non-last target removal retains helper/task; last removal deletes both.
- [ ] Future Windows self-updates verify and replace both binaries.
- [ ] Windows CI passes PE, scheduled execution, installer, uninstall, Rust, and PowerShell checks.
- [ ] macOS and Linux tests/builds remain green.

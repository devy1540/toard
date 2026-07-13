# Windows Task Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Windows에서도 현재 사용자 권한으로 5분 주기 toard 수집 작업을 자동 등록·조회·제거한다.

**Architecture:** 기존 `daemon` 모듈에 Windows Task Scheduler 어댑터를 추가한다. 등록·제거는 UAC 승인을 받은 Windows PowerShell `ScheduledTasks` 모듈로 처리하고, 권한 상승 전에 읽은 현재 사용자 SID를 `InteractiveToken` Principal에 고정한다. 작업 XML 생성과 `/Query /XML` 결과 파싱은 순수 함수로 만들어 macOS에서도 회귀 테스트할 수 있게 한다. PowerShell 설치·제거 스크립트는 shim CLI를 호출해 예약 작업 수명주기를 연결한다.

**Tech Stack:** Rust 표준 라이브러리, Windows PowerShell `ScheduledTasks`, `schtasks.exe`, TypeScript, Node test runner, PowerShell 생성기

## Global Constraints

- 예약 작업 이름은 `toard-collect`로 고정한다.
- 토큰은 예약 작업 명령에 포함하지 않는다.
- 설치·제거 시 UAC 승인을 요청하되 비밀번호나 토큰을 작업 정의에 저장하지 않는다.
- 작업 실행 Principal은 권한 상승 전 현재 사용자 SID, `InteractiveToken`, `LeastPrivilege`로 고정한다.
- Windows 외 launchd와 systemd/cron 동작을 변경하지 않는다.
- 설치·제거는 멱등이어야 한다.

---

### Task 1: Rust Windows Task Scheduler 어댑터

**Files:**
- Modify: `shim/rust/src/daemon.rs`
- Test: `shim/rust/src/daemon.rs`

**Interfaces:**
- Consumes: 기존 `State`, `install(interval)`, `uninstall()`, `status()` 계약
- Produces: `windows_registration_script(exe: &str, user_sid: &str, interval: u64) -> String`, `windows_state_from_xml(xml: Option<&str>) -> State`

- [ ] **Step 1: 작업 생성 인자와 XML 상태 파싱 실패 테스트 작성**

```rust
#[test]
fn windows_task_uses_current_user_limited_five_minute_schedule() {
    let script = windows_registration_script(
        r#"C:\Users\GA\.toard\bin\toard-shim.exe"#,
        "S-1-5-21-1234-5678-9012-1001",
        300,
    );
    assert!(script.contains("<Interval>PT5M</Interval>"));
    assert!(script.contains("<LogonType>InteractiveToken</LogonType>"));
    assert!(script.contains("<RunLevel>LeastPrivilege</RunLevel>"));
}

#[test]
fn windows_task_xml_maps_interval_and_enabled_state() {
    let active = windows_state_from_xml(Some(
        "<Task><Settings><Enabled>true</Enabled></Settings><Triggers><TimeTrigger><Repetition><Interval>PT5M</Interval></Repetition></TimeTrigger></Triggers></Task>",
    ));
    assert!(matches!(active, State::Installed { backend: "Windows Task Scheduler", interval: Some(300), active: true }));
    let disabled = windows_state_from_xml(Some("<Task><Settings><Enabled>false</Enabled></Settings></Task>"));
    assert!(matches!(disabled, State::Installed { active: false, .. }));
    assert!(matches!(windows_state_from_xml(None), State::NotInstalled));
}
```

- [ ] **Step 2: 테스트가 필요한 함수 부재로 실패하는지 확인**

Run: `cargo test --manifest-path shim/rust/Cargo.toml daemon::tests::windows_task`

Expected: FAIL with `cannot find function windows_registration_script` and `windows_state_from_xml`.

- [ ] **Step 3: Windows 생성·조회·삭제 구현**

```rust
const WINDOWS_TASK_NAME: &str = "toard-collect";

fn windows_registration_script(exe: &str, user_sid: &str, interval: u64) -> String {
    // Task XML: PTnM, InteractiveToken, LeastPrivilege, collect --quiet
}

fn windows_state_from_xml(xml: Option<&str>) -> State {
    let Some(xml) = xml else { return State::NotInstalled };
    let active = !xml.contains("<Enabled>false</Enabled>");
    let interval = xml.split("<Interval>PT").nth(1)
        .and_then(|s| s.split('M').next())
        .and_then(|m| m.parse::<u64>().ok())
        .map(|m| m * 60);
    State::Installed { backend: "Windows Task Scheduler", interval, active }
}
```

`state_for_os("windows")`는 `schtasks /Query /TN toard-collect /XML` 결과를 파서에 전달한다. `install()`은 현재 사용자 SID를 읽고 UTF-16LE Base64 `EncodedCommand`를 `Start-Process -Verb RunAs`로 실행해 등록한다. `uninstall()`도 같은 방식으로 `Unregister-ScheduledTask`를 실행한다. 조회 결과가 없거나 삭제 대상이 없으면 미등록·성공으로 처리한다.

- [ ] **Step 4: 관련 테스트와 전체 Rust 검증**

Run: `cargo fmt --manifest-path shim/rust/Cargo.toml && cargo test --manifest-path shim/rust/Cargo.toml daemon::tests && cargo clippy --manifest-path shim/rust/Cargo.toml --all-targets -- -D warnings`

Expected: daemon tests PASS, clippy warnings 0.

- [ ] **Step 5: Rust 어댑터 커밋**

```bash
git add shim/rust/src/daemon.rs
git commit -m "feat(shim): Windows 주기 수집 작업 등록"
```

### Task 2: PowerShell 설치·제거 연결

**Files:**
- Modify: `apps/web/lib/powershell-installer.test.ts`
- Modify: `apps/web/lib/powershell-installer.ts`

**Interfaces:**
- Consumes: `toard-shim.exe daemon install|uninstall`
- Produces: 설치 시 예약 작업 자동 등록, 제거 시 예약 작업 선행 삭제

- [ ] **Step 1: 설치·제거 연결 실패 테스트 작성**

```ts
test("installer registers Windows periodic collection before doctor", () => {
  const script = buildPowerShellInstallScript("https://toard.example/api", false);
  assert.match(script, /'daemon' 'install'/);
  assert.match(script, /\$daemonExit = \$LASTEXITCODE/);
  assert.match(script, /if \(\$daemonExit -ne 0\) \{ throw/);
  assert.ok(script.indexOf("'daemon' 'install'") < script.indexOf("'doctor'"));
});

test("uninstaller removes the scheduled task before binaries", () => {
  const script = buildPowerShellUninstallScript();
  assert.match(script, /'daemon' 'uninstall'/);
  assert.ok(script.indexOf("'daemon' 'uninstall'") < script.indexOf("Remove-Item -Force"));
});
```

- [ ] **Step 2: 테스트가 daemon 호출 부재로 실패하는지 확인**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/powershell-installer.test.ts`

Expected: 두 신규 테스트 FAIL.

- [ ] **Step 3: 설치·제거 스크립트에 shim CLI 호출 추가**

```powershell
& (Join-Path $binDir 'toard-shim.exe') 'daemon' 'install'
$daemonExit = $LASTEXITCODE
if ($daemonExit -ne 0) { throw 'toard periodic collection registration failed.' }
```

제거 스크립트는 바이너리 삭제 전에 다음을 실행한다.

```powershell
if (Test-Path $shim) { & $shim 'daemon' 'uninstall' 2>$null }
```

- [ ] **Step 4: PowerShell 생성기 테스트와 타입 검사**

Run: `pnpm --filter @toard/web exec node --import tsx --test lib/powershell-installer.test.ts && pnpm --filter @toard/web typecheck`

Expected: installer tests PASS, typecheck exit 0.

- [ ] **Step 5: 설치기 연결 커밋**

```bash
git add apps/web/lib/powershell-installer.test.ts apps/web/lib/powershell-installer.ts
git commit -m "feat(onboarding): Windows 주기 수집 자동 등록"
```

### Task 3: 전체 회귀 검증

**Files:**
- Verify only

**Interfaces:**
- Consumes: Task 1과 Task 2의 최종 결과
- Produces: PR에 올릴 수 있는 검증 증거

- [ ] **Step 1: Rust 전체 검증**

Run: `cargo fmt --manifest-path shim/rust/Cargo.toml -- --check && cargo test --manifest-path shim/rust/Cargo.toml && cargo clippy --manifest-path shim/rust/Cargo.toml --all-targets -- -D warnings`

Expected: tests failure 0, clippy warnings 0.

- [ ] **Step 2: 웹 전체 검증**

Run: `pnpm --filter @toard/web test && pnpm --filter @toard/web typecheck`

Expected: tests failure 0, typecheck exit 0.

- [ ] **Step 3: 변경 무결성 확인**

Run: `git diff --check && git status -sb`

Expected: whitespace error 0, 의도한 커밋 외 변경 0.

- [ ] **Step 4: Windows CI 성공기준 확인**

PR 게시 후 `shim-ci / check-windows`에서 생성 PowerShell 파싱, Rust clippy·test·release build가 모두 성공해야 한다.

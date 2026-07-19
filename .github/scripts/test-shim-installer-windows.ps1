param(
  [Parameter(Mandatory = $true)]
  [string]$Binary,
  [Parameter(Mandatory = $true)]
  [string]$BackgroundBinary
)

$ErrorActionPreference = 'Stop'
$work = Join-Path $env:RUNNER_TEMP ("toard-shim-e2e-" + [guid]::NewGuid())
$homeDir = Join-Path $work 'home'
$releaseDir = Join-Path $work 'release'
$portFile = Join-Path $work 'port'
$installer = Join-Path $work 'install.ps1'
$uninstallPersonal = Join-Path $work 'uninstall-personal.ps1'
$uninstallCompany = Join-Path $work 'uninstall-company.ps1'
$server = $null
$originalUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$scheduledToardDir = Join-Path $env:USERPROFILE '.toard'
$scheduledHomeLinkCreated = $false

New-Item -ItemType Directory -Force -Path $homeDir, $releaseDir | Out-Null
try {
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

  $node = (Get-Command node).Source
  $server = Start-Process -FilePath $node -ArgumentList @(
    (Join-Path $PWD '.github/scripts/shim-e2e-server.mjs'),
    $releaseDir,
    $portFile
  ) -NoNewWindow -PassThru
  for ($i = 0; $i -lt 100 -and -not (Test-Path $portFile); $i++) {
    Start-Sleep -Milliseconds 100
  }
  if (-not (Test-Path $portFile)) { throw 'E2E server did not start' }
  $baseUrl = 'http://127.0.0.1:' + [IO.File]::ReadAllText($portFile).Trim()
  $companyEndpoint = "$baseUrl/company/api"
  $personalEndpoint = "$baseUrl/personal/api"

  # 구버전 회사 설치를 만든 뒤 신버전 개인 installer가 자동 migration하는 흐름을 검증한다.
  $legacyToardDir = Join-Path $homeDir '.toard'
  $legacyCursorDir = Join-Path $legacyToardDir 'state/cursors'
  New-Item -ItemType Directory -Force -Path $legacyCursorDir | Out-Null
  [IO.File]::WriteAllLines((Join-Path $legacyToardDir 'credentials'), @(
    'agent_key=tk_company',
    "endpoint=$companyEndpoint",
    'collect_content=server_v1',
    'collect_content_since=all',
    'collect_tools=true'
  ))
  [IO.File]::WriteAllText(
    (Join-Path $legacyCursorDir 'codex.json'),
    '{"files":{"C:/legacy/already-sent.jsonl":{"mtime_ms":1,"size":2,"sent":3,"sent_hash":"legacy"}},"reconciliation_version":0}'
  )
  [IO.File]::WriteAllText((Join-Path $legacyToardDir 'state/content-since'), "123`n")
  [IO.File]::WriteAllText((Join-Path $legacyToardDir 'state/tool-since'), "456`n")

  $env:TOARD_E2E_INSTALLER = $installer
  $env:TOARD_E2E_UNINSTALL_PERSONAL = $uninstallPersonal
  $env:TOARD_E2E_UNINSTALL_COMPANY = $uninstallCompany
  $env:TOARD_E2E_PERSONAL_ENDPOINT = $personalEndpoint
  $env:TOARD_E2E_COMPANY_ENDPOINT = $companyEndpoint
  pnpm --filter @toard/web exec tsx -e "import { writeFileSync } from 'node:fs'; import { buildPowerShellInstallScript, buildPowerShellUninstallScript } from './lib/powershell-installer.ts'; writeFileSync(process.env.TOARD_E2E_INSTALLER, buildPowerShellInstallScript(process.env.TOARD_E2E_PERSONAL_ENDPOINT, false)); writeFileSync(process.env.TOARD_E2E_UNINSTALL_PERSONAL, buildPowerShellUninstallScript(process.env.TOARD_E2E_PERSONAL_ENDPOINT)); writeFileSync(process.env.TOARD_E2E_UNINSTALL_COMPANY, buildPowerShellUninstallScript(process.env.TOARD_E2E_COMPANY_ENDPOINT));"
  if ($LASTEXITCODE -ne 0) { throw 'PowerShell installer generation failed' }

  $env:USERPROFILE = $homeDir
  $env:HOME = $homeDir
  $env:TOARD_SHIM_RELEASE_BASE = "$baseUrl/release"
  $env:TOARD_INGEST_ENDPOINT = $personalEndpoint
  $env:TOARD_INGEST_TOKEN = 'tk_personal'
  $env:TOARD_SHIM_COLLECT_CONTENT = '1'
  & $installer

  $binDir = Join-Path $homeDir '.toard/bin'
  $toardDir = Join-Path $homeDir '.toard'
  if (Test-Path $scheduledToardDir) {
    throw "scheduled-task profile already contains toard state: $scheduledToardDir"
  }
  # Task Scheduler creates a fresh user environment instead of inheriting this
  # process's test-only USERPROFILE. Point that profile at the isolated E2E state.
  New-Item -ItemType Junction -Path $scheduledToardDir -Target $toardDir | Out-Null
  $scheduledHomeLinkCreated = $true
  if (Test-Path (Join-Path $toardDir 'credentials')) { throw 'legacy credentials must be migrated' }
  $targetDirs = @(Get-ChildItem -Directory (Join-Path $toardDir 'targets'))
  if ($targetDirs.Count -ne 2) { throw "expected two target directories, got $($targetDirs.Count)" }
  $companyTarget = $targetDirs | Where-Object { [IO.File]::ReadAllText((Join-Path $_.FullName 'credentials')) -match [regex]::Escape("endpoint=$companyEndpoint") }
  $personalTarget = $targetDirs | Where-Object { [IO.File]::ReadAllText((Join-Path $_.FullName 'credentials')) -match [regex]::Escape("endpoint=$personalEndpoint") }
  if (-not $companyTarget -or -not $personalTarget) { throw 'company/personal target migration failed' }
  $personalCredentialsPath = Join-Path $personalTarget.FullName 'credentials'
  $personalCredentials = [IO.File]::ReadAllLines($personalCredentialsPath)
  foreach ($line in @('agent_key=tk_personal', "endpoint=$personalEndpoint", 'collect_content=server_v1', 'collect_tools=true')) {
    if ($personalCredentials -notcontains $line) { throw "missing personal target credential line: $line" }
  }
  $companyCursor = [IO.File]::ReadAllText((Join-Path $companyTarget.FullName 'state/cursors/codex.json'))
  if ($companyCursor -notmatch '"sent":3') { throw 'legacy company cursor was not preserved' }
  if ([IO.File]::ReadAllText((Join-Path $companyTarget.FullName 'state/content-since')).Trim() -ne '123') { throw 'legacy content-since was not preserved' }
  if ([IO.File]::ReadAllText((Join-Path $companyTarget.FullName 'state/tool-since')).Trim() -ne '456') { throw 'legacy tool-since was not preserved' }
  $list = & (Join-Path $binDir 'toard-shim.exe') targets list | Out-String
  foreach ($endpoint in @($companyEndpoint, $personalEndpoint)) {
    if ($list -notmatch [regex]::Escape($endpoint)) { throw "target list endpoint missing: $endpoint" }
  }
  if ($list -match 'tk_company|tk_personal') { throw 'target list exposed token' }

  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $background = Join-Path $binDir 'toard-shim-background.exe'
  $aclPaths = @($toardDir, (Join-Path $toardDir 'targets'), $background)
  foreach ($targetDir in $targetDirs) {
    $aclPaths += $targetDir.FullName
    $aclPaths += (Join-Path $targetDir.FullName 'credentials')
    $aclPaths += (Join-Path $targetDir.FullName 'state')
  }
  foreach ($path in $aclPaths) {
    $acl = Get-Acl -LiteralPath $path
    if (-not $acl.AreAccessRulesProtected) { throw "ACL inheritance remains enabled: $path" }
    $allowed = @($acl.Access | Where-Object { $_.AccessControlType -eq 'Allow' })
    if ($allowed.Count -eq 0) { throw "ACL has no allow rule: $path" }
    foreach ($rule in $allowed) {
      $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
      if ($sid -ne $currentSid) { throw "ACL allows another principal on ${path}: $sid" }
    }
  }
  foreach ($name in @('claude.exe', 'codex.exe', 'toard-shim.exe', 'toard-shim-background.exe')) {
    if (-not (Test-Path (Join-Path $binDir $name))) { throw "missing installed binary: $name" }
  }

  $taskXmlText = schtasks.exe /Query /TN toard-collect /XML | Out-String
  if ($LASTEXITCODE -ne 0) { throw 'scheduled task was not registered' }
  [xml]$taskXml = $taskXmlText
  if ([string]$taskXml.Task.Actions.Exec.Command -ne $background) {
    throw 'scheduled task does not use the no-console helper'
  }
  if (-not [string]::IsNullOrWhiteSpace([string]$taskXml.Task.Actions.Exec.Arguments)) {
    throw 'scheduled task helper action must not have arguments'
  }
  $taskRunBaseline = Get-ScheduledTaskInfo -TaskName 'toard-collect'
  Start-ScheduledTask -TaskName 'toard-collect'
  $taskCompleted = $false
  $stableTerminalSnapshots = 0
  $terminalLastRunTime = $null
  $terminalLastTaskResult = $null
  for ($i = 0; $i -lt 100; $i++) {
    $infoBefore = Get-ScheduledTaskInfo -TaskName 'toard-collect'
    $state = (Get-ScheduledTask -TaskName 'toard-collect').State
    $infoAfter = Get-ScheduledTaskInfo -TaskName 'toard-collect'
    $sameInfoSnapshot = -not (
      $infoBefore.LastRunTime -ne $infoAfter.LastRunTime -or
      $infoBefore.LastTaskResult -ne $infoAfter.LastTaskResult
    )
    $isTerminalSnapshot = (
      $sameInfoSnapshot -and
      $infoAfter.LastRunTime -gt $taskRunBaseline.LastRunTime -and
      $state -ne 'Running' -and
      $infoAfter.LastTaskResult -ne 0x41301
    )
    if ($isTerminalSnapshot) {
      if (
        $infoAfter.LastRunTime -eq $terminalLastRunTime -and
        $infoAfter.LastTaskResult -eq $terminalLastTaskResult
      ) {
        $stableTerminalSnapshots++
      } else {
        $stableTerminalSnapshots = 1
        $terminalLastRunTime = $infoAfter.LastRunTime
        $terminalLastTaskResult = $infoAfter.LastTaskResult
      }
      if ($stableTerminalSnapshots -ge 2) {
        $taskInfo = $infoAfter
        $taskCompleted = $true
        break
      }
    } else {
      $stableTerminalSnapshots = 0
      $terminalLastRunTime = $null
      $terminalLastTaskResult = $null
    }
    Start-Sleep -Milliseconds 100
  }
  if (-not $taskCompleted) {
    throw "scheduled helper did not reach a stable terminal snapshot within 10 seconds (state=$state, lastRunTime=$($infoAfter.LastRunTime), lastTaskResult=$($infoAfter.LastTaskResult))"
  }
  if ($taskInfo.LastTaskResult -ne 0) {
    throw "scheduled helper failed with result $($taskInfo.LastTaskResult)"
  }
  Remove-Item Env:TOARD_INGEST_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:TOARD_INGEST_ENDPOINT -ErrorAction SilentlyContinue
  & (Join-Path $binDir 'toard-shim.exe') doctor
  if ($LASTEXITCODE -ne 0) { throw 'persisted installation doctor failed' }

  & $uninstallPersonal
  $remainingTargets = @(Get-ChildItem -Directory (Join-Path $toardDir 'targets'))
  if ($remainingTargets.Count -ne 1) { throw 'personal removal did not preserve exactly one company target' }
  if ([IO.File]::ReadAllText((Join-Path $remainingTargets[0].FullName 'credentials')) -notmatch [regex]::Escape("endpoint=$companyEndpoint")) { throw 'company target was not preserved' }
  if (-not (Test-Path (Join-Path $binDir 'toard-shim.exe'))) { throw 'non-last target removal deleted shim' }
  if (-not (Test-Path $background)) { throw 'non-last target removal deleted background helper' }
  schtasks.exe /Query /TN toard-collect | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'non-last target removal deleted scheduled task' }

  & $uninstallCompany
  if (Test-Path (Join-Path $homeDir '.toard/targets')) { throw 'last target registry was not removed' }
  if (Test-Path (Join-Path $binDir 'toard-shim.exe')) { throw 'last target removal did not delete shim' }
  if (Test-Path $background) { throw 'last target removal did not delete background helper' }
  schtasks.exe /Query /TN toard-collect 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { throw 'scheduled task was not removed' }
} finally {
  [Environment]::SetEnvironmentVariable('Path', $originalUserPath, 'User')
  schtasks.exe /Delete /TN toard-collect /F 2>$null | Out-Null
  if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
  if ($scheduledHomeLinkCreated) { Remove-Item -Force -ErrorAction SilentlyContinue $scheduledToardDir }
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $work
}

# 위의 예약 작업 부재 확인과 멱등 정리는 정상적으로도 schtasks 종료코드 1을 남긴다.
# E2E 본문이 예외 없이 끝났다면 잡 자체는 성공으로 종료한다.
exit 0

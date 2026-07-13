param(
  [Parameter(Mandatory = $true)]
  [string]$Binary
)

$ErrorActionPreference = 'Stop'
$work = Join-Path $env:RUNNER_TEMP ("toard-shim-e2e-" + [guid]::NewGuid())
$homeDir = Join-Path $work 'home'
$releaseDir = Join-Path $work 'release'
$portFile = Join-Path $work 'port'
$installer = Join-Path $work 'install.ps1'
$uninstaller = Join-Path $work 'uninstall.ps1'
$server = $null
$originalUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')

New-Item -ItemType Directory -Force -Path $homeDir, $releaseDir | Out-Null
try {
  $asset = 'toard-shim-x86_64-pc-windows-msvc.exe'
  Copy-Item -Force $Binary (Join-Path $releaseDir $asset)
  $hash = (Get-FileHash -Algorithm SHA256 (Join-Path $releaseDir $asset)).Hash.ToLowerInvariant()
  [IO.File]::WriteAllText((Join-Path $releaseDir 'SHA256SUMS'), "$hash  $asset`n")

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

  $env:TOARD_E2E_INSTALLER = $installer
  $env:TOARD_E2E_UNINSTALLER = $uninstaller
  $env:TOARD_E2E_ENDPOINT = "$baseUrl/api"
  pnpm --filter @toard/web exec tsx -e "import { writeFileSync } from 'node:fs'; import { buildPowerShellInstallScript, buildPowerShellUninstallScript } from './lib/powershell-installer.ts'; writeFileSync(process.env.TOARD_E2E_INSTALLER, buildPowerShellInstallScript(process.env.TOARD_E2E_ENDPOINT, false)); writeFileSync(process.env.TOARD_E2E_UNINSTALLER, buildPowerShellUninstallScript());"
  if ($LASTEXITCODE -ne 0) { throw 'PowerShell installer generation failed' }

  $env:USERPROFILE = $homeDir
  $env:HOME = $homeDir
  $env:TOARD_SHIM_RELEASE_BASE = "$baseUrl/release"
  $env:TOARD_INGEST_ENDPOINT = "$baseUrl/api"
  $env:TOARD_INGEST_TOKEN = 'tk_e2e_test'
  $env:TOARD_SHIM_COLLECT_CONTENT = '1'
  & $installer

  $binDir = Join-Path $homeDir '.toard/bin'
  $credentials = [IO.File]::ReadAllLines((Join-Path $homeDir '.toard/credentials'))
  if ($credentials.Count -ne 3) { throw "expected 3 credential lines, got $($credentials.Count)" }
  if ($credentials[0] -ne 'agent_key=tk_e2e_test') { throw 'token credential line mismatch' }
  if ($credentials[1] -ne "endpoint=$baseUrl/api") { throw 'endpoint credential line mismatch' }
  if ($credentials[2] -ne 'collect_content=true') { throw 'content credential line mismatch' }
  foreach ($name in @('claude.exe', 'codex.exe', 'toard-shim.exe')) {
    if (-not (Test-Path (Join-Path $binDir $name))) { throw "missing installed binary: $name" }
  }

  schtasks.exe /Query /TN toard-collect | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'scheduled task was not registered' }
  Remove-Item Env:TOARD_INGEST_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:TOARD_INGEST_ENDPOINT -ErrorAction SilentlyContinue
  & (Join-Path $binDir 'toard-shim.exe') doctor
  if ($LASTEXITCODE -ne 0) { throw 'persisted installation doctor failed' }

  & $uninstaller
  if (Test-Path (Join-Path $homeDir '.toard/credentials')) { throw 'credentials were not removed' }
  schtasks.exe /Query /TN toard-collect 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { throw 'scheduled task was not removed' }
} finally {
  [Environment]::SetEnvironmentVariable('Path', $originalUserPath, 'User')
  schtasks.exe /Delete /TN toard-collect /F 2>$null | Out-Null
  if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $work
}

# 위의 예약 작업 부재 확인과 멱등 정리는 정상적으로도 schtasks 종료코드 1을 남긴다.
# E2E 본문이 예외 없이 끝났다면 잡 자체는 성공으로 종료한다.
exit 0

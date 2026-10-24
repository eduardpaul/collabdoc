<#
.SYNOPSIS
  Build, run and test the Flutter app on Windows.

.DESCRIPTION
  scripts\flutter-windows.ps1 [action] [file] [-Release]

    doctor    Check the tools (Flutter, Rust, Visual Studio C++, Developer Mode).
    run       Run the app (default). Pass a .collabdoc or .md to open it.
    test      Rust core/bridge/launcher tests, then the Flutter tests.
    build     Release build: flutter_app\build\windows\x64\runner\Release\.
    onefile   Release build packed into one executable:
              dist\collabdoc-windows-x86_64.exe (unpacks to %LOCALAPPDATA%
              on first run).

  The Windows build (flutter_app\windows\CMakeLists.txt) builds the Rust
  bridge with cargo and puts collabdoc_ffi.dll next to collabdoc.exe.
  Drafts, the journal and recents go to %APPDATA%\CollabDoc; set
  COLLABDOC_USER_DATA to use another folder.

.EXAMPLE
  scripts\flutter-windows.cmd doctor
  scripts\flutter-windows.cmd run notes.collabdoc
  scripts\flutter-windows.cmd onefile
#>
[CmdletBinding()]
param(
  [ValidateSet('doctor', 'run', 'test', 'build', 'onefile')]
  [string]$Action = 'run',
  [string]$File = '',
  [switch]$Release
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$App = Join-Path $Root 'flutter_app'
$Dist = Join-Path $Root 'dist'

function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }

# Runs a native command; stops the script if it fails.
function Invoke-Native {
  param([string]$Exe, [string[]]$Arguments, [string]$Where = $Root)
  Push-Location $Where
  try {
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Exe $($Arguments -join ' ') failed (exit $LASTEXITCODE)" }
  } finally {
    Pop-Location
  }
}

function Test-Tools {
  $ok = $true
  $missing = @{
    flutter = 'Flutter 3.47+: https://docs.flutter.dev/get-started/install/windows/desktop'
    cargo   = 'Rust: winget install Rustlang.Rustup  (then open a new terminal)'
  }
  foreach ($tool in $missing.Keys) {
    if (Get-Command $tool -ErrorAction SilentlyContinue) {
      Write-Host "  ok  $tool" -ForegroundColor Green
    } else {
      Write-Host "  --  $tool missing. $($missing[$tool])" -ForegroundColor Yellow
      $ok = $false
    }
  }
  if (Get-Command rustc -ErrorAction SilentlyContinue) {
    $hostLine = (& rustc -vV | Select-String '^host:').ToString()
    if ($hostLine -notmatch 'msvc') {
      Write-Host "  !!  Rust targets $hostLine; Flutter links with MSVC. Run: rustup default stable-x86_64-pc-windows-msvc" -ForegroundColor Yellow
      $ok = $false
    } else {
      Write-Host "  ok  Rust $hostLine" -ForegroundColor Green
    }
  }
  # Visual Studio (or Build Tools) with the C++ workload, which both Flutter
  # and Rust's MSVC target need.
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  $vs = if (Test-Path $vswhere) {
    & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  }
  if ($vs) {
    Write-Host "  ok  Visual Studio C++ tools: $vs" -ForegroundColor Green
  } else {
    Write-Host '  --  Visual Studio C++ tools missing. winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"' -ForegroundColor Yellow
    $ok = $false
  }
  # Flutter plugins (file dialogs, links) are linked with symlinks, which
  # Windows allows only in Developer Mode.
  $key = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock'
  $dev = (Get-ItemProperty -Path $key -Name AllowDevelopmentWithoutDevLicense -ErrorAction SilentlyContinue).AllowDevelopmentWithoutDevLicense
  if ($dev -eq 1) {
    Write-Host '  ok  Developer Mode (symlinks for plugins)' -ForegroundColor Green
  } else {
    Write-Host '  --  Developer Mode is off; Flutter plugins need it. Turn it on: start ms-settings:developers' -ForegroundColor Yellow
    $ok = $false
  }
  return $ok
}

switch ($Action) {
  'doctor' {
    Step 'Tools'
    $ok = Test-Tools
    Step 'flutter doctor'
    if (Get-Command flutter -ErrorAction SilentlyContinue) { & flutter doctor }
    if (-not $ok) { exit 1 }
  }

  'run' {
    if (-not (Test-Tools)) { throw 'Fix the tools above first (scripts\flutter-windows.cmd doctor).' }
    Step 'Packages'
    Invoke-Native flutter @('pub', 'get') $App
    Step 'Run (cargo builds the Rust core inside the Windows build)'
    $runArgs = @('run', '-d', 'windows')
    if ($Release) { $runArgs += '--release' }
    if ($File) { $runArgs += @('--dart-entrypoint-args', (Resolve-Path $File).Path) }
    Invoke-Native flutter $runArgs $App
  }

  'test' {
    if (-not (Test-Tools)) { throw 'Fix the tools above first (scripts\flutter-windows.cmd doctor).' }
    Step 'Rust tests (core, bridge, launcher)'
    Invoke-Native cargo @('test', '-p', 'collabdoc-core', '-p', 'collabdoc-ffi', '-p', 'collabdoc-launcher')
    Step 'Bridge for the Flutter tests'
    Invoke-Native cargo @('build', '-p', 'collabdoc-ffi')
    $env:COLLABDOC_FFI_LIB = Join-Path $Root 'target\debug\collabdoc_ffi.dll'
    Step 'Flutter tests'
    Invoke-Native flutter @('pub', 'get') $App
    Invoke-Native flutter @('test') $App
  }

  { $_ -in 'build', 'onefile' } {
    if (-not (Test-Tools)) { throw 'Fix the tools above first (scripts\flutter-windows.cmd doctor).' }
    Step 'Release build'
    $symbols = Join-Path $Dist 'symbols-windows'
    New-Item -ItemType Directory -Force -Path $symbols | Out-Null
    Invoke-Native flutter @('pub', 'get') $App
    Invoke-Native flutter @('build', 'windows', '--release', "--split-debug-info=$symbols", '--obfuscate') $App
    $bundle = Join-Path $App 'build\windows\x64\runner\Release'
    if (-not (Test-Path (Join-Path $bundle 'collabdoc_ffi.dll'))) {
      throw "collabdoc_ffi.dll is not next to collabdoc.exe in $bundle"
    }
    Write-Host "Folder build: $bundle"
    if ($Action -eq 'onefile') {
      Step 'One file'
      Invoke-Native cargo @('build', '--release', '-p', 'collabdoc-launcher')
      $out = Join-Path $Dist 'collabdoc-windows-x86_64.exe'
      $launcher = Join-Path $Root 'target\release\collabdoc-launcher.exe'
      Invoke-Native $launcher @($bundle, $out)
      Write-Host "One file: $out"
    }
  }
}

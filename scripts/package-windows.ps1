param(
  [switch]$IncludeData,
  [string]$DataRoot = "D:\OpenClawData",
  [string]$OutputDir = ".\dist",
  [string]$AppName = "OpenClawTraining",
  [int]$Port = 8787,
  [string]$NodePath = ""
)

$ErrorActionPreference = "Stop"

function Resolve-FullPath([string]$PathValue) {
  if ([System.IO.Path]::IsPathRooted($PathValue)) {
    return [System.IO.Path]::GetFullPath($PathValue)
  }
  return [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $PathValue))
}

function Copy-Directory([string]$Source, [string]$Destination, [string[]]$ExcludeDirs = @(), [string[]]$ExcludeFiles = @()) {
  if (!(Test-Path -LiteralPath $Source)) {
    return
  }
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
    if ($_.PSIsContainer) {
      if ($ExcludeDirs -contains $_.Name) { return }
      Copy-Directory -Source $_.FullName -Destination (Join-Path $Destination $_.Name) -ExcludeDirs $ExcludeDirs -ExcludeFiles $ExcludeFiles
    } else {
      if ($ExcludeFiles -contains $_.Name) { return }
      Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $Destination $_.Name) -Force
    }
  }
}

$repoRoot = Resolve-FullPath (Join-Path $PSScriptRoot "..")
$outputRoot = Resolve-FullPath $OutputDir
$stageRoot = Join-Path $outputRoot $AppName
$payloadRoot = Join-Path $outputRoot "installer-payload"
$zipPath = Join-Path $outputRoot "$AppName.zip"
$exePath = Join-Path $outputRoot "$AppName-Setup.exe"

if (!$NodePath) {
  $nodeCommand = Get-Command node -ErrorAction Stop
  $NodePath = $nodeCommand.Source
}
if (!(Test-Path -LiteralPath $NodePath)) {
  throw "node.exe not found: $NodePath"
}

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $payloadRoot -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $exePath -Force -ErrorAction SilentlyContinue

New-Item -ItemType Directory -Force -Path $stageRoot | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $stageRoot "runtime") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $stageRoot "data\training-index") | Out-Null

Copy-Item -LiteralPath $NodePath -Destination (Join-Path $stageRoot "runtime\node.exe") -Force
Copy-Directory -Source (Join-Path $repoRoot "training-service") -Destination (Join-Path $stageRoot "training-service") -ExcludeDirs @("data", ".tmp-smoke-data", "node_modules", "dist") -ExcludeFiles @("*.log")
Copy-Directory -Source (Join-Path $repoRoot "training-plugin") -Destination (Join-Path $stageRoot "training-plugin") -ExcludeDirs @("node_modules", "dist") -ExcludeFiles @("*.log")
Copy-Item -LiteralPath (Join-Path $repoRoot "README.md") -Destination (Join-Path $stageRoot "README.md") -Force
Copy-Item -LiteralPath (Join-Path $repoRoot "openclaw.training.example.json5") -Destination (Join-Path $stageRoot "openclaw.training.example.json5") -Force

if ($IncludeData) {
  $dataRootFull = Resolve-FullPath $DataRoot
  Copy-Directory -Source (Join-Path $dataRootFull "training-index") -Destination (Join-Path $stageRoot "data\training-index")
  Copy-Directory -Source (Join-Path $dataRootFull "training-clean") -Destination (Join-Path $stageRoot "data\training-clean")
  Copy-Directory -Source (Join-Path $dataRootFull "training-vision") -Destination (Join-Path $stageRoot "data\training-vision")
}

$startCmd = @"
@echo off
setlocal
set "APP_DIR=%~dp0"
set "PORT=$Port"
set "HOST=127.0.0.1"
set "TRAINING_DATA_DIR=%APP_DIR%data\training-index"
set "OPENCLAW_CHAT_TIMEOUT_MS=3000"

echo Starting OpenClaw Training...
echo.
echo Browser: http://127.0.0.1:%PORT%/
echo Data:    %TRAINING_DATA_DIR%
echo.
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:%PORT%/'"
"%APP_DIR%runtime\node.exe" "%APP_DIR%training-service\src\server.mjs"
pause
"@
Set-Content -Encoding ASCII -Path (Join-Path $stageRoot "start-training.cmd") -Value $startCmd

$portableReadme = @"
# OpenClaw Training Portable

Double click start-training.cmd to start the training service, then open:

http://127.0.0.1:$Port/

Data directory:

data\training-index

If no business data is included, demo data will be created on first run.
"@
Set-Content -Encoding UTF8 -Path (Join-Path $stageRoot "README-portable.md") -Value $portableReadme

Compress-Archive -LiteralPath $stageRoot -DestinationPath $zipPath -Force

$iexpress = Join-Path $env:WINDIR "System32\iexpress.exe"
$exeCreated = $false
if (Test-Path -LiteralPath $iexpress) {
  New-Item -ItemType Directory -Force -Path $payloadRoot | Out-Null
  Copy-Item -LiteralPath $zipPath -Destination (Join-Path $payloadRoot "$AppName.zip") -Force

  $installCmd = @"
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
"@
  Set-Content -Encoding ASCII -Path (Join-Path $payloadRoot "install.cmd") -Value $installCmd

  $installPs1 = @"
`$ErrorActionPreference = "Stop"
`$zip = Join-Path `$PSScriptRoot "$AppName.zip"
`$dest = Join-Path `$env:LOCALAPPDATA "$AppName"
if (Test-Path -LiteralPath `$dest) {
  Remove-Item -LiteralPath `$dest -Recurse -Force
}
New-Item -ItemType Directory -Force -Path `$dest | Out-Null
Expand-Archive -LiteralPath `$zip -DestinationPath `$env:LOCALAPPDATA -Force
`$appDir = Join-Path `$env:LOCALAPPDATA "$AppName"
`$shortcutPath = Join-Path ([Environment]::GetFolderPath("Desktop")) "OpenClaw Training.lnk"
`$shell = New-Object -ComObject WScript.Shell
`$shortcut = `$shell.CreateShortcut(`$shortcutPath)
`$shortcut.TargetPath = Join-Path `$appDir "start-training.cmd"
`$shortcut.WorkingDirectory = `$appDir
`$shortcut.Description = "OpenClaw Training"
`$shortcut.Save()
Start-Process -FilePath (Join-Path `$appDir "start-training.cmd") -WorkingDirectory `$appDir
"@
  Set-Content -Encoding UTF8 -Path (Join-Path $payloadRoot "install.ps1") -Value $installPs1

  $sedPath = Join-Path $outputRoot "$AppName.sed"
  $payloadEscaped = $payloadRoot.Replace("\", "\\")
  $exeEscaped = $exePath.Replace("\", "\\")
  $sed = @"
[Version]
Class=IEXPRESS
SEDVersion=3

[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=1
HideExtractAnimation=0
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=
DisplayLicense=
FinishMessage=OpenClaw Training has been installed.
TargetName=$exeEscaped
FriendlyName=OpenClaw Training Installer
AppLaunched=install.cmd
PostInstallCmd=<None>
AdminQuietInstCmd=
UserQuietInstCmd=
SourceFiles=SourceFiles

[Strings]
FILE0="$AppName.zip"
FILE1="install.cmd"
FILE2="install.ps1"

[SourceFiles]
SourceFiles0=$payloadEscaped

[SourceFiles0]
%FILE0%=
%FILE1%=
%FILE2%=
"@
  Set-Content -Encoding ASCII -Path $sedPath -Value $sed

  & $iexpress /N /Q $sedPath | Out-Null
  $exeCreated = Test-Path -LiteralPath $exePath
}

Write-Host "Portable ZIP: $zipPath"
if ($exeCreated) {
  Write-Host "Installer EXE: $exePath"
} else {
  Write-Host "Installer EXE: skipped, iexpress.exe not available"
}

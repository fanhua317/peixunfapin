param(
  [string]$Out = "",
  [int]$RetentionDays = -1,
  [int]$KeepLast = -1,
  [switch]$SkipVerify
)

$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot
New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot "logs") | Out-Null
$logPath = Join-Path $PSScriptRoot "logs\backup.log"

function Write-BackupLog {
  param([string]$Message)
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
}

function Import-EnvFile {
  param([string]$PathValue)
  if (!(Test-Path -LiteralPath $PathValue)) {
    return
  }
  Get-Content -LiteralPath $PathValue | ForEach-Object {
    $line = $_.Trim()
    if (!$line -or $line.StartsWith("#")) {
      return
    }
    $name, $value = $line -split "=", 2
    if ($name) {
      [Environment]::SetEnvironmentVariable($name.Trim(), ($value -join "=").Trim(), "Process")
    }
  }
}

function Use-EnvInteger {
  param(
    [string]$Name,
    [int]$Fallback
  )
  $value = [Environment]::GetEnvironmentVariable($Name, "Process")
  if ($null -eq $value -or $value.Trim() -eq "") {
    return $Fallback
  }
  return [int]$value
}

Write-BackupLog "=== JuzhouAgentTraining backup requested ==="
Import-EnvFile -PathValue (Join-Path $PSScriptRoot ".env")

if (!$env:TRAINING_DATA_DIR) { $env:TRAINING_DATA_DIR = Join-Path $PSScriptRoot "data\training-index" }
if (!$env:TRAINING_STORAGE) { $env:TRAINING_STORAGE = "sqlite" }
if (!$env:TRAINING_SQLITE_BUSY_TIMEOUT_MS) { $env:TRAINING_SQLITE_BUSY_TIMEOUT_MS = "5000" }
if (!$Out -and $env:TRAINING_BACKUP_OUT) { $Out = $env:TRAINING_BACKUP_OUT }
if ($RetentionDays -lt 0) { $RetentionDays = Use-EnvInteger -Name "TRAINING_BACKUP_RETENTION_DAYS" -Fallback 14 }
if ($KeepLast -lt 0) { $KeepLast = Use-EnvInteger -Name "TRAINING_BACKUP_KEEP_LAST" -Fallback 10 }

New-Item -ItemType Directory -Force -Path $env:TRAINING_DATA_DIR | Out-Null
Write-BackupLog "TRAINING_DATA_DIR=$env:TRAINING_DATA_DIR TRAINING_STORAGE=$env:TRAINING_STORAGE RetentionDays=$RetentionDays KeepLast=$KeepLast Out=$Out"

$serviceDir = Join-Path $PSScriptRoot "training-service"
if (!(Test-Path -LiteralPath (Join-Path $serviceDir "node_modules\better-sqlite3"))) {
  Write-BackupLog "Installing production dependencies"
  Push-Location $serviceDir
  try {
    npm ci --omit=dev *>> $logPath
    if ($LASTEXITCODE -ne 0) {
      Write-BackupLog "npm ci failed with code $LASTEXITCODE"
      exit $LASTEXITCODE
    }
  } finally {
    Pop-Location
  }
}

$node = Get-Command node -ErrorAction Stop
$backupScript = Join-Path $serviceDir "scripts\backup-data.mjs"
$backupArgs = @($backupScript, "--retention-days", "$RetentionDays", "--keep-last", "$KeepLast")
if ($Out) {
  $backupArgs += @("--out", $Out)
}

Write-BackupLog "Node=$($node.Source)"
Write-BackupLog "Running backup-data.mjs"
$backupOutput = & $node.Source @backupArgs 2>&1
$backupExit = $LASTEXITCODE
$backupLines = $backupOutput | ForEach-Object { $_.ToString() }
$backupLines | Add-Content -LiteralPath $logPath -Encoding UTF8
if ($backupExit -ne 0) {
  Write-BackupLog "backup-data.mjs failed with code $backupExit"
  exit $backupExit
}

try {
  $summary = ($backupLines -join "`n") | ConvertFrom-Json
} catch {
  Write-BackupLog "Could not parse backup summary JSON: $($_.Exception.Message)"
  exit 1
}

if (!$summary.backupPath) {
  Write-BackupLog "Backup summary did not include backupPath"
  exit 1
}

Write-BackupLog "Backup created: $($summary.backupPath)"
if ($summary.retention) {
  Write-BackupLog "Retention scanned=$($summary.retention.scanned) deleted=$($summary.retention.deleted.Count)"
}

if (!$SkipVerify) {
  Write-BackupLog "Verifying backup"
  $verifyScript = Join-Path $serviceDir "scripts\backup-verify.mjs"
  & $node.Source $verifyScript "--from" $summary.backupPath *>> $logPath
  $verifyExit = $LASTEXITCODE
  if ($verifyExit -ne 0) {
    Write-BackupLog "backup-verify.mjs failed with code $verifyExit"
    exit $verifyExit
  }
  Write-BackupLog "Backup verified"
}

Write-BackupLog "=== JuzhouAgentTraining backup finished ==="
exit 0

$ErrorActionPreference = "Continue"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
New-Item -ItemType Directory -Force -Path (Join-Path $root "logs") | Out-Null
$logPath = Join-Path $root "logs\watchdog.log"

function Write-WatchdogLog {
  param([string]$Message)
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
}

function Test-TrainingPort {
  return [bool](Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue)
}

function Test-TrainingHttp {
  try {
    $homeResponse = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8787/" -TimeoutSec 8
    if ([int]$homeResponse.StatusCode -ne 200) { return $false }
  } catch {
    return $false
  }

  try {
    $healthResponse = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8787/api/health" -TimeoutSec 8
    return ([int]$healthResponse.StatusCode -eq 200)
  } catch {
    if ($_.Exception.Response) {
      $statusCode = [int]$_.Exception.Response.StatusCode
      return ($statusCode -eq 401)
    }
    return $false
  }
}

function Wait-TrainingHealthy {
  param(
    [int]$TimeoutSeconds = 45,
    [int]$IntervalSeconds = 3
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $portOk = Test-TrainingPort
    $httpOk = $false
    if ($portOk) { $httpOk = Test-TrainingHttp }
    if ($portOk -and $httpOk) {
      return @{ Healthy = $true; PortOk = $true; HttpOk = $true }
    }
    Start-Sleep -Seconds $IntervalSeconds
  } while ((Get-Date) -lt $deadline)

  $finalPortOk = Test-TrainingPort
  $finalHttpOk = $false
  if ($finalPortOk) { $finalHttpOk = Test-TrainingHttp }
  return @{ Healthy = $false; PortOk = $finalPortOk; HttpOk = $finalHttpOk }
}

$initial = Wait-TrainingHealthy -TimeoutSeconds 12 -IntervalSeconds 3
if ($initial.Healthy) {
  Write-WatchdogLog "OK port=8787 http=healthy"
  exit 0
}

Write-WatchdogLog "UNHEALTHY portOk=$($initial.PortOk) httpOk=$($initial.HttpOk); attempting restart"
$task = Get-ScheduledTask -TaskName "JuzhouAgentTraining" -ErrorAction SilentlyContinue
if ($task -and $task.State -eq "Running") {
  Write-WatchdogLog "Main task is Running but service unhealthy; stopping task"
  Stop-ScheduledTask -TaskName "JuzhouAgentTraining" -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 5
}

Write-WatchdogLog "Starting JuzhouAgentTraining"
Start-ScheduledTask -TaskName "JuzhouAgentTraining" -ErrorAction SilentlyContinue
$after = Wait-TrainingHealthy -TimeoutSeconds 45 -IntervalSeconds 3
Write-WatchdogLog "Restart result portOk=$($after.PortOk) httpOk=$($after.HttpOk)"
if ($after.Healthy) { exit 0 }
exit 1

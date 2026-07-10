[CmdletBinding()]
param(
    [string]$Root = ''
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($Root)) {
    $Root = $PSScriptRoot
}
$Root = [System.IO.Path]::GetFullPath($Root)
$ConfigPath = Join-Path $Root 'config\reranker.env'
$PythonExe = Join-Path $Root '.venv\Scripts\python.exe'
$LogDir = Join-Path $Root 'logs'
$LogPath = Join-Path $LogDir 'reranker.log'
$RuntimeLogPath = Join-Path $LogDir 'reranker.runtime.log'

if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw "Missing reranker configuration: $ConfigPath"
}
if (-not (Test-Path -LiteralPath $PythonExe -PathType Leaf)) {
    throw "Missing reranker Python environment: $PythonExe"
}

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
Get-ChildItem -LiteralPath $LogDir -File -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTimeUtc -lt [DateTime]::UtcNow.AddDays(-7) } |
    Remove-Item -Force

foreach ($activeLog in @($LogPath, $RuntimeLogPath)) {
    if ((Test-Path -LiteralPath $activeLog) -and (Get-Item -LiteralPath $activeLog).Length -ge 20MB) {
        $archiveName = '{0}-{1}{2}' -f (
            [System.IO.Path]::GetFileNameWithoutExtension($activeLog),
            (Get-Date -Format 'yyyyMMdd-HHmmss'),
            [System.IO.Path]::GetExtension($activeLog)
        )
        Move-Item -LiteralPath $activeLog -Destination (Join-Path $LogDir $archiveName)
    }
}

foreach ($line in Get-Content -LiteralPath $ConfigPath -Encoding UTF8) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#')) {
        continue
    }
    $separator = $trimmed.IndexOf('=')
    if ($separator -le 0) {
        throw "Invalid reranker configuration line"
    }
    $name = $trimmed.Substring(0, $separator).Trim()
    $value = $trimmed.Substring($separator + 1)
    [Environment]::SetEnvironmentVariable($name, $value, 'Process')
}

$env:PYTHONUTF8 = '1'
$env:PYTHONUNBUFFERED = '1'
$env:HF_HUB_DISABLE_TELEMETRY = '1'
$env:HF_HUB_OFFLINE = '1'
$env:TRANSFORMERS_OFFLINE = '1'
$env:HF_HOME = Join-Path $Root 'model-cache'

$HostAddress = if ($env:RERANKER_HOST) { $env:RERANKER_HOST } else { '0.0.0.0' }
$Port = if ($env:RERANKER_PORT) { $env:RERANKER_PORT } else { '8910' }

Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value (
    '[{0}] starting reranker host={1} port={2}' -f (Get-Date -Format o), $HostAddress, $Port
)

Push-Location $Root
try {
    $Arguments = @(
        '-m', 'uvicorn', 'app:app',
        '--host', $HostAddress,
        '--port', $Port,
        '--workers', '1',
        '--log-level', 'info',
        '--no-access-log',
        '--no-proxy-headers'
    )
    $ErrorActionPreference = 'Continue'
    & $PythonExe @Arguments 2>&1 |
        Out-File -LiteralPath $RuntimeLogPath -Append -Encoding UTF8
    $ExitCode = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
}
finally {
    Pop-Location
}

Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value (
    '[{0}] reranker exited code={1}' -f (Get-Date -Format o), $ExitCode
)
exit $ExitCode

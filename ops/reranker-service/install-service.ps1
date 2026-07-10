[CmdletBinding()]
param(
    [string]$Root = '',
    [string]$PythonExe = 'python',
    [string]$ProxyUrl = '',
    [string]$TorchVersion = '2.11.0',
    [string]$TorchIndexUrl = 'https://download.pytorch.org/whl/cu130'
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($Root)) {
    $Root = $PSScriptRoot
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Administrator privileges are required'
}

$Root = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
if ($Root -ne [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')) {
    throw 'Run install-service.ps1 from the final deployment directory'
}

function Assert-ContainedPath {
    param([Parameter(Mandatory)][string]$Path)
    $resolved = [System.IO.Path]::GetFullPath($Path)
    if (-not $resolved.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path escapes deployment root: $resolved"
    }
    return $resolved
}

function Invoke-Native {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [Parameter(Mandatory)][string[]]$Arguments
    )
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$FilePath failed with exit code $LASTEXITCODE"
    }
}

$VenvDir = Assert-ContainedPath (Join-Path $Root '.venv')
$ModelDir = Assert-ContainedPath (Join-Path $Root 'model')
$ModelCacheDir = Assert-ContainedPath (Join-Path $Root 'model-cache')
$ConfigDir = Assert-ContainedPath (Join-Path $Root 'config')
$LogDir = Assert-ContainedPath (Join-Path $Root 'logs')
$InstallCacheDir = Assert-ContainedPath (Join-Path $Root 'install-cache')
$TempDir = Assert-ContainedPath (Join-Path $Root 'tmp')

foreach ($directory in @($ModelDir, $ModelCacheDir, $ConfigDir, $LogDir, $InstallCacheDir, $TempDir)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
}

$DiskBefore = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='D:'"
[pscustomobject]@{
    phase = 'disk-before'
    freeGB = [math]::Round($DiskBefore.FreeSpace / 1GB, 2)
    sizeGB = [math]::Round($DiskBefore.Size / 1GB, 2)
} | ConvertTo-Json -Compress

$env:TEMP = $TempDir
$env:TMP = $TempDir
$env:PIP_CACHE_DIR = Join-Path $InstallCacheDir 'pip'
$env:HF_HOME = $ModelCacheDir
$env:HF_HUB_DISABLE_TELEMETRY = '1'
$env:HF_HUB_DISABLE_XET = '1'
$env:HF_HUB_DOWNLOAD_TIMEOUT = '600'
if ($ProxyUrl) {
    $env:HTTP_PROXY = $ProxyUrl
    $env:HTTPS_PROXY = $ProxyUrl
}

if (-not (Test-Path -LiteralPath (Join-Path $VenvDir 'Scripts\python.exe'))) {
    Invoke-Native -FilePath $PythonExe -Arguments @('-m', 'venv', $VenvDir)
}
$VenvPython = Join-Path $VenvDir 'Scripts\python.exe'

Invoke-Native -FilePath $VenvPython -Arguments @('-m', 'pip', 'install', '--upgrade', 'pip')
Invoke-Native -FilePath $VenvPython -Arguments @(
    '-m', 'pip', 'install', "torch==$TorchVersion", '--index-url', $TorchIndexUrl
)
Invoke-Native -FilePath $VenvPython -Arguments @(
    '-m', 'pip', 'install', '-r', (Join-Path $Root 'requirements.txt')
)

Invoke-Native -FilePath $VenvPython -Arguments @(
    (Join-Path $Root 'preload_model.py'),
    '--model', 'BAAI/bge-reranker-v2-m3',
    '--model-dir', $ModelDir,
    '--device', 'cuda:0',
    '--batch-size', '8'
)

$FreezePath = Join-Path $Root 'requirements.lock.txt'
& $VenvPython -m pip freeze | Set-Content -LiteralPath $FreezePath -Encoding UTF8
if ($LASTEXITCODE -ne 0) {
    throw 'pip freeze failed'
}

$ConfigPath = Join-Path $ConfigDir 'reranker.env'
$ApiKey = $null
if (Test-Path -LiteralPath $ConfigPath -PathType Leaf) {
    $keyLine = Get-Content -LiteralPath $ConfigPath -Encoding UTF8 |
        Where-Object { $_ -like 'RERANKER_API_KEY=*' } |
        Select-Object -First 1
    if ($keyLine) {
        $ApiKey = $keyLine.Substring($keyLine.IndexOf('=') + 1)
    }
}
if (-not $ApiKey -or $ApiKey.Length -lt 32) {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
    }
    finally {
        $rng.Dispose()
    }
    $ApiKey = [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
}

@(
    "RERANKER_API_KEY=$ApiKey"
    'RERANKER_MODEL=BAAI/bge-reranker-v2-m3'
    "RERANKER_MODEL_PATH=$ModelDir"
    'RERANKER_DEVICE=cuda:0'
    'RERANKER_BATCH_SIZE=8'
    'RERANKER_QUERY_MAX_LENGTH=256'
    'RERANKER_MAX_LENGTH=1024'
    'RERANKER_USE_FP16=1'
    'RERANKER_HOST=0.0.0.0'
    'RERANKER_PORT=8910'
) | Set-Content -LiteralPath $ConfigPath -Encoding UTF8

& icacls.exe $ConfigPath /inheritance:r /grant:r '*S-1-5-18:(R)' '*S-1-5-32-544:(F)' | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw 'Failed to secure reranker.env ACL'
}

$TaskName = 'JuzhouAgentReranker'
$TaskAction = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument ('-NoProfile -ExecutionPolicy Bypass -File "{0}" -Root "{1}"' -f (Join-Path $Root 'start-reranker.ps1'), $Root) `
    -WorkingDirectory $Root
$TaskTrigger = New-ScheduledTaskTrigger -AtStartup
$TaskPrincipal = New-ScheduledTaskPrincipal `
    -UserId 'SYSTEM' `
    -LogonType ServiceAccount `
    -RunLevel Highest
$TaskSettings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew
Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $TaskAction `
    -Trigger $TaskTrigger `
    -Principal $TaskPrincipal `
    -Settings $TaskSettings `
    -Force | Out-Null

$FirewallName = 'Juzhou Agent Reranker LAN 8910'
Get-NetFirewallRule -DisplayName $FirewallName -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule
New-NetFirewallRule `
    -DisplayName $FirewallName `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort 8910 `
    -RemoteAddress '192.168.9.0/24' `
    -Profile Any | Out-Null

Start-ScheduledTask -TaskName $TaskName
$Ready = $false
for ($attempt = 0; $attempt -lt 90; $attempt++) {
    Start-Sleep -Seconds 2
    try {
        $health = Invoke-RestMethod -UseBasicParsing -Uri 'http://127.0.0.1:8910/health' -TimeoutSec 3
        if ($health.ok -and $health.status -eq 'ready') {
            $Ready = $true
            break
        }
    }
    catch {
    }
}
if (-not $Ready) {
    throw 'Reranker did not become ready within 180 seconds'
}

$headers = @{ Authorization = "Bearer $ApiKey" }
$body = @{
    query = 'What is a water pump used for?'
    documents = @(
        @{ id = 'relevant'; text = 'A water pump moves liquid and raises its pressure or elevation.' }
        @{ id = 'irrelevant'; text = 'The weather is suitable for outdoor activities today.' }
    )
    topK = 2
} | ConvertTo-Json -Depth 5
$result = Invoke-RestMethod `
    -UseBasicParsing `
    -Uri 'http://127.0.0.1:8910/rerank' `
    -Method Post `
    -Headers $headers `
    -ContentType 'application/json; charset=utf-8' `
    -Body ([Text.Encoding]::UTF8.GetBytes($body)) `
    -TimeoutSec 30
if ($result.results[0].id -ne 'relevant') {
    throw 'Authenticated reranker smoke test returned the wrong order'
}

foreach ($cleanupPath in @($InstallCacheDir, $TempDir)) {
    $verified = Assert-ContainedPath $cleanupPath
    if (Test-Path -LiteralPath $verified) {
        Remove-Item -LiteralPath $verified -Recurse -Force
    }
}
Get-ChildItem -LiteralPath $ModelDir -Recurse -File -Filter '*.incomplete' -ErrorAction SilentlyContinue |
    Remove-Item -Force

$DiskAfter = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='D:'"
[pscustomobject]@{
    ok = $true
    task = $TaskName
    health = 'ready'
    model = $health.model
    device = $health.device
    gpu = $health.gpu
    torchVersion = $health.torchVersion
    flagEmbeddingVersion = $health.flagEmbeddingVersion
    configPath = $ConfigPath
    apiKeyPrinted = $false
    diskFreeGB = [math]::Round($DiskAfter.FreeSpace / 1GB, 2)
    diskUsedGB = [math]::Round(($DiskBefore.FreeSpace - $DiskAfter.FreeSpace) / 1GB, 2)
} | ConvertTo-Json -Compress

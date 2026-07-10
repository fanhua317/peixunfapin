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
$KeyLine = Get-Content -LiteralPath $ConfigPath -Encoding UTF8 |
    Where-Object { $_ -like 'RERANKER_API_KEY=*' } |
    Select-Object -First 1
$ApiKey = $KeyLine.Substring($KeyLine.IndexOf('=') + 1)
if ($ApiKey.Length -lt 32) {
    throw 'Stored token is invalid'
}

$Body = @{
    query = 'What does a water pump do?'
    documents = @(
        @{ id = 'irrelevant'; text = 'The weather is clear today.' }
        @{ id = 'relevant'; text = 'A water pump transports liquid and can raise pressure.' }
    )
    topK = 2
} | ConvertTo-Json -Depth 5
$Result = Invoke-RestMethod `
    -UseBasicParsing `
    -Uri 'http://127.0.0.1:8910/rerank' `
    -Method Post `
    -Headers @{ Authorization = "Bearer $ApiKey" } `
    -ContentType 'application/json; charset=utf-8' `
    -Body ([Text.Encoding]::UTF8.GetBytes($Body)) `
    -TimeoutSec 30

$Task = Get-ScheduledTask -TaskName 'JuzhouAgentReranker'
$TaskInfo = Get-ScheduledTaskInfo -TaskName 'JuzhouAgentReranker'
[xml]$TaskXml = Export-ScheduledTask -TaskName 'JuzhouAgentReranker'
$Firewall = Get-NetFirewallRule -DisplayName 'Juzhou Agent Reranker LAN 8910'
$Address = $Firewall | Get-NetFirewallAddressFilter
$Port = $Firewall | Get-NetFirewallPortFilter
$Acl = (Get-Acl -LiteralPath $ConfigPath).Access |
    Select-Object IdentityReference, FileSystemRights, AccessControlType, IsInherited

$Sizes = @{}
foreach ($name in @('.venv', 'model', 'model-cache', 'logs')) {
    $sum = (Get-ChildItem (Join-Path $Root $name) -File -Recurse -Force -ErrorAction SilentlyContinue |
        Measure-Object Length -Sum).Sum
    $Sizes[$name] = [math]::Round($sum / 1GB, 3)
}
$Partials = (Get-ChildItem (Join-Path $Root 'model') -File -Recurse -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like '*.incomplete' -or $_.Name -like '*.lock' }).Count
$Disks = Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' |
    Select-Object DeviceID,
        @{n = 'FreeGB'; e = {[math]::Round($_.FreeSpace / 1GB, 2)}},
        @{n = 'SizeGB'; e = {[math]::Round($_.Size / 1GB, 2)}}

[pscustomobject]@{
    validRerank = [pscustomobject]@{
        model = $Result.model
        latencyMs = $Result.latencyMs
        queueLatencyMs = $Result.queueLatencyMs
        order = @($Result.results | ForEach-Object { $_.id })
        scores = @($Result.results | ForEach-Object { $_.score })
    }
    task = [pscustomobject]@{
        state = $Task.State.ToString()
        lastResult = $TaskInfo.LastTaskResult
        user = $Task.Principal.UserId
        executionTimeLimit = $TaskXml.Task.Settings.ExecutionTimeLimit
        restartCount = $TaskXml.Task.Settings.RestartOnFailure.Count
        restartInterval = $TaskXml.Task.Settings.RestartOnFailure.Interval
        startWhenAvailable = $TaskXml.Task.Settings.StartWhenAvailable
    }
    firewall = [pscustomobject]@{
        enabled = $Firewall.Enabled.ToString()
        action = $Firewall.Action.ToString()
        direction = $Firewall.Direction.ToString()
        remoteAddress = $Address.RemoteAddress
        protocol = $Port.Protocol
        localPort = $Port.LocalPort
    }
    config = [pscustomobject]@{
        path = $ConfigPath
        tokenLength = $ApiKey.Length
        acl = $Acl
    }
    sizesGB = $Sizes
    partialFiles = $Partials
    installCacheExists = Test-Path (Join-Path $Root 'install-cache')
    tempExists = Test-Path (Join-Path $Root 'tmp')
    disks = $Disks
    gpu = (& nvidia-smi --query-gpu=name,memory.total,memory.used,utilization.gpu --format=csv,noheader)
} | ConvertTo-Json -Compress -Depth 8

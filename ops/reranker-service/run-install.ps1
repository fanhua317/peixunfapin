[CmdletBinding()]
param(
    [string]$Root = '',
    [string]$PythonExe = 'python',
    [string]$ProxyUrl = ''
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($Root)) {
    $Root = $PSScriptRoot
}
$Root = [System.IO.Path]::GetFullPath($Root)
$LogPath = Join-Path $Root 'install.log'
$StatusPath = Join-Path $Root 'install.status.json'

function Write-InstallStatus {
    param(
        [Parameter(Mandatory)][string]$State,
        [string]$ErrorType = ''
    )
    [pscustomobject]@{
        state = $State
        errorType = $ErrorType
        updatedAt = (Get-Date).ToUniversalTime().ToString('o')
        processId = $PID
    } | ConvertTo-Json -Compress | Set-Content -LiteralPath $StatusPath -Encoding UTF8
}

Write-InstallStatus -State 'running'
Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value (
    '[{0}] installation started' -f (Get-Date -Format o)
)
$TranscriptStarted = $false
$Succeeded = $false
$FailureType = ''
$FailureMessage = ''

try {
    Start-Transcript -LiteralPath $LogPath -Append | Out-Null
    $TranscriptStarted = $true
    & (Join-Path $Root 'install-service.ps1') `
        -Root $Root `
        -PythonExe $PythonExe `
        -ProxyUrl $ProxyUrl
    $Succeeded = $true
}
catch {
    $FailureType = $_.Exception.GetType().FullName
    $FailureMessage = $_.Exception.Message
}
finally {
    if ($TranscriptStarted) {
        Stop-Transcript | Out-Null
    }
}

if ($Succeeded) {
    Write-InstallStatus -State 'complete'
    Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value (
        '[{0}] installation completed' -f (Get-Date -Format o)
    )
    exit 0
}

Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value (
    '[{0}] installation failed type={1}: {2}' -f (Get-Date -Format o), $FailureType, $FailureMessage
)
Write-InstallStatus -State 'failed' -ErrorType $FailureType
exit 1

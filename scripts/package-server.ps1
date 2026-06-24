param(
  [switch]$IncludeData,
  [string]$DataRoot = "D:\juzhou-agent\data",
  [string]$OutputDir = ".\dist",
  [string]$AppName = "JuzhouAgentTrainingServer"
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
$zipPath = Join-Path $outputRoot "$AppName.zip"
$serverDeployRoot = Join-Path $repoRoot "deploy\server"

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue

New-Item -ItemType Directory -Force -Path $stageRoot | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $stageRoot "data\training-index") | Out-Null

Copy-Directory -Source (Join-Path $repoRoot "training-service") -Destination (Join-Path $stageRoot "training-service") -ExcludeDirs @("data", ".tmp-smoke-data", "node_modules", "dist") -ExcludeFiles @("*.log")
Copy-Item -LiteralPath (Join-Path $serverDeployRoot "Dockerfile") -Destination (Join-Path $stageRoot "Dockerfile") -Force
Copy-Item -LiteralPath (Join-Path $serverDeployRoot "dockerignore") -Destination (Join-Path $stageRoot ".dockerignore") -Force
Copy-Item -LiteralPath (Join-Path $serverDeployRoot "docker-compose.yml") -Destination (Join-Path $stageRoot "docker-compose.yml") -Force
Copy-Item -LiteralPath (Join-Path $serverDeployRoot "env.example") -Destination (Join-Path $stageRoot ".env.example") -Force
Copy-Item -LiteralPath (Join-Path $serverDeployRoot "start-server.sh") -Destination (Join-Path $stageRoot "start-server.sh") -Force
Copy-Item -LiteralPath (Join-Path $serverDeployRoot "start-server.ps1") -Destination (Join-Path $stageRoot "start-server.ps1") -Force
Copy-Item -LiteralPath (Join-Path $serverDeployRoot "watchdog-server.ps1") -Destination (Join-Path $stageRoot "watchdog-server.ps1") -Force
Copy-Item -LiteralPath (Join-Path $serverDeployRoot "README-server.md") -Destination (Join-Path $stageRoot "README-server.md") -Force

if ($IncludeData) {
  $dataRootFull = Resolve-FullPath $DataRoot
  Copy-Directory -Source (Join-Path $dataRootFull "training-index") -Destination (Join-Path $stageRoot "data\training-index")
}

Compress-Archive -LiteralPath $stageRoot -DestinationPath $zipPath -Force

Write-Host "Server package: $zipPath"


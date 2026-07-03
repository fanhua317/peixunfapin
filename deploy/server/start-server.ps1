$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot
New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot "logs") | Out-Null
$logPath = Join-Path $PSScriptRoot "logs\server.log"

function Write-ServiceLog {
  param([string]$Message)
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
}

if (Test-Path -LiteralPath ".env") {
  Get-Content -LiteralPath ".env" | ForEach-Object {
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

if (!$env:HOST) { $env:HOST = "0.0.0.0" }
if (!$env:PORT) { $env:PORT = "8787" }
if (!$env:PUBLIC_BASE_URL_MODE) { $env:PUBLIC_BASE_URL_MODE = "request" }
if (!$env:TRAINING_DATA_DIR) { $env:TRAINING_DATA_DIR = Join-Path $PSScriptRoot "data\training-index" }
if (!$env:TRAINING_STORAGE) { $env:TRAINING_STORAGE = "sqlite" }
if (!$env:TRAINING_SQLITE_BUSY_TIMEOUT_MS) { $env:TRAINING_SQLITE_BUSY_TIMEOUT_MS = "5000" }
if (!$env:TRAINING_LLM_PROVIDER) { $env:TRAINING_LLM_PROVIDER = "auto" }
if (!$env:TRAINING_LLM_BASE_URL) { $env:TRAINING_LLM_BASE_URL = "https://api.deepseek.com/v1" }
if (!$env:TRAINING_LLM_MODEL) { $env:TRAINING_LLM_MODEL = "deepseek-chat" }
if (!$env:TRAINING_LLM_TEMPERATURE) { $env:TRAINING_LLM_TEMPERATURE = "1" }
if (!$env:TRAINING_MARKETING_TEMPERATURE) { $env:TRAINING_MARKETING_TEMPERATURE = "0.6" }
if (!$env:TRAINING_MARKETING_WEB_SEARCH_MAX_RESULTS) { $env:TRAINING_MARKETING_WEB_SEARCH_MAX_RESULTS = "8" }
if (!$env:TRAINING_MARKETING_WEB_SEARCH_SEARCH_DEPTH) { $env:TRAINING_MARKETING_WEB_SEARCH_SEARCH_DEPTH = "basic" }
if (!$env:TRAINING_HYBRID_RETRIEVAL) { $env:TRAINING_HYBRID_RETRIEVAL = "auto" }
if (!$env:TRAINING_VECTOR_BACKEND) { $env:TRAINING_VECTOR_BACKEND = "local" }
if (!$env:TRAINING_EMBEDDING_MODEL) { $env:TRAINING_EMBEDDING_MODEL = "bge-m3" }
if (!$env:TRAINING_RAG_EMBEDDING_TIMEOUT_MS) { $env:TRAINING_RAG_EMBEDDING_TIMEOUT_MS = "8000" }

New-Item -ItemType Directory -Force -Path $env:TRAINING_DATA_DIR | Out-Null

Write-ServiceLog "=== JuzhouAgentTraining start requested ==="
Write-ServiceLog "WorkingDirectory=$PSScriptRoot"
Write-ServiceLog "HOST=$env:HOST PORT=$env:PORT TRAINING_DATA_DIR=$env:TRAINING_DATA_DIR TRAINING_STORAGE=$env:TRAINING_STORAGE TRAINING_VECTOR_BACKEND=$env:TRAINING_VECTOR_BACKEND TRAINING_HYBRID_RETRIEVAL=$env:TRAINING_HYBRID_RETRIEVAL"

$serviceDir = Join-Path $PSScriptRoot "training-service"
if (!(Test-Path -LiteralPath (Join-Path $serviceDir "node_modules\better-sqlite3"))) {
  Push-Location $serviceDir
  try {
    npm ci --omit=dev
  } finally {
    Pop-Location
  }
}

$node = Get-Command node -ErrorAction Stop
Write-ServiceLog "Node=$($node.Source)"
Write-ServiceLog "Launching training-service src/server.mjs"
& $node.Source .\training-service\src\server.mjs *>> $logPath
$exitCode = $LASTEXITCODE
Write-ServiceLog "Node process exited with code $exitCode"
Write-ServiceLog "=== JuzhouAgentTraining script finished ==="
exit $exitCode

$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot

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
if (!$env:TRAINING_HYBRID_RETRIEVAL) { $env:TRAINING_HYBRID_RETRIEVAL = "auto" }
if (!$env:TRAINING_VECTOR_BACKEND) { $env:TRAINING_VECTOR_BACKEND = "local" }
if (!$env:TRAINING_EMBEDDING_MODEL) { $env:TRAINING_EMBEDDING_MODEL = "bge-m3" }
if (!$env:TRAINING_RAG_EMBEDDING_TIMEOUT_MS) { $env:TRAINING_RAG_EMBEDDING_TIMEOUT_MS = "8000" }

New-Item -ItemType Directory -Force -Path $env:TRAINING_DATA_DIR | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot "logs") | Out-Null

$serviceDir = Join-Path $PSScriptRoot "training-service"
if (!(Test-Path -LiteralPath (Join-Path $serviceDir "node_modules\better-sqlite3"))) {
  Push-Location $serviceDir
  try {
    npm ci --omit=dev
  } finally {
    Pop-Location
  }
}

node .\training-service\src\server.mjs *> .\logs\server.log

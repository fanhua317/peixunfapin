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
if (!$env:TRAINING_DATA_DIR) { $env:TRAINING_DATA_DIR = Join-Path $PSScriptRoot "data\training-index" }
if (!$env:TRAINING_LLM_PROVIDER) { $env:TRAINING_LLM_PROVIDER = "auto" }
if (!$env:TRAINING_LLM_BASE_URL) { $env:TRAINING_LLM_BASE_URL = "https://api.deepseek.com/v1" }
if (!$env:TRAINING_LLM_MODEL) { $env:TRAINING_LLM_MODEL = "deepseek-chat" }
if (!$env:TRAINING_HYBRID_RETRIEVAL) { $env:TRAINING_HYBRID_RETRIEVAL = "0" }

New-Item -ItemType Directory -Force -Path $env:TRAINING_DATA_DIR | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot "logs") | Out-Null

node .\training-service\src\server.mjs *> .\logs\server.log

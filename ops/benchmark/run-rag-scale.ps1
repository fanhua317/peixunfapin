param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectRoot,
  [Parameter(Mandatory = $true)]
  [string]$OllamaRoot,
  [string]$Sizes = "100,1000,5000",
  [int]$Queries = 100,
  [string]$Concurrency = "1,5,10,20",
  [string]$ProxyUrl = "",
  [switch]$InstallDependencies,
  [switch]$Resume,
  [switch]$RerunQueries
)

$ErrorActionPreference = "Stop"

function Resolve-CheckedRoot([string]$Value, [string]$RequiredPrefix) {
  $resolved = [IO.Path]::GetFullPath($Value).TrimEnd('\')
  $prefix = [IO.Path]::GetFullPath($RequiredPrefix).TrimEnd('\')
  if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Path must remain under ${prefix}: ${resolved}"
  }
  return $resolved
}

function Read-EnvValue([string]$Path, [string]$Name) {
  $line = Get-Content -LiteralPath $Path | Where-Object { $_.StartsWith("${Name}=") } | Select-Object -First 1
  if (-not $line) { throw "Missing ${Name} in protected environment file" }
  return ($line -split '=', 2)[1].Trim()
}

$project = Resolve-CheckedRoot $ProjectRoot 'D:\juzhou-agent-benchmark'
$ollama = Resolve-CheckedRoot $OllamaRoot 'D:\juzhou-agent-benchmark-tools'
$serviceRoot = Join-Path $project 'training-service'
$workRoot = Join-Path $project 'work'
$artifactRoot = Join-Path $project 'artifacts'
$npmCache = Join-Path $project 'npm-cache'
$ollamaExe = Join-Path $ollama 'ollama.exe'
$ollamaModels = Join-Path $ollama 'models'
$rerankerEnv = 'D:\juzhou-agent-reranker\config\reranker.env'

foreach ($required in @($serviceRoot, $ollamaExe, $ollamaModels, $rerankerEnv)) {
  if (-not (Test-Path -LiteralPath $required)) { throw "Required path is missing: ${required}" }
}

New-Item -ItemType Directory -Force -Path $workRoot, $artifactRoot, $npmCache | Out-Null

$env:OLLAMA_HOST = '127.0.0.1:11434'
$env:OLLAMA_MODELS = $ollamaModels
$env:TRAINING_EMBEDDING_MODEL = 'bge-m3'
$env:TRAINING_VECTOR_BACKEND = 'local'
$env:TRAINING_HYBRID_RETRIEVAL = '1'
$env:TRAINING_RERANKER_ENABLED = '1'
$env:TRAINING_RERANKER_URL = 'http://127.0.0.1:8910'
$env:TRAINING_RERANKER_API_KEY = Read-EnvValue $rerankerEnv 'RERANKER_API_KEY'
$env:TRAINING_RERANKER_MODEL = 'BAAI/bge-reranker-v2-m3'
$env:TRAINING_RERANKER_TIMEOUT_MS = '15000'
$env:npm_config_cache = $npmCache
if ($ProxyUrl) {
  $env:HTTP_PROXY = $ProxyUrl
  $env:HTTPS_PROXY = $ProxyUrl
}

$ollamaProcess = $null
try {
  if ($InstallDependencies -or -not (Test-Path -LiteralPath (Join-Path $serviceRoot 'node_modules'))) {
    Push-Location $serviceRoot
    try {
      & npm.cmd ci --no-audit --no-fund
      if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
    } finally {
      Pop-Location
    }
  }

  $ollamaReady = $false
  try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 3
    $ollamaReady = $null -ne $health
  } catch {
    $ollamaReady = $false
  }
  if (-not $ollamaReady) {
    $ollamaProcess = Start-Process -FilePath $ollamaExe -ArgumentList 'serve' -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput (Join-Path $project 'ollama.stdout.log') `
      -RedirectStandardError (Join-Path $project 'ollama.stderr.log')
    $deadline = (Get-Date).AddSeconds(45)
    do {
      Start-Sleep -Milliseconds 500
      try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 3
        $ollamaReady = $null -ne $health
      } catch {
        $ollamaReady = $false
      }
    } while (-not $ollamaReady -and (Get-Date) -lt $deadline)
    if (-not $ollamaReady) { throw 'Temporary Ollama did not become ready' }
  }

  Push-Location $serviceRoot
  try {
    $arguments = @(
      'scripts/benchmark-rag-scale.mjs',
      "--sizes=${Sizes}",
      "--queries=${Queries}",
      "--concurrency=${Concurrency}",
      "--work=${workRoot}",
      "--out=${artifactRoot}"
    )
    if ($Resume) { $arguments += '--resume' }
    if ($RerunQueries) { $arguments += '--rerun-queries' }
    & node @arguments
    if ($LASTEXITCODE -ne 0) { throw "RAG scale benchmark failed with exit code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
} finally {
  Remove-Item Env:TRAINING_RERANKER_API_KEY -ErrorAction SilentlyContinue
  if ($ollamaProcess -and -not $ollamaProcess.HasExited) {
    Stop-Process -Id $ollamaProcess.Id -Force -ErrorAction SilentlyContinue
    $ollamaProcess.WaitForExit(10000) | Out-Null
  }
}

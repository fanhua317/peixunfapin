# 钜洲培训 Agent Server Deployment

本文是服务器部署速查。更完整的运行说明见 `training-service/README.md`。

## Docker Compose

1. Install Docker and Docker Compose.
2. Copy `.env.example` to `.env`.
3. Set at least:
   - `TRAINING_ACCESS_KEY`
   - `TRAINING_LLM_API_KEY` or `DEEPSEEK_API_KEY`
   - `PUBLIC_BASE_URL` only when a fixed domain/IP should be forced.
4. Start:

```bash
docker compose up -d --build
```

Default URL:

```text
http://your-server-ip:8787/
```

For `http://47.95.194.219:8787/`, either keep request-based links or set:

```env
PUBLIC_BASE_URL=http://47.95.194.219:8787
PUBLIC_BASE_URL_MODE=env
```

## Direct Node

Linux:

```bash
cp .env.example .env
vi .env
chmod +x start-server.sh
./start-server.sh
```

Windows Server:

```powershell
Copy-Item .env.example .env
notepad .env
powershell -ExecutionPolicy Bypass -File .\start-server.ps1
```

Scheduled task example:

```powershell
schtasks /Create /TN "JuzhouAgentTraining" /SC ONSTART /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\apps\JuzhouAgentTrainingServer\start-server.ps1" /RU SYSTEM /RL HIGHEST /F
schtasks /Run /TN "JuzhouAgentTraining"
```

After creating the task, edit the task settings so it can run indefinitely and restart on short failures:

```powershell
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Set-ScheduledTask -TaskName JuzhouAgentTraining -Settings $settings
```

For self-healing, register `watchdog-server.ps1` as a second task that runs every 5 minutes:

```powershell
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File C:\apps\JuzhouAgentTrainingServer\watchdog-server.ps1"
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName "JuzhouAgentTrainingWatchdog" -Action $action -Trigger $trigger -Settings $settings -User "SYSTEM" -RunLevel Highest -Force
```

For daily local backups with retention, register `backup-server.ps1` as a third task:

```powershell
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File C:\apps\JuzhouAgentTrainingServer\backup-server.ps1"
$trigger = New-ScheduledTaskTrigger -Daily -At 3:20am
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName "JuzhouAgentTrainingBackup" -Action $action -Trigger $trigger -Settings $settings -User "SYSTEM" -RunLevel Highest -Force
```

The start script installs production dependencies with `npm ci --omit=dev`, including the native SQLite module. It appends to `logs\server.log` and records the Node path, key environment summary, and exit code instead of overwriting the log. The watchdog checks port `8787`, `/`, and `/api/health`; a `401` from `/api/health` is normal when the access key is required. Watchdog events are written to `logs\watchdog.log`. The backup task writes `logs\backup.log`, verifies the new ZIP, and defaults to `TRAINING_BACKUP_RETENTION_DAYS=14` and `TRAINING_BACKUP_KEEP_LAST=10`.

Useful checks:

```powershell
Get-ScheduledTask -TaskName JuzhouAgentTraining,JuzhouAgentTrainingWatchdog,JuzhouAgentTrainingBackup | Select TaskName,State
Export-ScheduledTask -TaskName JuzhouAgentTraining | Select-String ExecutionTimeLimit
Get-NetTCPConnection -LocalPort 8787 -State Listen
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8787/
Get-Content .\logs\server.log -Tail 80
Get-Content .\logs\watchdog.log -Tail 80
Get-Content .\logs\backup.log -Tail 80
```

## Data

Default packaged data directory:

```text
data/training-index
```

Back up regularly:

```text
data/training-index/training.db
data/training-index/training.db-shm
data/training-index/training.db-wal
data/training-index/conversation-history.jsonl
data/training-index/agent-traces.jsonl
data/training-index/vector-index-bge-m3.json
```

Runtime backup commands:

```bash
cd training-service
npm run backup:data
npm run backup:data -- --retention-days 14 --keep-last 10
npm run backup:verify -- --from /path/to/training-backup.zip
npm run restore:data -- --from /path/to/training-backup.zip --force
```

Retention only deletes ZIP files that contain a valid Juzhou backup manifest, so unrelated archives in the directory are ignored. Stop the service before a real restore. The restore command verifies the ZIP and creates a safety backup before overwriting `training.db`.

## LLM

Default provider is OpenAI-compatible API, usually DeepSeek:

```env
TRAINING_LLM_PROVIDER=auto
TRAINING_LLM_BASE_URL=https://api.deepseek.com/v1
TRAINING_LLM_MODEL=deepseek-chat
TRAINING_LLM_API_KEY=...
```

OpenClaw Gateway is optional and only used when:

```env
TRAINING_LLM_PROVIDER=openclaw
```

## RAG With Local Vector Index

For a low-concurrency 2-core / 4GB Windows server, prefer local vector index + optional Ollama query embedding.

Recommended flow:

1. Build or refresh the knowledge base locally.
2. Run local embedding against the same `chunks` / `chunkParents`:

   ```powershell
   cd D:\juzhou-agent\peixun\training-service
   npm run embed:local -- --full
   ```

3. Upload matching `training.db` / clean data and `vector-index-bge-m3.json` to the server.
4. On the server, optionally install Ollama and pull only `bge-m3` for query embedding:

   ```powershell
   ollama pull bge-m3
   ```

   On Windows Server, keep Ollama running with a dedicated local-only scheduled task:

   ```powershell
   $serverRoot = "C:\apps\JuzhouAgentTrainingServer"
   Copy-Item .\start-ollama.cmd $serverRoot -Force

   $action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$serverRoot\start-ollama.cmd`"" -WorkingDirectory $serverRoot
   $trigger = New-ScheduledTaskTrigger -AtStartup
   $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
   $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew -StartWhenAvailable
   Register-ScheduledTask -TaskName "JuzhouAgentOllama" -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force
   Start-ScheduledTask -TaskName "JuzhouAgentOllama"
   ```

   Verify:

   ```powershell
   Get-ScheduledTask -TaskName JuzhouAgentOllama | Select TaskName,State
   Get-NetTCPConnection -LocalPort 11434 -State Listen
   Invoke-WebRequest -UseBasicParsing http://127.0.0.1:11434/api/tags
   Get-Content .\logs\ollama-system.log -Tail 80
   ```

5. Use:

   ```env
   TRAINING_HYBRID_RETRIEVAL=auto
   TRAINING_VECTOR_BACKEND=local
   TRAINING_EMBEDDING_MODEL=bge-m3
   OLLAMA_URL=http://127.0.0.1:11434
   ```

If Ollama or the vector index is unavailable, retrieval falls back to BM25. Qdrant remains an optional high-resource deployment path; when used, back up its volume or collection snapshot together with the application data. For local-vector deployments, `qdrantOk=false` in `/api/health` is expected as long as `ollamaOk=true`, `localVectorIndexOk=true`, and `retrievalMode=hybrid`.

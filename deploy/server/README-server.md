# 钜洲培训 Agent Server Deployment

## Docker Compose

1. Install Docker and Docker Compose on the server.
2. Copy `.env.example` to `.env`.
3. Edit `.env` and set:
   - `TRAINING_ACCESS_KEY`
   - `TRAINING_LLM_API_KEY`
   - `PUBLIC_BASE_URL` only if you want to force one fixed domain; otherwise links are generated from the current browser address.
4. Start the service:

```bash
docker compose up -d --build
```

Open:

```text
http://your-server-ip:8787/
```

For `http://47.95.194.219:8787/`, keep `PUBLIC_BASE_URL_MODE=request` or set:

```text
PUBLIC_BASE_URL=http://47.95.194.219:8787
PUBLIC_BASE_URL_MODE=env
```

## Direct Node

Install Node.js 24 or newer, then run:

```bash
cp .env.example .env
vi .env
chmod +x start-server.sh
./start-server.sh
```

The start script installs production dependencies with `npm ci --omit=dev` on first run, including the native SQLite module.

On Windows Server, install Node.js 24 LTS and run PowerShell as Administrator:

```powershell
Copy-Item .env.example .env
notepad .env
powershell -ExecutionPolicy Bypass -File .\start-server.ps1
```

To run after reboot, create a Windows scheduled task:

```powershell
schtasks /Create /TN "JuzhouAgentTraining" /SC ONSTART /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\apps\JuzhouAgentTrainingServer\start-server.ps1" /RU SYSTEM /RL HIGHEST /F
schtasks /Run /TN "JuzhouAgentTraining"
```

## Data

The default data directory is:

```text
data/training-index
```

Back up these files regularly:

```text
data/training-index/training.db
data/training-index/training.db-shm
data/training-index/training.db-wal
data/training-index/conversation-history.jsonl
data/training-index/agent-traces.jsonl
data/training-index/vector-index-bge-m3.json
```

`training.db` is the default business state and local memory database. `conversation-history.jsonl` remains an append-only chat history file, and `agent-traces.jsonl` is useful for intent-routing diagnostics. `vector-index-bge-m3.json` only exists when the local vector backend is used.

The package includes built-in runtime backup commands:

```bash
cd training-service
npm run backup:data
npm run backup:verify -- --from /path/to/training-backup.zip
npm run restore:data -- --from /path/to/training-backup.zip --force
```

Backups are written to `data/training-index/backups` by default. Stop the service before a real restore; the restore command verifies the ZIP first and creates a safety backup before overwriting `training.db`.

On first SQLite startup, old `state.json` and `memory.json` files are imported automatically and kept as backups. To temporarily roll back to JSON storage, set:

```text
TRAINING_STORAGE=json
```

## RAG With bge-m3

For a 2-core / 4GB Windows server, prefer the local vector index instead of Qdrant:

```powershell
ollama pull bge-m3
cd C:\Users\Administrator\Desktop\JuzhouAgentTrainingServer\training-service
$env:TRAINING_DATA_DIR="C:\Users\Administrator\Desktop\JuzhouAgentTrainingServer\data\training-index"
npm run embed:local -- --model=bge-m3
```

Keep these values in `.env`:

```text
TRAINING_HYBRID_RETRIEVAL=auto
TRAINING_VECTOR_BACKEND=local
TRAINING_EMBEDDING_MODEL=bge-m3
```

If you run Qdrant instead, keep the Qdrant volume or snapshot together with `training.db`; otherwise retrieval will fall back to BM25 until vectors are rebuilt or restored.


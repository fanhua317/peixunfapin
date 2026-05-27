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
data/training-index/state.json
data/training-index/memory.json
data/training-index/conversation-history.jsonl
data/training-index/agent-traces.jsonl
data/training-index/vector-index-bge-m3.json
```

`state.json` is the business state. `memory.json` and `conversation-history.jsonl` are the local Agent memory files. `agent-traces.jsonl` is useful for intent-routing diagnostics. `vector-index-bge-m3.json` only exists when the local vector backend is used.

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

If you run Qdrant instead, keep the Qdrant volume or snapshot together with `state.json`; otherwise retrieval will fall back to BM25 until vectors are rebuilt or restored.


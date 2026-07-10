# GPU Reranker Service

This bundle runs `BAAI/bge-reranker-v2-m3` as a single-worker FastAPI service on a Windows GPU host. It is separate from the training service and never contains business data or API keys in Git.

## API

- `GET /health` is unauthenticated and reports readiness, model, GPU, dependency versions, and input limits.
- `POST /rerank` requires `Authorization: Bearer <token>`.
- A request accepts 1–50 unique documents, at most 4,000 characters per query/document, and `topK <= documents.length`.
- Results contain IDs, input indexes, ranks, and normalized scores. Document text is not echoed.

```json
{
  "query": "水泵用于做什么？",
  "documents": [
    { "id": "a", "text": "水泵用于输送液体。" },
    { "id": "b", "text": "无关内容。" }
  ],
  "topK": 2
}
```

## Windows installation

Copy this directory to the final deployment root, then run from an elevated PowerShell session:

```powershell
cd D:\juzhou-agent-reranker
.\run-install.ps1 -ProxyUrl http://127.0.0.1:7897
```

The installer creates a dedicated `.venv`, downloads the model under `model`, generates a cryptographically random token in `config\reranker.env`, freezes installed packages to `requirements.lock.txt`, registers `JuzhouAgentReranker`, and creates a LAN-only firewall rule for `192.168.9.0/24` on port `8910`.

The scheduled task runs as `SYSTEM`, has no execution time limit, and retries failures. Logs rotate at 20 MiB and files older than seven days are removed at startup. Installer caches and partial downloads are removed after successful verification; `.venv`, the model, config, lock file, service scripts, and logs remain.

Never print, commit, or copy `config\reranker.env` into a tracked directory.

Verify the live task, authenticated GPU ranking, firewall, token ACL, retained sizes, and cleanup state without printing the token:

```powershell
.\verify-service.ps1
```

## Unit tests

The tests use a fake reranker and do not download the model:

```powershell
python -m venv $env:TEMP\juzhou-reranker-test
& $env:TEMP\juzhou-reranker-test\Scripts\python.exe -m pip install -r requirements-test.txt
& $env:TEMP\juzhou-reranker-test\Scripts\python.exe -m pytest -q
```

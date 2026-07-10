from __future__ import annotations

import asyncio
import logging
import math
import os
import secrets
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from dataclasses import dataclass
from functools import partial
from importlib.metadata import PackageNotFoundError, version
from typing import Annotated, Any, Callable

from fastapi import Depends, FastAPI, Header, HTTPException, Request, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, model_validator


LOGGER = logging.getLogger("juzhou.reranker")
MAX_BODY_BYTES = 256 * 1024
MAX_DOCUMENTS = 50
MAX_TEXT_CHARS = 4_000


def _env_int(name: str, default: int, *, minimum: int, maximum: int) -> int:
    raw = os.getenv(name, str(default)).strip()
    try:
        value = int(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be an integer") from exc
    if value < minimum or value > maximum:
        raise RuntimeError(f"{name} must be between {minimum} and {maximum}")
    return value


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    api_key: str
    model: str
    model_path: str
    device: str
    batch_size: int
    query_max_length: int
    max_length: int
    use_fp16: bool

    @classmethod
    def from_env(cls) -> "Settings":
        api_key = os.getenv("RERANKER_API_KEY", "").strip()
        if len(api_key) < 32:
            raise RuntimeError("RERANKER_API_KEY must contain at least 32 characters")

        model = os.getenv("RERANKER_MODEL", "BAAI/bge-reranker-v2-m3").strip()
        model_path = os.getenv("RERANKER_MODEL_PATH", model).strip()
        if not model or not model_path:
            raise RuntimeError("RERANKER_MODEL and RERANKER_MODEL_PATH are required")

        return cls(
            api_key=api_key,
            model=model,
            model_path=model_path,
            device=os.getenv("RERANKER_DEVICE", "cuda:0").strip(),
            batch_size=_env_int("RERANKER_BATCH_SIZE", 8, minimum=1, maximum=32),
            query_max_length=_env_int(
                "RERANKER_QUERY_MAX_LENGTH", 256, minimum=32, maximum=1_024
            ),
            max_length=_env_int("RERANKER_MAX_LENGTH", 1_024, minimum=128, maximum=8_192),
            use_fp16=_env_bool("RERANKER_USE_FP16", True),
        )


@dataclass(frozen=True)
class ModelBundle:
    reranker: Any
    model: str
    device: str
    gpu: str | None
    torch_version: str
    flag_embedding_version: str


class RerankDocument(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    id: str = Field(min_length=1, max_length=256)
    text: str = Field(min_length=1, max_length=MAX_TEXT_CHARS)


class RerankRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, str_strip_whitespace=True)

    query: str = Field(min_length=1, max_length=MAX_TEXT_CHARS)
    documents: list[RerankDocument] = Field(min_length=1, max_length=MAX_DOCUMENTS)
    top_k: int = Field(alias="topK", ge=1, le=MAX_DOCUMENTS)

    @model_validator(mode="after")
    def validate_documents(self) -> "RerankRequest":
        if self.top_k > len(self.documents):
            raise ValueError("topK cannot exceed the number of documents")
        ids = [document.id for document in self.documents]
        if len(ids) != len(set(ids)):
            raise ValueError("document ids must be unique")
        return self


def _package_version(name: str) -> str:
    try:
        return version(name)
    except PackageNotFoundError:
        return "unknown"


def load_reranker(settings: Settings) -> ModelBundle:
    import torch
    from FlagEmbedding import FlagReranker

    if settings.device.startswith("cuda") and not torch.cuda.is_available():
        raise RuntimeError("CUDA is required but is not available")

    reranker = FlagReranker(
        settings.model_path,
        use_fp16=settings.use_fp16,
        devices=[settings.device],
        batch_size=settings.batch_size,
        query_max_length=settings.query_max_length,
        max_length=settings.max_length,
        normalize=True,
    )
    gpu = torch.cuda.get_device_name(0) if torch.cuda.is_available() else None
    return ModelBundle(
        reranker=reranker,
        model=settings.model,
        device=settings.device,
        gpu=gpu,
        torch_version=torch.__version__,
        flag_embedding_version=_package_version("FlagEmbedding"),
    )


class RuntimeState:
    def __init__(self) -> None:
        self.bundle: ModelBundle | None = None
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="reranker-gpu")
        self.inference_lock = asyncio.Semaphore(1)


Loader = Callable[[Settings], ModelBundle]


def create_app(
    *, loader: Loader = load_reranker, settings: Settings | None = None
) -> FastAPI:
    service_settings = settings or Settings.from_env()
    runtime = RuntimeState()

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        started = time.perf_counter()
        runtime.bundle = await asyncio.to_thread(loader, service_settings)
        LOGGER.info(
            "reranker ready model=%s device=%s load_ms=%d",
            runtime.bundle.model,
            runtime.bundle.device,
            round((time.perf_counter() - started) * 1_000),
        )
        try:
            yield
        finally:
            runtime.executor.shutdown(wait=False, cancel_futures=True)

    service = FastAPI(
        title="Juzhou Agent Reranker",
        version="1.0.0",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )

    @service.middleware("http")
    async def body_size_guard(request: Request, call_next: Callable[..., Any]):
        if request.url.path == "/rerank":
            content_length = request.headers.get("content-length")
            if content_length:
                try:
                    too_large = int(content_length) > MAX_BODY_BYTES
                except ValueError:
                    return JSONResponse(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        content={"detail": "invalid Content-Length"},
                    )
                if too_large:
                    return JSONResponse(
                        status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                        content={"detail": "request body is too large"},
                    )
        return await call_next(request)

    async def require_bearer(
        authorization: Annotated[str | None, Header()] = None,
    ) -> None:
        scheme, separator, token = (authorization or "").partition(" ")
        valid = (
            separator == " "
            and scheme.lower() == "bearer"
            and bool(token)
            and secrets.compare_digest(token, service_settings.api_key)
        )
        if not valid:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="invalid bearer token",
                headers={"WWW-Authenticate": "Bearer"},
            )

    @service.get("/health")
    async def health() -> dict[str, Any]:
        bundle = runtime.bundle
        if bundle is None:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="reranker is not ready",
            )
        return {
            "ok": True,
            "status": "ready",
            "model": bundle.model,
            "device": bundle.device,
            "gpu": bundle.gpu,
            "torchVersion": bundle.torch_version,
            "flagEmbeddingVersion": bundle.flag_embedding_version,
            "limits": {
                "maxDocuments": MAX_DOCUMENTS,
                "maxTextChars": MAX_TEXT_CHARS,
                "maxBodyBytes": MAX_BODY_BYTES,
            },
        }

    @service.post("/rerank", dependencies=[Depends(require_bearer)])
    async def rerank(payload: RerankRequest) -> dict[str, Any]:
        bundle = runtime.bundle
        if bundle is None:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="reranker is not ready",
            )

        queued_at = time.perf_counter()
        async with runtime.inference_lock:
            started = time.perf_counter()
            pairs = [[payload.query, document.text] for document in payload.documents]
            try:
                raw_scores = await asyncio.get_running_loop().run_in_executor(
                    runtime.executor,
                    partial(bundle.reranker.compute_score, pairs, normalize=True),
                )
            except Exception as exc:
                LOGGER.exception("reranker inference failed type=%s", type(exc).__name__)
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail="reranker inference failed",
                ) from exc

            if isinstance(raw_scores, (int, float)):
                raw_scores = [raw_scores]
            scores = [float(score) for score in raw_scores]
            if len(scores) != len(payload.documents) or any(
                not math.isfinite(score) for score in scores
            ):
                LOGGER.error("reranker returned invalid scores")
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail="reranker returned invalid scores",
                )

            ranked_indices = sorted(
                range(len(scores)), key=lambda index: scores[index], reverse=True
            )[: payload.top_k]
            completed = time.perf_counter()

        return {
            "model": bundle.model,
            "latencyMs": round((completed - started) * 1_000, 3),
            "queueLatencyMs": round((started - queued_at) * 1_000, 3),
            "count": len(ranked_indices),
            "results": [
                {
                    "id": payload.documents[index].id,
                    "index": index,
                    "rank": rank,
                    "score": scores[index],
                }
                for rank, index in enumerate(ranked_indices, start=1)
            ],
        }

    return service


app = create_app()

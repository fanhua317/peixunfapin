from __future__ import annotations

import os
from dataclasses import replace

from fastapi.testclient import TestClient

os.environ.setdefault(
    "RERANKER_API_KEY", "test-key-0123456789abcdef0123456789abcdef"
)

from app import ModelBundle, Settings, create_app


API_KEY = "test-key-0123456789abcdef0123456789abcdef"


class FakeReranker:
    def compute_score(self, pairs, *, normalize):
        assert normalize is True
        return [0.9 if passage == "relevant passage" else 0.1 for _, passage in pairs]


class BrokenReranker:
    def compute_score(self, pairs, *, normalize):
        raise RuntimeError("secret internal path D:\\model")


def settings() -> Settings:
    return Settings(
        api_key=API_KEY,
        model="BAAI/bge-reranker-v2-m3",
        model_path="unused-in-tests",
        device="cuda:0",
        batch_size=8,
        query_max_length=256,
        max_length=1_024,
        use_fp16=True,
    )


def loader(service_settings: Settings) -> ModelBundle:
    assert service_settings.api_key == API_KEY
    return ModelBundle(
        reranker=FakeReranker(),
        model=service_settings.model,
        device=service_settings.device,
        gpu="Fake GPU",
        torch_version="test",
        flag_embedding_version="1.4.0",
    )


def client(*, broken: bool = False) -> TestClient:
    selected_loader = loader
    if broken:
        selected_loader = lambda service_settings: replace(
            loader(service_settings), reranker=BrokenReranker()
        )
    return TestClient(create_app(loader=selected_loader, settings=settings()))


def payload():
    return {
        "query": "which passage is relevant?",
        "documents": [
            {"id": "low", "text": "irrelevant passage"},
            {"id": "high", "text": "relevant passage"},
        ],
        "topK": 2,
    }


def test_health_and_authenticated_rerank():
    with client() as service:
        health = service.get("/health")
        assert health.status_code == 200
        assert health.json()["limits"] == {
            "maxDocuments": 50,
            "maxTextChars": 4_000,
            "maxBodyBytes": 256 * 1_024,
        }

        response = service.post(
            "/rerank",
            headers={"Authorization": f"Bearer {API_KEY}"},
            json=payload(),
        )
        assert response.status_code == 200
        body = response.json()
        assert [item["id"] for item in body["results"]] == ["high", "low"]
        assert "text" not in body["results"][0]
        assert body["model"] == "BAAI/bge-reranker-v2-m3"


def test_missing_and_wrong_tokens_are_rejected():
    with client() as service:
        missing = service.post("/rerank", json=payload())
        wrong = service.post(
            "/rerank",
            headers={"Authorization": "Bearer definitely-wrong"},
            json=payload(),
        )
        assert missing.status_code == 401
        assert wrong.status_code == 401
        assert missing.headers["www-authenticate"] == "Bearer"


def test_request_limits_and_duplicate_ids():
    headers = {"Authorization": f"Bearer {API_KEY}"}
    with client() as service:
        too_many = payload()
        too_many["documents"] = [
            {"id": f"doc-{index}", "text": "text"} for index in range(51)
        ]
        too_many["topK"] = 1
        assert service.post("/rerank", headers=headers, json=too_many).status_code == 422

        too_long = payload()
        too_long["documents"][0]["text"] = "x" * 4_001
        assert service.post("/rerank", headers=headers, json=too_long).status_code == 422

        duplicates = payload()
        duplicates["documents"][1]["id"] = duplicates["documents"][0]["id"]
        assert service.post("/rerank", headers=headers, json=duplicates).status_code == 422

        bad_top_k = payload()
        bad_top_k["topK"] = 3
        assert service.post("/rerank", headers=headers, json=bad_top_k).status_code == 422


def test_inference_errors_are_sanitized():
    with client(broken=True) as service:
        response = service.post(
            "/rerank",
            headers={"Authorization": f"Bearer {API_KEY}"},
            json=payload(),
        )
        assert response.status_code == 503
        assert response.json() == {"detail": "reranker inference failed"}
        assert "D:\\model" not in response.text

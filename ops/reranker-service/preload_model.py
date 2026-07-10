from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description="Download and validate the BGE reranker")
    parser.add_argument("--model", default="BAAI/bge-reranker-v2-m3")
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument("--batch-size", type=int, default=8)
    args = parser.parse_args()

    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "600")

    import torch
    from FlagEmbedding import FlagReranker
    from huggingface_hub import snapshot_download

    if args.device.startswith("cuda") and not torch.cuda.is_available():
        raise RuntimeError("CUDA is required but unavailable")

    model_dir = Path(args.model_dir).resolve()
    model_dir.mkdir(parents=True, exist_ok=True)
    snapshot_download(repo_id=args.model, local_dir=str(model_dir), max_workers=4)

    reranker = FlagReranker(
        str(model_dir),
        use_fp16=args.device.startswith("cuda"),
        devices=[args.device],
        batch_size=args.batch_size,
        query_max_length=256,
        max_length=1_024,
        normalize=True,
    )
    pairs = [
        ["水泵的主要作用是什么？", "水泵用于输送液体，并把机械能转化为液体能量。"],
        ["水泵的主要作用是什么？", "今天的天气晴朗，适合进行室外活动。"],
    ]
    scores = [float(value) for value in reranker.compute_score(pairs, normalize=True)]
    if len(scores) != 2 or any(not math.isfinite(value) for value in scores):
        raise RuntimeError("reranker smoke test returned invalid scores")
    if scores[0] <= scores[1]:
        raise RuntimeError("reranker smoke test ranked the irrelevant passage first")

    print(
        json.dumps(
            {
                "ok": True,
                "model": args.model,
                "device": args.device,
                "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
                "torchVersion": torch.__version__,
                "scoreCount": len(scores),
                "rankingOk": True,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()

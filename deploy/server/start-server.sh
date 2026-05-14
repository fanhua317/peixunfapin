#!/usr/bin/env sh
set -eu

if [ -f ".env" ]; then
  set -a
  . ./.env
  set +a
fi

export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-8787}"
export TRAINING_DATA_DIR="${TRAINING_DATA_DIR:-$(pwd)/data/training-index}"
export TRAINING_LLM_PROVIDER="${TRAINING_LLM_PROVIDER:-auto}"
export TRAINING_LLM_BASE_URL="${TRAINING_LLM_BASE_URL:-https://api.deepseek.com/v1}"
export TRAINING_LLM_MODEL="${TRAINING_LLM_MODEL:-deepseek-chat}"
export TRAINING_HYBRID_RETRIEVAL="${TRAINING_HYBRID_RETRIEVAL:-0}"

mkdir -p "$TRAINING_DATA_DIR"
exec node training-service/src/server.mjs

FROM node:24-bookworm-slim

WORKDIR /app

COPY training-service/package*.json ./training-service/
RUN cd training-service && npm ci --omit=dev

COPY training-service ./training-service

ENV HOST=0.0.0.0
ENV PORT=8787
ENV TRAINING_DATA_DIR=/app/data/training-index
ENV TRAINING_STORAGE=sqlite
ENV TRAINING_SQLITE_BUSY_TIMEOUT_MS=5000

EXPOSE 8787

CMD ["node", "training-service/src/server.mjs"]

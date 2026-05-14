FROM node:24-alpine

WORKDIR /app

COPY training-service ./training-service

ENV HOST=0.0.0.0
ENV PORT=8787
ENV TRAINING_DATA_DIR=/app/data/training-index

EXPOSE 8787

CMD ["node", "training-service/src/server.mjs"]

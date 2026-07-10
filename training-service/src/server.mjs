import http from "node:http";
import { createApp } from "./http/app.mjs";
import { handleAgentStreamUpgrade } from "./http/agent-stream.mjs";
import { startJobScheduler } from "./jobs/scheduler.mjs";
import { initializeOpenTelemetry, shutdownOpenTelemetry } from "./observability/telemetry.mjs";

await initializeOpenTelemetry();

const port = Number(process.env.PORT || process.env.TRAINING_SERVICE_PORT || 8787);
const host = process.env.HOST || "127.0.0.1";
const context = { host, port };
const server = http.createServer(createApp(context));

server.on("upgrade", (req, socket, head) => {
  if (handleAgentStreamUpgrade(req, socket, head, context)) return;
  socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
  socket.destroy();
});

startJobScheduler().catch((error) => {
  console.error("Failed to start job scheduler", error);
});

server.listen(port, host, () => {
  console.log(`Juzhou Agent training service listening at http://${host}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    server.close(() => {
      shutdownOpenTelemetry()
        .catch((error) => console.warn("OpenTelemetry shutdown failed:", error instanceof Error ? error.message : String(error)))
        .finally(() => process.exit(0));
    });
  });
}

import http from "node:http";
import { createApp } from "./http/app.mjs";
import { handleAgentStreamUpgrade } from "./http/agent-stream.mjs";
import { startJobScheduler } from "./jobs/scheduler.mjs";

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

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createTrainingTools } from "./tools";

export default definePluginEntry({
  id: "training-rag",
  name: "Training RAG",
  description: "OpenClaw tools for the external training-service Web MVP",
  register(api) {
    for (const tool of createTrainingTools(api)) {
      api.registerTool(tool);
    }
  },
});

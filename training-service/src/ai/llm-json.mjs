import { askLLM } from "../llm.mjs";
import { AI_PROFILE, TRAINING_AI_SESSION_KEY } from "./config.mjs";

export function extractJsonObject(text) {
  const raw = String(text || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const unfenced = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const source = fenced ? fenced[1].trim() : unfenced;
  const candidate = source.slice(source.indexOf("{"), source.lastIndexOf("}") + 1);
  if (!candidate || !candidate.startsWith("{")) throw new Error("OpenClaw did not return a JSON object");
  return JSON.parse(candidate);
}

export async function askLlmJson({ purpose, prompt, profile }) {
  const result = await askLLM(prompt, {
    sessionKey: `${TRAINING_AI_SESSION_KEY}:${purpose}`,
    thinking: profile.thinking,
    model: profile.model,
    timeoutMs: profile.timeoutMs,
    temperature: profile.temperature,
  });
  return {
    data: extractJsonObject(result.answer),
    raw: result.answer,
    runId: result.runId,
    source: result.source || "openclaw",
    thinking: result.thinking || profile.thinking,
    model: result.model || profile.model,
    finishReason: result.finishReason || "",
    truncated: result.truncated === true || result.finishReason === "length",
    usage: result.usage,
    sessionPatch: result.sessionPatch,
  };
}

export async function askLlmStructured({ purpose, prompt, profile, repairSchema }) {
  const result = await askLLM(prompt, {
    sessionKey: `${TRAINING_AI_SESSION_KEY}:${purpose}`,
    thinking: profile.thinking,
    model: profile.model,
    timeoutMs: profile.timeoutMs,
    temperature: profile.temperature,
  });
  try {
    return {
      data: extractJsonObject(result.answer),
      raw: result.answer,
      runId: result.runId,
      source: result.source || "openclaw",
      thinking: result.thinking || profile.thinking,
      model: result.model || profile.model,
      finishReason: result.finishReason || "",
      truncated: result.truncated === true || result.finishReason === "length",
      usage: result.usage,
      sessionPatch: result.sessionPatch,
      format: "json",
    };
  } catch (error) {
    if (repairSchema) {
      try {
        const repairProfile = AI_PROFILE.repair;
        const repair = await askLLM(`请把下面内容转换成严格 JSON 对象。只能输出 JSON，不要 Markdown，不要解释。目标格式：${JSON.stringify(repairSchema)}\n\n原始内容：\n${result.answer}`, {
          sessionKey: `${TRAINING_AI_SESSION_KEY}:${purpose}:repair`,
          thinking: repairProfile.thinking,
          model: repairProfile.model,
          timeoutMs: repairProfile.timeoutMs,
        });
        return {
          data: extractJsonObject(repair.answer),
          raw: repair.answer,
          runId: repair.runId,
          source: repair.source || "openclaw",
          thinking: repair.thinking || repairProfile.thinking,
          model: repair.model || repairProfile.model,
          finishReason: repair.finishReason || result.finishReason || "",
          truncated: repair.truncated === true || repair.finishReason === "length" || result.truncated === true || result.finishReason === "length",
          usage: repair.usage || result.usage,
          sessionPatch: repair.sessionPatch,
          format: "json",
          repaired: true,
        };
      } catch {
      }
    }
    return {
      data: null,
      raw: result.answer,
      runId: result.runId,
      source: result.source || "openclaw",
      thinking: result.thinking || profile.thinking,
      model: result.model || profile.model,
      finishReason: result.finishReason || "",
      truncated: result.truncated === true || result.finishReason === "length",
      usage: result.usage,
      sessionPatch: result.sessionPatch,
      format: "text",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

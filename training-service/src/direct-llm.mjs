const DEFAULT_TIMEOUT_MS = Number(process.env.TRAINING_LLM_TIMEOUT_MS || process.env.OPENCLAW_CHAT_TIMEOUT_MS || 120_000);
const DEFAULT_TEMPERATURE = Number(process.env.TRAINING_LLM_TEMPERATURE || 0.2);
const DEFAULT_MAX_TOKENS = Number(process.env.TRAINING_LLM_MAX_TOKENS || 4096);

export function resolveDirectApiKey() {
  return process.env.TRAINING_LLM_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || "";
}

export function resolveDirectBaseUrl() {
  if (process.env.TRAINING_LLM_BASE_URL) return process.env.TRAINING_LLM_BASE_URL;
  if (process.env.OPENAI_BASE_URL) return process.env.OPENAI_BASE_URL;
  if (process.env.DEEPSEEK_BASE_URL) return process.env.DEEPSEEK_BASE_URL;
  return process.env.OPENAI_API_KEY && !process.env.DEEPSEEK_API_KEY
    ? "https://api.openai.com/v1"
    : "https://api.deepseek.com/v1";
}

export function resolveDirectModel(options = {}) {
  const candidate = String(options.model || "").trim();
  if (candidate && !candidate.includes("/")) return candidate;
  const configured = process.env.TRAINING_LLM_MODEL || process.env.DEEPSEEK_MODEL || process.env.OPENAI_MODEL;
  if (configured) return configured;
  return process.env.OPENAI_API_KEY && !process.env.DEEPSEEK_API_KEY ? "gpt-4.1-mini" : "deepseek-chat";
}

function chatCompletionsUrl(baseUrl) {
  const trimmed = String(baseUrl || "").replace(/\/+$/, "");
  return /\/chat\/completions$/i.test(trimmed) ? trimmed : `${trimmed}/chat/completions`;
}

function isTemperatureOneRequiredError(message) {
  return /invalid temperature/i.test(String(message || "")) && /only\s+1\s+is\s+allowed/i.test(String(message || ""));
}

async function postChatCompletion(body, signal) {
  const response = await fetch(chatCompletionsUrl(resolveDirectBaseUrl()), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${resolveDirectApiKey()}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const detail = payload?.error?.message || payload?.message || text || response.statusText;
    const error = new Error(`LLM API request failed: ${detail}`);
    error.detail = detail;
    throw error;
  }
  return payload;
}

async function fetchChatCompletionStream(body, signal) {
  const response = await fetch(chatCompletionsUrl(resolveDirectBaseUrl()), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${resolveDirectApiKey()}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
    }
    const detail = payload?.error?.message || payload?.message || text || response.statusText;
    const error = new Error(`LLM API request failed: ${detail}`);
    error.detail = detail;
    throw error;
  }
  if (!response.body) throw new Error("LLM API returned no stream body");
  return response.body;
}

export function getDirectLlmRuntimeConfig(options = {}) {
  const apiKeyConfigured = Boolean(resolveDirectApiKey());
  return {
    provider: "openai-compatible",
    apiKeyConfigured,
    directConfigured: apiKeyConfigured,
    baseUrl: resolveDirectBaseUrl(),
    model: resolveDirectModel(options),
  };
}

export async function askOpenAiCompatibleLLM(message, options = {}) {
  const apiKey = resolveDirectApiKey();
  if (!apiKey) {
    throw new Error("TRAINING_LLM_API_KEY, DEEPSEEK_API_KEY, or OPENAI_API_KEY is required for direct LLM calls");
  }
  const model = resolveDirectModel(options);
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const messages = [];
  if (options.system) messages.push({ role: "system", content: String(options.system) });
  messages.push({ role: "user", content: String(message || "") });
  const body = {
    model,
    messages,
    temperature: Number(options.temperature ?? DEFAULT_TEMPERATURE),
    stream: false,
  };
  if (DEFAULT_MAX_TOKENS > 0) body.max_tokens = DEFAULT_MAX_TOKENS;

  try {
    let payload;
    try {
      payload = await postChatCompletion(body, controller.signal);
    } catch (error) {
      if (body.temperature !== 1 && isTemperatureOneRequiredError(error.detail || error.message)) {
        payload = await postChatCompletion({ ...body, temperature: 1 }, controller.signal);
      } else {
        throw error;
      }
    }
    const answer = payload?.choices?.[0]?.message?.content || payload?.choices?.[0]?.text || "";
    if (!answer) throw new Error("LLM API returned no assistant content");
    return {
      answer,
      source: "llm-api",
      provider: "openai-compatible",
      model,
      thinking: options.thinking || options.thinkingLevel,
      usage: payload?.usage,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function* streamOpenAiCompatibleLLM(message, options = {}) {
  const apiKey = resolveDirectApiKey();
  if (!apiKey) {
    throw new Error("TRAINING_LLM_API_KEY, DEEPSEEK_API_KEY, or OPENAI_API_KEY is required for direct LLM calls");
  }
  const model = resolveDirectModel(options);
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromCaller = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", abortFromCaller, { once: true });
  }
  const messages = [];
  if (options.system) messages.push({ role: "system", content: String(options.system) });
  messages.push({ role: "user", content: String(message || "") });
  const body = {
    model,
    messages,
    temperature: Number(options.temperature ?? DEFAULT_TEMPERATURE),
    stream: true,
  };
  if (DEFAULT_MAX_TOKENS > 0) body.max_tokens = DEFAULT_MAX_TOKENS;

  try {
    let stream;
    try {
      stream = await fetchChatCompletionStream(body, controller.signal);
    } catch (error) {
      if (body.temperature !== 1 && isTemperatureOneRequiredError(error.detail || error.message)) {
        stream = await fetchChatCompletionStream({ ...body, temperature: 1 }, controller.signal);
      } else {
        throw error;
      }
    }
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        const payload = JSON.parse(data);
        const choice = payload?.choices?.[0] || {};
        const delta = choice.delta?.content || choice.text || "";
        if (delta) {
          yield {
            delta,
            source: "llm-api",
            provider: "openai-compatible",
            model,
            thinking: options.thinking || options.thinkingLevel,
          };
        }
      }
    }
    buffer += decoder.decode();
  } finally {
    clearTimeout(timeout);
    if (options.signal) options.signal.removeEventListener("abort", abortFromCaller);
  }
}

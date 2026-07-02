import http from "node:http";

process.env.TRAINING_HYBRID_RETRIEVAL = "0";
process.env.TRAINING_LLM_PROVIDER = "openai-compatible";
process.env.TRAINING_LLM_API_KEY = "marketing-length-eval-key";
process.env.TRAINING_LLM_MODEL = "marketing-length-eval-mock";
process.env.TRAINING_LLM_TIMEOUT_MS = "5000";

let mockServer = null;
let capturedPrompt = "";
const capturedPrompts = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function longArticle() {
  const paragraph = "YINJIA pump manufacturing combines stable motor design, careful impeller processing, and practical quality checks for long-term customer value. ";
  return paragraph.repeat(22);
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw;
}

async function startMockServer() {
  mockServer = http.createServer(async (req, res) => {
    const rawBody = await readBody(req);
    try {
      const body = JSON.parse(rawBody || "{}");
      capturedPrompt = String(body.messages?.find((message) => message.role === "user")?.content || "");
      capturedPrompts.push(capturedPrompt);
    } catch {
      capturedPrompt = "";
    }
    if (req.method !== "POST" || !String(req.url || "").endsWith("/chat/completions")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl-marketing-length-eval",
      object: "chat.completion",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: JSON.stringify({
            title: "Long YINJIA Pump Article",
            summary: "A longer article used to verify server-side cleaning does not silently cut marketing copy at 1800 characters.",
            article: longArticle(),
            sellingPoints: ["Stable manufacturing", "Practical quality control"],
            sourceRefs: ["fixture.md #1"],
            warnings: [],
          }),
        },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
  await new Promise((resolve, reject) => {
    mockServer.once("error", reject);
    mockServer.listen(0, "127.0.0.1", () => {
      mockServer.off("error", reject);
      resolve();
    });
  });
  const address = mockServer.address();
  process.env.TRAINING_LLM_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
}

async function stopMockServer() {
  if (!mockServer) return;
  await new Promise((resolve, reject) => {
    mockServer.close((error) => (error ? reject(error) : resolve()));
  });
  mockServer = null;
}

try {
  await startMockServer();
  const { generateMarketingArticle } = await import("../src/ai/marketing.mjs");
  const state = {
    knowledgeBases: [{
      id: "kb-pump",
      name: "YINJIA pump knowledge base",
      aliases: ["pump", "YINJIA"],
      status: "ready",
    }],
    chunks: [{
      id: "chunk-1",
      knowledgeBaseId: "kb-pump",
      documentId: "doc-1",
      sourceRef: "fixture.md #1",
      heading: "YINJIA pump manufacturing",
      content: "YINJIA pump motor rotor impeller manufacturing quality control customer article pump sales support stable efficient durable service.",
      searchText: "YINJIA pump motor rotor impeller manufacturing quality control customer article",
    }],
    chunkParents: [],
  };
  const result = await generateMarketingArticle(state, {
    instruction: "write a detailed YINJIA pump customer marketing article",
    memoryContext: { longTerm: [], recentMessages: [] },
  });
  assert(capturedPrompts.some((prompt) => prompt.includes("Avoid generic AI templates")), "prompt should include anti-template AI-style guidance");
  assert(capturedPrompts.some((prompt) => prompt.includes("repeated openings") && prompt.includes("overused endings")), "prompt should discourage generic repeated phrasing");
  assert(capturedPrompts.some((prompt) => prompt.includes("Do not invent facts")), "prompt should preserve factual grounding while improving style");
  assert(result.article.length > 2400, `article should keep long content, got ${result.article.length}`);
  assert(!result.article.trim().endsWith("..."), "article should not be hard-cut with ellipsis");
  assert(result.finishReason === "stop", `finishReason should propagate, got ${result.finishReason}`);
  assert(result.truncated !== true, "stop finishReason should not be marked truncated");
  console.log(JSON.stringify({
    ok: true,
    promptStyleGuidance: true,
    articleLength: result.article.length,
    finishReason: result.finishReason,
    truncated: result.truncated,
  }, null, 2));
} catch (error) {
  console.error(error);
  console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  await stopMockServer();
}

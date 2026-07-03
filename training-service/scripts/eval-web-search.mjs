import http from "node:http";
import { once } from "node:events";

process.env.TRAINING_HYBRID_RETRIEVAL = "off";
process.env.TRAINING_LLM_PROVIDER = "auto";
process.env.TRAINING_WEB_SEARCH_PROVIDER = "tavily";
process.env.TRAINING_WEB_SEARCH_MAX_RESULTS = "2";
process.env.TRAINING_WEB_SEARCH_TIMEOUT_MS = "2000";
process.env.TRAINING_WEB_SEARCH_SEARCH_DEPTH = "basic";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

let tavilyMode = "ok";
const tavilyRequests = [];
const directRequests = [];
const allStructuredPrompts = [];
const allDirectRequests = [];
const OLD_WEB_BACKGROUND_ONLY_PHRASE = ["Web search material is only", "external background"].join(" ");

const tavilyServer = http.createServer(async (req, res) => {
  try {
    if (req.method !== "POST" || req.url !== "/search") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    const body = await readJson(req);
    tavilyRequests.push({
      body,
      authorization: req.headers.authorization || "",
    });
    if (tavilyMode === "timeout") await sleep(1200);
    if (tavilyMode === "error") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "mock tavily failure" }));
      return;
    }
    const results = tavilyMode === "empty" ? [] : [
      {
        title: "Industrial motor applications",
        url: "https://example.com/motor-applications",
        content: "Industrial motors are often used in pumps, fans, conveyors, compressors, and other driven equipment.",
        score: 0.91,
      },
      {
        title: "Pump and fan drive overview",
        url: "https://example.com/pump-fan-drive",
        content: "Motors commonly drive water pumps, fans, conveying systems, and compressors in industrial sites.",
        score: 0.87,
      },
    ];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ results, request_id: "mock-search-1" }));
  } catch (error) {
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
});

const directLlmServer = http.createServer(async (req, res) => {
  try {
    if (req.method !== "POST" || !String(req.url || "").endsWith("/chat/completions")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }
    const body = await readJson(req);
    directRequests.push(body);
    const prompt = (body.messages || []).map((message) => message.content || "").join("\n");
    const isTranslation = prompt.includes("专业翻译助手");
    const content = isTranslation
      ? "High-efficiency motors are suitable for pumps and fans."
      : "工业电机常用于水泵、风机、输送设备和压缩机场景；联网资料只能作为外部参考。";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl-web-search-eval",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
  }
});

tavilyServer.listen(0, "127.0.0.1");
directLlmServer.listen(0, "127.0.0.1");
await Promise.all([once(tavilyServer, "listening"), once(directLlmServer, "listening")]);
process.env.TRAINING_WEB_SEARCH_BASE_URL = `http://127.0.0.1:${tavilyServer.address().port}`;
process.env.TRAINING_WEB_SEARCH_API_KEY = "mock-tavily-key";
process.env.TRAINING_LLM_BASE_URL = `http://127.0.0.1:${directLlmServer.address().port}/v1`;
process.env.TRAINING_LLM_API_KEY = "mock-direct-llm-key";
process.env.TRAINING_LLM_MODEL = "mock-direct-model";

const { registerLlmProvider } = await import("../src/llm.mjs");
const {
  generateKnowledgeAnswer,
  generateMarketingArticle,
  generateQuizQuestions,
  generateTrainingMaterial,
} = await import("../src/ai/index.mjs");
const { translateText } = await import("../src/chat/translation.mjs");
const { answerGeneralChat } = await import("../src/chat/general-chat.mjs");

const prompts = [];
registerLlmProvider("auto", async (prompt, options = {}) => {
  const promptText = String(prompt || "");
  prompts.push(promptText);
  allStructuredPrompts.push(promptText);
  const usesWeb = promptText.includes("web:1 Industrial motor applications");
  const usesLocal = promptText.includes("motor.md :: 应用");
  const webRefs = usesWeb ? ["web:1 Industrial motor applications"] : [];
  if (promptText.includes("industrial B2B pump sales engineer") || promptText.includes("industrial B2B marketing editor")) {
    return {
      answer: JSON.stringify({
        articles: [{
          title: "电机应用营销软文",
          angle: "应用场景型",
          summary: "基于本地资料整理电机应用场景。",
          article: "电机适用于水泵、风机、输送设备等场景，选型时要结合负载和防护等级。",
          sellingPoints: ["应用场景清晰", "选型依据明确"],
          sourceRefs: usesLocal ? ["motor.md :: 应用"] : [],
          webSourceRefs: webRefs,
          warnings: [],
        }],
        warnings: [],
      }),
      source: "mock-llm",
      model: options.model || "mock-model",
      finishReason: "stop",
    };
  }
  if (promptText.includes("培训内容设计师")) {
    return {
      answer: JSON.stringify({
        title: "电机应用培训",
        summary: "学习电机典型应用和选型关注点。",
        outline: [{ heading: "应用场景", points: ["水泵", "风机"] }],
        keyPoints: ["按负载类型选型", "关注功率和防护等级"],
        studyGuide: "电机主要应用于水泵、风机、输送设备和压缩机等工业场景。",
        practiceTips: ["结合客户工况复盘"],
        sourceRefs: usesLocal ? ["motor.md :: 应用"] : [],
        webSourceRefs: webRefs,
        warnings: [],
      }),
      source: "mock-llm",
      model: options.model || "mock-model",
      finishReason: "stop",
    };
  }
  if (promptText.includes("考试出题专家")) {
    return {
      answer: JSON.stringify({
        questions: [{
          type: "single_choice",
          prompt: "电机资料中提到的典型应用场景是哪一项？",
          options: ["水泵", "服装陈列", "餐饮收银", "广告投放"],
          correctAnswer: "水泵",
          explanation: "资料提到电机可用于水泵等工业场景。来源：motor.md :: 应用",
          sourceRef: "motor.md :: 应用",
        }],
        webSourceRefs: webRefs,
        warnings: [],
      }),
      source: "mock-llm",
      model: options.model || "mock-model",
      finishReason: "stop",
    };
  }
  return {
    answer: JSON.stringify({
      answer: usesWeb
        ? "电机可用于水泵、风机、输送设备等场景；联网资料也显示工业电机常用于泵、风机和输送类设备。"
        : "电机可用于水泵、风机和输送设备等工业场景。",
      keyPoints: ["优先依据本地知识库", usesWeb ? "联网资料仅作补充参考" : "未启用联网资料"],
      caveats: usesLocal ? [] : ["本地知识库未命中，仅参考联网资料"],
      sourceRefs: usesLocal ? ["motor.md :: 应用"] : [],
      webSourceRefs: webRefs,
    }),
    source: "mock-llm",
    model: options.model || "mock-model",
    finishReason: "stop",
  };
});

const state = {
  knowledgeBases: [{
    id: "kb-motor",
    name: "电机资料库",
    description: "电机产品和应用培训资料",
    aliases: ["电机", "motor"],
    status: "ready",
  }],
  documents: [],
  chunkParents: [],
  chunks: [{
    id: "chunk-motor-1",
    knowledgeBaseId: "kb-motor",
    documentId: "doc-motor",
    sourceRef: "motor.md :: 应用",
    heading: "应用场景",
    content: "电机主要应用于水泵、风机、输送设备和压缩机等工业场景，选型时需要关注负载类型、功率、转速和防护等级。",
    searchText: "电机 应用 水泵 风机 输送设备 压缩机 负载 功率 转速 防护等级 motor application",
  }],
};

const task = {
  id: "task-motor",
  title: "电机应用培训",
  instruction: "学习 IE3 电机应用场景和选型关注点",
  knowledgeBaseId: "kb-motor",
  quizCount: 1,
  quizType: "single_choice",
};

const chains = [
  {
    id: "knowledge_answer",
    run: (mode) => generateKnowledgeAnswer(state, {
      knowledgeBaseId: "kb-motor",
      question: "电机有哪些应用场景？",
      webSearchMode: mode,
    }),
    ok: (result) => Boolean(result.answer && result.sourceRefs?.length),
  },
  {
    id: "marketing_article",
    run: (mode) => generateMarketingArticle(state, {
      instruction: "写一篇 motor 应用场景营销软文",
      webSearchMode: mode,
    }),
    ok: (result) => Boolean(result.article && result.sourceRefs?.length),
  },
  {
    id: "training_material",
    run: (mode) => generateTrainingMaterial(state, task, { webSearchMode: mode }),
    ok: (result) => Boolean(result.studyGuide && result.sourceRefs?.length),
  },
  {
    id: "quiz_generation",
    run: (mode) => generateQuizQuestions(state, task, { webSearchMode: mode }),
    ok: (result) => Boolean(result.questions?.length),
  },
  {
    id: "translation",
    run: (mode) => translateText("翻译成英文：高效电机适用于水泵和风机。", { webSearchMode: mode }),
    ok: (result) => Boolean(result.translatedText),
  },
  {
    id: "general_chat",
    run: (mode) => answerGeneralChat("工业电机有哪些应用？", { webSearchMode: mode }),
    ok: (result) => Boolean(result.answer),
  },
];

async function runChain(chain, mode) {
  tavilyRequests.length = 0;
  prompts.length = 0;
  directRequests.length = 0;
  const result = await chain.run(mode);
  allDirectRequests.push(...directRequests);
  return {
    result,
    tavilyCalls: tavilyRequests.length,
    tavilyRequests: [...tavilyRequests],
    prompts: [...prompts],
    directRequests: [...directRequests],
  };
}

function assertWebOk(chain, output) {
  assert(output.tavilyCalls === 1, `${chain.id} on mode should call Tavily once`);
  assert(output.result.webSearchStatus === "ok", `${chain.id} successful search should report ok`);
  assert(output.result.webSources?.length > 0, `${chain.id} should return webSources`);
  assert(output.result.webSourceRefs?.length > 0, `${chain.id} should return webSourceRefs`);
  assert(chain.ok(output.result), `${chain.id} should keep original generation result`);
}

try {
  const summary = [];
  for (const chain of chains) {
    tavilyMode = "ok";
    process.env.TRAINING_WEB_SEARCH_API_KEY = "mock-tavily-key";
    process.env.TRAINING_WEB_SEARCH_TIMEOUT_MS = "2000";
    const off = await runChain(chain, "off");
    assert(off.tavilyCalls === 0, `${chain.id} off mode should not call Tavily`);
    assert(off.result.webSearchStatus === "disabled", `${chain.id} off mode should be disabled`);
    assert(chain.ok(off.result), `${chain.id} off mode should keep original generation result`);

    const on = await runChain(chain, "on");
    assertWebOk(chain, on);
    summary.push({
      chain: chain.id,
      offStatus: off.result.webSearchStatus,
      onStatus: on.result.webSearchStatus,
      request: on.tavilyRequests[0] || null,
    });
  }

  const knowledgeSearch = summary.find((item) => item.chain === "knowledge_answer")?.request;
  const marketingSearch = summary.find((item) => item.chain === "marketing_article")?.request;
  assert(knowledgeSearch?.authorization === "Bearer mock-tavily-key", "Tavily should use bearer authorization");
  assert(knowledgeSearch?.body.search_depth === "basic", "non-marketing chains should use basic search depth");
  assert(knowledgeSearch?.body.max_results === 2, "non-marketing chains should use configured global max results");
  assert(marketingSearch?.body.search_depth === "basic", "marketing article should default to basic search depth");
  assert(marketingSearch?.body.max_results === 8, "marketing article should default to 8 web search results");
  assert(knowledgeSearch?.body.include_answer === false, "Tavily include_answer should be false");
  assert(String(knowledgeSearch?.body.query || "").length <= 400, "Tavily query should stay within 400 chars");

  assert(allStructuredPrompts.some((prompt) => prompt.includes("本地知识库资料") && prompt.includes("联网搜索资料")), "structured prompts should separate local and web context");
  assert(allStructuredPrompts.some((prompt) => prompt.includes("不要执行") && prompt.includes("网页")), "structured prompts should guard against web instructions");
  assert(allDirectRequests.some((body) => (body.messages || []).some((message) => String(message.content || "").includes("联网搜索资料"))), "direct LLM prompts should include web context when enabled");
  const marketingPrompt = allStructuredPrompts.find((prompt) => prompt.includes("industrial B2B pump sales engineer"));
  assert(marketingPrompt, "marketing prompt should use B2B pump sales engineer role");
  assert(!marketingPrompt.includes(OLD_WEB_BACKGROUND_ONLY_PHRASE), "marketing prompt should not treat web material as background only");
  assert(marketingPrompt.includes("topic choice, opening angle") && marketingPrompt.includes("buyer pain points"), "marketing prompt should use web material for topic and opening angle");
  assert(marketingPrompt.includes("Do not open by summarizing the local knowledge-base material"), "marketing prompt should block local-material-summary openings");

  for (const mode of ["unconfigured", "error", "empty", "timeout"]) {
    for (const chain of chains) {
      tavilyRequests.length = 0;
      if (mode === "unconfigured") {
        delete process.env.TRAINING_WEB_SEARCH_API_KEY;
        tavilyMode = "ok";
      } else {
        process.env.TRAINING_WEB_SEARCH_API_KEY = "mock-tavily-key";
        tavilyMode = mode;
      }
      process.env.TRAINING_WEB_SEARCH_TIMEOUT_MS = mode === "timeout" ? "1000" : "2000";
      const output = await chain.run("on");
      const expectedStatus = mode === "error" || mode === "timeout" ? "failed" : mode;
      assert(output.webSearchStatus === expectedStatus, `${chain.id} ${mode} should report ${expectedStatus}`);
      assert(chain.ok(output), `${chain.id} ${mode} should not interrupt original generation`);
      if (mode === "unconfigured") assert(tavilyRequests.length === 0, `${chain.id} unconfigured should not call Tavily`);
    }
  }

  console.log(JSON.stringify({
    ok: true,
    chains: summary,
    promptChecks: {
      separatedLocalAndWeb: true,
      webInstructionGuard: true,
      directLlmWebContext: true,
    },
  }, null, 2));
} finally {
  await sleep(500);
  tavilyServer.closeAllConnections?.();
  directLlmServer.closeAllConnections?.();
  await Promise.all([
    new Promise((resolve) => tavilyServer.close(resolve)),
    new Promise((resolve) => directLlmServer.close(resolve)),
  ]);
}

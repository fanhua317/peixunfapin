const DEFAULT_SERVICE_NAME = "juzhou-agent-training-service";
const DEFAULT_OTLP_ENDPOINT = "http://127.0.0.1:4318/v1/traces";

let api = null;
let sdk = null;
let initialization = null;
let runtimeStatus = {
  enabled: false,
  initialized: false,
  status: "disabled",
  exporter: "otlp-http",
  endpoint: "",
  serviceName: DEFAULT_SERVICE_NAME,
  error: "",
};

function enabledByEnvironment() {
  return ["1", "true", "yes", "on"].includes(String(process.env.TRAINING_OTEL_ENABLED || "").toLowerCase());
}

function cleanAttribute(value) {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  return String(value).slice(0, 240);
}

function cleanAttributes(attributes = {}) {
  return Object.fromEntries(Object.entries(attributes)
    .map(([key, value]) => [key, cleanAttribute(value)])
    .filter(([, value]) => value !== undefined));
}

function safeEndpoint(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (!new Set(["http:", "https:"]).has(url.protocol)) return "[configured-invalid-url]";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[configured-invalid-url]";
  }
}

export function sanitizeTelemetryEndpointForStatus(value) {
  return safeEndpoint(value);
}

function safeErrorType(error) {
  const raw = error && typeof error === "object"
    ? (error.code || error.name || error.constructor?.name)
    : "Error";
  const value = String(raw || "Error").replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 80);
  return value || "Error";
}

function markSpanError(span, error) {
  if (!span || !api) return;
  const type = safeErrorType(error);
  // Do not export raw exception messages or stacks: upstream errors can contain
  // prompt fragments, API keys, URLs, and local paths. The Run keeps a separate
  // redacted business error while telemetry only carries a stable type.
  span.setAttribute("error.type", type);
  span.setStatus({ code: api.SpanStatusCode.ERROR, message: "operation_failed" });
}

export async function initializeOpenTelemetry() {
  if (initialization) return await initialization;
  initialization = (async () => {
    const enabled = enabledByEnvironment();
    const endpoint = process.env.TRAINING_OTEL_OTLP_ENDPOINT
      || process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
      || DEFAULT_OTLP_ENDPOINT;
    const serviceName = process.env.TRAINING_OTEL_SERVICE_NAME
      || process.env.OTEL_SERVICE_NAME
      || DEFAULT_SERVICE_NAME;
    if (!enabled) {
      runtimeStatus = {
        ...runtimeStatus,
        enabled: false,
        initialized: false,
        status: "disabled",
        endpoint: "",
        serviceName,
        error: "",
      };
      return runtimeStatus;
    }

    runtimeStatus = {
      ...runtimeStatus,
      enabled: true,
      initialized: false,
      status: "starting",
      endpoint: safeEndpoint(endpoint),
      serviceName,
      error: "",
    };
    try {
      if (!process.env.OTEL_SERVICE_NAME) process.env.OTEL_SERVICE_NAME = serviceName;
      const [apiModule, sdkModule, exporterModule] = await Promise.all([
        import("@opentelemetry/api"),
        import("@opentelemetry/sdk-node"),
        import("@opentelemetry/exporter-trace-otlp-http"),
      ]);
      const exporter = new exporterModule.OTLPTraceExporter({ url: endpoint });
      sdk = new sdkModule.NodeSDK({ traceExporter: exporter });
      await sdk.start();
      api = apiModule;
      runtimeStatus = {
        ...runtimeStatus,
        initialized: true,
        status: "ready",
      };
    } catch (error) {
      runtimeStatus = {
        ...runtimeStatus,
        initialized: false,
        status: "error",
        error: safeErrorType(error),
      };
      console.warn("OpenTelemetry initialization failed:", runtimeStatus.error);
    }
    return runtimeStatus;
  })();
  return await initialization;
}

export function getOpenTelemetryStatus() {
  const enabled = enabledByEnvironment();
  if (!enabled && runtimeStatus.status !== "disabled") {
    return { ...runtimeStatus, enabled: false, initialized: false, status: "disabled", endpoint: "", error: "" };
  }
  return { ...runtimeStatus };
}

export async function shutdownOpenTelemetry() {
  if (!sdk) return;
  const activeSdk = sdk;
  sdk = null;
  try {
    await activeSdk.shutdown();
  } finally {
    api = null;
    runtimeStatus = {
      ...runtimeStatus,
      initialized: false,
      status: "stopped",
    };
  }
}

export async function withTelemetrySpan(name, attributes, fn) {
  if (!api || runtimeStatus.status !== "ready") return await fn(null);
  const tracer = api.trace.getTracer("juzhou-agent-training-service");
  return await tracer.startActiveSpan(name, { attributes: cleanAttributes(attributes) }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: api.SpanStatusCode.OK });
      return result;
    } catch (error) {
      markSpanError(span, error);
      throw error;
    } finally {
      span.end();
    }
  });
}

export function startTelemetrySpan(name, attributes = {}) {
  if (!api || runtimeStatus.status !== "ready") return null;
  return api.trace.getTracer("juzhou-agent-training-service").startSpan(name, {
    attributes: cleanAttributes(attributes),
  });
}

export function finishTelemetrySpan(span, { attributes = {}, error = null } = {}) {
  if (!span || !api) return;
  span.setAttributes(cleanAttributes(attributes));
  if (error || attributes["llm.success"] === false || attributes.success === false) {
    markSpanError(span, error || { name: "OperationFailed" });
  } else {
    span.setStatus({ code: api.SpanStatusCode.OK });
  }
  span.end();
}

export function setActiveSpanAttributes(attributes = {}) {
  if (!api || runtimeStatus.status !== "ready") return;
  const span = api.trace.getActiveSpan();
  if (span) span.setAttributes(cleanAttributes(attributes));
}

export function recordCompletedSpan(name, attributes = {}, timing = {}) {
  if (!api || runtimeStatus.status !== "ready") return;
  const tracer = api.trace.getTracer("juzhou-agent-training-service");
  const startedAt = timing.startedAt ? new Date(timing.startedAt) : undefined;
  const finishedAt = timing.finishedAt ? new Date(timing.finishedAt) : undefined;
  const span = tracer.startSpan(name, {
    attributes: cleanAttributes(attributes),
    ...(startedAt && !Number.isNaN(startedAt.valueOf()) ? { startTime: startedAt } : {}),
  });
  if (attributes.success === false || attributes.status === "failed") {
    span.setStatus({ code: api.SpanStatusCode.ERROR });
  } else {
    span.setStatus({ code: api.SpanStatusCode.OK });
  }
  span.end(finishedAt && !Number.isNaN(finishedAt.valueOf()) ? finishedAt : undefined);
}

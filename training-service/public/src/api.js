let unauthorizedHandler = null;

export function setUnauthorizedHandler(handler) {
  unauthorizedHandler = handler;
}

export async function api(path, options = {}) {
  const headers = options.body instanceof FormData
    ? { ...(options.headers || {}) }
    : { "content-type": "application/json", ...(options.headers || {}) };
  const response = await fetch(path, {
    ...options,
    headers,
  });
  const payload = await response.json();
  if (response.status === 401) {
    if (unauthorizedHandler) unauthorizedHandler(payload.error || "请先输入访问密钥");
    throw new Error(payload.error || "access key required");
  }
  if (!response.ok) throw new Error(payload.error || response.statusText);
  return payload;
}

export class HttpError extends Error {
  constructor(statusCode, message, options = {}) {
    super(message, options);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.expose = options.expose ?? statusCode < 500;
  }
}

export function badRequest(message = "bad request") {
  return new HttpError(400, message);
}

export function decodePathSegment(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    throw badRequest("invalid URI encoding");
  }
}

export function decodePathname(value) {
  try {
    return decodeURI(String(value || "/"));
  } catch {
    throw badRequest("invalid URI encoding");
  }
}

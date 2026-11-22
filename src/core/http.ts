/**
 * Shared fetch wrapper: every outbound API call goes through here so that
 * timeouts, unreachable hosts and HTTP errors become a typed ApiError that
 * handlers can turn into a friendly message instead of crashing.
 */
import { log, redact } from "./logger.js";

export type ApiErrorKind = "timeout" | "network" | "http" | "parse";

export class ApiError extends Error {
  constructor(
    public readonly service: string,
    public readonly kind: ApiErrorKind,
    message: string,
    public readonly status?: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** True when the service could not be reached at all (as opposed to answering with an error). */
  get unreachable(): boolean {
    return this.kind === "timeout" || this.kind === "network" || (this.status !== undefined && this.status >= 502);
  }
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
  /** How to read the response body. Defaults to json. */
  as?: "json" | "text" | "buffer" | "none";
}

export interface RawResponse<T> {
  status: number;
  data: T;
}

let defaultTimeoutMs = 10_000;
export function setDefaultTimeout(ms: number) {
  defaultTimeoutMs = ms;
}

function buildUrl(base: string, query?: RequestOptions["query"]): string {
  if (!query) return base;
  const u = new URL(base);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/** Extracts a human-readable message from a JSON or text error body. */
function messageFrom(body: unknown): string | undefined {
  if (!body) return undefined;
  if (typeof body === "string") {
    // Plain text or an HTML error page: drop the markup.
    const plain = body.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return plain ? plain.slice(0, 200) : undefined;
  }
  if (typeof body === "object") {
    const b = body as Record<string, unknown>;
    for (const key of ["message", "error", "errorMessage", "detail"]) {
      if (typeof b[key] === "string" && b[key]) return (b[key] as string).slice(0, 200);
    }
    if (Array.isArray(body) && body[0] && typeof body[0] === "object") {
      const first = body[0] as Record<string, unknown>;
      if (typeof first.errorMessage === "string") return first.errorMessage;
    }
  }
  return undefined;
}

export async function requestRaw<T = unknown>(service: string, url: string, opts: RequestOptions = {}): Promise<RawResponse<T>> {
  const full = buildUrl(url, opts.query);
  const headers: Record<string, string> = { Accept: "application/json", ...opts.headers };
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] ??= "application/json";
    body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(full, {
      method: opts.method ?? "GET",
      headers,
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? defaultTimeoutMs),
      redirect: "follow",
    });
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    if (e.name === "TimeoutError" || e.name === "AbortError") {
      throw new ApiError(service, "timeout", `${service} did not respond in time`);
    }
    const code = e.cause?.code ? ` (${e.cause.code})` : "";
    log.debug(`http: ${service} ${opts.method ?? "GET"} ${redact(full)} failed${code}`);
    throw new ApiError(service, "network", `could not reach ${service}${code}`);
  }

  const as = opts.as ?? "json";
  let data: unknown;
  let text: string | undefined;
  try {
    if (as === "buffer") data = Buffer.from(await res.arrayBuffer());
    else if (as === "none") data = undefined;
    else {
      text = await res.text();
      if (as === "text") data = text;
      else data = text ? JSON.parse(text) : undefined;
    }
  } catch {
    if (!res.ok) {
      // Not JSON (often a firewall's HTML page): keep a short, tag-free snippet for the log.
      const snippet = (text ?? "").replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
      throw new ApiError(service, "http", `${service} returned HTTP ${res.status}${snippet ? `: ${snippet}` : ""}`, res.status, text);
    }
    throw new ApiError(service, "parse", `${service} returned a response that isn't valid JSON`, res.status);
  }

  if (!res.ok) {
    const detail = messageFrom(data);
    throw new ApiError(service, "http", `${service} returned HTTP ${res.status}${detail ? `: ${detail}` : ""}`, res.status, data);
  }
  return { status: res.status, data: data as T };
}

export async function request<T = unknown>(service: string, url: string, opts: RequestOptions = {}): Promise<T> {
  return (await requestRaw<T>(service, url, opts)).data;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Short, user-facing explanation for any error thrown by a handler. */
export function friendlyError(err: unknown): string {
  if (err instanceof ApiError) {
    const who = err.service;
    switch (err.kind) {
      case "timeout":
        return `⏱️ ${cap(who)} didn't answer in time. Try again in a minute.`;
      case "network":
        return `🔌 I couldn't reach ${who}. It might be down; try again in a bit.`;
      case "parse":
        return `⚠️ ${cap(who)} sent back something I couldn't read. The bot's owner should check its address.`;
      case "http":
        if (err.status === 401 || err.status === 403) return `🔑 ${cap(who)} didn't accept the bot's login. The bot's owner needs to check it.`;
        if (err.status && err.status >= 500) return `⚠️ ${cap(who)} had a problem. Try again shortly.`;
        return `⚠️ ${err.message}`;
    }
  }
  return "⚠️ Something went wrong on my side. The error was logged.";
}

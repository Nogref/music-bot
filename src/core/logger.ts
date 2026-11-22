/** Tiny levelled logger. Secrets in URLs (tokens/api keys in query strings) are redacted. */
type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
// Read lazily so LOG_LEVEL from bot.env (loaded after import) still applies.
const threshold = () => order[(process.env.LOG_LEVEL?.trim().toLowerCase() as Level) || "info"] ?? order.info;

// Includes Subsonic's t (token), s (salt) and p (password) parameters.
const SECRET_PARAMS = /([?&](?:apikey|api_key|X-Plex-Token|token|secret|t|s|p)=)[^&\s]+/gi;

export function redact(text: string): string {
  return text.replace(SECRET_PARAMS, "$1***");
}

function emit(level: Level, msg: string, extra?: unknown) {
  if (order[level] < threshold()) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${redact(msg)}`;
  const out = level === "error" || level === "warn" ? console.error : console.log;
  if (extra === undefined) out(line);
  else out(line, extra instanceof Error ? redact(extra.stack ?? extra.message) : extra);
}

export const log = {
  debug: (m: string, e?: unknown) => emit("debug", m, e),
  info: (m: string, e?: unknown) => emit("info", m, e),
  warn: (m: string, e?: unknown) => emit("warn", m, e),
  error: (m: string, e?: unknown) => emit("error", m, e),
};

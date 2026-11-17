type Level = "info" | "warn" | "error" | "debug";

const SECRET_KEY = /secret|private|keypair|base58/i;
const BOT_TOKEN = /\d{6,}:[A-Za-z0-9_-]{20,}/g;

function scrub(value: unknown): unknown {
  if (typeof value === "string") return value.replace(BOT_TOKEN, "[redacted]");
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) ? "[redacted]" : scrub(inner);
    }
    return out;
  }
  return value;
}

function line(level: Level, message: string, extra?: unknown): void {
  const stamp = new Date().toISOString();
  const tail =
    extra === undefined ? "" : ` ${JSON.stringify(scrub(extra))}`;
  const text = `${stamp} ${level} ${message}${tail}`;
  if (level === "error") console.error(text);
  else if (level === "warn") console.warn(text);
  else console.log(text);
}

export const log = {
  info: (message: string, extra?: unknown) => line("info", message, extra),
  warn: (message: string, extra?: unknown) => line("warn", message, extra),
  error: (message: string, extra?: unknown) => line("error", message, extra),
  debug: (message: string, extra?: unknown) => {
    if (process.env.DEBUG) line("debug", message, extra);
  },
};

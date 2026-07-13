import { existsSync, readFileSync } from "node:fs";

// Load .env file into process.env. Bun handles the default .env file;
// this helper also supports explicit paths.
function loadEnvFile(path?: string) {
  const file = path ?? ".env";
  if (!existsSync(file)) return;
  const content = readFileSync(file, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    // Don't overwrite existing env vars
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

loadEnvFile();

function env(key: string): string | undefined {
  return process.env[key];
}

function _envRequired(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function parseDuration(s: string): number {
  const match = s.match(/^(\d+)(s|m|h|d)$/);
  if (!match)
    throw new Error(`Invalid duration: ${s} (use e.g. 30s, 5m, 24h, 7d)`);
  const n = Number.parseInt(match[1], 10);
  const unit = match[2];
  if (unit === "s") return n * 1000;
  if (unit === "m") return n * 60 * 1000;
  if (unit === "h") return n * 60 * 60 * 1000;
  return n * 24 * 60 * 60 * 1000;
}

export const config = {
  get key() {
    return env("VEX_KEY");
  },

  get handlerTimeout() {
    return env("VEX_HANDLER_TIMEOUT") ?? "30s";
  },
  get handlerTimeoutMs() {
    return parseDuration(this.handlerTimeout);
  },

  get traceSampleRate() {
    const v = env("VEX_TRACE_SAMPLE_RATE");
    return v ? Number.parseFloat(v) : 1.0;
  },

  get corsOrigin() {
    return env("VEX_CORS_ORIGIN");
  },

  get idleTimeout() {
    const v = env("VEX_IDLE_TIMEOUT");
    return v ? Number.parseInt(v, 10) : 255;
  },
} as const;

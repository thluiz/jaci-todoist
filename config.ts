// config.ts — runtime configuration, read once from the environment.
//
// Everything deployment-specific lives here or in acl.json. Nothing in this
// repository names a particular bot, user or project: the same binary serves
// any number of consumers, told apart only by their API key.

export interface Config {
  port: number;
  host: string;
  todoistToken: string;
  todoistTimeoutMs: number;
  aclPath: string;
  logDir: string;
  logRetentionDays: number;
  maxWritesPerMin: number;
  maxWritesPerDay: number;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${name}: expected a number, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

export function loadConfig(): Config {
  const todoistToken = process.env.TODOIST_TOKEN ?? "";
  if (!todoistToken) {
    // Fail at boot rather than on the first tool call: a service that starts
    // without credentials only reports the problem once someone is waiting.
    throw new Error("TODOIST_TOKEN is not set. Copy .env.example to .env and fill it in.");
  }

  return {
    port: num("PORT", 8008),
    host: process.env.HOST || "127.0.0.1",
    todoistToken,
    todoistTimeoutMs: num("TODOIST_TIMEOUT_MS", 20_000),
    aclPath: process.env.ACL_PATH || "./acl.json",
    logDir: process.env.LOG_DIR || "./logs",
    logRetentionDays: num("LOG_RETENTION_DAYS", 30),
    maxWritesPerMin: num("MAX_WRITES_PER_MIN", 20),
    maxWritesPerDay: num("MAX_WRITES_PER_DAY", 200),
  };
}

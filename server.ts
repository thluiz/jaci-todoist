// server.ts — HTTP entry point.
//
//   GET  /health          liveness, no key required
//   POST /mcp             MCP Streamable HTTP (JSON-RPC 2.0)
//   GET  /mcp             SSE keep-alive
//   POST /call/{tool}     the same tools over plain HTTP; body is the arguments object
//
// Identity comes from the X-Api-Key header and nothing else. In particular it
// never comes from an argument the caller supplies: a model can write any
// user id it likes into a JSON body, but it cannot forge the header a reverse
// proxy stamps on its behalf.

import { stat } from "node:fs/promises";

import {
  Acl,
  AuthenticationError,
  AuthorizationError,
  configuredDenials,
  type Principal,
} from "./acl";
import { RateLimitError, WriteBudget } from "./budget";
import { loadConfig } from "./config";
import { Logger, type AuditOutcome } from "./logger";
import { handleMcpGet, handleMcpOptions, handleMcpPost, SERVER_NAME, SERVER_VERSION } from "./mcp";
import { findTool, InvalidArgumentError, runTool, toolsFor, TOOLS } from "./tools";
import { TodoistClient, TodoistError, type TodoistApi } from "./todoist";

const config = loadConfig();
const logger = new Logger(config.logDir, config.logRetentionDays);
const budget = new WriteBudget(config.maxWritesPerMin, config.maxWritesPerDay);
const api: TodoistApi = new TodoistClient(config.todoistToken, config.todoistTimeoutMs);

// ── The ACL, reloaded when the file changes ───────────────────────────────
//
// Restarting a service on this host is a deliberate, confirmed act, and adding
// a project to somebody's scope should not require one. The file is re-read
// when its mtime moves; a broken edit keeps the previous version in force
// rather than locking everyone out.

let acl = await Acl.load(config.aclPath);
let aclMtimeMs = (await stat(config.aclPath)).mtimeMs;
let aclCheckedAt = 0;

/**
 * A denyTools entry that matches no tool silently protects nothing, and a
 * misspelled one looks exactly like a working one. Say so rather than let it
 * pass for a control.
 */
function warnUnknownDenials(current: Acl): void {
  const unknown = [...configuredDenials(current)].filter((name) => !findTool(name));
  if (unknown.length) {
    console.warn(`[${SERVER_NAME}] denyTools names no such tool: ${unknown.join(", ")}`);
  }
}
warnUnknownDenials(acl);

async function currentAcl(): Promise<Acl> {
  const now = Date.now();
  if (now - aclCheckedAt < 5_000) return acl;
  aclCheckedAt = now;
  try {
    const { mtimeMs } = await stat(config.aclPath);
    if (mtimeMs !== aclMtimeMs) {
      acl = await Acl.load(config.aclPath);
      aclMtimeMs = mtimeMs;
      warnUnknownDenials(acl);
      console.log(`[${SERVER_NAME}] reloaded ${config.aclPath}`);
    }
  } catch (error) {
    console.error(`[${SERVER_NAME}] keeping previous ACL: ${describe(error)}`);
  }
  return acl;
}

// ── Execution: budget, audit, then the tool ───────────────────────────────

function execute(principal: Principal, facade: "mcp" | "rest") {
  return async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const startedAt = Date.now();
    const tool = findTool(name);
    if (tool?.mutates) {
      try {
        budget.consume(principal.name);
      } catch (error) {
        await audit(principal, name, "rate_limited", facade, args, error, startedAt);
        throw error;
      }
    }

    try {
      const result = await runTool(name, args, { principal, api });
      await audit(principal, name, "ok", facade, args, undefined, startedAt);
      return result;
    } catch (error) {
      const outcome: AuditOutcome =
        error instanceof AuthorizationError || error instanceof AuthenticationError
          ? "denied"
          : "error";
      await audit(principal, name, outcome, facade, args, error, startedAt);
      throw error;
    }
  };
}

function audit(
  principal: Principal | null,
  tool: string,
  outcome: AuditOutcome,
  facade: "mcp" | "rest",
  args: Record<string, unknown>,
  error: unknown,
  startedAt: number,
): Promise<void> {
  return logger.write({
    principal: principal?.name ?? null,
    tool,
    outcome,
    facade,
    // Identifiers only. Task titles and comment bodies stay out of the log:
    // it exists to answer "who did what to which object", not to mirror the
    // contents of the account into a second place.
    project: typeof args.project === "string" ? args.project : undefined,
    taskId: typeof args.task_id === "string" ? args.task_id : undefined,
    message: error ? describe(error) : undefined,
    durationMs: Date.now() - startedAt,
  });
}

// ── HTTP ──────────────────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function statusFor(error: unknown): number {
  if (
    error instanceof AuthenticationError ||
    error instanceof AuthorizationError ||
    error instanceof InvalidArgumentError ||
    error instanceof RateLimitError
  ) {
    return error.status;
  }
  // An upstream failure is not the caller's fault; say so with 502 rather than
  // passing Todoist's status through as if we had produced it.
  if (error instanceof TodoistError) return 502;
  return 500;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const server = Bun.serve({
  port: config.port,
  hostname: config.host,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/health") {
      return json({ ok: true, service: SERVER_NAME, version: SERVER_VERSION, tools: TOOLS.length });
    }

    if (path === "/mcp" && req.method === "OPTIONS") return handleMcpOptions();

    let principal: Principal;
    try {
      principal = (await currentAcl()).authenticate(req.headers.get("x-api-key"));
    } catch (error) {
      // Logged without a principal, on purpose: this is the signal that
      // something is calling with a key nobody owns.
      await audit(null, path, "denied", path === "/mcp" ? "mcp" : "rest", {}, error, Date.now());
      return json({ error: describe(error) }, statusFor(error));
    }

    if (path === "/mcp") {
      const session = { principal, execute: execute(principal, "mcp") };
      if (req.method === "GET") return handleMcpGet();
      if (req.method === "POST") return handleMcpPost(req, session);
      return json({ error: "Method not allowed" }, 405);
    }

    if (path.startsWith("/call/")) {
      if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
      const name = decodeURIComponent(path.slice("/call/".length));

      let args: Record<string, unknown>;
      try {
        const text = await req.text();
        args = text ? JSON.parse(text) : {};
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }

      try {
        const result = await execute(principal, "rest")(name, args);
        return json({ ok: true, result });
      } catch (error) {
        return json({ ok: false, error: describe(error) }, statusFor(error));
      }
    }

    if (path === "/tools") {
      // Convenience for humans holding a key: the same list tools/list returns.
      return json({
        principal: principal.name,
        role: principal.role,
        projects: [...principal.projects.keys()],
        tools: toolsFor(principal).map((tool) => ({
          name: tool.name,
          mutates: tool.mutates,
          description: tool.description,
        })),
      });
    }

    return json({ error: "Not found" }, 404);
  },
});

console.log(
  `[${SERVER_NAME}] listening on http://${config.host}:${config.port} — ` +
    `${TOOLS.length} tools, acl=${config.aclPath}`,
);

await logger.prune();
const pruneTimer = setInterval(() => void logger.prune(), 24 * 60 * 60 * 1000);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`[${SERVER_NAME}] ${signal} received, shutting down`);
    clearInterval(pruneTimer);
    server.stop();
    process.exit(0);
  });
}

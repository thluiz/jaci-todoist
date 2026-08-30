// mcp.ts — MCP Streamable HTTP transport (protocol 2024-11-05).
//
//   POST /mcp   JSON-RPC 2.0, single request or batch
//   GET  /mcp   SSE keep-alive
//
// This file knows about framing and nothing else. Which tools exist, who may
// call them and what they do all live in tools.ts and acl.ts; the REST facade
// in server.ts goes through the same `execute` callback, so the two transports
// cannot drift apart.

import type { Principal } from "./acl";
import { InvalidArgumentError, toolsFor } from "./tools";

export const PROTOCOL_VERSION = "2024-11-05";
export const SERVER_NAME = "jaci-todoist";
export const SERVER_VERSION = "1.0.0";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpSession {
  principal: Principal;
  /** Runs a tool with auditing and budget enforcement already applied. */
  execute(name: string, args: Record<string, unknown>): Promise<unknown>;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id, X-Api-Key",
};

const JSON_HEADERS = { ...CORS, "Content-Type": "application/json" };

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function fail(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function dispatch(
  request: JsonRpcRequest,
  session: McpSession,
): Promise<JsonRpcResponse | null> {
  const id = request.id ?? null;

  switch (request.method) {
    case "initialize":
      return ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });

    case "notifications/initialized":
      return null; // a notification has no reply

    case "ping":
      return ok(id, {});

    case "tools/list":
      // Filtered by role: a read-only principal is never shown a tool it would
      // only be refused for calling.
      return ok(id, {
        tools: toolsFor(session.principal).map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      });

    case "tools/call": {
      const name = request.params?.name;
      if (typeof name !== "string") {
        return fail(id, -32602, "Missing required parameter: name");
      }
      const args = (request.params?.arguments ?? {}) as Record<string, unknown>;

      try {
        const result = await session.execute(name, args);
        return ok(id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        });
      } catch (error) {
        // A malformed call is a protocol error the client should fix.
        if (error instanceof InvalidArgumentError) {
          return fail(id, -32602, error.message);
        }
        // Everything else — refusals, upstream failures, budget exhaustion — is
        // a normal result carrying isError, so the model reads the reason and
        // can correct course instead of seeing an opaque transport failure.
        const message = error instanceof Error ? error.message : String(error);
        return ok(id, { content: [{ type: "text", text: `Error: ${message}` }], isError: true });
      }
    }

    default:
      return fail(id, -32601, `Method not found: ${request.method}`);
  }
}

export function handleMcpOptions(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

export function handleMcpGet(): Response {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`: ${SERVER_NAME} MCP ready\n\n`));
    },
  });
  return new Response(stream, {
    headers: { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}

export async function handleMcpPost(req: Request, session: McpSession): Promise<Response> {
  let body: JsonRpcRequest | JsonRpcRequest[];
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify(fail(null, -32700, "Parse error: invalid JSON")), {
      status: 400,
      headers: JSON_HEADERS,
    });
  }

  const isBatch = Array.isArray(body);
  const requests = isBatch ? body : [body];

  const settled = await Promise.all(requests.map((request) => dispatch(request, session)));
  const responses = settled.filter((response): response is JsonRpcResponse => response !== null);

  if (responses.length === 0) {
    return new Response(null, { status: 202, headers: CORS });
  }

  return new Response(JSON.stringify(isBatch ? responses : responses[0]), {
    headers: JSON_HEADERS,
  });
}

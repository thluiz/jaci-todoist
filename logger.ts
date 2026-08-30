// logger.ts — append-only audit trail, one NDJSON file per day.
//
// What matters here is what is *absent*: no API key, no Todoist token, no task
// content. A principal is identified by its name. An audit log that leaks the
// credentials it audits is worse than no audit log at all.
//
// Denials are logged as loudly as successes — a run of authorization failures is
// how a looping agent or a leaked key announces itself.

import { appendFile, mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

export type AuditOutcome = "ok" | "denied" | "error" | "rate_limited";

export interface AuditEntry {
  principal: string | null;
  tool: string;
  outcome: AuditOutcome;
  facade: "mcp" | "rest";
  project?: string;
  taskId?: string;
  message?: string;
  durationMs?: number;
}

export class Logger {
  private ready: Promise<void>;

  constructor(
    private readonly dir: string,
    private readonly retentionDays: number,
  ) {
    this.ready = mkdir(dir, { recursive: true }).then(() => undefined);
  }

  async write(entry: AuditEntry): Promise<void> {
    const now = new Date();
    const line = JSON.stringify({ ts: now.toISOString(), ...entry }) + "\n";
    try {
      await this.ready;
      await appendFile(join(this.dir, `${dayStamp(now)}.ndjson`), line, "utf8");
    } catch (error) {
      // Never let auditing take the request down with it; say so on stderr.
      console.error(`[logger] failed to append audit entry: ${describe(error)}`);
    }
  }

  /** Drops NDJSON files older than the retention window. */
  async prune(): Promise<void> {
    const cutoff = Date.now() - this.retentionDays * 86_400_000;
    try {
      await this.ready;
      for (const name of await readdir(this.dir)) {
        const match = name.match(/^(\d{4}-\d{2}-\d{2})\.ndjson$/);
        if (!match) continue;
        if (Date.parse(`${match[1]}T00:00:00Z`) < cutoff) {
          await unlink(join(this.dir, name));
        }
      }
    } catch (error) {
      console.error(`[logger] prune failed: ${describe(error)}`);
    }
  }
}

function dayStamp(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

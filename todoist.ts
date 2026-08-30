// todoist.ts — thin client for the unified Todoist API v1.
//
// Base: https://api.todoist.com/api/v1  ·  auth: Authorization: Bearer <token>
//
// Deliberately small: it speaks HTTP and nothing else. It knows no aliases, no
// principals and no permissions — authorization lives in acl.ts, on top of this.
//
// The token is never logged, never echoed in an error message and never leaves
// this module.

const BASE = "https://api.todoist.com/api/v1";

// A short cache for the slow-changing collections. Tasks are never cached: an
// ACL check that reads a stale project_id would be an ACL check that is wrong.
const CACHE_TTL_MS = 60_000;

export interface Task {
  id: string;
  project_id: string;
  section_id: string | null;
  parent_id: string | null;
  content: string;
  description?: string;
  priority?: number;
  labels?: string[];
  due?: { date?: string; string?: string; is_recurring?: boolean } | null;
  url?: string;
  is_completed?: boolean;
  [key: string]: unknown;
}

export interface Section {
  id: string;
  project_id: string;
  name: string;
  [key: string]: unknown;
}

export interface Label {
  id: string;
  name: string;
  [key: string]: unknown;
}

export interface Comment {
  id: string;
  task_id?: string | null;
  content: string;
  posted_at?: string;
  [key: string]: unknown;
}

export interface Project {
  id: string;
  name: string;
  [key: string]: unknown;
}

/** An error carrying the upstream HTTP status, so callers can map it faithfully. */
export class TodoistError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "TodoistError";
  }
}

export interface ListTasksQuery {
  project_id?: string;
  section_id?: string;
  label?: string;
  filter?: string;
}

export interface CreateTaskPayload {
  project_id: string;
  content: string;
  description?: string;
  due_string?: string;
  priority?: number;
  labels?: string[];
  section_id?: string;
  parent_id?: string;
}

export interface UpdateTaskPayload {
  content?: string;
  description?: string;
  priority?: number;
  labels?: string[];
  due_string?: string;
}

export interface MoveTaskPayload {
  project_id?: string;
  section_id?: string;
  parent_id?: string;
}

/**
 * The surface the rest of the service depends on. Tests substitute a fake for
 * it, so no test ever touches the network or a real account.
 */
export interface TodoistApi {
  listProjects(): Promise<Project[]>;
  getTask(id: string): Promise<Task>;
  listTasks(query: ListTasksQuery): Promise<Task[]>;
  createTask(payload: CreateTaskPayload): Promise<Task>;
  updateTask(id: string, payload: UpdateTaskPayload): Promise<Task>;
  moveTask(id: string, payload: MoveTaskPayload): Promise<Task>;
  closeTask(id: string): Promise<void>;
  reopenTask(id: string): Promise<void>;
  deleteTask(id: string): Promise<void>;
  listSections(projectId: string): Promise<Section[]>;
  listLabels(): Promise<Label[]>;
  listComments(taskId: string): Promise<Comment[]>;
  addComment(taskId: string, content: string): Promise<Comment>;
}

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

export class TodoistClient implements TodoistApi {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly token: string,
    private readonly timeoutMs = 20_000,
  ) {}

  // ── HTTP ────────────────────────────────────────────────────────────────

  private async request(
    method: string,
    path: string,
    options: { query?: Record<string, string | undefined>; body?: unknown } = {},
  ): Promise<unknown> {
    const url = new URL(BASE + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== "") url.searchParams.set(key, value);
    }

    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    let payload: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: payload,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      // The URL is safe to show; the token lives in a header, not the URL.
      throw new TodoistError(`Todoist ${method} ${path} failed: ${reason}`, 0);
    }

    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 500);
      throw new TodoistError(
        `Todoist ${method} ${path} returned ${response.status}${detail ? `: ${detail}` : ""}`,
        response.status,
      );
    }

    if (response.status === 204) return null;
    const text = await response.text();
    if (!text) return null;
    return JSON.parse(text);
  }

  /**
   * Follows cursor pagination to the end.
   *
   * The v1 responses wrap the page in an object alongside the cursor, but the
   * published reference does not pin down the field names, so we accept the
   * documented shape and the plausible variants rather than guessing one and
   * failing loudly in production on a rename.
   */
  private async requestAll<T>(
    path: string,
    query: Record<string, string | undefined> = {},
  ): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < 50; page++) {
      const body = (await this.request("GET", path, {
        query: { ...query, limit: "200", cursor },
      })) as Record<string, unknown> | T[] | null;

      if (body === null) break;

      if (Array.isArray(body)) {
        items.push(...(body as T[]));
        break;
      }

      const results = (body.results ?? body.items ?? body.data) as T[] | undefined;
      if (Array.isArray(results)) items.push(...results);

      const next = (body.next_cursor ?? body.nextCursor) as string | null | undefined;
      if (!next) break;
      cursor = next;
    }

    return items;
  }

  private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value as T;
    const value = await load();
    this.cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  }

  // ── Projects ────────────────────────────────────────────────────────────

  listProjects(): Promise<Project[]> {
    return this.cached("projects", () => this.requestAll<Project>("/projects"));
  }

  // ── Tasks ───────────────────────────────────────────────────────────────

  getTask(id: string): Promise<Task> {
    return this.request("GET", `/tasks/${encodeURIComponent(id)}`) as Promise<Task>;
  }

  async listTasks(query: ListTasksQuery): Promise<Task[]> {
    if (query.filter) {
      // Filter queries have their own endpoint in v1. Older deployments served
      // them as a parameter of /tasks; fall back rather than fail outright.
      try {
        return await this.requestAll<Task>("/tasks/filter", { query: query.filter });
      } catch (error) {
        if (!(error instanceof TodoistError) || error.status !== 404) throw error;
        return await this.requestAll<Task>("/tasks", { filter: query.filter });
      }
    }

    return this.requestAll<Task>("/tasks", {
      project_id: query.project_id,
      section_id: query.section_id,
      label: query.label,
    });
  }

  createTask(payload: CreateTaskPayload): Promise<Task> {
    return this.request("POST", "/tasks", { body: payload }) as Promise<Task>;
  }

  updateTask(id: string, payload: UpdateTaskPayload): Promise<Task> {
    return this.request("POST", `/tasks/${encodeURIComponent(id)}`, {
      body: payload,
    }) as Promise<Task>;
  }

  moveTask(id: string, payload: MoveTaskPayload): Promise<Task> {
    return this.request("POST", `/tasks/${encodeURIComponent(id)}/move`, {
      body: payload,
    }) as Promise<Task>;
  }

  async closeTask(id: string): Promise<void> {
    await this.request("POST", `/tasks/${encodeURIComponent(id)}/close`, { body: {} });
  }

  async reopenTask(id: string): Promise<void> {
    await this.request("POST", `/tasks/${encodeURIComponent(id)}/reopen`, { body: {} });
  }

  async deleteTask(id: string): Promise<void> {
    await this.request("DELETE", `/tasks/${encodeURIComponent(id)}`);
  }

  // ── Sections, labels, comments ──────────────────────────────────────────

  listSections(projectId: string): Promise<Section[]> {
    return this.cached(`sections:${projectId}`, () =>
      this.requestAll<Section>("/sections", { project_id: projectId }),
    );
  }

  listLabels(): Promise<Label[]> {
    return this.cached("labels", () => this.requestAll<Label>("/labels"));
  }

  listComments(taskId: string): Promise<Comment[]> {
    return this.requestAll<Comment>("/comments", { task_id: taskId });
  }

  addComment(taskId: string, content: string): Promise<Comment> {
    return this.request("POST", "/comments", {
      body: { task_id: taskId, content },
    }) as Promise<Comment>;
  }
}

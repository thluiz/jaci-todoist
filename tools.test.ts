// tools.test.ts — that the registry enforces what acl.ts decides.
//
// acl.test.ts proves the assertions refuse the right things. This file proves
// the handlers actually call them, and that the two schema separations the
// design rests on cannot be undone by a caller.

import { describe, expect, test } from "bun:test";
import { Acl, AuthorizationError, type AclFile } from "./acl";
import { RateLimitError, WriteBudget } from "./budget";
import { InvalidArgumentError, findTool, runTool, toolsFor, TOOLS } from "./tools";
import type {
  Comment,
  CreateTaskPayload,
  Label,
  ListTasksQuery,
  MoveTaskPayload,
  Project,
  Section,
  Task,
  TodoistApi,
  UpdateTaskPayload,
} from "./todoist";

const HOME = "P-home";
const SHED = "P-shed";
const PRIVATE = "P-private";

const acl = new Acl({
  projects: { home: HOME, shed: SHED },
  principals: {
    owner: { apiKey: "key-owner-0123456789abcdef0123", role: "write", projects: "*" },
    guest: { apiKey: "key-guest-0123456789abcdef0123", role: "write", projects: ["home"] },
    reader: { apiKey: "key-reader-0123456789abcdef012", role: "read", projects: ["home"] },
    careful: {
      apiKey: "key-careful-0123456789abcdef01",
      role: "write",
      projects: ["home"],
      denyTools: ["todoist_delete_task"],
    },
  },
} satisfies AclFile);

const owner = acl.authenticate("key-owner-0123456789abcdef0123");
const guest = acl.authenticate("key-guest-0123456789abcdef0123");
const reader = acl.authenticate("key-reader-0123456789abcdef012");
const careful = acl.authenticate("key-careful-0123456789abcdef01");

interface Recorder {
  created: CreateTaskPayload[];
  updated: { id: string; payload: UpdateTaskPayload }[];
  moved: { id: string; payload: MoveTaskPayload }[];
  closed: string[];
  deleted: string[];
  comments: { taskId: string; content: string }[];
}

function fakeApi(): TodoistApi & { recorder: Recorder } {
  const recorder: Recorder = {
    created: [],
    updated: [],
    moved: [],
    closed: [],
    deleted: [],
    comments: [],
  };

  const tasks: Record<string, Task> = {
    "t-home": {
      id: "t-home",
      project_id: HOME,
      section_id: "s-home",
      parent_id: null,
      content: "home task",
      due: { string: "every monday", is_recurring: true },
    },
    "t-shed": { id: "t-shed", project_id: SHED, section_id: null, parent_id: null, content: "shed task" },
    "t-private": { id: "t-private", project_id: PRIVATE, section_id: null, parent_id: null, content: "secret" },
  };

  const sections: Record<string, Section[]> = {
    [HOME]: [{ id: "s-home", project_id: HOME, name: "Groceries" }],
    [SHED]: [{ id: "s-shed", project_id: SHED, name: "Tools" }],
    [PRIVATE]: [{ id: "s-private", project_id: PRIVATE, name: "Hidden" }],
  };

  return {
    recorder,
    async listProjects(): Promise<Project[]> {
      return [
        { id: HOME, name: "Home" },
        { id: SHED, name: "Shed" },
        { id: PRIVATE, name: "Private" },
      ];
    },
    async getTask(id: string): Promise<Task> {
      const task = tasks[id];
      if (!task) throw new Error(`no such task ${id}`);
      return task;
    },
    async listTasks(query: ListTasksQuery): Promise<Task[]> {
      const all = Object.values(tasks);
      if (query.filter) return all; // a filter query sees the whole account
      return all.filter(
        (task) =>
          (!query.project_id || task.project_id === query.project_id) &&
          (!query.section_id || task.section_id === query.section_id),
      );
    },
    async createTask(payload: CreateTaskPayload): Promise<Task> {
      recorder.created.push(payload);
      const task: Task = {
        id: "t-new",
        project_id: payload.project_id,
        section_id: payload.section_id ?? null,
        parent_id: payload.parent_id ?? null,
        content: payload.content,
      };
      tasks[task.id] = task;
      return task;
    },
    async updateTask(id: string, payload: UpdateTaskPayload): Promise<Task> {
      recorder.updated.push({ id, payload });
      return { ...tasks[id]!, ...payload } as Task;
    },
    async moveTask(id: string, payload: MoveTaskPayload): Promise<Task> {
      recorder.moved.push({ id, payload });
      return tasks[id]!;
    },
    async closeTask(id: string): Promise<void> {
      recorder.closed.push(id);
    },
    async reopenTask(): Promise<void> {},
    async deleteTask(id: string): Promise<void> {
      recorder.deleted.push(id);
    },
    async listSections(projectId: string): Promise<Section[]> {
      return sections[projectId] ?? [];
    },
    async listLabels(): Promise<Label[]> {
      return [{ id: "l1", name: "errand" }];
    },
    async listComments(): Promise<Comment[]> {
      return [{ id: "c1", content: "a note" }];
    },
    async addComment(taskId: string, content: string): Promise<Comment> {
      recorder.comments.push({ taskId, content });
      return { id: "c-new", task_id: taskId, content };
    },
  };
}

// ── Registry shape ────────────────────────────────────────────────────────

describe("registry", () => {
  test("tool names are unique", () => {
    const names = TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("every tool declares an object input schema", () => {
    for (const tool of TOOLS) {
      expect(tool.inputSchema.type).toBe("object");
      expect(typeof tool.description).toBe("string");
    }
  });

  test("a read-only principal is shown no mutating tool", () => {
    const visible = toolsFor(reader);
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.some((tool) => tool.mutates)).toBe(false);
    expect(visible.length).toBeLessThan(TOOLS.length);
  });

  test("a write principal is shown everything", () => {
    expect(toolsFor(owner).length).toBe(TOOLS.length);
  });
});

// ── The separations the design depends on ─────────────────────────────────

describe("schema separations", () => {
  test("update_task cannot carry a due date", () => {
    const properties = findTool("todoist_update_task")!.inputSchema.properties as Record<string, unknown>;
    expect(properties.due_string).toBeUndefined();
  });

  test("update_task cannot carry a destination", () => {
    const properties = findTool("todoist_update_task")!.inputSchema.properties as Record<string, unknown>;
    expect(properties.project).toBeUndefined();
    expect(properties.section).toBeUndefined();
    expect(properties.parent_id).toBeUndefined();
  });

  test("an unexpected due_string in update_task is dropped, not forwarded", async () => {
    const api = fakeApi();
    await runTool(
      "todoist_update_task",
      { task_id: "t-home", content: "renamed", due_string: "tomorrow" },
      { principal: guest, api },
    );
    expect(api.recorder.updated).toHaveLength(1);
    expect(api.recorder.updated[0]!.payload).toEqual({
      content: "renamed",
      description: undefined,
      priority: undefined,
      labels: undefined,
    });
  });

  test("reschedule sends the due date on its own", async () => {
    const api = fakeApi();
    await runTool(
      "todoist_reschedule_task",
      { task_id: "t-home", due_string: "every tuesday" },
      { principal: guest, api },
    );
    expect(api.recorder.updated[0]!.payload).toEqual({ due_string: "every tuesday" });
  });
});

// ── Role enforcement at the dispatcher ────────────────────────────────────

describe("role enforcement", () => {
  test("a read-only principal is refused a mutating tool even by name", async () => {
    const api = fakeApi();
    await expect(
      runTool("todoist_create_task", { project: "home", content: "x" }, { principal: reader, api }),
    ).rejects.toThrow(AuthorizationError);
    expect(api.recorder.created).toHaveLength(0);
  });

  test("a read-only principal may still read", async () => {
    const api = fakeApi();
    const result = await runTool("todoist_list_tasks", { project: "home" }, { principal: reader, api });
    expect(Array.isArray(result)).toBe(true);
  });

  test("a denied tool is hidden from the listing, not merely refused", () => {
    const visible = toolsFor(careful).map((tool) => tool.name);
    expect(visible).not.toContain("todoist_delete_task");
    // Everything else this principal writes with is still there.
    expect(visible).toContain("todoist_create_task");
    expect(visible).toContain("todoist_complete_task");
    expect(visible.length).toBe(TOOLS.length - 1);
  });

  test("a denied tool is refused even when named directly, and deletes nothing", async () => {
    const api = fakeApi();
    await expect(
      runTool("todoist_delete_task", { task_id: "t-home" }, { principal: careful, api }),
    ).rejects.toThrow(AuthorizationError);
    expect(api.recorder.deleted).toHaveLength(0);
  });

  test("an unknown tool name is an argument error", async () => {
    const api = fakeApi();
    await expect(runTool("todoist_drop_database", {}, { principal: owner, api })).rejects.toThrow(
      InvalidArgumentError,
    );
  });
});

// ── Scope enforcement inside the handlers ─────────────────────────────────

describe("scope enforcement", () => {
  test("list_projects shows only the principal's own projects", async () => {
    const api = fakeApi();
    const result = (await runTool("todoist_list_projects", {}, { principal: guest, api })) as {
      project: string;
    }[];
    expect(result.map((entry) => entry.project)).toEqual(["home"]);
  });

  test("a filter query is trimmed to the caller's projects, not refused", async () => {
    const api = fakeApi();
    const result = (await runTool(
      "todoist_list_tasks",
      { filter: "today" },
      { principal: guest, api },
    )) as { task_id: string }[];
    expect(result.map((task) => task.task_id)).toEqual(["t-home"]);
  });

  test("a '*' principal still cannot see an unmapped project through a filter", async () => {
    const api = fakeApi();
    const result = (await runTool(
      "todoist_list_tasks",
      { filter: "today" },
      { principal: owner, api },
    )) as { task_id: string }[];
    expect(result.map((task) => task.task_id).sort()).toEqual(["t-home", "t-shed"]);
  });

  test("get_task refuses a task id from a forbidden project", async () => {
    const api = fakeApi();
    await expect(
      runTool("todoist_get_task", { task_id: "t-shed" }, { principal: guest, api }),
    ).rejects.toThrow(AuthorizationError);
  });

  test("delete_task refuses before deleting anything", async () => {
    const api = fakeApi();
    await expect(
      runTool("todoist_delete_task", { task_id: "t-shed" }, { principal: guest, api }),
    ).rejects.toThrow(AuthorizationError);
    expect(api.recorder.deleted).toHaveLength(0);
  });

  test("complete_task refuses before closing anything", async () => {
    const api = fakeApi();
    await expect(
      runTool("todoist_complete_task", { task_id: "t-private" }, { principal: owner, api }),
    ).rejects.toThrow(AuthorizationError);
    expect(api.recorder.closed).toHaveLength(0);
  });

  test("add_comment refuses a task outside the scope", async () => {
    const api = fakeApi();
    await expect(
      runTool("todoist_add_comment", { task_id: "t-shed", content: "hi" }, { principal: guest, api }),
    ).rejects.toThrow(AuthorizationError);
    expect(api.recorder.comments).toHaveLength(0);
  });

  test("create_task refuses a parent from another project", async () => {
    const api = fakeApi();
    await expect(
      runTool(
        "todoist_create_task",
        { project: "home", content: "subtask", parent_id: "t-shed" },
        { principal: owner, api },
      ),
    ).rejects.toThrow(AuthorizationError);
    expect(api.recorder.created).toHaveLength(0);
  });

  test("create_task refuses a section from another project", async () => {
    const api = fakeApi();
    await expect(
      runTool(
        "todoist_create_task",
        { project: "home", content: "x", section: "s-shed" },
        { principal: owner, api },
      ),
    ).rejects.toThrow(AuthorizationError);
    expect(api.recorder.created).toHaveLength(0);
  });

  test("move_task refuses a destination project outside the scope", async () => {
    const api = fakeApi();
    await expect(
      runTool("todoist_move_task", { task_id: "t-home", project: "shed" }, { principal: guest, api }),
    ).rejects.toThrow(AuthorizationError);
    expect(api.recorder.moved).toHaveLength(0);
  });
});

// ── Happy paths, enough to prove the plumbing ─────────────────────────────

describe("handlers", () => {
  test("create_task resolves a section by its visible name", async () => {
    const api = fakeApi();
    await runTool(
      "todoist_create_task",
      { project: "home", content: "milk", section: "Groceries" },
      { principal: guest, api },
    );
    expect(api.recorder.created[0]!.section_id).toBe("s-home");
    expect(api.recorder.created[0]!.project_id).toBe(HOME);
  });

  test("create_task rejects an out-of-range priority", async () => {
    const api = fakeApi();
    await expect(
      runTool(
        "todoist_create_task",
        { project: "home", content: "x", priority: 9 },
        { principal: guest, api },
      ),
    ).rejects.toThrow(InvalidArgumentError);
  });

  test("list_tasks requires a project or a filter", async () => {
    const api = fakeApi();
    await expect(runTool("todoist_list_tasks", {}, { principal: guest, api })).rejects.toThrow(
      InvalidArgumentError,
    );
  });

  test("update_task with no fields is refused", async () => {
    const api = fakeApi();
    await expect(
      runTool("todoist_update_task", { task_id: "t-home" }, { principal: guest, api }),
    ).rejects.toThrow(InvalidArgumentError);
  });

  test("move_task with no destination is refused", async () => {
    const api = fakeApi();
    await expect(
      runTool("todoist_move_task", { task_id: "t-home" }, { principal: guest, api }),
    ).rejects.toThrow(InvalidArgumentError);
  });

  test("responses name projects by alias and never expose a project id", async () => {
    const api = fakeApi();
    const task = (await runTool(
      "todoist_get_task",
      { task_id: "t-home" },
      { principal: guest, api },
    )) as Record<string, unknown>;
    expect(task.project).toBe("home");
    expect(JSON.stringify(task)).not.toContain(HOME);
    expect(task.section).toBe("Groceries");
  });
});

// ── Write budget ──────────────────────────────────────────────────────────

describe("write budget", () => {
  test("refuses once the per-minute ceiling is reached", () => {
    let now = 0;
    const budget = new WriteBudget(2, 100, () => now);
    budget.consume("a");
    budget.consume("a");
    expect(() => budget.consume("a")).toThrow(RateLimitError);
  });

  test("the window rolls over", () => {
    let now = 0;
    const budget = new WriteBudget(1, 100, () => now);
    budget.consume("a");
    now = 60_001;
    expect(() => budget.consume("a")).not.toThrow();
  });

  test("principals are budgeted separately", () => {
    let now = 0;
    const budget = new WriteBudget(1, 100, () => now);
    budget.consume("a");
    expect(() => budget.consume("b")).not.toThrow();
  });

  test("the daily ceiling holds even inside a fresh minute", () => {
    let now = 0;
    const budget = new WriteBudget(100, 2, () => now);
    budget.consume("a");
    now = 60_001;
    budget.consume("a");
    now = 120_001;
    expect(() => budget.consume("a")).toThrow(RateLimitError);
  });

  test("a refusal does not spend the other window's allowance", () => {
    let now = 0;
    const budget = new WriteBudget(10, 1, () => now);
    budget.consume("a");
    expect(() => budget.consume("a")).toThrow(RateLimitError);
    expect(budget.remaining("a").minute).toBe(9);
  });
});

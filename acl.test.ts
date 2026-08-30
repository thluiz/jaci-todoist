// acl.test.ts — the negative cases are the point.
//
// A permissions test that only proves the allowed path works proves nothing:
// a function returning `true` unconditionally passes it. Every assertion here
// that matters is about something being refused.

import { describe, expect, test } from "bun:test";
import {
  Acl,
  AuthenticationError,
  AuthorizationError,
  assertParentAccess,
  assertProjectAccess,
  assertProjectIdAccess,
  assertSectionAccess,
  assertTaskAccess,
  assertToolAllowed,
  assertWriteRole,
  configuredDenials,
  type AclFile,
} from "./acl";
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
const PRIVATE = "P-private"; // mapped to no alias: outside the service entirely

const ACL_FILE: AclFile = {
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
};

// ── A Todoist that never leaves the process ───────────────────────────────

const TASKS: Record<string, Task> = {
  "t-home": { id: "t-home", project_id: HOME, section_id: "s-home", parent_id: null, content: "home task" },
  "t-shed": { id: "t-shed", project_id: SHED, section_id: null, parent_id: null, content: "shed task" },
  "t-private": { id: "t-private", project_id: PRIVATE, section_id: null, parent_id: null, content: "secret" },
};

const SECTIONS: Record<string, Section[]> = {
  [HOME]: [{ id: "s-home", project_id: HOME, name: "Home section" }],
  [SHED]: [{ id: "s-shed", project_id: SHED, name: "Shed section" }],
  [PRIVATE]: [{ id: "s-private", project_id: PRIVATE, name: "Private section" }],
};

function fakeApi(): TodoistApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async listProjects(): Promise<Project[]> {
      calls.push("listProjects");
      return [
        { id: HOME, name: "Home" },
        { id: SHED, name: "Shed" },
        { id: PRIVATE, name: "Private" },
      ];
    },
    async getTask(id: string): Promise<Task> {
      calls.push(`getTask:${id}`);
      const task = TASKS[id];
      if (!task) throw new Error(`no such task ${id}`);
      return task;
    },
    async listTasks(_query: ListTasksQuery): Promise<Task[]> {
      return Object.values(TASKS);
    },
    async createTask(_payload: CreateTaskPayload): Promise<Task> {
      throw new Error("not used in ACL tests");
    },
    async updateTask(_id: string, _payload: UpdateTaskPayload): Promise<Task> {
      throw new Error("not used in ACL tests");
    },
    async moveTask(_id: string, _payload: MoveTaskPayload): Promise<Task> {
      throw new Error("not used in ACL tests");
    },
    async closeTask(): Promise<void> {},
    async reopenTask(): Promise<void> {},
    async deleteTask(): Promise<void> {},
    async listSections(projectId: string): Promise<Section[]> {
      calls.push(`listSections:${projectId}`);
      return SECTIONS[projectId] ?? [];
    },
    async listLabels(): Promise<Label[]> {
      return [];
    },
    async listComments(): Promise<Comment[]> {
      return [];
    },
    async addComment(): Promise<Comment> {
      throw new Error("not used in ACL tests");
    },
  };
}

const acl = new Acl(ACL_FILE);
const owner = acl.authenticate("key-owner-0123456789abcdef0123");
const guest = acl.authenticate("key-guest-0123456789abcdef0123");
const reader = acl.authenticate("key-reader-0123456789abcdef012");
const careful = acl.authenticate("key-careful-0123456789abcdef01");

// ── Authentication ────────────────────────────────────────────────────────

describe("authentication", () => {
  test("a valid key resolves to its principal", () => {
    expect(owner.name).toBe("owner");
    expect(guest.name).toBe("guest");
  });

  test("an unknown key is refused", () => {
    expect(() => acl.authenticate("key-nobody")).toThrow(AuthenticationError);
  });

  test("a missing key is refused", () => {
    expect(() => acl.authenticate(null)).toThrow(AuthenticationError);
    expect(() => acl.authenticate("")).toThrow(AuthenticationError);
  });
});

// ── Scope shape ───────────────────────────────────────────────────────────

describe("scope", () => {
  test('"*" grants every mapped project, and nothing else', () => {
    expect([...owner.projects.keys()].sort()).toEqual(["home", "shed"]);
    // The account's other projects are not denied — they are unrepresented.
    expect(owner.projectIds.has(PRIVATE)).toBe(false);
  });

  test("a listed scope grants exactly what it lists", () => {
    expect([...guest.projects.keys()]).toEqual(["home"]);
    expect(guest.projectIds.has(SHED)).toBe(false);
  });
});

// ── Configuration is rejected when it would be unsafe ─────────────────────

describe("acl file validation", () => {
  test("an unknown alias in a principal's scope is a load error", () => {
    expect(
      () =>
        new Acl({
          projects: { home: HOME },
          principals: { a: { apiKey: "k".repeat(32), role: "write", projects: ["nope"] } },
        }),
    ).toThrow(/unknown project alias/);
  });

  test("two principals may not share an api key", () => {
    expect(
      () =>
        new Acl({
          projects: { home: HOME },
          principals: {
            a: { apiKey: "k".repeat(32), role: "write", projects: ["home"] },
            b: { apiKey: "k".repeat(32), role: "read", projects: ["home"] },
          },
        }),
    ).toThrow(/reuses another principal's apiKey/);
  });

  test("an invalid role is a load error", () => {
    expect(
      () =>
        new Acl({
          projects: { home: HOME },
          principals: {
            a: { apiKey: "k".repeat(32), role: "admin" as never, projects: ["home"] },
          },
        }),
    ).toThrow(/invalid role/);
  });

  test("an empty project map is a load error", () => {
    expect(
      () => new Acl({ projects: {}, principals: ACL_FILE.principals }),
    ).toThrow(/`projects` is empty/);
  });
});

// ── Role ──────────────────────────────────────────────────────────────────

describe("role", () => {
  test("a write principal may run a mutating tool", () => {
    expect(() => assertWriteRole(guest, "todoist_create_task")).not.toThrow();
  });

  test("a read principal may not", () => {
    expect(() => assertWriteRole(reader, "todoist_create_task")).toThrow(AuthorizationError);
  });
});

// ── Tools denied by name ──────────────────────────────────────────────────
//
// The role split is coarse. This is the finer cut: a principal that must write
// but must not hold the one operation that cannot be undone.

describe("denyTools", () => {
  test("a denied tool is refused even though the role allows writing", () => {
    expect(() => assertToolAllowed(careful, "todoist_delete_task")).toThrow(AuthorizationError);
    expect(() => assertWriteRole(careful, "todoist_delete_task")).not.toThrow();
  });

  test("the principal's other write tools are untouched", () => {
    expect(() => assertToolAllowed(careful, "todoist_create_task")).not.toThrow();
    expect(() => assertToolAllowed(careful, "todoist_complete_task")).not.toThrow();
  });

  test("a principal with no denyTools denies nothing", () => {
    expect(careful.deniedTools.size).toBe(1);
    expect(owner.deniedTools.size).toBe(0);
    expect(() => assertToolAllowed(owner, "todoist_delete_task")).not.toThrow();
  });

  test("configuredDenials collects every name, for boot-time typo checking", () => {
    expect([...configuredDenials(acl)]).toEqual(["todoist_delete_task"]);
  });

  test("a denyTools that is not a list of names is a load error", () => {
    expect(
      () =>
        new Acl({
          projects: { home: HOME },
          principals: {
            a: {
              apiKey: "k".repeat(32),
              role: "write",
              projects: ["home"],
              denyTools: "todoist_delete_task" as never,
            },
          },
        }),
    ).toThrow(/invalid `denyTools`/);
  });
});

// ── Projects by alias ─────────────────────────────────────────────────────

describe("assertProjectAccess", () => {
  test("resolves an alias inside the scope", () => {
    expect(assertProjectAccess(guest, "home")).toBe(HOME);
  });

  test("refuses an alias outside the scope", () => {
    expect(() => assertProjectAccess(guest, "shed")).toThrow(AuthorizationError);
  });

  test("refuses an alias that does not exist at all", () => {
    expect(() => assertProjectAccess(owner, "atlantis")).toThrow(AuthorizationError);
  });

  test("the refusal names what is available, not what is hidden", () => {
    try {
      assertProjectAccess(guest, "shed");
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as Error).message).toContain("home");
      expect((error as Error).message).not.toContain(SHED);
    }
  });
});

describe("assertProjectIdAccess", () => {
  test("refuses an unmapped project id", () => {
    expect(() => assertProjectIdAccess(owner, PRIVATE)).toThrow(AuthorizationError);
  });
});

// ── Tasks by id: the bypass this whole file exists to prevent ─────────────

describe("assertTaskAccess", () => {
  test("allows a task in the caller's own project", async () => {
    const api = fakeApi();
    const { task, alias } = await assertTaskAccess(guest, api, "t-home");
    expect(task.id).toBe("t-home");
    expect(alias).toBe("home");
  });

  test("refuses a task id from a project outside the scope", async () => {
    const api = fakeApi();
    await expect(assertTaskAccess(guest, api, "t-shed")).rejects.toThrow(AuthorizationError);
  });

  test("refuses a task id from a project the service does not map at all", async () => {
    const api = fakeApi();
    await expect(assertTaskAccess(owner, api, "t-private")).rejects.toThrow(AuthorizationError);
  });

  test("the task is fetched before the verdict — the id is never trusted", async () => {
    const api = fakeApi();
    await assertTaskAccess(guest, api, "t-shed").catch(() => {});
    expect(api.calls).toContain("getTask:t-shed");
  });
});

// ── Destinations: where a write would land ────────────────────────────────

describe("assertSectionAccess", () => {
  test("allows a section in the caller's project", async () => {
    const api = fakeApi();
    const section = await assertSectionAccess(guest, api, "s-home");
    expect(section.project_id).toBe(HOME);
  });

  test("refuses a section belonging to a project outside the scope", async () => {
    const api = fakeApi();
    await expect(assertSectionAccess(guest, api, "s-shed")).rejects.toThrow(AuthorizationError);
  });

  test("refuses a section of an unmapped project even for a '*' principal", async () => {
    const api = fakeApi();
    await expect(assertSectionAccess(owner, api, "s-private")).rejects.toThrow(AuthorizationError);
  });

  test("refuses a section that is in scope but in the wrong target project", async () => {
    const api = fakeApi();
    // Allowed to reach both projects, but creating in `home` while pointing at
    // a section of `shed` is a mismatch, not a move.
    await expect(assertSectionAccess(owner, api, "s-shed", HOME)).rejects.toThrow(AuthorizationError);
  });

  test("never queries a project outside the scope", async () => {
    const api = fakeApi();
    await assertSectionAccess(guest, api, "s-shed").catch(() => {});
    expect(api.calls).toContain(`listSections:${HOME}`);
    expect(api.calls).not.toContain(`listSections:${SHED}`);
    expect(api.calls).not.toContain(`listSections:${PRIVATE}`);
  });
});

describe("assertParentAccess", () => {
  test("allows a parent in the caller's project", async () => {
    const api = fakeApi();
    const parent = await assertParentAccess(guest, api, "t-home");
    expect(parent.id).toBe("t-home");
  });

  test("refuses a parent from a forbidden project", async () => {
    const api = fakeApi();
    await expect(assertParentAccess(guest, api, "t-shed")).rejects.toThrow(AuthorizationError);
  });

  test("refuses an in-scope parent that sits in a different target project", async () => {
    const api = fakeApi();
    await expect(assertParentAccess(owner, api, "t-shed", HOME)).rejects.toThrow(AuthorizationError);
  });
});

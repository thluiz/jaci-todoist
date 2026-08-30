// acl.ts — who may touch what.
//
// This is the reason the service exists. Without it, this repository would be a
// thin proxy in front of a full-account Todoist token.
//
// Two ideas carry the whole design:
//
//   1. Callers name projects by alias, never by id. The mapping from alias to
//      Todoist id lives only here, so a project absent from the map is not
//      merely forbidden — it is invisible, and cannot be reached even by
//      guessing. That is why granting "*" is safe: it means every *mapped*
//      project, not every project in the account.
//
//   2. Every operation that takes an id validates the *target*, not just the
//      caller. Task ids leak — into URLs, notifications, exports. An ACL that
//      only checks "which project did you name?" is decorative, because the
//      caller can simply name nothing and pass an id instead.
//
// Nothing here knows about HTTP, MCP or any particular consumer.

import { readFile } from "node:fs/promises";
import type { Section, Task, TodoistApi } from "./todoist";

export type Role = "read" | "write";

export interface PrincipalConfig {
  apiKey: string;
  role: Role;
  /** Alias list, or "*" for every alias in the `projects` map. */
  projects: "*" | string[];
}

export interface AclFile {
  projects: Record<string, string>;
  principals: Record<string, PrincipalConfig>;
}

/** No key, or a key nobody owns. */
export class AuthenticationError extends Error {
  readonly status = 401;
  constructor(message = "Missing or invalid API key") {
    super(message);
    this.name = "AuthenticationError";
  }
}

/** A known caller reaching for something outside its scope. */
export class AuthorizationError extends Error {
  readonly status = 403;
  constructor(message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}

export interface Principal {
  readonly name: string;
  readonly role: Role;
  /** alias → Todoist project id, restricted to this principal's scope. */
  readonly projects: ReadonlyMap<string, string>;
  /** Todoist project id → alias, the same scope seen from the other side. */
  readonly projectIds: ReadonlyMap<string, string>;
}

export class Acl {
  private readonly byKey = new Map<string, Principal>();

  constructor(file: AclFile) {
    const aliases = new Map(Object.entries(file.projects ?? {}));
    if (aliases.size === 0) {
      throw new Error("acl: `projects` is empty — no project would ever be reachable");
    }
    for (const [alias, id] of aliases) {
      if (typeof id !== "string" || !id) {
        throw new Error(`acl: project alias "${alias}" has no Todoist id`);
      }
    }

    const entries = Object.entries(file.principals ?? {});
    if (entries.length === 0) {
      throw new Error("acl: `principals` is empty — nobody could call the service");
    }

    for (const [name, config] of entries) {
      if (!config?.apiKey) throw new Error(`acl: principal "${name}" has no apiKey`);
      if (this.byKey.has(config.apiKey)) {
        throw new Error(`acl: principal "${name}" reuses another principal's apiKey`);
      }
      if (config.role !== "read" && config.role !== "write") {
        throw new Error(`acl: principal "${name}" has invalid role ${JSON.stringify(config.role)}`);
      }
      if (config.apiKey.length < 24) {
        console.warn(`[acl] principal "${name}" has a short apiKey; prefer a 32+ char random value`);
      }

      const scope = new Map<string, string>();
      if (config.projects === "*") {
        for (const [alias, id] of aliases) scope.set(alias, id);
      } else if (Array.isArray(config.projects)) {
        for (const alias of config.projects) {
          const id = aliases.get(alias);
          if (!id) {
            throw new Error(
              `acl: principal "${name}" references unknown project alias "${alias}"`,
            );
          }
          scope.set(alias, id);
        }
      } else {
        throw new Error(`acl: principal "${name}" has invalid \`projects\` (expected "*" or a list)`);
      }

      const reverse = new Map<string, string>();
      for (const [alias, id] of scope) reverse.set(id, alias);

      this.byKey.set(config.apiKey, {
        name,
        role: config.role,
        projects: scope,
        projectIds: reverse,
      });
    }
  }

  static async load(path: string): Promise<Acl> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`acl: cannot read ${path}: ${reason}`);
    }
    return new Acl(JSON.parse(raw) as AclFile);
  }

  /** Resolves the caller, or refuses to serve one. */
  authenticate(apiKey: string | null | undefined): Principal {
    if (!apiKey) throw new AuthenticationError();
    const principal = this.byKey.get(apiKey);
    if (!principal) throw new AuthenticationError();
    return principal;
  }
}

// ── Assertions ────────────────────────────────────────────────────────────
//
// Each returns what it resolved, so a handler that has checked access does not
// have to fetch the same object again to use it.

/** A read-only principal may not run a mutating tool. */
export function assertWriteRole(principal: Principal, tool: string): void {
  if (principal.role !== "write") {
    throw new AuthorizationError(`Principal "${principal.name}" has read-only access; ${tool} is not permitted`);
  }
}

/** Alias → project id, refusing aliases outside the principal's scope. */
export function assertProjectAccess(principal: Principal, alias: string): string {
  const id = principal.projects.get(alias);
  if (!id) {
    throw new AuthorizationError(
      `Unknown or forbidden project "${alias}". Available: ${listAliases(principal)}`,
    );
  }
  return id;
}

/** Project id → alias, refusing ids outside the principal's scope. */
export function assertProjectIdAccess(principal: Principal, projectId: string): string {
  const alias = principal.projectIds.get(projectId);
  if (!alias) {
    throw new AuthorizationError(
      `That object belongs to a project outside your access. Available: ${listAliases(principal)}`,
    );
  }
  return alias;
}

/**
 * The load-bearing check: fetch the task and verify *its* project, before any
 * handler acts on it. Every tool that takes a task_id starts here.
 */
export async function assertTaskAccess(
  principal: Principal,
  api: TodoistApi,
  taskId: string,
): Promise<{ task: Task; alias: string }> {
  const task = await api.getTask(taskId);
  const alias = assertProjectIdAccess(principal, task.project_id);
  return { task, alias };
}

/**
 * Resolves a section id by looking for it among the principal's own projects.
 *
 * Scanning the allowed projects rather than asking Todoist "which project owns
 * this section?" means an out-of-scope section is never even resolved: not
 * found is the same answer as not permitted, and neither leaks anything.
 */
export async function assertSectionAccess(
  principal: Principal,
  api: TodoistApi,
  sectionId: string,
  expectedProjectId?: string,
): Promise<Section> {
  const candidates = expectedProjectId
    ? [expectedProjectId]
    : [...principal.projects.values()];

  for (const projectId of candidates) {
    if (!principal.projectIds.has(projectId)) continue;
    const sections = await api.listSections(projectId);
    const match = sections.find((section) => section.id === sectionId);
    if (match) return match;
  }

  throw new AuthorizationError(
    expectedProjectId
      ? `Section "${sectionId}" does not belong to the target project`
      : `Unknown or forbidden section "${sectionId}"`,
  );
}

/** A parent task is just a task: same check, phrased for the caller. */
export async function assertParentAccess(
  principal: Principal,
  api: TodoistApi,
  parentId: string,
  expectedProjectId?: string,
): Promise<Task> {
  const { task } = await assertTaskAccess(principal, api, parentId);
  if (expectedProjectId && task.project_id !== expectedProjectId) {
    throw new AuthorizationError(
      `Parent task "${parentId}" belongs to a different project than the one requested`,
    );
  }
  return task;
}

function listAliases(principal: Principal): string {
  const aliases = [...principal.projects.keys()];
  return aliases.length ? aliases.join(", ") : "(none)";
}

// tools.ts — the single registry of everything this service can do.
//
// Both facades (MCP over JSON-RPC and the mirrored REST endpoint) dispatch here,
// so there is exactly one copy of every rule. A tool added here appears in both
// without further work, and — more to the point — a permission check written
// here cannot be missing from one of them.
//
// Every handler that receives an id begins with the matching assertion from
// acl.ts. That ordering is the contract: check, then act.

import {
  assertParentAccess,
  assertProjectAccess,
  assertSectionAccess,
  assertTaskAccess,
  assertWriteRole,
  AuthorizationError,
  type Principal,
} from "./acl";
import type { Section, Task, TodoistApi } from "./todoist";

/** A caller-supplied argument that is missing or of the wrong type. */
export class InvalidArgumentError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "InvalidArgumentError";
  }
}

export interface ToolContext {
  principal: Principal;
  api: TodoistApi;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** Mutating tools are hidden from read-only principals and count against the write budget. */
  mutates: boolean;
  inputSchema: Record<string, unknown>;
  handler(args: Args, ctx: ToolContext): Promise<unknown>;
}

type Args = Record<string, unknown>;

// ── Argument helpers ──────────────────────────────────────────────────────

function requiredString(args: Args, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new InvalidArgumentError(`Missing required argument: ${name}`);
  }
  return value;
}

function optionalString(args: Args, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new InvalidArgumentError(`Argument ${name} must be a string`);
  }
  return value;
}

function optionalPriority(args: Args): number | undefined {
  const value = args.priority;
  if (value === undefined || value === null) return undefined;
  const priority = Number(value);
  if (!Number.isInteger(priority) || priority < 1 || priority > 4) {
    throw new InvalidArgumentError("Argument priority must be an integer from 1 (normal) to 4 (urgent)");
  }
  return priority;
}

function optionalLabels(args: Args): string[] | undefined {
  const value = args.labels;
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new InvalidArgumentError("Argument labels must be an array of strings");
  }
  return value as string[];
}

// ── Section resolution ────────────────────────────────────────────────────

/**
 * Sections are named, not aliased, so callers may pass either the name they see
 * in Todoist or the raw id. Both resolve inside a project the caller already
 * has access to, which is what keeps the lookup safe.
 */
async function resolveSection(
  principal: Principal,
  api: TodoistApi,
  projectId: string,
  reference: string,
): Promise<Section> {
  const sections = await api.listSections(projectId);
  const wanted = reference.trim().toLowerCase();
  const match =
    sections.find((section) => section.id === reference) ??
    sections.find((section) => section.name.trim().toLowerCase() === wanted);

  if (!match) {
    // Fall back to the id-based assertion so that a section id belonging to
    // another project produces an authorization error rather than "not found",
    // and so the refusal path is exercised by the same code either way.
    return assertSectionAccess(principal, api, reference, projectId);
  }
  return match;
}

// ── Output shaping ────────────────────────────────────────────────────────
//
// Responses speak aliases and names. Project ids never reach the caller: they
// are the service's business, and a caller that cannot name a project id cannot
// smuggle one back in.

async function sectionNameFor(api: TodoistApi, task: Task): Promise<string | undefined> {
  if (!task.section_id) return undefined;
  const sections = await api.listSections(task.project_id);
  return sections.find((section) => section.id === task.section_id)?.name;
}

async function shapeTask(task: Task, principal: Principal, api: TodoistApi): Promise<unknown> {
  return {
    task_id: task.id,
    content: task.content,
    description: task.description || undefined,
    project: principal.projectIds.get(task.project_id),
    section: await sectionNameFor(api, task),
    parent_id: task.parent_id ?? undefined,
    priority: task.priority,
    labels: task.labels?.length ? task.labels : undefined,
    due: task.due?.string ?? task.due?.date ?? undefined,
    is_recurring: task.due?.is_recurring || undefined,
    url: task.url,
  };
}

function shapeTasks(tasks: Task[], principal: Principal, api: TodoistApi): Promise<unknown[]> {
  return Promise.all(tasks.map((task) => shapeTask(task, principal, api)));
}

// ── Schema fragments ──────────────────────────────────────────────────────

const PROJECT_ARG = {
  type: "string",
  description: "Project alias, as returned by todoist_list_projects.",
};

const TASK_ID_ARG = {
  type: "string",
  description: "Task id, as returned by todoist_list_tasks or todoist_create_task.",
};

const SECTION_ARG = {
  type: "string",
  description: "Section name (or id) within the target project.",
};

// ── The registry ──────────────────────────────────────────────────────────

export const TOOLS: ToolDefinition[] = [
  {
    name: "todoist_list_projects",
    description:
      "List the Todoist projects you are allowed to work with. Every other tool refers to a " +
      "project by the alias returned here. Projects not listed are out of reach entirely.",
    mutates: false,
    inputSchema: { type: "object", properties: {} },
    async handler(_args, { principal, api }) {
      const projects = await api.listProjects();
      const names = new Map(projects.map((project) => [project.id, project.name]));
      return [...principal.projects].map(([alias, id]) => ({
        project: alias,
        name: names.get(id) ?? alias,
      }));
    },
  },

  {
    name: "todoist_list_tasks",
    description:
      "List active (not completed) tasks. Give a project alias, or a Todoist filter query such as " +
      "'today' or 'overdue'. Results are always restricted to the projects you may access.",
    mutates: false,
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT_ARG,
        section: SECTION_ARG,
        label: { type: "string", description: "Only tasks carrying this label." },
        filter: {
          type: "string",
          description:
            "Todoist filter query (for example 'today', 'overdue', 'p1'). May span projects; " +
            "anything outside your access is dropped from the result.",
        },
      },
    },
    async handler(args, { principal, api }) {
      const filter = optionalString(args, "filter");
      const projectAlias = optionalString(args, "project");

      if (filter) {
        const tasks = await api.listTasks({ filter });
        // A filter query is evaluated by Todoist over the whole account, so the
        // scope has to be reapplied here. This is the one place where results
        // are trimmed rather than refused: a broad query is a fair request, it
        // just cannot see further than the caller may.
        const visible = tasks.filter((task) => principal.projectIds.has(task.project_id));
        return shapeTasks(visible, principal, api);
      }

      if (!projectAlias) {
        throw new InvalidArgumentError("Provide either a project alias or a filter query");
      }

      const projectId = assertProjectAccess(principal, projectAlias);
      const sectionRef = optionalString(args, "section");
      const section = sectionRef
        ? await resolveSection(principal, api, projectId, sectionRef)
        : undefined;

      const tasks = await api.listTasks({
        project_id: projectId,
        section_id: section?.id,
        label: optionalString(args, "label"),
      });
      return shapeTasks(tasks, principal, api);
    },
  },

  {
    name: "todoist_get_task",
    description: "Get one task by id, including its description, due date, labels and section.",
    mutates: false,
    inputSchema: {
      type: "object",
      properties: { task_id: TASK_ID_ARG },
      required: ["task_id"],
    },
    async handler(args, { principal, api }) {
      const { task } = await assertTaskAccess(principal, api, requiredString(args, "task_id"));
      return shapeTask(task, principal, api);
    },
  },

  {
    name: "todoist_create_task",
    description:
      "Create a task in one of your projects. Pass parent_id to create a subtask. " +
      "due_string accepts natural language, for example 'tomorrow at 9am' or 'every monday'.",
    mutates: true,
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT_ARG,
        content: { type: "string", description: "Task title." },
        description: { type: "string", description: "Longer note attached to the task." },
        due_string: {
          type: "string",
          description: "Due date in natural language, for example 'tomorrow 18:00' or 'every friday'.",
        },
        priority: {
          type: "integer",
          description: "1 = normal, 2 = medium, 3 = high, 4 = urgent.",
        },
        labels: { type: "array", items: { type: "string" }, description: "Label names." },
        section: SECTION_ARG,
        parent_id: {
          type: "string",
          description: "Id of the parent task, to create this one as a subtask.",
        },
      },
      required: ["project", "content"],
    },
    async handler(args, { principal, api }) {
      const projectId = assertProjectAccess(principal, requiredString(args, "project"));

      // Both destinations are validated against the *target* project, not just
      // against the caller's scope: an in-scope section that lives in another
      // project would silently relocate the task.
      const sectionRef = optionalString(args, "section");
      const section = sectionRef
        ? await resolveSection(principal, api, projectId, sectionRef)
        : undefined;

      const parentId = optionalString(args, "parent_id");
      if (parentId) await assertParentAccess(principal, api, parentId, projectId);

      const task = await api.createTask({
        project_id: projectId,
        content: requiredString(args, "content"),
        description: optionalString(args, "description"),
        due_string: optionalString(args, "due_string"),
        priority: optionalPriority(args),
        labels: optionalLabels(args),
        section_id: section?.id,
        parent_id: parentId,
      });
      return shapeTask(task, principal, api);
    },
  },

  {
    name: "todoist_update_task",
    description:
      "Change a task's title, description, priority or labels. " +
      "To change the due date use todoist_reschedule_task; to change project or section use todoist_move_task.",
    mutates: true,
    inputSchema: {
      type: "object",
      properties: {
        task_id: TASK_ID_ARG,
        content: { type: "string", description: "New task title." },
        description: { type: "string", description: "New note." },
        priority: { type: "integer", description: "1 = normal, 2 = medium, 3 = high, 4 = urgent." },
        labels: {
          type: "array",
          items: { type: "string" },
          description: "Replaces the task's labels entirely.",
        },
      },
      required: ["task_id"],
    },
    async handler(args, { principal, api }) {
      const taskId = requiredString(args, "task_id");
      await assertTaskAccess(principal, api, taskId);

      const payload = {
        content: optionalString(args, "content"),
        description: optionalString(args, "description"),
        priority: optionalPriority(args),
        labels: optionalLabels(args),
      };
      if (Object.values(payload).every((value) => value === undefined)) {
        throw new InvalidArgumentError("Provide at least one field to update");
      }

      // due_string is deliberately absent: sending it here would overwrite a
      // recurrence rule with a one-off date. That is what reschedule is for.
      const task = await api.updateTask(taskId, payload);
      return shapeTask(task, principal, api);
    },
  },

  {
    name: "todoist_reschedule_task",
    description:
      "Set a task's due date. Kept separate from todoist_update_task because a due date sent as " +
      "part of a general update replaces a recurrence rule instead of moving the next occurrence.",
    mutates: true,
    inputSchema: {
      type: "object",
      properties: {
        task_id: TASK_ID_ARG,
        due_string: {
          type: "string",
          description:
            "Due date in natural language: 'tomorrow', 'next monday 9am', 'every 2 weeks'. " +
            "Use 'no date' to clear it.",
        },
      },
      required: ["task_id", "due_string"],
    },
    async handler(args, { principal, api }) {
      const taskId = requiredString(args, "task_id");
      await assertTaskAccess(principal, api, taskId);
      const task = await api.updateTask(taskId, { due_string: requiredString(args, "due_string") });
      return shapeTask(task, principal, api);
    },
  },

  {
    name: "todoist_move_task",
    description:
      "Move a task to another project, section, or under another task as a subtask. " +
      "Kept separate from todoist_update_task, where these fields would cause an accidental move.",
    mutates: true,
    inputSchema: {
      type: "object",
      properties: {
        task_id: TASK_ID_ARG,
        project: { ...PROJECT_ARG, description: "Destination project alias. Defaults to the current one." },
        section: SECTION_ARG,
        parent_id: { type: "string", description: "Id of the task to become the new parent." },
      },
      required: ["task_id"],
    },
    async handler(args, { principal, api }) {
      const taskId = requiredString(args, "task_id");
      const { task } = await assertTaskAccess(principal, api, taskId);

      const projectAlias = optionalString(args, "project");
      const destinationProjectId = projectAlias
        ? assertProjectAccess(principal, projectAlias)
        : task.project_id;

      const sectionRef = optionalString(args, "section");
      const section = sectionRef
        ? await resolveSection(principal, api, destinationProjectId, sectionRef)
        : undefined;

      const parentId = optionalString(args, "parent_id");
      if (parentId) await assertParentAccess(principal, api, parentId, destinationProjectId);

      if (!projectAlias && !section && !parentId) {
        throw new InvalidArgumentError("Provide a destination: project, section or parent_id");
      }

      // Todoist treats these as mutually exclusive destinations; send the most
      // specific one the caller asked for.
      const payload = parentId
        ? { parent_id: parentId }
        : section
          ? { section_id: section.id }
          : { project_id: destinationProjectId };

      const moved = await api.moveTask(taskId, payload);
      return shapeTask(moved ?? task, principal, api);
    },
  },

  {
    name: "todoist_complete_task",
    description: "Mark a task as done. A recurring task advances to its next occurrence instead.",
    mutates: true,
    inputSchema: {
      type: "object",
      properties: { task_id: TASK_ID_ARG },
      required: ["task_id"],
    },
    async handler(args, { principal, api }) {
      const taskId = requiredString(args, "task_id");
      const { task, alias } = await assertTaskAccess(principal, api, taskId);
      await api.closeTask(taskId);
      return { completed: true, task_id: taskId, content: task.content, project: alias };
    },
  },

  {
    name: "todoist_reopen_task",
    description: "Reopen a completed task.",
    mutates: true,
    inputSchema: {
      type: "object",
      properties: { task_id: TASK_ID_ARG },
      required: ["task_id"],
    },
    async handler(args, { principal, api }) {
      const taskId = requiredString(args, "task_id");
      await assertTaskAccess(principal, api, taskId);
      await api.reopenTask(taskId);
      return { reopened: true, task_id: taskId };
    },
  },

  {
    name: "todoist_delete_task",
    description:
      "Delete a task permanently, along with its subtasks. This cannot be undone — " +
      "prefer todoist_complete_task unless the task was created by mistake.",
    mutates: true,
    inputSchema: {
      type: "object",
      properties: { task_id: TASK_ID_ARG },
      required: ["task_id"],
    },
    async handler(args, { principal, api }) {
      const taskId = requiredString(args, "task_id");
      const { task, alias } = await assertTaskAccess(principal, api, taskId);
      await api.deleteTask(taskId);
      return { deleted: true, task_id: taskId, content: task.content, project: alias };
    },
  },

  {
    name: "todoist_list_sections",
    description: "List the sections of one of your projects.",
    mutates: false,
    inputSchema: {
      type: "object",
      properties: { project: PROJECT_ARG },
      required: ["project"],
    },
    async handler(args, { principal, api }) {
      const projectId = assertProjectAccess(principal, requiredString(args, "project"));
      const sections = await api.listSections(projectId);
      return sections.map((section) => ({ section: section.name, section_id: section.id }));
    },
  },

  {
    name: "todoist_list_labels",
    description: "List the label names available in the account, for use when creating or updating tasks.",
    mutates: false,
    inputSchema: { type: "object", properties: {} },
    async handler(_args, { api }) {
      const labels = await api.listLabels();
      return labels.map((label) => label.name);
    },
  },

  {
    name: "todoist_list_comments",
    description: "List the comments on a task.",
    mutates: false,
    inputSchema: {
      type: "object",
      properties: { task_id: TASK_ID_ARG },
      required: ["task_id"],
    },
    async handler(args, { principal, api }) {
      const taskId = requiredString(args, "task_id");
      await assertTaskAccess(principal, api, taskId);
      const comments = await api.listComments(taskId);
      return comments.map((comment) => ({
        comment_id: comment.id,
        content: comment.content,
        posted_at: comment.posted_at,
      }));
    },
  },

  {
    name: "todoist_add_comment",
    description: "Add a comment to a task.",
    mutates: true,
    inputSchema: {
      type: "object",
      properties: {
        task_id: TASK_ID_ARG,
        content: { type: "string", description: "Comment text." },
      },
      required: ["task_id", "content"],
    },
    async handler(args, { principal, api }) {
      const taskId = requiredString(args, "task_id");
      await assertTaskAccess(principal, api, taskId);
      const comment = await api.addComment(taskId, requiredString(args, "content"));
      return { comment_id: comment.id, task_id: taskId };
    },
  },
];

const BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

export function findTool(name: string): ToolDefinition | undefined {
  return BY_NAME.get(name);
}

/**
 * The tools a principal may see. A read-only caller is not told that the
 * mutating tools exist: a tool the model cannot see is one it cannot invent a
 * reason to call.
 */
export function toolsFor(principal: Principal): ToolDefinition[] {
  return principal.role === "write" ? TOOLS : TOOLS.filter((tool) => !tool.mutates);
}

/** Single entry point for both facades: role check, then the handler. */
export async function runTool(name: string, args: Args, ctx: ToolContext): Promise<unknown> {
  const tool = findTool(name);
  if (!tool) throw new InvalidArgumentError(`Unknown tool: ${name}`);
  if (tool.mutates) assertWriteRole(ctx.principal, name);
  if (!ctx.principal.projects.size) {
    throw new AuthorizationError(`Principal "${ctx.principal.name}" has no projects in scope`);
  }
  return tool.handler(args ?? {}, ctx);
}

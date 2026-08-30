# jaci-todoist

A small Bun service that lets an agent work with a **bounded slice** of a Todoist
account — create, read, reschedule, move, comment on and complete tasks — while
the account token itself stays out of the agent's reach.

It speaks two protocols over one implementation:

| Facade | Endpoint | For |
| --- | --- | --- |
| MCP (Streamable HTTP, protocol `2024-11-05`) | `POST /mcp`, `GET /mcp` | MCP clients |
| REST | `POST /call/{tool}`, body = the tool's arguments | anything that can send JSON |

Nothing in the code names a particular bot, person or project. Everything
specific to a deployment lives in `acl.json` and the nginx route, so the same
service can serve several consumers with different scopes.

## Why it exists

A Todoist API token is all-or-nothing: it opens the whole account. Handing one
to an agent means handing over every project in it. This service sits in front
of the token and answers a narrower question — *may this caller touch this
object?* — before anything reaches Todoist.

## Authorization

Identity is the `X-Api-Key` header, and only that. It is never an argument,
because an argument is something a model can invent.

`acl.json` maps aliases to project ids and principals to scopes:

```jsonc
{
  "projects": {
    "home": "6XXXXXXXXXXXXXXX",
    "errands": "6YYYYYYYYYYYYYYY"
  },
  "principals": {
    "assistant": { "apiKey": "…", "role": "write", "projects": "*" },
    "household": { "apiKey": "…", "role": "write", "projects": ["home"] }
  }
}
```

Three properties are worth stating plainly, because they are what make the
boundary hold:

**Projects are named by alias, never by id.** The alias→id map lives only in the
service. A project missing from the map is not merely forbidden — it is
unnameable, and no argument the caller can construct will reach it. That is why
`"projects": "*"` is safe: it means *every mapped project*, not every project in
the account.

**Every operation validates its target, not just its caller.** A tool that takes
a `task_id` fetches the task and checks *its* project before acting. Without
that step the whole scheme is decorative: task ids leak into URLs, notifications
and exports, so a caller that cannot name a forbidden project could still pass
an id belonging to one. The same applies to destinations — a `section` or
`parent_id` on create and move is checked against the target project, since
either could otherwise relocate a task out of scope.

**Read-only principals are not shown the mutating tools.** `tools/list` is
filtered by role, and `role` is enforced again at dispatch. A tool the model
cannot see is a tool it cannot talk itself into calling.

Every call is appended to `logs/YYYY-MM-DD.ndjson` with the principal's *name*,
the tool, the target ids and the outcome. Refusals are logged as loudly as
successes — a run of denials is how a looping agent or a leaked key announces
itself. Keys, tokens and task contents are never written there.

Mutating calls are also budgeted per principal, per minute and per day. That is
not a defence against an attacker holding a valid key; it is a limit on how much
damage a model stuck in a retry loop can do before someone notices.

## Two tools that look like one

`todoist_update_task` deliberately cannot set a due date or a destination:

- Sending a due date through a general update **replaces a recurrence rule**
  with a one-off date. `todoist_reschedule_task` exists so that cannot happen by
  accident.
- Sending `project_id`, `section_id` or `parent_id` through an update is
  interpreted by Todoist as a **move**. `todoist_move_task` makes the move
  explicit.

Both separations are covered by tests that assert the fields are absent from the
update schema and dropped if a caller sends them anyway.

## The API key belongs to the proxy, not the agent

The intended deployment puts one nginx `location` per principal in front of the
service, each injecting that principal's key:

```nginx
location /api/todoist/assistant/ {
    proxy_pass http://127.0.0.1:8008/;
    proxy_set_header X-Api-Key <that principal's key>;
    # …
}
```

The agent is configured with a URL and no credentials at all. `proxy_set_header`
replaces whatever the client sent, so a caller cannot promote itself by
supplying someone else's key. Identity becomes the path it arrived on.

The limit is worth knowing: any process that can reach the listener can call
every location on it. Separation between two principals on the same listener
therefore only holds if the narrower one cannot open sockets — so give the
broader scope to the consumer that has shell access, never the other way round.
The generated route says the same thing in a comment at the top, where whoever
edits it next will read it.

The route is not written by hand. `render-route.sh` generates it from
`acl.json` — one `location` per principal, keyed by the principal's own name:

```bash
./render-route.sh > todoist.conf
```

The route and the ACL are two views of the same list, so generating one from
the other is what keeps them from drifting. Adding a consumer is one edit to
`acl.json`, a re-render, and a reload — no code change and no restart.

## Running it

```bash
cp .env.example .env          # fill in TODOIST_TOKEN, then chmod 600 .env
cp acl.example.json acl.json  # map your projects, generate keys, chmod 600
bun test
bun run server.ts
```

`GET /health` needs no key. `GET /tools` returns the caller's own scope and tool
list, which is the quickest way to confirm a key is wired correctly.

`acl.json` is re-read when its modification time changes, so adding a project or
a principal takes effect without restarting the service.

## Deployment (HermesTools)

1. Clone to `/home/hermes/services/jaci-todoist`.
2. Write `.env` and `acl.json` in place; `chmod 600` both.
3. Install `jaci-todoist.service` into `/etc/systemd/system/`, then
   `systemctl daemon-reload && systemctl enable --now jaci-todoist`.
4. `./render-route.sh > todoist.conf`, install it (mode 600, root) as
   `/etc/nginx/hermes-routes/agent/todoist.conf`, then `nginx -t` and reload.

The service listens on loopback only. It is reached through the agent-facing
listener on `127.0.0.1:8090`, which serves an explicit allow-list of routes and
403s everything else. It is deliberately **not** published on the shared `:8080`
listener, whose route directory is also included by a TLS listener reachable
over the machine's VPN.

## Tools

| Tool | Arguments |
| --- | --- |
| `todoist_list_projects` | — |
| `todoist_list_tasks` | `project` \| `filter`, `section?`, `label?` |
| `todoist_get_task` | `task_id` |
| `todoist_create_task` | `project`, `content`, `description?`, `due_string?`, `priority?`, `labels?`, `section?`, `parent_id?` |
| `todoist_update_task` | `task_id`, `content?`, `description?`, `priority?`, `labels?` |
| `todoist_reschedule_task` | `task_id`, `due_string` |
| `todoist_move_task` | `task_id`, `project?`, `section?`, `parent_id?` |
| `todoist_complete_task` | `task_id` |
| `todoist_reopen_task` | `task_id` |
| `todoist_delete_task` | `task_id` |
| `todoist_list_sections` | `project` |
| `todoist_list_labels` | — |
| `todoist_list_comments` | `task_id` |
| `todoist_add_comment` | `task_id`, `content` |

Sections may be given by the name shown in Todoist or by id. Project ids never
appear in a request or a response.

## Layout

| File | |
| --- | --- |
| `server.ts` | HTTP routing, authentication, auditing, write budget |
| `mcp.ts` | JSON-RPC framing for the MCP facade |
| `tools.ts` | the tool registry — schemas and handlers, one copy for both facades |
| `acl.ts` | principals, scopes and the assertions every handler starts with |
| `todoist.ts` | Todoist API v1 client |
| `budget.ts` | per-principal write ceiling |
| `logger.ts` | daily NDJSON audit trail |
| `render-route.sh` | generates the nginx route from `acl.json` |

`acl.test.ts` covers the permission boundary; almost every assertion in it is
about something being refused. `tools.test.ts` covers the registry, the role
filter and the two schema separations.

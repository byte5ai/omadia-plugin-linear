# `@omadia/agent-linear`

The **Linear agent**: the Omadia plugin that carries the Linear tools and their
prompt. From any channel it can search and read Linear issues, and create,
change or comment on them — with every change shown as a preview first and
applied only after the user confirms it.

It holds no credential. Linear is reached through the **Linear API capability**
(`linear.api@1`) published by [`@omadia/integration-linear`](../omadia-integration-linear),
which owns the personal API key and the `api.linear.app` egress allow-list. The
client contract is that package's `INTEGRATION.md`; read it before changing
anything here.

```
@omadia/integration-linear          @omadia/agent-linear
  linear_api_key (secret)             default_team_key (string)
  provides: linear.api@1      <────   requires: linear.api@^1
  egress: api.linear.app              egress: none
```

## Install

1. Install and configure `@omadia/integration-linear` first. Without it this
   plugin's `requires:` is unresolved and it will not activate.
2. `npm run build` here, then upload `out/omadia-agent-linear-<version>.zip`
   via Admin → Store → tab "Lokal". (Or
   `POST /api/v1/install/plugins/:id` followed by `/configure`.)
3. Enter the **default team key** — the prefix of that team's issue keys, so
   `OMA` for `OMA-7`. It is the team used whenever a request does not name one.

The orchestrator reaches this agent as the tool `query_linear`, derived from the
plugin id. The five tools below are the sub-agent's, not the orchestrator's.

## The five tools

| Tool | What it does |
|---|---|
| `linear_search_issues` | Issues by team, stage of work, assignee or free text. Returns one compact summary per issue. |
| `linear_get_issue` | One issue by key, with its description and most recent comments. |
| `linear_lookup` | Teams, workflow states, workspace members or labels — the records a write refers to by name. |
| `linear_prepare_write` | Validates and stages a change, returns a token plus a preview. **Writes nothing.** |
| `linear_commit_write` | Applies one staged change. The only code path that mutates Linear. |

Editable: state, assignee, priority, title, description, labels. Not editable:
project, cycle, estimate, parent. There is no delete and no archive; "closing"
an issue is a move to a state whose type is `completed` or `canceled`.

## The write gate

Core does not enforce a two-phase confirm for any tool kind, so the gate lives
in this plugin — and it has to work across two orchestrator turns, because the
sub-agent this toolkit runs in is stateless. `LocalSubAgent.ask()` starts each
call with a single user message, so a confirmation cannot reach the agent on its
own: the token has to travel out in the agent's answer and come back in the next
question. That is what the `nextStep` field of `linear_prepare_write` and the
"How you are called" section of the prompt partial are for.

1. `linear_prepare_write` resolves every name to a Linear record, validates the
   change, renders a preview and stages it under a token. Nothing in Linear
   changes.
2. The agent ends its turn, returning the preview and the token verbatim to the
   orchestrator, which shows them to the user and asks.
3. The next question carries the token plus the user's yes.
   `linear_commit_write` takes the token — removing it from the store first —
   and applies exactly that staged change.

Properties this buys, and where they are enforced:

- **A staged write is inert.** `src/preparedWrites.ts` holds descriptors, not
  requests. A test asserts that a full round of prepare calls reaches none of
  `createIssue`, `updateIssue` or `addComment`.
- **A token applies once.** `take()` deletes before it returns, so a retried or
  racing commit cannot double-apply. The cost: a commit that fails upstream
  needs a fresh preview.
- **A token expires after ten minutes.** A preview describes the issue as it was
  when the preview was rendered; past that, the token dies rather than applying
  a change the user agreed to against a different state of the world.
- **Nothing survives a restart or a deactivate.** The store is in-memory and
  `close()` clears it.

What the store deliberately does **not** promise: conversation scope. The kernel
keeps one activation per plugin id, so a single store serves every orchestrator
in the process. A token is unguessable, single-use and short-lived, but it is
not bound to the conversation that produced it.

The prompt half of the same rule is `skills/linear-expert.md`, which the runtime
loads as the system prompt. Both halves are needed: the store makes a *double*
write impossible, but only the prompt stops a model from committing its own
preview in the turn it produced it.

## Layout

```
manifest.yaml            identity, depends_on + requires, the one setup field, skills
skills/linear-expert.md  system prompt: vocabulary, the write rule, how to answer
src/plugin.ts            activate(ctx) -> { toolkit, close }
src/toolkit.ts           the five tools: schemas, validation, prepare/commit
src/lookup.ts            name -> id, with a 5-minute cache and no guessing
src/preview.ts           descriptor -> the sentence a person says yes to
src/preparedWrites.ts    the token store: stage, take-once, expiry
src/errors.ts            LinearAgentError: refusals, the errors the host passes on to the model
```

## Development

```bash
npm install
npm run typecheck        # tsc --noEmit over src/ and tests/
npm test                 # node:test via esbuild, no test framework
npm run build            # typecheck + test + zip into out/
```

`npm run typecheck` compiles against the **built** declarations of the adjacent
checkouts (`../omadia-integration-linear/dist`, `../omadia/middleware/packages/plugin-api/dist`)
through tsconfig `paths`. If the connection package has not been built, the
Linear types resolve to nothing — run its `npm run build` first.

`zod` and `@omadia/plugin-api` are host-provided peers and are kept **external**
in the bundle. Inlining zod would be the subtle one: the kernel's tool bridge
reads Zod's `_def` internals to derive each tool's JSON schema, and a schema
built by a second zod instance would silently come out as `{}` — the tools would
appear with no arguments at all.

## Notes on decisions that are not obvious from the code

- **No `capabilities:` block in the manifest.** For a `kind: agent` plugin the
  loader reads capability entries only to resolve the `canvas_output`,
  `deterministic_action` and `event_emit` flags, none of which apply here; the
  tools the model sees come from the toolkit. Declaring all five a second time
  as JSON Schema would be a copy with nothing to keep it honest.
- **`self_test: false`, and no connection check of its own.** Whether the API
  key works is the Linear connection's answer: it exports the check core runs
  after every activation and shows in the Store. This plugin holds no
  credential to check. (`self_test: true` would oblige it to ship an
  `onConfigure` hook, which core does not call.)
- **`linear_prepare_write` takes an enum `kind` plus flat optional fields**
  rather than the discriminated union its three shapes are asking for. The
  host's Zod-to-JSON-schema bridge degrades a union to `{}` without warning, so
  the per-kind field rules are enforced in `validateWriteInput` instead — and a
  field that does not belong to the given kind is an error rather than being
  quietly dropped.
- **Every tool input is `.strict()`.** Zod's default is to strip an undeclared
  key, so `state` instead of `stateName` would be dropped and the preview would
  faithfully describe a write that omits the change the user asked for. Strict
  turns a typo into an error the model can see. The kernel's schema bridge
  ignores the flag, so the published tool definitions are unchanged.
- **Ambiguity is never resolved by guessing.** Two people called Kim, or a state
  name matching two states, is an error that lists the candidates. A preview is
  shown to a person as fact, so picking the first match would state a decision
  nobody made. Exact name matches do win over substring ones, so `Done` resolves
  to `Done` even when `Done (deployed)` exists.
- **Every error written for the model is a refusal.** The host withholds the
  message of whatever a tool throws: the model gets a class name and a log
  reference, and is told the outcome is unknown. The exception is an error
  named `ToolRefusalError` with a one-line message, which reaches the model as
  `refused the call: …`, cut at 600 characters. `LinearAgentError` carries that
  name, so "team OMA has no state called Closed" arrives intact and the model
  can correct itself. Two things follow. A refusal is one line and its variable
  parts are bounded — a name quoted back, a candidate list — so the sentence
  that says what to do next is never the part that gets cut; a shortened list
  says how many entries there are and points at `linear_lookup`. And a refusal
  is only ever thrown when nothing was written. Errors from the connection are
  not refusals and stay withheld, with one exception: a rate limit, which is
  reported with a text written here and the reset time, because Linear turned
  the request away and "wait" is something a person can act on. On a host older
  than this rule a refusal is withheld like any other error.
- **`assignee: "none"` clears the assignee**, on `update_issue` only. The
  editable set includes the assignee and the client documents `assigneeId: null`
  as the way to clear it; without this there would be no way to unassign. On
  `create_issue` it is refused, because omitting the field already means that.
- **Lookups are cached for five minutes.** A personal API key is capped near
  2,500 requests an hour and `ctx.http` allows 60 a minute per plugin. Resolving
  a team, a state and two labels is four requests, and doing that every turn
  against an unchanged workspace spends the budget on answers already known.
- **`linear_get_issue` sorts the comments itself.** The client's comment query
  sets no `orderBy`, so the order Linear returns is a default nobody here
  controls; slicing without sorting would have returned the oldest comments
  under the label "most recent".
- **A wrong team key is not caught at activation.** Validating it would mean a
  network call in `activate()`. Instead the first tool call fails with a message
  naming the team keys that do exist.

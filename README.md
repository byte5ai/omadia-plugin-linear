# `@omadia/agent-linear`

The **Linear agent**: the Omadia plugin that carries the Linear tools and their
prompt. From any channel it can search and read Linear issues, and create,
change or comment on them. By default every change is shown as a preview first
and applied only after the user confirms it; the operator can switch the
confirmation off, or switch changes off altogether.

It holds no credential. Linear is reached through the **Linear API capability**
(`linear.api@2`) published by [`@omadia/integration-linear`](../omadia-integration-linear),
which owns the personal API key and the `api.linear.app` egress allow-list. The
client contract is that package's `INTEGRATION.md`; read it before changing
anything here.

```
@omadia/integration-linear          @omadia/agent-linear
  linear_api_key (secret)             default_team_key, linear_write_mode
  provides: linear.api@2      <────   requires: linear.api@^2
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
4. Choose how **changes to Linear** are made (`linear_write_mode`):

   | Value | What the agent does |
   |---|---|
   | `confirm` (default) | Shows every change as a preview and applies it only after the user says yes in the conversation. |
   | `direct` | Applies a change as soon as it is asked for. No preview, no undo. |
   | `off` | Reads only. The write tools are not offered to the model at all. |

   A Linear API key restricted to reading passes the connection check all the
   same, because that check only reads. With such a key choose `off`:
   otherwise the agent offers changes that all fail at Linear.

The orchestrator reaches this agent as the tool `query_linear`, derived from the
plugin id. The tools below are the sub-agent's, not the orchestrator's.

## The tools

| Tool | Write mode | What it does |
|---|---|---|
| `linear_search_issues` | all | Issues by team, stage of work (triage included), assignee, creator, label, priority, project, cycle, time of creation, last update or completion, or free text. Returns one compact summary per issue, one page at a time, and says whether more match. |
| `linear_get_issue` | all | One issue by key, with its description and most recent comments. |
| `linear_lookup` | all | Teams, workflow states, workspace members, labels, projects or cycles — the records a search or a write refers to by name. Marks the current cycle. |
| `linear_prepare_write` | `confirm` | Validates and stages a change, returns a preview and its expiry. **Writes nothing.** |
| `linear_commit_write` | `confirm` | Applies the change staged in the calling conversation. |
| `linear_write` | `direct` | Validates a change and applies it at once. |

Editable: state, assignee, priority, title, description, labels. Not editable:
project, cycle, estimate, parent — an issue's project and cycle are shown and
can be searched by, not changed. There is no delete and no archive; "closing"
an issue is a move to a state whose type is `completed` or `canceled`.

## Finding issues

`linear_search_issues` takes flat, optional filters, and every one given has
to match:

| Filter | Takes |
|---|---|
| `teamKey` | A team key. Defaults to the configured team. |
| `stateType` | `triage`, `backlog`, `unstarted`, `started`, `completed`, `canceled`. |
| `assignee`, `creator` | `me` (the API key's owner) or a person's name. |
| `label`, `project` | A name. |
| `cycle` | `current`, `next` or `previous`, a cycle number, or a cycle name. |
| `priority` | 0 to 4. |
| `createdAfter` / `createdBefore`, `updatedAfter` / `updatedBefore`, `completedAfter` / `completedBefore` | A date (`2026-11-02`), a timestamp with its zone, or a span back from now (`-P7D`, `-P2W`, `-P1M`). |
| `text` | Full-text search over title and description. |

A name resolves the way it does for a write: an unknown or ambiguous label,
project, cycle or person is a refusal that lists the candidates. The span
back from now is what lets a model ask for "last week" without knowing
today's date; Linear resolves it when the search runs.

A result is one page (`limit`, at most 50) and says so: `hasMore` is true
when more issues match, and `cursor` fetches them when passed back with the
same filters. The cursor the model sees is Linear's, re-spelled
(`src/cursor.ts`): a host that masks tool results lets a model read a string
only when it looks like an identifier, and Linear promises no shape for its
cursors. `count`, `hasMore` and `cursor` are the names the host knows as the
paging data of a result; under another name it would copy them into every
issue row.

`linear_lookup` reads a collection to its end, so a name on a later page
resolves like one on the first. What it lists is cut at 250 records, with
`hasMore` and `total` saying so; `query` narrows before the cut.

## The write gate

Core does not enforce a two-phase confirm for any tool kind, so in the
`confirm` mode the gate lives in this plugin. It spans two turns of the
conversation: one that shows the preview, one that brings the user's yes.

1. `linear_prepare_write` resolves every name to a Linear record, validates the
   change, renders a preview and stages it for the calling conversation.
   Nothing in Linear changes. The result is `{ preview, expiresAt }`.
2. The Linear agent ends its turn. The orchestrator shows the user the preview
   and asks.
3. The user confirms. The orchestrator asks the Linear agent again and says
   so. `linear_commit_write` takes no input: it applies the change staged for
   the calling conversation, removing it from the store first.

### Who is calling

A tool gets its input and nothing else as an argument, and the Linear agent is
stateless: `LocalSubAgent.ask()` starts each call with a single user message.
What connects step 3 to step 1 is the host's **turn context**, a service
published as the capability `turnContext@1` (`optional_requires:` in the
manifest, read in `src/caller.ts`). For the call in flight it names the agent,
the user, the session and the turn. The first three together are the
conversation a prepared write is staged under; the turn is what tells a commit
made after the user answered from one made before.

That is why no handle travels with the conversation. An earlier version
returned a token that the Linear agent had to hand to the orchestrator, the
orchestrator had to write into its answer, and the next turn had to bring back
— past a privacy filter that masks strings in tool results, and across a turn
boundary that keeps only the answer text. Every station could lose it.

Properties this buys, and where they are enforced (`src/preparedWrites.ts`):

- **A staged write is inert.** The store holds descriptors, not requests. A
  test asserts that a full round of prepare calls reaches none of
  `createIssue`, `updateIssue` or `addComment`.
- **It belongs to its conversation.** A commit from another conversation,
  another user or another agent finds nothing.
- **Not in the turn that prepared.** `take()` refuses a commit whose turn is
  the one that staged the write, and leaves the write where it is. The prompt
  says the same, but this half no longer depends on the model following it.
- **One per conversation.** A second prepare in the same turn is refused: of
  two previews made in one turn, nobody could say which one the user saw. A
  prepare in a later turn replaces the earlier one. Several changes asked for
  at once are therefore confirmed one after the other; for bulk work the
  `direct` mode is the tool.
- **It applies once.** `take()` deletes before it returns, so a retried or
  racing commit cannot double-apply. The cost: a commit that fails upstream
  needs a fresh preview.
- **It expires after ten minutes.** A preview describes the issue as it was
  when the preview was rendered; past that, the write dies rather than
  applying a change the user agreed to against a different state of the world.
  An expired write is kept for a day without being committable, so a late yes
  is told "expired, prepare it again" instead of "nothing was prepared".
- **Nothing survives a restart or a deactivate.** The store is in-memory and
  `close()` clears it.

**"No" does not discard a prepared change.** When the user declines, the
orchestrator usually answers without calling the Linear agent, so the change
stays staged. It ends in one of three ways: it expires after ten minutes, a
newer prepare in the same conversation replaces it, or it is committed. Until
then a later yes in the same conversation could still apply it — the preview
the user declined.

What the gate does **not** decide is whether the user said yes. That is the
orchestrator's reading of the user's message, and the Linear agent's reading
of the orchestrator's question. `playbook.when_to_use` in the manifest carries
the orchestrator's half of the rule — it becomes the description of
`query_linear`, the one text of this package the orchestrator reads before it
calls — and `skills/linear-expert.md` carries the agent's half.

### Where a change cannot be confirmed

A call that belongs to no conversation gets a refusal instead of a preview
nobody could confirm: a scheduled routine, a tool called by another plugin, a
channel that names no conversation, or a host that does not publish the turn
context (the activation log says so). Reading works everywhere, and so does the
`direct` mode.

### Under the Privacy Shield

In the host's default privacy mode a model does not read a tool result. The
host keeps it and hands the model a digest: numbers, dates and handles in
clear, every other string as `[masked]`. The user sees the real values, because
the host renders them. For `linear_prepare_write` that means the preview
reaches the user without passing through a model at all, and the model reads
only until when it can be confirmed.

Two things follow. A result carries no instruction: a text field is shown to
the user and masked for the model, so the one reader it was written for never
gets it. And the prompt partial is written for both forms of a result: it
tells the agent to quote a preview it can read, and to point at the result
when the preview is masked.

A masked value is not an uncertain one. Of a commit result a model reads
`committed` and the issue key, and nothing of the title, the state or the
priority. Left to itself it reports that as "could not be checked" and asks
the user to look. The prompt partial and `playbook.when_to_use` therefore say
what `committed: true` means: Linear took the whole change, exactly as the
preview showed it, and the answer states that as fact.

## Layout

```
manifest.yaml            identity, depends_on + requires, the setup fields, playbook, skills
skills/linear-expert.md  system prompt: how results arrive, vocabulary, writes per mode, how to answer
src/plugin.ts            activate(ctx) -> { toolkit, close }; reads the write mode
src/toolkit.ts           the tools: schemas, validation, resolve and apply
src/caller.ts            which conversation and turn a call belongs to
src/lookup.ts            name -> id, with a 5-minute cache and no guessing
src/preview.ts           descriptor -> the sentence a person says yes to
src/preparedWrites.ts    the store of the confirm mode: one per conversation, take-once, expiry
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
- **One setup field for the write mode, not two switches.** "Changes on or off"
  and "confirmation on or off" exclude each other in one combination, and a
  form that lets an operator choose it has a setting that means nothing.
  The mode is read at activation; the host reactivates a plugin when its
  settings change.
- **No peer dependency on the connection.** The host's upload check compares
  `peerDependencies` with its own packages only, so a sibling plugin listed
  there is always reported as missing. The two plugins are tied together in
  the manifest (`depends_on`, `requires`), and the connection is imported for
  its types only.
- **`linear_prepare_write` and `linear_write` take an enum `kind` plus flat optional fields**
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
  not refusals and stay withheld, with two exceptions, both cases where Linear
  turned the request away before doing anything: a rate limit, reported with
  the reset time, because "wait" is something a person can act on; and a
  rejected API key, because only an operator can fix it and the model must
  not retry. Both are texts written here; nothing of Linear's response is
  passed on. On a host older
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

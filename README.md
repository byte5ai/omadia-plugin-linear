# `@omadia/agent-linear`

The **Linear tools**: a capability plugin (`kind: tool`) that gives an agent
the Linear tools. With them an agent can search and read Linear issues, and
create, change or comment on them, from any channel. By default every change is
shown as a preview first and applied only after the user confirms it; the
operator can switch the confirmation off, or switch changes off altogether.

The plugin has no persona and no model of its own. It ships the former Linear
agent as two **agent templates** (English and German), from which an operator
creates an agent in the Agent Builder. The id keeps its historical `agent-`
prefix, so this version replaces an installed 0.4.x under the same id.

It holds no credential. Linear is reached through the **Linear API capability**
(`linear.api@2`) published by [`@omadia/integration-linear`](https://github.com/byte5ai/omadia-integration-linear),
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

You need a Linear workspace and a personal API key of one of its members
(Linear → Settings → Security & access → Personal API keys); Linear's Free
plan is enough. The key goes into the connection, not into this plugin.

1. Install and configure `@omadia/integration-linear` first, and check it
   with **Verbindung testen** (see its README). Without it this plugin's
   `requires:` is unresolved and it will not activate.
2. `npm run build` here, then in the web UI: **Store** (`/store`) → source
   switch **Lokal** → box "Neues Agent-Package hochladen." → **Datei wählen**
   → `out/omadia-agent-linear-<version>.zip`. Expect "✓ Hochgeladen" and a
   card **Linear** among the capabilities. (Or
   `POST /api/v1/install/plugins/:id` followed by `/configure`.)
3. Install the card and enter the **Standard-Teamkürzel** (default team
   key) — the prefix of that team's issue keys, so `OMA` for `OMA-7`. It is
   the team used whenever a request does not name one.
4. Choose how **changes to Linear** are made (field **Änderungen in Linear**,
   `linear_write_mode`):

   | Value | What the agent does |
   |---|---|
   | `confirm` — "Mit Bestätigung (empfohlen)", the default | Shows every change as a preview and applies it only after the user says yes in the conversation. |
   | `direct` — "Ohne Bestätigung" | Applies a change as soon as it is asked for. No preview, no undo. |
   | `off` — "Aus (nur lesen)" | Reads only. The write tools are not offered to the model at all. |

   A Linear API key restricted to reading passes the connection check all the
   same, because that check only reads. With such a key choose `off`:
   otherwise the agent offers changes that all fail at Linear.
5. **Installation bestätigen.** Both settings can be changed later on the
   plugin's page, section **Setup-Felder editieren**; saving reactivates the
   plugin with the new values.
6. Give the tools to an agent. Installing grants them to nobody. Either:
   - create one from a template: **Agent-Builder** (`/admin/builder`) →
     **Neuer Agent** → **Ausgangspunkt** "Linear Assistant — Linear" or
     "Linear-Assistent — Linear". The template fills in name, description and
     instructions and suggests the capability `@omadia/agent-linear`: tick
     it, choose who may reach the agent, and **Agent anlegen**; or
   - grant `@omadia/agent-linear` to an existing agent. Such an agent gets the
     tools and their descriptions, which carry the write rule, but not the
     template's working rules for searching and answering.

**Updating:** upload a newer zip the same way. It replaces the installed
version, keeps the settings and reactivates the plugin; there is no install
step. When a release raises the capability it needs (`linear.api@^1` →
`@^2`), upload the connection first. Uploaded the other way round, the host
has been seen to activate the agent anyway, against the old connection.

**Updating from 0.4.x** (the retired agent plugin): omadia refuses to upload
or install a plugin of kind `agent` since 0.224 (plugin-api 1.83), and no
longer runs an installed one since 0.226 (plugin-api 1.86); the Store then
shows it as "Aktivierung fehlgeschlagen" with the retired kind `agent`. Upload 0.5.x as
above: settings and the agents it was attached to carry over, and those agents
now call the Linear tools themselves instead of a `query_linear` sub-agent. On
omadia 0.227 the upload does not start the new version by itself; it starts
after the next restart of the middleware. Agents that should work by the
template's rules are created from it as in step 6.

## Using it

Ask an agent that has the tools, in any channel it is bound to, in German or
English. Name the team when it is not the default one. For example:

- *Welche Aufgaben sind im Team OMA offen?*
- *Was haben wir in den letzten zwei Wochen erledigt?*
- *Was steht in OMA-7?*
- *Zeig mir alle dringenden Aufgaben mit dem Label Bug.*
- *Welcher Zyklus läuft gerade, und was ist darin?*
- *Lege in OMA eine Aufgabe an: Titel "Login prüfen", Priorität hoch.*
- *Verschiebe OMA-7 nach Done.* / *Kommentiere OMA-7 mit "erledigt".*

With confirmation on, a change comes back as a preview with the time until
which it can be confirmed, and nothing is written yet. A plain "Ja" in the
same conversation applies it; the answer names the issue key. A different
wording ("nein, schreib stattdessen …") replaces the preview. A preview is
valid for ten minutes; a yes after that is told the preview expired, and the
agent prepares it again for a new yes. Several changes asked for at once are
confirmed one after the other. The yes has to reach the same agent in the same
conversation: a preview is bound to both.

Everything written appears in Linear under the owner of the API key, not
under the person who asked.

## Known limits

- **One identity.** Every read and every change acts as the owner of the API
  key. Who asked in omadia is not visible in Linear, and everyone who can
  reach an agent with these tools can read what that key can read. Per-user
  identity would need OAuth, which is not built.
- **No Push.** Linear does not notify omadia; the agent answers only when
  asked.
- **Speed.** The agent's model calls the tools itself, one model round per
  tool call, so an answer takes some seconds. Linear itself answers in well
  under a second.
- **Rate limits.** A personal key is capped by Linear (near 2,500 requests an
  hour). Past the cap the agent says so and names the time the limit resets.
- **Privacy Shield.** In the default privacy mode the models read a digest of
  each result (numbers, dates, keys) and the user sees the real values in
  the table the host renders. Answers therefore often point at the table
  instead of repeating titles or names.
- **Not editable:** project, cycle, estimate, parent, due date. No delete and
  no archive; closing an issue is a move to a completed or canceled state.
- **"No" does not discard a preview.** It stays confirmable until it expires
  or is replaced — see the write gate below.
- **No confirmation outside a conversation.** A scheduled routine or a call
  from another plugin cannot confirm a change; there only reading and the
  `direct` mode work.

## Troubleshooting

| Symptom | Cause | What to do |
|---|---|---|
| Red badge and banner on the Linear connection; the chat answer says Linear rejected the API key. | The key was revoked, mistyped or belongs to another workspace. Log: `connection check: Linear rejected the API key (http_401)`, at call time `Linear rejected the API key during a request (http_401) — status set to error`. | Paste a valid key on the connection's page, section **Setup-Felder editieren**, then **Verbindung testen**. |
| The plugin does not activate, or the install reports a missing capability. | The connection is not installed, or is older than the capability this plugin requires. | Install or update the connection, then this plugin. |
| "Aktivierung fehlgeschlagen", retired kind `agent`. | An installed 0.4.x on omadia 0.226 or newer. | Upload 0.5.x; restart the middleware if the page still shows the old status. |
| An agent never uses Linear. | The plugin is installed but granted to no agent. | Create an agent from the Linear template, or grant `@omadia/agent-linear` to the agent (step 6). |
| Reading works, every change fails at Linear. | The API key is restricted to reading. | Set **Änderungen in Linear** to "Aus (nur lesen)", or use a key with write access. |
| "The prepared change expired …" after a yes. | More than ten minutes passed since the preview. | Ask for the change again and confirm the new preview. |
| "No change is waiting for confirmation …" after a yes. | The change was already written, a newer preview replaced it, or it expired more than a day ago. | Check Linear; ask for the change again if it is missing. |
| "Linear is rate-limiting this API key …" | The key's request budget is spent. | Wait until the reset time named in the answer. |
| "No projects", "no current cycle", nothing in triage. | The team does not use projects or cycles, or triage is off (Linear → team settings). | Nothing to fix in omadia. |
| "No team with key …", listing other keys. | **Standard-Teamkürzel** is wrong, or the request named an unknown team. | Correct the setting on the plugin's page. |
| Changes are refused with "This call belongs to no conversation …". | The call came from a routine or another plugin, where nobody can confirm. | Ask in a chat, or use the `direct` mode for automated changes. |
| An answer mentions a preview from another chat. | The host adds matching turns from the same user's other chats to the context. A preview stays bound to the conversation that made it and cannot be confirmed elsewhere. | Nothing to fix; confirm in the chat that showed the preview. |

## The tools

| Tool | Write mode | What it does |
|---|---|---|
| `linear_search_issues` | all | Issues by team, stage of work (triage included), assignee, creator, label, priority, project, cycle, time of creation, last update or completion, or free text. Returns one compact summary per issue, one page at a time, and says whether more match. |
| `linear_get_issue` | all | One issue by key, with its description and most recent comments. |
| `linear_lookup` | all | Teams, workflow states, workspace members, labels, projects or cycles — the records a search or a write refers to by name. Marks the current cycle. |
| `linear_prepare_write` | `confirm` | Validates and stages a change, returns a preview and its expiry. **Writes nothing.** |
| `linear_commit_write` | `confirm` | Applies the change staged in the calling conversation. **Writes.** |
| `linear_write` | `direct` | Validates a change and applies it at once. **Writes.** |

The manifest declares each tool's effect (`capabilities[].side_effects`): the
three readers and `linear_prepare_write` are `read`, the two that change
Linear are `write`. The kernel checks a `write` against the turn's discretion
labels before it runs.

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
2. The agent shows the user the preview, says that nothing is written yet,
   asks, and ends its turn.
3. The user confirms in a later message. The agent calls
   `linear_commit_write`, which takes no input: it applies the change staged
   for the calling conversation, removing it from the store first.

### Who is calling

A tool gets its input and nothing else as an argument. What connects step 3
to step 1 is the host's **turn context**, a service
published as the capability `turnContext@1` (`optional_requires:` in the
manifest, read in `src/caller.ts`). For the call in flight it names the agent,
the user, the session and the turn. The first three together are the
conversation a prepared write is staged under; the turn is what tells a commit
made after the user answered from one made before.

That is why no handle travels with the conversation. A token the model had to
carry from the preview to the commit would pass a privacy filter that masks
strings in tool results, and a turn boundary that keeps only the answer text;
either could lose it.

Properties this buys, and where they are enforced (`src/preparedWrites.ts`):

- **A staged write is inert.** The store holds descriptors, not requests. A
  test asserts that a full round of prepare calls reaches none of
  `createIssue`, `updateIssue` or `addComment`.
- **It belongs to its conversation.** A commit from another conversation,
  another user or another agent finds nothing.
- **Not in the turn that prepared.** `take()` refuses a commit whose turn is
  the one that staged the write, and leaves the write where it is. The tool
  description says the same, but this half does not depend on the model
  following it.
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
agent answers without calling a tool, so the change stays staged. It ends in one of three ways: it expires after ten minutes, a
newer prepare in the same conversation replaces it, or it is committed. Until
then a later yes in the same conversation could still apply it — the preview
the user declined.

What the gate does **not** decide is whether the user said yes. That is the
agent's reading of the user's message. Every agent the tools are granted to
reads the rule in the descriptions of `linear_prepare_write` and
`linear_commit_write`; an agent made from a template also has it, with the
rest of the working rules, in its instructions (`agent_templates:` in the
manifest).

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
gets it. And how a model answers from a digest is the kernel's to tell it;
the templates only say what the Linear results mean.

A masked value is not an uncertain one. Of a commit result a model reads
`committed` and the issue key, and nothing of the title, the state or the
priority. Left to itself it reports that as "could not be checked" and asks
the user to look. The templates therefore say what `committed: true` means:
Linear took the whole change, and the answer states that as fact.

## Layout

```
manifest.yaml            identity, depends_on + requires, setup fields, tool effects, playbook, agent templates
src/plugin.ts            activate(ctx) -> { close }; reads the write mode, registers the tools
src/registerTools.ts     tool -> NativeToolSpec (JSON schema via z.toJSONSchema) + handler
src/toolkit.ts           the tools: schemas, input check, resolve and apply
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
in the bundle; the host ships zod 4, whose `z.toJSONSchema` builds the tools'
input schemas.

## Notes on decisions that are not obvious from the code

- **The `capabilities:` block declares effects only.** Each entry is a tool id
  and its `side_effects`; the tools themselves, with their input schemas, come
  from the toolkit at activation. Declaring the schemas a second time in the
  manifest would be a copy with nothing to keep it honest. A test holds the
  list to the toolkit's ids in every write mode.
- **`compat.core: ">=1.78.0 <2.0"`** (omadia 0.219 and later). The first
  kernel that knows the capability kinds, `agent_templates:` and
  `side_effects`.
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
  rather than the discriminated union its three shapes are asking for. A
  union becomes an `anyOf` in the JSON schema, which models fill in less
  reliably than one flat object, so the per-kind field rules are enforced in
  `validateWriteInput` instead — and a field that does not belong to the given
  kind is an error rather than being quietly dropped.
- **Every tool input is `.strict()`, and checked by the tool.** Zod's default
  is to strip an undeclared key, so `state` instead of `stateName` would be
  dropped and the preview would faithfully describe a write that omits the
  change the user asked for. The kernel does not validate a plugin tool's
  input, and it withholds the message of a thrown `ZodError`, so each tool
  checks its input itself and answers a mismatch with a refusal that names
  the field (`Invalid input — <root>: Unrecognized key: "state"`).
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

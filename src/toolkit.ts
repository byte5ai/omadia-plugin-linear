import type {
  CreateIssueInput,
  LinearClient,
  LinearIssue,
  LinearIssueDetail,
  LinearLabel,
  LinearTeam,
  LinearUser,
  LinearWorkflowState,
  UpdateIssueInput,
} from '@omadia/integration-linear';
import { z } from 'zod';

import { LinearAgentError, quoted, rateLimitRefusal } from './errors.js';
import { createLinearLookups, type LinearLookups } from './lookup.js';
import {
  createPreparedWriteStore,
  PREPARED_WRITE_TTL_MS,
  type PreparedAddComment,
  type PreparedCreateIssue,
  type PreparedFieldChange,
  type PreparedUpdateIssue,
  type PreparedWrite,
  type PreparedWriteStore,
} from './preparedWrites.js';
import {
  excerpt,
  MAX_PRIORITY,
  MIN_PRIORITY,
  priorityLabel,
  renderPreview,
} from './preview.js';

/**
 * The five Linear tools.
 *
 * Shape and constraints come from the host, not from taste:
 *
 *   - A tool is `{ id, description, input: ZodSchema, run }`. The kernel bridges
 *     it into a sub-agent tool, derives the orchestrator-facing tool name from
 *     the plugin id (`@omadia/agent-linear` becomes `query_linear`) and composes
 *     the system prompt from `skills/` plus the manifest. This file returns no
 *     prompt and builds no LLM client.
 *   - The Zod to JSON-schema bridge understands Object, String, Number, Boolean,
 *     Enum, Array, Optional, Nullable, Default, Literal and Effects. Union,
 *     DiscriminatedUnion, Record and Tuple silently degrade to `{}` and the
 *     model then gets no schema at all. That is why `linear_prepare_write` takes
 *     an Enum `kind` plus flat optional fields instead of the discriminated
 *     union the three write shapes are begging for; the per-kind field rules are
 *     enforced in code (see `validateWriteInput`) rather than in the type.
 *
 * The write path is deliberately two tools. `linear_prepare_write` resolves,
 * validates, previews and stages; it never calls `createIssue`, `updateIssue`
 * or `addComment`. `linear_commit_write` does nothing else. A model cannot
 * change Linear without having produced a preview first, which is the only
 * point in the flow where a person can still say no.
 */

/** Matches the kernel's uploaded-toolkit tool contract. Declared locally so the
 *  package compiles standalone: the zip-upload flow forbids reaching outside
 *  its own tree, and `@omadia/plugin-api` does not export this shape. */
export interface ToolDescriptor<I, O> {
  readonly id: string;
  readonly description: string;
  readonly input: z.ZodType<I>;
  run(input: I): Promise<O>;
}

export interface Toolkit {
  readonly tools: readonly ToolDescriptor<unknown, unknown>[];
  close(): Promise<void>;
}

export interface ToolkitOptions {
  readonly client: LinearClient;
  /** The `default_team_key` setup field. */
  readonly defaultTeamKey: string;
  readonly log: (...args: unknown[]) => void;
  /** Injectable for tests; defaults to a fresh in-memory store. */
  readonly store?: PreparedWriteStore;
  /** Injectable for tests; defaults to a lookup set over `client`. */
  readonly lookups?: LinearLookups;
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------
//
// Every input is `.strict()`. Zod's default is to STRIP an undeclared key, so
// a model that writes `state` instead of `stateName`, or `assigne` instead of
// `assignee`, would have the field silently dropped: the write would be staged
// without the change, and the preview would describe the write that was staged
// rather than the one that was asked for. Strict turns that into an
// `Unrecognized key` the model can see and correct. The kernel's schema bridge
// ignores the strictness flag, so nothing about the published tool definition
// changes.

/** The five state types a person asks about. Linear also has `triage`, which
 *  is a per-team optional inbox rather than a stage of work: outside the
 *  editable set and outside this filter. */
const STATE_TYPES = ['backlog', 'unstarted', 'started', 'completed', 'canceled'] as const;

const WRITE_KINDS = ['create_issue', 'update_issue', 'add_comment'] as const;

const teamKeyField = z
  .string()
  .trim()
  .min(1)
  .max(16)
  .describe("Team key such as 'OMA'. Defaults to the team configured for this plugin.");

const issueKeyField = z
  .string()
  .trim()
  .min(2)
  .max(40)
  .describe("Issue key as people write it, e.g. 'OMA-7'.");

const assigneeField = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe("'me' for the API key's owner, or a person's name as it appears in Linear.");

const searchInput = z.object({
  teamKey: teamKeyField.optional(),
  stateType: z
    .enum(STATE_TYPES)
    .optional()
    .describe(
      'Stage of work to filter by. completed and canceled are the two "closed" kinds.',
    ),
  assignee: assigneeField.optional(),
  text: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .optional()
    .describe('Full-text search over title and description. Omit to list by filter alone.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('Maximum number of issues to return. Defaults to 25.'),
}).strict();

const getIssueInput = z.object({ key: issueKeyField }).strict();

const lookupInput = z.object({
  kind: z
    .enum(['teams', 'states', 'users', 'labels'])
    .describe('Which set of Linear records to list.'),
  teamKey: teamKeyField.optional(),
  query: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe('Narrow the list to records whose name contains this text.'),
}).strict();

const prepareWriteInput = z.object({
  kind: z
    .enum(WRITE_KINDS)
    .describe(
      'create_issue needs title (plus optional teamKey, description, stateName, assignee, priority, labels). ' +
        'update_issue needs issueKey plus at least one field to change. ' +
        'add_comment needs issueKey and body.',
    ),
  issueKey: issueKeyField.optional(),
  teamKey: teamKeyField.optional(),
  title: z.string().trim().min(1).max(255).optional().describe('Issue title.'),
  description: z
    .string()
    .max(100_000)
    .optional()
    .describe('Issue description in Markdown. Replaces the existing one on update_issue.'),
  stateName: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "Workflow-state name, e.g. 'Done'. Closing an issue is a move to a completed or canceled state.",
    ),
  // Not `assigneeField.optional().describe(...)`: the host's bridge unwraps an
  // Optional to its inner schema and only falls back to the outer description
  // when the inner has none. `assigneeField` already carries one, so a
  // re-describe after `.optional()` would be silently dropped and this field
  // would advertise the search wording instead of the write wording. Spelled
  // out with `.describe()` on the string itself. (Fields below that describe
  // before `.optional()` are fine — that is the inner schema.)
  assignee: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe(
      "'me' for the API key's owner, a person's name, or 'none' to clear the assignee on update_issue.",
    )
    .optional(),
  priority: z
    .number()
    .int()
    .min(MIN_PRIORITY)
    .max(MAX_PRIORITY)
    .optional()
    .describe('0 no priority, 1 urgent, 2 high, 3 medium, 4 low.'),
  labels: z
    .array(z.string().trim().min(1).max(100))
    .max(20)
    .optional()
    .describe(
      'Label names. Replaces the whole label set on update_issue, it does not add to it.',
    ),
  body: z.string().trim().min(1).max(100_000).optional().describe('Comment text in Markdown.'),
}).strict();

const commitWriteInput = z.object({
  token: z
    .string()
    .trim()
    .min(8)
    .max(200)
    .describe('The token returned by linear_prepare_write.'),
}).strict();

type PrepareWriteInput = z.infer<typeof prepareWriteInput>;

/** `assignee` values that mean "nobody". Only valid on update_issue: an issue
 *  created without an assignee is unassigned by omission. */
const CLEAR_ASSIGNEE = new Set(['none', 'nobody', 'unassigned']);

// ---------------------------------------------------------------------------
// Output shapes: summaries, never raw API payloads
// ---------------------------------------------------------------------------

/** Longest description `linear_get_issue` will return. A single issue must not
 *  be able to fill the sub-agent's context on its own. */
const MAX_DESCRIPTION_CHARS = 4_000;
const MAX_COMMENT_CHARS = 1_000;
const MAX_COMMENTS_RETURNED = 20;

/** Longest current value the "nothing to change" refusal quotes per field. Six
 *  fields can be named at once and the refusal has to stay under the length
 *  the host passes on (see errors.ts). */
const MAX_NOOP_VALUE_CHARS = 50;

function summariseIssue(issue: LinearIssue): Record<string, unknown> {
  return {
    key: issue.identifier,
    title: issue.title,
    state: issue.state.name,
    stateType: issue.state.type,
    assignee: issue.assignee?.displayName ?? null,
    priority: priorityLabel(issue.priority),
    labels: issue.labels,
    updatedAt: issue.updatedAt,
    url: issue.url,
  };
}

function detailIssue(issue: LinearIssueDetail): Record<string, unknown> {
  // Sorted here rather than trusted: the client's comment query sets no
  // `orderBy`, so the order it returns is whatever Linear's connection default
  // happens to be. Slicing without sorting would have handed back the oldest
  // comments under the label "most recent". Oldest-first within the newest
  // slice, because a thread reads forwards.
  const comments = [...issue.comments]
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(-MAX_COMMENTS_RETURNED)
    .map((c) => ({
      author: c.author ?? 'Omadia',
      createdAt: c.createdAt,
      body: excerpt(c.body, MAX_COMMENT_CHARS),
    }));
  return {
    ...summariseIssue(issue),
    team: issue.team.key,
    createdAt: issue.createdAt,
    description:
      issue.description === undefined ? null : excerpt(issue.description, MAX_DESCRIPTION_CHARS),
    commentCount: issue.comments.length,
    comments,
  };
}

// ---------------------------------------------------------------------------
// Toolkit
// ---------------------------------------------------------------------------

export function createToolkit(opts: ToolkitOptions): Toolkit {
  const { client, log } = opts;
  const store = opts.store ?? createPreparedWriteStore();
  const lookups =
    opts.lookups ?? createLinearLookups({ client, defaultTeamKey: opts.defaultTeamKey });

  const searchIssues: ToolDescriptor<unknown, unknown> = {
    id: 'linear_search_issues',
    description:
      'Find Linear issues by team, stage of work, assignee or free text. Returns a compact summary per issue ' +
      '(key, title, state, assignee, priority, labels, link). Cite the issue keys in your answer. Read-only.',
    input: searchInput as z.ZodType<unknown>,
    async run(raw) {
      const input = searchInput.parse(raw);
      const team = await lookups.team(input.teamKey);
      const assignee =
        input.assignee === undefined ? undefined : await lookups.user(input.assignee);
      log('linear_search_issues', {
        teamKey: team.key,
        stateType: input.stateType,
        assignee: assignee?.displayName,
        hasText: input.text !== undefined,
      });
      const issues = await client.searchIssues({
        teamKey: team.key,
        ...(input.stateType === undefined ? {} : { stateType: input.stateType }),
        ...(assignee === undefined ? {} : { assigneeId: assignee.id }),
        ...(input.text === undefined ? {} : { text: input.text }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
      return {
        teamKey: team.key,
        ...(assignee === undefined ? {} : { assignee: assignee.displayName }),
        count: issues.length,
        issues: issues.map(summariseIssue),
      };
    },
  };

  const getIssue: ToolDescriptor<unknown, unknown> = {
    id: 'linear_get_issue',
    description:
      'Read one Linear issue in full by its key (e.g. OMA-7): description plus the most recent comments. ' +
      'Summarise it for the user rather than pasting it back. Read-only.',
    input: getIssueInput as z.ZodType<unknown>,
    async run(raw) {
      const { key } = getIssueInput.parse(raw);
      log('linear_get_issue', { key });
      const issue = await client.getIssue(key);
      if (!issue) {
        throw new LinearAgentError(
          `No issue '${quoted(key)}'. Check the key, or search for the issue by title first.`,
        );
      }
      return detailIssue(issue);
    },
  };

  const lookup: ToolDescriptor<unknown, unknown> = {
    id: 'linear_lookup',
    description:
      'List the Linear records a write refers to by name: teams, workflow states, workspace members or labels. ' +
      'Use it when a name the user gave is ambiguous, or to see which states or labels a team has. Read-only.',
    input: lookupInput as z.ZodType<unknown>,
    async run(raw) {
      const input = lookupInput.parse(raw);
      log('linear_lookup', { kind: input.kind, teamKey: input.teamKey });
      switch (input.kind) {
        case 'teams': {
          const teams = filterByName(await lookups.teams(), input.query, (t) => [t.key, t.name]);
          return { kind: input.kind, count: teams.length, teams: teams.map(teamRow) };
        }
        case 'states': {
          const team = await lookups.team(input.teamKey);
          const states = filterByName(await lookups.states(team.id), input.query, (s) => [s.name]);
          return {
            kind: input.kind,
            teamKey: team.key,
            count: states.length,
            states: states.map(stateRow),
          };
        }
        case 'users': {
          const active = (await lookups.users()).filter((u) => u.active);
          const matched = filterByName(active, input.query, (u) => [
            u.name,
            u.displayName,
            u.email ?? '',
          ]);
          return {
            kind: input.kind,
            count: matched.length,
            users: matched.map(userRow),
            note: "Pass 'me' as an assignee to mean the API key's owner.",
          };
        }
        case 'labels': {
          const team = await lookups.team(input.teamKey);
          const labels = filterByName(await lookups.labels(team.id), input.query, (l) => [l.name]);
          return {
            kind: input.kind,
            teamKey: team.key,
            count: labels.length,
            labels: labels.map(labelRow),
          };
        }
      }
    },
  };

  const prepareWrite: ToolDescriptor<unknown, unknown> = {
    id: 'linear_prepare_write',
    description:
      'Stage a change to Linear WITHOUT applying it: create an issue, update an issue, or add a comment. ' +
      'Resolves every name you give to a Linear record, validates the change, and returns a token plus a ' +
      'human-readable preview. Nothing is written. Return the preview AND the token to your caller verbatim ' +
      'and ask for the user to confirm; commit only once a request comes back carrying that token together ' +
      'with the confirmation. The token is valid for 10 minutes and can be used once.',
    input: prepareWriteInput as z.ZodType<unknown>,
    async run(raw) {
      const input = prepareWriteInput.parse(raw);
      validateWriteInput(input);
      log('linear_prepare_write', { kind: input.kind, issueKey: input.issueKey });

      const write =
        input.kind === 'create_issue'
          ? await prepareCreateIssue(input, lookups)
          : input.kind === 'update_issue'
            ? await prepareUpdateIssue(input, client, lookups)
            : await prepareAddComment(input, client);

      const entry = store.stage(write, renderPreview(write));
      return {
        token: entry.token,
        preview: entry.preview,
        expiresAt: new Date(entry.expiresAt).toISOString(),
        nextStep:
          'NOTHING HAS BEEN WRITTEN YET. End your turn here: reply to your caller with the preview and ' +
          'this token, both verbatim, and ask for the user to confirm. Do NOT call linear_commit_write in ' +
          'this turn — you have not been told yes yet. Commit when a later request arrives carrying this ' +
          `token and the user's confirmation. The token expires in ${String(
            Math.round(PREPARED_WRITE_TTL_MS / 60000),
          )} minutes and works once.`,
      };
    },
  };

  const commitWrite: ToolDescriptor<unknown, unknown> = {
    id: 'linear_commit_write',
    description:
      'Apply a change previously staged by linear_prepare_write. Call this ONLY when the request you are ' +
      'answering carries the token AND says the user confirmed the preview: never to "check whether it ' +
      'works", never on your own initiative, and never in the same turn that produced the preview. Each ' +
      'token applies exactly one change and is discarded afterwards.',
    input: commitWriteInput as z.ZodType<unknown>,
    async run(raw) {
      const { token } = commitWriteInput.parse(raw);
      // Take before applying: the entry is gone whatever happens next, so a
      // retried or racing commit cannot apply the same change twice. The cost
      // is that a commit which fails upstream needs a fresh preview, which is
      // the safe direction of that trade.
      const entry = store.take(token);
      log('linear_commit_write', { kind: entry.write.kind });
      return applyWrite(entry.write, client);
    },
  };

  return {
    tools: [searchIssues, getIssue, lookup, prepareWrite, commitWrite].map(reportingRateLimits),
    async close() {
      // Deactivation drops every staged write. It is not a conversation
      // boundary — the kernel activates this plugin once per process, so one
      // store serves every orchestrator — but it is the one boundary available,
      // and a descriptor surviving an uninstall would be worse than useless.
      store.clear();
      lookups.invalidate();
    },
  };
}

// ---------------------------------------------------------------------------
// rate limits: the one connection failure the model is told about
// ---------------------------------------------------------------------------

/** What a rate limit means for the call it interrupted. A commit is the case
 *  that must not be left to inference: the token is gone (see `take()`), and a
 *  model that only hears "try again later" would retry a token that no longer
 *  exists. */
const RATE_LIMIT_CONSEQUENCE: Readonly<Record<string, string>> = {
  linear_prepare_write: 'Nothing was staged. Tell the user, and prepare the change again later.',
  linear_commit_write:
    'Nothing was written, and the token is used up. Tell the user, then prepare the change again ' +
    'later and ask for a new confirmation.',
};
const RATE_LIMIT_READ_CONSEQUENCE = 'Nothing was read. Tell the user, and try again later.';

/**
 * Turn a rate limit from the connection into a refusal the model can read.
 *
 * Every other error from the connection passes through untouched and stays
 * withheld by the host: its message is Linear's, not ours, and after a failed
 * mutation the outcome really is unknown.
 */
function reportingRateLimits(
  tool: ToolDescriptor<unknown, unknown>,
): ToolDescriptor<unknown, unknown> {
  const consequence = RATE_LIMIT_CONSEQUENCE[tool.id] ?? RATE_LIMIT_READ_CONSEQUENCE;
  return {
    ...tool,
    async run(input) {
      try {
        return await tool.run(input);
      } catch (err) {
        throw rateLimitRefusal(err, consequence) ?? err;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// prepare: validation and resolution, no mutation
// ---------------------------------------------------------------------------

/** Fields that belong to each write kind. Anything else being set is a sign the
 *  model mixed two instructions, so it is refused rather than dropped: a
 *  silently ignored `stateName` on an add_comment would produce a preview the
 *  user confirms believing the state moves too. */
const ALLOWED_FIELDS: Readonly<Record<PrepareWriteInput['kind'], readonly string[]>> = {
  create_issue: ['teamKey', 'title', 'description', 'stateName', 'assignee', 'priority', 'labels'],
  update_issue: ['issueKey', 'title', 'description', 'stateName', 'assignee', 'priority', 'labels'],
  add_comment: ['issueKey', 'body'],
};

const UPDATABLE_FIELDS = [
  'title',
  'description',
  'stateName',
  'assignee',
  'priority',
  'labels',
] as const;

export function validateWriteInput(input: PrepareWriteInput): void {
  const allowed = new Set<string>(ALLOWED_FIELDS[input.kind]);
  const offending = Object.entries(input)
    .filter(([key, value]) => key !== 'kind' && value !== undefined && !allowed.has(key))
    .map(([key]) => key);
  if (offending.length > 0) {
    throw new LinearAgentError(
      `${input.kind} does not take ${offending.join(', ')}. Allowed fields: ${[...allowed].join(', ')}.`,
    );
  }

  switch (input.kind) {
    case 'create_issue':
      if (input.title === undefined) {
        throw new LinearAgentError('create_issue needs a title.');
      }
      if (input.assignee !== undefined && CLEAR_ASSIGNEE.has(input.assignee.toLowerCase())) {
        throw new LinearAgentError(
          `Omit assignee to create an unassigned issue. '${quoted(input.assignee)}' is only meaningful on update_issue.`,
        );
      }
      return;
    case 'update_issue': {
      if (input.issueKey === undefined) {
        throw new LinearAgentError("update_issue needs the issue's key, e.g. 'OMA-7'.");
      }
      const given = UPDATABLE_FIELDS.filter((f) => input[f] !== undefined);
      if (given.length === 0) {
        throw new LinearAgentError(
          `update_issue needs at least one field to change: ${UPDATABLE_FIELDS.join(', ')}.`,
        );
      }
      return;
    }
    case 'add_comment':
      if (input.issueKey === undefined || input.body === undefined) {
        throw new LinearAgentError('add_comment needs both issueKey and body.');
      }
      return;
  }
}

async function prepareCreateIssue(
  input: PrepareWriteInput,
  lookups: LinearLookups,
): Promise<PreparedCreateIssue> {
  const team = await lookups.team(input.teamKey);
  const state =
    input.stateName === undefined ? undefined : await lookups.state(team, input.stateName);
  const assignee = input.assignee === undefined ? undefined : await lookups.user(input.assignee);
  const labels =
    input.labels === undefined ? undefined : await lookups.labelSet(team, input.labels);

  // `title` is guaranteed by validateWriteInput; the local keeps that guarantee
  // visible to the compiler instead of leaking `string | undefined` into the
  // descriptor.
  const title = input.title as string;

  return {
    kind: 'create_issue',
    teamId: team.id,
    teamKey: team.key,
    title,
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(state === undefined ? {} : { stateId: state.id, stateName: state.name }),
    ...(assignee === undefined
      ? {}
      : { assigneeId: assignee.id, assigneeName: assignee.displayName }),
    ...(input.priority === undefined
      ? {}
      : { priority: input.priority, priorityLabel: priorityLabel(input.priority) }),
    ...(labels === undefined
      ? {}
      : { labelIds: labels.map((l) => l.id), labelNames: labels.map((l) => l.name) }),
  };
}

async function prepareUpdateIssue(
  input: PrepareWriteInput,
  client: LinearClient,
  lookups: LinearLookups,
): Promise<PreparedUpdateIssue> {
  const issueKey = input.issueKey as string;
  const issue = await requireIssue(client, issueKey);

  const patch: Record<string, unknown> = {};
  const changes: PreparedFieldChange[] = [];

  if (input.title !== undefined) {
    const changed = input.title !== issue.title;
    changes.push({ field: 'title', from: `"${issue.title}"`, to: `"${input.title}"`, changed });
    if (changed) patch['title'] = input.title;
  }

  if (input.description !== undefined) {
    const current = issue.description ?? '';
    const changed = input.description.trim() !== current.trim();
    changes.push({
      field: 'description',
      from: current.length === 0 ? 'empty' : `${String(current.length)} chars`,
      to: `${String(input.description.length)} chars`,
      changed,
    });
    if (changed) patch['description'] = input.description;
  }

  if (input.stateName !== undefined) {
    const state = await lookups.state(issue.team, input.stateName);
    const changed = state.id !== issue.state.id;
    changes.push({ field: 'state', from: issue.state.name, to: state.name, changed });
    if (changed) patch['stateId'] = state.id;
  }

  if (input.assignee !== undefined) {
    const clearing = CLEAR_ASSIGNEE.has(input.assignee.toLowerCase());
    const assignee = clearing ? undefined : await lookups.user(input.assignee);
    const currentId = issue.assignee?.id;
    const changed = clearing ? currentId !== undefined : assignee?.id !== currentId;
    changes.push({
      field: 'assignee',
      from: issue.assignee?.displayName ?? 'nobody',
      to: clearing ? 'nobody' : (assignee?.displayName ?? 'nobody'),
      changed,
    });
    // `null` is how the client clears an assignee; `undefined` would mean
    // "leave it alone" and the issue would stay assigned.
    if (changed) patch['assigneeId'] = clearing ? null : assignee?.id;
  }

  if (input.priority !== undefined) {
    const changed = input.priority !== issue.priority;
    changes.push({
      field: 'priority',
      from: priorityLabel(issue.priority),
      to: priorityLabel(input.priority),
      changed,
    });
    if (changed) patch['priority'] = input.priority;
  }

  if (input.labels !== undefined) {
    const labels = await lookups.labelSet(issue.team, input.labels);
    const changed = !sameLabelSet(
      labels.map((l) => l.name),
      issue.labels,
    );
    changes.push({
      field: 'labels',
      from: issue.labels.length > 0 ? [...issue.labels].join(', ') : 'none',
      to: labels.length > 0 ? labels.map((l) => l.name).join(', ') : 'none',
      changed,
    });
    // The client replaces the whole set rather than adding to it, so the full
    // resolved list has to go out even when only one label is new.
    if (changed) patch['labelIds'] = labels.map((l) => l.id);
  }

  if (Object.keys(patch).length === 0) {
    throw new LinearAgentError(
      `${issue.identifier} already matches every value you gave (${changes
        .map((c) => `${c.field}: ${quoted(c.from, MAX_NOOP_VALUE_CHARS)}`)
        .join(', ')}). There is nothing to change, so nothing was staged.`,
    );
  }

  return {
    kind: 'update_issue',
    issueId: issue.id,
    issueKey: issue.identifier,
    issueTitle: issue.title,
    patch: patch as UpdateIssueInput,
    changes,
  };
}

async function prepareAddComment(
  input: PrepareWriteInput,
  client: LinearClient,
): Promise<PreparedAddComment> {
  const issueKey = input.issueKey as string;
  const issue = await requireIssue(client, issueKey);
  return {
    kind: 'add_comment',
    issueId: issue.id,
    issueKey: issue.identifier,
    issueTitle: issue.title,
    body: input.body as string,
  };
}

/** `getIssue` answers `undefined` for a miss rather than throwing, and a
 *  prepared write against a non-existent issue must not reach the store. */
async function requireIssue(client: LinearClient, key: string): Promise<LinearIssueDetail> {
  const issue = await client.getIssue(key);
  if (!issue) {
    throw new LinearAgentError(
      `No issue '${quoted(key)}'. Nothing was staged. Check the key, or search for the issue first.`,
    );
  }
  return issue;
}

// ---------------------------------------------------------------------------
// commit: the only mutating code path
// ---------------------------------------------------------------------------

async function applyWrite(
  write: PreparedWrite,
  client: LinearClient,
): Promise<Record<string, unknown>> {
  switch (write.kind) {
    case 'create_issue': {
      const created = await client.createIssue(toCreateInput(write));
      return {
        committed: true,
        kind: write.kind,
        key: created.identifier,
        title: created.title,
        state: created.state.name,
        url: created.url,
      };
    }
    case 'update_issue': {
      const updated = await client.updateIssue(write.issueId, write.patch);
      return {
        committed: true,
        kind: write.kind,
        key: updated.identifier,
        title: updated.title,
        state: updated.state.name,
        assignee: updated.assignee?.displayName ?? null,
        priority: priorityLabel(updated.priority),
        labels: updated.labels,
        url: updated.url,
      };
    }
    case 'add_comment': {
      const comment = await client.addComment(write.issueId, write.body);
      return {
        committed: true,
        kind: write.kind,
        key: write.issueKey,
        commentId: comment.id,
        url: comment.url,
      };
    }
  }
}

function toCreateInput(write: PreparedCreateIssue): CreateIssueInput {
  return {
    teamId: write.teamId,
    title: write.title,
    ...(write.description === undefined ? {} : { description: write.description }),
    ...(write.stateId === undefined ? {} : { stateId: write.stateId }),
    ...(write.assigneeId === undefined ? {} : { assigneeId: write.assigneeId }),
    ...(write.priority === undefined ? {} : { priority: write.priority }),
    ...(write.labelIds === undefined ? {} : { labelIds: write.labelIds }),
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sameLabelSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const norm = (xs: readonly string[]): string =>
    [...xs]
      .map((x) => x.trim().toLowerCase())
      .sort()
      .join(' ');
  return norm(a) === norm(b);
}

/** Substring filter for the lookup tool. Unlike `matchByName` in lookup.ts it
 *  does not prefer an exact hit: a lookup is meant to show the neighbourhood of
 *  a name, not to pick one record out of it. */
function filterByName<T>(
  items: readonly T[],
  query: string | undefined,
  fields: (item: T) => readonly string[],
): readonly T[] {
  if (query === undefined) return items;
  const wanted = query.trim().toLowerCase();
  return items.filter((i) => fields(i).some((f) => f.toLowerCase().includes(wanted)));
}

function teamRow(team: LinearTeam): Record<string, unknown> {
  return { key: team.key, name: team.name, id: team.id };
}

function stateRow(state: LinearWorkflowState): Record<string, unknown> {
  return { name: state.name, type: state.type, position: state.position, id: state.id };
}

function userRow(user: LinearUser): Record<string, unknown> {
  return { displayName: user.displayName, name: user.name, email: user.email ?? null, id: user.id };
}

function labelRow(label: LinearLabel): Record<string, unknown> {
  return {
    name: label.name,
    scope: label.teamId === undefined ? 'workspace' : 'team',
    id: label.id,
  };
}

import type {
  CreateIssueInput,
  LinearClient,
  LinearCycle,
  LinearDateRange,
  LinearIssue,
  LinearIssueDetail,
  LinearLabel,
  LinearProject,
  LinearTeam,
  LinearUser,
  LinearWorkflowState,
  UpdateIssueInput,
} from '@omadia/integration-linear';
import { z } from 'zod';

import type { CallerReader } from './caller.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import { connectionRefusal, LinearAgentError, quoted, type TurnedAway } from './errors.js';
import { createLinearLookups, cycleLabel, type LinearLookups } from './lookup.js';
import {
  createPreparedWriteStore,
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
 * The Linear tools: three that read, and the write tools of the active
 * write mode.
 *
 * A tool is `{ id, description, input: ZodSchema, run }`. `registerTools.ts`
 * hands each one to the kernel with `ctx.tools.register`, and the kernel
 * offers it to every agent the operator granted this plugin to. That agent
 * talks to the user itself, so a description here is written for the agent
 * that answers the user. This file returns no prompt and builds no LLM client.
 *
 * `linear_prepare_write` takes an Enum `kind` plus flat optional fields instead
 * of the discriminated union the three write shapes are begging for: a union
 * becomes an `anyOf` in the tool's JSON schema, which models fill in less
 * reliably than one flat object. The per-kind field rules are enforced in code
 * (see `validateWriteInput`) rather than in the type.
 *
 * Every write is the same two steps, `resolveWrite` (validate, resolve every
 * name, no mutation) and `applyWrite` (the only code that mutates). The write
 * mode decides what stands between them:
 *
 *   - `confirm`: two tools. `linear_prepare_write` resolves, previews and
 *     stages; `linear_commit_write` applies what is staged for the calling
 *     conversation, in a later turn. A model cannot change Linear without a
 *     preview having been produced first, which is the only point in the flow
 *     where a person can still say no.
 *   - `direct`: one tool, `linear_write`, which resolves and applies.
 *   - `off`: no write tool at all. A tool the model is not offered is the one
 *     it cannot call by mistake.
 */

/** How a change reaches Linear. The operator's setting; see manifest.yaml. */
export type WriteMode = 'confirm' | 'direct' | 'off';

export function isWriteMode(value: unknown): value is WriteMode {
  return value === 'confirm' || value === 'direct' || value === 'off';
}

/** One tool as this package builds it; `registerTools.ts` turns it into the
 *  kernel's `NativeToolSpec` plus handler. */
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
  /** Which write tools exist. */
  readonly writeMode: WriteMode;
  /** Who is calling: the conversation and the turn of the call in flight.
   *  Only the `confirm` mode asks. */
  readonly caller: CallerReader;
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
// `Unrecognized key` the model can see and correct (`parseInput`).

/** Linear's state types. `triage` is the inbox of a team that reviews new
 *  issues before accepting them: an issue created without a state lands
 *  there, so "what is waiting in triage" is a search by this type. */
const STATE_TYPES = [
  'triage',
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled',
] as const;

const LOOKUP_KINDS = ['teams', 'states', 'users', 'labels', 'projects', 'cycles'] as const;

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

const personField = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe("'me' for the API key's owner, or a person's name as it appears in Linear.");

const priorityField = z
  .number()
  .int()
  .min(MIN_PRIORITY)
  .max(MAX_PRIORITY)
  .describe('0 no priority, 1 urgent, 2 high, 3 medium, 4 low.');

/**
 * One end of a time span, in the three spellings Linear takes: a date, a
 * timestamp, or a span counted back from the moment of the search. The last
 * one is what lets "last week" be asked without knowing today's date. A
 * timestamp has to name its zone: without one, which day it falls on would be
 * anybody's guess.
 */
const TIME_PATTERN =
  /^(?:\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?|-P(?:\d+[YMWD])+)$/;

const TIME_FORMATS =
  "YYYY-MM-DD (midnight UTC), a timestamp with its zone such as 2026-11-02T09:00:00Z, or a span back from now: '-P7D' is 7 days ago, '-P2W' 2 weeks, '-P1M' a month";

function timeField(meaning: string): z.ZodString {
  return z
    .string()
    .trim()
    .regex(TIME_PATTERN, `Use ${TIME_FORMATS}.`)
    .describe(`${meaning} ${TIME_FORMATS}.`);
}

const searchInput = z.object({
  teamKey: teamKeyField.optional(),
  stateType: z
    .enum(STATE_TYPES)
    .optional()
    .describe(
      'Stage of work to filter by. completed and canceled are the two "closed" kinds; triage is ' +
        'the inbox of new issues a team has not accepted yet.',
    ),
  assignee: personField.optional(),
  creator: personField.optional(),
  label: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe('Label name. Finds the issues that carry this label.'),
  priority: priorityField.optional(),
  project: z.string().trim().min(1).max(200).optional().describe('Project name.'),
  cycle: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe("A cycle of the team: 'current', 'next' or 'previous', a cycle number, or a cycle name."),
  createdAfter: timeField('Created at or after this moment.').optional(),
  createdBefore: timeField('Created before this moment.').optional(),
  updatedAfter: timeField('Last updated at or after this moment.').optional(),
  updatedBefore: timeField('Last updated before this moment.').optional(),
  completedAfter: timeField(
    'Completed at or after this moment. Matches completed issues only, not canceled ones.',
  ).optional(),
  completedBefore: timeField(
    'Completed before this moment. Matches completed issues only, not canceled ones.',
  ).optional(),
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
  cursor: z
    .string()
    .trim()
    .min(1)
    .max(2_000)
    .optional()
    .describe(
      'The cursor of an earlier result, to get the page after it. Repeat every other field of that call unchanged.',
    ),
}).strict();

const getIssueInput = z.object({ key: issueKeyField }).strict();

const lookupInput = z.object({
  kind: z
    .enum(LOOKUP_KINDS)
    .describe(
      'Which set of Linear records to list. states, labels and cycles are those of one team; ' +
        'teams, users and projects those of the workspace.',
    ),
  teamKey: teamKeyField.optional(),
  query: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe('Narrow the list to records whose name contains this text.'),
}).strict();

const writeInput = z.object({
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
  // Its own string rather than `personField`: on a write, 'none' clears the
  // assignee, which the search wording of `personField` does not say.
  assignee: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe(
      "'me' for the API key's owner, a person's name, or 'none' to clear the assignee on update_issue.",
    )
    .optional(),
  priority: priorityField.optional(),
  labels: z
    .array(z.string().trim().min(1).max(100))
    .max(20)
    .optional()
    .describe(
      'Label names. Replaces the whole label set on update_issue, it does not add to it.',
    ),
  body: z.string().trim().min(1).max(100_000).optional().describe('Comment text in Markdown.'),
}).strict();

/** Nothing to pass: the change to apply is the one waiting in the calling
 *  conversation, which the host tells the tool. Strict like the others, so a
 *  stray argument is an error the model sees rather than a value it believes
 *  was used. */
const commitWriteInput = z.object({}).strict();

type WriteInput = z.infer<typeof writeInput>;

/** `assignee` values that mean "nobody". Only valid on update_issue: an issue
 *  created without an assignee is unassigned by omission. */
const CLEAR_ASSIGNEE = new Set(['none', 'nobody', 'unassigned']);

// ---------------------------------------------------------------------------
// Output shapes: summaries, never raw API payloads
// ---------------------------------------------------------------------------

/** Longest description `linear_get_issue` will return. A single issue must not
 *  be able to fill the calling agent's context on its own. */
const MAX_DESCRIPTION_CHARS = 4_000;
const MAX_COMMENT_CHARS = 1_000;
const MAX_COMMENTS_RETURNED = 20;

/** Longest current value the "nothing to change" refusal quotes per field. Six
 *  fields can be named at once and the refusal has to stay under the length
 *  the host passes on (see errors.ts). */
const MAX_NOOP_VALUE_CHARS = 50;

/** Most records `linear_lookup` returns. A lookup reads its whole collection,
 *  and a workspace with thousands of members must not arrive in one result. */
const MAX_LOOKUP_ROWS = 250;

function summariseIssue(issue: LinearIssue): Record<string, unknown> {
  return {
    key: issue.identifier,
    title: issue.title,
    state: issue.state.name,
    stateType: issue.state.type,
    assignee: issue.assignee?.displayName ?? null,
    priority: priorityLabel(issue.priority),
    labels: issue.labels,
    project: issue.project?.name ?? null,
    cycle: issue.cycle === undefined ? null : cycleLabel(issue.cycle),
    updatedAt: issue.updatedAt,
    // `null` while open, and from a connection older than these fields.
    completedAt: issue.completedAt ?? null,
    canceledAt: issue.canceledAt ?? null,
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
      'Find Linear issues by team, stage of work, assignee, creator, label, priority, project, cycle, ' +
      'by when they were created, last updated or completed, or by free text. Every filter given has to ' +
      'match. Returns a compact summary per issue (key, title, state, assignee, priority, labels, project, ' +
      'cycle, link), one page at a time: hasMore says whether more issues match than were returned. To ' +
      'get them, call again with the same input plus the cursor of this result. Cite the issue keys in ' +
      'your answer. Read-only.',
    input: searchInput as z.ZodType<unknown>,
    async run(raw) {
      const input = parseInput(searchInput, raw);
      const team = await lookups.team(input.teamKey);
      const assignee = await given(input.assignee, (name) => lookups.user(name));
      const creator = await given(input.creator, (name) => lookups.user(name));
      const label = await given(input.label, (name) => lookups.label(team, name));
      const project = await given(input.project, (name) => lookups.project(name));
      const cycle = await given(input.cycle, (spec) => lookups.cycle(team, spec));
      const cursor = input.cursor === undefined ? undefined : requireCursor(input.cursor);
      log('linear_search_issues', {
        teamKey: team.key,
        stateType: input.stateType,
        assignee: assignee?.displayName,
        hasText: input.text !== undefined,
        page: cursor === undefined ? 'first' : 'next',
      });

      const page = await client.searchIssues({
        teamKey: team.key,
        stateType: input.stateType,
        assigneeId: assignee?.id,
        creatorId: creator?.id,
        labelId: label?.id,
        priority: input.priority,
        projectId: project?.id,
        cycleId: cycle?.id,
        createdAt: timeSpan(input.createdAfter, input.createdBefore),
        updatedAt: timeSpan(input.updatedAfter, input.updatedBefore),
        completedAt: timeSpan(input.completedAfter, input.completedBefore),
        text: input.text,
        limit: input.limit,
        cursor,
      });
      // The person a filter resolved to goes back with the result: "me" is
      // somebody the caller cannot know. A label, project or cycle shows in
      // the issues themselves.
      //
      // `count`, `hasMore` and `cursor` are named the way the host knows the
      // paging data of a result. Under any other name it would copy them into
      // every issue as a column of its own.
      return {
        teamKey: team.key,
        ...present({ assignee: assignee?.displayName, creator: creator?.displayName }),
        count: page.issues.length,
        hasMore: page.nextCursor !== undefined,
        cursor: page.nextCursor === undefined ? null : encodeCursor(page.nextCursor),
        issues: page.issues.map(summariseIssue),
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
      const { key } = parseInput(getIssueInput, raw);
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
      'List Linear records by name: teams, workflow states, workspace members, labels, projects or cycles. ' +
      'Use it when a name the user gave is ambiguous, to see which states or labels a team has, which ' +
      'projects exist, or which cycle is the current one. A list longer than 250 is cut: hasMore says so ' +
      'and total counts them all; narrow it with query. Read-only.',
    input: lookupInput as z.ZodType<unknown>,
    async run(raw) {
      const input = parseInput(lookupInput, raw);
      log('linear_lookup', { kind: input.kind, teamKey: input.teamKey });
      switch (input.kind) {
        case 'teams': {
          const teams = filterByName(await lookups.teams(), input.query, (t) => [t.key, t.name]);
          return listing(input.kind, teams, teamRow);
        }
        case 'states': {
          const team = await lookups.team(input.teamKey);
          const states = filterByName(await lookups.states(team.id), input.query, (s) => [s.name]);
          return listing(input.kind, states, stateRow, { teamKey: team.key });
        }
        case 'users': {
          const active = (await lookups.users()).filter((u) => u.active);
          const matched = filterByName(active, input.query, (u) => [
            u.name,
            u.displayName,
            u.email ?? '',
          ]);
          return {
            ...listing(input.kind, matched, userRow),
            note: "Pass 'me' as an assignee to mean the API key's owner.",
          };
        }
        case 'labels': {
          const team = await lookups.team(input.teamKey);
          const labels = filterByName(await lookups.labels(team.id), input.query, (l) => [l.name]);
          return listing(input.kind, labels, labelRow, { teamKey: team.key });
        }
        case 'projects': {
          const projects = filterByName(await lookups.projects(), input.query, (p) => [p.name]);
          return listing(input.kind, projects, projectRow);
        }
        case 'cycles': {
          const team = await lookups.team(input.teamKey);
          // Newest first: a team's old cycles outnumber the ones anybody asks
          // about, and a cut list has to keep the recent end.
          const cycles = filterByName([...(await lookups.cycles(team.id))].reverse(), input.query, (c) => [
            cycleLabel(c),
          ]);
          return listing(input.kind, cycles, cycleRow, { teamKey: team.key });
        }
      }
    },
  };

  const prepareWrite: ToolDescriptor<unknown, unknown> = {
    id: 'linear_prepare_write',
    description:
      'Prepare a change to Linear WITHOUT applying it: create an issue, update an issue, or add a comment. ' +
      'Resolves every name you give to a Linear record, validates the change, and returns a human-readable ' +
      'preview and the time until which it can be confirmed. Nothing is written. The change now waits in ' +
      'this conversation, one at a time, for 10 minutes. Show the user the preview, say that nothing is ' +
      'written yet, ask them to confirm and end your turn. Call linear_commit_write only after the user ' +
      'has said yes in a later message.',
    input: writeInput,
    async run(raw) {
      const input = parseInput(writeInput, raw);
      validateWriteInput(input);
      const caller = opts.caller();
      if (caller === undefined) throw noConversation();
      log('linear_prepare_write', { kind: input.kind, issueKey: input.issueKey });

      const write = await resolveWrite(input, client, lookups);
      const entry = store.stage(caller, write, renderPreview(write));
      // Data only. The host may show a result to the user as a table and hand
      // the model a digest in which every text is masked, so an instruction in
      // here would be read by the one reader it was not written for. What to
      // do next is said where the model does read it: in this tool's
      // description.
      return {
        preview: entry.preview,
        expiresAt: new Date(entry.expiresAt).toISOString(),
      };
    },
  };

  const commitWrite: ToolDescriptor<unknown, unknown> = {
    id: 'linear_commit_write',
    description:
      'Apply the change that linear_prepare_write left waiting in this conversation. Takes no input. Call ' +
      'this ONLY when the user has confirmed the preview in a message of their own: never to "check ' +
      'whether it works" and never on your own initiative. It refuses in the turn that prepared the ' +
      'change, because the user cannot have seen the preview yet. A prepared change applies exactly once.',
    input: commitWriteInput,
    async run(raw) {
      parseInput(commitWriteInput, raw);
      const caller = opts.caller();
      if (caller === undefined) throw noConversation();
      // Take before applying: the entry is gone whatever happens next, so a
      // retried or racing commit cannot apply the same change twice. The cost
      // is that a commit which fails upstream needs a fresh preview, which is
      // the safe direction of that trade.
      const entry = store.take(caller);
      log('linear_commit_write', { kind: entry.write.kind });
      return applyWrite(entry.write, client);
    },
  };

  const write: ToolDescriptor<unknown, unknown> = {
    id: 'linear_write',
    description:
      'Change Linear: create an issue, update an issue, or add a comment. Resolves every name you give to ' +
      'a Linear record, validates the change and applies it AT ONCE; there is no preview and no undo. Call ' +
      'it once per change, and only for a change the user asked for. When a name is ambiguous or a ' +
      'value is missing, ask the user instead of calling.',
    input: writeInput,
    async run(raw) {
      const input = parseInput(writeInput, raw);
      validateWriteInput(input);
      log('linear_write', { kind: input.kind, issueKey: input.issueKey });
      return applyWrite(await resolveWrite(input, client, lookups), client);
    },
  };

  const writeTools: Readonly<Record<WriteMode, readonly ToolDescriptor<unknown, unknown>[]>> = {
    confirm: [prepareWrite, commitWrite],
    direct: [write],
    off: [],
  };

  return {
    tools: [searchIssues, getIssue, lookup, ...writeTools[opts.writeMode]].map(reportingConnectionRefusals),
    async close() {
      // Deactivation drops every staged write: a descriptor surviving an
      // uninstall would be worse than useless.
      store.clear();
      lookups.invalidate();
    },
  };
}

/** The refusal of the confirmation mode for a call that belongs to no
 *  conversation: a scheduled routine, a tool called by another plugin, or a
 *  host that publishes no turn context. A change prepared there could never
 *  be confirmed, so it is not prepared. */
function noConversation(): LinearAgentError {
  return new LinearAgentError(
    'This call belongs to no conversation, so the user cannot be asked to confirm a change here. ' +
      'Nothing was written. Say that changes with confirmation are not available from here, and that the ' +
      "operator can set the Linear plugin's write mode to apply changes without one.",
  );
}

/** At most this many input issues are listed in a refusal; the rest are counted. */
const MAX_LISTED_INPUT_ISSUES = 5;

/**
 * The input of a call, or a refusal that lists what does not fit.
 *
 * Validating here rather than leaving it to a thrown `ZodError` matters for
 * what the model reads: the kernel withholds the message of any error that is
 * not a refusal, and tells the model the outcome is unknown. A misspelt field
 * would then cost the model its only hint and leave it unsure whether a write
 * happened. As a refusal it reads which field is wrong, and that nothing ran.
 */
function parseInput<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const { issues } = parsed.error;
  const listed = issues
    .slice(0, MAX_LISTED_INPUT_ISSUES)
    .map((issue) => `${issue.path.length > 0 ? issue.path.map(String).join('.') : '<root>'}: ${issue.message}`)
    .join('; ');
  const more =
    issues.length > MAX_LISTED_INPUT_ISSUES ? ` (+${String(issues.length - MAX_LISTED_INPUT_ISSUES)} more)` : '';
  throw new LinearAgentError(
    `Invalid input — ${listed}${more}. Nothing was read or written; correct the call and send it again.`,
  );
}

// ---------------------------------------------------------------------------
// connection failures the model is told about: rate limit, rejected key
// ---------------------------------------------------------------------------

/** What a call Linear turned away left behind, per write tool. A commit is
 *  the case that must not be left to inference: the prepared change is gone
 *  (see `take()`). */
const TURNED_AWAY: Readonly<Record<string, TurnedAway>> = {
  linear_prepare_write: {
    outcome: 'Nothing was prepared.',
    later: 'Tell the user, and prepare the change again later.',
  },
  linear_commit_write: {
    outcome: 'Nothing was written, and the prepared change is used up.',
    later: 'Tell the user, then prepare the change again later and ask for a new confirmation.',
  },
  linear_write: {
    outcome: 'Nothing was written.',
    later: 'Tell the user, and try the change again later.',
  },
};
const READ_TURNED_AWAY: TurnedAway = {
  outcome: 'Nothing was read.',
  later: 'Tell the user, and try again later.',
};

/**
 * Turn a rate limit or a rejected key from the connection into a refusal the
 * model can read.
 *
 * Every other error from the connection passes through untouched and stays
 * withheld by the host: its message is Linear's, not ours, and after a failed
 * mutation the outcome really is unknown.
 */
function reportingConnectionRefusals(
  tool: ToolDescriptor<unknown, unknown>,
): ToolDescriptor<unknown, unknown> {
  const turnedAway = TURNED_AWAY[tool.id] ?? READ_TURNED_AWAY;
  return {
    ...tool,
    async run(input) {
      try {
        return await tool.run(input);
      } catch (err) {
        throw connectionRefusal(err, turnedAway) ?? err;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// resolve: validation and resolution, no mutation
// ---------------------------------------------------------------------------

/** Fields that belong to each write kind. Anything else being set is a sign the
 *  model mixed two instructions, so it is refused rather than dropped: a
 *  silently ignored `stateName` on an add_comment would produce a preview the
 *  user confirms believing the state moves too. */
const ALLOWED_FIELDS: Readonly<Record<WriteInput['kind'], readonly string[]>> = {
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

export function validateWriteInput(input: WriteInput): void {
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

/** An instruction turned into a descriptor: every name resolved to a Linear
 *  record, every field checked against the issue as it is now. Reads only. */
async function resolveWrite(
  input: WriteInput,
  client: LinearClient,
  lookups: LinearLookups,
): Promise<PreparedWrite> {
  switch (input.kind) {
    case 'create_issue':
      return resolveCreateIssue(input, lookups);
    case 'update_issue':
      return resolveUpdateIssue(input, client, lookups);
    case 'add_comment':
      return resolveAddComment(input, client);
  }
}

async function resolveCreateIssue(
  input: WriteInput,
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

async function resolveUpdateIssue(
  input: WriteInput,
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
        .join(', ')}). There is nothing to change, so nothing was written.`,
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

async function resolveAddComment(
  input: WriteInput,
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
 *  write against a non-existent issue must end here. */
async function requireIssue(client: LinearClient, key: string): Promise<LinearIssueDetail> {
  const issue = await client.getIssue(key);
  if (!issue) {
    throw new LinearAgentError(
      `No issue '${quoted(key)}'. Nothing was written. Check the key, or search for the issue first.`,
    );
  }
  return issue;
}

// ---------------------------------------------------------------------------
// apply: the only mutating code path
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

/** `resolve(value)`, or `undefined` for a value the caller left out. */
async function given<T, R>(
  value: T | undefined,
  resolve: (value: T) => Promise<R>,
): Promise<R | undefined> {
  return value === undefined ? undefined : resolve(value);
}

/** The entries that carry a value. */
function present(entries: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined));
}

/** The two ends of a time filter as the client takes them, or `undefined`
 *  when neither was given. */
function timeSpan(from: string | undefined, before: string | undefined): LinearDateRange | undefined {
  return from === undefined && before === undefined ? undefined : { from, before };
}

/** The Linear cursor behind a `cursor` the model passed back. */
function requireCursor(handle: string): string {
  const cursor = decodeCursor(handle);
  if (cursor === undefined) {
    throw new LinearAgentError(
      `'${quoted(handle)}' is not a cursor this tool returned. Pass the cursor exactly as an earlier ` +
        'result gave it, or leave it out to start at the first page.',
    );
  }
  return cursor;
}

/**
 * What `linear_lookup` returns for one kind: the rows under the kind's own
 * name, at most {@link MAX_LOOKUP_ROWS} of them, and whether that is all.
 */
function listing<T>(
  kind: (typeof LOOKUP_KINDS)[number],
  items: readonly T[],
  row: (item: T) => Record<string, unknown>,
  scope: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const shown = items.slice(0, MAX_LOOKUP_ROWS);
  return {
    kind,
    ...scope,
    count: shown.length,
    total: items.length,
    hasMore: items.length > shown.length,
    [kind]: shown.map(row),
  };
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

function projectRow(project: LinearProject): Record<string, unknown> {
  return {
    name: project.name,
    status: project.status.name,
    statusType: project.status.type,
    startDate: project.startDate ?? null,
    targetDate: project.targetDate ?? null,
    url: project.url,
    id: project.id,
  };
}

function cycleRow(cycle: LinearCycle): Record<string, unknown> {
  return {
    number: cycle.number,
    name: cycle.name ?? null,
    // The phase in a word for the reader of a table, and the one that is
    // asked for most as a flag as well: a flag stays readable where the host
    // masks every word.
    phase: cycle.phase,
    current: cycle.phase === 'current',
    startsAt: cycle.startsAt,
    endsAt: cycle.endsAt,
    id: cycle.id,
  };
}

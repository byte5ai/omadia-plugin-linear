import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { LinearAgentError } from '../src/errors.js';
import { createPreparedWriteStore } from '../src/preparedWrites.js';
import { createToolkit, type Toolkit } from '../src/toolkit.js';
import {
  createLog,
  createMockLinear,
  LABEL_MOBILE,
  makeComment,
  makeIssue,
  STATE_DONE,
  STATE_DONE_DEPLOY,
  STATE_TODO,
  TEAM_OMA,
  USER_KIM_LEE,
  USER_KIM_PARK,
  VIEWER,
  type MockLinear,
} from './fixtures.js';

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

function setup(
  options: Parameters<typeof createMockLinear>[0] = {},
  storeOptions: { now?: () => number; ttlMs?: number } = {},
): { toolkit: Toolkit; mock: MockLinear; store: ReturnType<typeof createPreparedWriteStore> } {
  const mock = createMockLinear(options);
  const store = createPreparedWriteStore(storeOptions);
  const toolkit = createToolkit({
    client: mock.client,
    defaultTeamKey: 'oma', // lower case on purpose: the plugin normalises it
    log: createLog().log,
    store,
  });
  return { toolkit, mock, store };
}

async function run(
  toolkit: Toolkit,
  id: string,
  input: unknown,
): Promise<Record<string, unknown>> {
  const tool = toolkit.tools.find((t) => t.id === id);
  assert.ok(tool, `no tool '${id}' in the toolkit`);
  return (await tool.run(input)) as Record<string, unknown>;
}

async function rejects(
  promise: Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(
      err instanceof LinearAgentError,
      `expected a LinearAgentError, got ${String(err)}`,
    );
    assert.match(err.message, pattern);
    return true;
  });
}

/** Stage a write and return its token. */
async function prepare(toolkit: Toolkit, input: unknown): Promise<string> {
  const out = await run(toolkit, 'linear_prepare_write', input);
  return out['token'] as string;
}

// ---------------------------------------------------------------------------
// schemas
// ---------------------------------------------------------------------------

/**
 * The Zod type tags the host's schema bridge can convert. Anything else lands
 * in the model's tool definition as `{}` — no properties, no required list, no
 * descriptions — and the failure is silent: the plugin activates, the tool
 * appears, and the model guesses at the arguments.
 *
 * Tags are Zod 4's `_def.type` strings. `pipe` is the tag `.transform()` and
 * friends produce, which the bridge handles as ZodEffects.
 */
const BRIDGE_SUPPORTED_TAGS = new Set([
  'object',
  'string',
  'number',
  'boolean',
  'enum',
  'array',
  'optional',
  'nullable',
  'default',
  'literal',
  'pipe',
]);

interface ZodDefLike {
  type?: string;
  shape?: Record<string, unknown> | (() => Record<string, unknown>);
  innerType?: unknown;
  element?: unknown;
  in?: unknown;
  out?: unknown;
}

function defOf(schema: unknown): ZodDefLike {
  return (schema as { _def: ZodDefLike })._def;
}

/** Every type tag reachable from a schema, as `path -> tag`. */
function collectTags(schema: unknown, path = '$', into = new Map<string, string>()): Map<string, string> {
  const def = defOf(schema);
  const tag = def.type ?? '(untagged)';
  into.set(path, tag);
  if (def.shape !== undefined) {
    const shape = typeof def.shape === 'function' ? def.shape() : def.shape;
    for (const [key, child] of Object.entries(shape)) {
      collectTags(child, `${path}.${key}`, into);
    }
  }
  for (const [name, child] of [
    ['innerType', def.innerType],
    ['element', def.element],
    ['in', def.in],
    ['out', def.out],
  ] as const) {
    if (child !== undefined && child !== null) collectTags(child, `${path}<${name}>`, into);
  }
  return into;
}

function isOptionalTag(schema: unknown): boolean {
  const tag = defOf(schema).type;
  return tag === 'optional' || tag === 'default';
}

function requiredKeys(schema: unknown): string[] {
  const def = defOf(schema);
  const shape = typeof def.shape === 'function' ? def.shape() : (def.shape ?? {});
  return Object.entries(shape)
    .filter(([, child]) => !isOptionalTag(child))
    .map(([key]) => key)
    .sort();
}

describe('toolkit shape', () => {
  const { toolkit } = setup();

  it('publishes exactly the five tools, with unique ids', () => {
    assert.deepEqual(
      toolkit.tools.map((t) => t.id),
      [
        'linear_search_issues',
        'linear_get_issue',
        'linear_lookup',
        'linear_prepare_write',
        'linear_commit_write',
      ],
    );
    assert.equal(new Set(toolkit.tools.map((t) => t.id)).size, 5);
  });

  it('describes every tool, and says read-only or asks for confirmation', () => {
    for (const tool of toolkit.tools) {
      assert.ok(tool.description.length > 40, `${tool.id} needs a real description`);
      assert.match(
        tool.description,
        /Read-only|confirm/i,
        `${tool.id} must tell the model whether it changes anything`,
      );
    }
  });

  it('stays inside the Zod types the host bridge can convert', () => {
    for (const tool of toolkit.tools) {
      const tags = collectTags(tool.input);
      for (const [path, tag] of tags) {
        assert.ok(
          BRIDGE_SUPPORTED_TAGS.has(tag),
          `${tool.id} ${path} uses Zod type '${tag}', which the host bridge degrades to {}`,
        );
      }
    }
  });

  it('takes an object at the top level, so the bridge sees properties at all', () => {
    for (const tool of toolkit.tools) {
      assert.equal(defOf(tool.input).type, 'object', `${tool.id} input must be an object`);
      assert.ok(collectTags(tool.input).size > 1, `${tool.id} input has no fields`);
    }
  });

  it('asks only for what each tool genuinely needs', () => {
    const required = new Map(toolkit.tools.map((t) => [t.id, requiredKeys(t.input)]));
    assert.deepEqual(required.get('linear_search_issues'), []);
    assert.deepEqual(required.get('linear_get_issue'), ['key']);
    assert.deepEqual(required.get('linear_lookup'), ['kind']);
    // The per-kind rules cannot live in the schema without a discriminated
    // union, which the bridge cannot convert — so `kind` is the only hard
    // requirement here and validateWriteInput enforces the rest.
    assert.deepEqual(required.get('linear_prepare_write'), ['kind']);
    assert.deepEqual(required.get('linear_commit_write'), ['token']);
  });

  it('offers the five stages of work as an enum, and not triage', () => {
    const tool = toolkit.tools.find((t) => t.id === 'linear_search_issues');
    assert.ok(tool);
    const parsed = tool.input.safeParse({ stateType: 'triage' });
    assert.equal(parsed.success, false);
    for (const t of ['backlog', 'unstarted', 'started', 'completed', 'canceled']) {
      assert.ok(tool.input.safeParse({ stateType: t }).success, `${t} should be accepted`);
    }
  });

  it('rejects an undeclared key instead of dropping it', () => {
    // Zod strips by default, so `state` for `stateName` would vanish and the
    // preview would faithfully describe a write missing the change that was
    // asked for. Every input is strict for this reason.
    for (const tool of toolkit.tools) {
      const parsed = tool.input.safeParse({ definitelyNotAField: 1 });
      assert.equal(parsed.success, false, `${tool.id} accepted an undeclared key`);
    }
    const prepareTool = toolkit.tools.find((t) => t.id === 'linear_prepare_write');
    assert.ok(prepareTool);
    const typo = prepareTool.input.safeParse({
      kind: 'update_issue',
      issueKey: 'OMA-7',
      state: 'Done',
    });
    assert.equal(typo.success, false);
    assert.match(JSON.stringify(typo.error?.issues), /Unrecognized key/);
  });

  it('bounds the free-text and limit inputs', () => {
    const tool = toolkit.tools.find((t) => t.id === 'linear_search_issues');
    assert.ok(tool);
    assert.equal(tool.input.safeParse({ limit: 0 }).success, false);
    assert.equal(tool.input.safeParse({ limit: 51 }).success, false);
    assert.equal(tool.input.safeParse({ limit: 3.5 }).success, false);
    assert.equal(tool.input.safeParse({ text: 'x'.repeat(501) }).success, false);
  });

  it('bounds priority to Linear’s own 0–4', () => {
    const tool = toolkit.tools.find((t) => t.id === 'linear_prepare_write');
    assert.ok(tool);
    for (const p of [0, 1, 2, 3, 4]) {
      assert.ok(tool.input.safeParse({ kind: 'create_issue', priority: p }).success);
    }
    assert.equal(tool.input.safeParse({ kind: 'create_issue', priority: 5 }).success, false);
    assert.equal(tool.input.safeParse({ kind: 'create_issue', priority: -1 }).success, false);
  });

  it('keeps the field descriptions the bridge will actually publish', () => {
    // The bridge unwraps an Optional to its inner schema and keeps the inner
    // description, so a `.describe()` applied after `.optional()` is dropped.
    // These are the descriptions where that distinction matters.
    const tool = toolkit.tools.find((t) => t.id === 'linear_prepare_write');
    assert.ok(tool);
    const shape = defOf(tool.input).shape as Record<string, unknown>;
    const inner = defOf(shape['assignee']).innerType;
    assert.match(
      (inner as { description?: string }).description ?? '',
      /'none' to clear the assignee/,
    );
  });
});

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

describe('linear_search_issues', () => {
  it('falls back to the configured default team, normalised', async () => {
    const { toolkit, mock } = setup();
    const out = await run(toolkit, 'linear_search_issues', {});
    assert.equal(out['teamKey'], 'OMA');
    const [call] = mock.callsTo('searchIssues');
    assert.deepEqual(call?.args[0], { teamKey: 'OMA' });
  });

  it('resolves "me" to the API key’s owner', async () => {
    const { toolkit, mock } = setup();
    const out = await run(toolkit, 'linear_search_issues', { assignee: 'me' });
    assert.equal(out['assignee'], VIEWER.displayName);
    assert.deepEqual(mock.callsTo('searchIssues')[0]?.args[0], {
      teamKey: 'OMA',
      assigneeId: VIEWER.id,
    });
  });

  it('resolves a person’s name to their id', async () => {
    const { toolkit, mock } = setup({ users: [VIEWER, USER_KIM_LEE] });
    await run(toolkit, 'linear_search_issues', { assignee: 'Kim Lee' });
    assert.deepEqual(mock.callsTo('searchIssues')[0]?.args[0], {
      teamKey: 'OMA',
      assigneeId: USER_KIM_LEE.id,
    });
  });

  it('passes the other filters through untouched', async () => {
    const { toolkit, mock } = setup();
    await run(toolkit, 'linear_search_issues', {
      teamKey: 'WEB',
      stateType: 'started',
      text: 'safari',
      limit: 5,
    });
    assert.deepEqual(mock.callsTo('searchIssues')[0]?.args[0], {
      teamKey: 'WEB',
      stateType: 'started',
      text: 'safari',
      limit: 5,
    });
  });

  it('returns a summary per issue, not the API payload', async () => {
    const { toolkit } = setup();
    const out = await run(toolkit, 'linear_search_issues', {});
    const issues = out['issues'] as Record<string, unknown>[];
    assert.equal(out['count'], 1);
    assert.deepEqual(Object.keys(issues[0] ?? {}).sort(), [
      'assignee',
      'key',
      'labels',
      'priority',
      'state',
      'stateType',
      'title',
      'updatedAt',
      'url',
    ]);
    assert.equal(issues[0]?.['key'], 'OMA-7');
    assert.equal(issues[0]?.['priority'], 'Medium', 'priority must read as a word');
    assert.ok(!('description' in (issues[0] ?? {})), 'a search hit must not carry a description');
  });

  it('reports an unknown team key by listing the ones that exist', async () => {
    const { toolkit } = setup();
    await rejects(
      run(toolkit, 'linear_search_issues', { teamKey: 'NOPE' }),
      /No team with key 'NOPE'.*OMA, WEB/s,
    );
  });
});

describe('linear_get_issue', () => {
  it('returns the description and comments for one issue', async () => {
    const { toolkit } = setup({
      issues: [makeIssue({ comments: [makeComment(), makeComment({ id: 'c2', body: 'Fixed.' })] })],
    });
    const out = await run(toolkit, 'linear_get_issue', { key: 'oma-7' });
    assert.equal(out['key'], 'OMA-7');
    assert.equal(out['team'], 'OMA');
    assert.equal(out['description'], 'Safari 17 rejects the session cookie.');
    assert.equal(out['commentCount'], 2);
    assert.equal((out['comments'] as unknown[]).length, 2);
  });

  it('truncates a very long description instead of filling the context', async () => {
    const { toolkit } = setup({ issues: [makeIssue({ description: 'z'.repeat(10_000) })] });
    const out = await run(toolkit, 'linear_get_issue', { key: 'OMA-7' });
    const description = out['description'] as string;
    assert.equal(description.length, 4_001);
    assert.ok(description.endsWith('…'));
  });

  it('keeps only the most recent comments', async () => {
    const comments = Array.from({ length: 30 }, (_, i) =>
      makeComment({
        id: `c${String(i)}`,
        body: `comment ${String(i)}`,
        createdAt: new Date(Date.UTC(2026, 8, 1, i)).toISOString(),
      }),
    );
    const { toolkit } = setup({ issues: [makeIssue({ comments })] });
    const out = await run(toolkit, 'linear_get_issue', { key: 'OMA-7' });
    const returned = out['comments'] as { body: string }[];
    assert.equal(out['commentCount'], 30, 'the true count must still be reported');
    assert.equal(returned.length, 20);
    assert.equal(returned[19]?.body, 'comment 29');
  });

  it('returns the newest comments whatever order Linear sent them in', async () => {
    // The client's comment query sets no `orderBy`, so the order it hands back
    // is a default nobody here controls. Slicing without sorting returned the
    // oldest comments under the label "most recent".
    const comments = [
      makeComment({ id: 'c-new', body: 'newest', createdAt: '2026-09-06T12:00:00.000Z' }),
      makeComment({ id: 'c-old', body: 'oldest', createdAt: '2026-09-01T12:00:00.000Z' }),
      makeComment({ id: 'c-mid', body: 'middle', createdAt: '2026-09-03T12:00:00.000Z' }),
    ];
    const { toolkit } = setup({ issues: [makeIssue({ comments })] });
    const out = await run(toolkit, 'linear_get_issue', { key: 'OMA-7' });
    assert.deepEqual(
      (out['comments'] as { body: string }[]).map((c) => c.body),
      ['oldest', 'middle', 'newest'],
      'oldest-first within the returned slice — a thread reads forwards',
    );
  });

  it('attributes an app-authored comment rather than showing a blank', async () => {
    const { toolkit } = setup({
      issues: [makeIssue({ comments: [makeComment({ author: undefined })] })],
    });
    const out = await run(toolkit, 'linear_get_issue', { key: 'OMA-7' });
    assert.equal((out['comments'] as { author: string }[])[0]?.author, 'Omadia');
  });

  it('says the issue does not exist instead of returning nothing', async () => {
    const { toolkit } = setup();
    await rejects(run(toolkit, 'linear_get_issue', { key: 'OMA-999' }), /No issue 'OMA-999'/);
  });
});

describe('linear_lookup', () => {
  it('lists teams with their keys', async () => {
    const { toolkit } = setup();
    const out = await run(toolkit, 'linear_lookup', { kind: 'teams' });
    assert.deepEqual((out['teams'] as { key: string }[]).map((t) => t.key), ['OMA', 'WEB']);
  });

  it('lists the workflow states of the default team, with their types', async () => {
    const { toolkit } = setup();
    const out = await run(toolkit, 'linear_lookup', { kind: 'states' });
    assert.equal(out['teamKey'], 'OMA');
    const states = out['states'] as { name: string; type: string }[];
    assert.deepEqual(
      states.map((s) => s.name),
      ['Backlog', 'Todo', 'In Progress', 'Done'],
    );
    assert.equal(states.find((s) => s.name === 'Done')?.type, 'completed');
  });

  it('leaves deactivated members out', async () => {
    const { toolkit } = setup();
    const out = await run(toolkit, 'linear_lookup', { kind: 'users' });
    const names = (out['users'] as { name: string }[]).map((u) => u.name);
    assert.ok(!names.includes('Robin Gone'));
    assert.ok(names.includes('Andre Derjagin'));
  });

  it('keeps workspace-wide labels when listing a team’s labels', async () => {
    const { toolkit } = setup();
    const out = await run(toolkit, 'linear_lookup', { kind: 'labels' });
    const labels = out['labels'] as { name: string; scope: string }[];
    assert.deepEqual(labels.map((l) => l.name), ['bug', 'mobile', 'needs-triage']);
    assert.equal(labels.find((l) => l.name === 'needs-triage')?.scope, 'workspace');
  });

  it('narrows a list by the query', async () => {
    const { toolkit } = setup();
    const out = await run(toolkit, 'linear_lookup', { kind: 'states', query: 'do' });
    assert.deepEqual((out['states'] as { name: string }[]).map((s) => s.name), ['Todo', 'Done']);
  });
});

// ---------------------------------------------------------------------------
// prepare — the gate
// ---------------------------------------------------------------------------

describe('linear_prepare_write', () => {
  it('never reaches a mutating client method', async () => {
    const { toolkit, mock } = setup({ states: [STATE_TODO, STATE_DONE] });

    await run(toolkit, 'linear_prepare_write', {
      kind: 'create_issue',
      title: 'Login fails on Safari',
      stateName: 'Todo',
      assignee: 'me',
      priority: 2,
      labels: ['bug'],
      description: 'Details.',
    });
    await run(toolkit, 'linear_prepare_write', {
      kind: 'update_issue',
      issueKey: 'OMA-7',
      stateName: 'Done',
      assignee: 'me',
    });
    await run(toolkit, 'linear_prepare_write', {
      kind: 'add_comment',
      issueKey: 'OMA-7',
      body: 'On staging.',
    });

    assert.deepEqual(
      mock.mutations(),
      [],
      'prepare must not call createIssue, updateIssue or addComment',
    );
  });

  it('returns a token, the preview, an expiry and the next step', async () => {
    const { toolkit } = setup();
    const out = await run(toolkit, 'linear_prepare_write', {
      kind: 'create_issue',
      title: 'Login fails on Safari',
      priority: 3,
    });
    assert.match(out['token'] as string, /\S{8,}/);
    assert.equal(out['preview'], 'New issue in OMA: Login fails on Safari (priority Medium)');
    assert.ok(!Number.isNaN(Date.parse(out['expiresAt'] as string)));
    assert.match(out['nextStep'] as string, /NOTHING HAS BEEN WRITTEN YET/);
    assert.match(out['nextStep'] as string, /linear_commit_write/);
  });

  it('tells the agent to hand the token back rather than commit in this turn', async () => {
    // The sub-agent is called one stateless question at a time: `ask()` starts
    // with a single user message, so a confirmation can only arrive in a LATER
    // question, and only if the token travelled out in this answer. Without
    // this instruction the write path dead-ends in repeated previews.
    const { toolkit } = setup();
    const out = await run(toolkit, 'linear_prepare_write', {
      kind: 'add_comment',
      issueKey: 'OMA-7',
      body: 'note',
    });
    const next = out['nextStep'] as string;
    assert.match(next, /NOTHING HAS BEEN WRITTEN YET/);
    assert.match(next, /reply to your caller with the preview and this token/);
    assert.match(next, /Do NOT call linear_commit_write in this turn/);
    assert.match(next, /a later request/);
  });

  it('resolves names to ids before staging anything', async () => {
    const { toolkit, store } = setup({ states: [STATE_TODO, STATE_DONE] });
    const token = await prepare(toolkit, {
      kind: 'create_issue',
      title: 'New thing',
      stateName: 'todo',
      assignee: 'me',
      labels: ['mobile'],
    });
    const staged = store.peek(token);
    assert.ok(staged);
    assert.equal(staged.write.kind, 'create_issue');
    assert.deepEqual(staged.write, {
      kind: 'create_issue',
      teamId: TEAM_OMA.id,
      teamKey: 'OMA',
      title: 'New thing',
      stateId: STATE_TODO.id,
      stateName: 'Todo',
      assigneeId: VIEWER.id,
      assigneeName: VIEWER.displayName,
      labelIds: [LABEL_MOBILE.id],
      labelNames: ['mobile'],
    });
  });

  it('prefers an exact state name over a longer one that contains it', async () => {
    const { toolkit, store } = setup({ states: [STATE_TODO, STATE_DONE, STATE_DONE_DEPLOY] });
    const token = await prepare(toolkit, {
      kind: 'update_issue',
      issueKey: 'OMA-7',
      stateName: 'Done',
    });
    const staged = store.peek(token);
    assert.ok(staged && staged.write.kind === 'update_issue');
    assert.equal(staged.write.patch.stateId, STATE_DONE.id);
  });

  it('refuses an unknown state and lists the ones the team has', async () => {
    const { toolkit } = setup();
    await rejects(
      run(toolkit, 'linear_prepare_write', {
        kind: 'update_issue',
        issueKey: 'OMA-7',
        stateName: 'Shipped',
      }),
      /no workflow state matching 'Shipped'.*Backlog.*Done \(completed\)/s,
    );
  });

  it('refuses an ambiguous person rather than guessing', async () => {
    const { toolkit } = setup({ users: [USER_KIM_LEE, USER_KIM_PARK] });
    await rejects(
      run(toolkit, 'linear_prepare_write', {
        kind: 'update_issue',
        issueKey: 'OMA-7',
        assignee: 'Kim',
      }),
      /matches several people.*Kim Lee.*Kim Park/s,
    );
  });

  it('refuses an unknown label and lists the available ones', async () => {
    const { toolkit } = setup();
    await rejects(
      run(toolkit, 'linear_prepare_write', {
        kind: 'create_issue',
        title: 'x',
        labels: ['regression'],
      }),
      /no label matching 'regression'.*bug, mobile, needs-triage/s,
    );
  });

  it('requires a title on create_issue', async () => {
    const { toolkit } = setup();
    await rejects(
      run(toolkit, 'linear_prepare_write', { kind: 'create_issue' }),
      /create_issue needs a title/,
    );
  });

  it('requires an issue key on update_issue', async () => {
    const { toolkit } = setup();
    await rejects(
      run(toolkit, 'linear_prepare_write', { kind: 'update_issue', stateName: 'Done' }),
      /update_issue needs the issue's key/,
    );
  });

  it('requires at least one field to change on update_issue', async () => {
    const { toolkit } = setup();
    await rejects(
      run(toolkit, 'linear_prepare_write', { kind: 'update_issue', issueKey: 'OMA-7' }),
      /at least one field to change/,
    );
  });

  it('requires a body on add_comment', async () => {
    const { toolkit } = setup();
    await rejects(
      run(toolkit, 'linear_prepare_write', { kind: 'add_comment', issueKey: 'OMA-7' }),
      /add_comment needs both issueKey and body/,
    );
  });

  it('refuses a field that does not belong to the kind, instead of ignoring it', async () => {
    const { toolkit } = setup();
    await rejects(
      run(toolkit, 'linear_prepare_write', {
        kind: 'add_comment',
        issueKey: 'OMA-7',
        body: 'note',
        stateName: 'Done',
      }),
      /add_comment does not take stateName/,
    );
    await rejects(
      run(toolkit, 'linear_prepare_write', {
        kind: 'create_issue',
        title: 'x',
        body: 'note',
      }),
      /create_issue does not take body/,
    );
    await rejects(
      run(toolkit, 'linear_prepare_write', {
        kind: 'update_issue',
        issueKey: 'OMA-7',
        teamKey: 'WEB',
        stateName: 'Done',
      }),
      /update_issue does not take teamKey/,
    );
  });

  it('refuses to stage a write against an issue that does not exist', async () => {
    const { toolkit, store } = setup();
    await rejects(
      run(toolkit, 'linear_prepare_write', {
        kind: 'update_issue',
        issueKey: 'OMA-404',
        stateName: 'Done',
      }),
      /No issue 'OMA-404'.*Nothing was staged/s,
    );
    assert.equal(store.size(), 0);
  });

  it('patches only the fields that differ, and says the rest is unchanged', async () => {
    const { toolkit, store } = setup({ states: [STATE_TODO, STATE_DONE] });
    const token = await prepare(toolkit, {
      kind: 'update_issue',
      issueKey: 'OMA-7',
      stateName: 'Done',
      assignee: 'me', // already the assignee
    });
    const staged = store.peek(token);
    assert.ok(staged && staged.write.kind === 'update_issue');
    assert.deepEqual(staged.write.patch, { stateId: STATE_DONE.id });
    assert.equal(
      staged.preview,
      'OMA-7: Todo → Done, assignee unchanged\nIssue: "Login fails on Safari"',
    );
  });

  it('stages nothing when every value already matches', async () => {
    const { toolkit, store } = setup();
    await rejects(
      run(toolkit, 'linear_prepare_write', {
        kind: 'update_issue',
        issueKey: 'OMA-7',
        stateName: 'Todo',
        assignee: 'me',
        priority: 3,
      }),
      /already matches every value you gave.*nothing to change/s,
    );
    assert.equal(store.size(), 0);
  });

  it('clears an assignee when asked for "none"', async () => {
    const { toolkit, store } = setup();
    const token = await prepare(toolkit, {
      kind: 'update_issue',
      issueKey: 'OMA-7',
      assignee: 'none',
    });
    const staged = store.peek(token);
    assert.ok(staged && staged.write.kind === 'update_issue');
    assert.deepEqual(staged.write.patch, { assigneeId: null });
    assert.match(staged.preview, /assignee andre → nobody/);
  });

  it('does not offer "none" on create_issue, where omission already means that', async () => {
    const { toolkit } = setup();
    await rejects(
      run(toolkit, 'linear_prepare_write', {
        kind: 'create_issue',
        title: 'x',
        assignee: 'none',
      }),
      /Omit assignee to create an unassigned issue/,
    );
  });

  it('replaces the whole label set, since that is what the client does', async () => {
    const { toolkit, store } = setup();
    const token = await prepare(toolkit, {
      kind: 'update_issue',
      issueKey: 'OMA-7',
      labels: ['mobile'],
    });
    const staged = store.peek(token);
    assert.ok(staged && staged.write.kind === 'update_issue');
    assert.deepEqual(staged.write.patch, { labelIds: [LABEL_MOBILE.id] });
    assert.match(staged.preview, /labels bug → mobile/);
  });

  it('collapses a repeated label rather than sending it twice', async () => {
    const { toolkit, store } = setup({ issues: [makeIssue({ labels: [] })] });
    const token = await prepare(toolkit, {
      kind: 'update_issue',
      issueKey: 'OMA-7',
      labels: ['bug', 'BUG'],
    });
    const staged = store.peek(token);
    assert.ok(staged && staged.write.kind === 'update_issue');
    assert.deepEqual(staged.write.patch, { labelIds: ['label-bug'] });
    assert.match(staged.preview, /labels none → bug$/m);
  });

  it('treats a reordered, differently cased label list as no change', async () => {
    const { toolkit } = setup({ issues: [makeIssue({ labels: ['bug', 'mobile'] })] });
    await rejects(
      run(toolkit, 'linear_prepare_write', {
        kind: 'update_issue',
        issueKey: 'OMA-7',
        labels: ['Mobile', 'BUG'],
      }),
      /nothing to change/,
    );
  });
});

// ---------------------------------------------------------------------------
// commit — the only mutation
// ---------------------------------------------------------------------------

describe('linear_commit_write', () => {
  it('creates the issue exactly as staged, and reports its key and link', async () => {
    const { toolkit, mock } = setup({ states: [STATE_TODO, STATE_DONE] });
    const token = await prepare(toolkit, {
      kind: 'create_issue',
      title: 'Login fails on Safari',
      description: 'Safari 17.',
      stateName: 'Todo',
      assignee: 'me',
      priority: 2,
      labels: ['bug'],
    });

    const out = await run(toolkit, 'linear_commit_write', { token });

    assert.deepEqual(mock.callsTo('createIssue')[0]?.args[0], {
      teamId: TEAM_OMA.id,
      title: 'Login fails on Safari',
      description: 'Safari 17.',
      stateId: STATE_TODO.id,
      assigneeId: VIEWER.id,
      priority: 2,
      labelIds: ['label-bug'],
    });
    assert.equal(out['committed'], true);
    assert.equal(out['key'], 'OMA-31');
    assert.match(out['url'] as string, /OMA-31$/);
  });

  it('sends only the changed keys on an update', async () => {
    const { toolkit, mock } = setup({ states: [STATE_TODO, STATE_DONE] });
    const token = await prepare(toolkit, {
      kind: 'update_issue',
      issueKey: 'OMA-7',
      stateName: 'Done',
      assignee: 'me',
      priority: 3,
    });

    const out = await run(toolkit, 'linear_commit_write', { token });

    const [call] = mock.callsTo('updateIssue');
    assert.equal(call?.args[0], 'issue-7');
    assert.deepEqual(call?.args[1], { stateId: STATE_DONE.id });
    assert.equal(out['key'], 'OMA-7');
    assert.equal(out['state'], 'Done');
  });

  it('adds the comment to the resolved issue id', async () => {
    const { toolkit, mock } = setup();
    const token = await prepare(toolkit, {
      kind: 'add_comment',
      issueKey: 'oma-7',
      body: 'The fix is on staging.',
    });

    const out = await run(toolkit, 'linear_commit_write', { token });

    assert.deepEqual(mock.callsTo('addComment')[0]?.args, ['issue-7', 'The fix is on staging.']);
    assert.equal(out['key'], 'OMA-7');
    assert.equal(out['commentId'], 'comment-99');
  });

  it('refuses a reused token and writes nothing the second time', async () => {
    const { toolkit, mock } = setup();
    const token = await prepare(toolkit, {
      kind: 'add_comment',
      issueKey: 'OMA-7',
      body: 'once',
    });

    await run(toolkit, 'linear_commit_write', { token });
    await rejects(run(toolkit, 'linear_commit_write', { token }), /already committed/);

    assert.equal(mock.mutations().length, 1, 'the same token must not apply twice');
  });

  it('refuses an expired token and writes nothing', async () => {
    let t = 1_000_000;
    const { toolkit, mock } = setup({}, { now: () => t, ttlMs: 60_000 });
    const token = await prepare(toolkit, {
      kind: 'add_comment',
      issueKey: 'OMA-7',
      body: 'too late',
    });

    t += 60_001;

    await rejects(run(toolkit, 'linear_commit_write', { token }), /expired.*Nothing was written/s);
    assert.deepEqual(mock.mutations(), []);
  });

  it('refuses an unknown token and writes nothing', async () => {
    const { toolkit, mock } = setup();
    await rejects(
      run(toolkit, 'linear_commit_write', { token: 'made-up-token' }),
      /unknown, was already committed, or expired/,
    );
    assert.deepEqual(mock.mutations(), []);
  });
});

describe('toolkit close', () => {
  it('drops staged writes, so a preview cannot be committed after a deactivate', async () => {
    const { toolkit, store, mock } = setup();
    const token = await prepare(toolkit, {
      kind: 'add_comment',
      issueKey: 'OMA-7',
      body: 'note',
    });
    assert.equal(store.size(), 1);

    await toolkit.close();

    assert.equal(store.size(), 0);
    await rejects(run(toolkit, 'linear_commit_write', { token }), /unknown/);
    assert.deepEqual(mock.mutations(), []);
  });
});

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { decodeCursor } from '../src/cursor.js';
import { LinearAgentError } from '../src/errors.js';
import { createPreparedWriteStore } from '../src/preparedWrites.js';
import { createToolkit, type Toolkit, type WriteMode } from '../src/toolkit.js';
import {
  CONVERSATION,
  createLog,
  createMockLinear,
  createTurns,
  CYCLE_CURRENT,
  LABEL_BUG,
  LABEL_MOBILE,
  makeComment,
  makeIssue,
  PROJECT_BILLING,
  STATE_DONE,
  STATE_DONE_DEPLOY,
  STATE_TODO,
  TEAM_OMA,
  USER_KIM_LEE,
  USER_KIM_PARK,
  VIEWER,
  type MockLinear,
  type Turns,
} from './fixtures.js';

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

function setup(
  options: Parameters<typeof createMockLinear>[0] = {},
  storeOptions: { now?: () => number; ttlMs?: number } = {},
  writeMode: WriteMode = 'confirm',
): {
  toolkit: Toolkit;
  mock: MockLinear;
  store: ReturnType<typeof createPreparedWriteStore>;
  turns: Turns;
} {
  const mock = createMockLinear(options);
  const store = createPreparedWriteStore(storeOptions);
  const turns = createTurns();
  const toolkit = createToolkit({
    client: mock.client,
    defaultTeamKey: 'oma', // lower case on purpose: the plugin normalises it
    log: createLog().log,
    writeMode,
    caller: turns.caller,
    store,
  });
  return { toolkit, mock, store, turns };
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

/** Stage a write; answers with the conversation it now waits in. */
async function prepare(toolkit: Toolkit, input: unknown): Promise<string> {
  await run(toolkit, 'linear_prepare_write', input);
  return CONVERSATION;
}

/** The user said yes: a new turn, and the commit made in it. */
async function confirm(toolkit: Toolkit, turns: Turns): Promise<Record<string, unknown>> {
  turns.next();
  return run(toolkit, 'linear_commit_write', {});
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

  it('publishes the three read tools and the two of the confirmation mode', () => {
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
      // The commit takes nothing: what it applies is decided by who calls.
      if (tool.id === 'linear_commit_write') continue;
      assert.ok(collectTags(tool.input).size > 1, `${tool.id} input has no fields`);
    }
  });

  it('gives the commit no argument a model could aim at another change', () => {
    const tool = toolkit.tools.find((t) => t.id === 'linear_commit_write');
    assert.ok(tool);
    assert.equal(collectTags(tool.input).size, 1);
    assert.ok(tool.input.safeParse({}).success);
    assert.equal(tool.input.safeParse({ token: 'w1-abcd' }).success, false);
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
    assert.deepEqual(required.get('linear_commit_write'), []);
  });

  it('offers every state type Linear has as an enum, triage included', () => {
    const tool = toolkit.tools.find((t) => t.id === 'linear_search_issues');
    assert.ok(tool);
    for (const t of ['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled']) {
      assert.ok(tool.input.safeParse({ stateType: t }).success, `${t} should be accepted`);
    }
    assert.equal(tool.input.safeParse({ stateType: 'done' }).success, false);
  });

  it('takes a time as a date, a timestamp with its zone, or a span back from now', () => {
    const tool = toolkit.tools.find((t) => t.id === 'linear_search_issues');
    assert.ok(tool);
    const fields = [
      'createdAfter',
      'createdBefore',
      'updatedAfter',
      'updatedBefore',
      'completedAfter',
      'completedBefore',
    ];
    for (const field of fields) {
      for (const ok of [
        '2026-11-02',
        '2026-11-02T09:00:00Z',
        '2026-11-02T09:00:00.000Z',
        '2026-11-02T09:00+01:00',
        '-P7D',
        '-P2W',
        '-P1M',
        '-P2W1D',
      ]) {
        assert.ok(tool.input.safeParse({ [field]: ok }).success, `${field}: ${ok} should be accepted`);
      }
      for (const bad of [
        'last week',
        'yesterday',
        '02.11.2026',
        '2026-11-02T09:00:00', // which zone?
        'P7D', // a span forward
        '-P',
        '-7D',
        '',
      ]) {
        assert.equal(
          tool.input.safeParse({ [field]: bad }).success,
          false,
          `${field}: '${bad}' should be rejected`,
        );
      }
    }
    // What the model is told when it gets the format wrong names the formats.
    const issue = tool.input.safeParse({ completedAfter: 'last week' }).error?.issues[0];
    assert.match(issue?.message ?? '', /YYYY-MM-DD.*-P7D/);
  });

  it('describes every search field the bridge will publish', () => {
    const tool = toolkit.tools.find((t) => t.id === 'linear_search_issues');
    assert.ok(tool);
    const shape = defOf(tool.input).shape as Record<string, unknown>;
    for (const [key, field] of Object.entries(shape)) {
      // The bridge publishes the inner description of an Optional and falls
      // back to the outer one.
      const inner = defOf(field).innerType as { description?: string } | undefined;
      const description = inner?.description ?? (field as { description?: string }).description;
      assert.ok((description ?? '').length > 10, `${key} needs a description`);
    }
    assert.deepEqual(Object.keys(shape).sort(), [
      'assignee',
      'completedAfter',
      'completedBefore',
      'createdAfter',
      'createdBefore',
      'creator',
      'cursor',
      'cycle',
      'label',
      'limit',
      'priority',
      'project',
      'stateType',
      'teamKey',
      'text',
      'updatedAfter',
      'updatedBefore',
    ]);
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
      'canceledAt',
      'completedAt',
      'cycle',
      'key',
      'labels',
      'priority',
      'project',
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

  it('resolves every name filter to the id Linear filters by', async () => {
    const { toolkit, mock } = setup();
    const out = await run(toolkit, 'linear_search_issues', {
      stateType: 'triage',
      creator: 'Kim Lee',
      label: 'Bug',
      priority: 1,
      project: 'billing',
      cycle: 'current',
    });

    assert.deepEqual(mock.callsTo('searchIssues')[0]?.args[0], {
      teamKey: 'OMA',
      stateType: 'triage',
      creatorId: USER_KIM_LEE.id,
      labelId: LABEL_BUG.id,
      priority: 1,
      projectId: PROJECT_BILLING.id,
      cycleId: CYCLE_CURRENT.id,
    });
    // The person a filter resolved to goes back with the result.
    assert.equal(out['creator'], USER_KIM_LEE.displayName);
  });

  it('carries the paging data under the names the host keeps out of the rows', async () => {
    // The host takes `count`, `hasMore` and `cursor` for the paging data of a
    // result. Any other top-level value it copies into every issue row.
    const { toolkit } = setup();
    const out = await run(toolkit, 'linear_search_issues', { label: 'bug', cycle: 'current' });
    assert.deepEqual(Object.keys(out).sort(), ['count', 'cursor', 'hasMore', 'issues', 'teamKey']);
  });

  it('filters by priority 0, which is a value and not an absence', async () => {
    const { toolkit, mock } = setup();
    await run(toolkit, 'linear_search_issues', { priority: 0 });
    assert.deepEqual(mock.callsTo('searchIssues')[0]?.args[0], { teamKey: 'OMA', priority: 0 });
  });

  it('passes each time span on as its two ends', async () => {
    const { toolkit, mock } = setup();
    await run(toolkit, 'linear_search_issues', {
      createdAfter: '2026-11-02',
      createdBefore: '2026-11-09',
      updatedAfter: '-P7D',
      completedBefore: '2026-11-09T12:00:00Z',
    });
    assert.deepEqual(mock.callsTo('searchIssues')[0]?.args[0], {
      teamKey: 'OMA',
      createdAt: { from: '2026-11-02', before: '2026-11-09' },
      updatedAt: { from: '-P7D' },
      completedAt: { before: '2026-11-09T12:00:00Z' },
    });
  });

  it('refuses an unknown label, project or cycle by listing what exists', async () => {
    const { toolkit, mock } = setup();
    await rejects(
      run(toolkit, 'linear_search_issues', { label: 'urgent' }),
      /no label matching 'urgent'.*bug, mobile, needs-triage/s,
    );
    await rejects(
      run(toolkit, 'linear_search_issues', { project: 'Roadmap' }),
      /No project matches 'Roadmap'\. Projects: Mobile app, Mobile app v2, Billing\./,
    );
    await rejects(
      run(toolkit, 'linear_search_issues', { cycle: '99' }),
      /no cycle matching '99'\. Its cycles: Cycle 13, Cycle 12 \(Launch\)/,
    );
    assert.equal(mock.callsTo('searchIssues').length, 0, 'nothing may be searched on a bad name');
  });

  it('looks a cycle up in the team the search names', async () => {
    const { toolkit, mock } = setup();
    await rejects(
      run(toolkit, 'linear_search_issues', { teamKey: 'WEB', cycle: 'current' }),
      /Team WEB has no cycles/,
    );
    assert.deepEqual(mock.callsTo('cycles')[0]?.args, ['team-web']);
  });

  it('says that a page is the last one', async () => {
    const { toolkit } = setup();
    const out = await run(toolkit, 'linear_search_issues', {});
    assert.equal(out['hasMore'], false);
    assert.equal(out['cursor'], null);
  });

  it('says that more issues match, and hands out the cursor to get them', async () => {
    const { toolkit } = setup({ searchNextCursor: '9b1c7f0e-52a4-4c1d-8e55-0a1b2c3d4e5f' });
    const out = await run(toolkit, 'linear_search_issues', { limit: 1 });
    assert.equal(out['count'], 1);
    assert.equal(out['hasMore'], true);
    assert.equal(
      decodeCursor(String(out['cursor'])),
      '9b1c7f0e-52a4-4c1d-8e55-0a1b2c3d4e5f',
    );
  });

  it('fetches the next page with the cursor it handed out', async () => {
    const { toolkit, mock } = setup({ searchNextCursor: 'cursor-of-page-2' });
    const first = await run(toolkit, 'linear_search_issues', { stateType: 'started', limit: 1 });
    await run(toolkit, 'linear_search_issues', {
      stateType: 'started',
      limit: 1,
      cursor: first['cursor'],
    });

    assert.deepEqual(mock.callsTo('searchIssues')[1]?.args[0], {
      teamKey: 'OMA',
      stateType: 'started',
      limit: 1,
      cursor: 'cursor-of-page-2',
    });
  });

  it('hands out a cursor that reads as an identifier, whatever Linear sent', async () => {
    // A host that masks tool results lets a model read a string only when it
    // looks like an identifier. Linear promises no shape for its cursors.
    const { toolkit } = setup({ searchNextCursor: 'eyJvZmZzZXQiOjUwfQ==' });
    const out = await run(toolkit, 'linear_search_issues', {});
    assert.match(String(out['cursor']), /^p1-[a-z]+$/);
  });

  it('refuses a cursor it did not hand out, and searches nothing', async () => {
    const { toolkit, mock } = setup();
    await rejects(
      run(toolkit, 'linear_search_issues', { cursor: '9b1c7f0e-52a4-4c1d-8e55-0a1b2c3d4e5f' }),
      /is not a cursor this tool returned.*leave it out to start at the first page/s,
    );
    assert.equal(mock.callsTo('searchIssues').length, 0);
  });

  it('tells the model in its description what hasMore asks of it', () => {
    const { toolkit } = setup();
    const tool = toolkit.tools.find((t) => t.id === 'linear_search_issues');
    assert.ok(tool);
    assert.match(tool.description, /hasMore says whether more issues match than were returned/);
    assert.match(tool.description, /same input plus the cursor of this result/);
    for (const filter of ['creator', 'label', 'priority', 'project', 'cycle', 'created', 'updated', 'completed']) {
      assert.ok(tool.description.includes(filter), `the description must name the filter: ${filter}`);
    }
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

  it('says when an issue was completed, and null while it is open or for an older connection', async () => {
    const { toolkit } = setup({
      issues: [
        makeIssue({ completedAt: '2026-11-12T15:55:49.337Z' }),
        makeIssue({ id: 'issue-8', identifier: 'OMA-8', canceledAt: '2026-11-10T09:00:00.000Z' }),
      ],
    });
    const done = await run(toolkit, 'linear_get_issue', { key: 'OMA-7' });
    assert.equal(done['completedAt'], '2026-11-12T15:55:49.337Z');
    assert.equal(done['canceledAt'], null);
    const canceled = await run(toolkit, 'linear_get_issue', { key: 'OMA-8' });
    assert.equal(canceled['completedAt'], null);
    assert.equal(canceled['canceledAt'], '2026-11-10T09:00:00.000Z');
  });

  it('shows the project and the cycle of an issue that has them', async () => {
    const { toolkit } = setup({
      issues: [
        makeIssue({
          project: { id: PROJECT_BILLING.id, name: PROJECT_BILLING.name },
          cycle: { id: CYCLE_CURRENT.id, number: 12, name: 'Launch' },
        }),
      ],
    });
    const out = await run(toolkit, 'linear_get_issue', { key: 'OMA-7' });
    assert.equal(out['project'], 'Billing');
    assert.equal(out['cycle'], 'Cycle 12 (Launch)');

    const hit = ((await run(toolkit, 'linear_search_issues', {}))['issues'] as Record<string, unknown>[])[0];
    assert.equal(hit?.['project'], 'Billing');
    assert.equal(hit?.['cycle'], 'Cycle 12 (Launch)');
  });

  it('shows neither for an issue that has none', async () => {
    const { toolkit } = setup();
    const out = await run(toolkit, 'linear_get_issue', { key: 'OMA-7' });
    assert.equal(out['project'], null);
    assert.equal(out['cycle'], null);
  });

  it('shows a cycle without a name by its number', async () => {
    const { toolkit } = setup({
      issues: [makeIssue({ cycle: { id: 'cycle-10', number: 10, name: undefined } })],
    });
    const out = await run(toolkit, 'linear_get_issue', { key: 'OMA-7' });
    assert.equal(out['cycle'], 'Cycle 10');
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

  it('lists a triage state with its type', async () => {
    const { toolkit } = setup({
      states: [
        { id: 'state-triage', name: 'Triage', type: 'triage', position: -1, teamId: TEAM_OMA.id },
        STATE_TODO,
      ],
    });
    const out = await run(toolkit, 'linear_lookup', { kind: 'states' });
    const states = out['states'] as { name: string; type: string }[];
    assert.equal(states.find((s) => s.name === 'Triage')?.type, 'triage');
  });

  it('lists the projects of the workspace with status and dates', async () => {
    const { toolkit } = setup();
    const out = await run(toolkit, 'linear_lookup', { kind: 'projects' });
    assert.ok(!('teamKey' in out), 'a project belongs to no single team');
    assert.equal(out['count'], 3);
    assert.deepEqual((out['projects'] as Record<string, unknown>[])[0], {
      name: 'Mobile app',
      status: 'In Progress',
      statusType: 'started',
      startDate: '2026-10-01',
      targetDate: '2026-12-15',
      url: 'https://linear.app/omadia-dev/project/mobile-app',
      id: 'project-mobile',
    });
    // No date is a null, so every row has the same columns.
    assert.equal((out['projects'] as Record<string, unknown>[])[1]?.['targetDate'], null);
  });

  it('narrows projects by the query', async () => {
    const { toolkit } = setup();
    const out = await run(toolkit, 'linear_lookup', { kind: 'projects', query: 'mobile' });
    assert.deepEqual(
      (out['projects'] as { name: string }[]).map((p) => p.name),
      ['Mobile app', 'Mobile app v2'],
    );
  });

  it('lists the cycles of the team, newest first, and marks the current one', async () => {
    const { toolkit } = setup();
    const out = await run(toolkit, 'linear_lookup', { kind: 'cycles' });
    assert.equal(out['teamKey'], 'OMA');
    const cycles = out['cycles'] as Record<string, unknown>[];
    assert.deepEqual(
      cycles.map((c) => [c['number'], c['phase'], c['current']]),
      [
        [13, 'next', false],
        [12, 'current', true],
        [11, 'previous', false],
        [10, 'past', false],
      ],
    );
    assert.deepEqual(cycles[1], {
      number: 12,
      name: 'Launch',
      phase: 'current',
      current: true,
      startsAt: '2026-11-09T00:00:00.000Z',
      endsAt: '2026-11-23T00:00:00.000Z',
      id: 'cycle-12',
    });
    assert.equal(cycles[0]?.['name'], null);
  });

  it('lists no cycles for a team that has none', async () => {
    const { toolkit } = setup();
    const out = await run(toolkit, 'linear_lookup', { kind: 'cycles', teamKey: 'WEB' });
    assert.equal(out['count'], 0);
    assert.deepEqual(out['cycles'], []);
  });

  it('says that a list is complete', async () => {
    const { toolkit } = setup();
    for (const kind of ['teams', 'states', 'users', 'labels', 'projects', 'cycles']) {
      const out = await run(toolkit, 'linear_lookup', { kind });
      assert.equal(out['hasMore'], false, kind);
      assert.equal(out['total'], out['count'], kind);
    }
  });

  it('cuts a list longer than 250, and says how many there are', async () => {
    const labels = Array.from({ length: 612 }, (_, n) => ({
      id: `label-${String(n)}`,
      name: `area-${String(n)}`,
      teamId: TEAM_OMA.id,
    }));
    const { toolkit } = setup({ labels });

    const out = await run(toolkit, 'linear_lookup', { kind: 'labels' });
    assert.equal((out['labels'] as unknown[]).length, 250);
    assert.equal(out['count'], 250);
    assert.equal(out['total'], 612);
    assert.equal(out['hasMore'], true);

    // The query narrows before the cut, so a record past it stays reachable.
    const narrowed = await run(toolkit, 'linear_lookup', { kind: 'labels', query: 'area-611' });
    assert.deepEqual((narrowed['labels'] as { name: string }[]).map((l) => l.name), ['area-611']);
    assert.equal(narrowed['hasMore'], false);
  });

  it('resolves a name past the cut all the same', async () => {
    // The cut is on what the lookup tool lists, not on what a name resolves
    // against.
    const labels = Array.from({ length: 612 }, (_, n) => ({
      id: `label-${String(n)}`,
      name: `area-${String(n)}`,
      teamId: TEAM_OMA.id,
    }));
    const { toolkit, mock } = setup({ labels });
    await run(toolkit, 'linear_search_issues', { label: 'area-611' });
    assert.deepEqual(mock.callsTo('searchIssues')[0]?.args[0], {
      teamKey: 'OMA',
      labelId: 'label-611',
    });
  });
});

// ---------------------------------------------------------------------------
// prepare — the gate
// ---------------------------------------------------------------------------

describe('linear_prepare_write', () => {
  it('never reaches a mutating client method', async () => {
    // One change per turn is the gate's rule, so each kind gets a turn.
    const { toolkit, mock, turns } = setup({ states: [STATE_TODO, STATE_DONE] });

    await run(toolkit, 'linear_prepare_write', {
      kind: 'create_issue',
      title: 'Login fails on Safari',
      stateName: 'Todo',
      assignee: 'me',
      priority: 2,
      labels: ['bug'],
      description: 'Details.',
    });
    turns.next();
    await run(toolkit, 'linear_prepare_write', {
      kind: 'update_issue',
      issueKey: 'OMA-7',
      stateName: 'Done',
      assignee: 'me',
    });
    turns.next();
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

  it('returns the preview and its expiry, and nothing else', async () => {
    // The host can show this result to the user as a table, one column per
    // key, while the model gets a digest in which every text is masked. A key
    // holding an instruction would be on the user's screen and unread by the
    // model, and a handle would be one more thing to carry back. So the
    // result is the preview and until when it can be confirmed.
    const clock = { now: () => Date.parse('2026-01-01T00:00:00.000Z') };
    const { toolkit } = setup({}, clock);
    const out = await run(toolkit, 'linear_prepare_write', {
      kind: 'create_issue',
      title: 'Login fails on Safari',
      priority: 3,
    });
    assert.deepEqual(out, {
      preview: 'New issue in OMA: Login fails on Safari (priority Medium)',
      expiresAt: '2026-01-01T00:10:00.000Z',
    });
  });

  it('says in the tool description what happens next', () => {
    // The confirmation arrives in a LATER message of the user. The description
    // is the place the model reads that, whatever the host does to the result
    // and whichever agent the operator granted the tools to.
    const { toolkit } = setup();
    const tool = toolkit.tools.find((t) => t.id === 'linear_prepare_write');
    assert.ok(tool);
    assert.match(tool.description, /Nothing is written/);
    assert.match(tool.description, /waits in this conversation, one at a time, for 10 minutes/);
    assert.match(tool.description, /Show the user the preview, say that nothing is written yet, ask them to confirm/);
    assert.match(tool.description, /Call linear_commit_write only after the user has said yes in a later message/);
  });

  it('stages the write for the calling conversation', async () => {
    const { toolkit, store, turns } = setup();
    await run(toolkit, 'linear_prepare_write', { kind: 'add_comment', issueKey: 'OMA-7', body: 'a' });

    assert.equal(store.peek(CONVERSATION)?.write.kind, 'add_comment');

    turns.switchTo('conversation-2');
    await run(toolkit, 'linear_prepare_write', { kind: 'create_issue', title: 'b' });

    assert.equal(store.peek(CONVERSATION)?.write.kind, 'add_comment');
    assert.equal(store.peek('conversation-2')?.write.kind, 'create_issue');
    assert.equal(store.size(), 2);
  });

  it('refuses a second change in the same turn, and keeps the first', async () => {
    // Of two previews made in one turn nobody can say which the user saw, and
    // the yes that follows would apply only one of them.
    const { toolkit, store } = setup();
    await run(toolkit, 'linear_prepare_write', { kind: 'create_issue', title: 'First' });

    await rejects(
      run(toolkit, 'linear_prepare_write', { kind: 'create_issue', title: 'Second' }),
      /already waiting for the user's confirmation \('New issue in OMA: First'\).*One change per confirmation/s,
    );
    assert.equal(store.peek(CONVERSATION)?.preview, 'New issue in OMA: First');
  });

  it('lets a later turn replace a preview the user did not confirm', async () => {
    const { toolkit, store, turns } = setup();
    await run(toolkit, 'linear_prepare_write', { kind: 'create_issue', title: 'First' });

    turns.next();
    await run(toolkit, 'linear_prepare_write', { kind: 'create_issue', title: 'Changed' });

    assert.equal(store.size(), 1);
    assert.equal(store.peek(CONVERSATION)?.preview, 'New issue in OMA: Changed');
  });

  it('refuses where no conversation could bring the confirmation', async () => {
    // A scheduled routine, a tool called by another plugin, a host without a
    // turn context: a preview staged there would wait for a yes that cannot
    // come. Refused before Linear is asked anything.
    const { toolkit, store, turns, mock } = setup();
    turns.leave();

    await rejects(
      run(toolkit, 'linear_prepare_write', { kind: 'create_issue', title: 'x' }),
      /belongs to no conversation.*Nothing was written.*write mode/s,
    );
    assert.equal(store.size(), 0);
    assert.deepEqual(mock.calls, []);
  });

  it('resolves names to ids before staging anything', async () => {
    const { toolkit, store } = setup({ states: [STATE_TODO, STATE_DONE] });
    const conversation = await prepare(toolkit, {
      kind: 'create_issue',
      title: 'New thing',
      stateName: 'todo',
      assignee: 'me',
      labels: ['mobile'],
    });
    const staged = store.peek(conversation);
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
    const conversation = await prepare(toolkit, {
      kind: 'update_issue',
      issueKey: 'OMA-7',
      stateName: 'Done',
    });
    const staged = store.peek(conversation);
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
      /No issue 'OMA-404'.*Nothing was written/s,
    );
    assert.equal(store.size(), 0);
  });

  it('patches only the fields that differ, and says the rest is unchanged', async () => {
    const { toolkit, store } = setup({ states: [STATE_TODO, STATE_DONE] });
    const conversation = await prepare(toolkit, {
      kind: 'update_issue',
      issueKey: 'OMA-7',
      stateName: 'Done',
      assignee: 'me', // already the assignee
    });
    const staged = store.peek(conversation);
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
    const conversation = await prepare(toolkit, {
      kind: 'update_issue',
      issueKey: 'OMA-7',
      assignee: 'none',
    });
    const staged = store.peek(conversation);
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
    const conversation = await prepare(toolkit, {
      kind: 'update_issue',
      issueKey: 'OMA-7',
      labels: ['mobile'],
    });
    const staged = store.peek(conversation);
    assert.ok(staged && staged.write.kind === 'update_issue');
    assert.deepEqual(staged.write.patch, { labelIds: [LABEL_MOBILE.id] });
    assert.match(staged.preview, /labels bug → mobile/);
  });

  it('collapses a repeated label rather than sending it twice', async () => {
    const { toolkit, store } = setup({ issues: [makeIssue({ labels: [] })] });
    const conversation = await prepare(toolkit, {
      kind: 'update_issue',
      issueKey: 'OMA-7',
      labels: ['bug', 'BUG'],
    });
    const staged = store.peek(conversation);
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
    const { toolkit, mock, turns } = setup({ states: [STATE_TODO, STATE_DONE] });
    await prepare(toolkit, {
      kind: 'create_issue',
      title: 'Login fails on Safari',
      description: 'Safari 17.',
      stateName: 'Todo',
      assignee: 'me',
      priority: 2,
      labels: ['bug'],
    });

    const out = await confirm(toolkit, turns);

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
    const { toolkit, mock, turns } = setup({ states: [STATE_TODO, STATE_DONE] });
    await prepare(toolkit, {
      kind: 'update_issue',
      issueKey: 'OMA-7',
      stateName: 'Done',
      assignee: 'me',
      priority: 3,
    });

    const out = await confirm(toolkit, turns);

    const [call] = mock.callsTo('updateIssue');
    assert.equal(call?.args[0], 'issue-7');
    assert.deepEqual(call?.args[1], { stateId: STATE_DONE.id });
    assert.equal(out['key'], 'OMA-7');
    assert.equal(out['state'], 'Done');
  });

  it('adds the comment to the resolved issue id', async () => {
    const { toolkit, mock, turns } = setup();
    await prepare(toolkit, {
      kind: 'add_comment',
      issueKey: 'oma-7',
      body: 'The fix is on staging.',
    });

    const out = await confirm(toolkit, turns);

    assert.deepEqual(mock.callsTo('addComment')[0]?.args, ['issue-7', 'The fix is on staging.']);
    assert.equal(out['key'], 'OMA-7');
    assert.equal(out['commentId'], 'comment-99');
  });

  it('applies a prepared change once, and finds nothing the second time', async () => {
    const { toolkit, mock, turns } = setup();
    await prepare(toolkit, { kind: 'add_comment', issueKey: 'OMA-7', body: 'once' });

    await confirm(toolkit, turns);
    await rejects(confirm(toolkit, turns), /No change is waiting.*already committed/s);

    assert.equal(mock.mutations().length, 1, 'the same change must not apply twice');
  });

  it('refuses in the turn that prepared, and keeps the change for the next one', async () => {
    // The gate that used to live in the prompt alone: in the turn that
    // produced the preview, nobody can have said yes to it.
    const { toolkit, mock, store, turns } = setup();
    await prepare(toolkit, { kind: 'add_comment', issueKey: 'OMA-7', body: 'note' });

    await rejects(
      run(toolkit, 'linear_commit_write', {}),
      /prepared in this same turn.*Nothing was written.*the user has confirmed it in a later message/s,
    );
    assert.deepEqual(mock.mutations(), []);
    assert.equal(store.size(), 1);

    const out = await confirm(toolkit, turns);
    assert.equal(out['committed'], true);
    assert.equal(mock.mutations().length, 1);
  });

  it('does not apply a change prepared in another conversation', async () => {
    const { toolkit, mock, store, turns } = setup();
    await prepare(toolkit, { kind: 'add_comment', issueKey: 'OMA-7', body: 'mine' });

    turns.switchTo('conversation-2');
    await rejects(run(toolkit, 'linear_commit_write', {}), /No change is waiting/);

    assert.deepEqual(mock.mutations(), []);
    assert.equal(store.peek(CONVERSATION)?.write.kind, 'add_comment');
  });

  it('commits one change and prepares the next in the same turn', async () => {
    // Several changes asked for at once are confirmed one after the other;
    // the turn that commits the first may already prepare the second.
    const { toolkit, mock, store, turns } = setup();
    await prepare(toolkit, { kind: 'create_issue', title: 'First' });

    await confirm(toolkit, turns);
    await run(toolkit, 'linear_prepare_write', { kind: 'create_issue', title: 'Second' });

    assert.equal(mock.mutations().length, 1);
    assert.equal(store.peek(CONVERSATION)?.preview, 'New issue in OMA: Second');
  });

  it('refuses an expired change and writes nothing', async () => {
    let t = 1_000_000;
    const { toolkit, mock, turns } = setup({}, { now: () => t, ttlMs: 60_000 });
    await prepare(toolkit, { kind: 'add_comment', issueKey: 'OMA-7', body: 'too late' });

    t += 60_001;

    await rejects(confirm(toolkit, turns), /expired.*Nothing was written/s);
    assert.deepEqual(mock.mutations(), []);
  });

  it('refuses when nothing was prepared, and writes nothing', async () => {
    const { toolkit, mock } = setup();
    await rejects(
      run(toolkit, 'linear_commit_write', {}),
      /No change is waiting for confirmation in this conversation/,
    );
    assert.deepEqual(mock.mutations(), []);
  });

  it('refuses outside a conversation', async () => {
    const { toolkit, mock, turns } = setup();
    await prepare(toolkit, { kind: 'add_comment', issueKey: 'OMA-7', body: 'note' });
    turns.leave();

    await rejects(run(toolkit, 'linear_commit_write', {}), /belongs to no conversation/);
    assert.deepEqual(mock.mutations(), []);
  });
});

// ---------------------------------------------------------------------------
// the other write modes
// ---------------------------------------------------------------------------

describe('write mode direct', () => {
  it('offers one write tool in place of prepare and commit', () => {
    const { toolkit } = setup({}, {}, 'direct');
    assert.deepEqual(
      toolkit.tools.map((t) => t.id),
      ['linear_search_issues', 'linear_get_issue', 'linear_lookup', 'linear_write'],
    );
  });

  it('tells the model that the change is applied at once', () => {
    const { toolkit } = setup({}, {}, 'direct');
    const tool = toolkit.tools.find((t) => t.id === 'linear_write');
    assert.ok(tool);
    assert.match(tool.description, /applies it AT ONCE; there is no preview and no undo/);
    assert.match(tool.description, /ask the user instead of calling/);
  });

  it('takes the same input as a prepared write', () => {
    const direct = setup({}, {}, 'direct').toolkit.tools.find((t) => t.id === 'linear_write');
    const prepared = setup().toolkit.tools.find((t) => t.id === 'linear_prepare_write');
    assert.ok(direct && prepared);
    assert.deepEqual(
      [...collectTags(direct.input)].sort(),
      [...collectTags(prepared.input)].sort(),
    );
  });

  it('creates an issue in one call, with every name resolved', async () => {
    const { toolkit, mock, store } = setup({ states: [STATE_TODO, STATE_DONE] }, {}, 'direct');
    const out = await run(toolkit, 'linear_write', {
      kind: 'create_issue',
      title: 'Login fails on Safari',
      stateName: 'todo',
      assignee: 'me',
    });

    assert.deepEqual(mock.callsTo('createIssue')[0]?.args[0], {
      teamId: TEAM_OMA.id,
      title: 'Login fails on Safari',
      stateId: STATE_TODO.id,
      assigneeId: VIEWER.id,
    });
    assert.equal(out['committed'], true);
    assert.equal(out['key'], 'OMA-31');
    assert.equal(store.size(), 0, 'a direct write stages nothing');
  });

  it('sends only the changed keys on an update', async () => {
    const { toolkit, mock } = setup({ states: [STATE_TODO, STATE_DONE] }, {}, 'direct');
    await run(toolkit, 'linear_write', {
      kind: 'update_issue',
      issueKey: 'OMA-7',
      stateName: 'Done',
      assignee: 'me',
    });

    const [call] = mock.callsTo('updateIssue');
    assert.equal(call?.args[0], 'issue-7');
    assert.deepEqual(call?.args[1], { stateId: STATE_DONE.id });
  });

  it('needs no conversation: a routine may write', async () => {
    const { toolkit, mock, turns } = setup({}, {}, 'direct');
    turns.leave();

    await run(toolkit, 'linear_write', { kind: 'add_comment', issueKey: 'OMA-7', body: 'nightly' });

    assert.deepEqual(mock.callsTo('addComment')[0]?.args, ['issue-7', 'nightly']);
  });

  it('refuses what a prepared write refuses, and writes nothing', async () => {
    const { toolkit, mock } = setup({}, {}, 'direct');
    await rejects(
      run(toolkit, 'linear_write', { kind: 'update_issue', issueKey: 'OMA-7', stateName: 'Shipped' }),
      /no workflow state matching 'Shipped'/,
    );
    await rejects(
      run(toolkit, 'linear_write', { kind: 'add_comment', issueKey: 'OMA-7', title: 'x', body: 'y' }),
      /add_comment does not take title/,
    );
    await rejects(
      run(toolkit, 'linear_write', { kind: 'update_issue', issueKey: 'OMA-404', priority: 1 }),
      /No issue 'OMA-404'.*Nothing was written/s,
    );
    assert.deepEqual(mock.mutations(), []);
  });
});

describe('write mode off', () => {
  it('offers the three read tools and no way to write', () => {
    const { toolkit } = setup({}, {}, 'off');
    assert.deepEqual(
      toolkit.tools.map((t) => t.id),
      ['linear_search_issues', 'linear_get_issue', 'linear_lookup'],
    );
  });

  it('still reads', async () => {
    const { toolkit, mock } = setup({}, {}, 'off');
    const out = await run(toolkit, 'linear_get_issue', { key: 'OMA-7' });
    assert.equal(out['key'], 'OMA-7');
    assert.deepEqual(mock.mutations(), []);
  });
});

describe('toolkit close', () => {
  it('drops staged writes, so a preview cannot be committed after a deactivate', async () => {
    const { toolkit, store, mock, turns } = setup();
    await prepare(toolkit, { kind: 'add_comment', issueKey: 'OMA-7', body: 'note' });
    assert.equal(store.size(), 1);

    await toolkit.close();

    assert.equal(store.size(), 0);
    await rejects(confirm(toolkit, turns), /No change is waiting/);
    assert.deepEqual(mock.mutations(), []);
  });
});

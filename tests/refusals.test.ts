import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { LinearClient, LinearLabel, LinearUser } from '@omadia/integration-linear';

import {
  LinearAgentError,
  MAX_REFUSAL_CHARS,
  quoted,
  connectionRefusal,
  TOOL_REFUSAL_ERROR_NAME,
  toRefusalText,
} from '../src/errors.js';
import { LinearLookupError, listOf } from '../src/lookup.js';
import { createPreparedWriteStore, PreparedWriteError } from '../src/preparedWrites.js';
import { createToolkit, type ToolDescriptor, type Toolkit } from '../src/toolkit.js';
import {
  CONVERSATION,
  createLog,
  createMockLinear,
  createTurns,
  LABEL_BUG,
  makeIssue,
  TEAM_OMA,
  VIEWER,
  type Turns,
} from './fixtures.js';

// ---------------------------------------------------------------------------
// The host's tool bridge, restated
// ---------------------------------------------------------------------------
//
// What the model receives is decided by the host, not by this package: the
// kernel calls the registered handler with the raw input and turns whatever
// it throws into an `Error:` result. This package cannot import the host, so
// the rules it depends on are restated here, and the tests below assert the
// text the model ends up with rather than the exception that produced it.
//
//   - the handler throws a refusal -> `refused the call: <message>`: an error
//     named ToolRefusalError whose message has no line break, cut at 600
//   - it throws anything else      -> class name and log reference only; the
//     message is withheld
//
// The kernel does not validate the input of a plugin tool. `run` does, and
// answers a mismatch with a refusal (`parseInput` in toolkit.ts).
//
// If the host changes these rules this restatement goes stale without failing,
// which is why the install test exercises the same cases against a real host.

const HOST_MAX_REFUSAL_CHARS = 600;
const LINE_BREAK = new RegExp(`[\\r\\n${String.fromCharCode(0x2028, 0x2029)}]`);
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f]+/g;

const REFUSED = (id: string): string => `Error: tool \`${id}\` refused the call: `;
const WITHHELD = /^Error: tool `[a-z_]+` failed with [A-Za-z]+ \[ref err_test\]\. The error text was withheld from the model;/;

async function throughHostBridge(
  tool: ToolDescriptor<unknown, unknown>,
  input: unknown,
): Promise<string> {
  try {
    const result = await tool.run(input);
    return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  } catch (err) {
    if (
      err instanceof Error &&
      err.name === 'ToolRefusalError' &&
      !LINE_BREAK.test(err.message)
    ) {
      const cleaned = err.message.replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim();
      if (cleaned.length > 0) {
        const text =
          cleaned.length > HOST_MAX_REFUSAL_CHARS
            ? `${cleaned.slice(0, HOST_MAX_REFUSAL_CHARS - 1)}…`
            : cleaned;
        return REFUSED(tool.id) + text;
      }
    }
    const name = err instanceof Error && /^[A-Za-z][A-Za-z0-9_$.]{0,63}$/.test(err.name) ? err.name : 'Error';
    return (
      `Error: tool \`${tool.id}\` failed with ${name} [ref err_test]. The error text was ` +
      'withheld from the model; an operator can find it in the server log under this ref. ' +
      'The outcome is unknown, so do not repeat a call that changes data.'
    );
  }
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

function setup(
  options: Parameters<typeof createMockLinear>[0] = {},
  storeOptions: { now?: () => number; ttlMs?: number } = {},
  override: Partial<LinearClient> = {},
): {
  toolkit: Toolkit;
  mock: ReturnType<typeof createMockLinear>;
  store: ReturnType<typeof createPreparedWriteStore>;
  turns: Turns;
} {
  const mock = createMockLinear(options);
  const store = createPreparedWriteStore(storeOptions);
  const turns = createTurns();
  const toolkit = createToolkit({
    client: { ...mock.client, ...override },
    defaultTeamKey: 'OMA',
    log: createLog().log,
    writeMode: 'confirm',
    caller: turns.caller,
    store,
  });
  return { toolkit, mock, store, turns };
}

async function call(toolkit: Toolkit, id: string, input: unknown): Promise<string> {
  const tool = toolkit.tools.find((t) => t.id === id);
  assert.ok(tool, `no tool '${id}' in the toolkit`);
  return throughHostBridge(tool, input);
}

/** The refusal message as the model reads it, with the host's framing removed. */
async function refusal(toolkit: Toolkit, id: string, input: unknown): Promise<string> {
  const text = await call(toolkit, id, input);
  assert.ok(
    text.startsWith(REFUSED(id)),
    `expected a refusal the model can read, got: ${text.slice(0, 200)}`,
  );
  return text.slice(REFUSED(id).length);
}

/** Stage a write in the current turn. */
async function prepare(toolkit: Toolkit, input: unknown): Promise<void> {
  const tool = toolkit.tools.find((t) => t.id === 'linear_prepare_write');
  assert.ok(tool);
  await tool.run(input);
}

/** An error as the Linear connection throws it. The connection is a separate
 *  bundle, so all this package ever sees of its classes is the name. */
function connectionError(name: string, message: string, extra: object = {}): Error {
  return Object.assign(new Error(message), { name, status: 400 }, extra);
}

function manyUsers(count: number): LinearUser[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `user-${String(i)}`,
    name: `Workspace Member Number ${String(i)}`,
    displayName: `member-with-a-long-handle-${String(i)}`,
    email: `member${String(i)}@example.com`,
    active: true,
  }));
}

function manyLabels(count: number): LinearLabel[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `label-${String(i)}`,
    name: `area/subsystem-${String(i)}-with-a-descriptive-name`,
    teamId: TEAM_OMA.id,
  }));
}

function assertPassable(message: string): void {
  assert.ok(!LINE_BREAK.test(message), 'a refusal with a line break is withheld by the host');
  assert.ok(
    message.length <= HOST_MAX_REFUSAL_CHARS,
    `refusal is ${String(message.length)} chars, the host cuts at ${String(HOST_MAX_REFUSAL_CHARS)}`,
  );
  assert.ok(!message.endsWith('…'), 'the refusal was cut and lost its ending');
}

// ---------------------------------------------------------------------------
// what the model reads
// ---------------------------------------------------------------------------

describe('refusals reach the model as readable text', () => {
  it('an unknown state name lists the states the team has', async () => {
    const { toolkit, mock } = setup();
    const text = await refusal(toolkit, 'linear_prepare_write', {
      kind: 'update_issue',
      issueKey: 'OMA-7',
      stateName: 'Closed',
    });
    assert.equal(
      text,
      "Team OMA has no workflow state matching 'Closed'. Its states are: Backlog (backlog), " +
        'Todo (unstarted), In Progress (started), Done (completed).',
    );
    assert.deepEqual(mock.mutations(), []);
  });

  it('an ambiguous person lists the candidates', async () => {
    const { toolkit } = setup();
    const text = await refusal(toolkit, 'linear_prepare_write', {
      kind: 'update_issue',
      issueKey: 'OMA-7',
      assignee: 'Kim',
    });
    assert.equal(
      text,
      "'Kim' matches several people: kimlee (Kim Lee), kimpark (Kim Park). Use a full name.",
    );
  });

  it('an unknown person on a search is a refusal too', async () => {
    const { toolkit } = setup();
    const text = await refusal(toolkit, 'linear_search_issues', { assignee: 'Nobody Here' });
    assert.match(text, /^No active workspace member matches 'Nobody Here'\. Members: andre, /);
  });

  it('an unknown label lists the labels the team has', async () => {
    const { toolkit } = setup();
    const text = await refusal(toolkit, 'linear_prepare_write', {
      kind: 'create_issue',
      title: 'x',
      labels: ['regression'],
    });
    assert.equal(
      text,
      "Team OMA has no label matching 'regression'. Available labels: bug, mobile, needs-triage.",
    );
  });

  it('an unknown team lists the team keys', async () => {
    const { toolkit } = setup();
    const text = await refusal(toolkit, 'linear_lookup', { kind: 'states', teamKey: 'NOPE' });
    assert.equal(text, "No team with key 'NOPE'. Known team keys: OMA, WEB.");
  });

  it('a missing issue says so on a read', async () => {
    const { toolkit } = setup();
    const text = await refusal(toolkit, 'linear_get_issue', { key: 'OMA-999' });
    assert.equal(text, "No issue 'OMA-999'. Check the key, or search for the issue by title first.");
  });

  it('a missing issue says nothing was written on a write', async () => {
    const { toolkit, store } = setup();
    const text = await refusal(toolkit, 'linear_prepare_write', {
      kind: 'add_comment',
      issueKey: 'OMA-999',
      body: 'hello',
    });
    assert.match(text, /^No issue 'OMA-999'\. Nothing was written\./);
    assert.equal(store.size(), 0);
  });

  it('a field of the wrong write kind names the field and the allowed ones', async () => {
    const { toolkit } = setup();
    const text = await refusal(toolkit, 'linear_prepare_write', {
      kind: 'add_comment',
      issueKey: 'OMA-7',
      body: 'hello',
      stateName: 'Done',
    });
    assert.equal(text, 'add_comment does not take stateName. Allowed fields: issueKey, body.');
  });

  it('a change that changes nothing says so', async () => {
    const { toolkit, store } = setup();
    const text = await refusal(toolkit, 'linear_prepare_write', {
      kind: 'update_issue',
      issueKey: 'OMA-7',
      priority: 3,
    });
    assert.match(text, /^OMA-7 already matches every value you gave \(priority: Medium\)\./);
    assert.match(text, /nothing was written\.$/);
    assert.equal(store.size(), 0);
  });

  it('a commit with nothing prepared tells the model to prepare again', async () => {
    const { toolkit, mock } = setup();
    const text = await refusal(toolkit, 'linear_commit_write', {});
    assert.match(text, /^No change is waiting for confirmation in this conversation/);
    assert.match(text, /Nothing was written\. Call linear_prepare_write again/);
    assert.match(text, /commit only after the user confirms it\.$/);
    assertPassable(text);
    assert.deepEqual(mock.mutations(), []);
  });

  it('an expired change says it expired and that nothing was written', async () => {
    let t = 1_000_000;
    const { toolkit, mock, turns } = setup({}, { now: () => t, ttlMs: 10 * 60_000 });
    await prepare(toolkit, { kind: 'add_comment', issueKey: 'OMA-7', body: 'late' });

    t += 12 * 60_000;
    turns.next();

    const text = await refusal(toolkit, 'linear_commit_write', {});
    assert.match(text, /expired 2 minute\(s\) ago \(previews are valid for 10 minutes\)/);
    assert.match(text, /Nothing was written\. Prepare the change again/);
    assert.deepEqual(mock.mutations(), []);
  });

  it('a change committed twice is refused the second time', async () => {
    const { toolkit, mock, turns } = setup();
    await prepare(toolkit, { kind: 'add_comment', issueKey: 'OMA-7', body: 'once' });
    turns.next();

    assert.match(await call(toolkit, 'linear_commit_write', {}), /"committed": true/);
    const text = await refusal(toolkit, 'linear_commit_write', {});

    assert.match(text, /already committed/);
    assert.equal(mock.mutations().length, 1);
  });

  it('a commit in the turn that prepared says why, and what to do', async () => {
    const { toolkit, mock, store } = setup();
    await prepare(toolkit, { kind: 'add_comment', issueKey: 'OMA-7', body: 'note' });

    const text = await refusal(toolkit, 'linear_commit_write', {});

    assert.equal(
      text,
      'This change was prepared in this same turn, so the user has not seen its preview yet. ' +
        'Nothing was written. Show the user the preview and end your turn; commit when the user ' +
        'has confirmed it in a later message.',
    );
    assert.deepEqual(mock.mutations(), []);
    assert.ok(store.peek(CONVERSATION), 'the change must still wait for the next turn');
  });

  it('a second change in one turn names the one already waiting', async () => {
    const { toolkit } = setup();
    await prepare(toolkit, { kind: 'add_comment', issueKey: 'OMA-7', body: 'first' });

    const text = await refusal(toolkit, 'linear_prepare_write', {
      kind: 'create_issue',
      title: 'second',
    });

    assert.match(text, /^A change is already waiting for the user's confirmation \('Comment on OMA-7 /);
    assert.match(text, /Nothing new was prepared\. One change per confirmation:/);
    assert.match(text, /prepare the next one once this one is committed\.$/);
    assertPassable(text);
  });

  it('a call outside any conversation says that it cannot be confirmed there', async () => {
    const { toolkit, turns } = setup();
    turns.leave();

    for (const [id, input] of [
      ['linear_prepare_write', { kind: 'create_issue', title: 'x' }],
      ['linear_commit_write', {}],
    ] satisfies [string, unknown][]) {
      const text = await refusal(toolkit, id, input);
      assert.match(text, /^This call belongs to no conversation/);
      assert.match(text, /Nothing was written\./);
      assert.match(text, /write mode to apply changes without one\.$/);
      assertPassable(text);
    }
  });

  it('a misspelt field is a refusal that names it', async () => {
    const { toolkit } = setup();
    const text = await call(toolkit, 'linear_prepare_write', {
      kind: 'update_issue',
      issueKey: 'OMA-7',
      state: 'Done',
    });
    assert.match(
      text,
      /^Error: tool `linear_prepare_write` refused the call: Invalid input — <root>: Unrecognized key: "state"\. Nothing was read or written; correct the call and send it again\.$/,
    );
  });
});

// ---------------------------------------------------------------------------
// the form the host passes on: one line, at most 600 characters
// ---------------------------------------------------------------------------

describe('a refusal always fits what the host passes on', () => {
  it('every error this package writes for the model carries the refusal name', () => {
    for (const err of [
      new LinearAgentError('a'),
      new LinearLookupError('b'),
      new PreparedWriteError('c'),
    ]) {
      assert.equal(err.name, TOOL_REFUSAL_ERROR_NAME);
      assert.equal(err.name, 'ToolRefusalError');
      assert.ok(err instanceof LinearAgentError);
      assert.ok(err instanceof Error);
    }
  });

  it('keeps the class apart for callers that need to tell the kinds', () => {
    assert.ok(!(new LinearLookupError('x') instanceof PreparedWriteError));
    assert.ok(!(new PreparedWriteError('x') instanceof LinearLookupError));
  });

  it('folds line breaks and control characters into one line', () => {
    const err = new LinearAgentError('first line\nsecond\r\nthird\ttabbed\u0007 end');
    assert.equal(err.message, 'first line second third tabbed end');
    assert.equal(
      toRefusalText(`a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c`),
      'a b c',
    );
  });

  it('cuts a message that is too long rather than exceeding the limit', () => {
    const err = new LinearAgentError('x'.repeat(2_000));
    assert.equal(err.message.length, MAX_REFUSAL_CHARS);
    assert.ok(err.message.endsWith('…'));
    assert.equal(MAX_REFUSAL_CHARS, HOST_MAX_REFUSAL_CHARS);
  });

  it('quotes caller text back on one line and bounded', () => {
    assert.equal(quoted('  Done\n(deployed) '), 'Done (deployed)');
    assert.equal(quoted('y'.repeat(300)).length, 81);
    assert.equal(quoted('abcdef', 3), 'abc…');
  });

  it('a candidate list is bounded by characters and says what it left out', () => {
    assert.equal(listOf([]), '(none)');
    assert.equal(listOf(['a', 'b']), 'a, b');

    const long = listOf(Array.from({ length: 400 }, (_, i) => `candidate-number-${String(i)}`));
    assert.ok(long.length <= 340, `list is ${String(long.length)} chars`);
    assert.match(long, /^candidate-number-0, candidate-number-1, /);
    assert.match(long, /, … \(400 in total, linear_lookup lists them all\)$/);

    assert.equal(
      listOf(['z'.repeat(500), 'short']),
      '… (2 in total, linear_lookup lists them all)',
    );
  });

  it('no match in a 400-member workspace stays complete', async () => {
    const { toolkit } = setup({ users: [VIEWER, ...manyUsers(400)] });
    const text = await refusal(toolkit, 'linear_prepare_write', {
      kind: 'update_issue',
      issueKey: 'OMA-7',
      assignee: 'Zaphod',
    });
    assertPassable(text);
    assert.match(text, /^No active workspace member matches 'Zaphod'\. Members: andre, /);
    assert.match(text, /\(401 in total, linear_lookup lists them all\)\.$/);
  });

  it('an ambiguous name among 400 members stays complete', async () => {
    const { toolkit } = setup({ users: manyUsers(400) });
    const text = await refusal(toolkit, 'linear_prepare_write', {
      kind: 'update_issue',
      issueKey: 'OMA-7',
      assignee: 'member',
    });
    assertPassable(text);
    assert.match(text, /^'member' matches several people: /);
    assert.match(text, /\(400 in total, linear_lookup lists them all\)\. Use a full name\.$/);
  });

  it('no match among 300 labels stays complete', async () => {
    const { toolkit } = setup({ labels: [LABEL_BUG, ...manyLabels(300)] });
    const text = await refusal(toolkit, 'linear_prepare_write', {
      kind: 'create_issue',
      title: 'x',
      labels: ['does-not-exist'],
    });
    assertPassable(text);
    assert.match(text, /\(301 in total, linear_lookup lists them all\)\.$/);
  });

  it('a name with a line break and the longest allowed length still gets its answer', async () => {
    const { toolkit } = setup({ users: manyUsers(400) });
    const text = await refusal(toolkit, 'linear_prepare_write', {
      kind: 'update_issue',
      issueKey: 'OMA-7',
      assignee: `Zaphod\nBeeblebrox ${'x'.repeat(180)}`,
    });
    assertPassable(text);
    assert.match(text, /^No active workspace member matches 'Zaphod Beeblebrox x+…'\. Members: /);
    assert.match(text, /lists them all\)\.$/);
  });

  it('a long preview does not push the instruction out of the "already waiting" refusal', async () => {
    const { toolkit } = setup();
    await prepare(toolkit, { kind: 'add_comment', issueKey: 'OMA-7', body: 'x'.repeat(5_000) });

    const text = await refusal(toolkit, 'linear_prepare_write', {
      kind: 'create_issue',
      title: 'second',
    });
    assertPassable(text);
    assert.match(text, /prepare the next one once this one is committed\.$/);
  });

  it('a no-op naming every field of a long issue stays complete', async () => {
    const issue = makeIssue({
      title: 'A very long title that goes on and on '.repeat(6).trim(),
      description: 'unchanged',
      labels: ['bug', 'mobile'],
    });
    const { toolkit } = setup({ issues: [issue] });
    const text = await refusal(toolkit, 'linear_prepare_write', {
      kind: 'update_issue',
      issueKey: issue.identifier,
      title: issue.title,
      description: 'unchanged',
      stateName: issue.state.name,
      priority: issue.priority,
      labels: ['bug', 'mobile'],
    });
    assertPassable(text);
    assert.match(text, /There is nothing to change, so nothing was written\.$/);
  });
});

// ---------------------------------------------------------------------------
// failures of the connection
// ---------------------------------------------------------------------------

describe('connection failures', () => {
  for (const name of ['LinearGraphQLError', 'LinearApiError']) {
    it(`${name} on a read stays withheld`, async () => {
      const secret = 'upstream said: token lin_api_abc for jane@example.com is invalid';
      const { toolkit } = setup({}, {}, {
        async searchIssues() {
          throw connectionError(name, secret);
        },
      });
      const text = await call(toolkit, 'linear_search_issues', {});
      assert.match(text, WITHHELD);
      assert.ok(text.includes(name));
      assert.ok(!text.includes('upstream said'), 'the connection error text reached the model');
    });
  }

  it('a failed mutation stays withheld, with the outcome reported as unknown', async () => {
    const { toolkit, turns } = setup({}, {}, {
      async addComment() {
        throw connectionError('LinearMutationError', 'commentCreate returned success: false');
      },
    });
    await prepare(toolkit, { kind: 'add_comment', issueKey: 'OMA-7', body: 'x' });
    turns.next();
    const text = await call(toolkit, 'linear_commit_write', {});
    assert.match(text, WITHHELD);
    assert.match(text, /The outcome is unknown/);
    assert.ok(!text.includes('success: false'));
  });

  it('a rate limit on a read is a refusal that carries none of the response', async () => {
    const { toolkit } = setup({}, {}, {
      async searchIssues() {
        throw connectionError('LinearRateLimitError', 'RATELIMITED: {"errors":[{"body":"raw"}]}', {
          resetAt: new Date('2026-11-12T15:30:00.000Z'),
        });
      },
    });
    const text = await refusal(toolkit, 'linear_search_issues', {});
    assert.equal(
      text,
      'Linear is rate-limiting this API key, so the request was turned away. The limit resets at ' +
        '2026-11-12T15:30:00.000Z. Nothing was read. Tell the user, and try again later.',
    );
  });

  it('a rate limit without a reset time leaves the time out', async () => {
    const { toolkit } = setup({}, {}, {
      async getIssue() {
        throw connectionError('LinearRateLimitError', 'RATELIMITED', {
          resetAt: new Date(Number.NaN),
        });
      },
    });
    const text = await refusal(toolkit, 'linear_get_issue', { key: 'OMA-7' });
    assert.equal(
      text,
      'Linear is rate-limiting this API key, so the request was turned away. Nothing was read. ' +
        'Tell the user, and try again later.',
    );
  });

  it('a rate limit while preparing says nothing was prepared', async () => {
    const { toolkit, store } = setup({}, {}, {
      async workflowStates() {
        throw connectionError('LinearRateLimitError', 'RATELIMITED');
      },
    });
    const text = await refusal(toolkit, 'linear_prepare_write', {
      kind: 'update_issue',
      issueKey: 'OMA-7',
      stateName: 'Done',
    });
    assert.match(text, /Nothing was prepared\. Tell the user, and prepare the change again later\.$/);
    assert.equal(store.size(), 0);
  });

  it('a rate limit on commit says the prepared change is used up, and it is', async () => {
    const { toolkit, store, turns } = setup({}, {}, {
      async addComment() {
        throw connectionError('LinearRateLimitError', 'RATELIMITED', {
          resetAt: new Date('2026-11-12T15:30:00.000Z'),
        });
      },
    });
    await prepare(toolkit, { kind: 'add_comment', issueKey: 'OMA-7', body: 'x' });
    turns.next();

    const text = await refusal(toolkit, 'linear_commit_write', {});
    assert.match(text, /Nothing was written, and the prepared change is used up\./);
    assert.match(text, /prepare the change again later and ask for a new confirmation\.$/);
    assertPassable(text);

    assert.equal(store.peek(CONVERSATION), undefined);
    assert.match(await refusal(toolkit, 'linear_commit_write', {}), /^No change is waiting/);
  });

  it('a rejected key on a read is a refusal that carries none of the response', async () => {
    const { toolkit } = setup({}, {}, {
      async searchIssues() {
        throw connectionError('LinearAuthError', 'upstream said: token lin_api_abc is invalid');
      },
    });
    const text = await refusal(toolkit, 'linear_search_issues', {});
    assert.equal(
      text,
      'Linear rejected the API key of the Linear connection, so the request was turned away. ' +
        'Nothing was read. Do not retry: tell the user that an operator has to replace the key in ' +
        "the Linear connection's settings.",
    );
    assertPassable(text);
  });

  it('a rejected key on commit says the prepared change is used up, and it is', async () => {
    const { toolkit, store, turns } = setup({}, {}, {
      async addComment() {
        throw connectionError('LinearAuthError', 'Authentication required');
      },
    });
    await prepare(toolkit, { kind: 'add_comment', issueKey: 'OMA-7', body: 'x' });
    turns.next();

    const text = await refusal(toolkit, 'linear_commit_write', {});
    assert.match(text, /^Linear rejected the API key.*Nothing was written, and the prepared change is used up\. Do not retry/);
    assert.ok(!text.includes('Authentication required'));
    assert.equal(store.peek(CONVERSATION), undefined);
  });

  it('only a rate limit and a rejected key are turned into a refusal', () => {
    const turnedAway = { outcome: 'x', later: 'y' };
    assert.equal(connectionRefusal(connectionError('LinearGraphQLError', 'x'), turnedAway), undefined);
    assert.equal(connectionRefusal(new Error('LinearRateLimitError'), turnedAway), undefined);
    assert.equal(connectionRefusal('LinearAuthError', turnedAway), undefined);
    for (const name of ['LinearRateLimitError', 'LinearAuthError']) {
      assert.ok(connectionRefusal(connectionError(name, 'x'), turnedAway) instanceof LinearAgentError);
    }
  });
});

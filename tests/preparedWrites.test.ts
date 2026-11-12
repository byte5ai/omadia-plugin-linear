import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { Caller } from '../src/caller.js';
import { LinearAgentError } from '../src/errors.js';
import {
  createPreparedWriteStore,
  EXPIRED_WRITE_KEPT_MS,
  PREPARED_WRITE_TTL_MS,
  PreparedWriteError,
  type PreparedWrite,
} from '../src/preparedWrites.js';

/**
 * The store is the write gate of the confirmation mode. Its promises are that
 * a staged write is inert, that it belongs to one conversation, that it cannot
 * be committed in the turn that staged it, that it applies once, and that it
 * dies of old age. Those are what is tested, with an injected clock rather
 * than a sleeping test.
 */

const WRITE: PreparedWrite = {
  kind: 'add_comment',
  issueId: 'issue-7',
  issueKey: 'OMA-7',
  issueTitle: 'Login fails on Safari',
  body: 'On staging now.',
};

const TURN_1: Caller = { conversation: 'a', turn: 'turn-1' };
const TURN_2: Caller = { conversation: 'a', turn: 'turn-2' };
const ELSEWHERE: Caller = { conversation: 'b', turn: 'turn-9' };

function fixedClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

function refuses(run: () => unknown, pattern: RegExp): void {
  assert.throws(run, (err: unknown) => {
    assert.ok(err instanceof PreparedWriteError);
    assert.match(err.message, pattern);
    return true;
  });
}

describe('createPreparedWriteStore', () => {
  it('stages a write with its preview, its expiry and the turn it came from', () => {
    const clock = fixedClock();
    const store = createPreparedWriteStore({ now: clock.now });

    const entry = store.stage(TURN_1, WRITE, 'the preview');

    assert.deepEqual(entry, {
      write: WRITE,
      preview: 'the preview',
      expiresAt: clock.now() + PREPARED_WRITE_TTL_MS,
      preparedInTurn: 'turn-1',
    });
    assert.equal(store.size(), 1);
  });

  it('defaults to a ten-minute TTL', () => {
    assert.equal(PREPARED_WRITE_TTL_MS, 10 * 60 * 1000);
  });

  it('keeps one write per conversation', () => {
    const store = createPreparedWriteStore();
    store.stage(TURN_1, WRITE, 'a');
    store.stage(ELSEWHERE, WRITE, 'b');

    assert.equal(store.size(), 2);
    assert.equal(store.peek('a')?.preview, 'a');
    assert.equal(store.peek('b')?.preview, 'b');
  });

  it('refuses a second write in the same turn and keeps the first', () => {
    const store = createPreparedWriteStore();
    store.stage(TURN_1, WRITE, 'OMA-7: Todo → Done');

    refuses(
      () => store.stage(TURN_1, WRITE, 'another'),
      /already waiting for the user's confirmation \('OMA-7: Todo → Done'\).*Nothing new was prepared/s,
    );
    assert.equal(store.peek('a')?.preview, 'OMA-7: Todo → Done');
  });

  it('lets a later turn replace the write that was waiting', () => {
    const store = createPreparedWriteStore();
    store.stage(TURN_1, WRITE, 'declined');
    store.stage(TURN_2, WRITE, 'changed');

    assert.equal(store.size(), 1);
    assert.equal(store.peek('a')?.preview, 'changed');
    assert.equal(store.peek('a')?.preparedInTurn, 'turn-2');
  });

  it('returns the staged entry to a later turn of the same conversation', () => {
    const store = createPreparedWriteStore();
    const entry = store.stage(TURN_1, WRITE, 'the preview');

    assert.deepEqual(store.take(TURN_2), entry);
    assert.equal(store.size(), 0);
  });

  it('refuses the turn that staged the write, and keeps it for the next', () => {
    const store = createPreparedWriteStore();
    store.stage(TURN_1, WRITE, 'the preview');

    refuses(() => store.take(TURN_1), /prepared in this same turn.*Nothing was written/s);
    assert.equal(store.size(), 1);
    assert.equal(store.take(TURN_2).preview, 'the preview');
  });

  it('answers another conversation as if nothing were staged', () => {
    const store = createPreparedWriteStore();
    store.stage(TURN_1, WRITE, 'the preview');

    refuses(() => store.take(ELSEWHERE), /No change is waiting for confirmation/);
    assert.equal(store.size(), 1);
  });

  it('lets a write be taken exactly once', () => {
    const store = createPreparedWriteStore();
    store.stage(TURN_1, WRITE, 'the preview');

    store.take(TURN_2);

    refuses(() => store.take(TURN_2), /already committed/);
    assert.equal(store.size(), 0);
  });

  it('says what to do when nothing is staged', () => {
    const store = createPreparedWriteStore();
    refuses(
      () => store.take(TURN_1),
      /No change is waiting.*linear_prepare_write.*after the user confirms/s,
    );
  });

  it('rejects a write past its TTL and names the age', () => {
    const clock = fixedClock();
    const store = createPreparedWriteStore({ now: clock.now, ttlMs: 60_000 });
    store.stage(TURN_1, WRITE, 'the preview');

    clock.advance(60_000);

    refuses(() => store.take(TURN_2), /expired less than a minute ago.*Nothing was written/s);
    assert.equal(store.size(), 0);
  });

  it('reports expiry before the same-turn rule, since an expired write is gone either way', () => {
    const clock = fixedClock();
    const store = createPreparedWriteStore({ now: clock.now, ttlMs: 60_000 });
    store.stage(TURN_1, WRITE, 'the preview');

    clock.advance(180_000);

    refuses(() => store.take(TURN_1), /expired 2 minute\(s\) ago/);
  });

  it('accepts a write right up to its expiry', () => {
    const clock = fixedClock();
    const store = createPreparedWriteStore({ now: clock.now, ttlMs: 60_000 });
    store.stage(TURN_1, WRITE, 'the preview');

    clock.advance(59_999);

    assert.equal(store.take(TURN_2).preview, 'the preview');
  });

  it('lets an expired write be replaced in the turn that staged it', () => {
    // The same-turn refusal protects a preview somebody may still confirm. An
    // expired one protects nothing.
    const clock = fixedClock();
    const store = createPreparedWriteStore({ now: clock.now, ttlMs: 60_000 });
    store.stage(TURN_1, WRITE, 'old');

    clock.advance(60_001);
    store.stage(TURN_1, WRITE, 'new');

    assert.equal(store.peek('a')?.preview, 'new');
  });

  it('is a LinearAgentError, so a tool reports it as a refusal', () => {
    const store = createPreparedWriteStore();
    assert.throws(() => store.take(TURN_1), LinearAgentError);
  });

  it('does not report an expired entry through peek', () => {
    const clock = fixedClock();
    const store = createPreparedWriteStore({ now: clock.now, ttlMs: 60_000 });
    store.stage(TURN_1, WRITE, 'the preview');

    assert.ok(store.peek('a'));
    clock.advance(60_001);
    assert.equal(store.peek('a'), undefined);
  });

  it('sweeps entries long past their expiry and leaves live ones', () => {
    const clock = fixedClock();
    const store = createPreparedWriteStore({ now: clock.now, ttlMs: 60_000, expiredKeptMs: 120_000 });
    store.stage(TURN_1, WRITE, 'old');

    clock.advance(30_000);
    store.stage(ELSEWHERE, WRITE, 'fresh');
    clock.advance(30_001);

    assert.equal(store.sweep(), 0, 'just expired: kept to answer a late yes');
    assert.equal(store.size(), 1, 'size counts live entries only');

    clock.advance(120_000);
    assert.equal(store.sweep(), 1);
    assert.equal(store.size(), 0);
  });

  it('tells a late yes that its write expired, after another conversation prepared one', () => {
    // A prepare anywhere sweeps. It must not erase the expired entry of a
    // conversation whose user is about to answer.
    const clock = fixedClock();
    const store = createPreparedWriteStore({ now: clock.now, ttlMs: 60_000 });
    store.stage(TURN_1, WRITE, 'mine');

    clock.advance(6 * 60_000);
    store.stage(ELSEWHERE, WRITE, 'theirs');
    clock.advance(20 * 60_000);

    refuses(() => store.take(TURN_2), /expired 25 minute\(s\) ago.*Nothing was written/s);
    refuses(() => store.take(TURN_2), /No change is waiting/);
  });

  it('names an old expiry in hours', () => {
    const clock = fixedClock();
    const store = createPreparedWriteStore({ now: clock.now, ttlMs: 60_000 });
    store.stage(TURN_1, WRITE, 'mine');

    clock.advance(60_000 + 5 * 60 * 60_000);

    refuses(() => store.take(TURN_2), /expired 5 hour\(s\) ago/);
  });

  it('forgets an expired write after a day', () => {
    const clock = fixedClock();
    const store = createPreparedWriteStore({ now: clock.now, ttlMs: 60_000 });
    store.stage(TURN_1, WRITE, 'mine');

    clock.advance(60_000 + EXPIRED_WRITE_KEPT_MS);
    store.stage(ELSEWHERE, WRITE, 'theirs');

    refuses(() => store.take(TURN_2), /No change is waiting.*expired more than a day ago/s);
  });

  it('drops everything on clear, so nothing outlives a deactivate', () => {
    const store = createPreparedWriteStore();
    store.stage(TURN_1, WRITE, 'the preview');

    store.clear();

    assert.equal(store.size(), 0);
    refuses(() => store.take(TURN_2), /No change is waiting/);
  });
});

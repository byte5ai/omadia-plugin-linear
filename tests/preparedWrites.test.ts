import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { LinearAgentError } from '../src/errors.js';
import {
  createPreparedWriteStore,
  PREPARED_WRITE_TTL_MS,
  PreparedWriteError,
  type PreparedWrite,
} from '../src/preparedWrites.js';

/**
 * The store is the write gate. Its three promises are that a staged write is
 * inert, that a token applies once, and that a token dies of old age — so those
 * are what is tested, with an injected clock rather than a sleeping test.
 */

const WRITE: PreparedWrite = {
  kind: 'add_comment',
  issueId: 'issue-7',
  issueKey: 'OMA-7',
  issueTitle: 'Login fails on Safari',
  body: 'On staging now.',
};

function fixedClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

describe('createPreparedWriteStore', () => {
  it('stages a write and hands back a token, a preview and an expiry', () => {
    const clock = fixedClock();
    const store = createPreparedWriteStore({ now: clock.now });

    const entry = store.stage(WRITE, 'the preview');

    assert.ok(entry.token.length >= 8, 'token should be long enough to be unguessable');
    assert.equal(entry.preview, 'the preview');
    assert.equal(entry.expiresAt, clock.now() + PREPARED_WRITE_TTL_MS);
    assert.deepEqual(entry.write, WRITE);
    assert.equal(store.size(), 1);
  });

  it('defaults to a ten-minute TTL', () => {
    assert.equal(PREPARED_WRITE_TTL_MS, 10 * 60 * 1000);
  });

  it('gives every staged write its own token', () => {
    const store = createPreparedWriteStore();
    const a = store.stage(WRITE, 'a');
    const b = store.stage(WRITE, 'b');
    assert.notEqual(a.token, b.token);
    assert.equal(store.size(), 2);
  });

  it('returns the staged entry on take', () => {
    const store = createPreparedWriteStore();
    const entry = store.stage(WRITE, 'the preview');
    const taken = store.take(entry.token);
    assert.equal(taken.token, entry.token);
    assert.deepEqual(taken.write, WRITE);
  });

  it('lets a token be taken exactly once', () => {
    const store = createPreparedWriteStore();
    const { token } = store.stage(WRITE, 'the preview');

    store.take(token);

    assert.throws(
      () => store.take(token),
      (err: unknown) => {
        assert.ok(err instanceof PreparedWriteError);
        assert.match(err.message, /already committed/);
        return true;
      },
    );
    assert.equal(store.size(), 0);
  });

  it('rejects an unknown token with a message that says what to do', () => {
    const store = createPreparedWriteStore();
    assert.throws(
      () => store.take('not-a-token'),
      (err: unknown) => {
        assert.ok(err instanceof PreparedWriteError);
        assert.match(err.message, /unknown/);
        assert.match(err.message, /linear_prepare_write/);
        assert.match(err.message, /after the user confirms/);
        return true;
      },
    );
  });

  it('rejects a token past its TTL and names the age', () => {
    const clock = fixedClock();
    const store = createPreparedWriteStore({ now: clock.now, ttlMs: 60_000 });
    const { token } = store.stage(WRITE, 'the preview');

    clock.advance(60_000);

    assert.throws(
      () => store.take(token),
      (err: unknown) => {
        assert.ok(err instanceof PreparedWriteError);
        assert.match(err.message, /expired/);
        assert.match(err.message, /Nothing was written/);
        return true;
      },
    );
  });

  it('accepts a token right up to its expiry', () => {
    const clock = fixedClock();
    const store = createPreparedWriteStore({ now: clock.now, ttlMs: 60_000 });
    const { token } = store.stage(WRITE, 'the preview');

    clock.advance(59_999);

    assert.equal(store.take(token).token, token);
  });

  it('is a LinearAgentError, so a tool can report it as an instruction problem', () => {
    const store = createPreparedWriteStore();
    assert.throws(() => store.take('nope'), LinearAgentError);
  });

  it('does not report an expired entry through peek', () => {
    const clock = fixedClock();
    const store = createPreparedWriteStore({ now: clock.now, ttlMs: 60_000 });
    const { token } = store.stage(WRITE, 'the preview');

    assert.ok(store.peek(token));
    clock.advance(60_001);
    assert.equal(store.peek(token), undefined);
  });

  it('sweeps expired entries and leaves live ones', () => {
    const clock = fixedClock();
    const store = createPreparedWriteStore({ now: clock.now, ttlMs: 60_000 });
    store.stage(WRITE, 'old');

    clock.advance(30_000);
    const fresh = store.stage(WRITE, 'fresh');
    clock.advance(30_001);

    assert.equal(store.sweep(), 1);
    assert.equal(store.size(), 1);
    assert.ok(store.peek(fresh.token));
  });

  it('drops everything on clear, so nothing outlives a deactivate', () => {
    const store = createPreparedWriteStore();
    const { token } = store.stage(WRITE, 'the preview');

    store.clear();

    assert.equal(store.size(), 0);
    assert.throws(() => store.take(token), PreparedWriteError);
  });
});

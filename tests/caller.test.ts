import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createCallerReader, type TurnContextService } from '../src/caller.js';

/**
 * The caller is read from a host service this package does not control, so
 * the reader is tested against every shape that service can answer with. The
 * one thing it must never do is name a conversation that is not one: a
 * prepared write staged under a key several callers share could be confirmed
 * by the wrong one.
 */

function service(snapshot: Record<string, unknown> | undefined): TurnContextService {
  return { current: () => snapshot };
}

const TURN = {
  turnId: 'turn-1',
  sessionScope: 'chat-42',
  userId: 'user-7',
  agentSlug: 'fallback',
};

describe('createCallerReader', () => {
  it('names the conversation and the turn of the call in flight', () => {
    const caller = createCallerReader(service(TURN))();
    assert.ok(caller);
    assert.equal(caller.turn, 'turn-1');
    assert.equal(caller.conversation, '["fallback","user-7","chat-42"]');
  });

  it('asks the host again for every call', () => {
    let turnId = 'turn-1';
    const read = createCallerReader({ current: () => ({ ...TURN, turnId }) });
    assert.equal(read()?.turn, 'turn-1');
    turnId = 'turn-2';
    assert.equal(read()?.turn, 'turn-2');
  });

  it('keeps the conversation the same from one turn to the next', () => {
    const first = createCallerReader(service(TURN))();
    const second = createCallerReader(service({ ...TURN, turnId: 'turn-2' }))();
    assert.equal(first?.conversation, second?.conversation);
    assert.notEqual(first?.turn, second?.turn);
  });

  it('tells apart two users who share a session scope', () => {
    // Unscoped HTTP callers all carry the same literal session scope, so the
    // scope alone is not a conversation.
    const a = createCallerReader(service({ ...TURN, sessionScope: 'http-default' }))();
    const b = createCallerReader(
      service({ ...TURN, sessionScope: 'http-default', userId: 'user-8' }),
    )();
    assert.notEqual(a?.conversation, b?.conversation);
  });

  it('tells apart two agents serving the same user and session', () => {
    const a = createCallerReader(service(TURN))();
    const b = createCallerReader(service({ ...TURN, agentSlug: 'support' }))();
    assert.notEqual(a?.conversation, b?.conversation);
  });

  it('cannot be made to collide by a separator inside a value', () => {
    const a = createCallerReader(service({ ...TURN, userId: 'u","x', sessionScope: 's' }))();
    const b = createCallerReader(service({ ...TURN, userId: 'u', sessionScope: 'x","s' }))();
    assert.notEqual(a?.conversation, b?.conversation);
  });

  it('still names a conversation when the host knows no user or agent', () => {
    const caller = createCallerReader(service({ turnId: 'turn-1', sessionScope: 'chat-42' }))();
    assert.equal(caller?.conversation, '[null,null,"chat-42"]');
  });

  for (const [why, value] of [
    ['the host publishes no turn context', undefined],
    ['the service has no current()', {}],
    ['the call runs outside a turn', service(undefined)],
    ['the turn has no session scope', service({ turnId: 'turn-1' })],
    ['the turn id is the placeholder of an outer scope', service({ turnId: '', sessionScope: 'chat-42' })],
    [
      'the session scope is the turn id, as for a channel that names no conversation',
      service({ turnId: 'turn-1', sessionScope: 'turn-1' }),
    ],
    ['the values are not strings', service({ turnId: 7, sessionScope: { id: 1 } })],
    [
      'the service throws',
      {
        current: () => {
          throw new Error('no store');
        },
      },
    ],
  ] satisfies [string, unknown][]) {
    it(`answers with no caller when ${why}`, () => {
      assert.equal(createCallerReader(coerce(value))(), undefined);
    });
  }
});

/** Hands a value of any shape to the reader, the way a host of another
 *  version would: unchecked. */
function coerce(value: unknown): TurnContextService | undefined {
  return isService(value) ? value : undefined;
}

function isService(_value: unknown): _value is TurnContextService {
  return _value !== undefined;
}

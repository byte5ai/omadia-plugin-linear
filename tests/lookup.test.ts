import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { LinearClient } from '@omadia/integration-linear';

import {
  createLinearLookups,
  LinearLookupError,
  LOOKUP_CACHE_TTL_MS,
  matchByName,
} from '../src/lookup.js';
import {
  createMockLinear,
  LABEL_BUG,
  LABEL_MOBILE,
  STATE_DONE,
  STATE_DONE_DEPLOY,
  STATE_TODO,
  TEAM_OMA,
  USER_KIM_LEE,
  USER_KIM_PARK,
  VIEWER,
} from './fixtures.js';

/**
 * The lookup layer is where a rate budget is either respected or spent, and
 * where an ambiguous instruction is either surfaced or guessed at. Both are
 * invisible from the outside until they bite, so they are pinned here.
 */

function lookups(
  options: Parameters<typeof createMockLinear>[0] = {},
  clock?: () => number,
): { lookups: ReturnType<typeof createLinearLookups>; mock: ReturnType<typeof createMockLinear> } {
  const mock = createMockLinear(options);
  return {
    lookups: createLinearLookups({
      client: mock.client,
      defaultTeamKey: 'oma',
      ...(clock === undefined ? {} : { now: clock }),
    }),
    mock,
  };
}

describe('matchByName', () => {
  it('prefers an exact match over a longer name that contains it', () => {
    const items = [{ name: 'Done' }, { name: 'Done (deployed)' }];
    assert.deepEqual(matchByName(items, 'Done', (i) => [i.name]), [{ name: 'Done' }]);
  });

  it('falls back to substring when nothing matches exactly', () => {
    const items = [{ name: 'In Progress' }];
    assert.deepEqual(matchByName(items, 'progress', (i) => [i.name]), items);
  });

  it('returns every candidate when a substring matches more than one', () => {
    const items = [{ name: 'In Review' }, { name: 'In Progress' }];
    assert.equal(matchByName(items, 'in ', (i) => [i.name]).length, 2);
  });

  it('matches nothing for an empty needle rather than everything', () => {
    assert.deepEqual(matchByName([{ name: 'Done' }], '   ', (i) => [i.name]), []);
  });
});

describe('team', () => {
  it('uppercases and trims the configured default', async () => {
    const { lookups: l } = lookups();
    assert.equal((await l.team()).key, 'OMA');
    assert.equal(l.defaultTeamKey, 'OMA');
  });

  it('accepts a case-insensitive explicit key', async () => {
    const { lookups: l } = lookups();
    assert.equal((await l.team('web')).key, 'WEB');
  });

  it('lists the known keys when the key is wrong', async () => {
    const { lookups: l } = lookups();
    await assert.rejects(l.team('NOPE'), LinearLookupError);
  });
});

describe('user', () => {
  it('resolves "me" to the key owner without a member lookup', async () => {
    const { lookups: l, mock } = lookups();
    assert.equal((await l.user('me')).id, VIEWER.id);
    assert.deepEqual(mock.callsTo('users'), []);
  });

  it('matches on name, display name or e-mail', async () => {
    const { lookups: l } = lookups({ users: [VIEWER] });
    assert.equal((await l.user('Andre Derjagin')).id, VIEWER.id);
    assert.equal((await l.user('andre')).id, VIEWER.id);
    assert.equal((await l.user('andre@example.com')).id, VIEWER.id);
  });

  it('refuses an ambiguous first name and names the candidates', async () => {
    const { lookups: l } = lookups({ users: [USER_KIM_LEE, USER_KIM_PARK] });
    await assert.rejects(l.user('Kim'), (err: unknown) => {
      assert.ok(err instanceof LinearLookupError);
      assert.match(err.message, /Kim Lee/);
      assert.match(err.message, /Kim Park/);
      return true;
    });
  });

  it('ignores deactivated members, in the match and in the error', async () => {
    const { lookups: l } = lookups();
    await assert.rejects(l.user('Robin'), (err: unknown) => {
      assert.ok(err instanceof LinearLookupError);
      assert.ok(!err.message.includes('robin'), 'a deactivated member is not a candidate');
      return true;
    });
  });

  it('fetches the member list once for any number of names', async () => {
    // The client fetches every member and filters in process regardless of the
    // query, so caching per search term would buy nothing and cost a request
    // per distinct name — plus one more for every miss.
    const { lookups: l, mock } = lookups({ users: [VIEWER, USER_KIM_LEE] });
    await l.user('andre');
    await l.user('Kim Lee');
    await assert.rejects(l.user('nobody at all'), LinearLookupError);
    assert.equal(mock.callsTo('users').length, 1);
  });
});

describe('state', () => {
  it('resolves case-insensitively', async () => {
    const { lookups: l } = lookups();
    assert.equal((await l.state(TEAM_OMA, 'in progress')).name, 'In Progress');
  });

  it('does not report an ambiguity a user cannot phrase their way out of', async () => {
    const { lookups: l } = lookups({ states: [STATE_TODO, STATE_DONE, STATE_DONE_DEPLOY] });
    assert.equal((await l.state(TEAM_OMA, 'Done')).id, STATE_DONE.id);
  });

  it('lists the team’s states, with their types, when the name is wrong', async () => {
    const { lookups: l } = lookups();
    await assert.rejects(l.state(TEAM_OMA, 'Shipped'), (err: unknown) => {
      assert.ok(err instanceof LinearLookupError);
      assert.match(err.message, /Done \(completed\)/);
      return true;
    });
  });
});

describe('labelSet', () => {
  it('keeps the caller’s order', async () => {
    const { lookups: l } = lookups();
    const resolved = await l.labelSet(TEAM_OMA, ['mobile', 'bug']);
    assert.deepEqual(resolved.map((x) => x.id), [LABEL_MOBILE.id, LABEL_BUG.id]);
  });

  it('collapses two spellings of the same label', async () => {
    const { lookups: l } = lookups();
    const resolved = await l.labelSet(TEAM_OMA, ['bug', 'BUG', 'bug']);
    assert.deepEqual(resolved.map((x) => x.id), [LABEL_BUG.id]);
  });

  it('reports the first unknown label and lists what is available', async () => {
    const { lookups: l } = lookups();
    await assert.rejects(l.labelSet(TEAM_OMA, ['bug', 'regression']), (err: unknown) => {
      assert.ok(err instanceof LinearLookupError);
      assert.match(err.message, /'regression'/);
      assert.match(err.message, /needs-triage/);
      return true;
    });
  });
});

describe('caching', () => {
  it('serves repeat lookups from one request', async () => {
    const { lookups: l, mock } = lookups();
    await l.team();
    await l.team('WEB');
    await l.states(TEAM_OMA.id);
    await l.states(TEAM_OMA.id);
    assert.equal(mock.callsTo('teams').length, 1);
    assert.equal(mock.callsTo('workflowStates').length, 1);
  });

  it('re-fetches once the entry is older than the TTL', async () => {
    let t = 0;
    const { lookups: l, mock } = lookups({}, () => t);
    await l.team();
    t += LOOKUP_CACHE_TTL_MS;
    await l.team();
    assert.equal(mock.callsTo('teams').length, 2);
  });

  it('drops everything on invalidate', async () => {
    const { lookups: l, mock } = lookups();
    await l.team();
    l.invalidate();
    await l.team();
    assert.equal(mock.callsTo('teams').length, 2);
  });

  it('does not cache a failure', async () => {
    let attempt = 0;
    const client = {
      async teams() {
        attempt += 1;
        if (attempt === 1) throw new Error('upstream hiccup');
        return [TEAM_OMA];
      },
    } as unknown as LinearClient;
    const l = createLinearLookups({ client, defaultTeamKey: 'OMA' });

    await assert.rejects(l.team(), /upstream hiccup/);
    assert.equal((await l.team()).key, 'OMA');
  });

  it('a slow failure does not evict the entry that replaced it', async () => {
    // Without an identity check on eviction, the first call's rejection handler
    // would delete whatever is under the key by the time it runs — including
    // the second call's good result, silently doubling every later lookup.
    let attempt = 0;
    let failFirst: (err: Error) => void = () => undefined;
    const client = {
      async teams() {
        attempt += 1;
        if (attempt === 1) {
          return new Promise<never>((_resolve, reject) => {
            failFirst = reject;
          });
        }
        return [TEAM_OMA];
      },
    } as unknown as LinearClient;
    let t = 0;
    const l = createLinearLookups({ client, defaultTeamKey: 'OMA', now: () => t });

    const first = l.team();
    // Age the first entry out so the next call starts a fresh load rather than
    // joining the in-flight one.
    t += LOOKUP_CACHE_TTL_MS;
    assert.equal((await l.team()).key, 'OMA');

    failFirst(new Error('too late'));
    await assert.rejects(first, /too late/);

    // Still cached: this must not reach the client a third time.
    assert.equal((await l.team()).key, 'OMA');
    assert.equal(attempt, 2);
  });
});

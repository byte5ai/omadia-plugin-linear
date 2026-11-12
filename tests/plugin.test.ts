import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { PluginContext } from '@omadia/plugin-api';

import {
  activate,
  AGENT_ID,
  DEFAULT_TEAM_KEY_FIELD,
  DEFAULT_WRITE_MODE,
  LINEAR_API_SERVICE_NAME,
  TURN_CONTEXT_SERVICE_NAME,
  WRITE_MODE_FIELD,
} from '../src/plugin.js';
import { createLog, createMockLinear, type MockLinear } from './fixtures.js';

/**
 * Activation is small, and everything it can get wrong is a wiring mistake an
 * operator would otherwise meet as an unexplained failure three turns into a
 * conversation: no Linear connection installed, or no team key entered.
 */

interface Ctx {
  ctx: PluginContext;
  mock: MockLinear;
  logLines: unknown[][];
}

function makeCtx(
  options: { services?: Record<string, unknown>; config?: Record<string, unknown> } = {},
): Ctx {
  const mock = createMockLinear();
  const { log, lines } = createLog();
  const services =
    options.services ?? ({ [LINEAR_API_SERVICE_NAME]: mock.client } as Record<string, unknown>);
  const config = options.config ?? { [DEFAULT_TEAM_KEY_FIELD]: 'oma' };

  // Structural stand-in: only the accessors activate() touches are real. Cast
  // rather than implemented in full — the host surface is large and a mock of
  // all of it would be a second implementation to keep in sync.
  const ctx = {
    agentId: AGENT_ID,
    services: {
      get: <T>(name: string): T | undefined => services[name] as T | undefined,
      has: (name: string) => name in services,
      provide: () => () => undefined,
    },
    config: {
      get: <T>(key: string): T | undefined => config[key] as T | undefined,
      require: <T>(key: string): T => {
        if (!(key in config)) throw new Error(`config key '${key}' is not set`);
        return config[key] as T;
      },
    },
    secrets: {
      get: async () => undefined,
      require: async (key: string) => {
        throw new Error(`unexpected secret read: ${key}`);
      },
      keys: async () => [],
    },
    log,
    smokeMode: false,
  } as unknown as PluginContext;

  return { ctx, mock, logLines: lines };
}

/** A host turn context whose turn the test sets. */
function turnContext(): { service: { current(): unknown }; turn(id: string): void } {
  let turnId = 'turn-1';
  return {
    service: {
      current: () => ({ turnId, sessionScope: 'chat-1', userId: 'user-1', agentSlug: 'fallback' }),
    },
    turn(id) {
      turnId = id;
    },
  };
}

function toolIds(handle: { toolkit: { tools: readonly { id: string }[] } }): string[] {
  return handle.toolkit.tools.map((t) => t.id);
}

describe('activate', () => {
  it('returns the toolkit the kernel expects', async () => {
    const { ctx } = makeCtx();
    const handle = await activate(ctx);
    assert.equal(handle.toolkit.tools.length, 5);
    assert.equal(typeof handle.close, 'function');
    await handle.close();
  });

  it('names the missing capability and the plugin that provides it', async () => {
    const { ctx } = makeCtx({ services: {} });
    await assert.rejects(activate(ctx), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /linear\.api/);
      assert.match(err.message, /@omadia\/integration-linear/);
      assert.match(err.message, /requires/);
      return true;
    });
  });

  it('tells the operator what to enter when the default team key is missing', async () => {
    const { ctx } = makeCtx({ config: {} });
    await assert.rejects(activate(ctx), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /default_team_key/);
      assert.match(err.message, /prefix of its issue keys/);
      return true;
    });
  });

  it('rejects a blank default team key rather than defaulting to nothing', async () => {
    const { ctx } = makeCtx({ config: { [DEFAULT_TEAM_KEY_FIELD]: '   ' } });
    await assert.rejects(activate(ctx), /default_team_key/);
  });

  it('normalises the team key, so a lower-case entry still resolves', async () => {
    const { ctx, mock } = makeCtx({ config: { [DEFAULT_TEAM_KEY_FIELD]: ' oma ' } });
    const handle = await activate(ctx);
    const search = handle.toolkit.tools.find((t) => t.id === 'linear_search_issues');
    assert.ok(search);
    await search.run({});
    assert.deepEqual(mock.callsTo('searchIssues')[0]?.args[0], { teamKey: 'OMA' });
    await handle.close();
  });

  it('makes no network call while activating', async () => {
    const { ctx, mock } = makeCtx();
    const handle = await activate(ctx);
    assert.deepEqual(mock.calls, [], 'activation must not depend on Linear being reachable');
    await handle.close();
  });

  it('reads no secret of its own — the credential belongs to the connection', async () => {
    // `ctx.secrets.require` throws in the fixture, so an activation that tried
    // to read `linear_api_key` here would fail this test rather than silently
    // shadowing the parent's value.
    const { ctx } = makeCtx();
    const handle = await activate(ctx);
    await handle.close();
  });

  it('logs which tools it published', async () => {
    const { ctx, logLines } = makeCtx();
    const handle = await activate(ctx);
    const flat = logLines.map((l) => l.map(String).join(' ')).join('\n');
    assert.match(flat, /default team OMA/);
    assert.match(flat, /linear_prepare_write/);
    await handle.close();
  });

  it('drops staged writes on close', async () => {
    const host = turnContext();
    const mock = createMockLinear();
    const { ctx } = makeCtx({
      services: { [LINEAR_API_SERVICE_NAME]: mock.client, [TURN_CONTEXT_SERVICE_NAME]: host.service },
    });
    const handle = await activate(ctx);
    const prepare = handle.toolkit.tools.find((t) => t.id === 'linear_prepare_write');
    const commit = handle.toolkit.tools.find((t) => t.id === 'linear_commit_write');
    assert.ok(prepare && commit);
    await prepare.run({ kind: 'add_comment', issueKey: 'OMA-7', body: 'note' });

    await handle.close();
    host.turn('turn-2');

    await assert.rejects(commit.run({}), /No change is waiting/);
  });
});

describe('write mode', () => {
  it('confirms by default, for an install that never saw the field', async () => {
    const { ctx } = makeCtx();
    const handle = await activate(ctx);
    assert.equal(DEFAULT_WRITE_MODE, 'confirm');
    assert.deepEqual(toolIds(handle).slice(3), ['linear_prepare_write', 'linear_commit_write']);
    await handle.close();
  });

  for (const [mode, tools] of [
    ['confirm', ['linear_prepare_write', 'linear_commit_write']],
    ['direct', ['linear_write']],
    ['off', []],
  ] satisfies [string, string[]][]) {
    it(`'${mode}' publishes ${tools.length === 0 ? 'no write tool' : tools.join(' + ')}`, async () => {
      const { ctx, logLines } = makeCtx({
        config: { [DEFAULT_TEAM_KEY_FIELD]: 'OMA', [WRITE_MODE_FIELD]: mode },
      });
      const handle = await activate(ctx);
      assert.deepEqual(toolIds(handle).slice(3), tools);
      assert.match(logLines.map((l) => l.map(String).join(' ')).join('\n'), new RegExp(`write mode ${mode}`));
      await handle.close();
    });
  }

  it('falls back to confirming on a value it does not know, and says so', async () => {
    const { ctx, logLines } = makeCtx({
      config: { [DEFAULT_TEAM_KEY_FIELD]: 'OMA', [WRITE_MODE_FIELD]: 'yolo' },
    });
    const handle = await activate(ctx);
    assert.deepEqual(toolIds(handle).slice(3), ['linear_prepare_write', 'linear_commit_write']);
    assert.match(
      logLines.map((l) => l.map(String).join(' ')).join('\n'),
      /'linear_write_mode' has the unknown value 'yolo', using 'confirm'/,
    );
    await handle.close();
  });
});

describe('turn context', () => {
  it('binds a prepared change to the conversation the host names', async () => {
    const host = turnContext();
    const mock = createMockLinear();
    const { ctx } = makeCtx({
      services: { [LINEAR_API_SERVICE_NAME]: mock.client, [TURN_CONTEXT_SERVICE_NAME]: host.service },
    });
    const handle = await activate(ctx);
    const prepare = handle.toolkit.tools.find((t) => t.id === 'linear_prepare_write');
    const commit = handle.toolkit.tools.find((t) => t.id === 'linear_commit_write');
    assert.ok(prepare && commit);

    await prepare.run({ kind: 'add_comment', issueKey: 'OMA-7', body: 'note' });
    await assert.rejects(commit.run({}), /prepared in this same turn/);
    assert.deepEqual(mock.mutations(), []);

    host.turn('turn-2');
    await commit.run({});
    assert.deepEqual(mock.callsTo('addComment')[0]?.args, ['issue-7', 'note']);

    await handle.close();
  });

  it('activates on a host without one, and refuses a change that needs confirming', async () => {
    const { ctx, mock, logLines } = makeCtx();
    const handle = await activate(ctx);
    const prepare = handle.toolkit.tools.find((t) => t.id === 'linear_prepare_write');
    assert.ok(prepare);

    await assert.rejects(
      prepare.run({ kind: 'add_comment', issueKey: 'OMA-7', body: 'note' }),
      /belongs to no conversation/,
    );
    assert.deepEqual(mock.calls, []);
    assert.match(
      logLines.map((l) => l.map(String).join(' ')).join('\n'),
      /service 'turnContext' is not available on this host/,
    );
    await handle.close();
  });

  it('activates on a host that throws for a service it does not grant', async () => {
    const { ctx, mock } = makeCtx();
    const granted = ctx.services.get.bind(ctx.services);
    ctx.services.get = <T>(name: string): T | undefined => {
      if (name === TURN_CONTEXT_SERVICE_NAME) throw new Error('ServiceNotDeclaredError');
      return granted<T>(name);
    };
    const handle = await activate(ctx);
    assert.equal(handle.toolkit.tools.length, 5);
    assert.deepEqual(mock.calls, []);
    await handle.close();
  });

  it('does not ask for a conversation in the direct mode', async () => {
    const { ctx, mock } = makeCtx({
      config: { [DEFAULT_TEAM_KEY_FIELD]: 'OMA', [WRITE_MODE_FIELD]: 'direct' },
    });
    const handle = await activate(ctx);
    const write = handle.toolkit.tools.find((t) => t.id === 'linear_write');
    assert.ok(write);
    await write.run({ kind: 'add_comment', issueKey: 'OMA-7', body: 'note' });
    assert.deepEqual(mock.callsTo('addComment')[0]?.args, ['issue-7', 'note']);
    await handle.close();
  });
});

describe('constants', () => {
  it('agrees with the manifest and package.json on the plugin id', () => {
    assert.equal(AGENT_ID, '@omadia/agent-linear');
  });

  it('names the capability the connection publishes', () => {
    assert.equal(LINEAR_API_SERVICE_NAME, 'linear.api');
  });

  it('names the setup fields', () => {
    assert.equal(DEFAULT_TEAM_KEY_FIELD, 'default_team_key');
    assert.equal(WRITE_MODE_FIELD, 'linear_write_mode');
  });

  it('names the host service the confirmation mode reads', () => {
    assert.equal(TURN_CONTEXT_SERVICE_NAME, 'turnContext');
  });
});

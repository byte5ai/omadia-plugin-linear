import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { NativeToolHandler, NativeToolSpec, PluginContext } from '@omadia/plugin-api';

import {
  activate,
  DEFAULT_TEAM_KEY_FIELD,
  DEFAULT_WRITE_MODE,
  LINEAR_API_SERVICE_NAME,
  PLUGIN_ID,
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
  tools: RegisteredTools;
}

/** What the plugin registered with the host's tool accessor. */
interface RegisteredTools {
  /** Names of the tools registered and not yet disposed, in order. */
  ids(): string[];
  spec(name: string): NativeToolSpec;
  /** Calls the handler the plugin registered under `name`. */
  call(name: string, input: unknown): Promise<unknown>;
  /** The handler itself, still callable after its registration is disposed. */
  handler(name: string): NativeToolHandler;
}

function createToolsAccessor(): { register: PluginContext['tools']['register']; tools: RegisteredTools } {
  const live = new Map<string, { spec: NativeToolSpec; handler: NativeToolHandler }>();
  return {
    register(spec, handler) {
      assert.ok(!live.has(spec.name), `tool '${spec.name}' registered twice`);
      live.set(spec.name, { spec, handler });
      return () => {
        live.delete(spec.name);
      };
    },
    tools: {
      ids: () => [...live.keys()],
      spec(name) {
        const entry = live.get(name);
        assert.ok(entry, `tool '${name}' is not registered`);
        return entry.spec;
      },
      async call(name, input) {
        const entry = live.get(name);
        assert.ok(entry, `tool '${name}' is not registered`);
        return entry.handler(input);
      },
      handler(name) {
        const entry = live.get(name);
        assert.ok(entry, `tool '${name}' is not registered`);
        return entry.handler;
      },
    },
  };
}

function makeCtx(
  options: { services?: Record<string, unknown>; config?: Record<string, unknown> } = {},
): Ctx {
  const mock = createMockLinear();
  const { log, lines } = createLog();
  const services =
    options.services ?? ({ [LINEAR_API_SERVICE_NAME]: mock.client } as Record<string, unknown>);
  const config = options.config ?? { [DEFAULT_TEAM_KEY_FIELD]: 'oma' };
  const { register, tools } = createToolsAccessor();

  // Structural stand-in: only the accessors activate() touches are real. Cast
  // rather than implemented in full — the host surface is large and a mock of
  // all of it would be a second implementation to keep in sync.
  const ctx = {
    agentId: PLUGIN_ID,
    tools: { register, registerHandler: () => () => undefined },
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

  return { ctx, mock, logLines: lines, tools };
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

describe('activate', () => {
  it('registers the tools with the host, and unregisters them on close', async () => {
    const { ctx, tools } = makeCtx();
    const handle = await activate(ctx);
    assert.deepEqual(tools.ids(), [
      'linear_search_issues',
      'linear_get_issue',
      'linear_lookup',
      'linear_prepare_write',
      'linear_commit_write',
    ]);
    await handle.close();
    assert.deepEqual(tools.ids(), []);
  });

  it('registers each tool with an object schema derived from its input', async () => {
    const { ctx, tools } = makeCtx();
    const handle = await activate(ctx);
    const search = tools.spec('linear_search_issues');
    assert.equal(search.input_schema.type, 'object');
    assert.ok('stateType' in search.input_schema.properties);
    assert.equal(search.input_schema.required, undefined, 'every search filter is optional');
    const getIssue = tools.spec('linear_get_issue');
    assert.deepEqual(getIssue.input_schema.required, ['key']);
    assert.match(getIssue.description, /Read one Linear issue in full/);
    await handle.close();
  });

  it('returns a result as JSON text, and a refusal as a thrown ToolRefusalError', async () => {
    const { ctx, tools } = makeCtx();
    const handle = await activate(ctx);
    const text = await tools.call('linear_search_issues', {});
    assert.equal(typeof text, 'string');
    assert.equal((JSON.parse(String(text)) as { teamKey: string }).teamKey, 'OMA');
    await assert.rejects(tools.call('linear_get_issue', { key: 'OMA-404' }), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.name, 'ToolRefusalError');
      return true;
    });
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
    const { ctx, mock, tools } = makeCtx({ config: { [DEFAULT_TEAM_KEY_FIELD]: ' oma ' } });
    const handle = await activate(ctx);
    await tools.call('linear_search_issues', {});
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
    const { ctx, tools } = makeCtx({
      services: { [LINEAR_API_SERVICE_NAME]: mock.client, [TURN_CONTEXT_SERVICE_NAME]: host.service },
    });
    const handle = await activate(ctx);
    await tools.call('linear_prepare_write', { kind: 'add_comment', issueKey: 'OMA-7', body: 'note' });
    // A handler the host still holds after close, e.g. a call already in flight.
    const commit = tools.handler('linear_commit_write');

    await handle.close();
    host.turn('turn-2');

    await assert.rejects(commit({}), /No change is waiting/);
    assert.deepEqual(mock.mutations(), []);
  });
});

describe('write mode', () => {
  it('confirms by default, for an install that never saw the field', async () => {
    const { ctx, tools } = makeCtx();
    const handle = await activate(ctx);
    assert.equal(DEFAULT_WRITE_MODE, 'confirm');
    assert.deepEqual(tools.ids().slice(3), ['linear_prepare_write', 'linear_commit_write']);
    await handle.close();
  });

  for (const [mode, tools] of [
    ['confirm', ['linear_prepare_write', 'linear_commit_write']],
    ['direct', ['linear_write']],
    ['off', []],
  ] satisfies [string, string[]][]) {
    it(`'${mode}' publishes ${tools.length === 0 ? 'no write tool' : tools.join(' + ')}`, async () => {
      const { ctx, logLines, tools: registered } = makeCtx({
        config: { [DEFAULT_TEAM_KEY_FIELD]: 'OMA', [WRITE_MODE_FIELD]: mode },
      });
      const handle = await activate(ctx);
      assert.deepEqual(registered.ids().slice(3), tools);
      assert.match(logLines.map((l) => l.map(String).join(' ')).join('\n'), new RegExp(`write mode ${mode}`));
      await handle.close();
    });
  }

  it('falls back to confirming on a value it does not know, and says so', async () => {
    const { ctx, logLines, tools } = makeCtx({
      config: { [DEFAULT_TEAM_KEY_FIELD]: 'OMA', [WRITE_MODE_FIELD]: 'yolo' },
    });
    const handle = await activate(ctx);
    assert.deepEqual(tools.ids().slice(3), ['linear_prepare_write', 'linear_commit_write']);
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
    const { ctx, tools } = makeCtx({
      services: { [LINEAR_API_SERVICE_NAME]: mock.client, [TURN_CONTEXT_SERVICE_NAME]: host.service },
    });
    const handle = await activate(ctx);

    await tools.call('linear_prepare_write', { kind: 'add_comment', issueKey: 'OMA-7', body: 'note' });
    await assert.rejects(tools.call('linear_commit_write', {}), /prepared in this same turn/);
    assert.deepEqual(mock.mutations(), []);

    host.turn('turn-2');
    await tools.call('linear_commit_write', {});
    assert.deepEqual(mock.callsTo('addComment')[0]?.args, ['issue-7', 'note']);

    await handle.close();
  });

  it('activates on a host without one, and refuses a change that needs confirming', async () => {
    const { ctx, mock, logLines, tools } = makeCtx();
    const handle = await activate(ctx);

    await assert.rejects(
      tools.call('linear_prepare_write', { kind: 'add_comment', issueKey: 'OMA-7', body: 'note' }),
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
    const { ctx, mock, tools } = makeCtx();
    const granted = ctx.services.get.bind(ctx.services);
    ctx.services.get = <T>(name: string): T | undefined => {
      if (name === TURN_CONTEXT_SERVICE_NAME) throw new Error('ServiceNotDeclaredError');
      return granted<T>(name);
    };
    const handle = await activate(ctx);
    assert.equal(tools.ids().length, 5);
    assert.deepEqual(mock.calls, []);
    await handle.close();
  });

  it('does not ask for a conversation in the direct mode', async () => {
    const { ctx, mock, tools } = makeCtx({
      config: { [DEFAULT_TEAM_KEY_FIELD]: 'OMA', [WRITE_MODE_FIELD]: 'direct' },
    });
    const handle = await activate(ctx);
    await tools.call('linear_write', { kind: 'add_comment', issueKey: 'OMA-7', body: 'note' });
    assert.deepEqual(mock.callsTo('addComment')[0]?.args, ['issue-7', 'note']);
    await handle.close();
  });
});

describe('constants', () => {
  it('agrees with the manifest and package.json on the plugin id', () => {
    assert.equal(PLUGIN_ID, '@omadia/agent-linear');
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

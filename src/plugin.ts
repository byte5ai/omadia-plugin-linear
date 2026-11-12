import type { LinearClient } from '@omadia/integration-linear';
import type { PluginContext } from '@omadia/plugin-api';

import { createCallerReader, type TurnContextService } from './caller.js';
import { createToolkit, isWriteMode, type Toolkit, type WriteMode } from './toolkit.js';

/**
 * `@omadia/agent-linear` — the Linear agent.
 *
 * A `kind: agent` plugin: it owns the tools and the prompt, and holds no
 * credential. Reaching Linear is entirely the connection plugin's job:
 *
 *     depends_on: ["@omadia/integration-linear"]   secret chain, activation order
 *     requires:   ["linear.api@^1"]                makes ctx.services.get legal
 *
 * Both declarations are needed and neither substitutes for the other. This
 * plugin must NOT declare `linear_api_key` as a setup field of its own: the
 * secret resolves along the `depends_on` chain, and a redeclared field silently
 * overrides the parent's value with an empty one.
 *
 * It has two setup fields: `default_team_key`, the team used whenever a tool
 * call omits `teamKey`, and `linear_write_mode`, which decides whether a change
 * waits for the user's confirmation, is applied at once, or is not offered at
 * all. The mode is read here, once: the host reactivates a plugin when its
 * settings change, and the toolkit is built with the write tools of that mode.
 *
 * A third declaration is optional: `optional_requires: ["turnContext@1"]`. The
 * confirmation mode asks that host service which conversation and which turn a
 * call belongs to. A host without it still activates this plugin; a change
 * that needs confirming is then refused with a sentence that says why.
 *
 * Lifecycle budgets: `activate()` has 10 s, `close()` has 5 s. Activation makes
 * no network call at all: whether the key works is the Linear connection's
 * answer, given by its own connection check and shown in the Store. A wrong
 * team key therefore surfaces on the first tool call, as a message naming the
 * keys that do exist.
 *
 * The kernel does the rest: it bridges the toolkit into a sub-agent, derives
 * the orchestrator tool name from this plugin's id (`query_linear`), and
 * composes the system prompt from `skills/linear-expert.md` plus the manifest's
 * `identity.description` and `playbook.when_to_use`. No LLM client, no tool
 * loop and no system-prompt string belongs in this package.
 */

export const AGENT_ID = '@omadia/agent-linear' as const;

/** The capability this agent consumes. Must match `requires:` in manifest.yaml
 *  and `provides:` in the connection's manifest. */
export const LINEAR_API_SERVICE_NAME = 'linear.api';

/** Setup field. Must match `setup.fields[0].key` in manifest.yaml. */
export const DEFAULT_TEAM_KEY_FIELD = 'default_team_key';

/** Setup field. Must match `setup.fields[1].key` in manifest.yaml. */
export const WRITE_MODE_FIELD = 'linear_write_mode';

/** The mode of an install that never saw the field, and of a value this
 *  version does not know: the one in which nothing is written unasked. */
export const DEFAULT_WRITE_MODE: WriteMode = 'confirm';

/** The host service the confirmation mode reads the caller from. Must match
 *  `optional_requires:` in manifest.yaml. */
export const TURN_CONTEXT_SERVICE_NAME = 'turnContext';

export interface LinearAgentHandle {
  readonly toolkit: Toolkit;
  close(): Promise<void>;
}

export async function activate(ctx: PluginContext): Promise<LinearAgentHandle> {
  ctx.log('activating linear agent');

  const client = ctx.services.get<LinearClient>(LINEAR_API_SERVICE_NAME);
  if (!client) {
    throw new Error(
      `agent-linear: service '${LINEAR_API_SERVICE_NAME}' is not published. Install and configure ` +
        "@omadia/integration-linear; this plugin must declare requires: ['linear.api@^1'] and " +
        "depends_on: ['@omadia/integration-linear'].",
    );
  }

  const defaultTeamKey = readDefaultTeamKey(ctx);
  const writeMode = readWriteMode(ctx);
  const turnContext = readTurnContext(ctx);
  if (writeMode === 'confirm' && turnContext === undefined) {
    ctx.log(
      `service '${TURN_CONTEXT_SERVICE_NAME}' is not available on this host: a change cannot be bound to ` +
        'its conversation, so every change that needs confirming will be refused',
    );
  }

  const toolkit = createToolkit({
    client,
    defaultTeamKey,
    writeMode,
    caller: createCallerReader(turnContext),
    log: (...args: unknown[]) => {
      ctx.log(...args);
    },
  });

  ctx.log(
    `linear agent ready (default team ${defaultTeamKey}, write mode ${writeMode}, tools: ${toolkit.tools
      .map((t) => t.id)
      .join(', ')})`,
  );

  return {
    toolkit,
    async close(): Promise<void> {
      ctx.log('deactivating linear agent');
      await toolkit.close();
    },
  };
}

export default { AGENT_ID, activate };

/**
 * `ctx.config.require` throws when the field is unset, but its message is about
 * a missing config key rather than about what an operator has to do. The field
 * is the difference between "search my issues" working and every tool call
 * failing, so it is worth a sentence.
 */
function readDefaultTeamKey(ctx: PluginContext): string {
  let raw: unknown;
  try {
    raw = ctx.config.require<string>(DEFAULT_TEAM_KEY_FIELD);
  } catch {
    raw = undefined;
  }
  const value = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (value.length === 0) {
    throw new Error(
      `agent-linear: '${DEFAULT_TEAM_KEY_FIELD}' is not set. Enter the key of the Linear team this agent ` +
        "should work in (the prefix of its issue keys, e.g. 'OMA' for OMA-7) in the plugin settings.",
    );
  }
  return value;
}

/**
 * The write mode the operator chose. An unset field is an install from before
 * the field existed, an unknown value a setting from another version; both
 * get the default rather than an activation failure, and the log says so.
 */
function readWriteMode(ctx: PluginContext): WriteMode {
  const raw = ctx.config.get<unknown>(WRITE_MODE_FIELD);
  if (isWriteMode(raw)) return raw;
  if (raw !== undefined && raw !== '') {
    ctx.log(
      `'${WRITE_MODE_FIELD}' has the unknown value '${String(raw)}', using '${DEFAULT_WRITE_MODE}'`,
    );
  }
  return DEFAULT_WRITE_MODE;
}

/**
 * The host's turn context, or `undefined` on a host that does not grant it.
 * Asking for a service the host does not know can throw there, and a missing
 * turn context must cost the confirmation mode, not the activation.
 */
function readTurnContext(ctx: PluginContext): TurnContextService | undefined {
  try {
    return ctx.services.get<TurnContextService>(TURN_CONTEXT_SERVICE_NAME);
  } catch {
    return undefined;
  }
}

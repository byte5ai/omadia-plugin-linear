import type { LinearClient } from '@omadia/integration-linear';
import type { PluginContext } from '@omadia/plugin-api';

import { createToolkit, type Toolkit } from './toolkit.js';

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
 * Its one setup field is `default_team_key`, the team used whenever a tool call
 * omits `teamKey`.
 *
 * Lifecycle budgets: `activate()` has 10 s, `close()` has 5 s. Activation makes
 * no network call at all: the connection already verifies the key in its own
 * activate(), and repeating that here would put Linear's availability on the
 * critical path twice for one boot. A wrong team key therefore surfaces on the
 * first tool call, as a message naming the keys that do exist.
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

/** The one setup field. Must match `setup.fields[0].key` in manifest.yaml. */
export const DEFAULT_TEAM_KEY_FIELD = 'default_team_key';

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

  const toolkit = createToolkit({
    client,
    defaultTeamKey,
    log: (...args: unknown[]) => {
      ctx.log(...args);
    },
  });

  ctx.log(
    `linear agent ready (default team ${defaultTeamKey}, tools: ${toolkit.tools
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

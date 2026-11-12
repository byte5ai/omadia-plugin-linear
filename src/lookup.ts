import type {
  LinearClient,
  LinearLabel,
  LinearTeam,
  LinearUser,
  LinearWorkflowState,
} from '@omadia/integration-linear';

import { LinearAgentError, quoted } from './errors.js';

/**
 * Lookup: turning a human name into the Linear id the API needs.
 *
 * Linear's write API speaks ids; people speak names ("move OMA-7 to Done and
 * give it to Kim"). Everything that turns the second into the first lives here,
 * so `prepare_write` reads as validate-then-stage and the lookup rules sit in
 * one place with one wording for their failure messages.
 *
 * Two decisions shape this file:
 *
 *   - **Ambiguity is an error, never a guess.** A prepared write is about to be
 *     shown to a person as fact. Picking the first of two matching users would
 *     produce a preview that says something true about a decision nobody made.
 *     The error lists the candidates, which is also what lets the model retry
 *     with a precise name instead of apologising. It is a refusal (see
 *     errors.ts), so the list has to fit the length the host passes on.
 *   - **Lookups are cached.** A personal API key gets roughly 2,500 requests
 *     per hour and `ctx.http` allows 60 per minute per plugin. Resolving a team
 *     key, a state name and two labels is four requests; doing that per turn
 *     against an unchanged workspace burns the budget on answers that were
 *     already known.
 */

/** Teams, states, users and labels change on the scale of weeks. Five minutes
 *  is short enough that a state renamed mid-conversation resolves correctly
 *  after one turn, and long enough to collapse the lookups of a single
 *  prepare/commit exchange into one round of requests. */
export const LOOKUP_CACHE_TTL_MS = 5 * 60 * 1000;

/** A name the caller gave matched no Linear record, or more than one. Carries
 *  no HTTP status: nothing failed upstream, the instruction was ambiguous or
 *  wrong. */
export class LinearLookupError extends LinearAgentError {}

export interface LinearLookupsOptions {
  readonly client: LinearClient;
  /** From the plugin's `default_team_key` setup field. Used whenever a tool
   *  input omits `teamKey`. */
  readonly defaultTeamKey: string;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export interface LinearLookups {
  readonly defaultTeamKey: string;
  viewer(): Promise<LinearUser>;
  teams(): Promise<readonly LinearTeam[]>;
  /** `undefined` falls back to the configured default team. */
  team(teamKey?: string): Promise<LinearTeam>;
  states(teamId: string): Promise<readonly LinearWorkflowState[]>;
  labels(teamId: string): Promise<readonly LinearLabel[]>;
  /** Every workspace member, active or not. Callers narrow in process. */
  users(): Promise<readonly LinearUser[]>;
  /** Resolve a workflow-state name within one team. */
  state(team: LinearTeam, name: string): Promise<LinearWorkflowState>;
  /** Resolve `"me"` (the key's owner) or a person's name to one user. */
  user(spec: string): Promise<LinearUser>;
  /** Resolve label names within one team, preserving the caller's order and
   *  dropping repeats. */
  labelSet(team: LinearTeam, names: readonly string[]): Promise<readonly LinearLabel[]>;
  /** Drop every cached lookup. */
  invalidate(): void;
}

export function createLinearLookups(opts: LinearLookupsOptions): LinearLookups {
  const { client } = opts;
  const defaultTeamKey = opts.defaultTeamKey.trim().toUpperCase();
  const cache = createTtlCache(opts.ttlMs ?? LOOKUP_CACHE_TTL_MS, opts.now ?? (() => Date.now()));

  async function teams(): Promise<readonly LinearTeam[]> {
    return cache.get('teams', () => client.teams());
  }

  async function viewer(): Promise<LinearUser> {
    return cache.get('viewer', () => client.viewer());
  }

  async function states(teamId: string): Promise<readonly LinearWorkflowState[]> {
    return cache.get(`states:${teamId}`, () => client.workflowStates(teamId));
  }

  async function labels(teamId: string): Promise<readonly LinearLabel[]> {
    return cache.get(`labels:${teamId}`, () => client.labels(teamId));
  }

  async function users(): Promise<readonly LinearUser[]> {
    // Deliberately never passes a `query`. The client fetches up to
    // MAX_LOOKUP_NODES members and narrows in process either way, so a query
    // buys no smaller request — it only splits the cache per search term, which
    // turns "who is Kim?" followed by "who is Sam?" into two full fetches and a
    // miss into a third. One entry, filtered here.
    return cache.get('users', () => client.users());
  }

  async function team(teamKey?: string): Promise<LinearTeam> {
    const wanted = (teamKey ?? defaultTeamKey).trim().toUpperCase();
    if (wanted.length === 0) {
      throw new LinearLookupError(
        'No team given and no default team is configured — set the default team key in the plugin settings or pass teamKey.',
      );
    }
    const all = await teams();
    const hit = all.find((t) => t.key.toUpperCase() === wanted);
    if (!hit) {
      throw new LinearLookupError(
        `No team with key '${quoted(wanted)}'. Known team keys: ${listOf(all.map((t) => t.key))}.`,
      );
    }
    return hit;
  }

  async function state(t: LinearTeam, name: string): Promise<LinearWorkflowState> {
    const all = await states(t.id);
    const match = matchByName(all, name, (s) => [s.name]);
    if (match.length === 1) return match[0] as LinearWorkflowState;
    if (match.length === 0) {
      throw new LinearLookupError(
        `Team ${t.key} has no workflow state matching '${quoted(name)}'. Its states are: ` +
          `${listOf(all.map((s) => `${s.name} (${s.type})`))}.`,
      );
    }
    throw new LinearLookupError(
      `'${quoted(name)}' matches several states in team ${t.key}: ${listOf(match.map((s) => s.name))}. Use the exact name.`,
    );
  }

  async function user(spec: string): Promise<LinearUser> {
    const wanted = spec.trim();
    // "me" is the key's owner, not the person talking: every call this plugin
    // makes acts as that one account (no per-user identity without OAuth), so
    // "assign it to me" can only mean the key owner. The prompt partial says
    // so in as many words — this is the code half of that promise.
    if (wanted.toLowerCase() === 'me') return viewer();

    const candidates = (await users()).filter((u) => u.active);
    const match = matchByName(candidates, wanted, (u) => [u.name, u.displayName, u.email ?? '']);
    if (match.length === 1) return match[0] as LinearUser;
    if (match.length === 0) {
      throw new LinearLookupError(
        `No active workspace member matches '${quoted(wanted)}'. Members: ${listOf(
          candidates.map((u) => u.displayName),
        )}.`,
      );
    }
    throw new LinearLookupError(
      `'${quoted(wanted)}' matches several people: ${listOf(match.map((u) => `${u.displayName} (${u.name})`))}. Use a full name.`,
    );
  }

  async function labelSet(
    t: LinearTeam,
    names: readonly string[],
  ): Promise<readonly LinearLabel[]> {
    const all = await labels(t.id);
    const resolved: LinearLabel[] = [];
    const seen = new Set<string>();
    for (const name of names) {
      const match = matchByName(all, name, (l) => [l.name]);
      if (match.length === 1) {
        const label = match[0] as LinearLabel;
        // A label set is a set. Two spellings of the same label ("bug", "Bug")
        // resolve to one record, and keeping both would make the resolved list
        // longer than the issue's own — so the label set would compare as
        // changed forever, and the duplicate id would go out on the wire.
        if (seen.has(label.id)) continue;
        seen.add(label.id);
        resolved.push(label);
        continue;
      }
      if (match.length === 0) {
        throw new LinearLookupError(
          `Team ${t.key} has no label matching '${quoted(name)}'. Available labels: ${listOf(all.map((l) => l.name))}.`,
        );
      }
      throw new LinearLookupError(
        `'${quoted(name)}' matches several labels: ${listOf(match.map((l) => l.name))}. Use the exact name.`,
      );
    }
    return resolved;
  }

  return {
    defaultTeamKey,
    viewer,
    teams,
    team,
    states,
    labels,
    users,
    state,
    user,
    labelSet,
    invalidate: () => cache.clear(),
  };
}

/**
 * Case-insensitive exact match, falling back to substring.
 *
 * Exact wins outright even when a substring match also exists: a workspace with
 * "Done" and "Done (deploy)" must resolve "Done" to "Done", not report an
 * ambiguity the user cannot phrase their way out of.
 */
export function matchByName<T>(
  items: readonly T[],
  needle: string,
  fields: (item: T) => readonly string[],
): readonly T[] {
  const wanted = needle.trim().toLowerCase();
  if (wanted.length === 0) return [];
  const exact = items.filter((i) =>
    fields(i).some((f) => f.trim().toLowerCase() === wanted),
  );
  if (exact.length > 0) return exact;
  return items.filter((i) =>
    fields(i).some((f) => f.trim().toLowerCase().includes(wanted)),
  );
}

/** Most entries a refusal enumerates. */
const MAX_LISTED = 25;
/** Most characters the enumerated entries take up. The host passes on 600
 *  characters of a refusal; this leaves room for the sentence around the list,
 *  the name quoted back and the pointer to the lookup tool. */
const MAX_LIST_CHARS = 280;

/**
 * Bounded, comma-separated enumeration for a refusal.
 *
 * Bounded by characters as well as by count: a refusal longer than the host
 * passes on is cut at the end, and the end is where the instruction is. When
 * entries are left out the list says how many there are and where to see them
 * all, so a cut list is never mistaken for the complete one.
 */
export function listOf(values: readonly string[], maxChars = MAX_LIST_CHARS): string {
  if (values.length === 0) return '(none)';
  const shown: string[] = [];
  let used = 0;
  for (const value of values) {
    const cost = value.length + (shown.length > 0 ? 2 : 0);
    if (shown.length >= MAX_LISTED || used + cost > maxChars) break;
    shown.push(value);
    used += cost;
  }
  if (shown.length === values.length) return shown.join(', ');
  const lead = shown.length > 0 ? `${shown.join(', ')}, ` : '';
  return `${lead}… (${String(values.length)} in total, linear_lookup lists them all)`;
}

interface TtlCache {
  get<T>(key: string, load: () => Promise<T>): Promise<T>;
  clear(): void;
}

function createTtlCache(ttlMs: number, now: () => number): TtlCache {
  // The promise is cached, not the value: two tools resolving the same team in
  // one turn then share a single request instead of racing two. A rejection is
  // evicted so a transient failure does not become a cached one.
  const entries = new Map<string, { readonly at: number; readonly value: Promise<unknown> }>();
  return {
    get<T>(key: string, load: () => Promise<T>): Promise<T> {
      const hit = entries.get(key);
      if (hit && now() - hit.at < ttlMs) return hit.value as Promise<T>;
      const entry: { readonly at: number; readonly value: Promise<unknown> } = {
        at: now(),
        // Evict by identity, not by key: a load that fails slowly must not
        // delete the entry a later, successful load has since put in its place.
        value: load().catch((err: unknown) => {
          if (entries.get(key) === entry) entries.delete(key);
          throw err;
        }),
      };
      entries.set(key, entry);
      return entry.value as Promise<T>;
    },
    clear: () => entries.clear(),
  };
}

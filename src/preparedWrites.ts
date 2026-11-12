import { randomUUID } from 'node:crypto';

import type { UpdateIssueInput } from '@omadia/integration-linear';

import { LinearAgentError, quoted } from './errors.js';

/**
 * The prepared-write store — the whole of this plugin's write safety.
 *
 * Core does not enforce a two-phase confirm for any tool kind (ADR-0005
 * describes the pattern; nothing in the kernel implements it), so the gate has
 * to live in the plugin. `linear_prepare_write` validates an instruction,
 * resolves every name to an id, renders a preview and stages the result here;
 * `linear_commit_write` is the only code path that reaches a mutating client
 * method, and it can only act on a token this store hands back.
 *
 * Three properties do the work:
 *
 *   - **A staged write is inert.** It is a fully resolved descriptor, not a
 *     request in flight. Nothing here touches Linear.
 *   - **Take-once.** `take()` removes the entry before the caller can act on
 *     it, so a token cannot apply twice — not even if the model retries a
 *     failed commit, and not even if two turns race.
 *   - **It expires.** A preview describes Linear as it was when the preview was
 *     rendered. Ten minutes on, "Todo → Done" may no longer be true, so the
 *     token dies rather than applying a change the user agreed to against a
 *     different state of the world.
 *
 * In-memory on purpose: a token that survived a restart would outlive the
 * conversation that produced the preview, and confirmation is only meaningful
 * inside that conversation.
 */

/** Ten minutes. Long enough for a person to read a preview and answer, short
 *  enough that the preview still describes the issue as it is. */
export const PREPARED_WRITE_TTL_MS = 10 * 60 * 1000;

/** The three writes the editable set allows. Mirrors the `kind` enum of
 *  `linear_prepare_write` — see toolkit.ts. */
export type PreparedWriteKind = 'create_issue' | 'update_issue' | 'add_comment';

/** One editable field of an existing issue, as the preview reports it. Carries
 *  the old and new rendering even when nothing changed, so the preview can say
 *  "assignee unchanged" instead of staying silent about a field the user
 *  explicitly named. */
export interface PreparedFieldChange {
  readonly field: 'title' | 'description' | 'state' | 'assignee' | 'priority' | 'labels';
  /** Human-readable current value. */
  readonly from: string;
  /** Human-readable requested value. */
  readonly to: string;
  readonly changed: boolean;
}

export interface PreparedCreateIssue {
  readonly kind: 'create_issue';
  readonly teamId: string;
  readonly teamKey: string;
  readonly title: string;
  readonly description?: string;
  readonly stateId?: string;
  readonly stateName?: string;
  readonly assigneeId?: string;
  readonly assigneeName?: string;
  readonly priority?: number;
  readonly priorityLabel?: string;
  readonly labelIds?: readonly string[];
  readonly labelNames?: readonly string[];
}

export interface PreparedUpdateIssue {
  readonly kind: 'update_issue';
  readonly issueId: string;
  readonly issueKey: string;
  readonly issueTitle: string;
  /**
   * Exactly the keys that differ from the issue's current values. An unchanged
   * field is dropped here but kept in {@link changes}: sending it would make
   * Linear answer `success: true` for a no-op, which is then reported to a user
   * as a change that happened.
   */
  readonly patch: UpdateIssueInput;
  /** Every field the instruction named, changed or not. */
  readonly changes: readonly PreparedFieldChange[];
}

export interface PreparedAddComment {
  readonly kind: 'add_comment';
  readonly issueId: string;
  readonly issueKey: string;
  readonly issueTitle: string;
  readonly body: string;
}

export type PreparedWrite =
  | PreparedCreateIssue
  | PreparedUpdateIssue
  | PreparedAddComment;

export interface PreparedWriteEntry {
  readonly token: string;
  readonly write: PreparedWrite;
  readonly preview: string;
  /** Epoch millis. */
  readonly expiresAt: number;
}

/** Raised by `take()`. Distinct type so the commit tool can report a token
 *  problem differently from a Linear API failure. A refusal like every
 *  {@link LinearAgentError}: when `take()` throws, nothing was written. */
export class PreparedWriteError extends LinearAgentError {}

export interface PreparedWriteStore {
  /** Stage a validated, fully resolved write. Never touches Linear. */
  stage(write: PreparedWrite, preview: string): PreparedWriteEntry;
  /** Remove and return the entry. Throws {@link PreparedWriteError} when the
   *  token is unknown, already used, or expired. */
  take(token: string): PreparedWriteEntry;
  /** Read without consuming. For tests and diagnostics — the commit path must
   *  use {@link take}, or two concurrent commits could both see the entry. */
  peek(token: string): PreparedWriteEntry | undefined;
  /** Drop every expired entry. Returns how many went. */
  sweep(): number;
  /** Live (non-expired) entries. */
  size(): number;
  /** Drop everything. Called on deactivate: a staged write must not survive
   *  the conversation it was previewed in. */
  clear(): void;
}

export interface PreparedWriteStoreOptions {
  readonly ttlMs?: number;
  /** Injectable clock. Tests move time instead of sleeping through a TTL. */
  readonly now?: () => number;
  /** Injectable token source, for deterministic tests. */
  readonly newToken?: () => string;
}

export function createPreparedWriteStore(
  opts: PreparedWriteStoreOptions = {},
): PreparedWriteStore {
  const ttlMs = opts.ttlMs ?? PREPARED_WRITE_TTL_MS;
  const now = opts.now ?? (() => Date.now());
  const newToken = opts.newToken ?? (() => randomUUID());
  const entries = new Map<string, PreparedWriteEntry>();

  /**
   * Sweeping is lazy — driven by `stage()` and `size()`, never by a timer.
   * A `setInterval` here would be a handle the plugin has to release inside
   * close()'s 5 s budget, and a leaked one keeps the whole activation alive.
   * Expiry is enforced in `take()` regardless of whether a sweep has run, so
   * the sweep is only about not holding dead descriptors in memory.
   */
  function sweep(): number {
    const t = now();
    let dropped = 0;
    for (const [token, entry] of entries) {
      if (entry.expiresAt <= t) {
        entries.delete(token);
        dropped += 1;
      }
    }
    return dropped;
  }

  return {
    stage(write, preview) {
      sweep();
      const entry: PreparedWriteEntry = {
        token: newToken(),
        write,
        preview,
        expiresAt: now() + ttlMs,
      };
      entries.set(entry.token, entry);
      return entry;
    },

    take(token) {
      const entry = entries.get(token);
      if (!entry) {
        throw new PreparedWriteError(
          `No prepared write for token '${quoted(token)}' — it is unknown, was already committed, or expired. ` +
            'Call linear_prepare_write again, show the new preview, and commit only after the user confirms it.',
        );
      }
      // Delete first, then check expiry: an expired entry is dead either way,
      // and deleting before any decision keeps take() unconditionally
      // single-use even if a later edit adds an early return above.
      entries.delete(token);
      const t = now();
      if (entry.expiresAt <= t) {
        const ageMin = Math.round((t - entry.expiresAt) / 60000);
        throw new PreparedWriteError(
          `The prepared write for token '${quoted(token)}' expired ${ageMin > 0 ? `${String(ageMin)} minute(s)` : 'less than a minute'} ago ` +
            `(previews are valid for ${String(Math.round(ttlMs / 60000))} minutes). Nothing was written. ` +
            'Prepare the change again so the preview reflects the issue as it is now.',
        );
      }
      return entry;
    },

    peek(token) {
      const entry = entries.get(token);
      if (!entry) return undefined;
      return entry.expiresAt <= now() ? undefined : entry;
    },

    sweep,

    size() {
      sweep();
      return entries.size;
    },

    clear() {
      entries.clear();
    },
  };
}

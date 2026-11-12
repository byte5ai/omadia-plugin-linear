import type { UpdateIssueInput } from '@omadia/integration-linear';

import type { Caller } from './caller.js';
import { LinearAgentError, quoted } from './errors.js';

/**
 * The prepared-write store: the write gate of the confirmation mode.
 *
 * Core does not enforce a two-phase confirm for any tool kind (ADR-0005
 * describes the pattern; nothing in the kernel implements it), so the gate has
 * to live in the plugin. `linear_prepare_write` validates an instruction,
 * resolves every name to an id, renders a preview and stages the result here;
 * `linear_commit_write` applies what is staged, and only that.
 *
 * A staged write belongs to the conversation that prepared it. That is what
 * lets a plain "yes" find it again: nothing has to be carried from the turn
 * that showed the preview to the turn that confirms it.
 *
 * Five properties do the work:
 *
 *   - **A staged write is inert.** It is a fully resolved descriptor, not a
 *     request in flight. Nothing here touches Linear.
 *   - **One per conversation.** What the user confirms is the one preview they
 *     were shown last. A second prepare in the same turn is refused, because
 *     of two previews made in one turn nobody can say which one the user saw.
 *     A prepare in a later turn replaces the earlier one: that is a preview the
 *     user declined or changed.
 *   - **Not in the turn that prepared.** In that turn the user has not
 *     answered yet, so `take()` refuses and leaves the entry where it is.
 *   - **Take-once.** `take()` removes the entry before the caller can act on
 *     it, so a prepared write cannot apply twice, not even if the model
 *     retries a failed commit.
 *   - **It expires.** A preview describes Linear as it was when the preview was
 *     rendered. Ten minutes on, "Todo → Done" may no longer be true, so the
 *     entry dies rather than applying a change the user agreed to against a
 *     different state of the world.
 *
 * In-memory on purpose: a staged write that survived a restart would outlive
 * the moment its preview was read in.
 */

/** Ten minutes. Long enough for a person to read a preview and answer, short
 *  enough that the preview still describes the issue as it is. */
export const PREPARED_WRITE_TTL_MS = 10 * 60 * 1000;

/** How long an expired entry is kept after its expiry, only so that a late
 *  yes is told "expired" rather than "nothing was prepared". A day covers a
 *  user who answers the next morning; the entry is refused all the same. */
export const EXPIRED_WRITE_KEPT_MS = 24 * 60 * 60 * 1000;

/** Longest stretch of a preview a refusal quotes to say which change is
 *  already waiting. */
const MAX_PENDING_PREVIEW_CHARS = 120;

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
  readonly write: PreparedWrite;
  readonly preview: string;
  /** Epoch millis. */
  readonly expiresAt: number;
  /** The turn that staged it. A commit has to come from another one. */
  readonly preparedInTurn: string;
}

/** Raised by `stage()` and `take()`. Distinct type so a caller can tell a
 *  problem with the gate from a Linear API failure. A refusal like every
 *  {@link LinearAgentError}: when it is thrown, nothing was written. */
export class PreparedWriteError extends LinearAgentError {}

export interface PreparedWriteStore {
  /** Stage a validated, fully resolved write for the caller's conversation.
   *  Never touches Linear. Throws {@link PreparedWriteError} when a write
   *  staged in this same turn is still waiting. */
  stage(caller: Caller, write: PreparedWrite, preview: string): PreparedWriteEntry;
  /** Remove and return the conversation's entry. Throws
   *  {@link PreparedWriteError} when nothing is waiting, when it expired, or
   *  when the call comes from the turn that staged it. */
  take(caller: Caller): PreparedWriteEntry;
  /** Read without consuming. For tests and diagnostics: the commit path must
   *  use {@link take}, or two concurrent commits could both see the entry. */
  peek(conversation: string): PreparedWriteEntry | undefined;
  /** Drop every entry that expired more than {@link EXPIRED_WRITE_KEPT_MS}
   *  ago. Returns how many went. */
  sweep(): number;
  /** Live (non-expired) entries. */
  size(): number;
  /** Drop everything. Called on deactivate. */
  clear(): void;
}

export interface PreparedWriteStoreOptions {
  readonly ttlMs?: number;
  /** How long an expired entry is kept to answer a late yes. */
  readonly expiredKeptMs?: number;
  /** Injectable clock. Tests move time instead of sleeping through a TTL. */
  readonly now?: () => number;
}

export function createPreparedWriteStore(
  opts: PreparedWriteStoreOptions = {},
): PreparedWriteStore {
  const ttlMs = opts.ttlMs ?? PREPARED_WRITE_TTL_MS;
  const expiredKeptMs = opts.expiredKeptMs ?? EXPIRED_WRITE_KEPT_MS;
  const now = opts.now ?? (() => Date.now());
  /** Keyed by conversation. */
  const entries = new Map<string, PreparedWriteEntry>();

  /**
   * Sweeping is lazy: driven by `stage()` and `size()`, never by a timer.
   * A `setInterval` here would be a handle the plugin has to release inside
   * close()'s 5 s budget, and a leaked one keeps the whole activation alive.
   * Expiry is enforced in `take()` regardless of whether a sweep has run, so
   * the sweep is only about not holding dead descriptors in memory.
   *
   * It drops an entry only well after its expiry. A sweep runs on every
   * prepare in any conversation, and dropping an entry the moment it expired
   * would turn a late yes in its own conversation into "nothing was
   * prepared", when the true answer is "it expired, prepare it again".
   */
  function sweep(): number {
    const t = now();
    let dropped = 0;
    for (const [conversation, entry] of entries) {
      if (entry.expiresAt + expiredKeptMs <= t) {
        entries.delete(conversation);
        dropped += 1;
      }
    }
    return dropped;
  }

  return {
    stage(caller, write, preview) {
      sweep();
      // An expired entry waits for nobody: it may be replaced in any turn.
      const waiting = entries.get(caller.conversation);
      if (waiting !== undefined && waiting.expiresAt > now() && waiting.preparedInTurn === caller.turn) {
        throw new PreparedWriteError(
          `A change is already waiting for the user's confirmation ('${quoted(waiting.preview, MAX_PENDING_PREVIEW_CHARS)}'). ` +
            'Nothing new was prepared. One change per confirmation: hand that one off now, name the ' +
            'changes still to come in your answer, and prepare the next one once this one is committed.',
        );
      }
      const entry: PreparedWriteEntry = {
        write,
        preview,
        expiresAt: now() + ttlMs,
        preparedInTurn: caller.turn,
      };
      entries.set(caller.conversation, entry);
      return entry;
    },

    take(caller) {
      const entry = entries.get(caller.conversation);
      if (!entry) {
        throw new PreparedWriteError(
          'No change is waiting for confirmation in this conversation: none was prepared, it was ' +
            'already committed, a newer one replaced it, or it expired more than a day ago. Nothing ' +
            'was written. Call ' +
            'linear_prepare_write again, show the new preview, and commit only after the user confirms it.',
        );
      }
      const t = now();
      if (entry.expiresAt <= t) {
        entries.delete(caller.conversation);
        throw new PreparedWriteError(
          `The prepared change expired ${age(t - entry.expiresAt)} ago ` +
            `(previews are valid for ${String(Math.round(ttlMs / 60000))} minutes). Nothing was written. ` +
            'Prepare the change again so the preview reflects the issue as it is now.',
        );
      }
      // Checked before the entry is removed: the user may still say yes to it
      // in the next turn.
      if (entry.preparedInTurn === caller.turn) {
        throw new PreparedWriteError(
          'This change was prepared in this same turn, so the user has not seen its preview yet. ' +
            'Nothing was written. Hand off the preview and end your turn; commit when a later ' +
            'question says the user confirmed.',
        );
      }
      // Removed before it is returned, so the entry is gone whatever the
      // caller does with it next.
      entries.delete(caller.conversation);
      return entry;
    },

    peek(conversation) {
      const entry = entries.get(conversation);
      if (!entry) return undefined;
      return entry.expiresAt <= now() ? undefined : entry;
    },

    sweep,

    size() {
      sweep();
      const t = now();
      let live = 0;
      for (const entry of entries.values()) {
        if (entry.expiresAt > t) live += 1;
      }
      return live;
    },

    clear() {
      entries.clear();
    },
  };
}

/** How long ago something happened, in the unit a person would say it in. */
function age(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'less than a minute';
  if (minutes < 120) return `${String(minutes)} minute(s)`;
  return `${String(Math.round(minutes / 60))} hour(s)`;
}

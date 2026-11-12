/**
 * Refusals: errors whose message is written for the reader, not for a log.
 *
 * The host's tool bridge withholds the message of whatever a tool throws. The
 * model is told the error's class name and a log reference, and that the
 * outcome is unknown. That is the right default for a failure nobody wrote a
 * message for, and the wrong one for "team OMA has no state called Closed":
 * there the message is the whole point, and nothing happened that could be
 * unknown.
 *
 * The bridge makes one exception. An error named `ToolRefusalError` whose
 * message is a single line reaches the model as `refused the call: <message>`,
 * cut at 600 characters, and the model may then repeat the call. The name is
 * the contract, not the class: a plugin bundles its own code, so the host
 * recognises a refusal by `name` rather than by `instanceof`. A host that
 * predates the exception withholds a refusal like any other error.
 *
 * Every error this plugin writes for the model is therefore a
 * {@link LinearAgentError}, and a `LinearAgentError` is always a refusal:
 * nothing was written to Linear when it is thrown. A message here has two
 * jobs: tell the model precisely enough to retry correctly (list the states
 * that do exist, say which field is not allowed), and read as a sentence a
 * person can be shown.
 *
 * That is a different kind of failure from the error types the connection
 * raises. Those mean the request to Linear failed and stay withheld; these
 * mean the request never should have been made. Two connection failures are
 * the exception, because Linear turned the request away before doing
 * anything: a rate limit and a rejected key are restated as refusals in
 * {@link connectionRefusal}, in words written here.
 */

/** The `name` the host's tool bridge recognises a refusal by. */
export const TOOL_REFUSAL_ERROR_NAME = 'ToolRefusalError';

/** Longest refusal the host passes on; it cuts the rest. Messages are built to
 *  stay under it, so the sentence that says what to do next is never the part
 *  that goes missing. */
export const MAX_REFUSAL_CHARS = 600;

/** Longest stretch of caller-supplied text a refusal quotes back. */
const MAX_QUOTED_CHARS = 80;

// A line break turns a refusal back into a withheld error on the host, and a
// name typed with a stray newline must not cost the model its explanation.
// Covers the C0 and C1 control ranges plus the two Unicode line separators.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/**
 * One line, bounded: the form in which the host passes a refusal on.
 *
 * The cut is a backstop. A message that reaches it has lost its ending, so
 * the call sites bound their own variable parts ({@link quoted}, and the
 * candidate lists in lookup.ts) to stay clear of it.
 */
export function toRefusalText(message: string): string {
  const oneLine = message.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_REFUSAL_CHARS
    ? `${oneLine.slice(0, MAX_REFUSAL_CHARS - 1)}…`
    : oneLine;
}

/** Caller-supplied text as a refusal quotes it back: one line, bounded. */
export function quoted(value: string, maxChars = MAX_QUOTED_CHARS): string {
  const oneLine = value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  return oneLine.length > maxChars ? `${oneLine.slice(0, maxChars).trimEnd()}…` : oneLine;
}

export class LinearAgentError extends Error {
  public override readonly name: string = TOOL_REFUSAL_ERROR_NAME;

  constructor(message: string) {
    super(toRefusalText(message));
  }
}

/** What a call that Linear turned away left behind, and what to do about a
 *  wait. Per tool, because a commit has to say that its prepared change is
 *  used up: a model that only hears "try again later" would commit a change
 *  that no longer waits. */
export interface TurnedAway {
  /** "Nothing was read.", "Nothing was written, and …". */
  readonly outcome: string;
  /** The next step after a rate limit. */
  readonly later: string;
}

/**
 * The refusal for a connection failure the model is told about, or
 * `undefined` for any other error.
 *
 * Two failures qualify, both because Linear turned the request away before
 * doing anything, so nothing was read or written, and both have a next step a
 * person can act on:
 *
 * - a rate limit: wait, then try again;
 * - a rejected API key: an operator has to replace it. Retrying cannot help.
 *
 * The text is written here and carries no part of Linear's response. The
 * errors are recognised by name because the connection is a separate bundle
 * whose classes this package only knows as types.
 */
export function connectionRefusal(err: unknown, turnedAway: TurnedAway): LinearAgentError | undefined {
  if (!(err instanceof Error)) return undefined;
  if (err.name === 'LinearAuthError') {
    return new LinearAgentError(
      `Linear rejected the API key of the Linear connection, so the request was turned away. ${turnedAway.outcome} ` +
        "Do not retry: tell the user that an operator has to replace the key in the Linear connection's settings.",
    );
  }
  if (err.name !== 'LinearRateLimitError') return undefined;
  const resetAt = (err as { resetAt?: unknown }).resetAt;
  const reset =
    resetAt instanceof Date && !Number.isNaN(resetAt.getTime())
      ? ` The limit resets at ${resetAt.toISOString()}.`
      : '';
  return new LinearAgentError(
    `Linear is rate-limiting this API key, so the request was turned away.${reset} ${turnedAway.outcome} ${turnedAway.later}`,
  );
}

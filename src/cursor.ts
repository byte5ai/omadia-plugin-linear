/**
 * Page cursors, in a spelling that survives the way to the model and back.
 *
 * `linear_search_issues` returns one page and the cursor of the next. The
 * model has to read that cursor to pass it back, and the host may hand it a
 * digest of the result in which a string is readable only when it looks like
 * an identifier: letters, digits, `.`, `_` and `-`, at least one digit, and
 * nothing a detector for personal data takes for a phone number or the like.
 * Linear's cursors promise no such thing. They are opaque, and the ones that
 * are UUIDs are digit-heavy enough to be mistaken for a phone number now and
 * then.
 *
 * So the cursor goes out re-spelled: a fixed prefix carrying the one digit,
 * then every byte of the cursor as two lower-case consonants. One digit makes
 * it an identifier; one digit, no vowel and no capital leave nothing for a
 * detector to match. The spelling is a plain reversible encoding. It hides
 * nothing and protects nothing: a cursor only ever selects where a page
 * starts inside a search the caller could run anyway.
 */

const PREFIX = 'p1-';

/** One consonant per half byte. */
const ALPHABET = 'bcdfghjklmnpqrst';

/** Longest handle worth decoding. A cursor is a few dozen bytes. */
const MAX_HANDLE_CHARS = 1_024;

/** A Linear cursor as the search tool hands it to the model. */
export function encodeCursor(cursor: string): string {
  let out = PREFIX;
  for (const byte of new TextEncoder().encode(cursor)) {
    out += ALPHABET.charAt(byte >> 4) + ALPHABET.charAt(byte & 15);
  }
  return out;
}

/**
 * The Linear cursor behind a handle, or `undefined` for anything
 * {@link encodeCursor} did not produce.
 */
export function decodeCursor(handle: string): string | undefined {
  const body = handle.slice(PREFIX.length);
  if (
    !handle.startsWith(PREFIX) ||
    body.length === 0 ||
    body.length % 2 !== 0 ||
    handle.length > MAX_HANDLE_CHARS
  ) {
    return undefined;
  }

  const bytes = new Uint8Array(body.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    const high = ALPHABET.indexOf(body.charAt(i * 2));
    const low = ALPHABET.indexOf(body.charAt(i * 2 + 1));
    if (high < 0 || low < 0) return undefined;
    bytes[i] = (high << 4) | low;
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

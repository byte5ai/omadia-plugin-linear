import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { decodeCursor, encodeCursor } from '../src/cursor.js';

/**
 * The cursor of a search page has to pass through the model: out in a tool
 * result, back in the next call. What is pinned here is that the spelling it
 * travels in gives back the cursor it was made from, and that it keeps the
 * shape a host that masks tool results still lets a model read.
 */

/** Cursors of the kinds Linear and its neighbours hand out. */
const CURSORS = [
  '9b1c7f0e-52a4-4c1d-8e55-0a1b2c3d4e5f',
  '00000000-0000-0000-0000-000000000000',
  'eyJvZmZzZXQiOjUwLCJrIjoiT01BLTcifQ==',
  'a/b+c=d',
  'x',
  '+49 170 1234567',
  'Grüße aus Köln ✓',
];

describe('cursor handle', () => {
  it('gives back the cursor it was made from', () => {
    for (const cursor of CURSORS) {
      assert.equal(decodeCursor(encodeCursor(cursor)), cursor);
    }
  });

  it('reads as an identifier: no space, one digit, nothing but lower-case consonants', () => {
    for (const cursor of CURSORS) {
      const handle = encodeCursor(cursor);
      assert.match(handle, /^p1-[bcdfghjklmnpqrst]+$/, handle);
      assert.equal(handle.replace(/\D/g, ''), '1', 'exactly one digit');
    }
  });

  it('spells two cursors differently', () => {
    const handles = new Set(CURSORS.map(encodeCursor));
    assert.equal(handles.size, CURSORS.length);
  });

  it('answers undefined for anything it did not produce', () => {
    for (const handle of [
      '',
      'p1-',
      'p1-b', // half a byte
      'p1-ba', // a vowel
      'p1-BC', // capitals
      'p2-bcdf', // another prefix
      '9b1c7f0e-52a4-4c1d-8e55-0a1b2c3d4e5f', // a raw cursor
      'p1-ss', // a byte that is no UTF-8 on its own
      `p1-${'bc'.repeat(600)}`, // longer than any cursor
    ]) {
      assert.equal(decodeCursor(handle), undefined, handle);
    }
  });
});

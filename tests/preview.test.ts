import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type {
  PreparedAddComment,
  PreparedCreateIssue,
  PreparedUpdateIssue,
} from '../src/preparedWrites.js';
import {
  excerpt,
  formatLabels,
  PREVIEW_EXCERPT_CHARS,
  priorityLabel,
  renderPreview,
} from '../src/preview.js';

/**
 * The preview is the sentence a person says yes to, so these assertions are on
 * the exact string. A preview that quietly changes shape is a preview whose
 * meaning nobody re-read.
 */

const CREATE: PreparedCreateIssue = {
  kind: 'create_issue',
  teamId: 'team-oma',
  teamKey: 'OMA',
  title: 'Login fails on Safari',
};

const UPDATE: PreparedUpdateIssue = {
  kind: 'update_issue',
  issueId: 'issue-7',
  issueKey: 'OMA-7',
  issueTitle: 'Login fails on Safari',
  patch: { stateId: 'state-done' },
  changes: [
    { field: 'state', from: 'Todo', to: 'Done', changed: true },
    { field: 'assignee', from: 'andre', to: 'andre', changed: false },
  ],
};

const COMMENT: PreparedAddComment = {
  kind: 'add_comment',
  issueId: 'issue-7',
  issueKey: 'OMA-7',
  issueTitle: 'Login fails on Safari',
  body: 'The fix is on staging.',
};

describe('priorityLabel', () => {
  it('uses Linear’s own vocabulary rather than the wire number', () => {
    assert.equal(priorityLabel(0), 'No priority');
    assert.equal(priorityLabel(1), 'Urgent');
    assert.equal(priorityLabel(2), 'High');
    assert.equal(priorityLabel(3), 'Medium');
    assert.equal(priorityLabel(4), 'Low');
  });

  it('reads an absent priority as unchanged', () => {
    assert.equal(priorityLabel(undefined), 'unchanged');
  });

  it('does not invent a label for a value outside the range', () => {
    assert.equal(priorityLabel(9), 'priority 9');
  });
});

describe('excerpt', () => {
  it('leaves a short text alone, trimmed', () => {
    assert.equal(excerpt('  hello\nworld  '), 'hello\nworld');
  });

  it('keeps Markdown line structure, because the preview must look like the write', () => {
    assert.equal(excerpt('# Title\n\n- one\n- two'), '# Title\n\n- one\n- two');
  });

  it('truncates with an ellipsis at the limit', () => {
    const long = 'x'.repeat(PREVIEW_EXCERPT_CHARS + 50);
    const out = excerpt(long);
    assert.equal(out.length, PREVIEW_EXCERPT_CHARS + 1);
    assert.ok(out.endsWith('…'));
  });

  it('honours a caller-supplied limit', () => {
    assert.equal(excerpt('abcdef', 3), 'abc…');
  });
});

describe('formatLabels', () => {
  it('joins names', () => {
    assert.equal(formatLabels(['bug', 'mobile']), 'bug, mobile');
  });

  it('says none rather than nothing at all', () => {
    assert.equal(formatLabels([]), 'none');
    assert.equal(formatLabels(undefined), 'none');
  });
});

describe('renderPreview — create_issue', () => {
  it('names the team and the title', () => {
    assert.equal(renderPreview(CREATE), 'New issue in OMA: Login fails on Safari');
  });

  it('lists the fields that were set, in a fixed order', () => {
    const preview = renderPreview({
      ...CREATE,
      stateName: 'Todo',
      assigneeName: 'andre',
      priority: 3,
      priorityLabel: 'Medium',
      labelNames: ['bug', 'mobile'],
    });
    assert.equal(
      preview,
      'New issue in OMA: Login fails on Safari (state Todo, assignee andre, priority Medium, labels bug, mobile)',
    );
  });

  it('mentions only what was actually set', () => {
    const preview = renderPreview({ ...CREATE, priority: 2 });
    assert.equal(preview, 'New issue in OMA: Login fails on Safari (priority High)');
  });

  it('shows the description under the headline', () => {
    const preview = renderPreview({ ...CREATE, description: 'Safari 17 rejects the cookie.' });
    assert.equal(
      preview,
      'New issue in OMA: Login fails on Safari\nDescription:\nSafari 17 rejects the cookie.',
    );
  });

  it('omits an empty label list rather than printing "labels none"', () => {
    assert.equal(
      renderPreview({ ...CREATE, labelNames: [] }),
      'New issue in OMA: Login fails on Safari',
    );
  });
});

describe('renderPreview — update_issue', () => {
  it('reads as the change plus the fields that stay put', () => {
    const preview = renderPreview(UPDATE);
    assert.equal(
      preview,
      'OMA-7: Todo → Done, assignee unchanged\nIssue: "Login fails on Safari"',
    );
  });

  it('prefixes every field except state, which speaks for itself', () => {
    const preview = renderPreview({
      ...UPDATE,
      changes: [
        { field: 'state', from: 'Todo', to: 'Done', changed: true },
        { field: 'assignee', from: 'andre', to: 'kimlee', changed: true },
        { field: 'priority', from: 'Medium', to: 'Urgent', changed: true },
        { field: 'labels', from: 'bug', to: 'bug, mobile', changed: true },
      ],
    });
    assert.match(
      preview,
      /^OMA-7: Todo → Done, assignee andre → kimlee, priority Medium → Urgent, labels bug → bug, mobile\n/,
    );
  });

  it('shows the new description when one is being written', () => {
    const preview = renderPreview({
      ...UPDATE,
      patch: { description: 'Rewritten.' },
      changes: [{ field: 'description', from: '31 chars', to: '10 chars', changed: true }],
    });
    assert.equal(
      preview,
      'OMA-7: description 31 chars → 10 chars\nIssue: "Login fails on Safari"\nNew description:\nRewritten.',
    );
  });

  it('quotes titles so a leading or trailing space is visible', () => {
    const preview = renderPreview({
      ...UPDATE,
      patch: { title: 'New title' },
      changes: [{ field: 'title', from: '"Old title"', to: '"New title"', changed: true }],
    });
    assert.match(preview, /title "Old title" → "New title"/);
  });
});

describe('renderPreview — add_comment', () => {
  it('names the issue it will be attached to', () => {
    assert.equal(
      renderPreview(COMMENT),
      'Comment on OMA-7 "Login fails on Safari":\nThe fix is on staging.',
    );
  });

  it('truncates a long body', () => {
    const preview = renderPreview({ ...COMMENT, body: 'y'.repeat(PREVIEW_EXCERPT_CHARS + 10) });
    assert.ok(preview.endsWith('…'));
  });
});

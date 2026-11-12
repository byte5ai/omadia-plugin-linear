import type {
  PreparedAddComment,
  PreparedCreateIssue,
  PreparedFieldChange,
  PreparedUpdateIssue,
  PreparedWrite,
} from './preparedWrites.js';

/**
 * Preview rendering — the text a person reads before saying yes.
 *
 * The preview is the only thing standing between an instruction the model
 * understood loosely and a change in Linear, so it is written for the person,
 * not for the model: names rather than ids, the current value next to the
 * requested one, and an explicit word for a field that will not move
 * ("assignee unchanged") rather than silence about it.
 *
 * Kept free of client and Zod imports so it stays trivially testable: every
 * function here is a pure descriptor → string.
 */

/** Linear's own priority vocabulary. `priority` is a number on the wire and
 *  a number is not something to confirm — nobody knows whether 1 is the
 *  urgent end or the low end. */
export const PRIORITY_LABELS: Readonly<Record<number, string>> = {
  0: 'No priority',
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low',
};

export const MIN_PRIORITY = 0;
export const MAX_PRIORITY = 4;

/** Longest excerpt of a description or comment body a preview will show. */
export const PREVIEW_EXCERPT_CHARS = 600;

export function priorityLabel(priority: number | undefined): string {
  if (priority === undefined) return 'unchanged';
  return PRIORITY_LABELS[priority] ?? `priority ${String(priority)}`;
}

/** Truncate for a preview while leaving Markdown line structure intact —
 *  collapsing newlines would turn a formatted description into a wall of text
 *  that reads nothing like what will be written. */
export function excerpt(text: string, maxChars = PREVIEW_EXCERPT_CHARS): string {
  const trimmed = text.trim();
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars).trimEnd()}…` : trimmed;
}

export function formatLabels(names: readonly string[] | undefined): string {
  return names && names.length > 0 ? names.join(', ') : 'none';
}

export function renderPreview(write: PreparedWrite): string {
  switch (write.kind) {
    case 'create_issue':
      return renderCreatePreview(write);
    case 'update_issue':
      return renderUpdatePreview(write);
    case 'add_comment':
      return renderCommentPreview(write);
  }
}

export function renderCreatePreview(write: PreparedCreateIssue): string {
  const parts: string[] = [];
  if (write.stateName !== undefined) parts.push(`state ${write.stateName}`);
  if (write.assigneeName !== undefined) parts.push(`assignee ${write.assigneeName}`);
  if (write.priority !== undefined) {
    parts.push(`priority ${write.priorityLabel ?? priorityLabel(write.priority)}`);
  }
  if (write.labelNames !== undefined && write.labelNames.length > 0) {
    parts.push(`labels ${formatLabels(write.labelNames)}`);
  }
  const suffix = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  const head = `New issue in ${write.teamKey}: ${write.title}${suffix}`;
  return write.description === undefined
    ? head
    : `${head}\nDescription:\n${excerpt(write.description)}`;
}

export function renderUpdatePreview(write: PreparedUpdateIssue): string {
  const head = `${write.issueKey}: ${write.changes.map(renderChange).join(', ')}`;
  const lines = [head, `Issue: "${write.issueTitle}"`];
  const description = write.patch.description;
  if (description !== undefined) {
    lines.push(`New description:\n${excerpt(description)}`);
  }
  return lines.join('\n');
}

export function renderCommentPreview(write: PreparedAddComment): string {
  return `Comment on ${write.issueKey} "${write.issueTitle}":\n${excerpt(write.body)}`;
}

/**
 * One field of an update, as a phrase.
 *
 * State reads as a bare `Todo → Done` — a workflow-state name says what it is
 * without a label in front of it, and the state change is what the sentence is
 * usually about. Every other field is prefixed, because `Andre → Kim` on its
 * own does not say whether the assignee or the reporter moved.
 */
function renderChange(change: PreparedFieldChange): string {
  if (!change.changed) return `${change.field} unchanged`;
  if (change.field === 'state') return `${change.from} → ${change.to}`;
  return `${change.field} ${change.from} → ${change.to}`;
}

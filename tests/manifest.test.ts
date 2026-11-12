import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  AGENT_ID,
  DEFAULT_TEAM_KEY_FIELD,
  DEFAULT_WRITE_MODE,
  LINEAR_API_SERVICE_NAME,
  TURN_CONTEXT_SERVICE_NAME,
  WRITE_MODE_FIELD,
} from '../src/plugin.js';
import { isWriteMode } from '../src/toolkit.js';

/**
 * Manifest, code and package.json consistency.
 *
 * Nothing reads `manifest.yaml` at runtime in this package, so every `# ===`
 * comment next to a key is a promise no compiler keeps. Several of those
 * promises are load-bearing and fail silently rather than loudly:
 *
 *   - a version that disagrees with package.json ships a permanently
 *     mislabelled artefact (hub versions are immutable);
 *   - an entry that disagrees with the build produces a plugin core cannot
 *     start;
 *   - the Linear API capability under `optional_requires:` instead of
 *     `requires:` would let this agent activate with no Linear connection at
 *     all and fail on the first tool call;
 *   - a redeclared `linear_api_key` field would override the connection's
 *     secret with an empty one and nothing would warn;
 *   - a missing `skills/` partial degrades the system prompt to nothing, taking
 *     the prepare/preview/commit rule with it.
 *
 * Line-oriented rather than a YAML parse: the package's only dependencies are
 * zod and the host peers, and a parser for one test file is the worse trade
 * against a handful of narrow assertions.
 */

const root = process.cwd();
const manifest = readFileSync(join(root, 'manifest.yaml'), 'utf8');
const skill = readFileSync(join(root, 'skills/linear-expert.md'), 'utf8');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  main: string;
  peerDependencies: Record<string, string>;
};

function scalar(key: string): string {
  const m = new RegExp(`^\\s*${key}:\\s*"([^"]*)"`, 'm').exec(manifest);
  assert.ok(m, `manifest key not found: ${key}`);
  return m?.[1] ?? '';
}

/** The `- "value"` items of a named list block. */
function listItems(key: string): string[] {
  const block = new RegExp(`^\\s*${key}:\\s*\\n((?:\\s*(?:#[^\\n]*|- [^\\n]*)\\n)*)`, 'm').exec(
    manifest,
  );
  assert.ok(block, `manifest list not found: ${key}`);
  return [...(block?.[1] ?? '').matchAll(/^\s*- "([^"]+)"/gm)].map((m) => m[1] ?? '');
}

function hasKey(key: string): boolean {
  return new RegExp(`^\\s*${key}:`, 'm').test(manifest);
}

describe('manifest.yaml <-> package.json', () => {
  it('declares the same id and version', () => {
    assert.equal(scalar('id'), pkg.name);
    assert.equal(scalar('id'), AGENT_ID);
    assert.equal(scalar('version'), pkg.version);
  });

  it('declares the entry point package.json points at', () => {
    assert.equal(scalar('entry'), 'dist/plugin.js');
    assert.equal(pkg.main, 'dist/plugin.js');
  });

  it('lists the host packages as peers, and no sibling plugin', () => {
    // The host's upload check compares peerDependencies with its own packages
    // only. A sibling plugin listed here is reported to the operator as a
    // missing dependency on every upload, however correctly it is installed;
    // the tie to the connection is `depends_on` and `requires` in the manifest.
    assert.deepEqual(Object.keys(pkg.peerDependencies).sort(), ['@omadia/plugin-api', 'zod']);
    assert.equal(
      (pkg as unknown as { dependencies?: unknown }).dependencies,
      undefined,
      'a plugin resolves imports against the host, so runtime deps must be peers',
    );
  });
});

describe('manifest.yaml <-> code', () => {
  it('is an agent in the linear domain', () => {
    assert.equal(scalar('kind'), 'agent');
    // Drives the orchestrator tool name: `@omadia/agent-linear` -> query_linear.
    assert.equal(scalar('domain'), 'linear');
  });

  it('depends on the connection, so the secret chain resolves', () => {
    assert.deepEqual(listItems('depends_on'), ['@omadia/integration-linear']);
  });

  it('requires the Linear API capability, and not as an optional', () => {
    assert.deepEqual(listItems('requires'), [`${LINEAR_API_SERVICE_NAME}@^1`]);
    assert.ok(
      !listItems('optional_requires').some((c) => c.startsWith(LINEAR_API_SERVICE_NAME)),
      'optional_requires would let this agent activate without a Linear connection',
    );
  });

  it('asks for the turn context as an option, never as a prerequisite', () => {
    // `optional_requires:` is what grants `ctx.services.get('turnContext')`.
    // Under `requires:` a host without the service could not activate the
    // agent at all, not even to read.
    assert.deepEqual(listItems('optional_requires'), [`${TURN_CONTEXT_SERVICE_NAME}@1`]);
  });

  it('declares the two setup fields, and never the API key', () => {
    const keys = [...manifest.matchAll(/^\s*- key:\s*"([^"]+)"/gm)].map((m) => m[1]);
    assert.deepEqual(keys, [DEFAULT_TEAM_KEY_FIELD, WRITE_MODE_FIELD]);
    // The deepEqual above already covers this; asserted separately because it
    // is the failure with no symptom — a redeclared field overrides the
    // connection's secret with an empty value and nothing warns. Matched as a
    // field declaration, not as a substring, so the manifest may still explain
    // the rule in a comment.
    assert.ok(
      !/^\s*- key:\s*"linear_api_key"/m.test(manifest),
      'redeclaring the parent secret silently overrides it with an empty value',
    );
    assert.match(manifest, /type:\s*"string"/);
    assert.match(manifest, /required:\s*true/);
  });

  it('offers the write modes the code knows, and defaults to confirming', () => {
    const field = /- key: "linear_write_mode"\n([\s\S]*?)\n  # `self_test/.exec(manifest)?.[1];
    assert.ok(field, 'setup field linear_write_mode not found');
    assert.match(field, /type: "enum"/);
    assert.match(field, /required: false/);
    assert.match(field, new RegExp(`default: "${DEFAULT_WRITE_MODE}"`));
    const values = [...field.matchAll(/- value: "([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(values, ['confirm', 'direct', 'off']);
    for (const value of values) assert.ok(isWriteMode(value), `the code does not know '${value}'`);
    // Every label an operator reads exists in both languages.
    assert.equal([...field.matchAll(/^\s+en: "/gm)].length, 5);
    assert.equal([...field.matchAll(/^\s+de: "/gm)].length, 5);
  });

  it('claims no outbound host — egress belongs to the connection', () => {
    assert.match(
      manifest,
      /^\s*outbound: \[\]/m,
      'permissions.network.outbound must be empty for an integration-backed agent',
    );
  });

  it('ships no self-test, because core never invokes onConfigure', () => {
    assert.match(manifest, /self_test:\s*false/);
  });

  it('carries a localized description rather than a bare string (#885)', () => {
    assert.match(manifest, /description:\s*\n\s*en:\s*"/);
    assert.match(manifest, /^\s*de:\s*"/m);
  });

  it('mounts no routes and claims no public paths', () => {
    assert.ok(!hasKey('public_paths'));
    assert.ok(!hasKey('routes'));
  });

  it('tells the orchestrator when to route to this agent', () => {
    assert.match(manifest, /^playbook:/m);
    assert.match(manifest, /when_to_use:/);
    assert.match(manifest, /not_for:/);
  });

  it('tells the orchestrator its half of the write rule', () => {
    // `when_to_use` becomes the description of `query_linear`: the one text of
    // this package the orchestrator's model reads before it calls. It has to
    // cover every write mode, because the text is fixed and the mode is not.
    const whenToUse = /when_to_use: >\n((?: {4}\S.*\n)+)/.exec(manifest)?.[1]?.replace(/\s+/g, ' ');
    assert.ok(whenToUse, 'playbook.when_to_use must be a folded block');
    for (const needle of [
      "How a change is applied is the operator's setting",
      "the agent's answer says which of the two happened",
      'Either the change is applied at once.',
      'Or it is only prepared: nothing is written yet',
      'the calling agent shows the user the preview and asks',
      'When the user has confirmed, in a later turn',
      'says that the user confirmed',
      'One change waits per conversation, for ten minutes.',
      'If changes are switched off, the agent says so.',
    ]) {
      assert.ok(whenToUse.includes(needle), `playbook.when_to_use must state: ${needle}`);
    }
    assert.ok(!/token/i.test(whenToUse), 'nothing is carried from one turn to the next');
  });
});

describe('prompt partial', () => {
  it('is the file the manifest points at', () => {
    assert.match(manifest, /path:\s*"skills\/linear-expert\.md"/);
    assert.match(manifest, /id:\s*"linear-expert"/);
    assert.match(manifest, /kind:\s*"prompt_partial"/);
    assert.ok(existsSync(join(root, 'skills/linear-expert.md')));
  });

  it('carries the frontmatter the runtime strips', () => {
    assert.match(skill, /^---\nid: linear-expert\nkind: prompt_partial\n---\n/);
  });

  it('states the prepare, preview, confirm, commit rule', () => {
    for (const needle of [
      'linear_prepare_write',
      'linear_commit_write',
      'Commit only on a question that says the user confirmed.',
      'One change per confirmation.',
      'A commit in the turn that prepared is refused.',
    ]) {
      assert.ok(skill.includes(needle), `the prompt partial must state: ${needle}`);
    }
  });

  it('says how a tool result reaches the agent', () => {
    // On a host with a privacy filter the model gets a digest of every tool
    // result: handles, numbers and dates, and `[masked]` for any text. A
    // partial written for results in full asks for things the model cannot do,
    // such as quoting a preview it never saw.
    assert.match(skill, /## What you get back/);
    assert.match(skill, /in full or as a \*\*digest\*\*/);
    assert.match(skill, /shows as `\[masked\]`/);
    assert.match(skill, /A masked value is real\./);
    assert.match(skill, /say that the rest is\s+in the result/);
  });

  it('keys the write rules on the tools the agent has', () => {
    // The partial is one fixed file and the write mode is the operator's
    // setting. The model sees its tool list, so the partial lets that list
    // say which rules apply.
    assert.match(skill, /The write tools you have are the operator's setting/);
    assert.match(skill, /`linear_prepare_write` and `linear_commit_write` — a change needs the user's\s+confirmation/);
    assert.match(skill, /`linear_write` — a change is applied at once/);
    assert.match(skill, /neither — you read only/);
    assert.match(skill, /### With confirmation/);
    assert.match(skill, /### Without confirmation/);
  });

  it('hands off a prepared write so the caller knows what to do next', () => {
    assert.match(skill, /The answer is complete when it holds all five:/);
    for (const needle of [
      'the statement that nothing has been written yet;',
      'what you prepared, in one sentence of your own;',
      'verbatim when you can read it; when it is `[masked]`',
      'until when the user can confirm;',
      'what your caller does next: ask the user, and after their yes ask you',
    ]) {
      assert.ok(skill.includes(needle), `the handoff must hold: ${needle}`);
    }
    assert.match(skill, /After their yes, ask me again and say that the user confirmed\./);
    assert.ok(!/token/i.test(skill), 'the agent has no handle to pass on');
  });

  it('says what the direct mode asks of the agent', () => {
    assert.match(skill, /`linear_write` applies a change the moment you call it/);
    assert.match(skill, /Be sure of the change first/);
    assert.match(skill, /Call `linear_write` once per change\./);
  });

  it('explains the stateless call shape the handoff depends on', () => {
    // `LocalSubAgent.ask()` starts every call with one user message, so the
    // agent that receives the confirmation remembers nothing of the request.
    // The prepared write waits in the conversation; what the agent has to do
    // is recognise the confirmation and tell its caller how to send one.
    assert.match(skill, /## How you are called/);
    assert.match(skill, /keep no memory between those questions/);
    assert.match(skill, /what\s+you prepared and what your caller has to do next/);
    assert.match(skill, /a question saying that the user confirmed\. That\s+statement is the only thing that authorises a commit/);
  });

  it('tells a refusal apart from a failure whose outcome is unknown', () => {
    // The host passes a refusal on as `refused the call: …` and withholds
    // every other error. The model has to answer the two differently: follow
    // the first, and never repeat a commit after the second. A refusal says
    // itself what to do next (a rate limit included), so the partial names
    // the kind once and does not restate each message.
    assert.match(skill, /## When a tool answers with an error/);
    assert.match(skill, /\*\*Refusal\*\*/);
    assert.match(skill, /`refused the call:`/);
    assert.match(skill, /The error text was withheld/);
    assert.match(skill, /do \*\*not\*\* make the change again on\s+your own/);
  });

  it('uses the glossary terms', () => {
    for (const term of [
      'Issue',
      'Workflow state',
      'Lookup',
      'Prepared write',
      'Preview',
      'Commit',
      'Default team',
    ]) {
      assert.ok(
        new RegExp(`\\*\\*${term}\\*\\*`).test(skill),
        `the prompt partial must define the term: ${term}`,
      );
    }
  });

  it('says what "me" resolves to and how to answer', () => {
    assert.match(skill, /the key's owner/);
    assert.match(skill, /Cite issue keys/);
    assert.match(skill, /\*\*Summarise\.\*\*/);
  });

  it('carries the German words for the terms a user gets to read', () => {
    // The agent is used in German as often as in English. The German word sits
    // next to the term it belongs to, so the two cannot drift apart; a term
    // that never reaches a user (Lookup, Refusal) has none.
    for (const [term, german] of [
      ['Issue', 'Aufgabe'],
      ['Workflow state', 'Status'],
      ['Default team', 'Standard-Team'],
      ['Prepared write', 'vorbereitete Änderung'],
      ['Preview', 'Vorschau'],
      ['Commit', 'übernehmen'],
    ] as const) {
      assert.ok(
        skill.includes(`**${term}** (*${german}*)`),
        `the prompt partial must give the German word for ${term}`,
      );
    }
    assert.match(skill, /\*\*Answer in the language of the question\.\*\*/);
    // The handoff is shown once in German: the agent's own sentences follow
    // the question's language.
    assert.match(skill, /Es wurde noch nichts geschrieben\. Vorbereitet: OMA-7 nach Done verschieben\./);
    assert.match(skill, /Nach dem Ja frag mich erneut und sag, dass der Nutzer bestätigt hat\./);
    // The preview is what the user agrees to, so a readable one is quoted as
    // returned, whatever the language of the answer.
    assert.match(skill, /quoted as returned:\n\n> OMA-7: Todo → Done, assignee unchanged/);
  });

  it('names the default team as configuration, not a hardcoded key', () => {
    assert.match(skill, /the team configured for this plugin/);
    assert.ok(!/\bOMA\b/.test(skill.replace(/`OMA-7`|OMA-7/g, '')), 'no workspace-specific team key');
  });
});

describe('shipped files', () => {
  // The internal working layer must never be referenced from anything that
  // leaves this repository. See the repo's own rule on it.
  const FILES = [
    'manifest.yaml',
    'package.json',
    'tsconfig.json',
    'tsconfig.build.json',
    'README.md',
    'skills/linear-expert.md',
    'src/caller.ts',
    'src/errors.ts',
    'src/lookup.ts',
    'src/plugin.ts',
    'src/preparedWrites.ts',
    'src/preview.ts',
    'src/toolkit.ts',
    'scripts/build-zip.mjs',
    'scripts/test.mjs',
  ];
  // `tests/` is deliberately absent: it is not in the package, and this very
  // file has to contain the forbidden needle in order to look for it.

  for (const rel of FILES) {
    it(`${rel} references no internal working directory`, () => {
      const text = readFileSync(join(root, rel), 'utf8');
      // The needle carries the separator on purpose: the reference that must
      // never ship is a path into the working directory, and matching the bare
      // word would also flag prose about the unrelated `filesystem.scratch`
      // manifest key.
      assert.ok(!text.includes('.scratch/'), `${rel} references the internal working directory`);
    });
  }
});

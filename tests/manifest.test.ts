import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  AGENT_ID,
  DEFAULT_TEAM_KEY_FIELD,
  LINEAR_API_SERVICE_NAME,
} from '../src/plugin.js';

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
 *   - `optional_requires:` instead of `requires:` would let this agent activate
 *     with no Linear connection at all and fail on the first tool call;
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

  it('lists the connection and zod as peers, not dependencies', () => {
    assert.ok('@omadia/integration-linear' in pkg.peerDependencies);
    assert.ok('@omadia/plugin-api' in pkg.peerDependencies);
    assert.ok('zod' in pkg.peerDependencies);
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
      !hasKey('optional_requires'),
      'optional_requires would let this agent activate without a Linear connection',
    );
  });

  it('declares exactly one setup field, and never the API key', () => {
    const keys = [...manifest.matchAll(/^\s*- key:\s*"([^"]+)"/gm)].map((m) => m[1]);
    assert.deepEqual(keys, [DEFAULT_TEAM_KEY_FIELD]);
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
      'Never commit in the same turn as you prepared',
      'Never commit without a token in the question you are answering',
    ]) {
      assert.ok(skill.includes(needle), `the prompt partial must state: ${needle}`);
    }
  });

  it('explains the stateless call shape the token handoff depends on', () => {
    // `LocalSubAgent.ask()` starts every call with one user message, so a
    // confirmation cannot reach the agent unless the token went out in its
    // previous answer. Without this section the write path dead-ends in
    // repeated previews and no commit is ever possible.
    assert.match(skill, /## How you are called/);
    assert.match(skill, /keep no memory between those questions/);
    assert.match(skill, /if you do not\s+return it, nobody can ever commit that write/);
    assert.match(skill, /a token plus\s+a statement that the user confirmed/);
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
    assert.match(skill, /do \*\*not\*\* prepare or commit it again on your own/);
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
      ['Token', 'Token'],
      ['Commit', 'übernehmen'],
    ] as const) {
      assert.ok(
        skill.includes(`**${term}** (*${german}*)`),
        `the prompt partial must give the German word for ${term}`,
      );
    }
    assert.match(skill, /\*\*Answer in the language of the question\.\*\*/);
    // The preview is what the user agrees to, so it is quoted as returned even
    // inside a German answer.
    assert.match(skill, /Es wurde noch nichts geschrieben\.[^]*OMA-7: Todo → Done, assignee unchanged/);
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

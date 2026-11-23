import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  DEFAULT_TEAM_KEY_FIELD,
  DEFAULT_WRITE_MODE,
  LINEAR_API_SERVICE_NAME,
  PLUGIN_ID,
  TURN_CONTEXT_SERVICE_NAME,
  WRITE_MODE_FIELD,
} from '../src/plugin.js';
import { createToolkit, isWriteMode, type WriteMode } from '../src/toolkit.js';
import { createLog, createMockLinear, createTurns } from './fixtures.js';

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
 *     `requires:` would let these tools activate with no Linear connection at
 *     all and fail on the first tool call;
 *   - a redeclared `linear_api_key` field would override the connection's
 *     secret with an empty one and nothing would warn;
 *   - a tool without a declared effect is checked by the kernel as a write;
 *   - a persona, a prompt partial or the retired kind `agent` makes the host
 *     refuse the upload.
 *
 * Line-oriented rather than a YAML parse: the package's only dependencies are
 * zod and the host peers, and a parser for one test file is the worse trade
 * against a handful of narrow assertions.
 */

const root = process.cwd();
const manifest = readFileSync(join(root, 'manifest.yaml'), 'utf8');
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

/** The text of a top-level block, from its key to the next top-level key. */
function topLevelBlock(key: string): string {
  const m = new RegExp(`^${key}:\\n([\\s\\S]*?)(?=^[a-z_]+:)`, 'm').exec(manifest);
  assert.ok(m, `top-level block not found: ${key}`);
  return m?.[1] ?? '';
}

interface Template {
  readonly id: string;
  readonly language: string;
  readonly shortDescription: string;
  readonly text: string;
  readonly instructions: string;
}

/** The entries of `agent_templates:`, each with its folded instructions. */
function templates(): Template[] {
  const block = topLevelBlock('agent_templates');
  return block
    .split(/^ {2}- /m)
    .slice(1)
    .map((entry) => ({
      id: /^id: "([^"]+)"/.exec(entry)?.[1] ?? '',
      language: /^ {4}language: "([^"]+)"/m.exec(entry)?.[1] ?? '',
      shortDescription: /^ {4}short_description: "([^"]+)"/m.exec(entry)?.[1] ?? '',
      text: entry,
      instructions: (/^ {4}instructions: \|\n((?:(?: {6}.*)?\n)+)/m.exec(entry)?.[1] ?? '').replace(/^ {6}/gm, ''),
    }));
}

function template(language: string): Template {
  const found = templates().find((t) => t.language === language);
  assert.ok(found, `no agent template in language '${language}'`);
  return found;
}

/** Whitespace folded, so a needle may span a line break of the YAML block. */
function folded(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/** Every tool the code registers in any write mode. */
function toolIdsOfEveryMode(): string[] {
  const ids = new Set<string>();
  for (const writeMode of ['confirm', 'direct', 'off'] satisfies WriteMode[]) {
    const toolkit = createToolkit({
      client: createMockLinear().client,
      defaultTeamKey: 'OMA',
      writeMode,
      caller: createTurns().caller,
      log: createLog().log,
    });
    for (const tool of toolkit.tools) ids.add(tool.id);
  }
  return [...ids];
}

describe('manifest.yaml <-> package.json', () => {
  it('declares the same id and version', () => {
    assert.equal(scalar('id'), pkg.name);
    assert.equal(scalar('id'), PLUGIN_ID);
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
  it('is a tool capability in the linear domain', () => {
    // `agent` is a retired kind: the host refuses its upload and starts no
    // installed copy. The id stays, so this version replaces such a copy.
    assert.equal(scalar('kind'), 'tool');
    assert.equal(scalar('domain'), 'linear');
  });

  it('asks for the kernel that knows capability kinds, templates and tool effects', () => {
    assert.equal(scalar('core'), '>=1.78.0 <2.0');
  });

  it('declares the effect of every tool the code has, and of no other', () => {
    const declared = new Map(
      [...topLevelBlock('capabilities').matchAll(/- id: "([^"]+)"\n(?:\s*#.*\n)*\s*side_effects: "([^"]+)"/g)].map(
        (m) => [m[1] ?? '', m[2] ?? ''],
      ),
    );
    assert.deepEqual([...declared.keys()].sort(), toolIdsOfEveryMode().sort());
    assert.deepEqual(Object.fromEntries(declared), {
      linear_search_issues: 'read',
      linear_get_issue: 'read',
      linear_lookup: 'read',
      // Reads Linear to resolve names; the change waits in memory.
      linear_prepare_write: 'read',
      linear_commit_write: 'write',
      linear_write: 'write',
    });
  });

  it('ships no persona, no prompt partial and no model settings', () => {
    // The host refuses a package with a persona of its own (422
    // package.persona_declared); a capability has no model loop to configure.
    for (const key of ['skills', 'llm', 'persona', 'speaker', 'personality', 'system_prompt']) {
      assert.ok(!new RegExp(`^${key}:`, 'm').test(manifest), `top-level '${key}:' must not be declared`);
    }
    assert.ok(!manifest.includes('prompt_partial'), 'no prompt_partial skill');
    assert.ok(!existsSync(join(root, 'skills')), 'no skills/ directory');
    assert.ok(!existsSync(join(root, 'AGENT.md')), 'no AGENT.md');
  });

  it('depends on the connection, so the secret chain resolves', () => {
    assert.deepEqual(listItems('depends_on'), ['@omadia/integration-linear']);
  });

  it('requires the Linear API capability, and not as an optional', () => {
    assert.deepEqual(listItems('requires'), [`${LINEAR_API_SERVICE_NAME}@^2`]);
    assert.ok(
      !listItems('optional_requires').some((c) => c.startsWith(LINEAR_API_SERVICE_NAME)),
      'optional_requires would let these tools activate without a Linear connection',
    );
  });

  it('asks for the turn context as an option, never as a prerequisite', () => {
    // `optional_requires:` is what grants `ctx.services.get('turnContext')`.
    // Under `requires:` a host without the service could not activate the
    // plugin at all, not even to read.
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
      'permissions.network.outbound must be empty: the connection makes every request',
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

  it('says when the capability fits, in every write mode', () => {
    const whenToUse = /when_to_use: >\n((?: {4}\S.*\n)+)/.exec(manifest)?.[1]?.replace(/\s+/g, ' ');
    assert.ok(whenToUse, 'playbook.when_to_use must be a folded block');
    assert.match(manifest, /not_for:/);
    for (const needle of [
      "How a change is applied is the operator's setting",
      'with confirmation, a change is first prepared and shown to the user as a preview',
      'applied only after the user says yes in a later message',
      'without confirmation it is applied at once',
      'changes are switched off and the tools only read',
    ]) {
      assert.ok(whenToUse.includes(needle), `playbook.when_to_use must state: ${needle}`);
    }
    assert.ok(!/token/i.test(whenToUse), 'nothing is carried from one turn to the next');
  });
});

describe('agent templates', () => {
  it('ships one per language, each suggesting this plugin', () => {
    assert.deepEqual(
      templates().map((t) => [t.id, t.language]),
      [
        ['linear', 'en'],
        ['linear-de', 'de'],
      ],
    );
    for (const t of templates()) {
      assert.match(t.text, new RegExp(`capabilities:\\n\\s*- "${PLUGIN_ID}"`), `${t.id} suggests ${PLUGIN_ID}`);
      // The host's limits for a template (agent create route): checked here so
      // an upload is not the first place to learn of an overlong text.
      assert.ok(t.shortDescription.length > 0 && t.shortDescription.length <= 80, `${t.id}: short_description`);
      assert.ok(t.instructions.length > 0 && t.instructions.length <= 20_000, `${t.id}: instructions`);
    }
  });

  it('carry a name per language, so the Agent Builder can tell them apart', () => {
    // The builder lists a template as "<name> — <plugin name>"; two templates
    // of one name read as one entry twice.
    const names = templates().map((t) => /^ {4}name: "([^"]+)"/m.exec(t.text)?.[1]);
    assert.deepEqual(names, ['Linear Assistant', 'Linear-Assistent']);
  });

  it('cover the same sections in both languages', () => {
    const headings = (text: string): number[] => [
      [...text.matchAll(/^## /gm)].length,
      [...text.matchAll(/^### /gm)].length,
    ];
    assert.deepEqual(headings(template('de').instructions), headings(template('en').instructions));
  });

  it('state the prepare, preview, confirm, commit rule', () => {
    const en = folded(template('en').instructions);
    for (const needle of [
      'Every change takes two messages from the user: the request and the confirmation.',
      'call `linear_prepare_write`',
      'Then answer and end your turn.',
      'says that nothing has been written yet',
      'shows the preview',
      'says until when the user can confirm',
      'a later message in which the user says yes to that preview: call `linear_commit_write`',
      "Commit only on the user's yes to the preview.",
      'One change per confirmation.',
      'A commit in the turn that prepared is refused',
    ]) {
      assert.ok(en.includes(needle), `the template must state: ${needle}`);
    }
    const de = folded(template('de').instructions);
    for (const needle of [
      'Jede Änderung braucht zwei Nachrichten des Nutzers: den Auftrag und die Bestätigung.',
      'Rufe `linear_prepare_write` auf.',
      'Übernimm nur nach dem Ja des Nutzers zur Vorschau.',
      'Eine Änderung pro Bestätigung.',
      'Ein Übernehmen im selben Zug wie das Vorbereiten wird abgelehnt',
    ]) {
      assert.ok(de.includes(needle), `the German template must state: ${needle}`);
    }
    for (const t of templates()) assert.ok(!/token/i.test(t.instructions), 'the agent has no handle to pass on');
  });

  it('key the write rules on the tools the agent has', () => {
    // The template is fixed text and the write mode is the operator's setting.
    // The model sees its tool list, so the template lets that list decide.
    const en = folded(template('en').instructions);
    assert.ok(en.includes("Which write tools you have is the operator's setting"));
    assert.ok(en.includes("`linear_prepare_write` and `linear_commit_write`: a change needs the user's confirmation"));
    assert.ok(en.includes('`linear_write`: a change is applied at once'));
    assert.ok(en.includes('neither: you only read.'));
    assert.match(template('en').instructions, /^### With confirmation$/m);
    assert.match(template('en').instructions, /^### Without confirmation$/m);
    assert.match(template('de').instructions, /^### Mit Bestätigung$/m);
    assert.match(template('de').instructions, /^### Ohne Bestätigung$/m);
  });

  it('report an applied change as fact', () => {
    // A model on a masking host reads `committed` and the issue key of a
    // result, not every value. Without this it has the user verify a change
    // that was written exactly as previewed.
    const en = folded(template('en').instructions);
    assert.ok(en.includes('`committed: true` in a result says that Linear took every value of the change.'));
    assert.ok(en.includes('do not ask them to check it'));
    assert.ok(folded(template('de').instructions).includes('bitte ihn nicht, es zu prüfen'));
  });

  it('tell a refusal apart from a failure whose outcome is unknown', () => {
    const en = folded(template('en').instructions);
    assert.ok(en.includes('A refusal (`refused the call:`): the tool did nothing.'));
    assert.ok(en.includes('The error text was withheld'));
    assert.ok(en.includes('do not make the change again on your own'));
    assert.ok(folded(template('de').instructions).includes('Mach die Änderung nicht von dir aus noch einmal.'));
  });

  it('say how to find issues by filter, by time and page by page', () => {
    const en = folded(template('en').instructions);
    for (const needle of [
      'an issue has to match every filter you pass',
      '`-P7D` is seven days ago',
      '`current`, `next` or `previous`, a cycle number, or a cycle name',
      '`stateType: triage`',
      '`stateType: canceled` and `updatedAfter`',
      '`hasMore: true` says that more issues match',
      'the same input plus that `cursor`',
    ]) {
      assert.ok(en.includes(needle), `the template must state: ${needle}`);
    }
  });

  it('say what "me" resolves to and how to answer', () => {
    const en = folded(template('en').instructions);
    assert.ok(en.includes("`assignee: \"me\"` is the key's owner, whoever is asking."));
    assert.ok(en.includes('Cite issue keys.'));
    assert.ok(en.includes("Answer in the user's language."));
  });

  it('use the glossary terms, in German with the German words', () => {
    const en = template('en').instructions;
    for (const term of ['Issue', 'Workflow state', 'Project', 'Cycle', 'Triage', 'Default team', 'Prepared write', 'Preview']) {
      assert.match(en, new RegExp(`^- ${term}:`, 'm'), `the template must define the term: ${term}`);
    }
    const de = template('de').instructions;
    for (const [german, term] of [
      ['Aufgabe', 'Issue'],
      ['Status', 'Workflow State'],
      ['Projekt', 'Project'],
      ['Zyklus', 'Cycle'],
      ['Standard-Team', 'Default Team'],
      ['Vorbereitete Änderung', 'Prepared Write'],
      ['Vorschau', 'Preview'],
      ['Übernehmen', 'Commit'],
    ] as const) {
      assert.ok(de.includes(`- ${german} (${term}):`), `the German template must define ${german} (${term})`);
    }
  });

  it('write German without dashes, as the project copy rules ask', () => {
    const t = template('de');
    assert.ok(!/[—–]/.test(t.text), 'no em or en dash in the German template');
  });

  it('name the default team as configuration, not a hardcoded key', () => {
    for (const t of templates()) {
      assert.ok(!/\bOMA\b/.test(t.instructions.replace(/`?OMA-7`?/g, '')), `${t.id}: no workspace-specific team key`);
    }
  });
});

describe('shipped files', () => {
  // The maintainer keeps working notes in a local `_scratch/` directory next
  // to the checkout. It is not part of this repository, and nothing in it may
  // be referenced from a file that is.
  const FILES = [
    'manifest.yaml',
    'package.json',
    'tsconfig.json',
    'tsconfig.build.json',
    'README.md',
    'src/caller.ts',
    'src/cursor.ts',
    'src/errors.ts',
    'src/lookup.ts',
    'src/plugin.ts',
    'src/preparedWrites.ts',
    'src/preview.ts',
    'src/registerTools.ts',
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
      // never ship is a path into that directory, and matching the bare word
      // would also flag prose about the unrelated `filesystem.scratch`
      // manifest key.
      assert.ok(!text.includes('_scratch/'), `${rel} references the internal working directory`);
    });
  }
});

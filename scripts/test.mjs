#!/usr/bin/env node
/**
 * test.mjs — run the TypeScript test suite with no test framework.
 *
 * Node's built-in runner (`node:test` + `node:assert`) drives the tests;
 * esbuild (already a dev dependency) transpiles each `tests/*.test.ts` into
 * `.test-build/` first. `@omadia/plugin-api` and `@omadia/integration-linear`
 * are only ever imported for their types, so those imports are erased and
 * nothing has to resolve a host package. `zod` is a real import and IS bundled
 * from the local devDependency — the host provides it at runtime, but a test
 * run has no host.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const testsDir = join(pkgRoot, 'tests');
const outDir = join(pkgRoot, '.test-build');

const entryPoints = readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => join(testsDir, f));

if (entryPoints.length === 0) {
  console.error('no tests found in tests/');
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });

console.log(`▶ transpiling ${entryPoints.length} test file(s)`);
await build({
  entryPoints,
  outdir: outDir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: 'inline',
  logLevel: 'error',
  external: ['@omadia/plugin-api', '@omadia/integration-linear'],
});

const built = readdirSync(outDir)
  .filter((f) => f.endsWith('.js'))
  .map((f) => join(outDir, f));

console.log('▶ node --test');
const res = spawnSync(process.execPath, ['--test', ...built], {
  cwd: pkgRoot,
  stdio: 'inherit',
});
process.exit(res.status ?? 1);

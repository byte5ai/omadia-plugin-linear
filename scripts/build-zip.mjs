#!/usr/bin/env node
/**
 * build-zip.mjs — produce the uploadable plugin package.
 *
 *     npm run build        # typecheck + tests, then this
 *     npm run build:only   # this alone, skipping the gate
 *
 * Steps:
 *   1) esbuild bundle           src/plugin.ts → dist/plugin.js (ESM)
 *   2) tsc --emitDeclarationOnly            → dist/*.d.ts
 *   3) version drift guard      manifest.yaml vs package.json
 *   4) stage the runtime artefacts into out/<id>-<version>-stage/
 *   5) zip them FLAT into out/<id>-<version>.zip
 *
 * ## Why it bundles, and what stays external
 *
 * The host resolves a plugin's bare imports against its OWN node_modules, so
 * anything the host does not already ship has to be inlined. Two imports are
 * therefore kept external and must NOT be bundled:
 *
 *   - `@omadia/plugin-api` — a host-provided peer. Inlining it would fork the
 *     host's own types at runtime.
 *   - `zod` — also host-provided (the middleware ships zod 4). Inlining a
 *     second copy would give the kernel's tool bridge a schema built by a
 *     different zod instance than the one it introspects, and the bridge reads
 *     `_def` internals: the input schema would silently come out as `{}`.
 *
 * `@omadia/integration-linear` needs no entry: this package imports only its
 * types, so the import is erased before esbuild ever resolves it.
 *
 * ## Why declarations are emitted separately
 *
 * esbuild does not produce `.d.ts`. tsc emits declarations only — the runtime
 * JS comes from esbuild, and having two emitters for the same file would be a
 * drift source.
 *
 * ## Archive layout: FLAT
 *
 * `manifest.yaml`, `package.json`, the docs and `dist/` sit at the archive
 * root, with no wrapping directory. The installer accepts either that or a
 * single wrapper level; flat is the simpler of the two to reason about.
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');

const REQUIRED_FILES = ['manifest.yaml'];
// The package contract lists what a zip may hold: manifest, package.json,
// dist/, skills/, assets/, README, LICENSE.
const OPTIONAL_FILES = ['README.md', 'LICENSE'];
// `skills/` is not optional here even though the contract allows a plugin
// without one. The manifest's `skills[]` entry points at it, and the runtime
// swallows a missing partial: the agent would activate with no prompt guidance
// at all — including no prepare/preview/commit rule — and nothing would say so.
const REQUIRED_DIRS = ['skills'];
/** The manifest's `lifecycle.entry`. Its absence means the build did not finish. */
const REQUIRED_IN_DIST = ['plugin.js', 'plugin.d.ts'];

const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
if (!pkg.name || !pkg.version) {
  throw new Error('package.json: "name" and "version" are required');
}

// --- 3) version drift guard (runs first — cheapest failure) ----------------
// The version lives in two files and the hub reads the MANIFEST, not
// package.json. When they disagree, the published artefact carries a different
// version than the repository believes it cut, which is how a release becomes
// unattributable to a commit.
const manifestText = readFileSync(join(pkgRoot, 'manifest.yaml'), 'utf8');
const manifestVersion = /^\s{2}version:\s*["']?([^"'\s]+)/m.exec(manifestText)?.[1];
if (!manifestVersion) {
  throw new Error('manifest.yaml: could not read identity.version');
}
if (manifestVersion !== pkg.version) {
  throw new Error(
    `version drift: package.json says ${pkg.version}, manifest.yaml says ${manifestVersion}. ` +
      'The hub reads the manifest — bump both.',
  );
}

const distDir = join(pkgRoot, 'dist');
rmSync(distDir, { recursive: true, force: true });

// --- 1) bundle -------------------------------------------------------------
console.log('▶ esbuild bundle');
await build({
  entryPoints: [join(pkgRoot, 'src/plugin.ts')],
  outfile: join(distDir, 'plugin.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
  // Host-provided peers — must resolve from the host's node_modules at runtime.
  external: ['@omadia/plugin-api', 'zod'],
});

// --- 2) declarations -------------------------------------------------------
console.log('▶ tsc --emitDeclarationOnly');
const tsc = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['tsc', '-p', 'tsconfig.build.json'],
  { cwd: pkgRoot, stdio: 'inherit' },
);
if (tsc.status !== 0) {
  throw new Error('tsc failed to emit declarations');
}

for (const rel of REQUIRED_IN_DIST) {
  if (!existsSync(join(distDir, rel))) {
    throw new Error(`dist/ is missing ${rel} — the build artefact is incomplete`);
  }
}

// --- 4) stage --------------------------------------------------------------
const safeName = pkg.name.replace(/^@/, '').replace(/\//g, '-');
const outDir = join(pkgRoot, 'out');
const stageDir = join(outDir, `${safeName}-${pkg.version}-stage`);
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

for (const rel of REQUIRED_FILES) {
  const src = join(pkgRoot, rel);
  if (!existsSync(src)) throw new Error(`missing required file: ${rel}`);
  cpSync(src, join(stageDir, rel));
  console.log(`  + ${rel}`);
}

// devDependencies are meaningless inside a published artefact — nothing ever
// installs them from a plugin zip — and shipping them only invites a host to
// try. The peers stay: ingest reads them to check the host provides them.
const stagedPkg = { ...pkg };
delete stagedPkg.devDependencies;
delete stagedPkg.scripts;
writeFileSync(join(stageDir, 'package.json'), `${JSON.stringify(stagedPkg, null, 2)}\n`);
console.log('  + package.json (devDependencies + scripts stripped)');

cpSync(distDir, join(stageDir, 'dist'), { recursive: true });
console.log('  + dist/');

for (const rel of REQUIRED_DIRS) {
  const src = join(pkgRoot, rel);
  if (!existsSync(src)) throw new Error(`missing required directory: ${rel}/`);
  cpSync(src, join(stageDir, rel), { recursive: true });
  console.log(`  + ${rel}/`);
}

for (const rel of OPTIONAL_FILES) {
  const src = join(pkgRoot, rel);
  if (!existsSync(src)) continue;
  cpSync(src, join(stageDir, rel));
  console.log(`  + ${rel}`);
}

// --- 5) zip ----------------------------------------------------------------
const zipPath = join(outDir, `${safeName}-${pkg.version}.zip`);
rmSync(zipPath, { force: true });
createFlatZip({ zipPath, stageDir });

console.log(`✓ built ${zipPath} (${statSync(zipPath).size} bytes)`);

/**
 * Archive the CONTENTS of `stageDir` at the archive root, with whichever
 * zipper this machine has. `zip` first; on Windows it is usually absent, so
 * 7-Zip and PowerShell's `Compress-Archive` follow. `Compress-Archive` needs
 * the `/*` glob to stay flat — pointing it at the directory nests one level.
 */
function createFlatZip({ zipPath, stageDir }) {
  const EXCLUDES = ['*.DS_Store', 'node_modules/*', '*.tsbuildinfo'];
  const strategies = [
    {
      label: 'zip',
      cmd: 'zip',
      args: ['-r', '-q', zipPath, '.', ...EXCLUDES.flatMap((p) => ['-x', p])],
      opts: { cwd: stageDir, stdio: 'inherit' },
    },
    {
      label: '7z',
      cmd: '7z',
      args: ['a', '-tzip', '-bd', '-bso0', zipPath, '.'],
      opts: { cwd: stageDir, stdio: 'inherit' },
    },
    {
      label: 'Compress-Archive',
      cmd: process.platform === 'win32' ? 'powershell' : 'pwsh',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Compress-Archive -Path '${stageDir.replace(/'/g, "''")}/*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`,
      ],
      opts: { stdio: 'inherit' },
    },
  ];

  const attempted = [];
  for (const s of strategies) {
    const res = spawnSync(s.cmd, s.args, s.opts);
    if (res.error?.code === 'ENOENT') {
      attempted.push(`${s.label} (not found)`);
      continue;
    }
    if (res.error) {
      attempted.push(`${s.label} (${res.error.message})`);
      continue;
    }
    if (res.status === 0 && existsSync(zipPath)) return;
    attempted.push(`${s.label} (exit ${res.status})`);
  }

  throw new Error(
    `could not create ${zipPath} — no working zip tool. Tried: ${attempted.join(', ')}. ` +
      'Install `zip`, install 7-Zip (`7z`), or ensure PowerShell (Compress-Archive) is available.',
  );
}

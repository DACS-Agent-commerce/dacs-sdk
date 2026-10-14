#!/usr/bin/env node
// Verifies packages/dacs-seller against its PROVENANCE.json (PLAN §0.12: a
// script checks the manifest against the frontend source commit on every push).
//
//   node packages/dacs-seller/scripts/check-provenance.mjs [--root <sdk repo>] [--source <frontend repo>]
//
// Without --source it recomputes the SHA-256 of every manifest entry and fails
// on a mismatch, a missing file, a non-regular file, or any file under the
// package's src/, test/ or port-sources/ that the manifest does not list.
// With --source it also reads each source blob at its recorded commit, checks
// the recorded PR heads and their ancestry, and checks that each PR's changed
// files are exactly the ported ones plus the ones listed as not ported.
// Exits 1 on any failure. No dependencies beyond Node and git.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapPath, portSourcePath } from './lib/paths.mjs';

const PKG = 'dacs-seller';
const ROLES = new Set(['src', 'test', 'port-source']);
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

function parseArgs(argv) {
  const args = { root: resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), source: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') args.root = resolve(argv[++i]);
    else if (argv[i] === '--source') args.source = resolve(argv[++i]);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return args;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function walk(dir, rel, out) {
  let names;
  try { names = readdirSync(dir); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const name of names) {
    const abs = join(dir, name);
    const r = `${rel}/${name}`;
    const st = lstatSync(abs);
    if (st.isDirectory()) walk(abs, r, out);
    else out.push({ rel: r, regular: st.isFile() });
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const failures = [];
  const fail = (m) => failures.push(m);
  const pkgRel = `packages/${PKG}`;
  const manifest = JSON.parse(readFileSync(join(args.root, pkgRel, 'PROVENANCE.json'), 'utf8'));
  if (manifest.format !== 'dacs-provenance/v1') fail(`unknown manifest format ${manifest.format}`);
  if (!HEX40.test(manifest.integrationBase ?? '')) fail('integrationBase is not a full commit hash');
  const ports = new Map((manifest.portSources ?? []).map((p) => [p.inspectedHead, p]));
  const files = Array.isArray(manifest.files) ? manifest.files : (fail('files is not an array'), []);

  const listed = new Set();
  let verified = 0;
  for (const e of files) {
    const where = e.path ?? '(no path)';
    if (typeof e.path !== 'string' || typeof e.sourcePath !== 'string' || !HEX40.test(e.sourceCommit ?? '') || !HEX64.test(e.sha256 ?? '') || !ROLES.has(e.role)) { fail(`${where}: malformed entry`); continue; }
    if (posix.normalize(e.path) !== e.path || e.path.split('/').includes('..')) { fail(`${where}: path is not normalized`); continue; }
    if (listed.has(e.path)) fail(`${where}: listed twice`);
    listed.add(e.path);
    let expected;
    try {
      if (e.role === 'port-source') {
        const port = ports.get(e.sourceCommit);
        if (!port) throw new Error(`port source commit ${e.sourceCommit} is not a recorded PR head`);
        if (e.pr !== port.pr || e.planNamedCommit !== port.planNamedHead) throw new Error('PR number or plan-named head differs from its portSources record');
        expected = portSourcePath(PKG, port, e.sourcePath);
      } else {
        if (e.sourceCommit !== manifest.integrationBase) throw new Error(`source commit ${e.sourceCommit} is not the integration base`);
        expected = mapPath(PKG, e.sourcePath);
        if ((e.role === 'test') !== expected.startsWith(`${pkgRel}/test/`)) throw new Error(`role ${e.role} does not match its mapped directory`);
      }
    } catch (error) { fail(`${where}: ${error.message}`); continue; }
    if (expected !== e.path) { fail(`${where}: the path mapping gives ${expected}`); continue; }
    let st;
    try { st = lstatSync(join(args.root, e.path)); } catch (error) { if (error.code === 'ENOENT') { fail(`${where}: missing`); continue; } throw error; }
    if (!st.isFile()) { fail(`${where}: not a regular file`); continue; }
    const actual = sha256(readFileSync(join(args.root, e.path)));
    if (actual !== e.sha256) { fail(`${where}: sha256 ${actual} differs from the manifest's ${e.sha256}`); continue; }
    verified += 1;
  }

  const found = [];
  for (const d of ['src', 'test', 'port-sources']) walk(join(args.root, pkgRel, d), `${pkgRel}/${d}`, found);
  for (const f of found) {
    if (!f.regular) fail(`${f.rel}: not a regular file`);
    else if (!listed.has(f.rel)) fail(`${f.rel}: not in the manifest`);
  }

  let sourceChecked = 0;
  if (args.source) {
    const git = (a, opts = {}) => execFileSync('git', ['-C', args.source, ...a], { maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    const blob = (c, p) => { try { return git(['cat-file', 'blob', `${c}:${p}`]); } catch { return null; } };
    const exists = (c) => { try { return git(['rev-parse', '--verify', '--end-of-options', `${c}^{commit}`]).toString().trim() === c; } catch { return false; } };
    const ancestor = (a, b) => { try { git(['merge-base', '--is-ancestor', a, b]); return true; } catch { return false; } };
    const commits = [manifest.integrationBase, ...[...ports.values()].flatMap((p) => [p.inspectedHead, p.planNamedHead])];
    const missing = commits.filter((c) => !exists(c));
    for (const c of missing) fail(`source: commit ${c} is not in ${args.source}`);
    if (missing.length === 0) {
      for (const p of ports.values()) {
        if (!ancestor(manifest.integrationBase, p.inspectedHead)) fail(`source: #${p.pr}: ${manifest.integrationBase} is not an ancestor of ${p.inspectedHead}`);
        if (!ancestor(p.planNamedHead, p.inspectedHead)) fail(`source: #${p.pr}: ${p.planNamedHead} is not an ancestor of ${p.inspectedHead}`);
        const changed = git(['diff', '--name-only', '-z', '--no-renames', manifest.integrationBase, p.inspectedHead, '--', 'http-mcp']).toString().split('\0').filter(Boolean).sort();
        const accounted = [...files.filter((e) => e.role === 'port-source' && e.sourceCommit === p.inspectedHead).map((e) => e.sourcePath), ...(p.notPorted ?? []).map((n) => n.sourcePath)].sort();
        if (JSON.stringify(changed) !== JSON.stringify(accounted)) fail(`source: #${p.pr}: the PR's changed files are not exactly the ported plus the not-ported ones`);
      }
      for (const e of files) {
        if (!listed.has(e.path) || !HEX40.test(e.sourceCommit ?? '')) continue;
        const bytes = blob(e.sourceCommit, e.sourcePath);
        if (!bytes) { fail(`${e.path}: source ${e.sourceCommit.slice(0, 7)}:${e.sourcePath} is missing`); continue; }
        if (sha256(bytes) !== e.sha256) { fail(`${e.path}: source blob ${e.sourceCommit.slice(0, 7)}:${e.sourcePath} hashes to ${sha256(bytes)}, not ${e.sha256}`); continue; }
        if (e.role === 'port-source') {
          const plan = blob(e.planNamedCommit, e.sourcePath);
          if ((plan ? sha256(plan) : null) !== e.planNamedSha256) { fail(`${e.path}: the plan-named head's version differs from planNamedSha256`); continue; }
        }
        sourceChecked += 1;
      }
    }
  }

  const counts = {};
  for (const e of files) counts[e.role] = (counts[e.role] ?? 0) + 1;
  process.stdout.write(`manifest: ${files.length} entries (${Object.entries(counts).map(([r, n]) => `${r} ${n}`).join(', ')})\n`);
  process.stdout.write(`files: ${verified} hashes match, ${found.length} files found under src/, test/, port-sources/\n`);
  if (args.source) process.stdout.write(`source: ${sourceChecked} source blobs match at their recorded commits\n`);
  if (failures.length) {
    for (const f of failures) process.stderr.write(`FAIL ${f}\n`);
    process.stderr.write(`check-provenance: ${failures.length} failure(s)\n`);
    process.exit(1);
  }
  process.stdout.write('check-provenance: ok\n');
}

try {
  main();
} catch (error) {
  process.stderr.write(`check-provenance: ${error.message}\n`);
  process.exit(1);
}

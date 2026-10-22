import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const packageDir = fileURLToPath(new URL('..', import.meta.url));
function entryPointClosure() {
  const files = new Set();
  function visit(path) {
    if (files.has(path)) return;
    assert.ok(path.startsWith('src/') && path.endsWith('.mjs'), path);
    files.add(path);
    const source = readFileSync(join(packageDir, path), 'utf8');
    for (const [, specifier] of source.matchAll(/\b(?:from|import)\s*(?:\(\s*)?['"](\.[^'"]+)['"]/g)) {
      visit(relative(packageDir, resolve(packageDir, dirname(path), specifier)));
    }
  }
  visit('src/index.mjs');
  visit('src/wallet/durable-journal.mjs');
  return [...files].sort();
}

test('npm pack ships only the two entry points and their reviewed import closure', t => {
  const directory = mkdtempSync(join(tmpdir(), 'dacs-client-pack-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const path of ['src', 'package.json', 'README.md', 'LICENSE']) {
    cpSync(join(packageDir, path), join(directory, path), { recursive: true });
  }
  // New plugin or internal files must stay excluded even when present locally.
  for (const path of ['src/public/portal/TEST-unreviewed.mjs', 'src/dacs/TEST-seller-state.mjs',
    'src/config/TEST-unreviewed.mjs', 'src/TEST-unused.mjs', 'FIX-REPORT.md', '.fix-tmp/PR.md', '.rr-tmp/REVIEW.md', '.stack/TEST.md']) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), 'TEST unreviewed content\n');
  }
  const result = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: directory,
    encoding: 'utf8', maxBuffer: 4 << 20, env: { ...process.env, npm_config_cache: join(directory, '.npm-cache') } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const [pack] = JSON.parse(result.stdout);
  const files = pack.files.map(file => file.path).sort();
  for (const path of files) {
    assert.doesNotMatch(path, /(?:^|\/)(?:public|portal|portal-intent|config|seller-agent|seller-durable-state|switch-files|FIX-REPORT|\.fix-tmp|\.rr-tmp|\.stack)(?:[/.]|$)/, path);
  }
  assert.deepEqual(files, [...entryPointClosure(), 'package.json', 'README.md', 'LICENSE'].sort());
});

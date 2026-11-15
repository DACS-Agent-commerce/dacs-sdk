import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { importAudit } from './check-imports.mjs';

const scripts = dirname(fileURLToPath(import.meta.url));
const pkg = join(scripts, '..');

test('the current package allows its reviewed wallet import', () => {
  const audit = importAudit();
  assert.ok(audit.rows.some(row => row.target === 'src/public/portal/embedded-wallet/sdk-provider.mjs'));
  assert.deepEqual(audit.failures, []);
});

test('the import audit command succeeds on the current package', () => {
  const result = spawnSync(process.execPath, [join(scripts, 'check-imports.mjs')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /\[check-imports\] OK:/);
});

test('reviewed imports preserve forbidden dependency checks', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'client-import-audit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'scripts'));
  cpSync(join(scripts, 'check-imports.mjs'), join(dir, 'scripts/check-imports.mjs'));
  cpSync(join(pkg, 'src'), join(dir, 'src'), { recursive: true });
  symlinkSync(join(pkg, '../../node_modules'), join(dir, 'node_modules'), 'dir');
  const { importAudit: audit } = await import(pathToFileURL(join(dir, 'scripts/check-imports.mjs')));
  const cases = [
    ['another importer', 'src/wallet/unreviewed.mjs', "import '../public/portal/embedded-wallet/sdk-provider.mjs';", /forbidden import/],
    ['another portal target', 'src/wallet/node-wallet-session.mjs', "import '../public/portal/unreviewed.mjs';", /forbidden import/],
    ['an unreviewed re-export', 'src/wallet/unreviewed.mjs', "export * from '../public/portal/embedded-wallet/sdk-provider.mjs';", /forbidden import/],
    ['a dependency directory', 'src/wallet/unreviewed.mjs', "import '../node_modules/dependency.mjs';", /forbidden import/],
    ['a build directory', 'src/wallet/unreviewed.mjs', "import '../dist/dependency.mjs';", /forbidden import/],
    ['operations', 'src/wallet/unreviewed.mjs', "import '../operations.mjs';", /forbidden import/],
    ['buyer access', 'src/wallet/unreviewed.mjs', "import '../buyer-access.mjs';", /forbidden import/],
    ['wallet signature', 'src/wallet/unreviewed.mjs', "import '../wallet/demos-signature.mjs';", /forbidden import/],
    ['a missing target', 'src/wallet/unreviewed.mjs', "import './missing.mjs';", /missing\/outside dependency/],
    ['an outside target', 'src/wallet/unreviewed.mjs', "import '../../../outside.mjs';", /missing\/outside dependency/],
  ];
  for (const [name, path, source, error] of cases) {
    await t.test(name, () => {
      writeFileSync(join(dir, path), source);
      assert.ok(audit().failures.some(failure => failure.startsWith(`${path}:1:`) && error.test(failure)));
    });
  }
  await t.test('a missing reviewed target', () => {
    writeFileSync(join(dir, 'src/wallet/node-wallet-session.mjs'), "import '../public/portal/embedded-wallet/sdk-provider.mjs';");
    unlinkSync(join(dir, 'src/public/portal/embedded-wallet/sdk-provider.mjs'));
    assert.ok(audit().failures.some(failure => failure.startsWith('src/wallet/node-wallet-session.mjs:1: missing/outside dependency')));
  });
});

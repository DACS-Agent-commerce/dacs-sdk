// Tester quickstart: the guide ships in the package, names real package
// paths/settings, keeps account creation inside the user's own wallet, and
// its documented loopback startup really answers /health and MCP with honest
// not_configured results. The installed-tarball boot is covered by
// `npm run check:package`; this file boots the source binary the same way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { SWITCHES } from '../src/config.mjs';

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOC = 'docs/TESTER-QUICKSTART.md';
const doc = readFileSync(join(root, DOC), 'utf8');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

test('the quickstart is part of the packed package', async () => {
  const { stdout } = await run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  const files = JSON.parse(stdout)[0].files.map((f) => f.path);
  assert.ok(files.includes(DOC), `${DOC} is packed`);
  assert.match(readFileSync(join(root, 'README.md'), 'utf8'), /docs\/TESTER-QUICKSTART\.md/, 'README links the quickstart');
});

test('the quickstart names the real package, binary, engine and tarball', () => {
  const [binName] = Object.keys(pkg.bin);
  assert.match(doc, new RegExp(`npx ${binName}\\b`));
  assert.ok(doc.includes(`\`engines.node\` is \`${pkg.engines.node}\``));
  const tarball = `${pkg.name.replace(/^@/, '').replace('/', '-')}-${pkg.version}.tgz`;
  assert.ok(doc.includes(tarball), `documents the npm pack file name ${tarball}`);
  assert.match(doc, /--ignore-scripts/);
  assert.match(doc, /not published to npm/);
});

// Every documentation link must work in the installed package: it resolves to
// a packed file, never outside the package root. A reference that only makes
// sense in a source checkout must say so on the same line.
test('documentation links resolve inside the packed package (or say "source checkout")', async () => {
  const { stdout } = await run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  const files = new Set(JSON.parse(stdout)[0].files.map((f) => f.path));
  const docs = [...files].filter((p) => p === 'README.md' || /^(docs|skills)\/.+\.md$/.test(p)).sort();
  assert.ok(docs.includes('docs/TESTING.md') && docs.includes('docs/TESTER-QUICKSTART.md'), 'tester docs are packed');
  let checked = 0;
  const sourceOnly = [];
  for (const docPath of docs) {
    const lines = readFileSync(join(root, docPath), 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/`((?:\.\.?\/)*[\w./-]+\.(?:md|example))`|\]\(([^)#:\s]+)\)/g)) {
        const ref = m[1] ?? m[2];
        const resolved = posix.normalize(posix.join(posix.dirname(docPath), ref));
        const where = `${docPath}:${i + 1} -> ${ref}`;
        assert.ok(!resolved.startsWith('..'), `${where} points outside the package`);
        if (files.has(resolved)) { checked += 1; continue; }
        assert.match(line, /source checkout/, `${where} is not packed and is not marked source-checkout-only`);
        sourceOnly.push(where);
      }
    });
  }
  assert.ok(checked >= 10, `checked ${checked} packed links`);
  assert.deepEqual(sourceOnly, ['docs/DEPLOYMENT-CHECKLIST.md:9 -> deploy/RUNBOOK.md']);
});

test('every setting the quickstart mentions is a real configuration variable', () => {
  // src/config.mjs names plus the feature switch files (docs/SWITCHES.md).
  const known = new Set([...readFileSync(join(root, 'src/config.mjs'), 'utf8').matchAll(/\bDACS_[A-Z_]+/g)].map((m) => m[0]).concat(SWITCHES.map((s) => s.env)));
  const mentioned = new Set([...doc.matchAll(/\bDACS_[A-Z_]+/g)].map((m) => m[0]));
  assert.ok(mentioned.size >= 5);
  for (const name of mentioned) assert.ok(known.has(name), `${name} is read by src/config.mjs`);
});

test('every relative file the quickstart points at exists', () => {
  const refs = [...doc.matchAll(/`((?:\.\.\/)?[\w./-]+\.(?:md|example))`/g)].map((m) => m[1]);
  assert.ok(refs.length >= 4);
  for (const ref of refs) assert.ok(existsSync(join(root, 'docs', ref)), `${ref} exists relative to docs/`);
});

test('account creation stays inside the user\'s own wallet, and open items stay open', () => {
  assert.match(doc, /only inside the Demos wallet extension/);
  assert.match(doc, /never ask for, display, store or log a seed phrase, mnemonic or private key/);
  assert.match(doc, /never create a wallet for you/);
  assert.match(doc, /public address/);
  assert.match(doc, /never merges two plugin accounts/);
  assert.match(doc, /fixed-price DEM testnet/);
  assert.match(doc, /\*\*Buyers\*\*/);
  assert.match(doc, /\*\*Sellers\*\*/);
  // The plain-string sign request matches the reviewed 0.5.7 source only; the
  // installed wallet and its network stay unconfirmed.
  assert.match(doc, /`params: \[message\]`/);
  assert.match(doc, /matches the source only/);
  assert.match(doc, /\*\*not\*\* been tried with an installed wallet/);
  assert.match(doc, /A label in the portal is not proof/);
  assert.match(doc, /has \*\*not\*\* been accepted/);
  // No instructions to paste secrets anywhere.
  assert.doesNotMatch(doc, /(enter|paste|type) (your )?(seed|mnemonic|private key)/i);
});

test('the documented loopback startup answers /health and MCP with honest not_configured results', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dacs-quickstart-'));
  const port = await new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port: p } = s.address();
      s.close(() => resolve(p));
    });
  });
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(root, pkg.bin['dacs-chatgpt-plugin'])], {
    cwd: work,
    // Exactly the variables the quickstart sets, nothing inherited.
    env: { PATH: process.env.PATH, PORT: String(port), HOST: '127.0.0.1', DACS_PUBLIC_ORIGIN: origin, DACS_ALLOW_INSECURE_LOCALHOST: '1', DACS_DATA_DIR: join(work, 'data'), DACS_OAUTH_COOKIE_KEYS: randomBytes(32).toString('hex'), DACS_LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  try {
    let health = null;
    for (let i = 0; i < 50 && !health; i += 1) {
      await new Promise((r) => setTimeout(r, 200));
      health = await fetch(`${origin}/health`).then((r) => r.json()).catch(() => null);
    }
    assert.equal(health?.status, 'ok', stderr.slice(0, 300));
    assert.equal(health.dependencies.directory.configured, false);
    assert.equal(health.dependencies.chain.configured, false);
    const client = new Client({ name: 'quickstart', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)));
    try {
      const { tools } = await client.listTools();
      assert.ok(tools.some((t) => t.name === 'search_agents'));
      const search = await client.callTool({ name: 'search_agents', arguments: {} });
      assert.equal(search.isError, true);
      assert.match(search.content[0].text, /not configured/);
    } finally {
      await client.close();
    }
  } finally {
    const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
    child.kill('SIGTERM');
    assert.equal(await exited, 0, 'graceful SIGTERM shutdown');
    rmSync(work, { recursive: true });
  }
});

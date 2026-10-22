// Role-owned helper for test/agreement-context-interactions.test.mjs. Same
// construction as test/helpers/agreement-context-integration.mjs
// startContextHarness, plus cold reconstruction: the actual app is closed and
// rebuilt by createApp from the SAME loaded config/data dir and an explicitly
// supplied operator provider (or none), while the HTTP listener, fixtures and
// SQLite durable broker journal (closed and reopened) persist. Restart state
// only; not process-kill or power-loss evidence. All authority is ephemeral TEST.
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAnchorFixture } from '../dacs-loopback-fixture.test.mjs';
import { startDirectoryFixture } from '../fixtures/directory-server.mjs';
import { CALLBACK_ORIGIN } from './harness.mjs';
import { loadConfig } from '../../src/config.mjs';
import { createApp } from '../../src/app.mjs';
import { createLogger } from '../../src/util/log.mjs';
import { openDurableWalletJournal } from '../../src/wallet/durable-journal.mjs';

export function reopenableJournal(dir) {
  const path = join(dir, 'wallet-journal.sqlite');
  let backing = openDurableWalletJournal({ path, mode: 'create' });
  const journalId = backing.journalId;
  return {
    journal: { get: (k) => backing.get(k), put: (k, v) => backing.put(k, v), entries: () => backing.entries(), withWalletLock: (k, w) => backing.withWalletLock(k, w) },
    reopen() { assert.deepEqual(backing.inspectLocks(), [], 'reopen only when quiescent'); backing.close(); backing = openDurableWalletJournal({ path, mode: 'open', expectedJournalId: journalId }); },
    close() { try { backing.close(); } catch { /* closed */ } },
  };
}

// env: extra switches (the report view test turns DACS_SHOWCASE_REPORT_VIEW on).
export async function startRestartableContextHarness({ chain, now, agreementContext, env = {} }) {
  const directory = await startDirectoryFixture();
  const anchors = await startAnchorFixture(now ? { clock: now } : {});
  const endpoints = new Map();
  const dataDir = mkdtempSync(join(tmpdir(), 'dacs-context-interactions-'));
  const store = reopenableJournal(dataDir);
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const config = loadConfig({ DACS_PUBLIC_ORIGIN: origin, DACS_ALLOW_INSECURE_LOCALHOST: '1', DACS_OAUTH_COOKIE_KEYS: randomBytes(32).toString('hex'),
    DACS_DATA_DIR: dataDir, DACS_DIRECTORY_ORIGIN: directory.url, DACS_CHAIN_RPC_URL: chain.url, DACS_ALLOWED_REDIRECT_ORIGINS: CALLBACK_ORIGIN,
    DACS_LOG_LEVEL: 'debug', DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback', ...env });
  const logs = [];
  const build = (provider) => createApp({ config, logger: createLogger({ level: 'debug', sink: (line) => logs.push(line) }),
    dacsProtocol: { anchorUrl: anchors.url, sellerEndpoint: (claim) => endpoints.get(claim) ?? null, browserAgreement: { journal: store.journal },
      ...(provider ? { agreementContext: provider } : {}) }, ...(now ? { now } : {}) });
  const h = { origin, mcpUrl: `${origin}/mcp`, chain, directory, anchors, endpoints, config, logs, store, restarts: 0 };
  h.app = await build(agreementContext);
  const handler = (req, res) => h.app.app(req, res);
  server.on('request', handler);
  const closers = [];
  h.onClose = (fn) => closers.push(fn);
  // Cold reconstruction with an explicit provider (the same TEST slot, or null).
  h.restart = async (provider) => {
    await h.app.close();
    store.reopen();
    h.app = await build(provider);
    h.restarts += 1;
  };
  h.close = async () => {
    await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
    await h.app.close();
    for (const fn of closers.reverse()) await fn();
    store.close();
    await anchors.close(); await chain.close(); await directory.close(); rmSync(dataDir, { recursive: true });
  };
  return h;
}

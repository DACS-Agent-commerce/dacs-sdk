// Real public staged composition, production reader and SQLite; only the node and local enrollment sources are scripted.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';
import { api, mnemonicBytes, scriptedNode, setPurchaseAdmission, T0 } from './tp1-node-fixture.mjs';
import { controlledClock } from './effect-boundary-fixture.mjs';
const { queuedOwner } = await import('./queued-owner.mjs');
const { openDurableWalletJournal } = await import('../../src/wallet/durable-journal.mjs');
const { buildNativeTransferPayload } = await import('../../src/dacs/wallet-transactions.mjs');

export async function finalizedWorld(t, { path, node = scriptedNode(), state = {}, input = {}, journalOptions = {}, journalWrap = j => j, compose = options => api.composeNodeWalletSession(options) } = {}) {
  setPurchaseAdmission('testnet-tp1');
  const directory = path ? null : mkdtempSync(join(tmpdir(), 'finalized-node-'));
  const journalPath = path ?? join(directory, 'wallet.sqlite');
  const journal = openDurableWalletJournal({ path: journalPath, mode: path ? 'open' : 'create', ...journalOptions });
  const owner = queuedOwner({ fetchImpl: node.fetch }), key = mnemonicBytes();
  const clock = controlledClock();
  clock.advance(T0);
  const options = { owner, journal: journalWrap(journal), key, clock, approve: async () => true,
    identityRecord: TP1_APPROVED_IDENTITY_RECORD, listings: { isRegistered: () => false },
    purchases: { findByJobId: () => null }, participantImplementations: { entriesFor: () => [] },
    stopped: async () => { await state.onStop?.(); return state.stopped ?? false; }, feeCeilingOs: '50000000000', ...input };
  let session, closed = false;
  const close = async () => { if (!closed) { closed = true; await session?.close(); await owner.close(); journal.close(); } };
  t.after(async () => { await close(); if (directory) rmSync(directory, { recursive: true, force: true }); });
  const build = async () => { session = await compose(options); return session; };
  const world = { node, owner, journal, key, options, clock, state, path: journalPath, close, build,
    get session() { return session; },
    records: async () => (await journal.entries()).filter(([key]) => key.startsWith('eb/')).map(([, value]) => value),
    effects: () => node.calls.filter(row => row.body.method === 'execute').map(row => row.body.params[0].extra),
    async restart(extra = {}) { await close(); const next = await finalizedWorld(t, { path: journalPath, node, state, ...extra }); await next.build(); return next; },
    send: request => session.wallet.request(request ?? world.request()),
    request: () => ({ method: 'sendTransaction', params: [buildNativeTransferPayload({ from: session.wallet.getPublicAccount().address,
      to: '0x' + '2'.repeat(64), amountOs: '2500000000', nonce: 1, timestamp: T0, encoding: 'os-string' })] }),
  };
  return world;
}

// Commits a history record before the cut, so a real kill can leave its lane owner behind.
export const cutHistory = hook => journal => ({ ...journal, appendUnderLock: async (lane, key, value) => {
  await journal.appendUnderLock(lane, key, value);
  await hook(value);
} });

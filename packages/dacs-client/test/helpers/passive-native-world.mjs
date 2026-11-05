import { createDevnetAgreementTransport } from '../../src/wallet/devnet-native-transport.mjs';

export const NOW = 1_900_000_000_000, HASH = 'a'.repeat(64), IDENTITY = 'f'.repeat(64);
export const PAYER = '0x' + 'b'.repeat(64), PAYEE = '0x' + 'c'.repeat(64);
export const INTENT = `devnet/native-transfer/${HASH}`;
const json = (response) => new Response(JSON.stringify({ result: 200, response }), { headers: { 'content-type': 'application/json' } });

// The passive contract's fetch: a request held by onFetch rejects with its
// signal's reason once that signal aborts.
function abortHonouring(signal, work) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(work).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

// One TEST source over a fake node. onFetch(message, signal, data) may hold a
// request or return a Response to answer it; onFence() may hold the fence.
export function passiveNativeWorld({ onFetch = () => {}, onFence = () => {}, status = 'confirmed', state = 'included', journal: durableJournal } = {}) {
  const expected = { network: 'testnet', chainIdentity: IDENTITY, pinVersion: 'TEST-pin', endpoint: 'https://rpc.invalid/', transportAuthority: 'TEST-owner' };
  const context = { network: expected.network, endpoint: expected.endpoint, transportAuthority: expected.transportAuthority, connectionId: 'TEST-connection' };
  const records = new Map(), writes = [], calls = [], lockKeys = [], locks = new Map(), fences = { acquired: 0, released: 0 };
  const memory = { get: async key => structuredClone(records.get(key)), entries: async () => structuredClone([...records]),
    put: async (key, value) => { writes.push(key); records.set(key, structuredClone(value)); }, withWalletLock: async (key, fn) => {
      lockKeys.push(key);
      const prior = locks.get(key) ?? Promise.resolve(); let release;
      const gate = new Promise(resolve => { release = resolve; }); locks.set(key, prior.then(() => gate));
      await prior; try { return await fn(); } finally { release(); }
    } };
  const journal = durableJournal ? { ...durableJournal, put: async (key, value) => { writes.push(key); await durableJournal.put(key, value); } } : memory;
  const content = { type: 'native', from: PAYER, from_ed25519_address: PAYER, to: PAYEE, amount: '1000000000', nonce: 7,
    timestamp: NOW, data: ['native', { nativeOperation: 'send', args: [PAYEE, '1000000000'] }] };
  const world = { journal, records, writes, calls, lockKeys, fences, held: () => held,
    statusAnswer: { state, blockNumber: 7 },
    transaction: { hash: HASH, content, status, blockNumber: 7 },
    block: { number: 7, status: 'confirmed', hash: 'd'.repeat(64), content: { ordered_transactions: [HASH], timestamp: NOW / 1000 } },
    async seed({ laneOnly = false } = {}) {
      const networkBinding = await world.source.observeBinding();
      const row = { stage: laneOnly ? 'broadcast-started' : 'broadcast-accepted', hash: HASH, nonce: 7, signedTransaction: { hash: HASH, content: structuredClone(content) }, networkBinding };
      await journal.put(`devnet/native-wallet/${JSON.stringify([expected.network, IDENTITY, PAYER])}`, structuredClone(row));
      if (!laneOnly) await journal.put(INTENT, structuredClone(row));
      await journal.put('TEST-claims', { claim: 'TEST-retained' });
      writes.length = 0; calls.length = 0; lockKeys.length = 0; fences.acquired = fences.released = 0;
    } };
  let held = false;
  world.source = createDevnetAgreementTransport({ expected, journal, now: () => NOW,
    transportOwner: { getContext: () => ({ ...context }), acquireConnectionFence: async () => {
      await onFence();
      if (held) throw new Error('TEST-double-fence');
      held = true; fences.acquired++;
      return { context: { ...context }, release() { held = false; fences.released++; } };
    } },
    fetchImpl: (_url, options) => abortHonouring(options.signal, async () => {
      const { message, data } = JSON.parse(options.body).params[0];
      calls.push(message);
      const answer = await onFetch(message, options.signal, data);
      if (answer instanceof Response) return answer;
      if (message === 'getBlockByNumber') return json(data.blockNumber === 0 ? { number: 0, status: 'confirmed', hash: IDENTITY } : world.block);
      if (message === 'getTransactionStatus') return json(world.statusAnswer);
      if (message === 'getTxByHash') return json(world.transaction);
      throw new Error(`TEST-unexpected ${message}`);
    }) });
  return world;
}

import { createDevnetAgreementTransport } from '../../src/wallet/devnet-native-transport.mjs';

export const NOW = 1_900_000_000_000, HASH = 'a'.repeat(64), IDENTITY = 'f'.repeat(64);
export const PAYER = '0x' + 'b'.repeat(64), PAYEE = '0x' + 'c'.repeat(64);
export function passiveNativeWorld({ onFetch = () => {}, onFence = () => {}, status = 'confirmed', state = 'included', journal: durableJournal } = {}) {
  const expected = { network: 'testnet', chainIdentity: IDENTITY, pinVersion: 'TEST-pin', endpoint: 'https://rpc.invalid/', transportAuthority: 'TEST-owner' };
  const context = { network: expected.network, endpoint: expected.endpoint, transportAuthority: expected.transportAuthority, connectionId: 'TEST-connection' };
  const records = new Map(), writes = [], calls = [], locks = new Map();
  const memory = { get: async key => structuredClone(records.get(key)), entries: async () => structuredClone([...records]),
    put: async (key, value) => { writes.push(key); records.set(key, structuredClone(value)); }, withWalletLock: async (key, fn) => {
      const prior = locks.get(key) ?? Promise.resolve(); let release;
      const gate = new Promise(resolve => { release = resolve; }); locks.set(key, prior.then(() => gate));
      await prior; try { return await fn(); } finally { release(); }
    } };
  const journal = durableJournal ? { ...durableJournal, put: async (key, value) => { writes.push(key); await durableJournal.put(key, value); } } : memory;
  const content = { type: 'native', from: PAYER, from_ed25519_address: PAYER, to: PAYEE, amount: '1000000000', nonce: 7,
    timestamp: NOW, data: ['native', { nativeOperation: 'send', args: [PAYEE, '1000000000'] }] };
  const transaction = { hash: HASH, content, status, blockNumber: 7 };
  let held = false;
  const source = createDevnetAgreementTransport({ expected, journal, now: () => NOW,
    transportOwner: { getContext: () => ({ ...context }), acquireConnectionFence: async () => {
      await onFence();
      if (held) throw new Error('TEST-double-fence'); held = true;
      return { context: { ...context }, release() { held = false; } };
    } },
    fetchImpl: async (_url, options) => {
      const { message, data } = JSON.parse(options.body).params[0];
      calls.push(message);
      await onFetch(message, options.signal, data);
      let response;
      if (message === 'getBlockByNumber') response = data.blockNumber === 0 ? { number: 0, status: 'confirmed', hash: IDENTITY }
        : { number: 7, status: 'confirmed', hash: 'd'.repeat(64), content: { ordered_transactions: [HASH], timestamp: NOW / 1000 } };
      else if (message === 'getTransactionStatus') response = { state, blockNumber: 7 };
      else if (message === 'getTxByHash') response = transaction;
      else throw new Error(`TEST-unexpected ${message}`);
      return new Response(JSON.stringify({ result: 200, response }), { headers: { 'content-type': 'application/json' } });
    } });
  return { source, journal, records, writes, calls, transaction, held: () => held,
    async seed({ laneOnly = false } = {}) {
      const networkBinding = await source.observeBinding();
      const row = { stage: laneOnly ? 'broadcast-started' : 'broadcast-accepted', hash: HASH, nonce: 7, signedTransaction: { hash: HASH, content: structuredClone(content) }, networkBinding };
      await journal.put(`devnet/native-wallet/${JSON.stringify([expected.network, IDENTITY, PAYER])}`, structuredClone(row));
      if (!laneOnly) await journal.put(`devnet/native-transfer/${HASH}`, structuredClone(row));
      await journal.put(`TEST-claims`, { claim: 'TEST-retained' });
      writes.length = 0;
    } };
}

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { TP1_APPROVED_IDENTITY_RECORD as record } from '@kynesyslabs/dacs/wire';
import { createDemosNetworkBinder } from '../../src/dacs/network-binding.mjs';
import { createDevnetSettlementTransport, DEVNET_NODE2_BLOCK_ZERO_ERROR_ENVELOPE, DEVNET_NODE2_BLOCK_LAYOUT } from '../../src/wallet/devnet-native-transport.mjs';

export { record };
export const NOW = 1_900_000_000_000;
export const hash = text => createHash('sha256').update(text).digest('hex');
const capture = name => JSON.parse(JSON.parse(readFileSync(new URL(`../../../../conformance/tp1-node-observations/${name}-2026-10-20.json`, import.meta.url))).body);
export const captured = { zero: capture('block0'), genesis: capture('genesis-string-zero'), one: capture('block1') };
export const envelope = response => ({ result: 200, response, require_reply: false, extra: '' });
export const local = { network: record.network, endpoint: 'https://identity-a.invalid/', transportAuthority: 'TEST-identity-owner', connectionId: 'TEST-identity-connection' };
// The buyer's connection as the wire profile binding takes it: no network label.
export const ownLocal = { endpoint: local.endpoint, transportAuthority: local.transportAuthority, connectionId: local.connectionId };
export const expected ={ network: record.network, chainIdentity: record.chainIdentity, pinVersion: record.pinVersion, endpoint: local.endpoint, transportAuthority: local.transportAuthority };
export const fallback = { blockZeroUnavailable: 'literal-error', documentation: record.provenance.documentation };

export function shared({ answers, getContext = () => ({ ...local }), getBlock, timeoutMs = 10_000, now = () => NOW } = {}) {
  const heights = [];
  const replies = [ 'error', captured.genesis, envelope({ number: 1, status: 'confirmed', hash: captured.one.response.hash, content: { previousHash: record.chainIdentity } }) ];
  if (answers) replies.splice(0, answers.length, ...answers);
  const binder = createDemosNetworkBinder({ expected, fallback, now, timeoutMs, reader: {
    getContext,
    async getBlockByNumber(height, policy) {
      heights.push(height);
      assert.deepEqual(policy, { cache: 'no-store', redirect: 'error' });
      const value = getBlock ? await getBlock(height) : replies[heights.length - 1];
      return { value: structuredClone(value), context: { ...local }, observedAt: now(), fromCache: false, redirected: false };
    },
  } });
  return { binder, heights };
}

// A synthetic stabilised-genesis node: numeric block zero is a real block, `getChainIdentity` answers, and block
// one chains to block zero with its own number. Every reviewed value here is a test value, not node evidence.
export const stabilisedGenesis = Object.freeze({
  representation: 'stabilised-genesis', documentation: 'TEST reviewed stabilised-genesis reference', chainId: 'TEST-stabilised-chain',
  genesisHash: record.chainIdentity, genesisDataHash: hash('TEST-genesis-data'), blockOneHash: hash('TEST-stabilised-block-one'),
});
/** Fresh replies of that node, keyed by the request: numeric height 0, 'chainIdentity' and numeric height 1. */
export const stabilisedReplies = () => ({
  0: envelope({ number: 0, status: 'confirmed', hash: stabilisedGenesis.genesisHash }),
  chainIdentity: envelope({ chainId: stabilisedGenesis.chainId, genesisHash: stabilisedGenesis.genesisHash, genesisDataHash: stabilisedGenesis.genesisDataHash }),
  1: envelope({ id: 1, number: 1, hash: stabilisedGenesis.blockOneHash, content: { previousHash: stabilisedGenesis.genesisHash }, status: 'confirmed', proposer: 'TEST-proposer', next_proposer: 'TEST-next', validation_data: {}, attrs: {} }),
});
/** The shared reader over `replies`; `reads` traces the request keys in order. `receiptContext` and `getContext` steer the reconnect cases. */
export function stabilisedShared({ replies = stabilisedReplies(), policy = stabilisedGenesis, getContext = () => ({ ...local }), receiptContext = () => ({ ...local }), getReply, timeoutMs = 10_000 } = {}) {
  const reads = [];
  const read = async key => {
    reads.push(key);
    const value = getReply ? await getReply(key) : replies[key];
    return { value: structuredClone(value), context: receiptContext(key), observedAt: NOW, fromCache: false, redirected: false };
  };
  const binder = createDemosNetworkBinder({ expected, stabilisedGenesis: policy, now: () => NOW, timeoutMs, reader: {
    getContext, getBlockByNumber: height => read(height), getChainIdentity: () => read('chainIdentity'),
  } });
  return { binder, reads };
}

// Synthetic nine-field block two, chained to the unchanged dated block one.
// Its hash is a test pin, not captured evidence from a node.
export const syntheticTwo = envelope({ id: 3, number: 2, hash: hash('TEST-synthetic-reviewed-block-two'), content: { previousHash: captured.one.response.hash }, status: 'confirmed', proposer: 'TEST-proposer', next_proposer: 'TEST-next', validation_data: {}, attrs: {} });
/** The native transport over scripted replies: the literal-error chain by default, the synthetic stabilised-genesis chain with `stabilised`. */
export function native(t, { stabilised = false } = {}) {
  const replies = new Map(stabilised
    ? Object.entries(stabilisedReplies()).map(([key, value]) => [key === 'chainIdentity' ? key : Number(key), value])
    : [[0, structuredClone(captured.zero)], ['0', structuredClone(captured.genesis)], [1, structuredClone(captured.one)], [2, structuredClone(syntheticTwo)]]);
  const identityOptions = stabilised ? { stabilisedGenesis }
    : { fallback, blockZeroErrorEnvelope: DEVNET_NODE2_BLOCK_ZERO_ERROR_ENVELOPE, blockOneLayout: DEVNET_NODE2_BLOCK_LAYOUT, reviewedBlockTwoHash: syntheticTwo.response.hash };
  const heights = [], messages = [], rows = new Map();
  let effects = 0;
  const journal = { get: async key => rows.get(key), put: async () => { effects++; throw Error('TEST-write-forbidden'); }, entries: async () => [], withWalletLock: (_key, work) => work() };
  const transport = createDevnetSettlementTransport({ expected, ...identityOptions, journal, now: () => NOW,
    settlementPublication: { policy: 'dacs-native-settlement-publication/v1', artifactKind: 'SettlementEvidence', phase: 'pay-dem', phaseIndex: 2, railId: 'demos-native:DEM', authority: 'TEST-identity-read' },
    transportOwner: { getContext: () => ({ ...local }), acquireConnectionFence: () => ({ context: { ...local }, release() {} }) },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body), call = body.params[0];
      assert.equal(body.method, 'nodeCall', 'identity tests must never execute');
      messages.push(call.message);
      const key = call.message === 'getChainIdentity' ? 'chainIdentity' : call.data?.blockNumber;
      if (call.message !== 'getBlockByNumber' && key !== 'chainIdentity') return new Response(JSON.stringify(envelope({ state: 'included' })), { headers: { 'content-type': 'application/json' } });
      heights.push(key);
      const answer = replies.get(key);
      if (answer instanceof Error) throw answer;
      return new Response(typeof answer === 'string' ? answer : JSON.stringify(answer), { headers: { 'content-type': 'application/json' } });
    },
  });
  t.after(() => transport.close());
  const recover = async binding => {
    const tx = { hash: hash('TEST-retained-storage-create'), content: { type: 'storageProgram', from: `0x${hash('TEST-storage-writer')}`, nonce: 1, data: ['storageProgram', { metadata: { artifactKind: 'SettlementEvidence' }, data: { phase: 'pay-dem' } }] } };
    const retained = { hash: tx.hash, signedTransaction: tx, nonce: 1, stage: 'broadcast-accepted', storageWriteSubmission: 'accepted', storageWriteSubmissionProfile: 'hash-or-validator-relay/v3', storageWriteResends: 0, storageWriteGas: null, networkBinding: binding };
    rows.set(`devnet/native-transfer/${tx.hash}`, retained);
    rows.set(`devnet/native-wallet/${JSON.stringify([expected.network, expected.chainIdentity, tx.content.from])}`, retained);
    messages.length = 0; heights.length = 0;
    const result = await transport.recoverStorageWrite({ signedTransaction: tx, signRpc: () => { effects++; throw Error('TEST-sign-forbidden'); } });
    assert.equal(result.noResend, true);
    return messages.includes('getTransactionStatus');
  };
  return { transport, replies, heights, recover, effects: () => effects };
}

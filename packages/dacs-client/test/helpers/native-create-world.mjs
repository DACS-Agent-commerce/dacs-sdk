// Offline native transport (the demo composition, which carries CREATE recovery)
// over a scripted TEST node. The wallet is deterministic so a parent test and a
// killed child agree on the address and on every signed byte. The connection
// fence queues, as a real shared connection would. No network, chain or funds.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { contentHash, finalityCommitmentAddress, FINALITY_COMMITMENT_SEPARATOR, logicalToStorageProgramName, signComponentArtifact } from '@kynesyslabs/dacs';
import { buildStorageProgramCreatePayload, deriveStorageAddress } from '../../src/dacs/wallet-transactions.mjs';
import { STORAGE_WRITE_SUBMISSION_PROFILE } from '../../src/devnet-demo/storage-write-recovery.mjs';
import { createDevnetDemoTransport, DEVNET_DELIVERY_POLICY, DEVNET_DEMO_ARTIFACT_POLICY, DEVNET_DEMO_ARTIFACT_TYPES, DEVNET_SETTLEMENT_POLICY } from '../../src/wallet/devnet-native-transport.mjs';

export const NOW = 1_900_000_000_000;
export const JOB_IDS = Object.freeze(['01ARZ3NDEKTSV4RRFFQ69G5FAV', '01ARZ3NDEKTSV4RRFFQ69G5FAW']);
const PINS = { network: 'testnet', chainIdentity: 'c'.repeat(64), pinVersion: 'TEST-lock-order-pins', endpoint: 'https://rpc.invalid/', transportAuthority: 'TEST-lock-order-owner' };
const CONTEXT = { network: PINS.network, endpoint: PINS.endpoint, transportAuthority: PINS.transportAuthority, connectionId: 'TEST-connection' };
const DEMO_AUTHORITY = 'TEST-RUN-lock-order-0001';
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const reply = (response, extra = null) => ({ result: 200, response, require_reply: false, extra });

/** Which operation is running; the counters below tag each acquisition with it. */
export const operation = new AsyncLocalStorage();

/** The same wallet in every process: address, DID claim and signing functions. */
function deterministicWallet() {
  const privateKey = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.alloc(32, 7)]), format: 'der', type: 'pkcs8' });
  const raw = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(12);
  return {
    address: `0x${raw.toString('hex')}`,
    claim: `did:demos:agent:${raw.toString('hex')}`,
    signText: (message) => sign(null, Buffer.from(message, 'utf8'), privateKey).toString('hex'),
    signHex: (message) => `0x${sign(null, Buffer.from(message, 'utf8'), privateKey).toString('hex')}`,
    signBytes: (bytes) => sign(null, Buffer.from(bytes), privateKey),
  };
}

/** A connection owner whose fence queues. `events` receives { op, kind: 'fence' } per acquisition; `queued()` resolves when an acquirer waits. */
export function queuingFenceOwner(events = []) {
  let tail = Promise.resolve(), waiting = 0, held = false;
  const watchers = [];
  return {
    events,
    isHeld: () => held,
    queued: () => (waiting > 0 ? Promise.resolve() : new Promise((resolve) => watchers.push(resolve))),
    getContext: () => ({ ...CONTEXT }),
    async acquireConnectionFence() {
      events.push({ op: operation.getStore(), kind: 'fence' });
      const previous = tail;
      let release;
      tail = new Promise((resolve) => { release = resolve; });
      waiting += 1;
      for (const wake of watchers.splice(0)) wake();
      await previous;
      waiting -= 1; held = true;
      let live = true;
      return { context: { ...CONTEXT }, release() { if (live) { live = false; held = false; release(); } } };
    },
  };
}

/** The journal with every wallet lane acquisition logged as { op, kind: 'lane', key }. */
export function countingJournal(journal, events) {
  return {
    get: (key) => journal.get(key),
    put: (key, value) => journal.put(key, value),
    entries: () => journal.entries(),
    withWalletLock(key, work) { events.push({ op: operation.getStore(), kind: 'lane', key }); return journal.withWalletLock(key, work); },
  };
}

/**
 * The transport and its test wallet over `journal`. `onNode(message, call)` runs
 * before the scripted node answers any call and may pause or kill the process.
 */
export function createWorld({ journal, owner = queuingFenceOwner(), onNode = async () => {} }) {
  const wallet = deterministicWallet();
  const sent = { confirms: [], broadcasts: [] };
  const answerNode = async (init) => {
    const body = JSON.parse(init.body), call = body.params[0], message = call.message ?? call.extra;
    await onNode(message, call);
    if (message === 'getBlockByNumber') return reply({ number: 0, status: 'confirmed', hash: PINS.chainIdentity }, '');
    if (message === 'getAddressNonce') return reply(0);
    if (message === 'getTransactionStatus') return reply({ state: 'unknown' }, '');
    if (message === 'getTxByHash') return { result: 400, response: 'error', require_reply: false, extra: null };
    if (message === 'confirmTx') {
      sent.confirms.push(call.data.hash);
      return reply({ data: { valid: true, reference_block: 0, message: 'TEST validated\n', gas_operation: null, transaction: call.data },
        signature: { type: 'ed25519', data: `0x${'11'.repeat(64)}` }, rpc_public_key: { type: 'ed25519', data: `0x${'22'.repeat(32)}` } });
    }
    if (message === 'broadcastTx') {
      const hash = call.data.response.data.transaction.hash;
      sent.broadcasts.push(hash);
      return reply({ hash });
    }
    throw new Error(`unexpected TEST node call ${message}`);
  };
  const fetchImpl = async (url, init) => new Response(JSON.stringify(await answerNode(init)), { headers: { 'content-type': 'application/json' } });
  const capability = createDevnetDemoTransport({ expected: PINS, transportOwner: owner, journal, fetchImpl, now: () => NOW, inclusionWaitMs: 0,
    settlementPublication: { artifactKind: 'SettlementEvidence', authority: 'TEST-lock-order-settlement', phase: 'pay-dem', phaseIndex: 2, policy: DEVNET_SETTLEMENT_POLICY, railId: 'demos-native:DEM' },
    deliveryPublication: { artifactKind: 'Deliverable', authority: 'TEST-lock-order-delivery', phase: 'deliver-storage-program', phaseIndex: 3, policy: DEVNET_DELIVERY_POLICY },
    demoArtifactPublication: { policy: DEVNET_DEMO_ARTIFACT_POLICY, artifactKinds: [...DEVNET_DEMO_ARTIFACT_TYPES], authority: DEMO_AUTHORITY } });
  const { address } = wallet;
  const laneKey = `devnet/native-wallet/${JSON.stringify([PINS.network, PINS.chainIdentity, address])}`;
  let stamp = 0;
  const auth = () => {
    const identity = `ed25519:${address}`, timestamp = String(NOW + (stamp += 1));
    return { identity, timestamp, signature: wallet.signText(sha(`${identity}:${timestamp}`)) };
  };
  // Binds once: a later bind would wait for the connection fence a lease holds.
  let bound;
  const binding = () => (bound ??= capability.binding({ phase: 'bind', address }).then((answer) => answer.binding));

  /** The signed admitted CREATE of one job at one account nonce. */
  async function makeCreate(jobId, nonce) {
    const logicalAddress = finalityCommitmentAddress(jobId);
    const artifact = await signComponentArtifact({ finalityCommitmentVersion: '1', jobId, agreementHash: 'a'.repeat(64),
      listingRef: { listingId: 'lock-order', version: 1, contentHash: 'b'.repeat(64) }, parties: [`did:demos:agent:${'b'.repeat(64)}`, wallet.claim],
      pattern: 'fixed-price', createdAt: NOW }, FINALITY_COMMITMENT_SEPARATOR, { algorithm: 'ed25519', signer: wallet.claim, sign: (bytes) => wallet.signBytes(bytes) });
    const programName = logicalToStorageProgramName(logicalAddress), storageAddress = deriveStorageAddress(address, programName, 1, '');
    const tx = buildStorageProgramCreatePayload({ from: address, storageAddress, programName, logicalAddress, signedListing: artifact, nonce, timestamp: NOW });
    tx.content.network = PINS.network; tx.content.chainIdentity = PINS.chainIdentity;
    Object.assign(tx.content.data[1].metadata, { artifactKind: 'FinalityCommitmentRecord', contentHash: contentHash(artifact),
      networkBinding: structuredClone(capability.profile('https://wallet.test').transportBinding),
      artifactBinding: { version: '1', policy: DEVNET_DEMO_ARTIFACT_POLICY, authority: DEMO_AUTHORITY, artifactKind: 'FinalityCommitmentRecord', jobId, logicalAddress, writer: wallet.claim } });
    tx.hash = sha(JSON.stringify(tx.content));
    tx.signature = { type: 'ed25519', data: wallet.signHex(tx.hash) };
    return tx;
  }

  return {
    capability, wallet, owner, sent, laneKey, makeCreate,
    /** Seeds the lane and intent rows of an issued `tx` as a prior run left them. */
    async retain(tx, stage) {
      const row = { hash: tx.hash, nonce: tx.content.nonce, stage, signedTransaction: structuredClone(tx), networkBinding: await binding(),
        storageWriteSubmission: 'accepted', storageWriteSubmissionProfile: STORAGE_WRITE_SUBMISSION_PROFILE, storageWriteGas: null };
      await journal.put(laneKey, row);
      await journal.put(`devnet/native-transfer/${tx.hash}`, row);
    },
    /** Takes the signature lease; it holds the connection fence until released. */
    async lease() { return capability.binding({ phase: 'signature', address, binding: await binding() }); },
    async confirm(tx) { return capability.rpc({ method: 'execute', params: [{ extra: 'confirmTx', data: tx }] }, auth()); },
    async broadcast({ leaseId }, confirmation, hash) {
      await capability.binding({ phase: 'broadcast', address, leaseId, hash });
      return capability.rpc({ method: 'execute', params: [{ extra: 'broadcastTx', data: confirmation }] }, auth());
    },
    release: ({ leaseId }) => capability.binding({ phase: 'release', address, leaseId }),
    readback: (hash) => capability.binding({ phase: 'readback', address, hash }),
    recover: (tx) => capability.recoverStorageWrite({ signedTransaction: tx, signRpc: async (message) => wallet.signHex(message) }),
  };
}

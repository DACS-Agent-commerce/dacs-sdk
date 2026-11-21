// The live SR-2 adapter takes its chain identity from the bindTp1Profile binding, reads the identity through the shared
// reader the host composition supplies, compares a counterparty's records on the shared tuple only, and verifies a CREATE's
// signature in the one form the node's getNetworkInfo gives.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';
import { TP1_APPROVED_IDENTITY_RECORD, TP1_REFUSED_FIXTURE_CHAIN_IDENTITIES } from '@kynesyslabs/dacs/wire';
import { buyer, NOW, seller } from './helpers/protocol-fixture.mjs';
import { readbackFixture } from './helpers/sr2-readback-fixture.mjs';
import { journalScope, liveAdapter, liveReadbackFixture, productionObserveIdentity, registeredSource, resign, sellerWalletWorld } from './helpers/sr2-live-fixture.mjs';

const { createDemosSr2Adapter, createInMemoryDemosSr2Journal, DEMOS_SR2_FIXTURE_CHAIN_IDENTITY } = await import('../src/dacs/demos-sr2-adapter.mjs');
const { TP1_REVIEWED_BLOCK_TWO_HASH } = await import('../../dacs-client/src/wallet/devnet-native-transport.mjs');

const CHAIN = TP1_APPROVED_IDENTITY_RECORD.chainIdentity;
const OTHER_CHAIN = 'c'.repeat(64);
const read = (f, adapter, options = {}) => adapter.read(f.logicalAddress, { expectedWriter: f.expectedWriter, ...options });
const codeOf = (error) => error?.code;
const refusalOf = (work) => work.then(() => null, (error) => error);
const effectReads = (f) => f.state.calls.length;

test('the live SR-2 adapter takes its chain identity only from a bindTp1Profile binding, and the fixture chain refuses tp1_identity_fixture', async (t) => {
  const world = await sellerWalletWorld(t);
  const source = world.wallet.sourceCapability, binding = world.admission.binding, observeIdentity = async () => CHAIN;
  const build = (sourceCapability, options = {}) => () => createDemosSr2Adapter({ rpcUrl: source.pins.endpoint, journal: createInMemoryDemosSr2Journal(), sourceCapability, binding, observeIdentity, ...options });
  assert.equal(binding.profile.chainIdentity, source.pins.chainIdentity);
  assert.equal(typeof build(registeredSource(world))().read, 'function', 'a binding that agrees with the source pin builds the adapter');
  assert.ok(TP1_REFUSED_FIXTURE_CHAIN_IDENTITIES.includes(DEMOS_SR2_FIXTURE_CHAIN_IDENTITY), "the wire's refused list names the kit's fixture chain");
  const fixturePinned = registeredSource(world, { pins: Object.freeze({ ...source.pins, chainIdentity: DEMOS_SR2_FIXTURE_CHAIN_IDENTITY }) });
  assert.throws(build(fixturePinned), { code: 'tp1_identity_fixture' }, 'a source pinned to the fixture chain');
  const fixtureBound = { profile: { ...binding.profile, chainIdentity: DEMOS_SR2_FIXTURE_CHAIN_IDENTITY }, localDigest: binding.localDigest };
  assert.throws(build(registeredSource(world), { binding: fixtureBound }), { code: 'tp1_identity_fixture' }, 'a binding to the fixture chain');
  const otherBound = { profile: { ...binding.profile, chainIdentity: OTHER_CHAIN }, localDigest: binding.localDigest };
  assert.throws(build(registeredSource(world), { binding: otherBound }), { code: 'invalid-chain' }, 'a binding that names another chain than the source pin');
  for (const missing of [{ binding: undefined }, { binding: null }, { binding: {} }, { observeIdentity: undefined }]) {
    assert.throws(build(registeredSource(world), missing), { name: 'TypeError' }, `live mode without ${Object.keys(missing)[0]}`);
  }
});

test('the fixture SR-2 mode stays loopback-only and never yields a finalized receipt', async () => {
  const journal = createInMemoryDemosSr2Journal();
  for (const rpcUrl of ['https://127.0.0.1:9922/', 'http://127.0.0.1:9922/path', 'http://127.0.0.1:9922/?query', 'http://example.invalid/']) {
    assert.throws(() => createDemosSr2Adapter({ rpcUrl, journal }), { code: 'offline-only' }, rpcUrl);
  }
  const f = readbackFixture(), result = await read(f, f.adapter);
  assert.equal(result.evidenceMode, 'simulated-fixture');
  assert.equal(result.receipt.state, 'included');
  assert.equal(result.demosEvidence.state, 'included');
  assert.equal(result.receipt.substrate, 'demos-sr2-simulated-fixture');
});

// The recorded Node2 replies: the four-field block-zero error, blocks one and two, and the string "0" genesis.
const recorded = (file) => JSON.parse(JSON.parse(readFileSync(new URL(`../../../conformance/${file}`, import.meta.url))).body);
const RECORDED_BLOCKS = ['tp1-node-observations/block0-2026-10-20.json', 'tp1-node-observations/block1-2026-10-20.json', 'tp1-node-observations-2026-11-08/block2-2026-11-08.json'].map(recorded);
const RECORDED_GENESIS = recorded('tp1-node-observations/genesis-string-zero-2026-10-20.json');
const answerJson = (answer) => new Response(JSON.stringify(answer), { headers: { 'content-type': 'application/json' } });
// The node answers identity reads with the recorded replies, each changed by `mutate(answer, height)`, and lists the heights asked with their types.
function recordedNode(world, mutate = () => {}) {
  const heights = [];
  world.node.reply = (row) => {
    const call = row.body?.params[0];
    if (call?.message !== 'getBlockByNumber') return undefined;
    const height = call.data.blockNumber;
    heights.push(height);
    const answer = structuredClone(height === '0' ? RECORDED_GENESIS : RECORDED_BLOCKS[height]);
    mutate(answer, height);
    return answerJson(answer);
  };
  return heights;
}

test('through the kit composition and the shared reader, a numeric block 0 is refused, a confirmed block-one predecessor is used, a disagreeing string-zero genesis or an unconfirmed block one refuses; the recorded two-field genesis with its exact envelope binds; an altered hash, number, envelope or field set refuses before any effect; the labelled block-two control binds and each single change to it refuses; requested heights and types are asserted', async (t) => {
  const world = await sellerWalletWorld(t), shared = productionObserveIdentity(world), asked = [];
  const observeIdentity = async (options) => { asked.push(options); return shared(options); };
  const f = liveReadbackFixture(world), adapter = liveAdapter(world, registeredSource(world, { fixture: f }), { observeIdentity });
  const heights = recordedNode(world);
  assert.equal(await shared(), CHAIN, 'the recorded replies give the approved chain identity');
  assert.deepEqual(heights, [0, '0', 1, 2], 'the node refuses numeric 0, which is asked apart from string "0"; block one and block two follow');
  assert.equal((await read(f, adapter)).status, 'present', 'the recorded replies bind and the CREATE reads');
  assert.equal(asked.length, 1, "the shared reader's observation is asked once for the whole read");
  const refused = {
    'another block-zero error': [(answer, height) => { if (height === 0) answer.extra = 'Unknown block'; }, 'indeterminate'],
    'a string-zero genesis that disagrees': [(answer, height) => { if (height === '0') answer.response.hash = OTHER_CHAIN; }, 'indeterminate'],
    'a genesis with another number': [(answer, height) => { if (height === '0') answer.response.number = 7; }, 'indeterminate'],
    'a genesis with another field set': [(answer, height) => { if (height === '0') answer.response.status = 'confirmed'; }, 'indeterminate'],
    'a genesis with another envelope': [(answer, height) => { if (height === '0') answer.extra = 'TEST-changed'; }, 'indeterminate'],
    'the two-field block-zero error': [(answer, height) => { if (height === 0) { delete answer.extra; delete answer.require_reply; } }, 'indeterminate'],
    'an unconfirmed block one': [(answer, height) => { if (height === 1) answer.response.status = 'pending'; }, 'indeterminate'],
    'a block one with another predecessor': [(answer, height) => { if (height === 1) answer.response.content.previousHash = OTHER_CHAIN; }, 'indeterminate'],
    'a block two with another predecessor': [(answer, height) => { if (height === 2) answer.response.content.previousHash = OTHER_CHAIN; }, 'indeterminate'],
    'a block two with another hash': [(answer, height) => { if (height === 2) answer.response.hash = 'f'.repeat(64); }, 'indeterminate'],
    'a block two with another field set': [(answer, height) => { if (height === 2) delete answer.response.attrs; }, 'indeterminate'],
  };
  for (const [label, [mutate, code]] of Object.entries(refused)) {
    const reads = effectReads(f);
    recordedNode(world, mutate);
    const error = await refusalOf(read(f, adapter));
    assert.equal(codeOf(error), code, `${label}: ${error?.message}`);
    assert.equal(effectReads(f), reads, `${label}: no transaction or storage read followed`);
  }
  assert.equal(TP1_REVIEWED_BLOCK_TWO_HASH, RECORDED_BLOCKS[2].response.hash, 'the block-two control is the reviewed one');
});

test("a fresh observation from the seller's RPC is compared with the record and never authorizes", async (t) => {
  const world = await sellerWalletWorld(t);
  const f = liveReadbackFixture(world), source = registeredSource(world, { fixture: f });
  const reading = (observeIdentity) => refusalOf(read(f, liveAdapter(world, source, { observeIdentity })));
  const refusedIdentity = await reading(async () => OTHER_CHAIN);
  assert.equal(codeOf(refusedIdentity), 'invalid-chain', 'an observation of another chain than the binding');
  assert.equal(codeOf(await reading(async () => undefined)), 'invalid-chain', 'a connection the reader cannot authenticate');
  const unreachable = new Error('TEST observation unreachable');
  const failed = await reading(async () => { throw unreachable; });
  assert.deepEqual([codeOf(failed), failed.cause], ['indeterminate', unreachable], 'a failed observation keeps its cause');
  assert.equal(effectReads(f), 0, 'no refused observation was followed by a read');
  const otherChainRecord = liveReadbackFixture(world);
  resign(otherChainRecord, (content) => { content.chainIdentity = OTHER_CHAIN; });
  const record = await refusalOf(read(otherChainRecord, liveAdapter(world, registeredSource(world, { fixture: otherChainRecord }), { observeIdentity: async () => CHAIN })));
  assert.equal(codeOf(record), 'invalid', 'a matching observation does not make a record of another chain verify');
  const empty = liveReadbackFixture(world);
  empty.state.rows = [];
  const absent = await refusalOf(read(empty, liveAdapter(world, registeredSource(world, { fixture: empty }), { observeIdentity: async () => CHAIN })));
  assert.equal(absent?.observation, 'name-index-miss', 'a matching observation proves no record is present');
});

test('a counterparty record written through another endpoint on the same chain verifies; changing the seller\'s own endpoint invalidates only the seller', async (t) => {
  const world = await sellerWalletWorld(t);
  const source = world.wallet.sourceCapability, otherEndpoint = { ...source.transportBinding, endpoint: 'https://another.example.invalid/', bindingId: 'e'.repeat(64) };
  const counterparty = liveReadbackFixture(world, { networkBinding: otherEndpoint }), own = liveReadbackFixture(world);
  const verifiesFor = (f, ownWriter, sourceCapability = registeredSource(world, { fixture: f })) => refusalOf(read(f, liveAdapter(world, sourceCapability, { ownWriter })));
  assert.equal(await verifiesFor(own, seller.claim), null, "the seller's own record verifies through its own binding");
  assert.equal(await verifiesFor(counterparty, buyer.claim), null, "a counterparty's record written through another endpoint verifies");
  assert.equal(codeOf(await verifiesFor(counterparty, seller.claim)), 'invalid', "the seller's own record is held to its own binding exactly");
  const movedBinding = { ...source.transportBinding, endpoint: 'https://moved.example.invalid/' };
  const moved = (f) => registeredSource(world, { fixture: f, transportBinding: movedBinding, observeBinding: async (options) => ({ ...(await source.observeBinding(options)), endpoint: movedBinding.endpoint }) });
  assert.equal(codeOf(await verifiesFor(own, seller.claim, moved(own))), 'invalid', "the seller's own record no longer verifies after its endpoint changes");
  assert.equal(await verifiesFor(counterparty, buyer.claim, moved(counterparty)), null, "a counterparty's record still verifies after the seller's endpoint changes");
  const otherNetwork = liveReadbackFixture(world, { networkBinding: { ...otherEndpoint, pinVersion: 'TEST-retired-pin' } });
  assert.equal(codeOf(await verifiesFor(otherNetwork, buyer.claim)), 'invalid', "a counterparty's record on another pin version is refused");
});

const activeFork = (chainId, activationHeight = 0) => ({ forks: { osDenomination: { activated: true }, signatureDomain: { activated: true, activationHeight } }, chainId });
const chainBound = (chainId) => Object.assign((hash) => `demos-tx:v1:${chainId}:${hash}`, { chainId });
const UNREADABLE_ANSWERS = [null, {}, activeFork(null), activeFork(-1), activeFork(2 ** 53), activeFork('7'), activeFork(7, null)];
const refused = (error) => error?.code === 'invalid' && /exact writer authorization/.test(error.message);

const INACTIVE_FORK = { forks: { osDenomination: { activated: true } } };

// Each lane judges the same signed CREATE while the node answers `networkInfo`. `messageOf` is what the CREATE's signature covers.
// A receipt can only be made while the node's answer accepts its signature, so the creation lane makes its receipt under the answer that
// accepts it and then asks the node's answer to change.
const LANES = {
  async creation(world, { networkInfo, messageOf }) {
    const f = liveReadbackFixture(world, { networkInfo: messageOf ? activeFork(messageOf.chainId) : INACTIVE_FORK, messageOf });
    const adapter = liveAdapter(world, registeredSource(world, { fixture: f })), { receipt } = await read(f, adapter);
    f.state.networkInfo = networkInfo;
    return adapter.verifyReceipt({ receipt, logicalAddress: f.logicalAddress, artifact: f.artifact, expectedWriter: f.expectedWriter });
  },
  async readback(world, { networkInfo, messageOf }) {
    const f = liveReadbackFixture(world, { networkInfo, messageOf });
    return refusalOf(read(f, liveAdapter(world, registeredSource(world, { fixture: f })))).then((error) => error ?? 'present');
  },
  async adoption(world, { networkInfo, messageOf }) {
    const f = liveReadbackFixture(world, { networkInfo, messageOf }), journal = createInMemoryDemosSr2Journal(), source = registeredSource(world, { fixture: f });
    journal.put({ planId: 'TEST-adopted', scope: journalScope(source), logicalAddress: f.logicalAddress, writer: seller.claim, nativeAddress: f.native.storageAddress,
      authorizationProfile: 'embedded-storage-anchor-create', authorizedTransaction: structuredClone(f.signed), authorizationMessage: f.signed.hash,
      envelopeHash: sha256Hex(canonicalize(f.artifact)), hash: f.signed.content.data[1].metadata.contentHash, artifactKind: 'Deliverable' });
    return refusalOf(read(f, liveAdapter(world, source, { journal }))).then((error) => error ?? 'present');
  },
};
function verdict(answer) {
  if (answer === 'valid' || answer === 'present') return 'accepted';
  if (answer === 'invalid' || refused(answer)) return 'refused';
  if (answer === 'indeterminate' || answer?.code === 'indeterminate') return 'unverified';
  return `unexpected ${answer?.code ?? answer}`;
}

for (const lane of Object.keys(LANES)) {
  test(`${lane} verifies a CREATE's signature only in the form the node's getNetworkInfo gives: fork inactive, the bare hash; fork active, demos-tx:v1:<chainId>:<hash>; an unreadable or malformed answer verifies nothing`, async (t) => {
    const world = await sellerWalletWorld(t);
    const judged = async (networkInfo, messageOf) => verdict(await LANES[lane](world, { networkInfo, messageOf }));
    assert.equal(await judged(INACTIVE_FORK, undefined), 'accepted', 'inactive fork, bare hash');
    assert.equal(await judged(INACTIVE_FORK, chainBound(7)), 'refused', 'inactive fork, chain-bound message');
    assert.equal(await judged(activeFork(7), chainBound(7)), 'accepted', 'active fork, chain-bound message');
    assert.equal(await judged(activeFork(7), undefined), 'refused', 'active fork, bare hash');
    assert.equal(await judged(activeFork(7), chainBound(8)), 'refused', 'active fork, another chain id');
    for (const networkInfo of UNREADABLE_ANSWERS) assert.equal(await judged(networkInfo, undefined), 'unverified', JSON.stringify(networkInfo));
  });
}

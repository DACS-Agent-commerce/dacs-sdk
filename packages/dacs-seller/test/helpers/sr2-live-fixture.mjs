// Unshipped test helper: the live SR-2 adapter over the seller wallet's real source capability. The identity comes from the
// client's production authority reader, as the host composition supplies it; the CREATE the adapter reads comes from the
// SR-2 readback fixture, answered through a registered copy of the source whose `readRpc` is the fixture's node.
import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';
import { TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';
import { sellerWalletWorld } from './seller-node-wallet-world.mjs';

// The world's client fixtures install the purchase-admission double first, so every module that reaches the client loads after it.
const { NOW, seller } = await import('./protocol-fixture.mjs');
const { readbackFixture } = await import('./sr2-readback-fixture.mjs');
const { createAuthorityReader } = await import('../../../dacs-client/src/wallet/authority-reader.mjs');
const { createNodeAuthorityCapability } = await import('../../../dacs-client/src/wallet/node-wallet-session.mjs');
const { registerHeldTransportFacade } = await import('../../../dacs-client/src/wallet/devnet-native-transport.mjs');
const { createDemosSr2Adapter, createInMemoryDemosSr2Journal } = await import('../../src/dacs/demos-sr2-adapter.mjs');

export { sellerWalletWorld };
export const ADAPTER_TIMEOUT_MS = 5_000;

/** `observeIdentity` as the host composition builds it: the production authority reader's connection decision on the world's own connection. */
export function productionObserveIdentity(world) {
  const authority = createNodeAuthorityCapability({ owner: world.owner, claim: () => { throw new Error('TEST the connection decision reads no claim'); } });
  const connectionAuthority = createAuthorityReader({ authority, identityRecord: TP1_APPROVED_IDENTITY_RECORD, claim: authority.claim, listings: { isRegistered: () => false },
    purchases: { findByJobId: () => null }, participantImplementations: { entriesFor: () => [] } });
  return async () => (await connectionAuthority({ local: world.owner.currentLocal(), sessionId: null, participants: [] }))?.chainIdentity;
}

/**
 * The world's source capability registered again with `overrides` (frozen, as the client registers its facade). Reads are answered by the
 * readback fixture's node when `fixture` is given.
 */
export function registeredSource(world, { fixture = null, ...overrides } = {}) {
  const source = world.wallet.sourceCapability;
  const readRpc = fixture === null ? source.readRpc : async (path, body) => (await fixture.fetchImpl(new URL(path, source.pins.endpoint).href,
    { method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).json();
  const facade = Object.freeze({ ...source, readRpc, ...overrides });
  registerHeldTransportFacade(facade, source);
  return facade;
}

/** A live adapter over `sourceCapability` with the world's binding and the production identity reader; `options` replace any input. */
export function liveAdapter(world, sourceCapability, options = {}) {
  return createDemosSr2Adapter({ rpcUrl: sourceCapability.pins.endpoint, journal: createInMemoryDemosSr2Journal(), sourceCapability, binding: world.admission.binding,
    observeIdentity: productionObserveIdentity(world), now: () => NOW, timeoutMs: ADAPTER_TIMEOUT_MS, ...options });
}

/** Signs the fixture's CREATE again after `change(content)`, over `messageOf(hash)` (the bare hash by default), and updates the node's copies. */
export function resign(f, change = () => {}, messageOf = (hash) => hash) {
  const op = f.signed.content.data[1];
  change(f.signed.content);
  f.signed.hash = sha256Hex(JSON.stringify(f.signed.content));
  f.signed.signature.data = `0x${seller.signBytes(Buffer.from(messageOf(f.signed.hash))).toString('hex')}`;
  Object.assign(f.tx, structuredClone(f.signed), { status: 'confirmed', blockNumber: 1 });
  f.native.metadata = structuredClone(op.metadata);
  f.native.createdByTx = f.signed.hash;
  f.native.interactionTxs = [f.signed.hash];
  f.block.content.ordered_transactions = [f.signed.hash];
  f.block.validation_data = { simulated: true };
}

/** The readback fixture's CREATE as the artifact anchor writes it: the pinned network and chain in its content, and the source's binding in its metadata. */
export function liveReadbackFixture(world, { networkInfo, networkBinding, messageOf } = {}) {
  const source = world.wallet.sourceCapability, f = readbackFixture(networkInfo === undefined ? {} : { networkInfo });
  resign(f, (content) => {
    content.network = source.pins.network;
    content.chainIdentity = source.pins.chainIdentity;
    content.data[1].metadata.networkBinding = structuredClone(networkBinding ?? source.transportBinding);
  }, messageOf);
  return f;
}

/** The scope key the adapter keeps its own journal rows under, for a seller whose source is `source`. */
export const journalScope = (source) => canonicalize([new URL(source.pins.endpoint).origin, source.pins.chainIdentity, source.transportBinding.bindingId]);

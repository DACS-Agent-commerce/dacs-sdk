// Unshipped test helper: the seller's chain readers over a seller wallet world whose source serves the seller's signed revocation
// marker for the fixture Listing through the SR-2 readback fixture, with the production connection reader as `observeIdentity`.
import { sellerWalletWorld } from './sr2-live-fixture.mjs';

// The world's client fixtures install the purchase-admission double first, so every module that reaches the client loads after it.
const { contentHash, encodeAddressSegment, signComponentArtifact } = await import('@kynesyslabs/dacs');
const { productionObserveIdentity, registeredSource, resign } = await import('./sr2-live-fixture.mjs');
const { readbackFixture } = await import('./sr2-readback-fixture.mjs');
const { NOW, JOB, protocolFixture, seller } = await import('./protocol-fixture.mjs');
const { createNodeChainReaders } = await import('../../src/devnet-demo/node-chain-readers.mjs');
const { listingRevocationProblem } = await import('../../src/dacs/session-admission.mjs');

const fx = await protocolFixture();

/**
 * A seller wallet world whose source serves the seller's signed revocation marker for the fixture Listing at its marker address.
 * `alterMarker(marker)` (sync or async) changes the signed marker before it is written into the fixture's CREATE, `change(fixture)` changes the
 * fixture after it is signed, and with `storageMiss` the node answers every native storage read 404.
 * The world records each `readRpc` call of its readers in `world.rpc` as `{ path, body, options }`; `world.answer(path, body, options)`,
 * when set, answers a call first unless it returns undefined. `world.chain({ pins, binding })` is a finalized-session thunk over a
 * source registered with those pins, `world.readers({ pins, binding, trustedFinality })` the chain readers over it, and
 * `world.coreCheck(readers)` the core's revocation check over them.
 */
export async function markerWorld(t, { change = () => {}, storageMiss = false, alterMarker = (marker) => marker } = {}) {
  const world = await sellerWalletWorld(t), source = world.wallet.sourceCapability;
  const listingPin = { listingId: fx.listing.listingId, version: fx.listing.listingVersion, contentHash: contentHash(fx.listing) };
  const marker = await alterMarker(await signComponentArtifact({ listingId: listingPin.listingId, listingVersion: listingPin.version, listingContentHash: listingPin.contentHash,
    revokedAt: NOW - 1, reason: 'TEST withdrawn' }, 'dacs-revocation:v1:', { algorithm: 'ed25519', signer: seller.claim, sign: seller.signBytes }));
  const logicalAddress = `dacs1-revoked:${encodeAddressSegment(seller.claim)}:${listingPin.listingId}:v${listingPin.version}`;
  const f = readbackFixture({ logicalAddress, artifact: marker, artifactKind: 'RevocationMarker' });
  resign(f, (content) => { content.network = source.pins.network; content.chainIdentity = source.pins.chainIdentity; content.data[1].metadata.networkBinding = structuredClone(source.transportBinding); });
  change(f);
  Object.assign(world, { fixture: f, listingPin, marker, logicalAddress, rpc: [], answer: null });
  const served = registeredSource(world, { fixture: f });
  const readRpc = async (path, body, options) => {
    world.rpc.push({ path, body: structuredClone(body), options });
    const answered = await world.answer?.(path, body, options);
    if (answered !== undefined) return answered;
    if (storageMiss && path.startsWith('/storage-program/')) throw Object.assign(new Error('TEST storage program not found'), { status: 404 });
    return served.readRpc(path, body, options);
  };
  world.chain = ({ pins, binding = world.admission.binding } = {}) => () => Object.freeze({ anchor: null,
    transport: registeredSource(world, { readRpc, ...(pins ? { pins: Object.freeze({ ...source.pins, ...pins }) } : {}) }), binding, observeIdentity: productionObserveIdentity(world),
    clock: { now: () => NOW } });
  world.readers = ({ pins, binding, trustedFinality } = {}) => createNodeChainReaders({ claim: () => seller.claim, chain: world.chain({ pins, binding }),
    ...(trustedFinality === undefined ? {} : { trustedFinality }) });
  world.coreCheck = (readers) => listingRevocationProblem(readers.sessionAdmission, { listing: fx.listing, listingPin, jobId: JOB, now: () => NOW });
  return world;
}

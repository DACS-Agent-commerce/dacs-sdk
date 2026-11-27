// The passive Listing reader: one read-only connection to a node on the approved TP-1 chain, over which a published Listing is
// read back and authenticated. It opens no wallet, key, journal or anchor, signs nothing and recovers nothing.
import { TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';
import { createNodeObserver, createNodeTransportOwner } from '@kynesyslabs/dacs-client/node-wallet';
import { createDemosSr2Adapter, createInMemoryDemosSr2Journal } from '../dacs/demos-sr2-adapter.mjs';

// The transport authority of the reader's own connection; it names that connection and binds nothing.
const PASSIVE_LISTING_READER_AUTHORITY = 'dacs-passive-listing-reader';

/**
 * Opens one read-only connection to `endpoint` (a canonical https root, or http only for the approved TP-1 testnet) and returns
 * frozen `{ readPublishedListing, close }`. Throws OperationError(transport_mismatch) for another endpoint or a `fetchImpl` that is
 * not a function, before any read.
 *
 * `readPublishedListing({ logicalAddress, writer, signedProjection, nativeAddress, signal })` first checks the node's chain against
 * the approved identity record, then reads the Listing CREATE of `writer` and authenticates it against the included transaction
 * and, when given, the writer's `signedProjection`. It resolves frozen `{ status: 'present', listing, receipt, demosEvidence,
 * evidenceMode, finality: 'not-established' }`: the receipt keeps the Demos labels but the read establishes no finality. It
 * rejects with the SR-2 adapter's `DemosSr2Error` (`writer-required`, `invalid`, or `indeterminate` with its cause, also for a node
 * on another chain), with `signal`'s reason once it is aborted, and with transport_closed after `close()`. Each reply is limited
 * to 1 MiB, each name-index page to 50 rows, and each read to one 10 s deadline. Nothing it reads is kept after the reader closes.
 */
export function createPassiveListingReader({ endpoint, fetchImpl } = {}) {
  const owner = createNodeTransportOwner({ endpoint, transportAuthority: PASSIVE_LISTING_READER_AUTHORITY, fetchImpl,
    chainIdentity: TP1_APPROVED_IDENTITY_RECORD.chainIdentity });
  const observer = createNodeObserver({ owner });
  const adapter = createDemosSr2Adapter({ rpcUrl: endpoint, journal: createInMemoryDemosSr2Journal(), fetchImpl: owner.fetchImpl,
    identityRecord: TP1_APPROVED_IDENTITY_RECORD, observeIdentity: async ({ signal }) => (await observer.observe({ signal })).chainIdentity });

  async function readPublishedListing({ logicalAddress, writer, signedProjection, nativeAddress, signal } = {}) {
    signal?.throwIfAborted();
    owner.currentLocal();
    const { artifact, receipt, demosEvidence, evidenceMode } = await adapter.read(logicalAddress,
      { expectedWriter: writer, expectedArtifactKind: 'Listing', signedProjection, nativeAddress, signal });
    return Object.freeze({ status: 'present', listing: artifact, receipt, demosEvidence, evidenceMode, finality: 'not-established' });
  }

  return Object.freeze({ readPublishedListing, close: () => owner.close() });
}

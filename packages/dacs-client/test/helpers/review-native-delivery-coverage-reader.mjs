// Independent buyer-side observer for the coverage test. The original signed
// CREATE comes from the chain fixture's accepted-wire record, not from the
// seller journal; every read is a fresh read-only adapter with no write path.
import { createDemosSr2Adapter, createInMemoryDemosSr2Journal } from '../../src/dacs/demos-sr2-adapter.mjs';
import { createSourceNativeDeliveryProvider } from './native-dem-delivery-provider.mjs';

export const kindOf = (tx) => tx.content.data[1].metadata.artifactKind;

export function acceptedCreates(w) {
  return w.h.chain.wire.record.accepted;
}

export function freshReader(w) {
  return createDemosSr2Adapter({ rpcUrl: w.h.expected.endpoint, sourceCapability: w.h.capability,
    journal: { ...createInMemoryDemosSr2Journal(), put: async () => { throw new Error('coverage observer is read-only'); } } });
}

// projectionFor decides which signed bytes are offered as the public projection.
export function buyerProvider(w, projectionFor) {
  return createSourceNativeDeliveryProvider({
    bridge: { anchor: async () => { throw new Error('buyer observer never submits'); } },
    sourceCapability: () => w.h.capability, rpcUrl: w.h.expected.endpoint, writer: w.seller.wallet.claim,
    readSignedProjection: async (input) => projectionFor(input),
  });
}

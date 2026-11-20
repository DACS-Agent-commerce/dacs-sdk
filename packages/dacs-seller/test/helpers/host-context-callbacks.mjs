// Unshipped fixture: the callbacks the seller host takes from a context capability besides `resolveBuyer`, as no-ops pinned to the fixture seller,
// and the present answer a stand-in `resolveBuyer` gives.
import { createHash } from 'node:crypto';
import { seller } from './protocol-fixture.mjs';

const sha = (text) => createHash('sha256').update(String(text)).digest('hex');

export const HOST_CONTEXT_CALLBACKS = Object.freeze({ recoverBuyer: async () => null, resumableBuyer: async () => null, bindRetainedScope: () => ({ sellerBundlePresentedBy: seller.claim }) });

/** A present answer with both Vet records named, as the real provider answers a completed context step. */
export const presentContextAnswer = (input) => ({ disposition: 'present', value: { scope: structuredClone(input.scope), input: { jobId: input.scope.jobId,
  buyer: { vetRecordRef: { anchor: { kind: 'storage-program', locator: 'vet-buyer' }, contentHash: sha('vet-buyer') } },
  seller: { vetRecordRef: { anchor: { kind: 'storage-program', locator: 'vet-seller' }, contentHash: sha('vet-seller') } } } } });

// The real kit challenge handler and SQLite ledger, without the full host's unrelated effect journal.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listingPin as pinOf } from '../../../dacs-seller/src/dacs/purchase-protocol.mjs';
import * as wire from '@kynesyslabs/dacs/wire';
import { createSellerContextRoute } from '../../../dacs-seller/src/dacs/seller-context-route.mjs';
import { createSellerHttpHandler } from '../../../dacs-seller/src/dacs/seller-http.mjs';
import { createWireContext } from '../../../dacs-seller/src/dacs/seller-wire-requests.mjs';
import { createSellerTransportStore } from '../../../dacs-seller/test/helpers/bound-transport-store.mjs';
import { exchange } from '../../../dacs-seller/test/helpers/d5-http-fixture.mjs';
import { TEST_CONNECTION, authorityReader } from '../../../dacs-seller/test/helpers/wire-authority-fixture.mjs';

/** Builds only the kit's challenge route; any journal access fails the test. Returns a host factory for bootstrapWorld. */
export function challengeHostFor(t) {
  return async ({ listing, signer, now }) => {
    const directory = await mkdtemp(join(tmpdir(), 'TEST-bootstrap-challenge-'));
    const store = createSellerTransportStore({ path: join(directory, 'transport.sqlite'), now, contextSessionState: () => null,
      maxChallenges: 100, contextStartLimits: { maxStartsPerHour: 100, maxStartsPerBuyerPerHour: 100 } });
    t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
    const binding = await wire.bindTp1Profile({ record: wire.TP1_APPROVED_IDENTITY_RECORD, local: { ...TEST_CONNECTION }, readAuthority: authorityReader() });
    const listingPin = pinOf(listing);
    const agent = { claim: signer.claim, listingPin, transportAgreementOf: () => null, continuationEvidenceOf: () => null, retainsPaymentWork: () => true, assertSettlementCredit() {} };
    const journal = new Proxy({}, { get() { throw new Error('TEST the challenge route must not access an effect journal'); } });
    const context = createSellerContextRoute({ listing, now, assertBuyerAccess: async () => {}, knownJob: async () => true });
    const transport = createWireContext({ binding, tp1Network: { connection: () => ({ ...TEST_CONNECTION }) }, signer, store, journal,
      ready: () => true, stopped: () => false, now, agent, requireDelegation: true, readCommitmentReceipt: async () => 'valid' });
    const handler = createSellerHttpHandler(agent, { context, wire: transport });
    return { listingPin, url: listing.seller.publicEndpoint, close: async () => {}, async fetch(url, init) {
      const response = await exchange(handler, { url: new URL(url).pathname, text: init.body, headers: init.headers, method: init.method });
      return new Response(response.text, { status: response.status, headers: response.headers });
    } };
  };
}

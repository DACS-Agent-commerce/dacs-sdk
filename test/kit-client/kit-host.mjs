// The composed kit host on loopback (the kit's own commitment fixture and startSellerHost) and a client-signed way to reach it.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex } from '@kynesyslabs/dacs';
import { commitmentFixture } from '../../packages/dacs-seller/test/helpers/commitment-fixture.mjs';
import { NOW, buyer, seller } from '../../packages/dacs-seller/test/helpers/protocol-fixture.mjs';
import { testNetwork } from '../../packages/dacs-seller/test/helpers/wire-authority-fixture.mjs';
import { startSellerHost } from '../../packages/dacs-seller/src/host.mjs';
import { wireBuyer } from '../../packages/dacs-seller/test/helpers/wire-buyer.mjs';
import { createSellerTransportClientAuth, SELLER_TRANSPORT_HEADER } from '../../packages/dacs-client/src/dacs/seller-transport-auth.mjs';

/** Starts the kit's composed host over the kit's fixture capabilities; both are released when the test ends, whether it passes or fails. */
export async function composedKitHost(t) {
  const fixture = await commitmentFixture(t);
  const dataDirectory = await mkdtemp(join(tmpdir(), 'TEST-kit-client-host-'));
  // The fixture's agent options that the host does not take (it owns its directory and its challenge ledger, and has no early commit) are left out.
  const config = { ...fixture.config };
  const { nativeArtifactAnchor } = config;
  for (const key of ['durableDirectory', 'commitOnSignature', 'nativeArtifactAnchor', 'challengeLedger']) delete config[key];
  const host = await startSellerHost({ ...config, artifactAnchor: nativeArtifactAnchor, dataDirectory, tp1Network: testNetwork() });
  t.after(async () => { await host.close(); await rm(dataDirectory, { recursive: true, force: true }); });
  return { fixture, host, dataDirectory };
}

/** The client's request signer for the fixture's buyer, addressed to `host`'s seller and Listing. */
export const clientAuthFor = (host) => createSellerTransportClientAuth({ buyerSigner: { claim: buyer.claim, sign: buyer.signBytes }, seller: seller.claim,
  resolveJob: () => ({ listingPin: host.listingPin, agreementHash: sha256Hex('kit-client-host-agreement') }), now: () => NOW });

/** One client-signed POST to `host`: the status, the answer text and whether the answer carries a seller signature. */
export async function postSigned(host, auth, path, body) {
  const text = JSON.stringify(body);
  const { header } = await auth.request(path, body, text);
  const response = await fetch(host.url + path, { method: 'POST', headers: { 'content-type': 'application/json', [SELLER_TRANSPORT_HEADER]: header }, body: text });
  return { status: response.status, text: await response.text(), signed: response.headers.has(SELLER_TRANSPORT_HEADER) };
}


/** One POST of `text` to `host` under an already-built header: the status, the answer text and whether the answer carries a seller signature. */
export async function postHeader(host, path, header, text) {
  const response = await fetch(host.url + path, { method: 'POST', headers: { 'content-type': 'application/json', [SELLER_TRANSPORT_HEADER]: header }, body: text });
  return { status: response.status, text: await response.text(), signed: response.headers.has(SELLER_TRANSPORT_HEADER) };
}

/** A request for `path` that the fixture's buyer signs under the wire domain, for the job and Agreement hash it names: `{ payload, header, text }`. */
export async function wireSignedRequest(host, path, body, { jobId, agreementHash }) {
  const signer = (wallet) => ({ claim: wallet.claim, sign: wallet.signBytes });
  const buyerWire = await wireBuyer({ buyer: signer(buyer), seller: signer(seller), listingPin: host.listingPin, clock: () => NOW });
  return buyerWire.signRequest(path, body, { jobId, agreementHash });
}

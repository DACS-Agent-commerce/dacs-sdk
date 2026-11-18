// Unshipped fixture: a buyer that reaches a started seller host over loopback HTTP, and a context provider capability with every callback
// the host needs. The buyer signs the challenge and the context request through the wire, delegated to a session key.
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize, identityBundleHash, sha256Hex } from '@kynesyslabs/dacs';
import { DACS_SELLER_HTTP_DOMAINS, DACS_SELLER_HTTP_HEADER, DACS_SELLER_HTTP_PATHS, TP1_APPROVED_IDENTITY_RECORD, bindTp1Profile } from '@kynesyslabs/dacs/wire';
import { AGREEMENT_CONTEXT_SOURCE } from '../../src/dacs/agreement-context-consumer.mjs';
import { createDemDeliveryContext } from '../../src/dacs/dem-delivery-context-consumer.mjs';
import { purchaseSupport } from '../../src/dacs/listing.mjs';
import { KIT_TP1_VET_MODE, startSellerHost } from '../../src/host.mjs';
import { commitmentFixture } from './commitment-fixture.mjs';
import { presentationFor } from './context-wire-world.mjs';
import { HOST_CONTEXT_CALLBACKS } from './host-context-callbacks.mjs';
import { JOB, NOW, buyer, seller, testWallet } from './protocol-fixture.mjs';
import { TEST_CONNECTION, authorityReader, testNetwork } from './wire-authority-fixture.mjs';
import { wireBuyer } from './wire-buyer.mjs';

const DELEGATION_LEAD_MS = 30_000;
const DELEGATION_LIFETIME_MS = 3_600_000;
const sha = (text) => createHash('sha256').update(String(text)).digest('hex');
const signerOf = (wallet) => ({ claim: wallet.claim, sign: wallet.signBytes });

/** A present answer with both Vet records named, as the real provider answers a completed context step. */
export const presentContextAnswer = (input) => ({ disposition: 'present', value: { scope: structuredClone(input.scope), input: { jobId: input.scope.jobId,
  buyer: { vetRecordRef: { anchor: { kind: 'storage-program', locator: 'vet-buyer' }, contentHash: sha('vet-buyer') } },
  seller: { vetRecordRef: { anchor: { kind: 'storage-program', locator: 'vet-seller' }, contentHash: sha('vet-seller') } } } } });

/** A registered context capability in the host's Vet mode; `overrides` replace only the callbacks they name. */
export const contextCapability = (overrides = {}) => createDemDeliveryContext({ authority: 'TEST-host-context', vetMode: KIT_TP1_VET_MODE, resolveSeller: async () => null,
  resolveBuyer: async (input) => presentContextAnswer(input), ...HOST_CONTEXT_CALLBACKS, ...overrides });

/**
 * The kit's commitment fixture composed through `startSellerHost` with a complete context capability. `start(changes)` starts a host on the one
 * data directory (`changes` replace host options); every host it started is closed, and the directory removed, when the test ends.
 */
export async function contextHostFixture(t) {
  const f = await commitmentFixture(t, { vetMode: KIT_TP1_VET_MODE });
  const dataDirectory = await mkdtemp(join(tmpdir(), 'TEST-host-context-'));
  // The agent options the host does not take: it owns its directory, Vet mode and challenge ledger and has no early commit.
  const { nativeArtifactAnchor, ...config } = f.config;
  for (const key of ['durableDirectory', 'commitOnSignature', 'vetMode', 'challengeLedger']) delete config[key];
  const hosts = [];
  const start = async (changes = {}) => {
    const host = await startSellerHost({ ...config, artifactAnchor: nativeArtifactAnchor, dataDirectory, tp1Network: testNetwork(), demDeliveryContext: contextCapability(), ...changes });
    hosts.push(host);
    return host;
  };
  t.after(async () => { for (const host of hosts) await host.close().catch(() => {}); await rm(dataDirectory, { recursive: true, force: true }); });
  return { ...f, config, start, dataDirectory, buyerFor: (host) => hostBuyer(host, f.config.listing, { jobId: JOB }) };
}

/**
 * A buyer for `host`. `challenge(jobId)` posts the signed challenge request, `context(jobId, nonce)` the signed context request
 * over that challenge, and `requestContext(jobId)` both; each answers `{ status, text, body, signed }`.
 */
export async function hostBuyer(host, listing, { jobId: defaultJob }) {
  const binding = await bindTp1Profile({ record: TP1_APPROVED_IDENTITY_RECORD, local: { ...TEST_CONNECTION }, readAuthority: authorityReader() });
  const session = testWallet(99), support = purchaseSupport(listing);
  const wire = await wireBuyer({ buyer: signerOf(buyer), seller: signerOf(seller), listingPin: host.listingPin, clock: () => NOW });
  const scopeFor = (jobId) => ({ source: AGREEMENT_CONTEXT_SOURCE, wallet: buyer.address, jobId, buyer: buyer.claim, seller: seller.claim, listingPin: host.listingPin,
    rail: { railId: 'demos-native:DEM', railVersion: 1 }, payee: support.payee, price: support.price, generatedAt: NOW });
  const delegationFor = (jobId) => {
    const payload = { version: '1', kind: 'seller-session-delegation', buyer: buyer.claim, sessionPublicKey: session.claim.slice('did:demos:agent:'.length), seller: seller.claim,
      listingPin: host.listingPin, jobId, notBefore: NOW - DELEGATION_LEAD_MS, expiresAt: NOW + DELEGATION_LIFETIME_MS, profile: binding.profile };
    return { payload, signature: buyer.signBytes(Buffer.from(DACS_SELLER_HTTP_DOMAINS.delegation + canonicalize(payload))).toString('base64url') };
  };
  const send = async (path, jobId, body) => {
    const signed = await wire.signRequest(path, body, { jobId, agreementHash: sha256Hex(canonicalize(body.scope)), delegation: delegationFor(jobId), signer: signerOf(session), text: JSON.stringify(body) });
    const response = await fetch(host.url + path, { method: 'POST', headers: { 'content-type': 'application/json', [DACS_SELLER_HTTP_HEADER]: signed.header }, body: signed.text });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text), signed: response.headers.has(DACS_SELLER_HTTP_HEADER) };
  };
  const challenge = (jobId = defaultJob) => send(DACS_SELLER_HTTP_PATHS.contextChallenge, jobId, { scope: scopeFor(jobId) });
  const context = (jobId, nonce) => {
    const bundle = presentationFor(buyer, nonce, NOW);
    return send(DACS_SELLER_HTTP_PATHS.context, jobId, { scope: { ...scopeFor(jobId), buyerBundleHash: identityBundleHash(bundle) }, buyerIdentityBundle: bundle });
  };
  const requestContext = async (jobId = defaultJob) => {
    const issued = await challenge(jobId);
    if (issued.status !== 200) throw new Error(`TEST the challenge was refused: ${issued.text}`);
    return context(jobId, issued.body.sessionNonce);
  };
  return { challenge, context, requestContext };
}

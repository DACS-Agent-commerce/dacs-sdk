// Unshipped fixture: a buyer that reaches a started seller host over loopback HTTP, and a context provider capability with every callback
// the host needs. The buyer signs the challenge and the context request through the wire, delegated to a session key.
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
import { HOST_CONTEXT_CALLBACKS, presentContextAnswer } from './host-context-callbacks.mjs';
import { JOB, NOW, buyer, seller, testWallet } from './protocol-fixture.mjs';
import { hostAuthority } from './kit-wallet-session.mjs';
import { TEST_CONNECTION, authorityReader } from './wire-authority-fixture.mjs';
import { wireBuyer } from './wire-buyer.mjs';

const DELEGATION_LEAD_MS = 30_000;
const DELEGATION_LIFETIME_MS = 3_600_000;
const signerOf = (wallet) => ({ claim: wallet.claim, sign: wallet.signBytes });

export { presentContextAnswer };

/** A registered context capability in the host's Vet mode; `overrides` replace only the callbacks they name. */
export const contextCapability = (overrides = {}) => createDemDeliveryContext({ authority: 'TEST-host-context', vetMode: KIT_TP1_VET_MODE, resolveSeller: async () => null,
  resolveBuyer: async (input) => presentContextAnswer(input), ...HOST_CONTEXT_CALLBACKS, ...overrides });

/**
 * The kit's commitment fixture composed through `startSellerHost` with a complete context capability. `start(changes)` starts a host on the one
 * data directory (`changes` replace host options); every host it started is closed, and the directory removed, when the test ends.
 * A `publicEndpoint` is put in the Listing, so the host serves its discovery document there.
 */
export async function contextHostFixture(t, { publicEndpoint = null } = {}) {
  const f = await commitmentFixture(t, { vetMode: KIT_TP1_VET_MODE, publicEndpoint });
  const dataDirectory = await mkdtemp(join(tmpdir(), 'TEST-host-context-'));
  // The agent options the host does not take: it owns its directory, Vet mode and challenge ledger and has no early commit.
  const { nativeArtifactAnchor, ...config } = f.config;
  for (const key of ['durableDirectory', 'commitOnSignature', 'vetMode', 'challengeLedger']) delete config[key];
  const hosts = [];
  const start = async (changes = {}) => {
    const host = await startSellerHost({ ...config, artifactAnchor: nativeArtifactAnchor, dataDirectory, ...hostAuthority(), demDeliveryContext: contextCapability(), ...changes });
    hosts.push(host);
    return host;
  };
  t.after(async () => { for (const host of hosts) await host.close().catch(() => {}); await rm(dataDirectory, { recursive: true, force: true }); });
  return { ...f, config, start, dataDirectory, buyerFor: (host) => hostBuyer(host, f.config.listing, { jobId: JOB }) };
}

/**
 * A buyer for `host`. `challenge(jobId)` posts the signed challenge request, `context(jobId, nonce)` the signed context request
 * over that challenge, and `requestContext(jobId)` both; each answers `{ status, text, body, signed }`. Requests are delegated to a session
 * key; `{ delegated: false }` signs the context request with the buyer's own key instead. `scopeFor(jobId)` is the challenge scope the
 * buyer sends, and `admit(jobId)` the first admission a proposal needs. `connection` and `readAuthority` are the buyer's own (the
 * fixture authority by default). `signChallenge(jobId, options)` signs a challenge request without sending it, and `post(path, signed)`
 * sends a signed request as it is.
 */
export async function hostBuyer(host, listing, { jobId: defaultJob, buyer: buyerKey = buyer, seller: sellerKey = seller, clock = () => NOW,
  connection = () => ({ ...TEST_CONNECTION }), readAuthority = authorityReader() }) {
  const binding = await bindTp1Profile({ record: TP1_APPROVED_IDENTITY_RECORD, local: connection(), readAuthority });
  const session = testWallet(99), support = purchaseSupport(listing);
  const wire = await wireBuyer({ buyer: signerOf(buyerKey), seller: signerOf(sellerKey), listingPin: host.listingPin, clock, connection, readAuthority });
  const scopeFor = (jobId) => ({ source: AGREEMENT_CONTEXT_SOURCE, wallet: buyerKey.address, jobId, buyer: buyerKey.claim, seller: sellerKey.claim, listingPin: host.listingPin,
    rail: { railId: 'demos-native:DEM', railVersion: 1 }, payee: support.payee, price: support.price, generatedAt: clock() });
  const delegationFor = (jobId) => {
    const payload = { version: '1', kind: 'seller-session-delegation', buyer: buyerKey.claim, sessionPublicKey: session.claim.slice('did:demos:agent:'.length), seller: sellerKey.claim,
      listingPin: host.listingPin, jobId, notBefore: clock() - DELEGATION_LEAD_MS, expiresAt: clock() + DELEGATION_LIFETIME_MS, profile: binding.profile };
    return { payload, signature: buyerKey.signBytes(Buffer.from(DACS_SELLER_HTTP_DOMAINS.delegation + canonicalize(payload))).toString('base64url') };
  };
  const sign = (path, jobId, body, { delegated = true } = {}) => wire.signRequest(path, body, { jobId, agreementHash: sha256Hex(canonicalize(body.scope)),
    delegation: delegated ? delegationFor(jobId) : null, signer: signerOf(delegated ? session : buyerKey), text: JSON.stringify(body) });
  const post = async (path, signed, { signal } = {}) => {
    const response = await fetch(host.url + path, { method: 'POST', headers: { 'content-type': 'application/json', [DACS_SELLER_HTTP_HEADER]: signed.header }, body: signed.text, signal });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text), signed: response.headers.has(DACS_SELLER_HTTP_HEADER) };
  };
  // `options.signal` lets the caller abandon the request.
  const send = async (path, jobId, body, options) => post(path, await sign(path, jobId, body, options), options);
  const signChallenge = (jobId = defaultJob, options) => sign(DACS_SELLER_HTTP_PATHS.contextChallenge, jobId, { scope: scopeFor(jobId) }, options);
  const challenge = (jobId = defaultJob, options) => send(DACS_SELLER_HTTP_PATHS.contextChallenge, jobId, { scope: scopeFor(jobId) }, options);
  const context = async (jobId, nonce, options) => {
    const bundle = presentationFor(buyerKey, nonce, clock());
    return { ...await send(DACS_SELLER_HTTP_PATHS.context, jobId, { scope: { ...scopeFor(jobId), buyerBundleHash: identityBundleHash(bundle) }, buyerIdentityBundle: bundle }, options), bundle };
  };
  const requestContext = async (jobId = defaultJob, options) => {
    const issued = await challenge(jobId);
    if (issued.status !== 200) throw new Error(`TEST the challenge was refused: ${issued.text}`);
    return context(jobId, issued.body.sessionNonce, options);
  };
  // The first admission a proposal needs: the challenge, then the context request over it. Returns the presentation the host accepted.
  // A refusal is thrown with the code and status the host answered.
  const refusal = (step, answer) => Object.assign(new Error(`TEST the ${step} was refused: ${answer.text}`), { code: answer.body?.error, status: answer.status });
  const admit = async (jobId = defaultJob) => {
    const issued = await challenge(jobId);
    if (issued.status !== 200) throw refusal('challenge', issued);
    const answered = await context(jobId, issued.body.sessionNonce);
    if (answered.status !== 200) throw refusal('context request', answered);
    return answered.bundle;
  };
  return { challenge, context, requestContext, scopeFor, admit, signChallenge, post, verifyDiscovery: wire.verifyDiscovery };
}

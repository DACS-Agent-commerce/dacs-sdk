// TEST-ONLY integration helper for the operator Agreement context consumer
// (src/dacs/agreement-context-consumer.mjs). It starts the actual plugin app
// with an operator-configured context provider, and runs the UNCHANGED,
// read-only Demo seller library (createAgreementContextResolver /
// createSellerAgreementResponder, local Listing intake service) behind the
// plugin's own loopback seller HTTP handler. Adapted from the read-only interop
// witness helper; set DACS_SELLER_INTEROP_REFERENCE to a local reference copy.
//
// Every authority here is a fresh ephemeral SIMULATION: the composite Vet
// writer, the PA-1 rail steward, the revocation catalogue, payout policy and
// party IO. Only the empty requirement class is exercised. None of it is
// genuine Listing, Vet, revocation, rail, chain or finality evidence.
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalize, compositeVerificationAddress, contentHash, createInMemoryFencedSessionStore, ed25519Verify, identityBundleHash,
  publicKeyFromRaw, signedBytes, validateListingArtifact, verifyCompositeVerificationRecord } from '@kynesyslabs/dacs';
import { startAnchorFixture } from '../dacs-loopback-fixture.test.mjs';
import { startDirectoryFixture } from '../fixtures/directory-server.mjs';
import { createEphemeralWallet } from '../fixtures/wallet.mjs';
import { CALLBACK_ORIGIN } from './harness.mjs';
import { seedSellerListing } from './flows.mjs';
import { loadConfig } from '../../src/config.mjs';
import { createApp } from '../../src/app.mjs';
import { createLogger } from '../../src/util/log.mjs';
import { createSellerHttpHandler } from '../../src/dacs/seller-http.mjs';

export const SELLER_REFERENCE = process.env.DACS_SELLER_INTEROP_REFERENCE || null;
export const SELLER_REFERENCE_DIGEST = 'dbe07f9c9cff45fa2a4af106b80614ce59c5ac19b9acf5c147aa315c78a298bf';
export const SDK_ARCHIVE_SHA256 = '79934553cf3f952de4a442c8db306b68a2d5cd5947b3f1258ac9ac2caa5a69a3';
export const TEST_AUTHORITY = 'ephemeral-test-simulation/demo-agreement-context';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function walk(root, dir, files) {
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(root, path, files);
    else if (entry.isFile()) files[relative(root, path)] = hash(await readFile(path));
    else throw new Error(`unexpected reference entry ${path}`);
  }
  return files;
}

// The 17-file read-only reference must be byte-identical; a missing or changed
// configured reference fails verification if it is missing or changed.
let reference;
export async function sellerReference() {
  if (!SELLER_REFERENCE) throw new Error('DACS_SELLER_INTEROP_REFERENCE is not set: seller reference cases must be skipped');
  if (reference) return reference;
  const files = await walk(SELLER_REFERENCE, SELLER_REFERENCE, {});
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  assert.equal(Object.keys(sorted).length, 17, 'seller reference file count');
  assert.equal(hash(JSON.stringify(sorted)), SELLER_REFERENCE_DIGEST, 'unchanged seller reference digest');
  assert.equal(sorted['vendor/kynesyslabs-dacs-0.1.0-alpha.0.tgz'], SDK_ARCHIVE_SHA256);
  const context = await import(pathToFileURL(join(SELLER_REFERENCE, 'v2/seller/agreement-context.mjs')));
  const service = await import(pathToFileURL(join(SELLER_REFERENCE, 'v2/seller/listing-service.mjs')));
  reference = { ...context, ...service, files: sorted };
  return reference;
}

function closer(server) {
  return () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
}

// startProtocolHarness with the one extra programmatic option under test.
export async function startContextHarness({ chain, now, agreementContext, browserAgreement, env = {} }) {
  const directory = await startDirectoryFixture();
  const anchors = await startAnchorFixture(now ? { clock: now } : {});
  const endpoints = new Map();
  const dataDir = mkdtempSync(join(tmpdir(), 'dacs-chatgpt-context-'));
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const config = loadConfig({ DACS_PUBLIC_ORIGIN: origin, DACS_ALLOW_INSECURE_LOCALHOST: '1', DACS_OAUTH_COOKIE_KEYS: randomBytes(32).toString('hex'),
    DACS_DATA_DIR: dataDir, DACS_DIRECTORY_ORIGIN: directory.url, DACS_CHAIN_RPC_URL: chain.url, DACS_ALLOWED_REDIRECT_ORIGINS: CALLBACK_ORIGIN,
    DACS_LOG_LEVEL: 'debug', DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback', ...env });
  const logs = [];
  const created = await createApp({ config, logger: createLogger({ level: 'debug', sink: (line) => logs.push(line) }),
    dacsProtocol: { anchorUrl: anchors.url, sellerEndpoint: (claim) => endpoints.get(claim) ?? null,
      ...(browserAgreement ? { browserAgreement } : {}), ...(agreementContext ? { agreementContext } : {}) },
    ...(now ? { now } : {}) });
  server.on('request', created.app);
  const closers = [];
  return { origin, mcpUrl: `${origin}/mcp`, chain, directory, anchors, endpoints, config, app: created, logs, onClose: (fn) => closers.push(fn),
    async close() {
      await closer(server)(); await created.close();
      for (const fn of closers.reverse()) await fn();
      await anchors.close(); await chain.close(); await directory.close(); rmSync(dataDir, { recursive: true });
    } };
}

// One separately selected TEST operator authority shared by the buyer-side
// provider and the Demo seller IO. It never reads a buyer proposal.
export async function startDemoContextSeller(h, { listingId, clock = () => Date.now(), sellerAuthority = true } = {}) {
  const api = await sellerReference();
  const wallet = createEphemeralWallet(), vetWriter = createEphemeralWallet(), steward = createEphemeralWallet();
  const nowMs = clock();
  const { listing } = seedSellerListing(h, wallet, { listingId, now: nowMs, summary: { observedAt: new Date(nowMs).toISOString() } });
  assert.deepEqual(listing.buyerRequirement?.required ?? [], [], 'only the empty requirement class is exercised');
  const pin = { listingId: listing.listingId, version: listing.listingVersion, contentHash: contentHash(listing) };
  const stateDir = await mkdtemp(join(tmpdir(), 'dacs-plugin-context-demo-'));
  const intake = await api.createSellerListingService({ sellerDid: wallet.claim, stateDir, now: clock });
  const intakeOrigin = `http://127.0.0.1:${(await intake.listen()).port}`;
  h.onClose(async () => { await intake.close(); await rm(stateDir, { recursive: true, force: true }); });
  const storedResponse = await fetch(`${intakeOrigin}/v1/listings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ listing, listingPin: pin }) });
  const stored = await storedResponse.json();
  assert.equal(storedResponse.status, 201, JSON.stringify(stored));
  assert.equal(stored.validation.sessionEligible, false); assert.equal(stored.publication.dacsActive, false);

  const listingReads = [], received = [], progress = [], signed = [], published = [], verifiedVets = [], providerCalls = [], faults = { provider: null };
  const empty = { requirementVersion: '1', required: [] };
  const bundles = new Map([[wallet.claim, structuredClone(listing.seller.identity)]]);
  const vets = new Map(), trusted = new Map();
  // Fresh fixture steward proof for TEST PA-1 authority (not a Demos trust source).
  const rail = { railId: 'demos-native:DEM', railVersion: 1, phaseHandler: 'pay-dem' };
  const railHash = hash(canonicalize(rail));
  const railValid = ed25519Verify(signedBytes('dacs-rail:v1:', railHash), steward.signBytes(signedBytes('dacs-rail:v1:', railHash)), publicKeyFromRaw(steward.publicKeyRaw));
  assert.equal(railValid, true);
  const revocation = { nowMs: clock, surfaces: [{ kind: 'catalog', status: 'active', readStatus: 'ok', catalogObservedAt: nowMs }], readMarker: async () => null, verifyMarkerSignature: () => false };
  const loadRailResolution = () => ({ trustPhase: 'PA-1', trustPolicyAcceptsPA1: true, registry: { state: 'not-used', entries: [], definitions: [] }, inCodeDefinitions: [{ ...rail, governanceAnchoring: 'in-code', signatureValid: railValid }] });
  async function readListing(query) {
    const path = `/v1/listings/${encodeURIComponent(query.listingId)}/versions/${query.version}/artifact?contentHash=${query.contentHash}`;
    const response = await fetch(`${intakeOrigin}${path}`), bytes = await response.text();
    listingReads.push({ pin: structuredClone(query), status: response.status, bytes });
    return response.status === 200 ? { disposition: 'present', value: JSON.parse(bytes) } : { disposition: 'absent', reason: `local artifact HTTP ${response.status}` };
  }
  const deps = { nowMs: clock, resolve: async () => null, resolveRecipe: async () => null, isRecipeSignerAuthorized: () => false,
    isVerifyResultSignerAuthorized: () => false, verifyAuthorityAttestation: () => 'unresolved',
    resolvePublicKey: async (signature) => (signature.signer === vetWriter.claim ? publicKeyFromRaw(vetWriter.publicKeyRaw) : null),
    verify: ({ signedBytes: bytes, signature, publicKey }) => ed25519Verify(bytes, Buffer.from(signature.value, 'base64url'), publicKey) };

  // TEST Vet authority: signs one composite pass record per (job, party,
  // bundle) in the empty requirement class, with its trusted expectation.
  function evaluate(jobId, bundle) {
    const party = bundle.presentedBy, key = `${jobId}/${party}`;
    if (vets.has(key)) return vets.get(key);
    const requirement = party === wallet.claim ? empty : listing.buyerRequirement;
    const unsigned = { recordVersion: '1', jobId, evaluatedParty: party, bundleHash: identityBundleHash(bundle), requirementHash: api.requirementHash(requirement),
      freshness: [], supplementary: [], dealSpecific: [], overallDecision: 'pass', generatedAt: clock() };
    const record = { ...unsigned, signature: { algorithm: 'ed25519', signer: vetWriter.claim, value: vetWriter.signBytes(signedBytes('dacs-composite:v1:', contentHash(unsigned))).toString('base64url') } };
    const ref = { anchor: { kind: 'storage-program', locator: compositeVerificationAddress(jobId, party) }, contentHash: hash(canonicalize(record)), signer: vetWriter.claim };
    const value = { record, ref, expectations: { jobId, evaluatedParty: party, bundleHash: identityBundleHash(bundle), requirement: structuredClone(requirement), verifier: vetWriter.claim, freshness: [], dealSpecific: [] } };
    vets.set(key, value); trusted.set(key, { recordRef: structuredClone(ref), expectations: structuredClone(value.expectations) });
    bundles.set(party, structuredClone(bundle));
    return value;
  }

  // Buyer-side operator provider: SDK ordered Listing reader over the local
  // seller HTTP/store readback, key control of both bundles, and SDK strict
  // composite closure of both TEST records before any ref is returned.
  const provider = {
    authority: TEST_AUTHORITY,
    resolve: async (request) => {
      providerCalls.push(structuredClone(request?.scope));
      return faults.provider ? faults.provider(request) : resolveTrusted(request);
    },
  };
  async function resolveTrusted({ scope, buyerIdentityBundle }) {
      if (scope.seller !== wallet.claim) return { disposition: 'absent', reason: 'no TEST authority for this seller' };
      const read = await readListing(scope.listingPin);
      if (read.disposition !== 'present') return read;
      const admitted = await validateListingArtifact(read.value, { nowMs: clock,
        verifyListingSignature: ({ signedBytes: bytes, signature }) => signature.algorithm === 'ed25519' && signature.signer === wallet.claim && api.verifyDidSignature(bytes, signature.value, wallet.claim),
        verifyIdentityPresentation: ({ bundle }) => api.verifyPartyKeyControl(bundle, wallet.claim),
        verifySellerControl: ({ bundle, signer }) => signer === wallet.claim && api.verifyPartyKeyControl(bundle, wallet.claim), revocation, loadRailResolution });
      if (admitted.disposition !== 'verified') return { disposition: 'indeterminate', reason: `Listing reader ${admitted.disposition}` };
      if (!api.verifyPartyKeyControl(buyerIdentityBundle, scope.buyer) || identityBundleHash(buyerIdentityBundle) !== scope.buyerBundleHash) return { disposition: 'rejected', reason: 'buyer key control' };
      const parties = {};
      for (const [role, bundle] of [['buyer', buyerIdentityBundle], ['seller', read.value.seller.identity]]) {
        const v = evaluate(scope.jobId, bundle);
        const closure = await verifyCompositeVerificationRecord(structuredClone(v.record), structuredClone(v.expectations), deps);
        if (closure?.status !== 'valid' || closure.record.overallDecision !== 'pass') return { disposition: 'indeterminate', reason: `${role} Vet closure ${closure?.status}` };
        parties[role] = { identityBundle: structuredClone(bundle), vetRecordRef: structuredClone(v.ref) };
      }
      return { disposition: 'present', value: { scope, input: { jobId: scope.jobId, verifiedListing: { disposition: 'verified', listing: read.value, pin: structuredClone(scope.listingPin) },
        buyer: parties.buyer, seller: parties.seller, selectedRail: structuredClone(scope.rail),
        payoutBindings: [{ railId: scope.rail.railId, phaseIndex: read.value.pipeline.findIndex((p) => p.kind === 'pay-dem'), payeeAddress: wallet.address }], generatedAt: scope.generatedAt } } };
  }

  // Seller side: the unchanged Demo resolver and SDK responder, reading only
  // the same TEST operator authority (never the proposal) for IO.
  const io = { readListing, revocation, loadRailResolution,
    readPartyBundle: async ({ party }) => (bundles.has(party) ? { disposition: 'present', value: structuredClone(bundles.get(party)) } : { disposition: 'absent', reason: 'unknown TEST party' }),
    readVet: async ({ jobId, evaluatedParty }) => (vets.has(`${jobId}/${evaluatedParty}`) ? { disposition: 'present', value: { record: structuredClone(vets.get(`${jobId}/${evaluatedParty}`).record), ref: structuredClone(vets.get(`${jobId}/${evaluatedParty}`).ref) } } : { disposition: 'absent', reason: 'no TEST record' }) };
  const strict = api.createSdkCompositeVetVerifier({ selectTrusted: async ({ jobId, evaluatedParty }) => structuredClone(trusted.get(`${jobId}/${evaluatedParty}`) ?? null), deps });
  const policy = { nowMs: clock, trustedVetWriters: [vetWriter.claim], sellerRequirement: empty, payeeAddress: wallet.address,
    verifyPartyVet: async (input) => { const result = await strict(input); verifiedVets.push({ evaluatedParty: input.expected.evaluatedParty, status: result.status }); return result; } };
  const resolveContext = api.createAgreementContextResolver({ sellerDid: wallet.claim, ...(sellerAuthority ? { io, policy } : {}) });
  const contributions = new Map(), proposals = new Map();
  const responder = api.createSellerAgreementResponder({ sellerDid: wallet.claim, resolveContext, store: createInMemoryFencedSessionStore(), workerId: 'TEST-plugin-context',
    leaseNowMs: clock, sign: (bytes, context) => { signed.push(context.party); return wallet.signBytes(bytes).toString('base64url'); },
    reconcileSellerSignature: () => ({ disposition: 'absent', reason: 'no prior TEST signature' }),
    transport: { publishSellerContribution: (contribution, identity) => { contributions.set(identity.proposalHash, structuredClone(contribution)); published.push(structuredClone(contribution)); return { disposition: 'submitted' }; },
      reconcileSellerContributionPublication: (identity) => (contributions.has(identity.proposalHash) ? { disposition: 'present', value: contributions.get(identity.proposalHash) } : { disposition: 'absent', reason: 'not published' }) } });
  // TEST-only transport adapter: the plugin's existing loopback seller HTTP
  // handler in front of the Demo responder. Not a Demo public route.
  const agent = {
    claim: wallet.claim,
    async receiveProposal(body) {
      received.push(structuredClone(body));
      const result = await responder({ proposal: body.proposal, transportIdentity: body.transportIdentity });
      progress.push(result);
      if (result.disposition === 'complete') { proposals.set(body.proposal.proposalHash, structuredClone(body.proposal)); return { disposition: 'complete', contribution: result.result.sellerContribution }; }
      return { disposition: result.disposition, stage: result.stage, reason: result.reason };
    },
    agreementState: (identity) => ({ proposal: proposals.get(identity?.proposalHash) ?? null, contribution: contributions.get(identity?.proposalHash) ?? null }),
  };
  const server = http.createServer(createSellerHttpHandler(agent));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  h.onClose(closer(server));
  const origin = `http://127.0.0.1:${server.address().port}`;
  h.endpoints.set(wallet.claim, origin);
  return { wallet, vetWriter, listing, pin, origin, intakeOrigin, stored, api, provider, resolveTrusted, faults, vets, listingReads, received, progress, signed, published, verifiedVets, providerCalls,
    vetRef: (jobId, party) => vets.get(`${jobId}/${party}`)?.ref ?? null,
    // Legacy characterization only: TEST facts from the retained pre-proposal identity.
    installFacts: (jobId, buyerBundle) => { evaluate(jobId, buyerBundle); evaluate(jobId, listing.seller.identity); } };
}

// A late-bound operator provider slot for createApp: the TEST authority is
// installed by the operator before any purchase, never learned from requests.
export function providerSlot() {
  const installed = new Map();
  return {
    config: { authority: TEST_AUTHORITY, resolve: (request) => installed.get(request?.scope?.seller)?.resolve(request) ?? { disposition: 'indeterminate', reason: 'no TEST operator authority installed for this seller' } },
    install: (seller) => { installed.set(seller.wallet.claim, seller.provider); },
  };
}

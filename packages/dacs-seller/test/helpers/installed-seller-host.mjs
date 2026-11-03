// Runs inside a temporary application that installed the packed core and
// seller tarballs. It is copied there and started with a clean `node` (no
// flags, loaders or NODE_OPTIONS), so every import below resolves through that
// application's node_modules, never through this repository.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as core from '@kynesyslabs/dacs';
import * as seller from '@kynesyslabs/dacs-seller';
import { createDemDeliveryContext } from '@kynesyslabs/dacs-seller/src/dacs/dem-delivery-context-consumer.mjs';
import { createNativeDemDeliveryCapability } from '@kynesyslabs/dacs-seller/src/dacs/native-dem-delivery-consumer.mjs';
import { createNativePaymentEvidenceConsumer } from '@kynesyslabs/dacs-seller/src/dacs/native-payment-evidence-consumer.mjs';

const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve('@kynesyslabs/dacs-seller/package.json'));
const out = { environment: { execArgv: process.execArgv, nodeOptions: process.env.NODE_OPTIONS ?? null }, packageRoot: relative(process.cwd(), packageRoot) };
// `--second <dataDirectory>`: another process tries to host on a live host's state.
const second = process.argv[2] === '--second' ? process.argv[3] : null;

// Every installed module, each imported by itself.
if (second === null) {
  const modules = [];
  const walk = (dir) => { for (const name of readdirSync(dir)) { const path = join(dir, name); if (statSync(path).isDirectory()) walk(path); else if (name.endsWith('.mjs')) modules.push(path); } };
  walk(join(packageRoot, 'src'));
  out.imports = [];
  for (const path of modules.sort()) {
    try { await import(pathToFileURL(path).href); out.imports.push({ file: relative(packageRoot, path), loaded: true }); }
    catch (error) { out.imports.push({ file: relative(packageRoot, path), loaded: false, code: error.code ?? null, message: String(error.message).slice(0, 300) }); }
  }
  out.exports = Object.keys(seller).sort();
  out.subpath = {
    artifactAnchor: typeof (await import('@kynesyslabs/dacs-seller/src/devnet-demo/artifact-anchor.mjs')).createDevnetDemoArtifactAnchor,
    contextRoute: typeof (await import('@kynesyslabs/dacs-seller/src/dacs/seller-context-route.mjs')).createSellerContextRoute,
  };
}

// Wallet-shaped keys: the wallet signs raw UTF-8 messages and answers 0x-hex.
function key() {
  const pair = generateKeyPairSync('ed25519');
  const raw = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  const address = `0x${raw.toString('hex')}`;
  return { address, claim: `did:demos:agent:${raw.toString('hex')}`, publicKey: pair.publicKey,
    sign: (bytes) => sign(null, Buffer.from(bytes), pair.privateKey),
    signWallet: (message) => `0x${sign(null, Buffer.from(message, 'utf8'), pair.privateKey).toString('hex')}` };
}
const identityFor = (party, presentedAt) => {
  const unsigned = seller.buildUnsignedIdentityBundle({ address: party.address, presentedAt, sessionSeed: 'installed-package' });
  return seller.attachIdentityPresentation(unsigned, party.signWallet(unsigned.message));
};

const sellerKey = key(), buyerKey = key(), now = Date.now();
// A TEST rail steward and its signed demos-native:DEM definition (PA-1, in-code):
// the host selects the rail only from this authority.
const steward = generateKeyPairSync('ed25519'), stewardPublicKey = steward.publicKey.export({ format: 'jwk' }).x;
const stewardClaim = `did:demos:agent:${Buffer.from(stewardPublicKey, 'base64url').toString('hex')}`;
const unsignedRail = { railVersion: 1, railId: 'demos-native:DEM', railType: 'demos-native', asset: { kind: 'native-dem', symbol: 'DEM', decimals: 9 }, network: { kind: 'demos' },
  phaseHandler: 'pay-dem', parameters: {}, availability: 'live', governance: { proposedBy: stewardClaim, acceptedAt: 1, anchoring: 'in-code' } };
const railAuthority = { rail: { ...unsignedRail, signature: { algorithm: 'ed25519', signer: stewardClaim,
  value: sign(null, Buffer.from(`dacs-rail:v1:${core.contentHash(unsignedRail)}`, 'ascii'), steward.privateKey).toString('base64url') } }, stewardClaim, stewardPublicKey, railRegistryVersion: 1, production: false };
const draft = seller.buildListingDraft({ identityBundle: identityFor(sellerKey, now - 1000), displayName: 'Installed seller', publicEndpoint: 'https://seller.invalid/agent',
  listingId: 'installed-report', listingVersion: 1, title: 'Installed package report', description: 'A report served by the installed seller package.',
  expectedSizeBytes: 1024, category: 'services.market-report', tags: ['installed'], priceDem: '2.5', notBefore: now - 60000 });
const listing = seller.attachListingSignature(draft, sellerKey.signWallet(seller.listingSigningMessage(draft)));
const pin = seller.listingPin(listing);
out.sellerClaim = sellerKey.claim;
assert.equal((await seller.validateListing(listing, { now: () => now, revocationSurfaces: [{ kind: 'catalog', status: 'active', readStatus: 'ok', catalogObservedAt: now }], readMarker: async () => null, railAuthority })).disposition, 'verified');

// Operator capabilities. Negotiation needs only the Vet context, so every other
// one records and refuses if it is reached.
const reached = [];
const refuse = (name) => async () => { reached.push(name); throw new Error(`${name} is not reached while negotiating`); };
// The seller admits one session per challenge it issued (CORE SN-1..SN-4):
// the operator issues a random one per job through the host, and the buyer
// presents it through the public builder's `sessionNonce`. The replayed job's
// presentation carries a nonce the host never issued; the bare job's carries
// no session nonce at all (DACS-1 §6.3.2).
const jobId = core.generateCanonicalJobId(), unvettedJobId = core.generateCanonicalJobId(), fabricatedJobId = core.generateCanonicalJobId(), replayedJobId = core.generateCanonicalJobId(), bareJobId = core.generateCanonicalJobId();
const issuedNonces = new Map(), ownBundles = new Map();
const presentFor = (id, presentedAt) => {
  const unsigned = seller.buildUnsignedIdentityBundle({ address: buyerKey.address, presentedAt, ...(issuedNonces.has(id) ? { sessionNonce: issuedNonces.get(id) } : { sessionSeed: 'installed-package' }) });
  if (id !== bareJobId) return ownBundles.set(id, seller.attachIdentityPresentation(unsigned, buyerKey.signWallet(unsigned.message)));
  const { sessionNonce: _nonce, ...bundle } = unsigned.bundle, bundleHash = core.sha256Hex(core.canonicalize(bundle));
  ownBundles.set(id, seller.attachIdentityPresentation({ bundle, bundleHash }, buyerKey.signWallet(unsigned.message.replace(unsigned.bundleHash, bundleHash))));
};
const bundleFor = (id) => ownBundles.get(id);
// The operator's seller-owned session admission: the counterparty-verified
// CompositeVerificationRecords it keeps (DACS-2 §7.7.2: the buyer's signed by
// the seller, the seller's by the buyer), readers for its Listing's revocation
// surfaces (one fresh catalog reading that lists it active; the host decides
// with core checkListingRevocation) and both parties under the package's exact
// profile. The presentation challenge is the host's own.
const vetRecords = new Map(), admissionCalls = [];
const vetReceipt = (ref) => ({ receiptVersion: '1', substrate: 'demos', finalityProfile: 'TEST-installed', logicalAddress: ref.anchor.locator, nativeAddress: `TEST-native-${ref.contentHash.slice(0, 16)}`,
  contentHash: ref.contentHash, transactionRef: { kind: 'demos', value: core.sha256Hex(`installed vet tx ${ref.contentHash}`) }, writer: ref.signer, state: 'finalized', observationDisposition: 'established',
  observedAt: Date.now(), blockRef: { id: 'TEST-block', height: '1', timestamp: Date.now() }, evidence: { kind: 'TEST', value: 'installed' } });
const verifierOf = (party) => (party === sellerKey.claim ? buyerKey : sellerKey);
const vetRef = async (jobId, party, bundle) => {
  const verifier = verifierOf(party);
  const record = await core.signComponentArtifact({ recordVersion: '1', jobId, evaluatedParty: party, bundleHash: core.identityBundleHash(bundle), requirementHash: core.sha256Hex(core.canonicalize(listing.buyerRequirement)),
    freshness: [], supplementary: [], dealSpecific: [], overallDecision: 'pass', generatedAt: now }, core.ARTIFACT_SEPARATORS.CompositeVerificationRecord, { algorithm: 'ed25519', signer: verifier.claim, sign: verifier.sign });
  vetRecords.set(core.contentHash(record), record);
  return { anchor: { kind: 'storage-program', locator: core.compositeVerificationAddress(jobId, party) }, contentHash: core.contentHash(record), signer: verifier.claim };
};
const sessionAdmission = {
  readRevocationSurfaces: async () => [{ kind: 'catalog', status: 'active', readStatus: 'ok', catalogObservedAt: Date.now() }],
  readRevocationMarker: refuse('sessionAdmission.readRevocationMarker'),
  admit: async (query) => {
    admissionCalls.push(query.jobId);
    return { disposition: 'admitted', jobId: query.jobId, buyer: query.buyer, buyerBundleHash: query.buyerBundleHash, listingPin: query.listingPin,
      participants: [{ role: 'buyer', claim: query.buyer, ...query.profile }, { role: 'seller', claim: query.seller, ...query.profile }] };
  },
  resolveVetRecord: async ({ ref }) => { if (!vetRecords.has(ref.contentHash)) throw new Error('no Vet record at this reference'); return structuredClone(vetRecords.get(ref.contentHash)); },
  verifyVetAnchorReceipt: async ({ ref, receipt }) => (vetRecords.has(ref.contentHash) && receipt?.logicalAddress === ref.anchor.locator && receipt.contentHash === ref.contentHash && receipt.evidence?.value === 'installed' ? 'valid' : 'invalid'),
  readVetAnchorReceipt: async ({ ref }) => { if (!vetRecords.has(ref.contentHash)) throw new Error('no SR-2 receipt at this reference'); return vetReceipt(ref); },
};
// The Agreement derivation input both parties use, with the Vet references.
const inputs = new Map();
const vettedInput = (jobId) => inputs.get(jobId) ?? inputs.set(jobId, (async () => {
  const input = seller.agreementInput({ jobId, listing, buyerBundle: bundleFor(jobId), generatedAt: now });
  return { ...input, buyer: { ...input.buyer, vetRecordRef: await vetRef(jobId, buyerKey.claim, bundleFor(jobId)) }, seller: { ...input.seller, vetRecordRef: await vetRef(jobId, sellerKey.claim, listing.seller.identity) } };
})()).get(jobId);
// A Vet context that names a hash with no record behind it.
const fabricatedInput = (jobId) => {
  const input = seller.agreementInput({ jobId, listing, buyerBundle: bundleFor(jobId), generatedAt: now });
  const ref = (party) => ({ anchor: { kind: 'storage-program', locator: core.compositeVerificationAddress(jobId, party) }, contentHash: core.sha256Hex(`installed-vet:${jobId}:${party}`), signer: verifierOf(party).claim });
  return { ...input, buyer: { ...input.buyer, vetRecordRef: ref(buyerKey.claim) }, seller: { ...input.seller, vetRecordRef: ref(sellerKey.claim) } };
};
const fabricatedJobs = new Set();
// One requirement invocation per party Vet record, each naming the evaluated party's counterparty as verifier.
const invocationsFor = (input) => [['buyer', buyerKey.claim], ['seller', sellerKey.claim]].map(([role, evaluatedParty]) => ({
  vetRecordRef: input[role].vetRecordRef, evaluatedParty, requirement: structuredClone(listing.buyerRequirement), verifier: verifierOf(evaluatedParty).claim, freshness: [], dealSpecific: [] }));
const vetContextCalls = [];
// The package's wallet journal over the operator's wallet primitives: it
// answers both the evidence anchor and the host's journal question.
const journalDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'dacs-seller-wallet-')));
const journal = seller.createPaymentEvidenceWalletJournal({ path: join(journalDirectory, 'wallet-journal.sqlite'), signCreate: refuse('wallet.signCreate'), broadcast: refuse('wallet.broadcast'),
  readAccountNonce: refuse('wallet.readAccountNonce'), readTransactionState: refuse('wallet.readTransactionState') });
const capabilities = () => ({
  nativePaymentEvidence: createNativePaymentEvidenceConsumer({ rpcUrl: 'http://127.0.0.1:9/', anchorEvidence: journal.anchorEvidence, fetchImpl: refuse('nativePaymentEvidence.fetch') }),
  reconcilePaymentEvidence: journal.reconcilePaymentEvidence,
  demDeliveryContext: createDemDeliveryContext({ authority: 'TEST-installed-package', resolveBuyer: refuse('demDeliveryContext.resolveBuyer'),
    resolveSeller: async ({ jobId }) => { vetContextCalls.push(jobId); const input = fabricatedJobs.has(jobId) ? fabricatedInput(jobId) : await vettedInput(jobId); return { disposition: 'present', value: { input, vetRequirements: invocationsFor(input) } }; } }),
  nativeDemDelivery: createNativeDemDeliveryCapability({ authority: 'TEST-installed-package', submit: refuse('nativeDemDelivery.submit'), reconcile: refuse('nativeDemDelivery.reconcile'),
    read: refuse('nativeDemDelivery.read'), verifyReceipt: refuse('nativeDemDelivery.verifyReceipt') }),
  buyerAccess: seller.createOperatorBuyerAccess({ openBuyerAccess: true }),
  agreementAnchor: { source: 'installed-package/agreement-readback', readAgreement: refuse('agreementAnchor.readAgreement') },
  artifactAnchor: { writer: sellerKey.claim, source: 'installed-package/artifacts', publish: refuse('artifactAnchor.publish'), readRetained: refuse('artifactAnchor.readRetained'), verifyReceipt: refuse('artifactAnchor.verifyReceipt') },
  deliverySchemaVerifier: { schemaUrl: listing.offering.deliverable.schemaUrl, verify: refuse('verifyDeliverySchema') },
  deliverableProducer: () => { reached.push('deliverableProducer'); throw new Error('deliverableProducer is not reached while negotiating'); },
  observeDemosTransfer: refuse('observeDemosTransfer'),
  railAuthority,
  sessionAdmission,
});
const dataDirectory = second ?? realpathSync(mkdtempSync(join(tmpdir(), 'dacs-seller-host-')));
const signer = { claim: sellerKey.claim, sign: sellerKey.sign };
const start = (extra = {}) => seller.startSellerHost({ signer, listing, dataDirectory, ...capabilities(), ...extra });

// Refused configurations: each names its cause and starts nothing.
const refusal = async (options) => { try { const host = await seller.startSellerHost(options); await host.close(); return null; } catch (error) { return `${error.name}: ${error.message}`; } };
// The same for an agent an operator composes itself (createSellerAgent).
const agentRefusal = async (options) => { try { const agent = await seller.createSellerAgent(options); agent.close(); return null; } catch (error) { return `${error.name}: ${error.message}`; } };
if (second !== null) {
  process.stdout.write(`${JSON.stringify({ secondProcess: await refusal({ signer, listing, dataDirectory, ...capabilities() }) })}\n`);
  process.exit(0);
}
const { agreementAnchor: _omitted, ...withoutReadback } = capabilities();
const { nativeDemDelivery: _undelivered, ...withoutDelivery } = capabilities();
const { railAuthority: _unrailed, ...withoutRail } = capabilities();
const { sessionAdmission: _unadmitted, ...withoutAdmission } = capabilities();
const { reconcilePaymentEvidence: _unreconciled, ...withoutJournal } = capabilities();
out.refusedConfigurations = {
  missingJournal: await refusal({ signer, listing, dataDirectory, ...withoutJournal }),
  missingSessionAdmission: await refusal({ signer, listing, dataDirectory, ...withoutAdmission }),
  missingAgreementAnchor: await refusal({ signer, listing, dataDirectory, ...withoutReadback }),
  missingDelivery: await refusal({ signer, listing, dataDirectory, ...withoutDelivery }),
  missingRailAuthority: await refusal({ signer, listing, dataDirectory, ...withoutRail }),
  publicInterface: await refusal({ signer, listing, dataDirectory, ...capabilities(), host: '0.0.0.0' }),
  unknownOption: await refusal({ signer, listing, dataDirectory, ...capabilities(), anchors: { read: async () => null, write: async () => null } }),
  relativeDirectory: await refusal({ signer, listing, dataDirectory: 'seller-data', ...capabilities() }),
  otherSigner: await refusal({ signer: { claim: buyerKey.claim, sign: buyerKey.sign }, listing, dataDirectory, ...capabilities() }),
  scriptedJournal: await refusal({ signer, listing, dataDirectory, ...capabilities(), reconcilePaymentEvidence: async () => ({ status: 'unsigned' }) }),
  scriptedAgent: await agentRefusal({ signer, listing, ...capabilities(), nativeArtifactAnchor: capabilities().artifactAnchor, durableDirectory: join(journalDirectory, 'agent'),
    reconcilePaymentEvidence: async () => ({ status: 'unsigned' }) }),
};

// The buyer derives the Agreement from the vetted input and signs its contribution.
const proposalFor = async (input) => {
  const plan = core.createFixedPriceAgreementSigningPlan(core.deriveFixedPriceAgreement(input));
  const buyerContribution = await core.createFixedPriceAgreementSignatureContribution(plan, 'buyer', { party: buyerKey.claim, algorithm: 'ed25519', sign: buyerKey.sign });
  const material = { proposalVersion: '1', plan, buyerContribution };
  const proposal = { ...material, proposalHash: core.sha256Hex(core.canonicalize(material)) };
  return { plan, buyerContribution, proposal, transportIdentity: { jobId: input.jobId, planHash: plan.planHash, agreementHash: plan.agreementHash, buyer: buyerKey.claim, seller: sellerKey.claim, proposalHash: proposal.proposalHash } };
};
// Built once the host has issued the challenges: the vetted job; the same
// buyer on another job over the synthetic not-performed Vet references; on
// another, whose Vet context names hashes no record backs; and a fresh
// presentation on a job the seller issued no challenge for.
fabricatedJobs.add(fabricatedJobId);
let buyerBundle, plan, buyerContribution, proposal, transportIdentity, unvetted, fabricated, replayed, bare;
const clientFor = (url, listingPin = pin, agreementHash = plan.agreementHash) => seller.createSellerAgentClient({ url, authentication: seller.createSellerTransportClientAuth({
  buyerSigner: { claim: buyerKey.claim, sign: buyerKey.sign }, seller: sellerKey.claim, resolveJob: () => ({ listingPin, agreementHash }) }) });
// Independent of the package: node:crypto against the seller's own key.
const independentVerifier = ({ party, algorithm, value, signedBytes }) => {
  if (algorithm !== 'ed25519' || party !== sellerKey.claim && party !== buyerKey.claim) return 'invalid';
  const publicKey = party === sellerKey.claim ? sellerKey.publicKey : buyerKey.publicKey;
  return verify(null, Buffer.from(signedBytes), publicKey, Buffer.from(value, 'base64url')) ? 'valid' : 'invalid';
};
const refusedCode = async (work) => { try { await work(); return null; } catch (error) { return { name: error.name, code: error.code, status: error.status ?? null }; } };

// Whatever stops the run is reported with everything observed before it.
try {
let host = await start();
out.host = { origin: new URL(host.url).origin, listingPin: host.listingPin, timeouts: host.timeouts };
// The operator issues each job's challenge through the host (CORE SN-1/SN-3),
// the nonce its buyer then presents; the replayed job gets none.
for (const id of [jobId, unvettedJobId, fabricatedJobId]) issuedNonces.set(id, host.issueSessionChallenge({ jobId: id, buyer: buyerKey.claim }).sessionNonce);
for (const [index, id] of [jobId, unvettedJobId, fabricatedJobId, replayedJobId, bareJobId].entries()) presentFor(id, now - index);
out.presentsIssuedChallenge = [jobId, unvettedJobId, fabricatedJobId].every((id) => /^[0-9a-f]{64}$/.test(issuedNonces.get(id)) && bundleFor(id).sessionNonce === issuedNonces.get(id));
buyerBundle = bundleFor(jobId);
({ plan, buyerContribution, proposal, transportIdentity } = await proposalFor(await vettedInput(jobId)));
unvetted = await proposalFor(seller.agreementInput({ jobId: unvettedJobId, listing, buyerBundle: bundleFor(unvettedJobId), generatedAt: now }));
fabricated = await proposalFor(fabricatedInput(fabricatedJobId));
replayed = await proposalFor(await vettedInput(replayedJobId));
bare = await proposalFor(await vettedInput(bareJobId));
out.issuedChallenge = (({ sessionNonce, issuedAt, expiresAt }) => ({ nonce: /^[0-9a-f]{64}$/.test(sessionNonce), lifetimeMs: expiresAt - issuedAt }))(host.issueSessionChallenge({ jobId: core.generateCanonicalJobId(), buyer: buyerKey.claim }));
const client = clientFor(host.url);
const first = await client.propose({ proposal, transportIdentity, buyerIdentityBundle: buyerBundle });
out.proposal = { disposition: first.disposition, role: first.contribution?.role ?? null, signer: first.contribution?.party ?? null };
const agreement = await core.finalizeFixedPriceAgreementContributions(plan, [buyerContribution, first.contribution], independentVerifier);
out.agreement = { hash: core.contentHash(agreement), expected: plan.agreementHash, listingRef: agreement.listingRef };
const repeat = await client.propose({ proposal, transportIdentity, buyerIdentityBundle: buyerBundle });
out.repeatSameContribution = core.canonicalize(repeat.contribution) === core.canonicalize(first.contribution);
const state = await client.agreementState(transportIdentity);
out.stateSameContribution = core.canonicalize(state.contribution) === core.canonicalize(first.contribution);
out.refusals = {
  otherListingPin: await refusedCode(() => clientFor(host.url, { ...pin, contentHash: '0'.repeat(64) }).propose({ proposal, transportIdentity, buyerIdentityBundle: buyerBundle })),
  unsigned: await (async () => { const response = await fetch(`${host.url}/dacs/v1/agreements/proposals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ proposal, transportIdentity, buyerIdentityBundle: buyerBundle }) }); return { status: response.status, body: await response.json() }; })(),
  unvettedProposal: await (async () => { try { const answer = await clientFor(host.url, pin, unvetted.plan.agreementHash).propose({ proposal: unvetted.proposal, transportIdentity: unvetted.transportIdentity, buyerIdentityBundle: bundleFor(unvettedJobId) });
    return { disposition: answer.disposition ?? null, contribution: answer.contribution ?? null }; } catch (error) { return { name: error.name, code: error.code ?? null, contribution: null }; } })(),
  fabricatedVetProposal: await (async () => { try { const answer = await clientFor(host.url, pin, fabricated.plan.agreementHash).propose({ proposal: fabricated.proposal, transportIdentity: fabricated.transportIdentity, buyerIdentityBundle: bundleFor(fabricatedJobId) });
    return { disposition: answer.disposition ?? null, contribution: answer.contribution ?? null }; } catch (error) { return { name: error.name, code: error.code ?? null, contribution: null }; } })(),
  replayedPresentation: await refusedCode(() => clientFor(host.url, pin, replayed.plan.agreementHash).propose({ proposal: replayed.proposal, transportIdentity: replayed.transportIdentity, buyerIdentityBundle: bundleFor(replayedJobId) })),
  bareNoNonce: !Object.hasOwn(bundleFor(bareJobId), 'sessionNonce'),
  missingNonce: await refusedCode(() => clientFor(host.url, pin, bare.plan.agreementHash).propose({ proposal: bare.proposal, transportIdentity: bare.transportIdentity, buyerIdentityBundle: bundleFor(bareJobId) })),
  contextChallenge: await (async () => { const response = await fetch(`${host.url}/dacs/v1/agreements/context/challenge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); return { status: response.status, body: await response.json() }; })(),
  secondHostSameDirectory: await refusal({ signer, listing, dataDirectory, ...capabilities() }),
  secondProcessSameDirectory: JSON.parse(spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--second', dataDirectory], { cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 60000 }).stdout.trim().split('\n').at(-1)).secondProcess,
};
await host.close();

// Restart on the same state: the retained contribution is answered again.
host = await start();
const restarted = clientFor(host.url);
const afterRestart = await restarted.agreementState(transportIdentity);
const repeatAfterRestart = await restarted.propose({ proposal, transportIdentity, buyerIdentityBundle: buyerBundle });
out.restart = { stateSameContribution: core.canonicalize(afterRestart.contribution) === core.canonicalize(first.contribution),
  repeatSameContribution: core.canonicalize(repeatAfterRestart.contribution) === core.canonicalize(first.contribution) };
await host.close();
} catch (error) {
  out.hostError = { name: error.name, code: error.code ?? null, message: String(error.message).slice(0, 300) };
  process.exitCode = 1;
}
out.reached = reached;
const label = (id) => id === jobId ? 'vetted' : id === unvettedJobId ? 'unvetted' : id === fabricatedJobId ? 'fabricated' : id === replayedJobId ? 'replayed' : id === bareJobId ? 'bare' : 'other';
out.vetContextJobs = [...new Set(vetContextCalls)].map(label);
out.admittedJobs = [...new Set(admissionCalls)].map(label);
journal.close();
rmSync(dataDirectory, { recursive: true, force: true });
rmSync(journalDirectory, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify(out)}\n`);

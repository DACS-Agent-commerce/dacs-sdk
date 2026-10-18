// Deterministic, offline scenario for the DACS_SELLER_CONTEXT default
// (in-process). It uses only APIs that main already has (main 8228e66: the
// provider's party Vet store and the anchor's hasIntent and read), so the same
// file runs unchanged on main and on this branch; seller-context-route-off.test.mjs
// pins the digest main produced. It covers the in-process Vet and Agreement-context
// call, the derived Agreement, the published Vet artifact bytes, the seller's
// own context, the seller transport declarations, every byte of the seven
// authenticated transport routes, the answer at the context path, and every
// row of the seller transport journal.
import http from 'node:http';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { canonicalize, contentHash, createFixedPriceAgreementSignatureContribution, sha256Hex } from '@kynesyslabs/dacs';
import { fixtureListing } from '../fixtures/listings.mjs';
import { attachIdentityPresentation, buildUnsignedIdentityBundle, purchaseSupport } from '../../src/dacs/listing.mjs';
import { listingPin, planAgreementFromInput } from '../../src/dacs/purchase-protocol.mjs';
import { createDemDeliveryContext, resolveDemDeliveryBuyerContext, resolveDemDeliverySellerContext } from '../../src/dacs/dem-delivery-context-consumer.mjs';
import { createDevnetDemoAgreementContextProvider } from '../../src/devnet-demo/agreement-context.mjs';
import { createInMemoryPartyVetStore } from '../../src/devnet-demo/party-vet-store.mjs';
import { createOperatorBuyerAccess } from '../../src/devnet-demo/buyer-access.mjs';
import { createSellerAgentClient, createSellerHttpHandler } from '../../src/dacs/seller-http.mjs';
import { createSellerTransportClientAuth, createSellerTransportServerAuth, createSellerTransportStore } from '../../src/dacs/seller-transport-auth.mjs';
import { createSourceDemoSellerTransport } from '../../src/dacs/source-demo-seller-transport.mjs';

export const OFF_NOW = 1791600000000;
export const OFF_JOB = '01M4JQ7M7MX1HBNE8F21JPBFVC';

// A fixed Ed25519 key from a 32-byte hex seed.
export function fixedWallet(seed) {
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed, 'hex')]), format: 'der', type: 'pkcs8' });
  const raw = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(12);
  return {
    address: `0x${raw.toString('hex')}`, claim: `did:demos:agent:${raw.toString('hex')}`, publicKeyRaw: Buffer.from(raw),
    signHex: (message) => `0x${sign(null, Buffer.from(message, 'utf8'), privateKey).toString('hex')}`,
    signBytes: (bytes) => sign(null, Buffer.from(bytes), privateKey),
  };
}

// The native anchor's contract in memory: one immutable artifact per logical
// address; a second publish of other bytes is refused, as the real anchor does.
export function memoryAnchor(writer) {
  const records = new Map(), publishes = [];
  const receiptFor = (logicalAddress, artifact, bytes) => ({ receiptVersion: '1', substrate: 'TEST-memory-anchor', finalityProfile: 'TEST-memory', logicalAddress,
    nativeAddress: `native-${sha256Hex(logicalAddress).slice(0, 40)}`, contentHash: contentHash(artifact), transactionRef: { kind: 'TEST-memory', value: sha256Hex(bytes) },
    writer, state: 'finalized', observationDisposition: 'established', observedAt: OFF_NOW, blockRef: { id: 'TEST-memory-block' }, evidence: { kind: 'TEST-memory', value: 'in-memory test anchor' } });
  return {
    source: 'dacs-devnet-demo-native-artifacts/v1', writer, records, publishes,
    async publish({ logicalAddress, artifact, artifactKind }) {
      const bytes = canonicalize(artifact), old = records.get(logicalAddress);
      if (old) { if (old.bytes !== bytes) throw new Error('immutable demo artifact intent differs'); return { status: 'present', receipt: structuredClone(old.receipt) }; }
      const receipt = receiptFor(logicalAddress, artifact, bytes);
      records.set(logicalAddress, { bytes, artifactKind, receipt });
      publishes.push({ logicalAddress, artifactKind, bytes });
      return { status: 'present', receipt: structuredClone(receipt) };
    },
    // Readback only, as the real anchor's read: never creates an intent, and
    // other bytes than the retained ones are refused.
    async read({ logicalAddress, artifact }) {
      const found = records.get(logicalAddress);
      if (!found) return { status: 'absent', reason: 'no seller-owned demo CREATE intent' };
      return found.bytes === canonicalize(artifact) ? { status: 'present', receipt: structuredClone(found.receipt) } : { status: 'rejected', reason: 'retained demo CREATE scope differs' };
    },
    async readRetained({ logicalAddress }) {
      const found = records.get(logicalAddress);
      return found ? { status: 'present', artifact: JSON.parse(found.bytes), receipt: structuredClone(found.receipt) } : { status: 'absent' };
    },
    // Passive, as the real anchor's: whether a CREATE intent is retained.
    async hasIntent(logicalAddress) { return records.has(logicalAddress); },
    async verifyReceipt() { return 'valid'; },
  };
}

export function offOperation({ listing, buyer, jobId = OFF_JOB, id = 'pur_TEST_seller_context', accountId = 'acct_TEST_seller_context' }) {
  const support = purchaseSupport(listing);
  return { id, accountId, status: 'agreement_pending',
    terms: { buyer: { accountId, wallet: buyer.address }, seller: { claim: listing.seller.identity.presentedBy, payee: support.payee }, listing: listingPin(listing), price: support.price, protocol: { jobId } },
    state: { protocol: { stage: 'identity', listing } } };
}

export function offBuyerBundle(buyer, presentedAt = OFF_NOW) {
  const unsigned = buildUnsignedIdentityBundle({ address: buyer.address, presentedAt, sessionSeed: 'seller-context-scenario' });
  return attachIdentityPresentation(unsigned, buyer.signHex(unsigned.message));
}

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
const tableRows = (db, sql) => db.prepare(sql).all().map((row) => ({ ...row }));

export async function sellerContextOffScenario({ directory }) {
  const now = () => OFF_NOW;
  const seller = fixedWallet('11'.repeat(32)), buyer = fixedWallet('22'.repeat(32));
  const listing = fixtureListing(seller, { listingId: 'seller-context-scenario', price: '1', now: OFF_NOW });
  const buyerBundle = offBuyerBundle(buyer);
  const anchor = memoryAnchor(seller.claim);
  const provider = createDevnetDemoAgreementContextProvider({ anchor, wallet: { claim: seller.claim, signBytes: seller.signBytes }, listing, store: createInMemoryPartyVetStore(), buyerAccess: createOperatorBuyerAccess({ openBuyerAccess: true }), now });
  const capability = createDemDeliveryContext({ authority: 'TEST-seller-context-scenario', resolveBuyer: provider.resolveBuyer, resolveSeller: provider.resolveSeller });
  const operation = offOperation({ listing, buyer });
  const buyerContext = await resolveDemDeliveryBuyerContext(capability, { operation, listing, buyerBundle, generatedAt: OFF_NOW });
  if (buyerContext.disposition !== 'present') throw new Error(`scenario context is ${buyerContext.disposition}: ${buyerContext.reason}`);
  const planned = planAgreementFromInput(buyerContext.input);
  const sellerContext = await resolveDemDeliverySellerContext(capability, { jobId: OFF_JOB, listing, buyerBundle, generatedAt: OFF_NOW });

  const declarations = [
    createSourceDemoSellerTransport({ authority: 'TEST-seller-context-scenario', authenticationFor: () => null }).declaration,
    createSourceDemoSellerTransport({ authority: 'TEST-seller-context-scenario', authenticationFor: () => null, sessionDelegation: { request: () => null, accept: () => null } }).declaration,
  ];

  // The seven authenticated transport routes, byte for byte.
  const agent = {
    claim: seller.claim, listingPin: listingPin(listing), transportAgreementOf: () => null,
    receiveProposal: () => ({ disposition: 'complete', scenario: true }), agreementState: () => ({ proposal: null, contribution: null }),
    commit: () => ({ status: 'committed', scenario: true }), submitPayment: () => ({ status: 'delivered', scenario: true }),
    bundleRequest: () => ({ bundleHash: 'e'.repeat(64), scenario: true }), countersign: () => ({ status: 'seller-copy-anchored', scenario: true }), confirmBuyerCopy: () => ({ status: 'verified', scenario: true }),
  };
  const storePath = join(directory, 'seller-transport.sqlite');
  const store = createSellerTransportStore({ path: storePath });
  const serverAuth = createSellerTransportServerAuth({ sellerSigner: { claim: seller.claim, sign: seller.signBytes }, listingPin: agent.listingPin, store, now });
  const server = http.createServer(createSellerHttpHandler(agent, { authentication: serverAuth }));
  const traffic = [];
  try {
    const origin = `http://127.0.0.1:${await listen(server)}`;
    let counter = 0;
    const auth = createSellerTransportClientAuth({ buyerSigner: { claim: buyer.claim, sign: buyer.signBytes }, seller: seller.claim, now,
      resolveJob: () => ({ listingPin: agent.listingPin, agreementHash: planned.plan.agreementHash }), nonce: () => Buffer.from(`scenario-nonce-${String(++counter).padStart(8, '0')}`).toString('base64url') });
    const fetchImpl = async (url, options) => {
      const response = await fetch(url, options), text = await response.text();
      traffic.push({ path: new URL(url).pathname, request: { headers: options.headers, body: options.body }, response: { status: response.status, contentType: response.headers.get('content-type'), peer: response.headers.get('x-dacs-seller-peer'), text } });
      return new Response(text, { status: response.status, headers: response.headers });
    };
    const client = createSellerAgentClient({ url: origin, fetchImpl, authentication: auth, timeoutMs: 5000 });
    const contribution = await createFixedPriceAgreementSignatureContribution(planned.plan, 'buyer', { party: buyer.claim, algorithm: 'ed25519', sign: buyer.signBytes });
    const material = { proposalVersion: '1', plan: planned.plan, buyerContribution: contribution };
    const proposalHash = sha256Hex(canonicalize(material));
    const transportIdentity = { jobId: OFF_JOB, planHash: planned.plan.planHash, agreementHash: planned.plan.agreementHash, buyer: buyer.claim, seller: seller.claim, proposalHash };
    await client.agreementState(transportIdentity);
    await client.propose({ proposal: { ...material, proposalHash }, transportIdentity, buyerIdentityBundle: buyerBundle });
    await client.commit(OFF_JOB);
    await client.submitPayment({ jobId: OFF_JOB, txHash: sha256Hex(`scenario:${OFF_JOB}`), payerPayingKey: buyer.claim });
    await client.bundleRequest(OFF_JOB);
    await client.countersign(OFF_JOB, 'scenario-only-signature');
    await client.confirmBuyerCopy(OFF_JOB);
    const contextPath = await fetch(`${origin}/dacs/v1/agreements/context`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: { jobId: OFF_JOB } }) });
    traffic.push({ path: '/dacs/v1/agreements/context', response: { status: contextPath.status, contentType: contextPath.headers.get('content-type'), connection: contextPath.headers.get('connection'), text: await contextPath.text() } });
  } finally { await close(server); store.close(); }
  const db = new DatabaseSync(storePath, { readOnly: true });
  let journal;
  try {
    journal = {
      meta: tableRows(db, 'SELECT * FROM peer_meta ORDER BY key'), jobs: tableRows(db, 'SELECT * FROM peer_jobs ORDER BY job'),
      effects: tableRows(db, 'SELECT effect, state, status, response FROM peer_effects ORDER BY effect'), slots: tableRows(db, 'SELECT * FROM peer_slots ORDER BY slot'),
      transactions: tableRows(db, 'SELECT * FROM peer_transactions ORDER BY tx'), nonces: tableRows(db, 'SELECT * FROM peer_nonces ORDER BY nonce'),
    };
  } finally { db.close(); }
  const parts = {
    buyerContext: { disposition: buyerContext.disposition, input: buyerContext.input, scope: buyerContext.scope, authority: buyerContext.authority },
    agreement: { agreementHash: planned.plan.agreementHash, planHash: planned.plan.planHash, agreementMessage: planned.agreementMessage, draft: planned.draft },
    sellerContext, vetArtifacts: anchor.publishes, invocations: provider.invocations, declarations, traffic, journal,
  };
  return { digest: sha256Hex(canonicalize(parts)), parts };
}

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import DatabaseSync from 'better-sqlite3';
import { canonicalize, contentHash, createFixedPriceAgreementSignatureContribution, createFixedPriceAgreementSigningPlan, deriveFixedPriceAgreement, finalizeFixedPriceAgreementContributions, sha256Hex } from '@kynesyslabs/dacs';
import { DACS_SELLER_HTTP_DOMAINS, admitPreAgreementRequest, bindTp1Profile, checkWireRequest, inspectWireOperation, openWireEnvelope, openWireRequestJournal, TP1_APPROVED_IDENTITY_RECORD, wireOperationId } from '@kynesyslabs/dacs/wire';
import { createSellerTransportStore } from '../../src/dacs/seller-transport-auth.mjs';
import { testWallet } from './protocol-fixture.mjs';
import { FIXTURE_PROFILE, TEST_CONNECTION, authorityReader } from './wire-authority-fixture.mjs';
import { fixtureIdentityBundle, fixtureListing } from '../fixtures/listings.mjs';
import { agreementInput, contributionVerifier, listingPin } from '../../src/dacs/purchase-protocol.mjs';

export const T0 = 1793102400000;
export const JOB = '01M5YKPJG0248H248H248H248H';
export const JOB2 = '01M5YKPJG048H248H248H248H2';
export const PROPOSALS = '/dacs/v1/agreements/proposals';
export const PAYMENTS = '/dacs/v1/payments';
export const CONTEXT = '/dacs/v1/agreements/context';
export const PAYMENT_TX = sha256Hex('default payment transaction');
export const BUYER = testWallet(1), SELLER = testWallet(2);
export const OTHER = testWallet(4);
const SESSION = testWallet(3);
export const PIN = { listingId: 'tp1-vector-listing', version: 1, contentHash: sha256Hex('contracts-vector-listing') };
export const nonceKey = (p) => sha256Hex(canonicalize({ buyer: p.buyer, seller: p.seller, profile: p.profile, nonce: p.nonce }));

// Actual SQL and wire journal, with a clock that never depends on wall time.
export async function accountingFixture(t, options = {}) {
  t.mock.method(performance, 'now', () => 0);
  const dir = mkdtempSync(join(tmpdir(), 'TEST-accounting-'));
  const journalDir = join(dir, 'journal'); mkdirSync(journalDir, { mode: 0o700 });
  const path = join(dir, 'transport.sqlite');
  let time = T0, sequence = 0;
  const now = () => time;
  // The store reads the wire's own record of an operation, as the host does with its journal.
  const wireOperationView = target => inspectWireOperation(journal, target);
  let store = createSellerTransportStore({ path, now, wireOperationView, ...options });
  const db = new DatabaseSync(path);
  const journal = openWireRequestJournal(journalDir, { clock: now, leaseMs: 300000 });
  const binding = await bindTp1Profile({ record: TP1_APPROVED_IDENTITY_RECORD, local: TEST_CONNECTION, readAuthority: authorityReader() });
  t.after(() => { db.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const payload = (change = {}) => ({ version: '1', kind: 'request', method: 'POST', path: PROPOSALS,
    buyer: BUYER.claim, seller: SELLER.claim, listingPin: PIN, jobId: JOB, agreementHash: sha256Hex('agreement'),
    nonce: Buffer.from(String(++sequence).padStart(24, '0')).toString('base64url'), profile: FIXTURE_PROFILE,
    bodyHash: sha256Hex('{}'), expiresAt: time + 30000, ...change });
  const openSigned = async (p, delegated) => {
    const signer = delegated ? SESSION : BUYER;
    const signature = signer.signBytes(Buffer.from(DACS_SELLER_HTTP_DOMAINS.request + canonicalize(p))).toString('base64url');
    const delegationPayload = { version: '1', kind: 'seller-session-delegation', buyer: BUYER.claim, seller: SELLER.claim,
      sessionPublicKey: SESSION.claim.split(':').at(-1), listingPin: p.listingPin, jobId: p.jobId,
      notBefore: T0 - 1000, expiresAt: T0 + 60000, profile: FIXTURE_PROFILE };
    const delegation = { payload: delegationPayload,
      signature: BUYER.signBytes(Buffer.from(DACS_SELLER_HTTP_DOMAINS.delegation + canonicalize(delegationPayload))).toString('base64url') };
    return openWireEnvelope(Buffer.from(canonicalize({ payload: p, signature, ...(delegated ? { delegation } : {}) })).toString('base64url'), 'request', { binding, local: TEST_CONNECTION, purchaseProfile: FIXTURE_PROFILE });
  };
  const admit = async (p = payload(), change = {}, delegated = false) => {
    const opened = await openSigned(p, delegated);
    const checked = await checkWireRequest(opened, { binding, local: TEST_CONNECTION, purchaseProfile: FIXTURE_PROFILE,
      method: 'POST', path: p.path, rawBody: Buffer.from('{}'), now: time, seller: SELLER.claim, listingPin: p.listingPin,
      retained: { buyer: p.buyer, seller: p.seller, jobId: p.jobId, agreementHash: p.agreementHash, allocated: false }, ready: true, requestJournal: journal, ...change });
    return { checked, payload: p, route: p.path, operationId: wireOperationId(p), keepProfile: FIXTURE_PROFILE };
  };
  // The context start through the wire's pre-Agreement admission, which carries the context scope hash instead of an Agreement.
  const admitContext = async (p = payload({ path: CONTEXT, agreementHash: sha256Hex('context scope') }), change = {}, delegated = false) => {
    const opened = await openSigned(p, delegated);
    const checked = await admitPreAgreementRequest(opened, { binding, local: TEST_CONNECTION, purchaseProfile: FIXTURE_PROFILE,
      route: 'context', method: 'POST', path: p.path, rawBody: Buffer.from('{}'), now: time, seller: SELLER.claim, listingPin: p.listingPin,
      retained: { buyer: p.buyer, seller: p.seller, jobId: p.jobId, agreementHash: p.agreementHash, accepted: false }, ready: true, requestJournal: journal, ...change });
    return { checked, payload: p, route: p.path, operationId: wireOperationId(p), keepProfile: FIXTURE_PROFILE };
  };
  // A payment request carries its transaction in the admitted body and claims it; `change` may override either.
  const args = (p = payload(), change = {}) => ({ checked: { reserve: async () => ({ state: 'new' }), body: p.path === PAYMENTS ? { payerPayingKey: p.buyer, txHash: PAYMENT_TX } : {} },
    payload: p, route: p.path, operationId: wireOperationId(p), keepProfile: FIXTURE_PROFILE, ...(p.path === PAYMENTS ? { paymentTx: PAYMENT_TX } : {}), ...change });
  const reserve = (input) => store.reservationAccounting.reserveAccounted(input);
  const rows = () => db.prepare('SELECT * FROM kit_reservations ORDER BY rowid').all();
  const files = () => readdirSync(journalDir).sort();
  const nonces = () => files().filter(name => name.startsWith('k-'));
  // Each payment passes the real continuation gate with a signed Agreement, Listing and commitment.
  const payment = async (jobId = JOB, change = {}, tx = sha256Hex('payment of ' + jobId)) => {
    const rawBody = Buffer.from(JSON.stringify({ payerPayingKey: BUYER.claim, txHash: tx }));
    const listing = fixtureListing(SELLER, { now: T0 });
    const draft = deriveFixedPriceAgreement(agreementInput({ jobId, listing, buyerBundle: fixtureIdentityBundle(BUYER, T0 - 1000), generatedAt: T0 - 1000 }));
    const plan = createFixedPriceAgreementSigningPlan(draft);
    const contributions = await Promise.all([['buyer', BUYER], ['seller', SELLER]].map(([role, signer]) =>
      createFixedPriceAgreementSignatureContribution(plan, role, { party: signer.claim, algorithm: 'ed25519', sign: signer.signBytes })));
    const agreement = await finalizeFixedPriceAgreementContributions(plan, contributions, contributionVerifier);
    const agreementHash = contentHash(agreement), pin = listingPin(listing);
    const unsigned = { finalityCommitmentVersion: '1', jobId, agreementHash, listingRef: pin, parties: [BUYER.claim, SELLER.claim], pattern: 'fixed-price', createdAt: T0 - 500 };
    const record = { ...unsigned, signature: { algorithm: 'ed25519', signer: SELLER.claim,
      value: SELLER.signBytes(Buffer.from('dacs-finality-commitment:v1:' + contentHash(unsigned))).toString('base64url') } };
    const logicalAddress = `dacs3:commit:${jobId}`;
    const commitment = { logicalAddress, nativeAddress: 'TEST-commitment', agreementHash, committedAt: T0, resumed: false, recordKind: 'finality', record,
      anchorTxRef: { kind: 'storage-program', address: 'TEST-commitment', writeTxHash: sha256Hex('TEST commitment write') },
      anchorReceipt: { receiptVersion: '1', substrate: 'demos', finalityProfile: 'demos-bft-final', logicalAddress, nativeAddress: 'TEST-commitment',
        contentHash: contentHash(record), transactionRef: { kind: 'demos', value: 'TEST commitment write' }, writer: SELLER.claim, nonce: '1',
        state: 'finalized', observationDisposition: 'established', observedAt: T0,
        blockRef: { id: 'TEST-block', height: '1', timestamp: T0 }, evidence: { kind: 'TEST-finality', value: 'TEST-proof' } } };
    const input = await admit(payload({ path: PAYMENTS, jobId, agreementHash, listingPin: pin, bodyHash: sha256Hex(rawBody) }), {
      rawBody, commitment: Buffer.from(JSON.stringify(commitment)), agreement: Buffer.from(JSON.stringify(agreement)), signedListing: Buffer.from(JSON.stringify(listing)),
      retained: { buyer: BUYER.claim, seller: SELLER.claim, jobId, agreementHash },
      readCommitmentReceipt: Object.assign(async () => 'valid', { chainIdentity: FIXTURE_PROFILE.chainIdentity }),
      ...change,
    });
    return { ...input, paymentTx: tx };
  };
  return { dir, path, db, journal, journalDir, payload, admit, admitContext, payment, args, reserve, rows, files, nonces, now,
    store: () => store, setTime: value => { time = value; },
    reopen: () => { store.close(); store = createSellerTransportStore({ path, now, wireOperationView, ...options }); },
    tuples: () => db.prepare('SELECT COUNT(*) AS n FROM kit_purchase_profiles').get().n,
    payments: () => db.prepare('SELECT * FROM kit_payment_transactions').all(),
    jobRows: () => db.prepare('SELECT * FROM peer_jobs ORDER BY rowid').all(),
    holds: () => db.prepare('SELECT * FROM kit_job_holds ORDER BY rowid').all(),
    assertEmpty: () => {
      assert.equal(rows().length, 0); assert.equal(files().length, 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM kit_job_holds').get().n, 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM kit_purchase_profiles').get().n, 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM peer_jobs').get().n, 0);
    },
  };
}

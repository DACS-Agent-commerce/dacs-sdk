// Unshipped fixture for the signed challenge route: the HTTP handler composed directly over a real transport
// store, with the wire context, an injectable stop predicate, readiness and clock, and counters for ledger rows,
// ledger statements and wire journal files. Requests are signed through the wire's buyer; `envelope` builds the
// hostile ones the buyer refuses to sign.
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { canonicalize, generateCanonicalJobId, sha256Hex } from '@kynesyslabs/dacs';
import { DACS_SELLER_HTTP_DOMAINS, DACS_SELLER_HTTP_PATHS, TP1_APPROVED_IDENTITY_RECORD, admitWireArtifact, bindTp1Profile, openWireRequestJournal } from '@kynesyslabs/dacs/wire';
import { fixtureListing } from '../fixtures/listings.mjs';
import { listingPin } from '../../src/dacs/purchase-protocol.mjs';
import { purchaseSupport } from '../../src/dacs/listing.mjs';
import { AGREEMENT_CONTEXT_SOURCE } from '../../src/dacs/agreement-context-consumer.mjs';
import { createSellerContextRoute } from '../../src/dacs/seller-context-route.mjs';
import { createSellerHttpHandler } from '../../src/dacs/seller-http.mjs';
import { createWireContext } from '../../src/dacs/seller-wire-requests.mjs';
import { SELLER_CONTEXT_PATH, SELLER_TRANSPORT_HEADER, createSellerTransportServerAuth } from '../../src/dacs/seller-transport-auth.mjs';
import { createSellerTransportStore } from './bound-transport-store.mjs';
import { exchange } from './d5-http-fixture.mjs';
import { testWallet } from './protocol-fixture.mjs';
import { TEST_CONNECTION, authorityReader } from './wire-authority-fixture.mjs';
import { wireBuyer } from './wire-buyer.mjs';

export const T0 = Date.UTC(2026, 9, 27, 12);
export const JOB = generateCanonicalJobId({ timestamp: T0, entropy: new Uint8Array(10).fill(0x11) });
export const JOB2 = generateCanonicalJobId({ timestamp: T0, entropy: new Uint8Array(10).fill(0x22) });
export const CHALLENGE_PATH = DACS_SELLER_HTTP_PATHS.contextChallenge;
export const CONTEXT_PATH = SELLER_CONTEXT_PATH;
export const CHALLENGE_LIFETIME_MS = 600_000;
const CLAIM_PREFIX = 'did:demos:agent:';
const DELEGATION_LEAD_MS = 30_000;
const DELEGATION_LIFETIME_MS = 3_600_000;
const [SELLER, BUYER, OTHER, SESSION] = [testWallet(2), testWallet(1), testWallet(3), testWallet(99)];
const signer = (wallet) => ({ claim: wallet.claim, sign: wallet.signBytes });
const unexpected = (name) => () => { throw new Error(`TEST the challenge route reached ${name}`); };

/** Resolves `entered` when the callback that awaits `pass()` is reached, and lets it go on at `release()`. */
export function gate() {
  let release, enter;
  const open = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { enter = resolve; });
  return { entered, release, pass: async () => { enter(); await open; } };
}

/** Counts the SQL statements prepared from now on: `reads` of the challenge ledger, and `writes` to any table. */
export function watchSql(t) {
  const seen = [];
  const prepare = Database.prototype.prepare;
  t.mock.method(Database.prototype, 'prepare', function (sql) { seen.push(String(sql)); return prepare.call(this, sql); });
  const isWrite = (sql) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql);
  return { reads: () => seen.filter((sql) => /kit_challenges/.test(sql) && !isWrite(sql)).length, writes: () => seen.filter(isWrite).length };
}

export async function challengeWorld(t, { store: storeOptions = {}, requireDelegation = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'TEST-challenge-route-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'transport.sqlite'), journalDirectory = join(directory, 'wire-journal');
  mkdirSync(journalDirectory, { mode: 0o700 });
  const listing = fixtureListing(SELLER, { now: T0 }), pin = listingPin(listing), support = purchaseSupport(listing);
  const state = { time: T0, ledgerClock: null, stop: () => false, ready: () => true, sessionState: () => null, generation: 0, authority: true };
  const calls = { access: 0, known: 0, connection: 0, continuationEvidenceOf: 0, readCommitmentReceipt: 0, transportAgreementOf: 0 };
  const policy = { access: async () => {}, known: async () => true };
  const confirmed = authorityReader();
  const readAuthority = (scope) => { if (!state.authority) throw new Error('TEST the authority was withdrawn'); return confirmed(scope); };
  const binding = await bindTp1Profile({ record: TP1_APPROVED_IDENTITY_RECORD, local: { ...TEST_CONNECTION }, readAuthority });
  const now = () => state.time;
  let store = null, handler = null;
  const open = () => {
    store = createSellerTransportStore({ path, now: () => (state.ledgerClock ?? now)(), generation: `TEST-generation-${++state.generation}`,
      stopped: () => state.stop(), contextSessionState: (input) => state.sessionState(input), ...storeOptions });
  };
  open();
  t.after(() => store.close());
  const route = createSellerContextRoute({ listing, now, writable: unexpected('writable'),
    assertBuyerAccess: async (buyer) => { calls.access++; return policy.access(buyer); },
    knownJob: async (...input) => { calls.known++; return policy.known(...input); },
    admitPresentation: unexpected('admitPresentation'), admitWrites: unexpected('admitWrites'), releaseWrites: unexpected('releaseWrites'),
    resolveBuyer: unexpected('resolveBuyer'), recover: unexpected('recover') });
  const journal = openWireRequestJournal(journalDirectory, { leaseMs: 300_000, clock: now });
  t.after(() => journal.close?.());
  const agent = { claim: SELLER.claim, listingPin: pin, transportAgreementOf: () => { calls.transportAgreementOf++; return null; },
    continuationEvidenceOf: () => { calls.continuationEvidenceOf++; return null; }, retainsPaymentClaim: () => true, retainsPaymentWork: () => true, assertSettlementCredit: () => {} };
  const readCommitmentReceipt = Object.assign(() => { calls.readCommitmentReceipt++; return 'valid'; }, { chainIdentity: TP1_APPROVED_IDENTITY_RECORD.chainIdentity });
  /** The wire context over the current store; `overrides` replace only the members they name. */
  const makeWire = (overrides = {}) => createWireContext({ binding, tp1Network: { connection: () => { calls.connection++; return { ...TEST_CONNECTION }; } }, signer: signer(SELLER), store, journal,
    ready: () => state.ready(), stopped: () => state.stop(), now, agent, requireDelegation, signedListing: admitWireArtifact(Buffer.from(JSON.stringify(listing))), readCommitmentReceipt, ...overrides });
  let wire = null;
  const compose = () => {
    wire = makeWire();
    const authentication = createSellerTransportServerAuth({ sellerSigner: signer(SELLER), listingPin: pin, store, now, requireDelegation });
    handler = createSellerHttpHandler(agent, { authentication, context: route, wire });
  };
  compose();

  const scopeFor = (jobId = JOB, actor = BUYER, generatedAt = state.time) => ({ source: AGREEMENT_CONTEXT_SOURCE, wallet: actor.address, jobId, buyer: actor.claim,
    seller: SELLER.claim, listingPin: pin, rail: { railId: 'demos-native:DEM', railVersion: 1 }, payee: support.payee, price: support.price, generatedAt });
  const delegationFor = ({ jobId = JOB, actor = BUYER, at = state.time, lifetimeMs = DELEGATION_LIFETIME_MS, domain = DACS_SELLER_HTTP_DOMAINS.delegation, overrides = {} } = {}) => {
    const payload = { version: '1', kind: 'seller-session-delegation', buyer: actor.claim, sessionPublicKey: SESSION.claim.slice(CLAIM_PREFIX.length), seller: SELLER.claim,
      listingPin: pin, jobId, notBefore: at - DELEGATION_LEAD_MS, expiresAt: at + lifetimeMs, profile: binding.profile, ...overrides };
    return { payload, signature: actor.signBytes(Buffer.from(domain + canonicalize(payload))).toString('base64url') };
  };
  /** A request signed through the wire's buyer; delegated by default. `scope`, `body`, `hash`, `text` replace only what they name. */
  const sign = async ({ jobId = JOB, actor = BUYER, delegated = true, scope = scopeFor(jobId, actor), body = { scope }, hash = sha256Hex(canonicalize(body.scope)),
    text = JSON.stringify(body), delegation, lifetimeMs, path: signedPath = CHALLENGE_PATH, nonce } = {}) => {
    const buyer = await wireBuyer({ buyer: signer(actor), seller: signer(SELLER), listingPin: pin, clock: now });
    const signedWith = delegated ? (delegation ?? delegationFor({ jobId, actor })) : null;
    const signed = await buyer.signRequest(signedPath, body, { jobId, agreementHash: hash, delegation: signedWith, signer: delegated ? signer(SESSION) : signer(actor), text, lifetimeMs, nonce });
    return { ...signed, body, url: CHALLENGE_PATH, verify: (answer) => buyer.authentication(() => hash).verifyResponse(signed.payload,
      { header: answer.signature, status: answer.status, responseBytes: Buffer.from(answer.text) }) };
  };
  /** A request envelope for `payload` signed by `by` with the wire's request domain, as the buyer would not sign it. */
  const envelope = (payload, by, delegation = null) => ({ header: Buffer.from(canonicalize({ payload,
    signature: by.signBytes(Buffer.from(DACS_SELLER_HTTP_DOMAINS.request + canonicalize(payload))).toString('base64url'), ...(delegation ? { delegation } : {}) })).toString('base64url') });
  const post = async ({ url = CHALLENGE_PATH, header, text, headers, chunks }) => {
    const res = await exchange(handler, { url, header, text, headers, chunks });
    return { status: res.status, text: res.text, body: JSON.parse(res.text), signature: res.headers?.[SELLER_TRANSPORT_HEADER] };
  };
  const rows = () => { const db = new Database(path, { readonly: true }); try { return db.prepare('SELECT * FROM kit_challenges').all(); } finally { db.close(); } };
  const journalFiles = () => readdirSync(journalDirectory).filter((name) => /^[ko]-/.test(name)).length;
  /** Fills the hourly overall limit up to `count` rows, each for its own buyer and job. */
  const seedRows = (count) => {
    const db = new Database(path);
    try {
      for (let index = 0; index < count; index++) {
        db.prepare("INSERT INTO kit_challenges (nonce,jobId,buyer,challengeScopeHash,origin,issuedAt,expiresAt,state) VALUES (?,?,?,?,'route',?,?,'issued')")
          .run(sha256Hex(`TEST-seed-${index}`), generateCanonicalJobId({ timestamp: T0, entropy: new Uint8Array(10).fill(0x40 + index) }), testWallet(40 + index).claim,
            sha256Hex(`TEST-scope-${index}`), state.time, state.time + CHALLENGE_LIFETIME_MS);
      }
    } finally { db.close(); }
  };
  /** One context record in the admissions table, so a store limited to one record is full. */
  const seedContextRecord = () => {
    const db = new Database(path);
    try {
      db.exec('CREATE TABLE IF NOT EXISTS peer_context_admissions (job TEXT PRIMARY KEY, buyer TEXT NOT NULL, seller TEXT NOT NULL, listing_pin TEXT NOT NULL, scope_hash TEXT NOT NULL, effect TEXT NOT NULL, admitted_at INTEGER NOT NULL)');
      db.prepare('INSERT INTO peer_context_admissions VALUES (?,?,?,?,?,?,?)').run(JOB2, OTHER.claim, SELLER.claim, canonicalize(pin), sha256Hex('TEST-scope'), sha256Hex('TEST-effect'), state.time);
    } finally { db.close(); }
  };
  const restart = () => { store.close(); open(); compose(); };
  return { route, agent, makeWire, get wire() { return wire; }, calls, policy, state, scopeFor, delegationFor, sign, envelope, post, rows, journalFiles, seedRows, seedContextRecord, restart, path,
    other: OTHER, buyer: BUYER, seller: SELLER, session: SESSION, listing, pin, advance: (ms) => { state.time += ms; }, get store() { return store; }, get handler() { return handler; } };
}

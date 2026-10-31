#!/usr/bin/env node
// Generate vectors/dacs-seller-http-v1.json from the built SDK (npm run build).
// Every vector names the one check that refuses it; test/wire/vectors.test.ts
// replays them, and scripts/wire/mutate-wire-checks.mjs shows each named check
// is the one that catches its vector. Keys are generated at run time and
// discarded. The TP-1 identity records are SYNTHETIC: none is the approved record.
// The generator binds nothing: it writes the TP-1 profile member from the
// synthetic record itself. test/wire/vectors.test.ts approves that record
// only through its test approval list (test/wire/testApproval.ts); binding
// vectors name the gate they use.
//
// Usage: node scripts/wire/generate-wire-vectors.mjs --sdk-dist dist --out vectors/dacs-seller-http-v1.json
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AGREEMENT_HASH, HOUR, JOB_ID, LISTING_PIN, LOCAL_A, LOCAL_B, NONCE, NOW, OTHER_JOB_ID, PUBLIC_ENDPOINT, party,
  sha256Hex, syntheticIdentityRecord, writeJson,
} from "./fixture-helpers.mjs";

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, i, all) => (i % 2 === 0 ? [...pairs, [value.replace(/^--/, ""), all[i + 1]]] : pairs), []));
if (!args["sdk-dist"] || !args.out) throw new Error("--sdk-dist and --out are required");
const wire = await import(pathToFileURL(join(resolve(args["sdk-dist"]), "wire/index.js")).href);
const { canonicalize } = await import(pathToFileURL(join(resolve(args["sdk-dist"]), "canonical/index.js")).href);

const buyer = party(), seller = party(), session = party(), other = party();
const record = syntheticIdentityRecord("vectors");
const otherRecord = syntheticIdentityRecord("vectors-other-chain");
const mainnetLabelledTestnet = { ...syntheticIdentityRecord("MOCKED-MAINNET"), recordId: "synthetic-test-only/mocked-mainnet-labelled-testnet" };
const digest = (r) => sha256Hex(canonicalize(r));
const approved = [digest(record)];
// The profile member a binding for `record` carries (bindTp1Profile, src/wire/profile.ts).
const profile = { id: wire.TP1_PROFILE_ID, revision: wire.TP1_PROFILE_REVISION, base: wire.TP1_BASE_REVISION, chainIdentity: record.chainIdentity, pinVersion: record.pinVersion };
// A well-formed profile naming the mocked mainnet identity: what a changing payload answers after its first reads.
const mainnetProfile = { ...profile, chainIdentity: mainnetLabelledTestnet.chainIdentity };
// The tuple (identifier, revision, base). These profiles match the identifier and base, and differ only in the revision.
const revised = (revision) => ({ ...profile, revision });
const { revision: _rev, ...preRevisionProfile } = profile;
const identifierAndBase = { id: profile.id, base: profile.base };
// Case, whitespace and type variants of "TP-1": the revision is compared exactly, so each is unknown.
const REVISION_VARIANTS = [
  ["lowercase", "tp-1"], ["mixed-case", "Tp-1"], ["leading-space", " TP-1"], ["trailing-space", "TP-1 "], ["trailing-newline", "TP-1\n"],
  ["inner-space", "TP- 1"], ["empty", ""], ["number", 1], ["null", null], ["boolean", true], ["array", ["TP-1"]], ["object", { revision: "TP-1" }],
];

// Each actor's own connection after a change: the binding made for the old one no longer authorizes it.
const SELLER_CHANGED = { ...LOCAL_B, connectionId: "conn-b-2" };
const BUYER_CHANGED = { ...LOCAL_A, connectionId: "conn-a-2" };

const PATH = "/dacs/v1/commitments";
const BODY = `{"jobId":"${JOB_ID}"}`;
const RESPONSE_TEXT = '{"status":"committed"}';
const OTHER_PIN = { ...LISTING_PIN, version: 2 };
const OLD = { request: "dacs-chatgpt-plugin:loopback-seller-peer:v1:", delegation: "dacs-chatgpt-plugin:seller-session-delegation:v1:" };
const D = wire.DACS_SELLER_HTTP_DOMAINS;
const b64 = (bytes) => Buffer.from(bytes).toString("base64url");
const sig = (signer, text) => b64(signer.sign(Buffer.from(text, "utf8")));
const signedText = (domain, payload, signer) => sig(signer, `${domain}${canonicalize(payload)}`);
const headerOf = (envelope) => b64(Buffer.from(canonicalize(envelope), "utf8"));

const request = { version: "1", kind: "request", method: "POST", path: PATH, bodyHash: sha256Hex(BODY), jobId: JOB_ID, buyer: buyer.claim, seller: seller.claim, listingPin: LISTING_PIN, agreementHash: AGREEMENT_HASH, nonce: NONCE, expiresAt: NOW + 30_000, profile };
const { profile: _p, ...requestWithoutProfile } = request;
const req = (p, { signer = buyer.signer, domain = D.request, delegation } = {}) => headerOf({ payload: p, signature: signedText(domain, p, signer), ...(delegation ? { delegation } : {}) });
const delegationPayload = { version: "1", kind: "seller-session-delegation", buyer: buyer.claim, sessionPublicKey: session.raw, seller: seller.claim, listingPin: LISTING_PIN, jobId: JOB_ID, notBefore: NOW - 1000, expiresAt: NOW + HOUR, profile };
const del = (p, { signer = buyer.signer, domain = D.delegation } = {}) => ({ payload: p, signature: `0x${Buffer.from(signer.sign(Buffer.from(`${domain}${canonicalize(p)}`, "utf8"))).toString("hex")}` });
const delegation = del(delegationPayload);
const delegated = { ...request, nonce: Buffer.from(NONCE, "base64url").reverse().toString("base64url") };
// expiresAt is 60 s after NOW: a seller whose clock runs 30 s (maxClockSkewMs) ahead, signing its 30 s answer; the buyer's 60 s window admits it.
const response = { ...request, kind: "response", bodyHash: sha256Hex(RESPONSE_TEXT), expiresAt: NOW + 60_000, requestHash: sha256Hex(canonicalize(request)), status: 200 };
const resp = (p, { signer = seller.signer, domain = D.response } = {}) => headerOf({ payload: p, signature: signedText(domain, p, signer) });
// A seller answer signed by the buyer-delegated session key and carrying the buyer's valid delegation of that key:
// the seller signs every answer with its own key, so no delegation ever authenticates a response.
const delegatedResponse = headerOf({ payload: response, signature: signedText(D.response, response, session.signer), delegation });

// Raw-input (CF-5) header cases: correctly signed, refused only by admission.
const envelopeText = (p) => JSON.stringify({ payload: p, signature: signedText(D.request, p, buyer.signer) });
const duplicateHeader = b64(Buffer.from(envelopeText(request).replace(`"nonce":"${NONCE}"`, `"nonce":"${NONCE}","nonce":"${NONCE}"`), "utf8"));
// A reordered, whitespace-rich header is still admitted (CF-5 does not require JCS form).
const reorderedHeader = b64(Buffer.from(`{ "signature" : "${signedText(D.request, request, buyer.signer)}",\n  "payload" : ${JSON.stringify(Object.fromEntries(Object.entries(request).reverse()), null, 1)} }`, "utf8"));
// Malformed UTF-8 / non-NFC in a signed header string that canonicalization would otherwise accept.
const pinWith = (listingId) => ({ ...request, listingPin: { ...LISTING_PIN, listingId } });
const malformedHeader = (() => {
  const p = pinWith(`${LISTING_PIN.listingId}�`);
  const bytes = Buffer.from(envelopeText(p), "utf8");
  const at = bytes.indexOf(Buffer.from("�", "utf8"));
  return { header: b64(Buffer.concat([bytes.subarray(0, at), Buffer.from([0xff]), bytes.subarray(at + 3)])), serverListingId: `${LISTING_PIN.listingId}�` };
})();
// An out-of-profile number token in a signed header field.
const bigNumberHeader = b64(Buffer.from(envelopeText(request).replace(`"expiresAt":${request.expiresAt}`, '"expiresAt":9007199254740993'), "utf8"));
// The revision given twice, the signed value first: a parser keeping the last member would read "TP-2".
const duplicateRevisionHeader = (() => {
  const text = envelopeText(request);
  if (text.split('"revision":"TP-1"').length !== 2) throw new Error("the request must carry its revision once");
  return b64(Buffer.from(text.replace('"revision":"TP-1"', '"revision":"TP-1","revision":"TP-2"'), "utf8"));
})();
const nfdHeader = (() => {
  const p = pinWith("wire-fixture-café");
  return { header: b64(Buffer.from(envelopeText(p), "utf8")), serverListingId: "wire-fixture-café" };
})();

// Raw-input body cases: the header signs the exact body bytes (bodyHash), so
// only body admission can refuse them.
const bodyCase = (bytes) => ({ header: req({ ...request, bodyHash: sha256Hex(bytes) }), body: b64(bytes) });
const enc = (text) => Buffer.from(text, "utf8");
const malformedBody = Buffer.concat([enc(`{"jobId":"${JOB_ID}","note":"`), Buffer.from([0xc3, 0x28]), enc('"}')]);
// The same for responses: the seller signs the exact body bytes (bodyHash).
const responseBodyCase = (bytes) => ({ header: resp({ ...response, bodyHash: sha256Hex(bytes) }), body: b64(bytes) });
const malformedResponseBody = Buffer.concat([enc('{"status":"committed","note":"'), Buffer.from([0xc3, 0x28]), enc('"}')]);
// The seller's retained proposal draft or Agreement for a delegated request.
const agreement = { jobId: JOB_ID, listingRef: LISTING_PIN, parties: [{ role: "buyer", primaryClaim: buyer.claim }, { role: "seller", primaryClaim: seller.claim }], terms: { deadline: NOW + 2 * HOUR } };

const discovery = {
  format: wire.DACS_SELLER_DISCOVERY_FORMAT, profile, seller: seller.claim, publicEndpoint: PUBLIC_ENDPOINT,
  transport: [wire.DACS_SELLER_HTTP_V1], listings: [LISTING_PIN], capabilities: wire.TP1_CAPABILITIES, ready: true,
  issuedAt: NOW - 1000, expiresAt: NOW + 5 * 60_000,
};
const disc = (p, { signer = seller.signer, domain = D.discovery } = {}) => b64(Buffer.from(canonicalize({ payload: p, signature: signedText(domain, p, signer) }), "utf8"));
const { profile: _dp, ...discoveryWithoutProfile } = discovery;
const discoveryText = (p) => JSON.stringify({ payload: p, signature: signedText(D.discovery, p, seller.signer) });
const discoveryDuplicate = b64(enc(discoveryText(discovery).replace('"ready":true', '"ready":true,"ready":true')));
// Correctly signed discovery documents refused only by admission (UTF-8 and
// NFC): the Listing the buyer checks against names the same pin, so nothing
// else differs. The number case below is not of this kind.
const discoveryFor = (listingId) => {
  const pin = { ...LISTING_PIN, listingId };
  return { p: { ...discovery, listings: [pin] }, listing: { seller: seller.claim, publicEndpoint: PUBLIC_ENDPOINT, listingPin: pin } };
};
const discoveryMalformed = (() => {
  const { p, listing } = discoveryFor(`${LISTING_PIN.listingId}\ufffd`);
  const bytes = enc(discoveryText(p));
  const at = bytes.indexOf(enc("\ufffd"));
  return { document: b64(Buffer.concat([bytes.subarray(0, at), Buffer.from([0xff]), bytes.subarray(at + 3)])), listing };
})();
const discoveryNonNfc = (() => {
  const { p, listing } = discoveryFor("wire-fixture-cafe\u0301");
  return { document: b64(enc(discoveryText(p))), listing };
})();
const discoveryBigNumber = b64(enc(discoveryText(discovery).replace(`"expiresAt":${discovery.expiresAt}`, '"expiresAt":9007199254740993')));

const R = (id, check, input, expect) => ({ id, kind: "request", check, input: { path: PATH, body: b64(enc(BODY)), requireDelegation: false, ...input }, expect });
const G = (id, check, input, expect) => ({ id, kind: "delegation", check, input: { scope: {}, ...input }, expect });
const S = (id, check, input, expect) => ({ id, kind: "response", check, input: { status: 200, body: b64(enc(RESPONSE_TEXT)), ...input }, expect });
const V = (id, check, input, expect) => ({ id, kind: "discovery", check, input: { listing: { seller: seller.claim, publicEndpoint: PUBLIC_ENDPOINT, listingPin: LISTING_PIN }, ...input }, expect });
const B = (id, check, input, expect) => ({ id, kind: "binding", check, input, expect });
const P = (id, check, input, expect) => ({ id, kind: "signing", check, input: { path: PATH, ...input }, expect });
const ok = { ok: true };
const no = (code, detail) => ({ ok: false, code, ...(detail ? { detail } : {}) });

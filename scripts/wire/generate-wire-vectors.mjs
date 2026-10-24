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

const vectors = [
  R("request/valid-direct", null, { header: req(request) }, ok),
  R("request/valid-delegated", null, { header: req(delegated, { signer: session.signer, delegation }), requireDelegation: true }, ok),
  R("request/valid-noncanonical-header", null, { header: reorderedHeader }, ok),
  R("request/expired-delegation-readback-only", "expired delegation cannot start an effect", { header: req({ ...delegated, expiresAt: NOW + 30_000 }, { signer: session.signer, delegation: del({ ...delegationPayload, notBefore: NOW - 2 * HOUR, expiresAt: NOW - 1 }) }), requireDelegation: true }, no("peer_delegation_expired")),
  // No envelope header member at all: refused as an invalid envelope, never a crash.
  R("request/header-missing", "envelope header gate", {}, no("peer_envelope_invalid")),
  R("request/old-domain", "request signature domain", { header: req(request, { domain: OLD.request }) }, no("peer_signature_invalid")),
  R("request/response-domain", "request signature domain", { header: req(request, { domain: D.response }) }, no("peer_signature_invalid")),
  R("request/profile-missing", "profile present", { header: req(requestWithoutProfile, { domain: D.request }) }, no("tp1_profile_missing")),
  R("request/profile-wrong-id", "profile equals own binding", { header: req({ ...request, profile: { ...profile, id: "dacs-testnet-tp2" } }) }, no("tp1_profile_mismatch")),
  R("request/profile-wrong-base", "profile equals own binding", { header: req({ ...request, profile: { ...profile, base: "4bb9e48a1095000000000000000000000000beef" } }) }, no("tp1_profile_mismatch")),
  R("request/profile-wrong-chain", "profile equals own binding", { header: req({ ...request, profile: { ...profile, chainIdentity: otherRecord.chainIdentity } }) }, no("tp1_profile_mismatch")),
  R("request/profile-wrong-pin-version", "profile equals own binding", { header: req({ ...request, profile: { ...profile, pinVersion: "synthetic-test-only/2" } }) }, no("tp1_profile_mismatch")),
  // The tuple (identifier, revision, base), approved 2026-10-15. Every message here is correctly signed and names
  // TP-1's identifier and base: only the revision differs, so only the profile gate can refuse it. `purchaseProfile`
  // is the tuple the seller kept for the job, given to openWireEnvelope and checkWireRequest alike: by default the
  // exact tuple; null for a new purchase.
  R("request/valid-exact-tuple-kept", null, { header: req(request), purchaseProfile: profile }, ok),
  R("request/valid-new-purchase", null, { header: req(request), purchaseProfile: null }, ok),
  R("request/profile-revision-missing", "profile revision present", { header: req({ ...request, profile: preRevisionProfile }) }, no("tp1_profile_revision_missing")),
  R("request/profile-identifier-and-base-only", "profile revision present", { header: req({ ...request, profile: identifierAndBase }) }, no("tp1_profile_revision_missing")),
  R("request/profile-revision-unknown", "profile revision defined", { header: req({ ...request, profile: revised("TP-2") }) }, no("tp1_profile_revision_unknown")),
  // A later revision's name (the declaration plans TP-1.1); this SDK defines only TP-1, so it is also unknown.
  R("request/profile-revision-mismatch", "profile revision defined", { header: req({ ...request, profile: revised("TP-1.1") }) }, no("tp1_profile_revision_unknown")),
  ...REVISION_VARIANTS.map(([name, value]) => R(`request/profile-revision-${name}`, "profile revision defined", { header: req({ ...request, profile: revised(value) }) }, no("tp1_profile_revision_unknown"))),
  R("request/profile-revision-extra-member", "profile equals own binding", { header: req({ ...request, profile: { ...profile, revisions: ["TP-1"] } }) }, no("tp1_profile_mismatch")),
  R("request/profile-revision-duplicate-member", "CF-5 duplicate member", { header: duplicateRevisionHeader }, no("wire_json_rejected", "DUPLICATE-MEMBER")),
  R("request/purchase-profile-omitted", "purchase tuple kept", { header: req(request), purchaseProfile: "omitted" }, no("tp1_purchase_profile_mismatch")),
  R("request/purchase-profile-revision-missing", "purchase tuple kept", { header: req(request), purchaseProfile: preRevisionProfile }, no("tp1_purchase_profile_mismatch")),
  R("request/purchase-profile-other-revision", "purchase tuple kept", { header: req(request), purchaseProfile: revised("TP-1.1") }, no("tp1_purchase_profile_mismatch")),
  R("request/purchase-profile-other-chain", "purchase tuple kept", { header: req(request), purchaseProfile: { ...profile, chainIdentity: otherRecord.chainIdentity } }, no("tp1_purchase_profile_mismatch")),
  // The seller checks the kept tuple when it opens the request, before the header is read, and again in
  // checkWireRequest. `checkPurchaseProfile`, when present, is given to checkWireRequest instead; each of these
  // differs at one entry point only, so only that one can refuse it.
  R("request/open-purchase-profile-other-revision", "purchase tuple kept (open)", { header: req(request), purchaseProfile: revised("TP-1.1"), checkPurchaseProfile: profile }, no("tp1_purchase_profile_mismatch")),
  R("request/open-purchase-profile-omitted", "purchase tuple kept (open)", { header: req(request), purchaseProfile: "omitted", checkPurchaseProfile: profile }, no("tp1_purchase_profile_mismatch")),
  R("request/check-purchase-profile-other-revision", "purchase tuple kept (check)", { header: req(request), purchaseProfile: profile, checkPurchaseProfile: revised("TP-1.1") }, no("tp1_purchase_profile_mismatch")),
  R("request/check-purchase-profile-omitted", "purchase tuple kept (check)", { header: req(request), purchaseProfile: profile, checkPurchaseProfile: "omitted" }, no("tp1_purchase_profile_mismatch")),
  R("request/wrong-signer", "request signature key", { header: req(request, { signer: other.signer }) }, no("peer_signature_invalid")),
  R("request/extra-field", "exact request fields", { header: headerOf({ payload: { ...request, extra: "x" }, signature: signedText(D.request, { ...request, extra: "x" }, buyer.signer) }) }, no("peer_envelope_invalid")),
  R("request/expired", "request expiry", { header: req({ ...request, expiresAt: NOW - 1 }) }, no("peer_expired")),
  // Expired from the instant now === expiresAt, so a journal may drop the reservation then.
  R("request/expires-at-now", "request expiry", { header: req({ ...request, expiresAt: NOW }) }, no("peer_expired")),
  R("request/lifetime-over-60s", "request lifetime", { header: req({ ...request, expiresAt: NOW + 60_001 }) }, no("peer_expired")),
  R("request/lifetime-override-over-60s", "lifetime override bound", { header: req({ ...request, expiresAt: NOW + 120_000 }), maxLifetimeMs: 120_000 }, no("seller_configuration_invalid")),
  R("request/wrong-listing", "listing pin", { header: req(request), server: { listingPin: OTHER_PIN } }, no("peer_listing_mismatch")),
  R("request/wrong-audience", "audience", { header: req(request), server: { seller: other.claim } }, no("peer_audience_wrong")),
  R("request/body-hash-mismatch", "body hash", { header: req(request), body: b64(enc(`{"jobId":"${OTHER_JOB_ID}"}`)) }, no("peer_request_mismatch")),
  // Signed for the read route, received on an effect route; and signed for POST, received as another method.
  R("request/path-mismatch", "request path binding", { header: req({ ...request, path: "/dacs/v1/agreements/state" }), path: "/dacs/v1/payments" }, no("peer_request_mismatch")),
  R("request/method-mismatch", "request method binding", { header: req(request), method: "GET" }, no("peer_request_mismatch")),
  R("request/delegation-required", "delegation required", { header: req(request), requireDelegation: true }, no("peer_delegation_required")),
  // The seller requires a delegation when it opens the request and again in checkWireRequest. `checkRequireDelegation`,
  // when present, is given to checkWireRequest instead; each of these requires it at one entry point only, so only that
  // one can refuse the buyer-signed request.
  R("request/open-delegation-required", "delegation required (open)", { header: req(request), requireDelegation: true, checkRequireDelegation: false }, no("peer_delegation_required")),
  R("request/check-delegation-required", "delegation required (check)", { header: req(request), requireDelegation: false, checkRequireDelegation: true }, no("peer_delegation_required")),
  R("request/valid-delegated-with-agreement", null, { header: req(delegated, { signer: session.signer, delegation }), requireDelegation: true, artifacts: [agreement] }, ok),
  // A seller that does not require a delegation still verifies one a request carries: a buyer never has to guess the setting.
  R("request/valid-delegated-not-required", null, { header: req(delegated, { signer: session.signer, delegation }), requireDelegation: false, artifacts: [agreement] }, ok),
  R("request/delegated-agreement-mismatch", "delegated request matches the retained Agreement", { header: req(delegated, { signer: session.signer, delegation }), requireDelegation: true, artifacts: [{ ...agreement, jobId: OTHER_JOB_ID }] }, no("peer_delegation_agreement_mismatch")),
  // `retained`: the job and Agreement hash the seller host kept, instead of the file's job ("omitted": none given).
  // Each signed request is the valid one: only the host's record differs, so only that comparison can refuse it.
  R("request/retained-agreement-hash-mismatch", "retained Agreement hash", { header: req(request), retained: { jobId: JOB_ID, agreementHash: sha256Hex("other-agreement"), buyer: buyer.claim, seller: seller.claim } }, no("peer_agreement_mismatch")),
  R("request/retained-job-mismatch", "retained job", { header: req(request), retained: { jobId: OTHER_JOB_ID, agreementHash: AGREEMENT_HASH, buyer: buyer.claim, seller: seller.claim } }, no("peer_job_mismatch")),
  R("request/retained-agreement-omitted", "retained Agreement required", { header: req(request), retained: "omitted" }, no("seller_retained_agreement_required")),
  // The retained parties bind a request with no artifacts: another key that knows the job and its public Agreement is refused.
  R("request/retained-buyer-mismatch", "retained buyer", { header: req(request), retained: { jobId: JOB_ID, agreementHash: AGREEMENT_HASH, buyer: other.claim, seller: seller.claim } }, no("peer_agreement_party_mismatch")),
  R("request/retained-seller-mismatch", "retained seller", { header: req(request), retained: { jobId: JOB_ID, agreementHash: AGREEMENT_HASH, buyer: buyer.claim, seller: other.claim } }, no("peer_agreement_party_mismatch")),
  R("request/retained-parties-omitted", "retained parties required", { header: req(request), retained: { jobId: JOB_ID, agreementHash: AGREEMENT_HASH } }, no("seller_retained_agreement_required")),
  R("request/delegated-retained-agreement-hash-mismatch", "retained Agreement hash", { header: req(delegated, { signer: session.signer, delegation }), requireDelegation: true, artifacts: [agreement], retained: { jobId: JOB_ID, agreementHash: sha256Hex("other-agreement"), buyer: buyer.claim, seller: seller.claim } }, no("peer_agreement_mismatch")),
  R("request/delegated-retained-buyer-mismatch", "retained buyer", { header: req(delegated, { signer: session.signer, delegation }), requireDelegation: true, artifacts: [agreement], retained: { jobId: JOB_ID, agreementHash: AGREEMENT_HASH, buyer: other.claim, seller: seller.claim } }, no("peer_agreement_party_mismatch")),
  R("request/delegated-agreement-buyer-party-mismatch", "delegated request matches the retained Agreement's buyer", { header: req(delegated, { signer: session.signer, delegation }), requireDelegation: true, artifacts: [{ ...agreement, parties: [{ role: "buyer", primaryClaim: other.claim }, agreement.parties[1]] }] }, no("peer_delegation_agreement_mismatch")),
  R("request/delegated-agreement-seller-party-mismatch", "delegated request matches the retained Agreement's seller", { header: req(delegated, { signer: session.signer, delegation }), requireDelegation: true, artifacts: [{ ...agreement, parties: [agreement.parties[0], { role: "seller", primaryClaim: other.claim }] }] }, no("peer_delegation_agreement_mismatch")),
  // A direct request is bound to the same host artifacts: another buyer's request for this job and hash is refused.
  R("request/direct-agreement-buyer-party-mismatch", "direct request matches the retained Agreement's parties", { header: req(request), artifacts: [{ ...agreement, parties: [{ role: "buyer", primaryClaim: other.claim }, agreement.parties[1]] }] }, no("peer_agreement_party_mismatch")),
  R("request/direct-agreement-seller-party-mismatch", "direct request matches the retained Agreement's parties", { header: req(request), artifacts: [{ ...agreement, parties: [agreement.parties[0], { role: "seller", primaryClaim: other.claim }] }] }, no("peer_agreement_party_mismatch")),
  R("request/valid-delegated-agreement-parties-reordered", null, { header: req(delegated, { signer: session.signer, delegation }), requireDelegation: true, artifacts: [{ ...agreement, parties: [agreement.parties[1], agreement.parties[0]] }] }, ok),
  // A delegation another wallet signed, carried under a request naming the vector buyer: its signature verifies under that wallet's key.
  R("request/delegated-buyer-mismatch", "delegation scope (buyer)", { header: req(delegated, { signer: session.signer, delegation: del({ ...delegationPayload, buyer: other.claim }, { signer: other.signer }) }), requireDelegation: true }, no("peer_delegation_mismatch")),
  R("request/delegated-agreement-no-deadline", "retained Agreement has a deadline", { header: req(delegated, { signer: session.signer, delegation }), requireDelegation: true, artifacts: [{ ...agreement, terms: {} }] }, no("peer_delegation_deadline")),
  R("request/delegated-delegation-beyond-agreement-deadline", "delegation ends by the Agreement deadline", { header: req(delegated, { signer: session.signer, delegation }), requireDelegation: true, artifacts: [{ ...agreement, terms: { deadline: NOW + HOUR - 1 } }] }, no("peer_delegation_deadline")),
  R("request/delegated-outlives-delegation", "delegated request ends by delegation expiry", { header: req({ ...delegated, expiresAt: NOW + 60_000 }, { signer: session.signer, delegation: del({ ...delegationPayload, expiresAt: NOW + 30_000 }) }), requireDelegation: true }, no("peer_delegation_expired")),
  R("request/cf5-header-duplicate-member", "CF-5 duplicate member", { header: duplicateHeader }, no("wire_json_rejected", "DUPLICATE-MEMBER")),
  R("request/cf5-header-malformed-utf8", "CF-5 UTF-8", { header: malformedHeader.header, server: { listingPin: { ...LISTING_PIN, listingId: malformedHeader.serverListingId } } }, no("wire_json_rejected", "INVALID-UTF8")),
  R("request/cf5-header-invalid-number", "CF-5 number", { header: bigNumberHeader }, no("wire_json_rejected", "NUMBER-OUTSIDE-DACS-MAGNITUDE")),
  R("request/cf5-header-non-nfc", "ASCII Listing ID", { header: nfdHeader.header, server: { listingPin: { ...LISTING_PIN, listingId: nfdHeader.serverListingId } } }, no("peer_envelope_invalid")),
  R("request/cf5-body-duplicate-member", "CF-5 duplicate member", bodyCase(enc(`{"jobId":"${JOB_ID}","jobId":"${JOB_ID}"}`)), no("bad_json", "DUPLICATE-MEMBER")),
  R("request/cf5-body-malformed-utf8", "CF-5 UTF-8", bodyCase(malformedBody), no("bad_json", "INVALID-UTF8")),
  R("request/cf5-body-non-nfc", "CF-5 preserves received string values", bodyCase(enc(`{"jobId":"${JOB_ID}","note":"café"}`)), ok),
  R("request/cf5-body-invalid-number", "CF-5 number", bodyCase(enc(`{"jobId":"${JOB_ID}","amount":9007199254740993}`)), no("bad_json", "NUMBER-OUTSIDE-DACS-MAGNITUDE")),
  // The verifier's own TP-1 binding: an object that only carries the profile is
  // not a binding, and a changed connection invalidates the real one. Each
  // message here is otherwise valid.
  R("request/forged-binding", "SDK binding required", { header: req(request), verifier: { forgedBinding: { profile } } }, no("tp1_binding_required")),
  R("request/local-binding-changed", "verifier's current connection (open)", { header: req(request), verifier: { local: SELLER_CHANGED } }, no("tp1_local_binding_changed")),
  R("request/local-binding-changed-before-check", "verifier's current connection (check)", { header: req(request), checkLocal: SELLER_CHANGED }, no("tp1_local_binding_changed")),
  // checkWireRequest takes only the envelope openWireEnvelope verified, under the same binding.
  R("request/check-unopened-envelope", "check takes only a verified envelope", { header: req(request), checkSubject: "decoded-header" }, no("peer_request_unverified")),
  R("request/check-copied-envelope", "check takes only a verified envelope", { header: req(request), checkSubject: "copy" }, no("peer_request_unverified")),
  R("request/check-other-binding", "check takes only a verified envelope", { header: req(request), checkSubject: "other-binding" }, no("peer_request_unverified")),

  G("delegation/valid", null, { delegation }, ok),
  G("delegation/old-domain", "delegation signature domain", { delegation: del(delegationPayload, { domain: OLD.delegation }) }, no("peer_delegation_signature_invalid")),
  G("delegation/profile-missing", "profile present", { delegation: (() => { const { profile: _x, ...p } = delegationPayload; return del(p); })() }, no("tp1_profile_missing")),
  G("delegation/profile-wrong", "profile equals own binding", { delegation: del({ ...delegationPayload, profile: { ...profile, chainIdentity: otherRecord.chainIdentity } }) }, no("tp1_profile_mismatch")),
  G("delegation/profile-revision-missing", "profile revision present", { delegation: del({ ...delegationPayload, profile: preRevisionProfile }) }, no("tp1_profile_revision_missing")),
  G("delegation/profile-revision-unknown", "profile revision defined", { delegation: del({ ...delegationPayload, profile: revised("tp-1") }) }, no("tp1_profile_revision_unknown")),
  G("delegation/expired", "delegation expiry", { delegation, scope: { time: NOW + HOUR } }, no("peer_delegation_expired")),
  G("delegation/not-yet-valid", "delegation notBefore", { delegation, scope: { time: NOW - 2000 } }, no("peer_delegation_expired")),
  G("delegation/wrong-buyer-scope", "delegation scope (buyer)", { delegation, scope: { buyer: other.claim } }, no("peer_delegation_mismatch")),
  G("delegation/wrong-seller-scope", "delegation scope", { delegation, scope: { seller: other.claim } }, no("peer_delegation_mismatch")),
  G("delegation/wrong-listing-scope", "delegation scope", { delegation, scope: { listingPin: OTHER_PIN } }, no("peer_delegation_mismatch")),
  G("delegation/wrong-job-scope", "delegation scope", { delegation, scope: { jobId: OTHER_JOB_ID } }, no("peer_delegation_mismatch")),
  G("delegation/beyond-deadline", "delegation deadline", { delegation, scope: { deadline: NOW + HOUR - 1 } }, no("peer_delegation_deadline")),
  G("delegation/bad-signature", "delegation signature key", { delegation: del(delegationPayload, { signer: other.signer }) }, no("peer_delegation_signature_invalid")),
  G("delegation/lifetime-over-24h", "delegation lifetime", { delegation: del({ ...delegationPayload, notBefore: NOW, expiresAt: NOW + 24 * HOUR + 1 }) }, no("peer_delegation_invalid")),
  G("delegation/forged-binding", "SDK binding required", { delegation, verifier: { forgedBinding: { profile } } }, no("tp1_binding_required")),
  G("delegation/local-binding-changed", "verifier's current connection (delegation)", { delegation, verifier: { local: SELLER_CHANGED } }, no("tp1_local_binding_changed")),
  // `view`: the replay passes the delegation's payload as a Proxy whose expiresAt answers its own value for
  // the first n reads and `after` from then on, for every n from 0 to 16. Such a caller object
  // has no CF-5 admission authority and is refused before any accessor or Proxy trap.
  G("delegation/payload-changes-between-reads", "CF-5 delegation input", { delegation, view: { of: "delegation.payload", as: "proxy", field: "expiresAt", after: NOW - 500 } }, no("peer_delegation_invalid", "ARTIFACT-NOT-ADMITTED")),

  S("response/valid", null, { request, header: resp(response) }, ok),
  S("response/old-domain", "response signature domain", { request, header: resp(response, { domain: OLD.request }) }, no("peer_signature_invalid")),
  S("response/request-domain", "response signature domain", { request, header: resp(response, { domain: D.request }) }, no("peer_signature_invalid")),
  S("response/profile-missing", "profile present", { request, header: (() => { const { profile: _x, ...p } = response; return resp(p); })() }, no("tp1_profile_missing")),
  S("response/profile-wrong", "profile equals own binding", { request, header: resp({ ...response, profile: { ...profile, chainIdentity: otherRecord.chainIdentity } }) }, no("tp1_profile_mismatch")),
  S("response/profile-revision-missing", "profile revision present", { request, header: resp({ ...response, profile: preRevisionProfile }) }, no("tp1_profile_revision_missing")),
  S("response/profile-revision-unknown", "profile revision defined", { request, header: resp({ ...response, profile: revised("TP-1 ") }) }, no("tp1_profile_revision_unknown")),
  // The request the buyer kept for the purchase names a pre-revision tuple: refused before the answer is opened.
  S("response/kept-request-revision-missing", "retained request shape", { request: { ...request, profile: preRevisionProfile }, header: resp(response) }, no("peer_envelope_invalid")),
  S("response/wrong-status", "response status binding", { request, header: resp(response), status: 201 }, no("peer_response_mismatch")),
  S("response/wrong-body", "response body binding", { request, header: resp(response), body: b64(enc('{"status":"other"}')) }, no("peer_response_mismatch")),
  S("response/other-signer", "response signature key", { request, header: resp(response, { signer: other.signer }) }, no("peer_signature_invalid")),
  S("response/signer-not-seller", "response principal", { request, header: resp({ ...response, seller: other.claim }, { signer: other.signer }) }, no("peer_signer_wrong")),
  // `requireDelegation`: the replay opens the answer with openWireEnvelope and that flag set, as a host calling the
  // exported verifier might, instead of verifyWireResponse (which never sets it). Either way it is refused.
  S("response/delegated-session-signed", "exact response envelope members", { request, header: delegatedResponse }, no("peer_envelope_invalid")),
  S("response/delegated-session-signed-delegation-required", "response never delegated (open)", { request, header: delegatedResponse, requireDelegation: true }, no("peer_envelope_invalid")),
  S("response/identity-mismatch", "response identity binding", { request, header: resp({ ...response, agreementHash: sha256Hex("other-agreement") }) }, no("peer_response_mismatch")),
  S("response/request-hash-mismatch", "response request-hash binding", { request, header: resp({ ...response, requestHash: sha256Hex("other-request") }) }, no("peer_response_mismatch")),
  S("response/expired", "response expiry", { request, header: resp({ ...response, expiresAt: NOW }) }, no("peer_response_mismatch")),
  S("response/lifetime-over-60s", "response lifetime", { request, header: resp({ ...response, expiresAt: NOW + 60_001 }) }, no("peer_response_mismatch")),
  S("response/cf5-duplicate-member", "CF-5 duplicate member", { request, ...responseBodyCase(enc('{"status":"committed","status":"committed"}')) }, no("response_json_rejected", "DUPLICATE-MEMBER")),
  S("response/cf5-malformed-utf8", "CF-5 UTF-8", { request, ...responseBodyCase(malformedResponseBody) }, no("response_json_rejected", "INVALID-UTF8")),
  S("response/cf5-non-nfc", "CF-5 preserves received string values", { request, ...responseBodyCase(enc('{"status":"committed","note":"café"}')) }, ok),
  S("response/cf5-invalid-number", "CF-5 number", { request, ...responseBodyCase(enc('{"status":"committed","amount":9007199254740993}')) }, no("response_json_rejected", "NUMBER-OUTSIDE-DACS-MAGNITUDE")),
  S("response/forged-binding", "SDK binding required", { request, header: resp(response), verifier: { forgedBinding: { profile } } }, no("tp1_binding_required")),
  S("response/local-binding-changed", "verifier's current connection (open)", { request, header: resp(response), verifier: { local: BUYER_CHANGED } }, no("tp1_local_binding_changed")),

  V("discovery/valid", null, { document: disc(discovery) }, ok),
  // A publicEndpoint is an origin: requests go to it followed by the route path, discovery to its /.well-known.
  V("discovery/listing-endpoint-with-path", "endpoint is an origin", { document: disc(discovery), listing: { seller: seller.claim, publicEndpoint: `${PUBLIC_ENDPOINT}/seller/v2`, listingPin: LISTING_PIN } }, no("wire_input_invalid")),
  V("discovery/endpoint-mismatch", "endpoint proof: publicEndpoint byte for byte", { document: disc({ ...discovery, publicEndpoint: `${PUBLIC_ENDPOINT}/` }) }, no("discovery_endpoint_mismatch")),
  V("discovery/signer-not-listing-seller", "endpoint proof: Listing seller", { document: disc({ ...discovery, seller: other.claim }, { signer: other.signer }) }, no("discovery_signer_wrong")),
  V("discovery/bad-signature", "endpoint proof: signature key", { document: disc(discovery, { signer: other.signer }) }, no("discovery_signature_invalid")),
  V("discovery/wrong-domain", "discovery signature domain", { document: disc(discovery, { domain: D.request }) }, no("discovery_signature_invalid")),
  V("discovery/profile-missing", "profile present", { document: disc(discoveryWithoutProfile) }, no("tp1_profile_missing")),
  V("discovery/profile-wrong", "profile equals own binding", { document: disc({ ...discovery, profile: { ...profile, chainIdentity: otherRecord.chainIdentity } }) }, no("tp1_profile_mismatch")),
  V("discovery/profile-revision-missing", "profile revision present", { document: disc({ ...discovery, profile: preRevisionProfile }) }, no("tp1_profile_revision_missing")),
  V("discovery/profile-revision-unknown", "profile revision defined", { document: disc({ ...discovery, profile: revised("TP-2") }) }, no("tp1_profile_revision_unknown")),
  V("discovery/profile-revision-mismatch", "profile revision defined", { document: disc({ ...discovery, profile: revised("TP-1.1") }) }, no("tp1_profile_revision_unknown")),
  V("discovery/listing-not-listed", "Listing pin listed", { document: disc({ ...discovery, listings: [OTHER_PIN] }) }, no("discovery_listing_missing")),
  V("discovery/capabilities-widened", "TP-1 capabilities", { document: disc({ ...discovery, capabilities: { ...wire.TP1_CAPABILITIES, rails: ["pay-dem", "x402"] } }) }, no("discovery_capabilities_unsupported")),
  V("discovery/expired", "discovery validity", { document: disc({ ...discovery, issuedAt: NOW - 6 * 60_000, expiresAt: NOW - 1 }) }, no("discovery_expired")),
  V("discovery/issued-in-future", "discovery issuedAt skew", { document: disc({ ...discovery, issuedAt: NOW + 60_001 }) }, no("discovery_expired")),
  V("discovery/cf5-duplicate-member", "CF-5 duplicate member", { document: discoveryDuplicate }, no("discovery_json_rejected", "DUPLICATE-MEMBER")),
  V("discovery/cf5-malformed-utf8", "CF-5 UTF-8", discoveryMalformed, no("discovery_json_rejected", "INVALID-UTF8")),
  V("discovery/cf5-non-nfc", "ASCII Listing ID", discoveryNonNfc, no("discovery_invalid")),
  // Signed and then edited, so the signature check refuses it too: only the
  // order of checks makes admission the one that names it.
  V("discovery/cf5-invalid-number", "CF-5 number", { document: discoveryBigNumber }, no("discovery_json_rejected", "NUMBER-OUTSIDE-DACS-MAGNITUDE")),
  V("discovery/forged-binding", "SDK binding required", { document: disc(discovery), verifier: { forgedBinding: { profile } } }, no("tp1_binding_required")),
  V("discovery/local-binding-changed", "verifier's current connection (discovery)", { document: disc(discovery), verifier: { local: BUYER_CHANGED } }, no("tp1_local_binding_changed")),

  // A producer applies its peer's admission profile before it signs (D7): the
  // buyer's signWireRequest and the seller's signWireResponse refuse these
  // invalid bodies with zero signatures; decomposed string values are accepted. Malformed UTF-8 has no case here: both take
  // the body as a string.
  P("signing/request-valid", null, { producer: "request", body: b64(enc(BODY)) }, ok),
  P("signing/request-listing-x402", "authenticated Listing eligibility", { producer: "request-eligibility", body: b64(enc(BODY)), eligibility: { rail: "pay-x402" } }, no("listing_unsupported")),
  P("signing/request-listing-metered", "authenticated Listing eligibility", { producer: "request-eligibility", body: b64(enc(BODY)), eligibility: { pricingKind: "metered" } }, no("listing_unsupported")),
  P("signing/request-listing-input", "authenticated Listing eligibility", { producer: "request-eligibility", body: b64(enc(BODY)), eligibility: { buyerRequestInput: true } }, no("listing_unsupported")),
  P("signing/request-cf5-duplicate-member", "outgoing request body admission", { producer: "request", body: b64(enc(`{"jobId":"${JOB_ID}","jobId":"${JOB_ID}"}`)) }, no("outgoing_body_rejected", "DUPLICATE-MEMBER")),
  P("signing/request-cf5-non-nfc", "CF-5 preserves outgoing body values", { producer: "request", body: b64(enc(`{"jobId":"${JOB_ID}","note":"cafe\u0301"}`)) }, ok),
  P("signing/request-cf5-invalid-number", "outgoing request body admission", { producer: "request", body: b64(enc(`{"jobId":"${JOB_ID}","amount":9007199254740993}`)) }, no("outgoing_body_rejected", "NUMBER-OUTSIDE-DACS-MAGNITUDE")),
  P("signing/response-valid", null, { producer: "response", request, body: b64(enc(RESPONSE_TEXT)) }, ok),
  P("signing/response-cf5-duplicate-member", "outgoing response body admission", { producer: "response", request, body: b64(enc('{"status":"committed","status":"committed"}')) }, no("outgoing_body_rejected", "DUPLICATE-MEMBER")),
  P("signing/response-cf5-non-nfc", "CF-5 preserves outgoing body values", { producer: "response", request, body: b64(enc('{"status":"committed","note":"cafe\u0301"}')) }, ok),
  P("signing/response-cf5-invalid-number", "outgoing response body admission", { producer: "response", request, body: b64(enc('{"status":"committed","amount":9007199254740993}')) }, no("outgoing_body_rejected", "NUMBER-OUTSIDE-DACS-MAGNITUDE")),
  // The other signers that take a caller-built payload, signing plain data once (the replay sets the signer's own claim).
  P("signing/envelope-valid", null, { producer: "envelope", payload: request }, ok),
  P("signing/delegation-valid", null, { producer: "delegation", payload: delegationPayload }, ok),
  P("signing/discovery-valid", null, { producer: "discovery", payload: discovery }, ok),
  // Each refuses a payload whose format discriminators are not exactly the wire's, before its signer is called.
  // test/wire/admission.test.ts signs the same cases correctly and requires each receiver to refuse them.
  P("signing/delegation-version-unknown", "delegation version", { producer: "delegation", payload: { ...delegationPayload, version: "2" } }, no("peer_delegation_invalid")),
  P("signing/delegation-version-number", "delegation version", { producer: "delegation", payload: { ...delegationPayload, version: 1 } }, no("peer_delegation_invalid")),
  P("signing/delegation-kind-unknown", "delegation kind", { producer: "delegation", payload: { ...delegationPayload, kind: "seller-session-delegation/v2" } }, no("peer_delegation_invalid")),
  P("signing/discovery-format-unknown", "discovery format", { producer: "discovery", payload: { ...discovery, format: "dacs-seller-discovery/v2" } }, no("discovery_invalid")),
  P("signing/discovery-transport-unknown", "discovery transport", { producer: "discovery", payload: { ...discovery, transport: ["dacs-seller-http/v2"] } }, no("discovery_invalid")),
  P("signing/discovery-transport-extra", "discovery transport", { producer: "discovery", payload: { ...discovery, transport: ["dacs-seller-http/v1", "dacs-seller-http/v2"] } }, no("discovery_invalid")),
  P("signing/discovery-transport-array-like", "discovery transport", { producer: "discovery", payload: { ...discovery, transport: { 0: "dacs-seller-http/v1", length: 1 } } }, no("discovery_invalid")),
  // Signers sign only their own exact tuple, and the buyer only under the tuple kept for the job (`jobProfile`;
  // by default the exact tuple): each refuses before its signer is called.
  P("signing/request-purchase-profile-missing", "purchase tuple kept (signer)", { producer: "request", body: b64(enc(BODY)), jobProfile: "omitted" }, no("tp1_purchase_profile_mismatch")),
  P("signing/request-purchase-profile-revision-missing", "purchase tuple kept (signer)", { producer: "request", body: b64(enc(BODY)), jobProfile: preRevisionProfile }, no("tp1_purchase_profile_mismatch")),
  P("signing/request-purchase-profile-other-revision", "purchase tuple kept (signer)", { producer: "request", body: b64(enc(BODY)), jobProfile: revised("TP-1.1") }, no("tp1_purchase_profile_mismatch")),
  P("signing/envelope-profile-revision-missing", "profile revision present (signer)", { producer: "envelope", payload: { ...request, profile: preRevisionProfile } }, no("tp1_profile_revision_missing")),
  P("signing/response-request-revision-unknown", "profile revision defined (signer)", { producer: "response", request: { ...request, profile: revised("TP-1.1") }, body: b64(enc(RESPONSE_TEXT)) }, no("tp1_profile_revision_unknown")),
  P("signing/delegation-profile-revision-unknown", "profile revision defined (signer)", { producer: "delegation", payload: { ...delegationPayload, profile: revised("TP-2") } }, no("tp1_profile_revision_unknown")),
  P("signing/discovery-profile-revision-missing", "profile revision present (signer)", { producer: "discovery", payload: { ...discovery, profile: preRevisionProfile } }, no("tp1_profile_revision_missing")),
  // The seller's signWireResponse and the generic signWireEnvelope also take the tuple kept for the purchase
  // (`purchaseProfile`; by default the exact tuple) and refuse before their signer is called. `null` (none kept yet)
  // is a seller's new purchase: it signs an answer, never a request.
  P("signing/response-purchase-profile-missing", "purchase tuple kept (response signer)", { producer: "response", request, body: b64(enc(RESPONSE_TEXT)), purchaseProfile: "omitted" }, no("tp1_purchase_profile_mismatch")),
  P("signing/response-purchase-profile-other-revision", "purchase tuple kept (response signer)", { producer: "response", request, body: b64(enc(RESPONSE_TEXT)), purchaseProfile: revised("TP-1.1") }, no("tp1_purchase_profile_mismatch")),
  P("signing/response-new-purchase", null, { producer: "response", request, body: b64(enc(RESPONSE_TEXT)), purchaseProfile: null }, ok),
  P("signing/envelope-purchase-profile-missing", "purchase tuple kept (envelope signer)", { producer: "envelope", payload: request, purchaseProfile: "omitted" }, no("tp1_purchase_profile_mismatch")),
  P("signing/envelope-purchase-profile-other-revision", "purchase tuple kept (envelope signer)", { producer: "envelope", payload: request, purchaseProfile: revised("TP-1.1") }, no("tp1_purchase_profile_mismatch")),
  P("signing/envelope-request-purchase-profile-none", "purchase tuple kept (envelope signer)", { producer: "envelope", payload: request, purchaseProfile: null }, no("tp1_purchase_profile_mismatch")),
  // Only a request carries a delegation: the generic signer refuses an answer with one before its signer is called.
  P("signing/envelope-response-delegation", "response carries no delegation (signer)", { producer: "envelope", payload: response, delegation }, no("peer_envelope_invalid")),
  // `view`: the signer's payload, or signWireResponse's request, passed as a Proxy whose `profile` answers
  // the bound profile for the first n reads and the mocked mainnet profile from then on, for every n from 0 to 16.
  // Each signer copies its input once and refuses a Proxy outright, so the expectation holds for every n, with zero
  // signatures. Without the copy, some n signs bytes, or a header, naming the mocked mainnet identity.
  P("signing/envelope-payload-changes-between-reads", "envelope payload owned copy", { producer: "envelope", payload: request, view: { of: "payload", as: "proxy", field: "profile", after: mainnetProfile } }, no("peer_envelope_invalid")),
  P("signing/delegation-payload-changes-between-reads", "delegation payload owned copy", { producer: "delegation", payload: delegationPayload, view: { of: "payload", as: "proxy", field: "profile", after: mainnetProfile } }, no("peer_delegation_invalid")),
  P("signing/discovery-payload-changes-between-reads", "discovery payload owned copy", { producer: "discovery", payload: discovery, view: { of: "payload", as: "proxy", field: "profile", after: mainnetProfile } }, no("discovery_invalid")),
  P("signing/response-request-changes-between-reads", "response request owned copy", { producer: "response", request, body: b64(enc(RESPONSE_TEXT)), view: { of: "request", as: "proxy", field: "profile", after: mainnetProfile } }, no("peer_envelope_invalid")),
  // A session signer that edits the caller's delegation while it signs: the header embeds the delegation that was
  // verified, unedited, and the seller opens it. The replay makes the wallet, session key and delegation at run time.
  P("signing/request-delegation-edited-while-signing", "request delegation owned copy", { producer: "request-delegated", body: b64(enc(BODY)) }, ok),

  // gate "public": bindTp1Profile, which approves only by the SDK's own list and ignores any
  // approvedRecordDigests a caller passes. gate "test-approval": the vector's own list stands in for the SDK's.
  B("binding/valid-synthetic-test-approval", null, { gate: "test-approval", record, approvedRecordDigests: approved }, ok),
  B("binding/record-missing", "identity record present", { gate: "public", record: null }, no("tp1_identity_record_missing")),
  B("binding/pin-missing", "identity pins present", { gate: "public", record: { ...record, chainIdentity: null } }, no("tp1_identity_pin_missing")),
  B("binding/fixture-identity", "fixture identity refused", { gate: "test-approval", record: { ...record, chainIdentity: wire.TP1_REFUSED_FIXTURE_CHAIN_IDENTITIES[0] }, approvedRecordDigests: [digest({ ...record, chainIdentity: wire.TP1_REFUSED_FIXTURE_CHAIN_IDENTITIES[0] })] }, no("tp1_identity_fixture")),
  B("binding/mainnet-labelled-testnet-refused", "refused identity", { gate: "test-approval", record: mainnetLabelledTestnet, approvedRecordDigests: [digest(mainnetLabelledTestnet)], refusedChainIdentities: [mainnetLabelledTestnet.chainIdentity] }, no("tp1_identity_refused")),
  B("binding/mainnet-labelled-testnet-unapproved", "identity approval", { gate: "public", record: mainnetLabelledTestnet }, no("tp1_identity_unapproved")),
  B("binding/mainnet-labelled-testnet-caller-approved", "public gate approves only by the SDK's list", { gate: "public", record: mainnetLabelledTestnet, approvedRecordDigests: [digest(mainnetLabelledTestnet)] }, no("tp1_identity_unapproved")),
  B("binding/caller-list-cannot-approve", "public gate approves only by the SDK's list", { gate: "public", record, approvedRecordDigests: approved }, no("tp1_identity_unapproved")),
  B("binding/no-approved-records", "identity approval", { gate: "public", record }, no("tp1_identity_unapproved")),
  // `view`: the approved record, or the actor's connection, passed as a Proxy or with an accessor whose
  // `field` answers its own value for the first n reads and `after` from then on, for every n from 0 to 16.
  // bindTp1Profile checks, digests and binds one owned data-only copy and refuses both forms outright, so the
  // expectation holds for every n. Without the copy, some n binds the mocked mainnet identity under the approved
  // record's digest, or an endpoint that was never checked.
  B("binding/record-proxy-changes-between-reads", "identity record owned copy", { gate: "test-approval", record, approvedRecordDigests: approved, view: { of: "record", as: "proxy", field: "chainIdentity", after: mainnetLabelledTestnet.chainIdentity } }, no("tp1_identity_record_invalid")),
  B("binding/record-accessor-changes-between-reads", "identity record owned copy", { gate: "test-approval", record, approvedRecordDigests: approved, view: { of: "record", as: "accessor", field: "chainIdentity", after: mainnetLabelledTestnet.chainIdentity } }, no("tp1_identity_record_invalid")),
  B("binding/local-proxy-changes-between-reads", "local connection owned copy", { gate: "test-approval", record, approvedRecordDigests: approved, local: LOCAL_A, view: { of: "local", as: "proxy", field: "endpoint", after: "http://rpc-changed.wire-fixture.invalid/" } }, no("tp1_local_binding_invalid")),
];

writeJson(resolve(args.out), {
  format: "dacs-seller-http-v1-vectors/1",
  status: "SDK wire definitions ready for review; composition qualification pending",
  generator: "scripts/wire/generate-wire-vectors.mjs",
  keys: "Ed25519 keys were generated at run time and discarded; this file holds public keys and signatures only.",
  synthetic: "Every identity record here is SYNTHETIC and test-only. None is the approved record or a Demos chain identity; MOCKED-MAINNET is a random value labelled as a mainnet identity for refusal tests. testApprovedRecordDigests approve only through the tests' own replacement of the SDK's approval list; the shipped bindTp1Profile refuses every record here.",
  now: NOW,
  parties: { buyer: buyer.claim, seller: seller.claim, session: session.claim, other: other.claim },
  identity: { record, profile, testApprovedRecordDigests: approved, otherChainRecord: otherRecord, mockedMainnetLabelledTestnet: mainnetLabelledTestnet },
  localBindings: { buyer: LOCAL_A, seller: LOCAL_B },
  job: { jobId: JOB_ID, listingPin: LISTING_PIN, agreementHash: AGREEMENT_HASH, publicEndpoint: PUBLIC_ENDPOINT },
  vectors,
});
console.log(`wrote ${vectors.length} vectors`);

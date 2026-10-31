#!/usr/bin/env node
// Capture the plugin's seller-wire behaviour from the UNMODIFIED original module
// at frontend 82bf8c4 and, in the same run, its TP-1 adaptation.
//
// Frontend 82bf8c4 has no static wire fixture: its wire tests generate
// ephemeral wallets each run. This script therefore captures one, by running
// the original seller-transport-auth.mjs (verified here by git blob id) with
// the vendored SDK build it ships (verified by SHA-256), and writes:
//   <out>/plugin-wire-82bf8c4.original.json     the capture; never rewritten
//   <out>/plugin-wire-82bf8c4.tp1-adapted.json  the D6 adaptation; NOT verbatim
// Both files are written exclusively: an existing file is never overwritten.
// Keys are generated at run time and discarded; the files hold public keys
// and signatures only. The TP-1 identity record is SYNTHETIC (not an approved identity).
//
// Usage: node scripts/wire/capture-plugin-wire-fixture.mjs \
//   --http-mcp <dir> --vendored-tgz <file> --sdk-dist <dacs-sdk/dist> --out-dir <dir>
// <dir> holds `git show 82bf8c4:http-mcp/<path>` of the three source files
// below and node_modules/@kynesyslabs/dacs extracted from the vendored tarball.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  AGREEMENT_HASH, HOUR, JOB_ID, LISTING_PIN, LOCAL_A, LOCAL_B, NONCE, NOW, OTHER_JOB_ID, party, sha256Hex,
  syntheticIdentityRecord, writeJson,
} from "./fixture-helpers.mjs";

const FRONTEND_COMMIT = "82bf8c4dabb2332a72f618f6cc29950e48d6feb6";
const SOURCES = [
  { path: "http-mcp/src/dacs/seller-transport-auth.mjs", gitBlob: "eec0a312ab91f18ed064f14d3393a716600927d1" },
  { path: "http-mcp/src/wallet/demos-signature.mjs", gitBlob: "3e6686910d5be32ddea53e11dbffab1e2e03391f" },
  { path: "http-mcp/public/portal/seller-session-limits.mjs", gitBlob: "6ca54be7de1d2eeb0fa4a16c2a3a48be0cda2a99" },
];
const VENDORED = { path: "http-mcp/vendor/kynesyslabs-dacs-0.1.0-alpha.0.tgz", gitBlob: "40ecc3efdecbe0b427a033773a1825a8a9c11752", sha256: "79934553cf3f952de4a442c8db306b68a2d5cd5947b3f1258ac9ac2caa5a69a3" };
const OLD_REQUEST_DOMAIN = "dacs-chatgpt-plugin:loopback-seller-peer:v1:";
const OLD_DELEGATION_DOMAIN = "dacs-chatgpt-plugin:seller-session-delegation:v1:";

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, i, all) => (i % 2 === 0 ? [...pairs, [value.replace(/^--/, ""), all[i + 1]]] : pairs), []));
for (const key of ["http-mcp", "vendored-tgz", "sdk-dist", "out-dir"]) if (!args[key]) throw new Error(`--${key} is required`);
const gitBlob = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const files = SOURCES.map(({ path, gitBlob: expected }) => {
  const bytes = readFileSync(join(args["http-mcp"], path.slice("http-mcp/".length)));
  if (gitBlob(bytes) !== expected) throw new Error(`${path} is not the ${FRONTEND_COMMIT} blob ${expected}`);
  return { path, gitBlob: expected, sha256: sha256Hex(bytes) };
});
const tgz = readFileSync(args["vendored-tgz"]);
if (sha256Hex(tgz) !== VENDORED.sha256 || gitBlob(tgz) !== VENDORED.gitBlob) throw new Error("vendored SDK tarball differs from 82bf8c4");
const self = fileURLToPath(import.meta.url);

const orig = await import(pathToFileURL(join(args["http-mcp"], "src/dacs/seller-transport-auth.mjs")).href);
const vendored = await import(pathToFileURL(join(args["http-mcp"], "node_modules/@kynesyslabs/dacs/dist/index.js")).href);
const wire = await import(pathToFileURL(join(resolve(args["sdk-dist"]), "wire/index.js")).href);
const sdk = await import(pathToFileURL(join(resolve(args["sdk-dist"]), "canonical/index.js")).href);

const buyer = party(), seller = party(), session = party(), other = party();
const PATH = "/dacs/v1/commitments";
const BODY = `{"jobId":"${JOB_ID}"}`;
const RESPONSE_TEXT = '{"status":"committed"}';
const OTHER_PIN = { ...LISTING_PIN, version: 2 };
const b64 = (text) => Buffer.from(text, "utf8").toString("base64url");
const header = (envelope) => b64(vendored.canonicalize(envelope));
const sig = (signer, bytes) => Buffer.from(signer.sign(bytes)).toString("base64url");
const verdict = async (fn) => {
  try { await fn(); return { ok: true }; } catch (error) { return { ok: false, code: error.code ?? String(error.message) }; }
};
const noStore = { bind() {}, reserve() { throw new Error("not used"); }, finish() { throw new Error("not used"); }, journaledOnlyReserve: true };
const serverAuth = (who, pin, requireDelegation = false) =>
  orig.createSellerTransportServerAuth({ sellerSigner: who.signer, listingPin: pin, store: noStore, now: () => NOW, requireDelegation });

// The two flavours share every case builder: only the domain and the profile member differ (D6).
const record = syntheticIdentityRecord("wire-fixture");
const approved = [sdk.sha256Hex(sdk.canonicalize(record))];
const buyerBinding = wire.bindTp1Profile({ record, approvedRecordDigests: approved, local: LOCAL_A });
const flavours = {
  original: { addProfile: (p) => p, requestBytes: (p) => orig.sellerTransportSigningBytes(p), delegationBytes: (p) => orig.sellerSessionDelegationSigningBytes(p) },
  tp1: {
    addProfile: (p) => ({ ...p, profile: buyerBinding.profile }),
    requestBytes: (p) => wire.wireEnvelopeSigningBytes(p),
    delegationBytes: (p) => Buffer.from(`${wire.DACS_SELLER_HTTP_DOMAINS.delegation}${sdk.canonicalize(p)}`, "utf8"),
  },
};

function buildCases(flavour) {
  const f = flavours[flavour];
  const request = f.addProfile({ version: "1", kind: "request", method: "POST", path: PATH, bodyHash: sha256Hex(BODY), jobId: JOB_ID, buyer: buyer.claim, seller: seller.claim, listingPin: LISTING_PIN, agreementHash: AGREEMENT_HASH, nonce: NONCE, expiresAt: NOW + 30_000 });
  const signedRequest = (p, signer = buyer.signer, extra = {}) => ({ payload: p, header: header({ payload: p, signature: sig(signer, f.requestBytes(p)), ...extra }) });
  const delegationPayload = f.addProfile({ version: "1", kind: "seller-session-delegation", buyer: buyer.claim, sessionPublicKey: session.raw, seller: seller.claim, listingPin: LISTING_PIN, jobId: JOB_ID, notBefore: NOW - 1000, expiresAt: NOW + HOUR });
  const delegate = (p, signer = buyer.signer) => ({ payload: p, signature: `0x${Buffer.from(signer.sign(f.delegationBytes(p))).toString("hex")}` });
  const delegation = delegate(delegationPayload);
  const delegated = { ...request, nonce: Buffer.from(NONCE, "base64url").reverse().toString("base64url") };
  const response = { ...request, kind: "response", bodyHash: sha256Hex(RESPONSE_TEXT), expiresAt: NOW + 60_000, requestHash: sha256Hex(vendored.canonicalize(request)), status: 200 };
  const responseHeader = (p, signer = seller.signer) => header({ payload: p, signature: sig(signer, f.requestBytes(p)) });
  const longDelegation = { ...delegationPayload, notBefore: NOW, expiresAt: NOW + 24 * HOUR + 1 };
  return {
    valid: {
      request: { ...signedRequest(request), signingBytes: f.requestBytes(request).toString("utf8"), bodyText: BODY },
      response: { request, payload: response, header: responseHeader(response), signingBytes: f.requestBytes(response).toString("utf8"), status: 200, text: RESPONSE_TEXT },
      delegation: { ...delegation, signingBytes: f.delegationBytes(delegationPayload).toString("utf8") },
      delegatedRequest: { ...signedRequest(delegated, session.signer, { delegation }), bodyText: BODY },
    },
    requestNegatives: [
      { id: "request/wrong-signer", ...signedRequest(request, other.signer) },
      { id: "request/extra-field", payload: null, header: header({ payload: { ...request, extra: "x" }, signature: sig(buyer.signer, Buffer.from("x")) }) },
      { id: "request/bad-nonce", payload: null, header: header({ payload: { ...request, nonce: "short" }, signature: sig(buyer.signer, Buffer.from("x")) }) },
      { id: "request/expired", ...signedRequest({ ...request, expiresAt: NOW - 1 }) },
      { id: "request/lifetime-over-60s", ...signedRequest({ ...request, expiresAt: NOW + 60_001 }) },
      { id: "request/wrong-listing", ...signedRequest(request), server: { listingPin: OTHER_PIN } },
      { id: "request/wrong-audience", ...signedRequest(request), server: { seller: "other" } },
      { id: "request/body-mismatch", ...signedRequest(request), bodyText: `{"jobId":"${OTHER_JOB_ID}"}` },
      { id: "request/delegation-required", ...signedRequest(request), requireDelegation: true },
      { id: "request/delegated-outlives-delegation", ...signedRequest({ ...delegated, expiresAt: NOW + 60_000 }, session.signer, { delegation: delegate({ ...delegationPayload, expiresAt: NOW + 30_000 }) }), requireDelegation: true },
    ],
    delegationNegatives: [
      { id: "delegation/expired", delegation, scope: { time: NOW + HOUR } },
      { id: "delegation/not-yet-valid", delegation, scope: { time: NOW - 2000 } },
      { id: "delegation/wrong-seller-scope", delegation, scope: { seller: "other" } },
      { id: "delegation/wrong-listing-scope", delegation, scope: { listingPin: OTHER_PIN } },
      { id: "delegation/wrong-job-scope", delegation, scope: { jobId: OTHER_JOB_ID } },
      { id: "delegation/beyond-deadline", delegation, scope: { deadline: NOW + HOUR - 1 } },
      { id: "delegation/bad-signature", delegation: delegate(delegationPayload, other.signer), scope: {} },
      { id: "delegation/lifetime-over-24h", delegation: { payload: longDelegation, signature: delegation.signature }, scope: {} },
    ],
    responseNegatives: [
      { id: "response/wrong-status", header: responseHeader(response), status: 201, text: RESPONSE_TEXT },
      { id: "response/wrong-body", header: responseHeader(response), status: 200, text: '{"status":"other"}' },
      { id: "response/other-signer", header: responseHeader(response, other.signer), status: 200, text: RESPONSE_TEXT },
    ],
  };
}

// Original verdicts, computed by the original module.
const scopeOf = (scope) => ({ ...scope, ...(scope.seller === "other" ? { seller: other.claim } : {}) });
async function originalRequestVerdict(c) {
  return verdict(() => {
    const auth = serverAuth(c.server?.seller === "other" ? other : seller, c.server?.listingPin ?? LISTING_PIN, c.requireDelegation ?? false);
    const text = c.bodyText ?? BODY;
    const request = auth.readRequest(c.header);
    auth.validate(request, { method: "POST", path: PATH, rawBody: Buffer.from(text), body: JSON.parse(text), agreement: undefined });
  });
}
const originalDelegationVerdict = (c) => verdict(() => orig.verifySellerSessionDelegation(c.delegation, { buyer: buyer.claim, seller: seller.claim, listingPin: LISTING_PIN, jobId: JOB_ID, time: NOW, ...scopeOf(c.scope) }));
const originalResponseVerdict = (request, c) => verdict(() => {
  const client = orig.createSellerTransportClientAuth({ buyerSigner: buyer.signer, seller: seller.claim, resolveJob: async () => ({}), now: () => NOW });
  client.verifyResponse(request, { header: c.header, status: c.status, text: c.text });
});

async function withVerdicts(cases, judge) {
  const out = structuredClone(cases);
  const response = out.valid.response;
  for (const [name, c] of Object.entries(out.valid)) {
    if (name === "response") c.originalVerdict = await originalResponseVerdict(response.request, c);
    else if (name === "delegation") c.originalVerdict = await originalDelegationVerdict({ delegation: { payload: c.payload, signature: c.signature }, scope: {} });
    else c.originalVerdict = await originalRequestVerdict({ ...c, requireDelegation: name === "delegatedRequest" });
  }
  for (const c of out.requestNegatives) c[judge] = await originalRequestVerdict(c);
  for (const c of out.delegationNegatives) c[judge] = await originalDelegationVerdict(c);
  for (const c of out.responseNegatives) c[judge] = await originalResponseVerdict(response.request, c);
  return out;
}

// Raw-input behaviour of the original header reader: the baseline D7 changes.
function rawInputCases() {
  const base = { version: "1", kind: "request", method: "POST", path: PATH, bodyHash: sha256Hex(BODY), jobId: JOB_ID, buyer: buyer.claim, seller: seller.claim, listingPin: LISTING_PIN, agreementHash: AGREEMENT_HASH, nonce: NONCE, expiresAt: NOW + 30_000 };
  const signed = (p) => sig(buyer.signer, orig.sellerTransportSigningBytes(p));
  const duplicateText = JSON.stringify({ payload: base, signature: signed(base) }).replace(`"nonce":"${NONCE}"`, `"nonce":"${NONCE}","nonce":"${NONCE}"`);
  const replacement = { ...base, listingPin: { ...LISTING_PIN, listingId: "wire-fixture-�" } };
  const malformed = Buffer.from(JSON.stringify({ payload: replacement, signature: signed(replacement) }), "utf8");
  const at = malformed.indexOf(Buffer.from("�", "utf8"));
  const malformedBytes = Buffer.concat([malformed.subarray(0, at), Buffer.from([0xff]), malformed.subarray(at + 3)]);
  const nfd = { ...base, listingPin: { ...LISTING_PIN, listingId: "wire-fixture-café" } };
  const nfdText = JSON.stringify({ payload: nfd, signature: signed(nfd) });
  return [
    { id: "raw/duplicate-member", header: Buffer.from(duplicateText, "utf8").toString("base64url") },
    { id: "raw/malformed-utf8", header: malformedBytes.toString("base64url") },
    { id: "raw/non-nfc-value", header: Buffer.from(nfdText, "utf8").toString("base64url") },
  ];
}

const original = await withVerdicts(buildCases("original"), "originalVerdict");
const rawInput = rawInputCases();
for (const c of rawInput) c.originalVerdict = await verdict(() => serverAuth(seller, LISTING_PIN).readRequest(c.header));
const originalDoc = {
  fixture: "plugin-wire-82bf8c4.original",
  nature: "Capture of the unmodified original module's behaviour at frontend 82bf8c4. Frontend 82bf8c4 has no static wire fixture of its own (its wire tests use ephemeral wallets per run); this file is not a pre-existing plugin artifact.",
  immutable: "Captured messages are immutable. Publication metadata is re-pinned; the test suite pins the file's SHA-256.",
  provenance: {
    repo: "DACS-Agent-commerce/frontend",
    commit: FRONTEND_COMMIT,
    sources: files,
    vendoredSdk: { ...VENDORED, note: "the @kynesyslabs/dacs build the original module imports" },
    generator: { path: "scripts/wire/capture-plugin-wire-fixture.mjs", sha256: sha256Hex(readFileSync(self)) },
    node: process.version,
    clock: new Date(NOW).toISOString(),
  },
  keys: "Ed25519 keys were generated at run time and discarded; this file holds public keys and signatures only.",
  domains: { request: OLD_REQUEST_DOMAIN, response: OLD_REQUEST_DOMAIN, delegation: OLD_DELEGATION_DOMAIN },
  now: NOW,
  parties: { buyer: buyer.claim, seller: seller.claim, session: session.claim, other: other.claim },
  job: { jobId: JOB_ID, otherJobId: OTHER_JOB_ID, listingPin: LISTING_PIN, otherListingPin: OTHER_PIN, agreementHash: AGREEMENT_HASH, path: PATH },
  ...original,
  rawInput,
};

const adapted = await withVerdicts(buildCases("tp1"), "originalVerdict");
const outDir = resolve(args["out-dir"]);
const originalPath = join(outDir, "plugin-wire-82bf8c4.original.json");
writeJson(originalPath, originalDoc, { exclusive: true });
const adaptedDoc = {
  fixture: "plugin-wire-82bf8c4.tp1-adapted",
  nature: "Adaptation of plugin-wire-82bf8c4.original for testnet profile TP-1. NOT verbatim: every message differs from the original by exactly the changes listed, and was re-signed in the same run with the same run-time keys.",
  derivedFrom: { fixture: "plugin-wire-82bf8c4.original", sha256: sha256Hex(readFileSync(originalPath)) },
  changes: [
    { id: "D6-1", what: "request signing domain", from: OLD_REQUEST_DOMAIN, to: wire.DACS_SELLER_HTTP_DOMAINS.request },
    { id: "D6-2", what: "response signing domain (the original signs responses under the request domain)", from: OLD_REQUEST_DOMAIN, to: wire.DACS_SELLER_HTTP_DOMAINS.response },
    { id: "D6-3", what: "delegation signing domain", from: OLD_DELEGATION_DOMAIN, to: wire.DACS_SELLER_HTTP_DOMAINS.delegation },
    { id: "D6-4", what: "new exact member `profile` {id, base, chainIdentity, pinVersion} in request, response and delegation payloads", from: null, to: "profile" },
  ],
  syntheticIdentityRecord: { label: "SYNTHETIC test-only record; not the approved record; not a Demos chain identity", record, digest: approved[0] },
  keys: "Ed25519 keys were generated at run time and discarded; this file holds public keys and signatures only.",
  now: NOW,
  parties: originalDoc.parties,
  job: originalDoc.job,
  localBindings: { buyer: LOCAL_A, seller: LOCAL_B },
  note: "originalVerdict here is the ORIGINAL module's verdict on the adapted message: it refuses every profile-bearing message.",
  ...adapted,
};
writeJson(join(outDir, "plugin-wire-82bf8c4.tp1-adapted.json"), adaptedDoc, { exclusive: true });
console.log(`wrote ${originalPath} and its TP-1 adaptation`);

// The built package as a consumer installs it. src/ is compiled with
// tsconfig.build.json into a scratch node_modules/@kynesyslabs/dacs, and a
// consumer script runs against it in its own Node process. The consumer
// reaches every compiled wire module by its resolved file path, not only
// through the exports map, and must find no way to approve an identity record,
// to sign without the shipped approval, or to pass any verification entry point
// with an object that only looks like a binding, and the seller entry points
// open and sign nothing under the shipped approval unless the tuple kept for the
// purchase is given and exactly the binding's. A second copy of the same
// build, whose approval.js alone is replaced by the SYNTHETIC vector record's
// digest, shows the compiled verifiers also refuse a changed connection and an
// envelope that openWireEnvelope did not verify. Nothing here reaches a
// network: endpoints are under .invalid and the wire does no I/O.
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const VECTORS = join(root, "vectors/dacs-seller-http-v1.json");

const CONSUMER = String.raw`
import { readdirSync, readFileSync } from "node:fs";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const wire = await import("@kynesyslabs/dacs/wire");
const { canonicalize } = await import("@kynesyslabs/dacs/canonical");
// Independent test authority for the compiled consumer, with no production mocks.
const bindTp1Fixture = (options) => wire.bindTp1Profile({ ...options, readAuthority: (scope) => ({
  local: { ...scope.local }, chainIdentity: options.record.chainIdentity, provenance: "compiled-test-authority/v1",
  sessionId: scope.sessionId, participants: scope.participants.map((claim) => ({ claim,
    profile: { id: wire.TP1_PROFILE_ID, revision: wire.TP1_PROFILE_REVISION, base: wire.TP1_BASE_REVISION, chainIdentity: options.record.chainIdentity, pinVersion: options.record.pinVersion },
    modules: { CORE: "0.3", "DACS-1": "0.7", "DACS-2": "0.6", "DACS-3": "0.5", "DACS-4": "0.8", "DACS-5": "0.5" },
  })),
}) });

const file = JSON.parse(readFileSync(process.argv[2], "utf8"));
const vector = Object.fromEntries(file.vectors.map((v) => [v.id, v.input]));
const b = (text) => Buffer.from(text, "base64url");
const out = { deepImports: {} };
for (const spec of ["@kynesyslabs/dacs/wire/profile", "@kynesyslabs/dacs/wire/approval", "@kynesyslabs/dacs/dist/wire/profile.js", "@kynesyslabs/dacs/dist/wire/approval.js"]) {
  try { await import(spec); out.deepImports[spec] = "imported"; } catch (error) { out.deepImports[spec] = error.code ?? String(error); }
}

// Every compiled wire module and declaration, by resolved file path.
const dir = dirname(fileURLToPath(import.meta.resolve("@kynesyslabs/dacs/wire")));
const files = readdirSync(dir).filter((f) => f.endsWith(".js") || f.endsWith(".d.ts"));
out.files = files.filter((f) => f.endsWith(".js")).sort();
out.filesNamingTestApproval = files.filter((f) => /UnderTestApproval|withTestApproval|approvedRecordDigests/.test(readFileSync(join(dir, f), "utf8")));
out.functionsBeyondWire = [];
const beyond = [];
for (const f of out.files) {
  const mod = await import(pathToFileURL(join(dir, f)).href);
  for (const [name, value] of Object.entries(mod)) if (typeof value === "function" && wire[name] !== value) { out.functionsBeyondWire.push(f + ":" + name); beyond.push(value); }
  if (f === "approval.js") {
    const list = mod.TP1_APPROVED_IDENTITY_RECORD_DIGESTS;
    out.approvalModule = { names: Object.keys(mod), list: [...list], frozen: Object.isFrozen(list), sameAsWire: list === wire.TP1_APPROVED_IDENTITY_RECORD_DIGESTS };
  }
}
out.functionsBeyondWire.sort();

const sha = (v) => createHash("sha256").update(v).digest("hex");
const code = async (fn) => { try { await fn(); return "ok"; } catch (error) { return error instanceof wire.WireError ? error.code : error.name; } };
const record = file.identity.record;
const profile = { id: wire.TP1_PROFILE_ID, revision: wire.TP1_PROFILE_REVISION, base: wire.TP1_BASE_REVISION, chainIdentity: record.chainIdentity, pinVersion: record.pinVersion };
const sellerLocal = file.localBindings.seller, buyerLocal = file.localBindings.buyer;
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const signer = { claim: "did:demos:agent:" + publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex"), calls: 0,
  sign(bytes) { signer.calls += 1; return new Uint8Array(sign(null, Buffer.from(bytes), privateKey)); } };
const readListingEligibility = (scope) => ({ seller: scope.seller, publicEndpoint: scope.publicEndpoint, listingPin: scope.listingPin, pricingKind: "fixed", negotiation: "negotiate-fixed-price", rail: "pay-dem", delivery: wire.TP1_CAPABILITIES.delivery, service: { kind: "fixed-text" }, output: wire.TP1_CAPABILITIES.output, buyerRequestInput: false, notBefore: 0, expiresAt: Number.MAX_SAFE_INTEGER });
const signWith = (binding, local) => code(() => wire.signWireRequest({ signer, binding, local, path: "/dacs/v1/commitments", jobId: file.job.jobId, text: "{}", seller: file.parties.seller, job: { listingPin: file.job.listingPin, agreementHash: file.job.agreementHash, profile }, now: file.now }));

// Every verification entry point, on the vectors' correctly signed messages.
let effects = 0;
const effect = (fn) => code(() => { fn(); effects += 1; });
const decodedRequest = JSON.parse(b(vector["request/valid-direct"].header).toString("utf8"));
// An in-memory journal declared durable: the explicit test opt-in, and the seller ready for a new purchase.
const check = { requestJournal: { durable: true, reserve: () => true }, ready: true, retained: { jobId: file.job.jobId, agreementHash: file.job.agreementHash, buyer: file.parties.buyer, seller: file.parties.seller }, seller: file.parties.seller, listingPin: file.job.listingPin, method: "POST", path: vector["request/valid-direct"].path, rawBody: b(vector["request/valid-direct"].body), now: file.now, purchaseProfile: profile };
async function verifyAll(sellerBinding, sLocal, buyerBinding, bLocal) {
  return {
    openWireEnvelope: await effect(() => wire.openWireEnvelope(vector["request/valid-direct"].header, "request", { binding: sellerBinding, local: sLocal, purchaseProfile: profile })),
    checkWireRequest: await effect(() => wire.checkWireRequest(wire.openWireEnvelope(vector["request/valid-direct"].header, "request", { binding: sellerBinding, local: sLocal, purchaseProfile: profile }), { ...check, binding: sellerBinding, local: sLocal })),
    checkUnopened: await effect(() => wire.checkWireRequest(decodedRequest, { ...check, binding: sellerBinding, local: sLocal })),
    verifySellerSessionDelegation: await effect(() => wire.verifySellerSessionDelegation(vector["delegation/valid"].delegation, { binding: sellerBinding, local: sLocal, buyer: file.parties.buyer, seller: file.parties.seller, listingPin: file.job.listingPin, jobId: file.job.jobId, time: file.now })),
    verifyWireResponse: await effect(() => wire.verifyWireResponse(vector["response/valid"].request, { header: vector["response/valid"].header, status: 200, body: b(vector["response/valid"].body), now: file.now, binding: buyerBinding, local: bLocal })),
    verifyEndpointProof: await effect(() => wire.verifyEndpointProof(b(vector["discovery/valid"].document), { readListingEligibility, listing: vector["discovery/valid"].listing, binding: buyerBinding, local: bLocal, now: file.now })),
    assertPeerProfile: await effect(() => wire.assertPeerProfile(profile, buyerBinding)),
  };
}
const forgeries = (local) => [
  { profile },
  { profile, recordDigest: sha(canonicalize(record)), local, localDigest: sha(canonicalize(local)) },
];

if (process.argv[3] === "approved-synthetic") {
  // This copy approves the SYNTHETIC vector record only; it is never shipped.
  const sellerBinding = bindTp1Fixture({ record, local: sellerLocal });
  const buyerBinding = bindTp1Fixture({ record, local: buyerLocal });
  const changed = (local) => ({ ...local, connectionId: local.connectionId + "-changed" });
  out.genuine = await verifyAll(sellerBinding, sellerLocal, buyerBinding, buyerLocal);
  out.genuineEffects = effects; effects = 0;
  out.changedLocal = await verifyAll(sellerBinding, changed(sellerLocal), buyerBinding, changed(buyerLocal));
  out.copiedBinding = await verifyAll({ ...sellerBinding }, sellerLocal, { ...buyerBinding }, buyerLocal);
  out.copiedEnvelope = await code(() => wire.checkWireRequest({ ...wire.openWireEnvelope(vector["request/valid-direct"].header, "request", { binding: sellerBinding, local: sellerLocal, purchaseProfile: profile }) }, { ...check, binding: sellerBinding, local: sellerLocal }));
  out.otherBindingEnvelope = await code(() => wire.checkWireRequest(wire.openWireEnvelope(vector["request/valid-direct"].header, "request", { binding: sellerBinding, local: sellerLocal, purchaseProfile: profile }), { ...check, binding: bindTp1Fixture({ record, local: sellerLocal }), local: sellerLocal }));
  out.otherEffects = effects;
  // The compiled profile gate on the vectors' correctly signed revision cases.
  const open = (id) => code(() => wire.openWireEnvelope(vector[id].header, "request", { binding: sellerBinding, local: sellerLocal, purchaseProfile: profile }));
  out.revisionVectors = Object.fromEntries(["request/profile-revision-missing", "request/profile-identifier-and-base-only", "request/profile-revision-unknown", "request/profile-revision-mismatch", "request/profile-revision-lowercase", "request/profile-revision-trailing-space"].map((id) => [id, open(id)]));
  out.revisionVectors["request/purchase-profile-revision-missing"] = await code(() => wire.checkWireRequest(wire.openWireEnvelope(vector["request/valid-direct"].header, "request", { binding: sellerBinding, local: sellerLocal, purchaseProfile: profile }), { ...check, binding: sellerBinding, local: sellerLocal, purchaseProfile: vector["request/purchase-profile-revision-missing"].purchaseProfile }));
  for (const [id, verdict] of Object.entries(out.revisionVectors)) out.revisionVectors[id] = await verdict;
  console.log(JSON.stringify(out));
  process.exit(0);
}

// The shipped build: the consumer's own approval attempts, then forged bindings.
const digest = sha(canonicalize(record));
out.bindWithCallerList = await code(() => bindTp1Fixture({ record, local: buyerLocal, approvedRecordDigests: [digest] }));
out.extendSdkList = await code(() => wire.TP1_APPROVED_IDENTITY_RECORD_DIGESTS.push(digest));
out.extendProfileList = await code(() => wire.TESTNET_PROFILE_TP1.network.approvedIdentityRecordDigests.push(digest));
out.bindAfterAttempts = await code(() => bindTp1Fixture({ record, local: buyerLocal }));
out.signWithForgedBinding = await signWith(forgeries(buyerLocal)[1], buyerLocal);
out.forgedVerification = [];
for (const [i, forged] of forgeries(sellerLocal).entries()) out.forgedVerification.push(await verifyAll(forged, sellerLocal, forgeries(buyerLocal)[i], buyerLocal));

// Every function reachable by file path that ./wire does not export, called as
// an approval or binding function might be. Any object it returns is tried as
// a binding for signing and for verification.
out.reachableAsBinding = { objects: 0, signed: 0, verified: 0 };
for (const fn of beyond) {
  for (const args of [[[digest], { record, local: buyerLocal }], [{ record, local: buyerLocal, approvedRecordDigests: [digest] }], [record], []]) {
    let result;
    try { result = await fn(...args); } catch { continue; }
    if (result === null || typeof result !== "object") continue;
    out.reachableAsBinding.objects += 1;
    if ((await signWith(result, buyerLocal)) === "ok") out.reachableAsBinding.signed += 1;
    const verdicts = await verifyAll(result, sellerLocal, result, buyerLocal);
    if (Object.values(verdicts).includes("ok")) out.reachableAsBinding.verified += 1;
  }
}
out.signatures = signer.calls;
out.effects = effects;
// The unmodified shipped approval module admits the supplied approved identity record.
const approvedRecord = wire.TP1_APPROVED_IDENTITY_RECORD;
const bb = bindTp1Fixture({ record: approvedRecord, local: buyerLocal });
const sb = bindTp1Fixture({ record: approvedRecord, local: sellerLocal });
const sellerKeys = generateKeyPairSync("ed25519");
const sellerSigner = { claim: "did:demos:agent:" + sellerKeys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex"), calls: 0,
  sign(bytes) { sellerSigner.calls += 1; return new Uint8Array(sign(null, Buffer.from(bytes), sellerKeys.privateKey)); } };
const publicEndpoint = "https://seller.built-package.invalid";
const discoveryBytes = await wire.signDiscoveryDocument({ format: "dacs-seller-discovery/v1", profile: bb.profile, seller: sellerSigner.claim, publicEndpoint, transport: ["dacs-seller-http/v1"], listings: [file.job.listingPin], capabilities: wire.TP1_CAPABILITIES, ready: true, issuedAt: file.now, expiresAt: file.now + 60_000 }, sellerSigner, sb, sellerLocal);
const endpointProof = wire.verifyEndpointProof(discoveryBytes, { readListingEligibility, listing: { seller: sellerSigner.claim, publicEndpoint, listingPin: file.job.listingPin }, binding: bb, local: buyerLocal, now: file.now });
// Discovery is a separate seller signature from the request/answer pair counted below.
sellerSigner.calls = 0;
const approvedRequest = await wire.signWireRequest({ endpointProof, publicEndpoint, signer, binding: bb, local: buyerLocal, path: "/dacs/v1/commitments", jobId: file.job.jobId, text: "{}", seller: sellerSigner.claim, job: { listingPin: file.job.listingPin, agreementHash: file.job.agreementHash, profile: bb.profile }, now: file.now });
const approvedOpened = wire.openWireEnvelope(approvedRequest.header, "request", { binding: sb, local: sellerLocal, purchaseProfile: sb.profile });
wire.checkWireRequest(approvedOpened, { requestJournal: { durable: true, reserve: () => true }, ready: true, retained: { jobId: file.job.jobId, agreementHash: file.job.agreementHash, buyer: signer.claim, seller: sellerSigner.claim }, seller: sellerSigner.claim, listingPin: file.job.listingPin, method: "POST", path: approvedRequest.payload.path, rawBody: Buffer.from("{}"), now: file.now, binding: sb, local: sellerLocal, purchaseProfile: sb.profile });
const approvedResponse = await wire.signWireResponse(approvedOpened.payload, 200, "{}", { signer: sellerSigner, binding: sb, local: sellerLocal, now: file.now, purchaseProfile: sb.profile });
const receipt = wire.verifyWireResponse(approvedRequest.payload, { header: approvedResponse, status: 200, body: Buffer.from("{}"), now: file.now, binding: bb, local: buyerLocal });
out.approvedIdentity = { recordDigest: bb.recordDigest, sameProfile: canonicalize(bb.profile) === canonicalize(sb.profile), differentEndpoints: bb.local.endpoint !== sb.local.endpoint, verifiedSeller: receipt.principal === sellerSigner.claim, signatures: signer.calls + sellerSigner.calls };
// The approved tuple in the compiled package, and its refusals under the shipped approval.
const { revision: _revision, ...preRevision } = bb.profile;
const resigned = (p) => Buffer.from(canonicalize({ payload: p, signature: Buffer.from(signer.sign(Buffer.from("dacs-seller-http:v1:request:" + canonicalize(p)))).toString("base64url") })).toString("base64url");
out.approvedIdentityTuple = {
  tuple: [bb.profile.id, bb.profile.revision, bb.profile.base],
  revisionMissing: await code(() => wire.openWireEnvelope(resigned({ ...approvedRequest.payload, profile: preRevision }), "request", { binding: sb, local: sellerLocal, purchaseProfile: sb.profile })),
  revisionUnknown: await code(() => wire.openWireEnvelope(resigned({ ...approvedRequest.payload, profile: { ...bb.profile, revision: "TP-1.1" } }), "request", { binding: sb, local: sellerLocal, purchaseProfile: sb.profile })),
  keptPreRevision: await code(() => wire.checkWireRequest(wire.openWireEnvelope(approvedRequest.header, "request", { binding: sb, local: sellerLocal, purchaseProfile: sb.profile }), { seller: sellerSigner.claim, listingPin: file.job.listingPin, method: "POST", path: approvedRequest.payload.path, rawBody: Buffer.from("{}"), now: file.now, binding: sb, local: sellerLocal, purchaseProfile: preRevision })),
};
// The compiled seller entry points under the shipped approval: a kept tuple other than the binding's, or none
// given, opens nothing and signs nothing; the exact tuple, or none kept yet for a new purchase, does both.
const sellerCallsBefore = sellerSigner.calls;
const keptCases = { otherRevision: { purchaseProfile: { ...sb.profile, revision: "TP-1.1" } }, preRevision: { purchaseProfile: preRevision }, omitted: {} };
const approvedAnswer = { ...approvedRequest.payload, kind: "response", bodyHash: sha("{}"), expiresAt: file.now + 60_000, requestHash: wire.wireRequestHash(approvedRequest.payload), status: 200 };
let sellerOpened = 0, sellerSigned = 0;
out.approvedIdentitySeller = {};
for (const [name, kept] of Object.entries(keptCases)) {
  out.approvedIdentitySeller[name] = [
    await code(() => { wire.openWireEnvelope(approvedRequest.header, "request", { binding: sb, local: sellerLocal, ...kept }); sellerOpened += 1; }),
    await code(async () => { await wire.signWireResponse(approvedRequest.payload, 200, "{}", { signer: sellerSigner, binding: sb, local: sellerLocal, now: file.now, ...kept }); sellerSigned += 1; }),
    await code(async () => { await wire.signWireEnvelope(approvedAnswer, { signer: sellerSigner, binding: sb, local: sellerLocal, ...kept }); sellerSigned += 1; }),
  ];
}
out.approvedIdentitySeller.effects = { opened: sellerOpened, signed: sellerSigned, signerCalls: sellerSigner.calls - sellerCallsBefore };
for (const purchaseProfile of [sb.profile, null]) {
  const { payload } = wire.openWireEnvelope(approvedRequest.header, "request", { binding: sb, local: sellerLocal, purchaseProfile });
  await wire.signWireResponse(payload, 200, "{}", { signer: sellerSigner, binding: sb, local: sellerLocal, now: file.now, purchaseProfile });
}
out.approvedIdentitySeller.exactOrNewPurchaseSignerCalls = sellerSigner.calls - sellerCallsBefore;
console.log(JSON.stringify(out));
`;

let scratch = "";
let shipped: Record<string, any> = {};
let approvedCopy: Record<string, any> = {};

function consume(dir: string, ...args: string[]): Record<string, any> {
  writeFileSync(join(dir, "consumer.mjs"), CONSUMER);
  const run = spawnSync(process.execPath, ["consumer.mjs", VECTORS, ...args], { cwd: dir, encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" });
  if (run.status !== 0) throw new Error(`consumer failed (status ${run.status}, signal ${run.signal})\n${run.stderr}`);
  return JSON.parse(run.stdout);
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "dacs-wire-built-"));
  const shippedDir = join(scratch, "shipped"), approvedDir = join(scratch, "approved-synthetic");
  const pkg = join(shippedDir, "node_modules/@kynesyslabs/dacs");
  mkdirSync(pkg, { recursive: true });
  const build = spawnSync(join(root, "node_modules/.bin/tsc"), ["-p", join(root, "tsconfig.build.json"), "--outDir", join(pkg, "dist")], { cwd: root, encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL" });
  if (build.status !== 0) throw new Error(`build failed (status ${build.status}, signal ${build.signal})\n${build.stdout}${build.stderr}`);
  copyFileSync(join(root, "package.json"), join(pkg, "package.json"));
  shipped = consume(shippedDir);
  // The same compiled files; only approval.js names the SYNTHETIC vector record.
  const approvedPkg = join(approvedDir, "node_modules/@kynesyslabs/dacs");
  cpSync(pkg, approvedPkg, { recursive: true });
  const digests = JSON.parse(readFileSync(VECTORS, "utf8")).identity.testApprovedRecordDigests;
  writeFileSync(join(approvedPkg, "dist/wire/approval.js"), `export const TP1_APPROVED_IDENTITY_RECORD_DIGESTS = Object.freeze(${JSON.stringify(digests)});\n`);
  approvedCopy = consume(approvedDir, "approved-synthetic");
}, 240_000);

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

const ENTRY_POINTS = ["openWireEnvelope", "checkWireRequest", "checkUnopened", "verifySellerSessionDelegation", "verifyWireResponse", "verifyEndpointProof", "assertPeerProfile"];
const all = (value: string) => Object.fromEntries(ENTRY_POINTS.map((name) => [name, value]));

describe("built @kynesyslabs/dacs/wire, as a consumer installs it", () => {
  it("gives no package path to any wire module except ./wire", () => {
    expect(Object.values(shipped.deepImports)).toEqual(Array(4).fill("ERR_PACKAGE_PATH_NOT_EXPORTED"));
  });

  it("ships no approval injection: no compiled module or declaration names one, and approval.js holds only the SDK's frozen 2026-10-15 approval list", () => {
    expect(shipped.files).toContain("approval.js");
    expect(shipped.filesNamingTestApproval).toEqual([]);
    expect(shipped.approvalModule).toEqual({ names: ["TP1_APPROVED_IDENTITY_RECORD_DIGESTS"], list: ["c4e63ad6a75207c57c9342ed2c4fe38619c2b7cba17610753fbad2d5b4cc3cbd"], frozen: true, sameAsWire: true });
    expect(shipped.functionsBeyondWire.filter((f: string) => /^(approval|profile)\.js:/.test(f))).toEqual([]);
    expect(shipped.functionsBeyondWire.some((f: string) => /bind|approv/i.test(f))).toBe(false);
  });

  it("the shipped approval from 2026-10-15 binds two endpoints and verifies request and response signatures", () => {
    expect(shipped.approvedIdentity).toEqual({ recordDigest: "c4e63ad6a75207c57c9342ed2c4fe38619c2b7cba17610753fbad2d5b4cc3cbd", sameProfile: true, differentEndpoints: true, verifiedSeller: true, signatures: 2 });
  });

  it("the shipped 2026-10-15 approval binding carries the tuple (identifier, revision, base) and refuses a missing or other revision and a pre-revision kept tuple", () => {
    expect(shipped.approvedIdentityTuple).toEqual({
      tuple: ["dacs-testnet-tp1", "TP-1", "d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20"],
      revisionMissing: "tp1_profile_revision_missing", revisionUnknown: "tp1_profile_revision_unknown", keptPreRevision: "tp1_purchase_profile_mismatch",
    });
  });

  it("the shipped seller entry points open nothing and sign nothing under a kept tuple other than the approved binding, or with none given", () => {
    const refused = Array(3).fill("tp1_purchase_profile_mismatch");
    expect(shipped.approvedIdentitySeller).toEqual({
      otherRevision: refused, preRevision: refused, omitted: refused,
      effects: { opened: 0, signed: 0, signerCalls: 0 },
      exactOrNewPurchaseSignerCalls: 2,
    });
  });

  it("with the SYNTHETIC approval copy: the compiled gate refuses each revision vector with its own code", () => {
    expect(approvedCopy.revisionVectors).toEqual({
      "request/profile-revision-missing": "tp1_profile_revision_missing",
      "request/profile-identifier-and-base-only": "tp1_profile_revision_missing",
      "request/profile-revision-unknown": "tp1_profile_revision_unknown",
      "request/profile-revision-mismatch": "tp1_profile_revision_unknown",
      "request/profile-revision-lowercase": "tp1_profile_revision_unknown",
      "request/profile-revision-trailing-space": "tp1_profile_revision_unknown",
      "request/purchase-profile-revision-missing": "tp1_purchase_profile_mismatch",
    });
  });

  it("refuses the consumer's own approval attempts: zero signatures", () => {
    expect(shipped.bindWithCallerList).toBe("tp1_identity_unapproved");
    expect(shipped.extendSdkList).toBe("TypeError");
    expect(shipped.extendProfileList).toBe("TypeError");
    expect(shipped.bindAfterAttempts).toBe("tp1_identity_unapproved");
    expect(shipped.signWithForgedBinding).toBe("tp1_binding_required");
  });

  it("no function reachable by file path yields an object that signs or verifies as a binding", () => {
    expect(shipped.reachableAsBinding.signed).toBe(0);
    expect(shipped.reachableAsBinding.verified).toBe(0);
    expect(shipped.signatures).toBe(0);
  });

  it("refuses a forged binding, including one carrying only the vector's profile, at every verification entry point", () => {
    expect(shipped.forgedVerification).toEqual([all("tp1_binding_required"), all("tp1_binding_required")]);
    expect(shipped.effects).toBe(0);
  });

  it("with a SYNTHETIC approval copy of the same build: genuine messages verify under the actor's own binding", () => {
    expect(approvedCopy.genuine).toEqual({ ...all("ok"), checkUnopened: "peer_request_unverified" });
    expect(approvedCopy.genuineEffects).toBe(6);
  });

  it("with that copy: a changed connection, a copied binding, or an envelope not verified under the same binding is refused", () => {
    expect(approvedCopy.changedLocal).toEqual({ ...all("tp1_local_binding_changed"), assertPeerProfile: "ok" });
    expect(approvedCopy.copiedBinding).toEqual(all("tp1_binding_required"));
    expect(approvedCopy.copiedEnvelope).toBe("peer_request_unverified");
    expect(approvedCopy.otherBindingEnvelope).toBe("peer_request_unverified");
    // Only assertPeerProfile, which takes no connection, accepted the changed-connection case.
    expect(approvedCopy.otherEffects).toBe(1);
  });
});

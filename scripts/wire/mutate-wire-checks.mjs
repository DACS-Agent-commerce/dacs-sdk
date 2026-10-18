#!/usr/bin/env node
// Shows that each negative vector in vectors/dacs-seller-http-v1.json is
// caught by the check it names: for each mutant, one check is disabled in a
// scratch copy of src/, test/wire/vectors.test.ts is replayed against that copy
// (DACS_WIRE_IMPL), and every vector the mutant targets must then fail.
// The working tree is never edited. One test process runs at a time.
//
// Read-only target validation: node scripts/wire/mutate-wire-checks.mjs --check
// Usage: node scripts/wire/mutate-wire-checks.mjs --scratch <empty-or-new dir outside the checkout> [--report <file>]
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createOwnedScratch } from "./scratch-directory.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const option = process.argv[i];
  if (option === "--check") args.check = true;
  else if (option === "--scratch" || option === "--report") {
    const value = process.argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`${option} requires a path`);
    args[option.slice(2)] = value;
  } else throw new Error(`unknown option: ${option}`);
}
const checkOnly = args.check === true;
if (!args.scratch && !checkOnly) throw new Error("--scratch is required (or use --check)");
const scratchParent = args.scratch ? resolve(args.scratch) : undefined;

const M = (id, file, find, replace, catches) => ({ id, file, find, replace, catches });
/** A mutant that edits several files at once: [[file, find, replace], ...]. */
const MF = (id, edits, catches) => ({ id, file: edits.map(([file]) => file).join(" + "), edits, catches });
const MUTANTS = [
  M("wire NFC rule", "wire/validate.ts", 'if (value.normalize("NFC") !== value) throw', "if (false) throw", ["request/cf5-header-non-nfc", "request/cf5-body-non-nfc", "response/cf5-non-nfc", "discovery/cf5-non-nfc", "signing/request-cf5-non-nfc", "signing/response-cf5-non-nfc"]),
  M("CF-5 duplicate member", "canonical/rawJson.ts", 'if (names.has(name)) noteProfileError("DUPLICATE-MEMBER");', "", ["request/cf5-header-duplicate-member", "request/cf5-body-duplicate-member", "response/cf5-duplicate-member", "discovery/cf5-duplicate-member", "signing/request-cf5-duplicate-member", "signing/response-cf5-duplicate-member"]),
  M("CF-5 UTF-8", "canonical/rawJson.ts", '{ fatal: true, ignoreBOM: true }', "{ fatal: false, ignoreBOM: true }", ["request/cf5-header-malformed-utf8", "request/cf5-body-malformed-utf8", "response/cf5-malformed-utf8", "discovery/cf5-malformed-utf8"]),
  M("CF-5 number", "canonical/rawJson.ts", "noteProfileError(numberProfileError(match[0]));", "void numberProfileError;", ["request/cf5-header-invalid-number", "request/cf5-body-invalid-number", "response/cf5-invalid-number", "discovery/cf5-invalid-number", "signing/request-cf5-invalid-number", "signing/response-cf5-invalid-number"]),
  M("request body admission in checkWireRequest", "wire/envelope.ts", "const body = admitWireRequestBody(rawBody);", "const body = JSON.parse(Buffer.from(rawBody).toString(\"utf8\"));", ["request/cf5-body-duplicate-member", "request/cf5-body-malformed-utf8", "request/cf5-body-non-nfc", "request/cf5-body-invalid-number"]),
  M("response body admission in verifyWireResponse", "wire/response.ts", "const body = admitWireResponseBody(responseBytes);", "const body = JSON.parse(Buffer.from(responseBytes).toString(\"utf8\"));", ["response/cf5-duplicate-member", "response/cf5-malformed-utf8", "response/cf5-non-nfc", "response/cf5-invalid-number"]),
  M("outgoing request body admission in signWireRequest", "wire/response.ts", "const bytes = admitOutgoingBody(input.text, DACS_SELLER_HTTP_LIMITS.maxRequestBodyBytes);", "const bytes = Buffer.from(input.text, \"utf8\");", ["signing/request-cf5-duplicate-member", "signing/request-cf5-non-nfc", "signing/request-cf5-invalid-number"]),
  M("outgoing response body admission in signWireResponse", "wire/response.ts", "const bytes = admitOutgoingBody(text, DACS_SELLER_HTTP_LIMITS.maxResponseBodyBytes);", "const bytes = Buffer.from(text, \"utf8\");", ["signing/response-cf5-duplicate-member", "signing/response-cf5-non-nfc", "signing/response-cf5-invalid-number"]),
  M("request domain", "wire/routes.ts", 'request: "dacs-seller-http:v1:request:"', 'request: "dacs-chatgpt-plugin:loopback-seller-peer:v1:"', ["request/old-domain"]),
  M("request/response domain split (request)", "wire/routes.ts", 'request: "dacs-seller-http:v1:request:"', 'request: "dacs-seller-http:v1:response:"', ["request/response-domain"]),
  M("request/response domain split (selection)", "wire/envelope.ts", "DACS_SELLER_HTTP_DOMAINS[payload.kind]", "DACS_SELLER_HTTP_DOMAINS.request", ["response/request-domain"]),
  M("response domain", "wire/routes.ts", 'response: "dacs-seller-http:v1:response:"', 'response: "dacs-chatgpt-plugin:loopback-seller-peer:v1:"', ["response/old-domain"]),
  M("delegation domain", "wire/routes.ts", 'delegation: "dacs-seller-http:v1:delegation:"', 'delegation: "dacs-chatgpt-plugin:seller-session-delegation:v1:"', ["delegation/old-domain"]),
  M("discovery domain", "wire/routes.ts", 'discovery: "dacs-seller-http:v1:discovery:"', 'discovery: "dacs-seller-http:v1:request:"', ["discovery/wrong-domain"]),
  M("profile present (envelope)", "wire/envelope.ts", 'if (lacksProfile(p, kind === "response" ? RESPONSE_FIELDS : REQUEST_FIELDS)) fail("tp1_profile_missing", 409);', "", ["request/profile-missing", "response/profile-missing"]),
  M("profile present (delegation)", "wire/delegation.ts", 'if (lacksProfile(p, FIELDS)) fail("tp1_profile_missing", 409);', "", ["delegation/profile-missing"]),
  M("profile present (discovery)", "wire/discovery.ts", 'if (lacksProfile(p, FIELDS)) fail("tp1_profile_missing", 502);', "", ["discovery/profile-missing"]),
  M("profile equals own binding", "wire/profile.ts", "canonicalize(profile) !== canonicalize(own.profile)", "false", ["request/profile-wrong-id", "request/profile-wrong-base", "request/profile-wrong-chain", "request/profile-wrong-pin-version", "delegation/profile-wrong", "response/profile-wrong", "discovery/profile-wrong"]),
  // The tuple (identifier, revision, base): without its own check, each revision fault would be named as a later one.
  M("profile revision present", "wire/profile.ts", 'if (isRecord(profile) && !Object.hasOwn(profile, "revision")) fail("tp1_profile_revision_missing", status);', "", ["request/profile-revision-missing", "request/profile-identifier-and-base-only", "delegation/profile-revision-missing", "response/profile-revision-missing", "discovery/profile-revision-missing", "signing/envelope-profile-revision-missing", "signing/discovery-profile-revision-missing"]),
  M("profile revision defined", "wire/profile.ts", 'if (isRecord(profile) && !listHas(TP1_PROFILE_REVISIONS, profile.revision as string)) fail("tp1_profile_revision_unknown", status);', "", ["request/profile-revision-unknown", "request/profile-revision-mismatch", "request/profile-revision-lowercase", "request/profile-revision-mixed-case", "request/profile-revision-leading-space", "request/profile-revision-trailing-space", "request/profile-revision-trailing-newline", "request/profile-revision-inner-space", "request/profile-revision-empty", "request/profile-revision-number", "request/profile-revision-null", "request/profile-revision-boolean", "request/profile-revision-array", "request/profile-revision-object", "delegation/profile-revision-unknown", "response/profile-revision-unknown", "discovery/profile-revision-unknown", "discovery/profile-revision-mismatch", "signing/response-request-revision-unknown", "signing/delegation-profile-revision-unknown"]),
  // The tuple kept for the purchase. The seller checks it when it opens a request and again in
  // checkWireRequest, and signWireEnvelope checks the tuple every signer passes it; where two sites check one value,
  // the mutant removes both (each alone is equivalent there), and the single-site vectors show each site is needed.
  MF("purchase tuple kept (seller, both sites)", [
    ["wire/envelope.ts", '  if (purchaseProfile !== null || kind !== "request") assertPurchaseProfile(purchaseProfile, binding);\n', ""],
    ["wire/envelope.ts", "if (c.purchaseProfile !== null) assertPurchaseProfile(c.purchaseProfile, c.binding);", ""],
  ], ["request/purchase-profile-omitted", "request/purchase-profile-revision-missing", "request/purchase-profile-other-revision", "request/purchase-profile-other-chain"]),
  M("purchase tuple kept (open)", "wire/envelope.ts", '  if (purchaseProfile !== null || kind !== "request") assertPurchaseProfile(purchaseProfile, binding);\n', "", ["request/open-purchase-profile-other-revision", "request/open-purchase-profile-omitted"]),
  M("purchase tuple kept (check)", "wire/envelope.ts", "if (c.purchaseProfile !== null) assertPurchaseProfile(c.purchaseProfile, c.binding);", "", ["request/check-purchase-profile-other-revision", "request/check-purchase-profile-omitted"]),
  MF("purchase tuple kept (signer, with the envelope's)", [
    ["wire/response.ts", "assertPurchaseProfile(job?.profile, binding, 500);", ""],
    ["wire/envelope.ts", 'if (purchaseProfile !== null || payload.kind !== "response") assertPurchaseProfile(purchaseProfile, binding, 500);', ""],
  ], ["signing/request-purchase-profile-missing", "signing/request-purchase-profile-revision-missing", "signing/request-purchase-profile-other-revision"]),
  MF("purchase tuple kept (response signer, with the envelope's)", [
    ["wire/response.ts", "  if (purchaseProfile !== null) assertPurchaseProfile(purchaseProfile, binding, 500);\n", ""],
    ["wire/envelope.ts", 'if (purchaseProfile !== null || payload.kind !== "response") assertPurchaseProfile(purchaseProfile, binding, 500);', ""],
  ], ["signing/response-purchase-profile-missing", "signing/response-purchase-profile-other-revision"]),
  M("purchase tuple kept (envelope signer)", "wire/envelope.ts", 'if (purchaseProfile !== null || payload.kind !== "response") assertPurchaseProfile(purchaseProfile, binding, 500);', "", ["signing/envelope-purchase-profile-missing", "signing/envelope-purchase-profile-other-revision", "signing/envelope-request-purchase-profile-none"]),
  // A request is signed only under a kept tuple: `null` passes only for an answer.
  M("purchase tuple kept (envelope signer, request)", "wire/envelope.ts", 'if (purchaseProfile !== null || payload.kind !== "response")', "if (purchaseProfile !== null)", ["signing/envelope-request-purchase-profile-none"]),
  MF("purchase tuple kept (buyer, with the open's)", [
    ["wire/response.ts", "assertPurchaseProfile(request?.profile, received.binding);", ""],
    ["wire/envelope.ts", '  if (purchaseProfile !== null || kind !== "request") assertPurchaseProfile(purchaseProfile, binding);\n', ""],
  ], ["response/kept-request-revision-missing"]),
  M("envelope signature", "wire/envelope.ts", 'if (!verifyEd25519(wireEnvelopeSigningBytes(payload), envelopeSignatureBytes(envelope.signature), key)) fail("peer_signature_invalid");', "", ["request/wrong-signer", "response/other-signer"]),
  M("exact request fields", "wire/envelope.ts", "(kind === \"request\" || kind === \"response\") && hasKeys(p, kind === \"response\" ? RESPONSE_FIELDS : REQUEST_FIELDS) &&", "(kind === \"request\" || kind === \"response\") && typeof p === \"object\" && p !== null &&", ["request/extra-field"]),
  M("request expiry", "wire/envelope.ts", "request.expiresAt <= c.now || ", "", ["request/expired"]),
  M("request lifetime", "wire/envelope.ts", " || request.expiresAt > c.now + maxLifetimeMs", "", ["request/lifetime-over-60s"]),
  M("lifetime override bound", "wire/envelope.ts", " || ms > DACS_SELLER_HTTP_LIMITS.maxMessageLifetimeMs", "", ["request/lifetime-override-over-60s"]),
  M("listing pin", "wire/envelope.ts", 'if (!sameCanonical(request.listingPin, listingPin)) fail("peer_listing_mismatch", 409);', "", ["request/wrong-listing"]),
  M("audience", "wire/envelope.ts", 'if (request.seller !== c.seller) fail("peer_audience_wrong");', "", ["request/wrong-audience"]),
  M("body hash", "wire/envelope.ts", " || request.bodyHash !== sha256Hex(rawBody)", "", ["request/body-hash-mismatch"]),
  M("delegation required (both sites)", "wire/envelope.ts", [['if (requireDelegation && !delegated) fail("peer_delegation_required");', ""], ['if (c.requireDelegation && !delegation) fail("peer_delegation_required");', ""]], null, ["request/delegation-required"]),
  M("delegated request ends by delegation expiry", "wire/envelope.ts", 'if (request.expiresAt > delegation.payload.expiresAt) fail("peer_delegation_expired", 408);', "", ["request/delegated-outlives-delegation"]),
  M("delegated request matches the retained Agreement", "wire/envelope.ts", ' fail("peer_delegation_agreement_mismatch", 409);', " void 0;", ["request/delegated-agreement-mismatch"]),
  M("retained Agreement has a deadline", "wire/envelope.ts", 'if (!isUint(deadline)) fail("peer_delegation_deadline", 409);', "", ["request/delegated-agreement-no-deadline"]),
  M("delegation ends by the Agreement deadline", "wire/envelope.ts", "verifySellerSessionDelegation(delegation, { binding: c.binding, local: c.local, deadline: deadline as number });", "", ["request/delegated-delegation-beyond-agreement-deadline"]),
  M("expired delegation cannot start an effect", "wire/envelope.ts", 'if (!isReadRoute(request.path)) fail("peer_delegation_expired", 408);', "", ["request/expired-delegation-readback-only"]),
  M("delegation expiry", "wire/delegation.ts", "(!allowExpired && p.expiresAt <= time)", "false", ["delegation/expired"]),
  M("delegation notBefore", "wire/delegation.ts", "p.notBefore > time || ", "", ["delegation/not-yet-valid"]),
  M("delegation seller scope", "wire/delegation.ts", "(seller !== undefined && p.seller !== seller)", "false", ["delegation/wrong-seller-scope"]),
  M("delegation listing scope", "wire/delegation.ts", "(listingPin !== undefined && !sameCanonical(p.listingPin, listingPin))", "false", ["delegation/wrong-listing-scope"]),
  M("delegation job scope", "wire/delegation.ts", "(jobId !== undefined && p.jobId !== jobId)", "false", ["delegation/wrong-job-scope"]),
  M("delegation deadline", "wire/delegation.ts", 'if (deadline !== undefined && (!isUint(deadline) || p.expiresAt > deadline)) fail("peer_delegation_deadline", 409);', "", ["delegation/beyond-deadline"]),
  M("delegation signature", "wire/delegation.ts", 'if (!verifyEd25519(bytes, walletSignatureBytes(delegation.signature), claimKey(p.buyer))) fail("peer_delegation_signature_invalid");', "", ["delegation/bad-signature"]),
  M("delegation lifetime", "wire/delegation.ts", "p.expiresAt - p.notBefore > DACS_SELLER_HTTP_LIMITS.maxDelegationLifetimeMs || ", "", ["delegation/lifetime-over-24h"]),
  M("response status binding", "wire/response.ts", "status !== received.status ||", "", ["response/wrong-status"]),
  M("response body binding", "wire/response.ts", "bodyHash !== sha256Hex(responseBytes) || ", "", ["response/wrong-body"]),
  M("response principal", "wire/envelope.ts", 'if (principal !== undefined && actor !== principal) fail("peer_signer_wrong");', "", ["response/signer-not-seller"]),
  M("response identity binding", "wire/response.ts", "!sameCanonical(identity, expected) || ", "", ["response/identity-mismatch"]),
  M("response request-hash binding", "wire/response.ts", "requestHash !== expectedRequestHash || ", "", ["response/request-hash-mismatch"]),
  M("response expiry", "wire/response.ts", "expiresAt <= received.now ||", "", ["response/expired"]),
  M("response lifetime", "wire/response.ts", "expiresAt > received.now + DACS_SELLER_HTTP_LIMITS.maxMessageLifetimeMs", "false", ["response/lifetime-over-60s"]),
  M("endpoint proof: exact endpoint", "wire/discovery.ts", 'if (p.publicEndpoint !== listing.publicEndpoint) fail("discovery_endpoint_mismatch", 502);', "", ["discovery/endpoint-mismatch"]),
  M("endpoint proof: Listing seller", "wire/discovery.ts", 'if (p.seller !== listing.seller) fail("discovery_signer_wrong", 502);', "", ["discovery/signer-not-listing-seller"]),
  M("endpoint proof: signature", "wire/discovery.ts", "if (!verifyEd25519(discoverySigningBytes(p), envelopeSignatureBytes(document.signature, \"discovery_signature_invalid\"), claimKey(p.seller))) {", "if (false) {", ["discovery/bad-signature", "discovery/wrong-domain"]),
  M("discovery Listing listed", "wire/discovery.ts", 'if (!p.listings.some((pin) => sameCanonical(pin, listing.listingPin))) fail("discovery_listing_missing", 502);', "", ["discovery/listing-not-listed"]),
  M("discovery capabilities", "wire/discovery.ts", 'if (!sameCanonical(p.capabilities, TP1_CAPABILITIES)) fail("discovery_capabilities_unsupported", 502);\n  if (!isUint(now)', "if (!isUint(now)", ["discovery/capabilities-widened"]),
  M("discovery validity", "wire/discovery.ts", ' || p.expiresAt <= now) fail("discovery_expired", 502);', ') fail("discovery_expired", 502);', ["discovery/expired"]),
  M("discovery issuedAt skew", "wire/discovery.ts", "p.issuedAt > now + ISSUED_SKEW_MS || ", "", ["discovery/issued-in-future"]),
  M("identity record present", "wire/profile.ts", 'if (supplied === undefined || supplied === null) return fail("tp1_identity_record_missing", 500);', "", ["binding/record-missing"]),
  // One owned copy: without it, a record, connection or delegation whose answers change between reads
  // is checked as one value and used as another.
  M("identity record owned copy", "wire/profile.ts", 'const record = ownedConfig(supplied, "tp1_identity_record_invalid");', "const record = supplied;", ["binding/record-proxy-changes-between-reads", "binding/record-accessor-changes-between-reads"]),
  M("local connection owned copy", "wire/profile.ts", 'const local = ownedConfig(supplied, "tp1_local_binding_invalid");', "const local = supplied;", ["binding/local-proxy-changes-between-reads"]),
  M("delegation owned copy", "wire/delegation.ts", 'const delegation = ownedArtifact(supplied, "peer_delegation_invalid");', "const delegation = supplied;", ["delegation/payload-changes-between-reads"]),
  M("identity pins present", "wire/profile.ts", "if (record.chainIdentity === undefined || record.chainIdentity === null || record.pinVersion === undefined || record.pinVersion === null) {", "if (false) {", ["binding/pin-missing"]),
  M("fixture identity refused", "wire/profile.ts", 'if (listHas(TP1_REFUSED_FIXTURE_CHAIN_IDENTITIES, record.chainIdentity)) return fail("tp1_identity_fixture", 500);', "", ["binding/fixture-identity"]),
  M("refused identity", "wire/profile.ts", '    return fail("tp1_identity_refused", 500);', "", ["binding/mainnet-labelled-testnet-refused"]),
  M("identity approval", "wire/profile.ts", "!listHas(TP1_APPROVED_IDENTITY_RECORD_DIGESTS, recordDigest)", "false", ["binding/mainnet-labelled-testnet-unapproved", "binding/mainnet-labelled-testnet-caller-approved", "binding/caller-list-cannot-approve", "binding/no-approved-records"]),
  // A review regression: the public gate taking a caller's approval list.
  M("public gate approves only by the SDK's list", "wire/profile.ts", "!listHas(TP1_APPROVED_IDENTITY_RECORD_DIGESTS, recordDigest)", "!listHas(options.approvedRecordDigests ?? TP1_APPROVED_IDENTITY_RECORD_DIGESTS, recordDigest)", ["binding/mainnet-labelled-testnet-caller-approved", "binding/caller-list-cannot-approve"]),
  // Verification under the verifier's own binding: a plain object
  // carrying a profile is not a binding, and each verifier checks its actor's
  // current connection before it returns.
  M("SDK binding required", "wire/profile.ts", "typeof binding === \"object\" && binding !== null && isBinding(bindings, binding);", "typeof binding === \"object\" && binding !== null;", ["request/forged-binding", "delegation/forged-binding", "response/forged-binding", "discovery/forged-binding"]),
  M("verifier's current connection (open)", "wire/envelope.ts", "  assertTp1Binding(binding, local);\n  if (purchaseProfile !== null || kind !== \"request\")", "  if (purchaseProfile !== null || kind !== \"request\")", ["request/local-binding-changed"]),
  // verifyWireResponse checks the binding before it copies its inputs, and openWireEnvelope checks it again.
  MF("verifier's current connection (response, both sites)", [
    ["wire/envelope.ts", "  assertTp1Binding(binding, local);\n  if (purchaseProfile !== null || kind !== \"request\")", "  if (purchaseProfile !== null || kind !== \"request\")"],
    ["wire/response.ts", "  assertTp1Binding(received.binding, received.local);\n", ""],
  ], ["response/local-binding-changed"]),
  M("verifier's current connection (check)", "wire/envelope.ts", "  assertTp1Binding(c.binding, c.local);\n", "", ["request/local-binding-changed-before-check"]),
  M("verifier's current connection (delegation)", "wire/delegation.ts", "  assertTp1Binding(binding, local);\n  const listingPin = suppliedPin", "  const listingPin = suppliedPin", ["delegation/local-binding-changed"]),
  M("verifier's current connection (discovery)", "wire/discovery.ts", "  assertTp1Binding(binding, local);\n  let listing: VerifiedListingEndpoint;", "  let listing: VerifiedListingEndpoint;", ["discovery/local-binding-changed"]),
  // One owned copy of each signer's payload or request: without it, a payload whose profile changes
  // between reads is checked as the bound profile and signed, or embedded, as another. Where the bytes function a
  // signer calls has its own copy that already refuses the vector, the mutant removes both copies: each alone is
  // equivalent there, since no caller code runs between the two reads.
  M("envelope payload owned copy", "wire/envelope.ts", 'const payload = ownedArtifact(supplied, "peer_envelope_invalid", 500);', "const payload = supplied;", ["signing/envelope-payload-changes-between-reads"]),
  M("delegation payload owned copy", "wire/delegation.ts", 'const payload = ownedArtifact(supplied, "peer_delegation_invalid", 500) as SellerSessionDelegationPayload;', "const payload = supplied as SellerSessionDelegationPayload;", ["signing/delegation-payload-changes-between-reads"]),
  M("discovery payload owned copy", "wire/discovery.ts", 'const payload = ownedArtifact(supplied, "discovery_invalid", 500) as DiscoveryPayload;', "const payload = supplied as DiscoveryPayload;", ["signing/discovery-payload-changes-between-reads"]),
  MF("response request owned copy (with the request hash's)", [
    ["wire/response.ts", 'const request = ownedArtifact(supplied, "peer_envelope_invalid", 500) as WireRequestPayload;', "const request = supplied as WireRequestPayload;"],
    ["wire/envelope.ts", 'const copy = ownedArtifact(request, "peer_envelope_invalid", 500);', "const copy = request;"],
  ], ["signing/response-request-changes-between-reads"]),
  MF("request delegation owned copy (with the envelope's)", [
    ["wire/response.ts", 'input.delegation ? ownedArtifact(input.delegation, "peer_delegation_invalid") as SellerSessionDelegation : null', "input.delegation ? input.delegation as SellerSessionDelegation : null"],
    ["wire/envelope.ts", 'suppliedDelegation ? ownedArtifact(suppliedDelegation, "peer_delegation_invalid", 500) : null', "suppliedDelegation ?? null"],
  ], ["signing/request-delegation-edited-while-signing"]),
  M("check takes only a verified envelope", "wire/envelope.ts", "openedBinding(opened, envelope) !== c.binding ||", "", ["request/check-unopened-envelope", "request/check-copied-envelope", "request/check-other-binding"]),
];

// Validate the replay plan without applying a mutant, copying source or starting tests.
// This mode can run in ordinary CI even when mutation execution is delegated.
if (checkOnly) {
  const vectors = JSON.parse(readFileSync(join(root, "vectors/dacs-seller-http-v1.json"), "utf8")).vectors;
  const ids = new Set();
  for (const mutant of MUTANTS) {
    if (ids.has(mutant.id)) throw new Error(`duplicate check: ${mutant.id}`);
    ids.add(mutant.id);
    const edits = mutant.edits ?? (Array.isArray(mutant.find) ? mutant.find : [[mutant.find, mutant.replace]]).map(([find, replace]) => [mutant.file, find, replace]);
    for (const [file, find] of edits) {
      const source = readFileSync(join(root, "src", file), "utf8");
      if (!find || source.split(find).length !== 2) throw new Error(`${mutant.id}: the mutated text must occur exactly once in ${file}`);
    }
    for (const id of mutant.catches) {
      if (vectors.filter((v) => v.id === id).length !== 1) throw new Error(`${mutant.id}: missing or duplicate vector ${id}`);
    }
  }
  console.log(`${MUTANTS.length} named checks have current source targets and vectors; no mutations applied`);
  process.exit(0);
}

const owned = createOwnedScratch(scratchParent, root);
const scratch = owned.path;
try {
cpSync(join(root, "src"), join(scratch, "src"), { recursive: true });
const reportFile = join(scratch, "vitest.json");

function replay(label) {
  rmSync(reportFile, { force: true });
  const run = spawnSync(join(root, "node_modules/.bin/vitest"), ["run", "--no-cache", "--configLoader", "runner", "--reporter=json", `--outputFile=${reportFile}`, "test/wire/vectors.test.ts"], {
    cwd: root, env: { ...process.env, DACS_WIRE_IMPL: join(scratch, "src/wire/index.ts") }, encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL",
  });
  if (!existsSync(reportFile)) throw new Error(`${label}: no test report (status ${run.status}, signal ${run.signal})\n${run.stderr}`);
  const report = JSON.parse(readFileSync(reportFile, "utf8"));
  const results = report.testResults.flatMap((file) => file.assertionResults);
  return { status: run.status, total: results.length, failed: new Set(results.filter((r) => r.status !== "passed").map((r) => r.title)) };
}

const baseline = replay("unmutated copy");
if (baseline.status !== 0 || baseline.failed.size !== 0 || baseline.total === 0) throw new Error(`the unmutated copy must pass every vector (failed: ${[...baseline.failed].join(", ")})`);
const results = [];
for (const mutant of MUTANTS) {
  const edits = mutant.edits ?? (Array.isArray(mutant.find) ? mutant.find : [[mutant.find, mutant.replace]]).map(([find, replace]) => [mutant.file, find, replace]);
  const originals = new Map();
  for (const [file, find, replace] of edits) {
    const path = join(scratch, "src", file);
    if (!originals.has(path)) originals.set(path, readFileSync(path, "utf8"));
    const text = readFileSync(path, "utf8");
    if (text.split(find).length !== 2) throw new Error(`${mutant.id}: the mutated text must occur exactly once in ${file}`);
    writeFileSync(path, text.replace(find, () => replace));
  }
  try {
    const run = replay(mutant.id);
    const missed = mutant.catches.filter((id) => !run.failed.has(id));
    results.push({ mutant: mutant.id, file: mutant.file, total: run.total, failedVectors: [...run.failed].sort(), targets: mutant.catches, caught: missed.length === 0, missed });
    console.log(`${missed.length === 0 ? "caught" : "MISSED"}  ${mutant.id}: ${mutant.catches.join(", ")}${missed.length ? ` (missed ${missed.join(", ")})` : ""}`);
  } finally {
    for (const [path, text] of originals) writeFileSync(path, text);
  }
}
const summary = { baseline: { total: baseline.total, failed: baseline.failed.size }, mutants: results.length, caught: results.filter((r) => r.caught).length, results };
if (args.report) writeFileSync(resolve(args.report), `${JSON.stringify(summary, null, 2)}\n`);
console.log(`${summary.caught}/${summary.mutants} mutants caught by their named vectors; baseline ${baseline.total} vector tests passed`);
process.exitCode = summary.caught === summary.mutants ? 0 : 1;

} finally {
  owned.cleanup();
}

import * as fixtureWire from "../../src/wire/index.js";
import { fixtureBinder } from "./authorityFixture.js";
import { agreementFixture } from "./agreementFixture.js";
import { sha256ProvenanceFile } from "./provenanceFixture.js";
// Compares the SDK wire with the original plugin wire captured from frontend
// 82bf8c4 (test/wire/fixtures/plugin-wire-82bf8c4.original.json; captured messages are immutable),
// through its separately identified TP-1 revision adaptation
// (plugin-wire-82bf8c4.tp1-revision-adapted.json). Everything except the
// enumerated D6 changes (domains, `profile`, its `revision`), the K-1 key
// substitution and D7 (exact-bytes admission) must behave as the original did.
// The pre-revision adaptation (plugin-wire-82bf8c4.tp1-adapted.json)
// names the pre-revision tuple under valid signatures: the SDK refuses it.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { canonicalize } from "../../src/canonical/index.js";
import {
  checkWireRequest, DACS_SELLER_HTTP_DOMAINS, openWireEnvelope, verifySellerSessionDelegation,
  verifyWireResponse, wireEnvelopeSigningBytes, WireError, type Tp1Binding,
} from "../../src/wire/index.js";
// SYNTHETIC records are approved only by replacing src/wire/approval.ts with a
// test list (./testApproval.ts); no shipped module takes an approval list.
vi.mock("../../src/wire/approval.js", () => import("./testApproval.js"));
import { withTestApproval } from "./testApproval.js";
import { envelopeSignatureBytes, verifyEd25519 } from "../../src/wire/validate.js";

const bindTp1Fixture = fixtureBinder(fixtureWire);

const ORIGINAL_PATH = new URL("./fixtures/plugin-wire-82bf8c4.original.json", import.meta.url);
const PRE_REVISION_PATH = new URL("./fixtures/plugin-wire-82bf8c4.tp1-adapted.json", import.meta.url);
const ADAPTED_PATH = new URL("./fixtures/plugin-wire-82bf8c4.tp1-revision-adapted.json", import.meta.url);
const ORIGINAL_SHA256 = "4be1730d77d9cfdc2d840b876dee6adc0d261b70a7a903add2515751c905121b";
const PRE_REVISION_SHA256 = "89be02a422d5063281cab8e7b9e9f0dd27650a4da06dd66e6d4927161a988a35";
const ADAPTED_SHA256 = "26d001276f6b293eb80a744571e742413e655d63679d1f14c81ba7316e1773f9";
const ADAPTER_SHA256 = "b3ed612130f2f9b836791a697862e7c7accacf330e7cdc7aae31c85ebb83bf7c";
const original = JSON.parse(readFileSync(ORIGINAL_PATH, "utf8"));
const preRevision = JSON.parse(readFileSync(PRE_REVISION_PATH, "utf8"));
const adapted = JSON.parse(readFileSync(ADAPTED_PATH, "utf8"));
const sha256File = (url: URL) => createHash("sha256").update(readFileSync(url)).digest("hex");
const OLD = "dacs-chatgpt-plugin:loopback-seller-peer:v1:";
const OLD_DELEGATION = "dacs-chatgpt-plugin:seller-session-delegation:v1:";
const decode = (header: string) => JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
const omitProfile = ({ profile: _p, ...rest }: Record<string, unknown>) => rest;
// K-1 undone: each substitute claim or session key back to the capture's.
const capturedKeys = new Map(Object.values(adapted.keySubstitution.parties as Record<string, { from: string; to: string }>)
  .flatMap(({ from, to }) => [[to, from], [to.slice(-64), from.slice(-64)]]));
const unsubstitute = (v: unknown): unknown => (typeof v === "string" ? capturedKeys.get(v) ?? v
  : Array.isArray(v) ? v.map(unsubstitute)
  : v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unsubstitute(x)])) : v);

const bind = (local: unknown): Tp1Binding => withTestApproval([adapted.syntheticIdentityRecord.digest], () => bindTp1Fixture({
  record: adapted.syntheticIdentityRecord.record, local,
}));
const sellerBinding = bind(adapted.localBindings.seller);
const buyerBinding = bind(adapted.localBindings.buyer);

function code(fn: () => unknown): string {
  try { fn(); return "ok"; } catch (error) { if (error instanceof WireError) return error.code; throw error; }
}

function sellerVerdict(c: any): string {
  const scope = adapted.job;
  return code(() => {
    const body = c.bodyText ?? `{"jobId":"${scope.jobId}"}`;
    const opened = openWireEnvelope(c.header, "request", { binding: sellerBinding, local: adapted.localBindings.seller, purchaseProfile: sellerBinding.profile, requireDelegation: c.requireDelegation ?? false });
    checkWireRequest(opened, { reserveRequest: () => true, artifacts: agreementFixture(opened),
      retained: { jobId: scope.jobId, agreementHash: scope.agreementHash, buyer: adapted.parties.buyer, seller: adapted.parties.seller },
      seller: c.server?.seller === "other" ? adapted.parties.other : adapted.parties.seller,
      listingPin: c.server?.listingPin ?? scope.listingPin, method: "POST", path: scope.path, rawBody: Buffer.from(body),
      now: adapted.now, binding: sellerBinding, local: adapted.localBindings.seller, purchaseProfile: sellerBinding.profile, requireDelegation: c.requireDelegation ?? false,
    });
  });
}

const delegationVerdict = (c: any) => code(() => verifySellerSessionDelegation(c.delegation, {
  binding: sellerBinding, local: adapted.localBindings.seller, buyer: adapted.parties.buyer, seller: c.scope.seller === "other" ? adapted.parties.other : adapted.parties.seller,
  listingPin: c.scope.listingPin ?? adapted.job.listingPin, jobId: c.scope.jobId ?? adapted.job.jobId, time: c.scope.time ?? adapted.now,
  ...(c.scope.deadline === undefined ? {} : { deadline: c.scope.deadline }),
}));

const responseVerdict = (c: any) => code(() => verifyWireResponse(adapted.valid.response.request, {
  header: c.header, status: c.status, body: Buffer.from(c.text), now: adapted.now, binding: buyerBinding, local: adapted.localBindings.buyer,
}));

describe("original plugin wire fixture (frontend 82bf8c4)", () => {
  it("retains its captured messages and source provenance under publication pins", () => {
    expect(createHash("sha256").update(readFileSync(ORIGINAL_PATH)).digest("hex")).toBe(ORIGINAL_SHA256);
    expect(original.provenance.commit).toBe("82bf8c4dabb2332a72f618f6cc29950e48d6feb6");
    expect(original.provenance.sources.map((s: any) => [s.path, s.gitBlob])).toEqual([
      ["http-mcp/src/dacs/seller-transport-auth.mjs", "eec0a312ab91f18ed064f14d3393a716600927d1"],
      ["http-mcp/src/wallet/demos-signature.mjs", "3e6686910d5be32ddea53e11dbffab1e2e03391f"],
      ["http-mcp/public/portal/seller-session-limits.mjs", "6ca54be7de1d2eeb0fa4a16c2a3a48be0cda2a99"],
    ]);
    expect(original.nature).toMatch(/not a pre-existing plugin artifact/);
    expect(sha256ProvenanceFile(new URL("../../scripts/wire/capture-plugin-wire-fixture.mjs", import.meta.url))).toBe(original.provenance.generator.sha256);
    expect(original.provenance.generator.captureSha256).toBe("bbd61306977b956e61987b90d1e9bd4789f275aee7559dfaffe3457b05187dbb");
    expect(original.publicationNote).toMatch(/redacted for publication/);
    // The pre-revision adaptation retains its messages; its descriptive provenance was redacted.
    expect(sha256File(PRE_REVISION_PATH)).toBe(PRE_REVISION_SHA256);
    expect(preRevision.derivedFrom).toEqual({ fixture: "plugin-wire-82bf8c4.original", sha256: ORIGINAL_SHA256 });
    expect(preRevision.nature).toMatch(/NOT verbatim/);
    expect(preRevision.publicationNote).toMatch(/redacted for publication/);
    expect(preRevision.changes.map((c: any) => c.id)).toEqual(["D6-1", "D6-2", "D6-3", "D6-4"]);
    // The revision adaptation, derived from both by its pinned script.
    expect(sha256File(ADAPTED_PATH)).toBe(ADAPTED_SHA256);
    expect(sha256ProvenanceFile(new URL("../../scripts/wire/adapt-tp1-revision-fixture.mjs", import.meta.url))).toBe(ADAPTER_SHA256);
    expect(adapted.generator).toEqual({ path: "scripts/wire/adapt-tp1-revision-fixture.mjs", sha256: ADAPTER_SHA256 });
    expect(adapted.derivedFrom).toEqual([
      { fixture: "plugin-wire-82bf8c4.original", sha256: ORIGINAL_SHA256 },
      { fixture: "plugin-wire-82bf8c4.tp1-adapted", sha256: PRE_REVISION_SHA256 },
    ]);
    expect(adapted.nature).toMatch(/NOT verbatim/);
    expect(adapted.syntheticIdentityRecord).toEqual(preRevision.syntheticIdentityRecord);
    expect(adapted.syntheticIdentityRecord.label).toMatch(/SYNTHETIC/);
    expect(adapted.changes.map((c: any) => c.id)).toEqual(["D6-1", "D6-2", "D6-3", "D6-4", "D6-5"]);
    expect(adapted.changes.slice(0, 4)).toEqual(preRevision.changes);
    expect(adapted.keySubstitution.id).toBe("K-1");
    const substitution = Object.entries(adapted.keySubstitution.parties as Record<string, { from: string; to: string }>);
    expect(Object.fromEntries(substitution.map(([role, k]) => [role, k.from]))).toEqual(original.parties);
    expect(Object.fromEntries(substitution.map(([role, k]) => [role, k.to]))).toEqual(adapted.parties);
    for (const list of ["valid", "requestNegatives", "delegationNegatives", "responseNegatives"]) expect(JSON.stringify(adapted[list])).not.toContain("originalVerdict");
  });

  it("the original accepted every valid message and refused every negative with its own code", () => {
    for (const c of Object.values(original.valid) as any[]) expect(c.originalVerdict).toEqual({ ok: true });
    for (const list of ["requestNegatives", "delegationNegatives", "responseNegatives"]) {
      for (const c of original[list]) expect(c.originalVerdict.ok, c.id).toBe(false);
    }
  });

  it("canonical payload bytes, signature encoding and header encoding are unchanged apart from D6 and K-1", () => {
    for (const name of ["request", "response", "delegatedRequest"]) {
      const o = original.valid[name], a = adapted.valid[name];
      const kind = o.payload.kind as "request" | "response";
      // The capture recorded signing bytes for request and response; the delegated
      // request's are derived here and proven below by its original signature.
      const originalBytes = o.signingBytes ?? `${OLD}${canonicalize(o.payload)}`;
      expect(originalBytes).toBe(`${OLD}${canonicalize(o.payload)}`);
      const adaptedBytes = a.signingBytes ?? `${DACS_SELLER_HTTP_DOMAINS[kind]}${canonicalize(a.payload)}`;
      expect(adaptedBytes).toBe(`${DACS_SELLER_HTTP_DOMAINS[kind]}${canonicalize(a.payload)}`);
      expect(wireEnvelopeSigningBytes(a.payload).toString("utf8")).toBe(adaptedBytes);
      // With K-1 undone, the only payload difference is the profile member,
      // which carries the revision. A response's requestHash is still sha256
      // of its canonical request, which now includes the profile and the
      // substituted keys (a consequence of D6-4, D6-5 and K-1, not a separate change).
      expect(a.payload.profile).toEqual(sellerBinding.profile);
      expect(a.payload.profile.revision).toBe("TP-1");
      if (kind === "response") {
        const sha = (v: unknown) => createHash("sha256").update(canonicalize(v)).digest("hex");
        expect(o.payload.requestHash).toBe(sha(o.request));
        expect(a.payload.requestHash).toBe(sha(a.request));
        expect(canonicalize(unsubstitute(omitProfile(a.request)))).toBe(canonicalize(o.request));
        expect(canonicalize({ ...(unsubstitute(omitProfile(a.payload)) as object), requestHash: null })).toBe(canonicalize({ ...o.payload, requestHash: null }));
      } else {
        expect(canonicalize(unsubstitute(omitProfile(a.payload)))).toBe(canonicalize(o.payload));
      }
      expect(Object.keys(a.payload).filter((k) => !(k in o.payload))).toEqual(["profile"]);
      // The original signatures verify with the SDK's Ed25519 over the original bytes.
      const envelope = decode(o.header);
      const signer = kind === "request" ? (name === "delegatedRequest" ? original.parties.session : original.parties.buyer) : original.parties.seller;
      expect(verifyEd25519(Buffer.from(originalBytes, "utf8"), envelopeSignatureBytes(envelope.signature), signer.slice(-64))).toBe(true);
      // Header: base64url of the canonical {payload, signature, delegation?}, in both.
      expect(Buffer.from(canonicalize(envelope)).toString("base64url")).toBe(o.header);
      expect(Buffer.from(canonicalize(decode(a.header))).toString("base64url")).toBe(a.header);
    }
    const o = original.valid.delegation, a = adapted.valid.delegation;
    expect(o.signingBytes).toBe(`${OLD_DELEGATION}${canonicalize(o.payload)}`);
    expect(a.signingBytes).toBe(`${DACS_SELLER_HTTP_DOMAINS.delegation}${canonicalize(a.payload)}`);
    expect(canonicalize(unsubstitute(omitProfile(a.payload)))).toBe(canonicalize(o.payload));
    // Every adapted message, negatives included, is the pre-revision one with only the revision added and K-1 applied.
    const decoded = (c: any) => (c.header ? decode(c.header).payload : c.delegation?.payload ?? c.payload);
    for (const list of ["requestNegatives", "delegationNegatives", "responseNegatives"]) {
      adapted[list].forEach((c: any, i: number) => {
        const r = preRevision[list][i];
        expect(c.id).toBe(r.id);
        const { revision, ...profile } = decoded(c).profile;
        expect(revision, c.id).toBe("TP-1");
        expect(profile, c.id).toEqual(decoded(r).profile);
        const strip = (p: any) => ({ ...omitProfile(p), ...(p.kind === "response" ? { requestHash: null } : {}) });
        expect(canonicalize(unsubstitute(strip(decoded(c)))), c.id).toBe(canonicalize(strip(decoded(r))));
      });
    }
  });

  it("the SDK accepts each adapted valid message (seller and buyer directions)", () => {
    expect(sellerVerdict(adapted.valid.request)).toBe("ok");
    expect(sellerVerdict({ ...adapted.valid.delegatedRequest, requireDelegation: true })).toBe("ok");
    expect(delegationVerdict({ delegation: { payload: adapted.valid.delegation.payload, signature: adapted.valid.delegation.signature }, scope: {} })).toBe("ok");
    expect(responseVerdict(adapted.valid.response)).toBe("ok");
  });

  it("each adapted negative is refused with the original's code (unchanged protocol behaviour)", () => {
    const pairs = [
      ["requestNegatives", sellerVerdict],
      ["delegationNegatives", delegationVerdict],
      ["responseNegatives", responseVerdict],
    ] as const;
    let compared = 0;
    for (const [list, verdict] of pairs) {
      for (const c of adapted[list]) {
        const o = original[list].find((x: any) => x.id === c.id);
        expect(o, c.id).toBeDefined();
        expect(verdict(c), c.id).toBe(o.originalVerdict.code);
        compared += 1;
      }
    }
    expect(compared).toBe(21);
  });

  it("original (old-domain, profile-less) messages fail in the SDK; the original refuses every profile-bearing message", () => {
    expect(sellerVerdict(original.valid.request)).toBe("tp1_profile_missing");
    expect(sellerVerdict({ ...original.valid.delegatedRequest, requireDelegation: true })).toBe("tp1_profile_missing");
    expect(delegationVerdict({ delegation: { payload: original.valid.delegation.payload, signature: original.valid.delegation.signature }, scope: {} })).toBe("tp1_profile_missing");
    expect(code(() => verifyWireResponse(adapted.valid.response.request, { header: original.valid.response.header, status: 200, body: Buffer.from(original.valid.response.text), now: original.now, binding: buyerBinding, local: adapted.localBindings.buyer }))).toBe("tp1_profile_missing");
    // The original module's verdicts on profile-bearing messages, recorded for the pre-revision adaptation.
    for (const c of Object.values(preRevision.valid) as any[]) expect(c.originalVerdict.ok).toBe(false);
    expect(preRevision.valid.request.originalVerdict.code).toBe("peer_envelope_invalid");
    expect(preRevision.valid.delegation.originalVerdict.code).toBe("peer_delegation_invalid");
  });

  it("pre-revision adaptation: the pre-revision tuple {id, base, chainIdentity, pinVersion}, under valid signatures, is refused at the profile gate", () => {
    // Its signatures are genuine: only the missing revision can refuse these messages.
    const signedBy = (c: any, party: string, domain: string) => verifyEd25519(Buffer.from(`${domain}${canonicalize(decode(c.header).payload)}`, "utf8"), envelopeSignatureBytes(decode(c.header).signature), party.slice(-64));
    expect(signedBy(preRevision.valid.request, preRevision.parties.buyer, DACS_SELLER_HTTP_DOMAINS.request)).toBe(true);
    expect(signedBy(preRevision.valid.response, preRevision.parties.seller, DACS_SELLER_HTTP_DOMAINS.response)).toBe(true);
    expect(Object.keys(preRevision.valid.request.payload.profile).sort()).toEqual(["base", "chainIdentity", "id", "pinVersion"]);
    expect(sellerVerdict(preRevision.valid.request)).toBe("tp1_profile_revision_missing");
    expect(sellerVerdict({ ...preRevision.valid.delegatedRequest, requireDelegation: true })).toBe("tp1_profile_revision_missing");
    expect(delegationVerdict({ delegation: { payload: preRevision.valid.delegation.payload, signature: preRevision.valid.delegation.signature }, scope: {} })).toBe("tp1_profile_revision_missing");
    // The buyer's kept request carries the exact tuple; the pre-revision answer does not.
    expect(responseVerdict(preRevision.valid.response)).toBe("tp1_profile_revision_missing");
    // A buyer that kept the pre-revision request for the purchase is refused before the answer is opened.
    expect(code(() => verifyWireResponse(preRevision.valid.response.request, { header: adapted.valid.response.header, status: 200, body: Buffer.from(adapted.valid.response.text), now: adapted.now, binding: buyerBinding, local: adapted.localBindings.buyer }))).toBe("tp1_purchase_profile_mismatch");
    // Every pre-revision negative is refused too; each with the exact member set is refused for its missing revision.
    const codes = [
      ...preRevision.requestNegatives.map((c: any) => [c.id, sellerVerdict(c)]),
      ...preRevision.delegationNegatives.map((c: any) => [c.id, delegationVerdict(c)]),
      ...preRevision.responseNegatives.map((c: any) => [c.id, responseVerdict(c)]),
    ];
    expect(codes).toHaveLength(21);
    expect(Object.fromEntries(codes.filter(([, verdict]) => verdict !== "tp1_profile_revision_missing"))).toEqual({ "request/extra-field": "peer_envelope_invalid" });
  });

  it("D7: raw inputs the original accepted are refused at the SDK ingress, before any parse", () => {
    const byId = Object.fromEntries(original.rawInput.map((c: any) => [c.id, c]));
    expect(byId["raw/duplicate-member"].originalVerdict).toEqual({ ok: true });
    expect(byId["raw/non-nfc-value"].originalVerdict).toEqual({ ok: true });
    expect(byId["raw/malformed-utf8"].originalVerdict).toEqual({ ok: false, code: "peer_envelope_invalid" });
    const detail = (header: string) => {
      try { openWireEnvelope(header, "request", { binding: sellerBinding, local: adapted.localBindings.seller, purchaseProfile: sellerBinding.profile }); return "ok"; } catch (error) { return `${(error as WireError).code}/${(error as WireError).detail}`; }
    };
    expect(detail(byId["raw/duplicate-member"].header)).toBe("wire_json_rejected/DUPLICATE-MEMBER");
    expect(detail(byId["raw/non-nfc-value"].header)).toBe("wire_json_rejected/WIRE-NON-NFC-STRING");
    expect(detail(byId["raw/malformed-utf8"].header)).toBe("wire_json_rejected/INVALID-UTF8");
  });
});

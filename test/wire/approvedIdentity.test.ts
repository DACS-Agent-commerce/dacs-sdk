import { expect, it } from "vitest";
import { TP1_APPROVED_IDENTITY_RECORD, TP1_APPROVED_IDENTITY_RECORD_DIGESTS, signSellerSessionDelegation, verifySellerSessionDelegation, signDiscoveryDocument, verifyEndpointProof, TP1_CAPABILITIES } from "../../src/wire/index.js";
import * as fixtureWire from "../../src/wire/index.js";
import { fixtureBinder } from "./authorityFixture.js";
import { readFixtureListingEligibility } from "./listingEligibilityFixture.js";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { canonicalize } from "../../src/canonical/index.js";
const bindTp1Fixture = fixtureBinder(fixtureWire);
const RECORD = TP1_APPROVED_IDENTITY_RECORD;
const DIGEST = "5c234f784b8fbbb77a53886594dbdf3689fbbc336f04c2c930edfd57f225e330";
const NOW = Date.UTC(2026, 9, 15, 17);
const JOB = "01K7FZ8Q9W3V5T2R1N0M8K6J4H";
const PIN = { listingId: "approved-identity", version: 1, contentHash: "d".repeat(64) };
const A = { endpoint: "https://rpc-a.identity.invalid/", transportAuthority: "test-a", connectionId: "a-1" };
const B = { endpoint: "https://rpc-b.identity.invalid/", transportAuthority: "test-b", connectionId: "b-1" };
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function party() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const key = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
  return { key, claim: `did:demos:agent:${key}`, calls: 0, sign(bytes: Uint8Array) {
    this.calls += 1;
    return new Uint8Array(sign(null, Buffer.from(bytes), privateKey));
  } };
}
  it("pins the complete canonical record, including provenance and fallback documentation", () => {
    expect(RECORD.recordId).toBe("dacs-demos-testnet-identity/2026-10-20");
    expect(RECORD.chainIdentity).toBe("d59b54c2f70305e03d3a7e4d469f38295ffe4e4a62cb59b9f887057d0e5ca4bc");
    expect(RECORD.pinVersion).toBe(RECORD.recordId);
    expect(RECORD.provenance).toMatchObject({ approvedBy: "the owner", approvedAt: "2026-10-20", sourceKind: "confirmed-block-one-predecessor" });
    expect(RECORD.provenance.documentation).toBe("Demos testnet nodes refuse a numeric block 0 (`getBlockByNumber` with `blockNumber: 0` returns RPC result 400). The chain identity is block 1's `content.previousHash`, the genesis hash a string `blockNumber: \"0\"` returns, checked against the approved record `dacs-demos-testnet-identity/2026-10-20`.");
    expect(hash(canonicalize(RECORD))).toBe(DIGEST);
    expect(TP1_APPROVED_IDENTITY_RECORD_DIGESTS).toEqual([DIGEST]);
    expect(Object.isFrozen(RECORD) && Object.isFrozen(RECORD.provenance)).toBe(true);
    expect(RECORD).not.toHaveProperty("endpoint");
    expect(RECORD).not.toHaveProperty("transportAuthority");
    expect(bindTp1Fixture({ record: RECORD, local: A }).recordDigest).toBe(DIGEST);
  });
  it("signs and verifies delegation and discovery under the approved identity", async () => {
    const buyer = party(), seller = party(), session = party();
    const bb = bindTp1Fixture({ record: RECORD, local: A });
    const sb = bindTp1Fixture({ record: RECORD, local: B });
    const delegation = await signSellerSessionDelegation({ version: "1", kind: "seller-session-delegation", buyer: buyer.claim, sessionPublicKey: session.key, seller: seller.claim, listingPin: PIN, jobId: JOB, notBefore: NOW, expiresAt: NOW + 60_000, profile: bb.profile }, buyer, bb, A);
    verifySellerSessionDelegation(delegation, { buyer: buyer.claim, seller: seller.claim, listingPin: PIN, jobId: JOB, time: NOW, binding: sb, local: B });
    const publicEndpoint = "https://seller.identity.invalid";
    const discovery = await signDiscoveryDocument({ format: "dacs-seller-discovery/v1", profile: sb.profile, seller: seller.claim, publicEndpoint, transport: ["dacs-seller-http/v1"], listings: [PIN], capabilities: TP1_CAPABILITIES, ready: true, issuedAt: NOW, expiresAt: NOW + 60_000 }, seller, sb, B);
    verifyEndpointProof(discovery, { readListingEligibility: readFixtureListingEligibility, listing: { seller: seller.claim, publicEndpoint, listingPin: PIN }, binding: bb, local: A, now: NOW });
    expect(buyer.calls + seller.calls).toBe(2);
  });

import * as fixtureWire from "../../src/wire/index.js";
import { fixtureBinder } from "./authorityFixture.js";
import { generateKeyPairSync, sign } from "node:crypto";
import { expect, it } from "vitest";
import { canonicalize } from "../../src/canonical/index.js";
import * as wire from "../../src/wire/index.js";
import { readFixtureListingEligibility } from "./listingEligibilityFixture.js";

const bindTp1Fixture = fixtureBinder(fixtureWire);

it("admits exactly ten minutes, rejects ten minutes plus one millisecond at receiver and before producer signing", async () => {
  const keys = generateKeyPairSync("ed25519");
  const claim = `did:demos:agent:${keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex")}`;
  const local = { endpoint: "https://rpc.lifetime.invalid/", transportAuthority: "test", connectionId: "1" };
  const binding = bindTp1Fixture({ record: wire.TP1_APPROVED_IDENTITY_RECORD, local });
  const now = Date.UTC(2026, 9, 18);
  const listing = { seller: claim, publicEndpoint: "https://seller.lifetime.invalid", listingPin: { listingId: "report", version: 1, contentHash: "c".repeat(64) } };
  let calls = 0;
  const signer = { claim, sign(bytes: Uint8Array) { calls++; return sign(null, Buffer.from(bytes), keys.privateKey); } };
  for (const duration of [600_000, 600_001]) {
    const payload: wire.DiscoveryPayload = {
      format: "dacs-seller-discovery/v1", profile: binding.profile, seller: claim, publicEndpoint: listing.publicEndpoint,
      transport: ["dacs-seller-http/v1"], listings: [listing.listingPin], capabilities: wire.TP1_CAPABILITIES,
      ready: true, issuedAt: now, expiresAt: now + duration,
    };
    // Sign independently so the receiver is tested even when the producer
    // already refuses the overlong payload.
    const signature = sign(null, Buffer.from(wire.DACS_SELLER_HTTP_DOMAINS.discovery + canonicalize(payload)), keys.privateKey).toString("base64url");
    const bytes = Buffer.from(canonicalize({ payload, signature }));
    const receive = () => wire.verifyEndpointProof(bytes, { listing, binding, local, now, readListingEligibility: readFixtureListingEligibility });
    calls = 0;
    if (duration === 600_000) {
      expect(receive().ready).toBe(true);
      await wire.signDiscoveryDocument(payload, signer, binding, local);
      expect(calls).toBe(1);
    } else {
      expect(receive).toThrowError(expect.objectContaining({ code: "discovery_invalid" }));
      await expect(wire.signDiscoveryDocument(payload, signer, binding, local)).rejects.toMatchObject({ code: "discovery_invalid" });
      expect(calls).toBe(0);
    }
  }
});

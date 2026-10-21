import * as fixtureWire from "../../src/wire/index.js";
import { fixtureBinder } from "./authorityFixture.js";
import { generateKeyPairSync, sign } from "node:crypto";
import { expect, it, vi } from "vitest";
import * as wire from "../../src/wire/index.js";
import { FIXTURE_ENDPOINT, registerDiscoverySigner, signRequestWithProof } from "./requestFixture.js";

const bindTp1Fixture = fixtureBinder(fixtureWire);

function signer(): wire.WireSigner {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const claim = `did:demos:agent:${publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex")}`;
  return { claim, sign: (bytes) => sign(null, Buffer.from(bytes), privateKey) };
}

it.each([false, true])("uses the selected implementation for the entire proof fixture (supplied document: %s)", async (supplied) => {
  const buyer = signer(), seller = signer();
  registerDiscoverySigner(seller);
  const now = Date.UTC(2026, 9, 18);
  const local = { endpoint: "https://rpc.fixture.invalid/", transportAuthority: "test", connectionId: "1" };
  const binding = bindTp1Fixture({ record: wire.TP1_APPROVED_IDENTITY_RECORD, local });
  const listingPin = { listingId: "report", version: 1, contentHash: "c".repeat(64) };
  const input = {
    signer: buyer, binding, local, now, seller: seller.claim, path: "/dacs/v1/commitments", jobId: "01K7FZ8Q9W3V5T2R1N0M8K6J4H", text: "{}",
    job: { profile: binding.profile, listingPin, agreementHash: "a".repeat(64) },
  };
  const document = supplied ? await wire.signDiscoveryDocument({
    format: "dacs-seller-discovery/v1", profile: binding.profile, seller: seller.claim, publicEndpoint: FIXTURE_ENDPOINT,
    transport: ["dacs-seller-http/v1"], listings: [listingPin], capabilities: wire.TP1_CAPABILITIES, ready: true, issuedAt: now, expiresAt: now + 60_000,
  }, seller, binding, local) : undefined;
  const selected = {
    ...wire,
    signWireRequest: vi.fn(wire.signWireRequest),
    signDiscoveryDocument: vi.fn(wire.signDiscoveryDocument),
    verifyEndpointProof: vi.fn(wire.verifyEndpointProof),
  };
  const result = await signRequestWithProof(input, document, selected);
  expect(selected.signWireRequest).toHaveBeenCalledTimes(2);
  expect(selected.signDiscoveryDocument).toHaveBeenCalledTimes(supplied ? 0 : 1);
  expect(selected.verifyEndpointProof).toHaveBeenCalledTimes(1);
  expect(wire.openWireEnvelope(result.header, "request", { binding, local, purchaseProfile: binding.profile }).payload).toEqual(result.payload);
});

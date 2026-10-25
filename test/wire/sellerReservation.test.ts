import { expect, it, vi } from "vitest";

// Isolate the admission/journal contract; durable journal behavior has its own tests.
vi.mock("../../src/wire/journal.js", async (original) => ({
  ...await original<typeof import("../../src/wire/journal.js")>(),
  journalStore: vi.fn(),
  reserveEffect: vi.fn(),
}));

import * as wire from "../../src/wire/index.js";
import { journalStore, reserveEffect } from "../../src/wire/journal.js";
import { sha256Hex } from "../../src/canonical/hash.js";
import { ed25519Sign, privateKeyFromSeed } from "../../src/crypto/ed25519.js";
import { committedPurchase, BUYER_SEED, bytes } from "./committedPurchaseFixture.js";

const EFFECT_PATHS = wire.DACS_SELLER_HTTP_ROUTES.filter((route) => route.auth === "signed" && route.effect === "effect").map((route) => route.path);

it.each(EFFECT_PATHS)("%s passes the authenticated job and route to the journal", async (path) => {
  vi.clearAllMocks();
  const p = await committedPurchase(), { binding, now } = p.scope;
  const context = { binding, local: binding.local, purchaseProfile: binding.profile };
  const payload: wire.WireRequestPayload = { version: "1", kind: "request", method: "POST", path,
    bodyHash: sha256Hex("{}"), ...p.scope.request, seller: p.scope.seller, listingPin: p.scope.listingPin,
    nonce: Buffer.alloc(16).toString("base64url"), expiresAt: now + 30_000, profile: binding.profile };
  const signature = Buffer.from(ed25519Sign(wire.wireEnvelopeSigningBytes(payload), privateKeyFromSeed(BUYER_SEED))).toString("base64url");
  const opened = await wire.openWireEnvelope(Buffer.from(JSON.stringify({ payload, signature })).toString("base64url"), "request", context);
  const store = Object.freeze({});
  const effect: wire.WireEffect = { state: "new", operationId: wire.wireOperationId(payload), attempt: 0, leaseUntil: now + 60_000 };
  vi.mocked(journalStore).mockReturnValue(store);
  vi.mocked(reserveEffect).mockReturnValue(effect);
  const checked = await wire.checkWireRequest(opened, {
    ...context, seller: payload.seller, listingPin: payload.listingPin, method: payload.method, path,
    rawBody: Buffer.from("{}"), now, ready: true,
    retained: { jobId: payload.jobId, agreementHash: payload.agreementHash, buyer: payload.buyer, seller: payload.seller },
    requestJournal: { directory: "unused-contract-fixture" },
    commitment: bytes(p.anchored), agreement: bytes(p.agreement), signedListing: bytes(p.listing),
    readCommitmentReceipt: Object.assign(async () => "valid", { chainIdentity: binding.profile.chainIdentity }),
  });
  expect(reserveEffect).toHaveBeenCalledExactlyOnceWith(store, {
    key: expect.any(String), seller: payload.seller, jobId: payload.jobId, path,
    binding: expect.any(String), requestHash: wire.wireRequestHash(payload),
  });
  expect(checked.effect).toBe(effect);
});

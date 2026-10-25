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
import type { CommitmentReceiptReader } from "../../src/wire/commitment.js";
import { fixtureBinder } from "./authorityFixture.js";
import { committedPurchase, BUYER_SEED, bytes, type Purchase } from "./committedPurchaseFixture.js";

const EFFECT_PATHS = wire.DACS_SELLER_HTTP_ROUTES.filter((route) => route.auth === "signed" && route.effect === "effect").map((route) => route.path);

/** Opens a signed request for `path` that expires `lifetimeMs` after the purchase's clock. */
async function openRequest(p: Purchase, binding: wire.Tp1Binding, path: string, lifetimeMs = 30_000) {
  const payload: wire.WireRequestPayload = { version: "1", kind: "request", method: "POST", path,
    bodyHash: sha256Hex("{}"), ...p.scope.request, seller: p.scope.seller, listingPin: p.scope.listingPin,
    nonce: Buffer.alloc(16).toString("base64url"), expiresAt: p.scope.now + lifetimeMs, profile: binding.profile };
  const signature = Buffer.from(ed25519Sign(wire.wireEnvelopeSigningBytes(payload), privateKeyFromSeed(BUYER_SEED))).toString("base64url");
  const context = { binding, local: binding.local, purchaseProfile: binding.profile };
  const opened = await wire.openWireEnvelope(Buffer.from(JSON.stringify({ payload, signature })).toString("base64url"), "request", context);
  return { payload, opened, context };
}

function requestCheck(p: Purchase, request: Awaited<ReturnType<typeof openRequest>>, readCommitmentReceipt: CommitmentReceiptReader): wire.RequestCheck {
  const { payload, context } = request;
  return { ...context, seller: payload.seller, listingPin: payload.listingPin, method: payload.method, path: payload.path,
    rawBody: Buffer.from("{}"), now: p.scope.now, ready: true,
    retained: { jobId: payload.jobId, agreementHash: payload.agreementHash, buyer: payload.buyer, seller: payload.seller },
    requestJournal: { directory: "unused-contract-fixture" },
    commitment: bytes(p.anchored), agreement: bytes(p.agreement), signedListing: bytes(p.listing), readCommitmentReceipt };
}

const receiptReader = (binding: wire.Tp1Binding, read: () => string = () => "valid") =>
  Object.assign(async () => read(), { chainIdentity: binding.profile.chainIdentity }) as CommitmentReceiptReader;

it.each(EFFECT_PATHS)("%s passes the authenticated job and route to the journal", async (path) => {
  vi.clearAllMocks();
  const p = await committedPurchase(), { binding, now } = p.scope;
  const request = await openRequest(p, binding, path);
  const store = Object.freeze({});
  const effect: wire.WireEffect = { state: "new", operationId: wire.wireOperationId(request.payload), attempt: 0, leaseUntil: now + 60_000 };
  vi.mocked(journalStore).mockReturnValue(store);
  vi.mocked(reserveEffect).mockReturnValue(effect);
  const checked = await wire.checkWireRequest(request.opened, requestCheck(p, request, receiptReader(binding)));
  expect(reserveEffect).toHaveBeenCalledExactlyOnceWith(store, {
    key: expect.any(String), seller: request.payload.seller, jobId: request.payload.jobId, path,
    binding: expect.any(String), requestHash: wire.wireRequestHash(request.payload),
  });
  expect(checked.effect).toBe(effect);
});

it.each(wire.CONTINUING_PATHS)("%s reserves nothing for a request that expired while its receipt was verified", async (path) => {
  vi.clearAllMocks();
  const p = await committedPurchase();
  const request = await openRequest(p, p.scope.binding, path, 10_000);
  vi.mocked(journalStore).mockReturnValue(Object.freeze({}));
  let elapsedMs = 0;
  const monotonic = vi.spyOn(performance, "now").mockImplementation(() => elapsedMs);
  try {
    const slowReceipt = receiptReader(p.scope.binding, () => { elapsedMs += 11_000; return "valid"; });
    await expect(wire.checkWireRequest(request.opened, requestCheck(p, request, slowReceipt))).rejects.toMatchObject({ code: "peer_expired" });
  } finally {
    monotonic.mockRestore();
  }
  expect(reserveEffect).not.toHaveBeenCalled();
});

it.each(wire.CONTINUING_PATHS)("%s reserves nothing once the connection's authority is lost while its receipt is verified", async (path) => {
  vi.clearAllMocks();
  const p = await committedPurchase();
  const { profile } = p.scope.binding;
  let lost = false;
  const binding = await fixtureBinder(wire)({ record: wire.TP1_APPROVED_IDENTITY_RECORD, local: p.scope.binding.local,
    readAuthority: (scope) => {
      if (lost) throw new Error("authority withdrawn");
      return { local: { ...scope.local }, chainIdentity: profile.chainIdentity, provenance: "test-only-independent-authority/v1",
        sessionId: scope.sessionId, participants: scope.participants.map((claim) => ({ claim, profile, modules: wire.TESTNET_PROFILE_TP1.tuple })) };
    } });
  const request = await openRequest(p, binding, path);
  vi.mocked(journalStore).mockReturnValue(Object.freeze({}));
  const withdrawingReceipt = receiptReader(binding, () => { lost = true; return "valid"; });
  await expect(wire.checkWireRequest(request.opened, requestCheck(p, request, withdrawingReceipt))).rejects.toThrow("authority withdrawn");
  expect(reserveEffect).not.toHaveBeenCalled();
});

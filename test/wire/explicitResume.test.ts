import { expect, it } from "vitest";
import { canonicalize } from "../../src/canonical/jcs.js";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "../../src/crypto/ed25519.js";
import * as wire from "../../src/wire/index.js";
import { fixtureBinder } from "./authorityFixture.js";
import { BUYER, SELLER, BUYER_SEED, NOW, JOB } from "./committedPurchaseFixture.js";

const SESSION_SEED = Buffer.alloc(32, 43);
const sessionPublicKey = Buffer.from(rawPublicKey(publicKeyFromSeed(SESSION_SEED))).toString("hex");
const LANE = wire.DACS_SELLER_HTTP_PATHS.commitments;
const DOMAIN = "dacs-seller-http:v1:explicit-create-resume:";

async function fixture(options: { listingId?: string; readAuthority?: wire.Tp1AuthorityReader } = {}) {
  const local = { endpoint: "https://rpc.resume.invalid/", transportAuthority: "test", connectionId: "1" };
  const binding = await fixtureBinder(wire)({ record: wire.TP1_APPROVED_IDENTITY_RECORD, local, ...(options.readAuthority ? { readAuthority: options.readAuthority } : {}) });
  const listingPin = { listingId: options.listingId ?? "resume", version: 1, contentHash: "a".repeat(64) };
  const request: wire.WireRequestPayload = { version: "1", kind: "request", method: "POST", path: LANE, bodyHash: "b".repeat(64), jobId: JOB,
    buyer: BUYER, seller: SELLER, listingPin, agreementHash: "c".repeat(64), nonce: Buffer.alloc(16, 7).toString("base64url"), expiresAt: NOW + 30_000, profile: binding.profile };
  const payload: wire.ExplicitCreateResumePayload = { version: "1", kind: "explicit-create-resume", buyer: BUYER, seller: SELLER, listingPin, jobId: JOB, path: LANE,
    agreementHash: request.agreementHash, requestHash: wire.wireRequestHash(request), nonce: Buffer.alloc(16, 9).toString("base64url"), expiresAt: NOW + 30_000, profile: binding.profile };
  const scope = (): wire.ExplicitResumeScope => ({ binding, local, request, delegation: null, time: NOW, ledger: wire.createExplicitResumeLedger() });
  const buyerSigner = { claim: BUYER, sign: (bytes: Uint8Array) => ed25519Sign(bytes, privateKeyFromSeed(BUYER_SEED)) };
  const sessionSigner = { claim: BUYER, sign: (bytes: Uint8Array) => ed25519Sign(bytes, privateKeyFromSeed(SESSION_SEED)) };
  const delegation: wire.SellerSessionDelegationPayload = { version: "1", kind: "seller-session-delegation", buyer: BUYER, seller: SELLER, sessionPublicKey, listingPin, jobId: JOB,
    notBefore: NOW, expiresAt: NOW + 60_000, profile: binding.profile };
  return { binding, local, request, payload, scope, buyerSigner, sessionSigner, delegation };
}

/** A header built here from the card's format, independent of the helpers: any payload, any domain, any key seed. */
function header(payload: unknown, seed: Uint8Array = BUYER_SEED, domain: string = DOMAIN): string {
  const signature = Buffer.from(ed25519Sign(Buffer.from(domain + canonicalize(payload)), privateKeyFromSeed(seed))).toString("base64url");
  return Buffer.from(canonicalize({ payload, signature })).toString("base64url");
}
const refused = (run: () => Promise<unknown>, code: string) => expect(run()).rejects.toMatchObject({ code });

it("O-7 / DS-14 bounded explicit-resume helpers replay one fixture per DS-14 element", async () => {
  const f = await fixture();
  const sign = (payload: wire.ExplicitCreateResumePayload, signer = f.buyerSigner) => wire.signExplicitCreateResume(payload, { signer, binding: f.binding, local: f.local, now: NOW });

  // 1. Exact bytes and header: the helper's header is the independent encoding, and the verifier returns the payload that was signed.
  expect(wire.DACS_SELLER_RESUME_HEADER).toBe("x-dacs-seller-resume");
  expect(wire.DACS_SELLER_HTTP_DOMAINS.explicitCreateResume).toBe(DOMAIN);
  expect(wire.explicitCreateResumeSigningBytes(f.payload)).toEqual(Buffer.from(DOMAIN + canonicalize(f.payload)));
  const signed = await sign(f.payload);
  expect(signed).toBe(header(f.payload));
  expect(signed).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(signed.length).toBeLessThanOrEqual(wire.DACS_SELLER_HTTP_LIMITS.maxHeaderLength);
  expect(await wire.verifyExplicitCreateResume(signed, f.scope())).toEqual(f.payload);
  for (const bad of [`${signed}=`, signed.replace(/.$/, "+"), "", "A".repeat(wire.DACS_SELLER_HTTP_LIMITS.maxHeaderLength + 1)]) {
    await refused(() => wire.verifyExplicitCreateResume(bad, f.scope()), "explicit_resume_invalid");
  }
  await expect(wire.verifyExplicitCreateResume("A".repeat(wire.DACS_SELLER_HTTP_LIMITS.maxHeaderLength + 1), f.scope())).rejects.toMatchObject({ detail: "HEADER-TOO-LONG" });

  // 2. Closed payload: a missing or extra member is refused at the signer and at the verifier.
  const { nonce: _nonce, ...missing } = f.payload;
  for (const open of [missing, { ...f.payload, extra: 1 }, { ...f.payload, kind: "explicit-resume" }]) {
    await refused(() => sign(open as wire.ExplicitCreateResumePayload), "explicit_resume_invalid");
    await refused(() => wire.verifyExplicitCreateResume(header(open), f.scope()), "explicit_resume_invalid");
  }

  // 3. expiresAt bound: exclusive at the verifier's clock, at most the receiver window ahead, and at most the signer's lifetime at signing.
  const at = (expiresAt: number) => ({ ...f.payload, expiresAt });
  await refused(() => wire.verifyExplicitCreateResume(header(at(NOW)), f.scope()), "explicit_resume_expired");
  expect(await wire.verifyExplicitCreateResume(header(at(NOW + 1)), f.scope())).toEqual(at(NOW + 1));
  const window = wire.DACS_SELLER_HTTP_LIMITS.maxMessageLifetimeMs;
  expect(await wire.verifyExplicitCreateResume(header(at(NOW + window)), f.scope())).toEqual(at(NOW + window));
  await refused(() => wire.verifyExplicitCreateResume(header(at(NOW + window + 1)), f.scope()), "explicit_resume_invalid");
  await refused(() => sign(at(NOW + wire.DACS_SELLER_HTTP_LIMITS.maxSignedLifetimeMs + 1)), "explicit_resume_invalid");
  await refused(() => sign(at(NOW)), "explicit_resume_invalid");

  // 4. Signature domain, principal and delegation: only the request's own signer under this domain verifies.
  await refused(() => wire.verifyExplicitCreateResume(header(f.payload, BUYER_SEED, wire.DACS_SELLER_HTTP_DOMAINS.request), f.scope()), "explicit_resume_signature_invalid");
  await refused(() => wire.verifyExplicitCreateResume(header(f.payload, SESSION_SEED), f.scope()), "explicit_resume_signature_invalid");
  const delegated = { ...f.scope(), delegation: f.delegation };
  expect(await wire.verifyExplicitCreateResume(await sign(f.payload, f.sessionSigner), delegated)).toEqual(f.payload);
  await refused(() => wire.verifyExplicitCreateResume(signed, { ...f.scope(), delegation: f.delegation }), "explicit_resume_signature_invalid");
  await refused(() => wire.verifyExplicitCreateResume(header(f.payload, BUYER_SEED), { ...f.scope(), request: { ...f.request, buyer: SELLER, seller: BUYER } }), "explicit_resume_mismatch");

  // 5. One-use consumption: a repeat is refused, and a changed request, scope, lane or hash is refused without using the proof up.
  const scope = f.scope();
  const changed: Array<[string, Partial<wire.WireRequestPayload>]> = [
    ["request", { nonce: Buffer.alloc(16, 8).toString("base64url") }],
    ["scope", { jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7F" }],
    ["lane", { path: wire.DACS_SELLER_HTTP_PATHS.payments }],
    ["hash", { agreementHash: "d".repeat(64) }],
  ];
  for (const [, change] of changed) await refused(() => wire.verifyExplicitCreateResume(signed, { ...scope, request: { ...f.request, ...change } }), "explicit_resume_mismatch");
  expect(await wire.verifyExplicitCreateResume(signed, scope)).toEqual(f.payload);
  await refused(() => wire.verifyExplicitCreateResume(signed, scope), "explicit_resume_used");
  const lapsed = await sign(at(NOW + 5));
  await refused(() => wire.verifyExplicitCreateResume(lapsed, { ...scope, time: NOW + 31_000 }), "explicit_resume_expired");
});

const signWith = (f: Awaited<ReturnType<typeof fixture>>, payload: wire.ExplicitCreateResumePayload, signer: wire.WireSigner = f.buyerSigner) =>
  wire.signExplicitCreateResume(payload, { signer, binding: f.binding, local: f.local, now: NOW });

it("the longest legal proof still fits the header limit and verifies", async () => {
  const f = await fixture({ listingId: "L".repeat(128) });
  const header = await signWith(f, f.payload);
  expect(header.length).toBeLessThanOrEqual(wire.DACS_SELLER_HTTP_LIMITS.maxHeaderLength);
  expect(await wire.verifyExplicitCreateResume(header, f.scope())).toEqual(f.payload);
});

it("a delegation without a session key never falls back to the buyer's key", async () => {
  const f = await fixture();
  const { sessionPublicKey: _sessionPublicKey, ...keyless } = f.delegation;
  const delegation = keyless as unknown as wire.SellerSessionDelegationPayload;
  await refused(async () => wire.verifyExplicitCreateResume(await signWith(f, f.payload), { ...f.scope(), delegation }), "explicit_resume_signature_invalid");
});

it("refuses to sign for a signer that is not the payload's buyer", async () => {
  const f = await fixture();
  await refused(() => signWith(f, f.payload, { claim: SELLER, sign: f.buyerSigner.sign }), "explicit_resume_invalid");
});

it("refuses to sign or verify on a changed connection or without a binding", async () => {
  const f = await fixture();
  const signed = await signWith(f, f.payload);
  await refused(() => wire.signExplicitCreateResume(f.payload, { signer: f.buyerSigner, binding: f.binding, local: { ...f.local, connectionId: "2" }, now: NOW }), "tp1_local_binding_changed");
  await refused(() => wire.verifyExplicitCreateResume(signed, { ...f.scope(), local: { ...f.local, connectionId: "2" } }), "tp1_local_binding_changed");
  await refused(() => wire.verifyExplicitCreateResume(signed, { ...f.scope(), binding: { ...f.binding } }), "tp1_binding_required");
});

it("returns no header when the participants' authority changes while the signer runs", async () => {
  const profile = { id: wire.TP1_PROFILE_ID, revision: wire.TP1_PROFILE_REVISION, base: wire.TP1_BASE_REVISION,
    chainIdentity: wire.TP1_APPROVED_IDENTITY_RECORD.chainIdentity, pinVersion: wire.TP1_APPROVED_IDENTITY_RECORD.pinVersion };
  let drifted = false;
  const readAuthority: wire.Tp1AuthorityReader = (scope) => ({ local: { ...scope.local }, chainIdentity: profile.chainIdentity, provenance: "test-only-independent-authority/v1",
    sessionId: scope.sessionId, participants: scope.participants.map((claim) => ({ claim: drifted ? SELLER : claim, profile, modules: wire.TESTNET_PROFILE_TP1.tuple })) });
  const f = await fixture({ readAuthority });
  const driftingSigner = { claim: BUYER, sign: (bytes: Uint8Array) => { drifted = true; return f.buyerSigner.sign(bytes); } };
  await refused(() => signWith(f, f.payload, driftingSigner), "tp1_participant_profile_mismatch");
});

it("a signer that fails returns no header and keeps nothing, so signing again works", async () => {
  const f = await fixture();
  const failing = { claim: BUYER, sign: () => { throw new Error("wallet unavailable"); } };
  await expect(signWith(f, f.payload, failing)).rejects.toThrow("wallet unavailable");
  expect(await wire.verifyExplicitCreateResume(await signWith(f, f.payload), f.scope())).toEqual(f.payload);
});

it("a proof claimed before the host acted is refused on resend, and a fresh proof verifies", async () => {
  const f = await fixture();
  const scope = f.scope();
  const first = await signWith(f, f.payload);
  expect(await wire.verifyExplicitCreateResume(first, scope)).toEqual(f.payload);
  await refused(() => wire.verifyExplicitCreateResume(first, scope), "explicit_resume_used");
  const fresh = { ...f.payload, nonce: Buffer.alloc(16, 10).toString("base64url") };
  expect(await wire.verifyExplicitCreateResume(await signWith(f, fresh), scope)).toEqual(fresh);
});

it("a ledger that cannot record refuses the proof with its cause and leaves it unused", async () => {
  const f = await fixture();
  const signed = await signWith(f, f.payload);
  const cause = new Error("store unavailable");
  const failing: wire.ExplicitResumeLedger = { claim: () => { throw cause; } };
  const rejecting: wire.ExplicitResumeLedger = { claim: () => Promise.reject(cause) };
  for (const ledger of [failing, rejecting]) {
    await expect(wire.verifyExplicitCreateResume(signed, { ...f.scope(), ledger })).rejects.toMatchObject({ code: "explicit_resume_ledger_failed", cause });
  }
  expect(await wire.verifyExplicitCreateResume(signed, f.scope())).toEqual(f.payload);
});

it("a durable ledger rebuilt after a restart still refuses a proof the earlier process used", async () => {
  const f = await fixture();
  const signed = await signWith(f, f.payload);
  const disk = new Set<string>();
  const durableLedger = (): wire.ExplicitResumeLedger => {
    const known = new Set(disk);
    return { claim: async (key) => { if (known.has(key)) return false; known.add(key); disk.add(key); return true; } };
  };
  expect(await wire.verifyExplicitCreateResume(signed, { ...f.scope(), ledger: durableLedger() })).toEqual(f.payload);
  await refused(() => wire.verifyExplicitCreateResume(signed, { ...f.scope(), ledger: durableLedger() }), "explicit_resume_used");
});

it("the in-memory ledger refuses a new claim at capacity, keeps live claims and frees expired ones", () => {
  const ledger = wire.createExplicitResumeLedger();
  for (let i = 0; i < wire.MAX_EXPLICIT_RESUME_CLAIMS; i++) expect(ledger.claim(`live-${i}`, NOW + 10, NOW)).toBe(true);
  expect(() => ledger.claim("one-more", NOW + 10, NOW)).toThrowError(expect.objectContaining({ code: "explicit_resume_ledger_full" }));
  expect(ledger.claim("live-0", NOW + 10, NOW)).toBe(false);
  expect(ledger.claim("one-more", NOW + 20, NOW + 10)).toBe(true);
});

it("the in-memory ledger never forgets a claim for a caller whose clock is behind another caller's", () => {
  const ledger = wire.createExplicitResumeLedger();
  expect(ledger.claim("used", NOW + 10, NOW)).toBe(true);
  expect(ledger.claim("later", NOW + 100, NOW + 11)).toBe(true);
  expect(ledger.claim("used", NOW + 10, NOW + 5)).toBe(false);
});

it("the in-memory ledger refuses a proof that has expired by the latest clock it has seen, and does not hold it", () => {
  const ledger = wire.createExplicitResumeLedger();
  expect(ledger.claim("later", NOW + 100, NOW + 50)).toBe(true);
  expect(ledger.claim("stale", NOW + 40, NOW)).toBe(false);
  expect(ledger.claim("boundary", NOW + 50, NOW)).toBe(false);
  expect(ledger.claim("live", NOW + 51, NOW)).toBe(true);
});

it("a used proof is refused again when another verification with a later clock came between", async () => {
  const f = await fixture();
  const ledger = wire.createExplicitResumeLedger();
  const used = { ...f.payload, expiresAt: NOW + 10_000 };
  const other = { ...f.payload, nonce: Buffer.alloc(16, 10).toString("base64url") };
  const usedHeader = await signWith(f, used);
  expect(await wire.verifyExplicitCreateResume(usedHeader, { ...f.scope(), ledger })).toEqual(used);
  expect(await wire.verifyExplicitCreateResume(await signWith(f, other), { ...f.scope(), ledger, time: used.expiresAt + 1 })).toEqual(other);
  await refused(() => wire.verifyExplicitCreateResume(usedHeader, { ...f.scope(), ledger, time: used.expiresAt - 5 }), "explicit_resume_used");
});

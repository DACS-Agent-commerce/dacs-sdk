import * as wireValidate from "../../src/wire/validate.js";
import { expect, it } from "vitest";
import { canonicalize } from "../../src/canonical/jcs.js";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "../../src/crypto/ed25519.js";
import * as wire from "../../src/wire/index.js";
import { fixtureBinder } from "./authorityFixture.js";
import { BUYER, SELLER, BUYER_SEED, NOW, JOB } from "./committedPurchaseFixture.js";

const sessionPublicKey = Buffer.from(rawPublicKey(publicKeyFromSeed(Buffer.alloc(32, 43)))).toString("hex");
async function fixture() {
  const local = { endpoint: "https://rpc.delegation.invalid/", transportAuthority: "test", connectionId: "1" };
  const binding = await fixtureBinder(wire)({ record: wire.TP1_APPROVED_IDENTITY_RECORD, local });
  const payload: wire.SellerSessionDelegationPayload = { version: "1", kind: "seller-session-delegation", buyer: BUYER, seller: SELLER,
    sessionPublicKey, listingPin: { listingId: "delegation", version: 1, contentHash: "a".repeat(64) }, jobId: JOB,
    notBefore: NOW, expiresAt: NOW + 60_000, profile: binding.profile };
  const scope: wire.DelegationScope = { binding, local, buyer: BUYER, seller: SELLER, listingPin: payload.listingPin, jobId: JOB, time: NOW };
  const signer = { claim: BUYER, sign: (bytes: Uint8Array) => ed25519Sign(bytes, privateKeyFromSeed(BUYER_SEED)) };
  return { payload, scope, binding, local, signer };
}
function signed(payload: wire.SellerSessionDelegationPayload, domain: string = wire.DACS_SELLER_HTTP_DOMAINS.delegation) {
  return { payload, signature: Buffer.from(ed25519Sign(Buffer.from(domain + canonicalize(payload)), privateKeyFromSeed(BUYER_SEED))).toString("base64url") };
}
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));

it("requires received byte admission, including for duplicate members and rounded numbers", async () => {
  const f = await fixture(), document = signed(f.payload);
  await expect(Promise.resolve().then(() => wire.verifySellerSessionDelegation(document, f.scope)))
    .rejects.toMatchObject({ code: "peer_delegation_invalid", detail: "ARTIFACT-NOT-ADMITTED" });
  const admitted = wire.admitWireArtifact(bytes({ delegation: document }));
  if (!wireValidate.isRecord(admitted)) throw new Error("invalid admitted fixture");
  expect(await wire.verifySellerSessionDelegation(admitted.delegation, f.scope)).toEqual(f.payload);
  const duplicate = bytes(document).toString().replace(`"jobId":"${JOB}"`, `"jobId":"invalid","jobId":"${JOB}"`);
  await expect(Promise.resolve().then(() => wire.verifySellerSessionDelegation(Buffer.from(duplicate), f.scope)))
    .rejects.toMatchObject({ code: "peer_delegation_invalid", detail: "DUPLICATE-MEMBER" });
  f.payload.notBefore = Number.MAX_SAFE_INTEGER - 60_000;
  f.payload.expiresAt = Number.MAX_SAFE_INTEGER;
  const rounded = bytes(signed(f.payload)).toString().replace(String(Number.MAX_SAFE_INTEGER), "9007199254740991.1");
  await expect(Promise.resolve().then(() => wire.verifySellerSessionDelegation(Buffer.from(rounded), f.scope)))
    .rejects.toMatchObject({ code: "peer_delegation_invalid" });
});

it.each([BUYER, SELLER])("refuses a party-controlled session key at producer and receiver (%s)", async (party) => {
  const f = await fixture();
  f.payload.sessionPublicKey = wireValidate.claimKey(party);
  await expect(wire.signSellerSessionDelegation(f.payload, f.signer, f.binding, f.local)).rejects.toMatchObject({ code: "peer_delegation_invalid" });
  await expect(Promise.resolve().then(() => wire.verifySellerSessionDelegation(bytes(signed(f.payload)), f.scope)))
    .rejects.toMatchObject({ code: "peer_delegation_invalid" });
});

it("verifies independent signing bytes and refuses a wrong signature or signing domain", async () => {
  const f = await fixture();
  expect(await wire.sellerSessionDelegationSigningBytes(f.payload, f.binding, f.local))
    .toEqual(Buffer.from(wire.DACS_SELLER_HTTP_DOMAINS.delegation + canonicalize(f.payload)));
  expect(await wire.verifySellerSessionDelegation(bytes(signed(f.payload)), f.scope)).toEqual(f.payload);
  for (const document of [signed(f.payload, wire.DACS_SELLER_HTTP_DOMAINS.request), { ...signed(f.payload), signature: Buffer.alloc(64).toString("base64url") }]) {
    await expect(Promise.resolve().then(() => wire.verifySellerSessionDelegation(bytes(document), f.scope)))
      .rejects.toMatchObject({ code: "peer_delegation_signature_invalid" });
  }
});

it.each(["buyer", "seller", "jobId", "listingPin"] as const)("binds the delegation's %s to its authenticated scope", async (field) => {
  const f = await fixture();
  const scope = { ...f.scope, [field]: field === "listingPin" ? { ...f.payload.listingPin, version: 2 } : field === "jobId" ? "01J8ME0SXKQ4T9V2RC5HJ6WX7F" : `did:demos:agent:${"f".repeat(64)}` };
  await expect(Promise.resolve().then(() => wire.verifySellerSessionDelegation(bytes(signed(f.payload)), scope)))
    .rejects.toMatchObject({ code: "peer_delegation_mismatch" });
});

it("enforces notBefore, exclusive expiry, readback and Agreement deadline endpoints", async () => {
  const f = await fixture(), document = bytes(signed(f.payload));
  for (const time of [f.payload.notBefore, f.payload.expiresAt - 1]) expect(await wire.verifySellerSessionDelegation(document, { ...f.scope, time })).toEqual(f.payload);
  for (const time of [f.payload.notBefore - 1, f.payload.expiresAt]) {
    await expect(Promise.resolve().then(() => wire.verifySellerSessionDelegation(document, { ...f.scope, time })))
      .rejects.toMatchObject({ code: "peer_delegation_expired" });
  }
  expect(await wire.verifySellerSessionDelegation(document, { ...f.scope, time: f.payload.expiresAt, allowExpired: true })).toEqual(f.payload);
  await expect(Promise.resolve().then(() => wire.verifySellerSessionDelegation(document, { ...f.scope, time: f.payload.notBefore - 1, allowExpired: true })))
    .rejects.toMatchObject({ code: "peer_delegation_expired" });
  expect(await wire.verifySellerSessionDelegation(document, { ...f.scope, deadline: f.payload.expiresAt })).toEqual(f.payload);
  await expect(Promise.resolve().then(() => wire.verifySellerSessionDelegation(document, { ...f.scope, deadline: f.payload.expiresAt - 1 })))
    .rejects.toMatchObject({ code: "peer_delegation_deadline" });
});

it("permits exactly 24 hours, refusing a longer lifetime or a different profile revision", async () => {
  const f = await fixture();
  f.payload.expiresAt = f.payload.notBefore + 86_400_000;
  expect(await wire.verifySellerSessionDelegation(bytes(signed(f.payload)), f.scope)).toEqual(f.payload);
  f.payload.expiresAt++;
  await expect(Promise.resolve().then(() => wire.verifySellerSessionDelegation(bytes(signed(f.payload)), f.scope)))
    .rejects.toMatchObject({ code: "peer_delegation_invalid" });
  f.payload.expiresAt--;
  const document = signed(f.payload);
  Object.assign(document.payload, { profile: { ...f.payload.profile, revision: "TP-2" } });
  await expect(Promise.resolve().then(() => wire.verifySellerSessionDelegation(bytes(document), f.scope)))
    .rejects.toMatchObject({ code: "tp1_profile_revision_unknown" });
});

it.each(["seller", "jobId", "listingPin", "time"] as const)("refuses a scope without %s, so no scope check is skipped", async (field) => {
  const f = await fixture(), scope: Partial<wire.DelegationScope> = { ...f.scope };
  delete scope[field];
  await expect(Promise.resolve().then(() => wire.verifySellerSessionDelegation(bytes(signed(f.payload)), scope as wire.DelegationScope)))
    .rejects.toMatchObject({ code: "wire_input_invalid", status: 500 });
});

it.each(["buyer", "seller", "jobId", "listingPin", "time", "deadline", "allowExpired"] as const)("refuses a scope whose %s is undefined", async (field) => {
  const f = await fixture();
  await expect(Promise.resolve().then(() => wire.verifySellerSessionDelegation(bytes(signed(f.payload)), { ...f.scope, [field]: undefined })))
    .rejects.toMatchObject({ code: "wire_input_invalid", status: 500 });
});

it.each(["no", 0, null, 1])("refuses a non-boolean allowExpired (%s) even for a delegation that has expired", async (allowExpired) => {
  const f = await fixture();
  await expect(Promise.resolve().then(() => wire.verifySellerSessionDelegation(bytes(signed(f.payload)), { ...f.scope, time: f.payload.expiresAt, allowExpired: allowExpired as unknown as boolean })))
    .rejects.toMatchObject({ code: "wire_input_invalid", status: 500 });
});

it("verifies for readback without a clock only when allowExpired says so", async () => {
  const f = await fixture(), scope: Partial<wire.DelegationScope> = { ...f.scope, allowExpired: true };
  delete scope.time;
  expect(await wire.verifySellerSessionDelegation(bytes(signed(f.payload)), scope as wire.DelegationScope)).toEqual(f.payload);
});

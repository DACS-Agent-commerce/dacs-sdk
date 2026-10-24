import { describe, expect, it, vi } from "vitest";
import * as wire from "../../src/wire/index.js";
import { admitOutgoingBody, admitWireRequestBody, admitWireResponseBody, messageLifetime } from "../../src/wire/envelope.js";
import { admitWireJson, envelopeSignatureBytes, ownedFields, walletSignatureBytes } from "../../src/wire/validate.js";
import { canonicalize, sha256Hex } from "../../src/canonical/index.js";
import { alias, encodeHeader, NOW, wireWorld } from "./conformanceFixture.js";

const refuses = async (fn: () => unknown, code: string, status?: number) => await expect(Promise.resolve().then(fn)).rejects.toThrowError(expect.objectContaining({ code, ...(status ? { status } : {}) }));
describe("wire boundary regression cases", () => {
  it("primitive keys, positive intervals, inclusive 24h, and configured wallet identity", async () => {
    const x = await wireWorld();
    for (const patch of [{ sessionPublicKey: [x.session.raw] }, { expiresAt: x.delegation.notBefore }, { expiresAt: x.delegation.notBefore - 1 }]) {
      const p = { ...x.delegation, ...patch } as any;
      const before = x.reads();
      await refuses(async () => await wire.sellerSessionDelegationSigningBytes(p, x.binding, x.local), "peer_delegation_invalid", 500);
      await refuses(async () => await wire.verifySellerSessionDelegation(Buffer.from(JSON.stringify(x.signed(p, x.buyer, wire.DACS_SELLER_HTTP_DOMAINS.delegation))), x.delegationScope), "peer_delegation_invalid");
      expect(x.reads()).toBe(before);
    }
    const p = { ...x.delegation, expiresAt: x.delegation.notBefore + 86_400_000 };
    const d = await wire.signSellerSessionDelegation(p, x.buyer, x.binding, x.local);
    expect(await wire.verifySellerSessionDelegation(Buffer.from(JSON.stringify(d)), x.delegationScope)).toEqual(p);
    await refuses(async () => await wire.sellerSessionDelegationSigningBytes({ ...p, expiresAt: p.expiresAt + 1 }, x.binding, x.local), "peer_delegation_invalid");
    x.seller.calls = 0;
    await expect(wire.signSellerSessionDelegation(p, x.seller, x.binding, x.local)).rejects.toMatchObject({ code: "peer_delegation_invalid", status: 500 });
    expect(x.seller.calls).toBe(0);
  });
  it("unsupported kinds and nonce padding aliases fail hashing, signing and independently signed ingress", async () => {
    const x = await wireWorld();
    for (const p of [{ ...x.request, kind: "other" }, { ...x.request, nonce: alias(x.request.nonce) }]) {
      expect(wire.isWirePayload(p, p.kind as any)).toBe(false);
      await refuses(() => wire.wireEnvelopeSigningBytes(p as any), "peer_envelope_invalid");
      await refuses(() => wire.wireRequestHash(p as any), "peer_envelope_invalid");
      await expect(wire.signWireEnvelope(p as any, { ...x.input, purchaseProfile: x.binding.profile })).rejects.toMatchObject({ code: "peer_envelope_invalid" });
      await refuses(async () => await wire.openWireEnvelope(encodeHeader(x.signed(p)), "request", x.context), "peer_envelope_invalid");
    }
    expect(x.buyer.calls).toBe(0);
  });
  it("encoded header bounds and unused bits are enforced independently of decoded JSON size", async () => {
    const x = await wireWorld(), json = canonicalize(x.signed(x.request));
    const atLimit = Buffer.from(json.padEnd(3072, " ")).toString("base64url");
    expect(atLimit.length).toBe(4096);
    expect((await wire.openWireEnvelope(atLimit, "request", x.context)).payload).toEqual(x.request);
    const over = Buffer.from(json.padEnd(3073, " ")).toString("base64url");
    expect(Buffer.from(over, "base64url").length).toBeLessThan(4096);
    await refuses(async () => await wire.openWireEnvelope(over, "request", x.context), "peer_envelope_invalid");
    let padded = json;
    while (Buffer.byteLength(padded) % 3 !== 1) padded += " ";
    const canonical = Buffer.from(padded).toString("base64url"), noncanonical = alias(canonical);
    expect(Buffer.from(noncanonical, "base64url")).toEqual(Buffer.from(canonical, "base64url"));
    await refuses(async () => await wire.openWireEnvelope(noncanonical, "request", x.context), "peer_envelope_invalid");
  });
  it("hashes, claims and every exact positive-version pin are primitive wire values", async () => {
    const x = await wireWorld();
    const pins = [{ ...x.pin, extra: true }, { ...x.pin, listingId: [x.pin.listingId] }, { ...x.pin, version: 0 }];
    const patches = [{ bodyHash: [x.request.bodyHash] }, { buyer: [x.buyer.claim] }, ...pins.map((listingPin) => ({ listingPin }))];
    for (const patch of patches) {
      const p = { ...x.request, ...patch } as any;
      expect(wire.isWirePayload(p, "request")).toBe(false);
      await expect(wire.signWireEnvelope(p, { ...x.input, purchaseProfile: x.binding.profile })).rejects.toMatchObject({ code: "peer_envelope_invalid" });
      await refuses(async () => await wire.openWireEnvelope(encodeHeader(x.signed(p)), "request", x.context), "peer_envelope_invalid");
    }
    for (const listingPin of pins) {
      const p = { ...x.delegation, listingPin } as any;
      await expect(wire.signSellerSessionDelegation(p, x.buyer, x.binding, x.local)).rejects.toMatchObject({ code: "peer_delegation_invalid" });
      await refuses(async () => await wire.verifySellerSessionDelegation(Buffer.from(JSON.stringify(x.signed(p, x.buyer, wire.DACS_SELLER_HTTP_DOMAINS.delegation))), x.delegationScope), "peer_delegation_invalid");
      const d = { ...x.discovery, listings: [x.pin, listingPin] } as any;
      await expect(wire.signDiscoveryDocument(d, x.seller, x.binding, x.local)).rejects.toMatchObject({ code: "discovery_invalid" });
      await refuses(async () => await wire.verifyEndpointProof(x.document(d), x.options), "discovery_invalid");
    }
    for (const patch of [{ seller: [x.seller.claim] }, { listings: [{ ...x.pin, contentHash: [x.pin.contentHash] }] }]) {
      const d = { ...x.discovery, ...patch } as any;
      await expect(wire.signDiscoveryDocument(d, x.seller, x.binding, x.local)).rejects.toMatchObject({ code: "seller" in patch ? "discovery_signer_wrong" : "discovery_invalid" });
      await refuses(async () => await wire.verifyEndpointProof(x.document(d), x.options), "discovery_invalid");
    }
    expect(x.buyer.calls + x.seller.calls).toBe(0);
  });
  it("canonical signatures at public producers and receivers, including wallet encodings", async () => {
    const x = await wireWorld();
    const e = x.signed(x.request), d = x.signed(x.delegation, x.buyer, wire.DACS_SELLER_HTTP_DOMAINS.delegation);
    for (const signature of [alias(e.signature), Buffer.from(e.signature, "base64url").toString("hex") + "junk", "junk" + Buffer.from(e.signature, "base64url").toString("hex")]) {
      await refuses(async () => await wire.openWireEnvelope(encodeHeader({ ...e, signature }), "request", x.context), "peer_signature_invalid");
      await expect(wire.signWireEnvelope(x.request, { ...x.input, signer: { claim: x.buyer.claim, sign: () => signature }, purchaseProfile: x.binding.profile })).rejects.toMatchObject({ code: "peer_signature_invalid" });
    }
    const hex = Buffer.from(d.signature, "base64url").toString("hex");
    const inserted = d.signature.slice(0, 12) + "0x" + d.signature.slice(12);
    for (const signature of [alias(d.signature), inserted, hex + "junk", "junk" + hex]) {
      await refuses(async () => await wire.verifySellerSessionDelegation(Buffer.from(JSON.stringify({ ...d, signature })), x.delegationScope), "peer_delegation_signature_invalid");
      await expect(wire.signSellerSessionDelegation(x.delegation, { claim: x.buyer.claim, sign: () => signature }, x.binding, x.local)).rejects.toMatchObject({ code: "peer_delegation_signature_invalid" });
    }
    expect(walletSignatureBytes(d.signature)).toEqual(Buffer.from(d.signature, "base64url"));
    expect(envelopeSignatureBytes(e.signature)).toEqual(Buffer.from(e.signature, "base64url"));
  });
  it("public raw JSON byte bounds, null artifacts and primitive shape predicates", async () => {
    const x = await wireWorld(), text = '{"x":1}', bytes = Buffer.from(text);
    expect(admitWireJson(bytes, bytes.length, "limited")).toEqual({ x: 1 });
    await refuses(() => admitWireJson(Buffer.from(text + " "), bytes.length, "limited"), "limited");
    for (const [admit, max] of [[admitWireRequestBody, wire.DACS_SELLER_HTTP_LIMITS.maxRequestBodyBytes], [admitWireResponseBody, wire.DACS_SELLER_HTTP_LIMITS.maxResponseBodyBytes]] as const) {
      const exact = Buffer.from(text.padEnd(max, " "));
      expect(admit(exact)).toEqual({ x: 1 });
      expect(() => admit(Buffer.concat([exact, Buffer.from(" ")]))).toThrow();
    }
    expect(admitOutgoingBody(text, bytes.length)).toEqual(bytes);
    expect(() => admitOutgoingBody(text + " ", bytes.length)).toThrow();
    for (const v of [null, undefined]) expect(wire.isPublicEndpoint(v)).toBe(false);
    expect(wire.isWirePayload({ ...x.request, seller: x.buyer.claim }, "request")).toBe(false);
    for (const patch of [{ base: [x.binding.profile.base] }, { chainIdentity: [x.binding.profile.chainIdentity] }, { base: "x" + x.binding.profile.base }, { base: x.binding.profile.base + "x" }]) {
      expect(wire.isTp1WireProfile({ ...x.binding.profile, ...patch })).toBe(false);
    }
    const nullOptions = Object.assign(Object.create(null), { field: 1 });
    expect(ownedFields(nullOptions, ["field"])).toEqual({ field: 1 });
    const inherited = Object.create({ get hidden() { throw new Error("must not read"); } });
    inherited.field = 1;
    await refuses(() => ownedFields(inherited, ["field", "hidden"]), "wire_input_invalid", 500);
    await expect(Promise.resolve().then(async () => await wire.bindTp1Profile({ record: wire.TP1_APPROVED_IDENTITY_RECORD, local: x.local, refusedChainIdentities: {}, readAuthority: () => null } as any))).rejects.toThrowError(expect.objectContaining({ code: "wire_input_invalid" }));
  });
  it("delegated authentication hashes include normalized payload and signature across accepted encodings", async () => {
    const x = await wireWorld();
    const d = await wire.signSellerSessionDelegation(x.delegation, x.buyer, x.binding, x.local);
    const signed = x.signed(x.request, x.session);
    const normalized = { ...signed, delegation: d };
    const expected = sha256Hex(encodeHeader(normalized));
    for (const signature of [d.signature, Buffer.from(d.signature, "base64url").toString("hex"), "0x0x" + Buffer.from(d.signature, "base64url").toString("hex")]) {
      const opened = await wire.openWireEnvelope(encodeHeader({ ...signed, delegation: { ...d, signature } }), "request", x.context);
      expect(opened.authenticationHash).toBe(expected);
    }
  });
  it("oversized raw signatures are refused before copying their bytes", async () => {
    const oversized = new Uint8Array(65);
    let copies = 0;
    const Original = Uint8Array;
    vi.stubGlobal("Uint8Array", new Proxy(Original, { construct(target, args) {
      if (args[0] === oversized) copies++;
      return Reflect.construct(target, args);
    } }));
    try {
      await refuses(() => envelopeSignatureBytes(oversized), "peer_signature_invalid");
      expect(copies).toBe(0);
    } finally { vi.unstubAllGlobals(); }
  });
});
it("the producer includes signature bytes in the inclusive 4096-character header budget", async () => {
  const x = await wireWorld();
  const d = await wire.signSellerSessionDelegation(x.delegation, x.buyer, x.binding, x.local);
  const signed = x.signed(x.request, x.session);
  const unpadded = Buffer.byteLength(canonicalize({ ...signed, delegation: d }));
  const padded = { ...d, signature: " ".repeat(3072 - unpadded) + d.signature };
  x.session.calls = 0;
  const ctx = { ...x.input, signer: x.session, purchaseProfile: x.binding.profile };
  const header = await wire.signWireEnvelope(x.request, ctx, padded);
  expect(header.length).toBe(4096);
  expect((await wire.openWireEnvelope(header, "request", x.context)).payload).toEqual(x.request);
  x.session.calls = 0;
  const over = { ...padded, signature: " " + padded.signature };
  expect(encodeHeader({ payload: x.request, signature: "", delegation: over }).length).toBeLessThan(4096);
  await expect(wire.signWireEnvelope(x.request, ctx, over)).rejects.toMatchObject({ code: "peer_envelope_too_large", status: 500 });
  expect(x.session.calls).toBe(0);
});

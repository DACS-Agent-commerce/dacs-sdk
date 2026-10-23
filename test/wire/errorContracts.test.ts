import { expect, it, vi } from "vitest";
import * as wire from "../../src/wire/index.js";
import { journalDirectory } from "./requestJournalFixture.js";
import { NOW, wireWorld } from "./conformanceFixture.js";

it("malformed local payloads retain WireError contracts and never call a signer", async () => {
  const x = wireWorld();
  expect(() => wire.wireEnvelopeSigningBytes(null as any)).toThrowError(expect.objectContaining({ code: "peer_envelope_invalid" }));
  await expect(wire.signWireEnvelope(null as any, { ...x.context, signer: x.buyer })).rejects.toMatchObject({ code: "peer_envelope_invalid", status: 500 });
  await expect(wire.signSellerSessionDelegation(null as any, x.buyer, x.binding, x.local)).rejects.toBeInstanceOf(wire.WireError);
  await expect(wire.signDiscoveryDocument(null as any, x.seller, x.binding, x.local)).rejects.toBeInstanceOf(wire.WireError);
  await expect(wire.signWireRequest({ ...x.input, job: null } as any)).rejects.toBeInstanceOf(wire.WireError);
  expect(() => wire.verifyWireResponse(null as any, { ...x.context, header: "", status: 200, body: Buffer.from("{}"), now: NOW })).toThrowError(expect.any(wire.WireError));
  expect(x.buyer.calls + x.seller.calls).toBe(0);
});
it("signature decoding retains discovery-specific diagnostics at producer and receiver", async () => {
  const x = wireWorld();
  const d = JSON.parse(x.document().toString()); d.signature = "malformed";
  expect(() => wire.verifyEndpointProof(Buffer.from(JSON.stringify(d)), x.options)).toThrowError(expect.objectContaining({ code: "discovery_signature_invalid" }));
  await expect(wire.signDiscoveryDocument(x.discovery, { claim: x.seller.claim, sign: () => "malformed" }, x.binding, x.local)).rejects.toMatchObject({ code: "discovery_signature_invalid" });
});
it("direct public authority/profile checks keep their binding and missing-profile diagnostics", () => {
  const x = wireWorld();
  for (const [invoke, code] of [
    [() => wire.assertTp1Authority({ ...x.binding }, x.local, [], null), "tp1_binding_required"],
    [() => wire.assertTp1Authority(x.binding, { ...x.local, connectionId: "changed" }, [], null), "tp1_local_binding_changed"],
    [() => wire.assertPeerProfile(undefined, x.binding), "tp1_profile_missing"],
    [() => wire.assertPurchaseProfile(x.binding.profile, { ...x.binding }), "tp1_binding_required"],
  ] as const) expect(invoke).toThrowError(expect.objectContaining({ code }));
  expect(() => wire.bindTp1Profile({ record: { ...wire.TP1_APPROVED_IDENTITY_RECORD, pinVersion: null }, local: x.local, readAuthority: () => null } as any)).toThrowError(expect.objectContaining({ code: "tp1_identity_pin_missing" }));
  expect(() => wire.bindTp1Profile({ record: wire.TP1_APPROVED_IDENTITY_RECORD, local: x.local, readAuthority: () => ({}) } as any)).toThrowError(expect.objectContaining({ code: "tp1_connection_unverified" }));
});
it("journal platform and option errors remain explicit", () => {
  const directory = journalDirectory();
  for (const options of [{ leaseMs: 0 }, { clock: 1 }]) expect(() => wire.openWireRequestJournal(directory, options as any))
    .toThrowError(expect.objectContaining({ code: "seller_configuration_invalid", detail: "JOURNAL-OPTIONS" }));
  const spy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  try { expect(() => wire.openWireRequestJournal(directory)).toThrowError(expect.objectContaining({ code: "seller_replay_guard_invalid", detail: "PLATFORM-UNSUPPORTED" })); }
  finally { spy.mockRestore(); }
});
it("raw body and artifact option failures retain local input diagnostics", async () => {
  const x = wireWorld();
  const { encodeHeader } = await import("./conformanceFixture.js");
  const opened = wire.openWireEnvelope(encodeHeader(x.signed(x.request)), "request", x.context);
  for (const patch of [{ artifacts: {} }, { rawBody: "{}" }]) expect(() => wire.checkWireRequest(opened, { ...x.context,
    seller: x.seller.claim, listingPin: x.pin, method: "POST", path: x.request.path, rawBody: Buffer.from("{}"), now: NOW,
    retained: { jobId: x.request.jobId, agreementHash: x.request.agreementHash, buyer: x.buyer.claim, seller: x.seller.claim }, ...patch } as any))
    .toThrowError(expect.objectContaining({ code: "wire_input_invalid", status: 500 }));
  expect(() => wire.verifyWireResponse(x.request, { ...x.context, status: 200, header: "", now: NOW, body: "{}" } as any))
    .toThrowError(expect.objectContaining({ code: "wire_input_invalid", status: 500 }));
  await expect(wire.signWireRequest({ ...x.input, seller: x.buyer.claim })).rejects.toThrow("buyer transport configuration is invalid");
  expect(x.buyer.calls).toBe(0);
  expect(() => wire.bindTp1Profile({ record: wire.TP1_APPROVED_IDENTITY_RECORD, local: x.local,
    refusedChainIdentities: Object.create({ inherited: true }), readAuthority: () => null } as any))
    .toThrowError(expect.objectContaining({ code: "wire_input_invalid" }));
  expect(() => wire.bindTp1Profile({ record: 1, local: x.local, readAuthority: () => null } as any))
    .toThrowError(expect.objectContaining({ code: "tp1_identity_record_invalid" }));
});

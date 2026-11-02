import { expect, it } from "vitest";
import * as wire from "../../src/wire/index.js";
import { sha256Hex } from "../../src/canonical/hash.js";
import { wireWorld } from "./conformanceFixture.js";

it("keeps the original trusted-reader refusal and its cause when converting a local delegation error", async () => {
  const x = await wireWorld();
  const delegation = await wire.signSellerSessionDelegation(x.delegation, x.buyer, x.binding, x.local);
  const originalCause = new Error("transport deadline exceeded");
  const readerError = new wire.WireError("reader_timeout", 408, "receipt authority", originalCause);
  x.failAuthority(readerError);
  await expect(wire.signWireRequest({ ...x.input, signer: x.session, delegation }))
    .rejects.toMatchObject({ code: "reader_timeout", status: 500, detail: "receipt authority", cause: readerError });
  expect(readerError.cause).toBe(originalCause);
});

async function responseFixture() {
  const x = await wireWorld();
  const { payload: request } = await wire.signWireRequest({ ...x.input, nonce: x.request.nonce });
  const text = '{"ok":true}';
  const header = await wire.signWireResponse(request, 200, text, { ...x.context, signer: x.seller, now: x.options.now });
  const received: wire.ReceivedWireResponse = { header, status: 200, body: Buffer.from(text), now: x.options.now, binding: x.binding, local: x.local };
  return { x, request, text, received };
}

it("binds a response to the exact received JSON body bytes", async () => {
  const f = await responseFixture();
  expect((await wire.verifyWireResponse(f.request, f.received)).body).toEqual({ ok: true });
  await expect(Promise.resolve().then(() => wire.verifyWireResponse(f.request, { ...f.received, body: Buffer.from('{"forged":true}') })))
    .rejects.toMatchObject({ code: "peer_response_mismatch" });
});

it("binds the signed response status to the received HTTP status", async () => {
  const f = await responseFixture();
  await expect(Promise.resolve().then(() => wire.verifyWireResponse(f.request, { ...f.received, status: 201 })))
    .rejects.toMatchObject({ code: "peer_response_mismatch" });
});

it("requires the seller-signed request hash to match the buyer's retained request", async () => {
  const f = await responseFixture();
  const payload: wire.WireResponsePayload = { ...f.request, kind: "response", status: 200, bodyHash: sha256Hex(f.text),
    expiresAt: f.x.options.now + 30_000, requestHash: "f".repeat(64) };
  const header = await wire.signWireEnvelope(payload, { ...f.x.context, signer: f.x.seller });
  await expect(Promise.resolve().then(() => wire.verifyWireResponse(f.request, { ...f.received, header })))
    .rejects.toMatchObject({ code: "peer_response_mismatch" });
});

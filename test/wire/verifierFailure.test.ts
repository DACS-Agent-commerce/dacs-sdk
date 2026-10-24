import { expect, it, vi } from "vitest";
const injection = vi.hoisted(() => ({ fail: false }));
vi.mock("../../src/crypto/ed25519.js", async (original) => {
  const crypto = await original<typeof import("../../src/crypto/ed25519.js")>();
  return { ...crypto, ed25519Verify: (...args: Parameters<typeof crypto.ed25519Verify>) => {
    if (injection.fail) throw new Error("injected verifier failure");
    return crypto.ed25519Verify(...args);
  } };
});
import * as wire from "../../src/wire/index.js";
import { encodeHeader, wireWorld } from "./conformanceFixture.js";
it("verifier exceptions refuse otherwise valid envelopes, delegations and discovery", async () => {
  const x = await wireWorld(), header = encodeHeader(x.signed(x.request));
  const delegation = x.signed(x.delegation, x.buyer, wire.DACS_SELLER_HTTP_DOMAINS.delegation), discovery = x.document();
  expect((await wire.openWireEnvelope(header, "request", x.context)).payload).toEqual(x.request);
  expect(await wire.verifySellerSessionDelegation(Buffer.from(JSON.stringify(delegation)), x.delegationScope)).toEqual(x.delegation);
  expect((await wire.verifyEndpointProof(discovery, x.options)).ready).toBe(true);
  injection.fail = true;
  try {
    for (const [invoke, code] of [
      [async () => await wire.openWireEnvelope(header, "request", x.context), "peer_signature_invalid"],
      [async () => await wire.verifySellerSessionDelegation(Buffer.from(JSON.stringify(delegation)), x.delegationScope), "peer_delegation_signature_invalid"],
      [async () => await wire.verifyEndpointProof(discovery, x.options), "discovery_signature_invalid"],
    ] as const) await expect(Promise.resolve().then(async () => { await invoke(); })).rejects.toThrowError(expect.objectContaining({ code }));
  } finally { injection.fail = false; }
});

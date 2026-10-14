import { expect, it } from "vitest";

import { parseCciRecord } from "../../src/identity/cci.js";
import { DemosAdapter } from "../../src/substrate/index.js";

// Opt-in live check of the raw CCI transport against a real Demos node. It sends
// one unauthenticated getIdentities read and no transaction. Use an address that
// already has a GCR account: the node creates an account for an unknown address.
const rpc = process.env.DACS_DEMOS_CCI_LIVE_RPC;
const address = process.env.DACS_DEMOS_CCI_LIVE_ADDRESS;

it.skipIf(!rpc || !address)("reads an existing account's GCR identities from a live node", async () => {
  const adapter = new DemosAdapter({ rpc: rpc! });
  await adapter.connect();
  const resolved = await adapter.resolveIdentity(address!);
  expect(resolved).toMatchObject({ ref: address, boundTo: address });
  expect(resolved.raw).toMatchObject({ result: 200 });
  expect(() => parseCciRecord(`did:demos:agent:${"00".repeat(32)}`, resolved.raw)).not.toThrow();
}, 30_000);

// Purchase fixtures obtain a real endpoint proof. No production gate is mocked.
import {
  signWireRequest, signDiscoveryDocument, verifyEndpointProof, TP1_CAPABILITIES, WireError,
  type WireRequestInput, type WireSigner,
} from "../../src/wire/index.js";

const sellers = new Map<string, WireSigner>();
export function registerDiscoverySigner(signer: WireSigner): void { sellers.set(signer.claim, signer); }
export const FIXTURE_ENDPOINT = "https://seller.proof-fixture.invalid";
export async function signRequestWithProof(input: Omit<WireRequestInput, "endpointProof" | "publicEndpoint"> & Partial<Pick<WireRequestInput, "endpointProof" | "publicEndpoint">>, document?: Uint8Array) {
  // Keep the earlier admission tests on the real entry point, including its
  // refusal order and data-only checks. Only fill a missing purchase fixture.
  try { return await signWireRequest(input as WireRequestInput); }
  catch (error) { if (!(error instanceof WireError) || error.code !== "endpoint_proof_required") throw error; }
  const seller = sellers.get(input.seller);
  if (!document && !seller) throw new Error("register the fixture's discovery signer");
  const publicEndpoint = input.publicEndpoint ?? FIXTURE_ENDPOINT;
  const bytes = document ?? await signDiscoveryDocument({
    format: "dacs-seller-discovery/v1", profile: input.binding.profile, seller: input.seller,
    publicEndpoint, transport: ["dacs-seller-http/v1"], listings: [input.job.listingPin],
    capabilities: TP1_CAPABILITIES, ready: true, issuedAt: input.now, expiresAt: input.now + 60_000,
  }, seller!, input.binding, input.local);
  const endpointProof = verifyEndpointProof(bytes, {
    listing: { seller: input.seller, publicEndpoint, listingPin: input.job.listingPin },
    binding: input.binding, local: input.local, now: input.now,
  });
  return signWireRequest({ ...input, endpointProof, publicEndpoint });
}

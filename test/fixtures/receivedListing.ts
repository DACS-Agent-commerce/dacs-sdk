import { types as nodeTypes } from "node:util";
import { discoverListings, type DiscoverDeps } from "../../src/agent/discover.js";
import { runSessionCore } from "../../src/agent/runSessionCore.js";
import type { ListingValidationDeps } from "../../src/agent/listingValidation.js";
import { validateListingArtifact } from "../../src/agent/listingValidation.js";
import { snapshotCanonicalJsonReceived } from "../../src/canonical/snapshot.js";

/** Encode locally constructed fixtures. Never use this to repair a transport read. */
export function validateFixtureListingArtifact(
  raw: Record<string, unknown> | Uint8Array,
  deps: ListingValidationDeps,
) {
  deps = simulationDeps(deps);
  if (raw instanceof Uint8Array) return validateListingArtifact(raw, deps);
  let bytes: Uint8Array;
  try {
    bytes = Buffer.from(JSON.stringify(snapshotCanonicalJsonReceived(raw, "Listing fixture")));
  } catch {
    bytes = Buffer.from("null");
  }
  return validateListingArtifact(bytes, deps);
}

/** Lossless transport for a locally authored normative Listing fixture. */
export function fixtureListingRead<T>(value: T): T | Uint8Array {
  if (value && typeof value === "object" && !nodeTypes.isProxy(value) && "dacsVersion" in value) {
    try {
      return Buffer.from(JSON.stringify(snapshotCanonicalJsonReceived(value, "Listing fixture")));
    } catch {
      // Preserve malformed inputs for the receiving boundary's own refusal.
    }
  }
  return value;
}

export function simulationDeps<T extends object>(deps: T): T & { executionMode: "simulation" } {
  if (nodeTypes.isProxy(deps)) return deps as T & { executionMode: "simulation" };
  const descriptors = Object.getOwnPropertyDescriptors(deps);
  delete descriptors.executionMode;
  const copy = Object.create(Object.getPrototypeOf(deps), descriptors);
  Object.defineProperty(copy, "executionMode", { value: "simulation", enumerable: true });
  return copy;
}

export function discoverFixtureListings(
  refs: Parameters<typeof discoverListings>[0],
  read: Parameters<typeof discoverListings>[1],
  deps: DiscoverDeps = {},
) {
  return discoverListings(refs, nodeTypes.isProxy(read) ? read :
    async (ref) => fixtureListingRead(await read(ref)), simulationDeps(deps));
}

export function runFixtureSessionCore(...args: Parameters<typeof runSessionCore>) {
  const original = args[2];
  if (nodeTypes.isProxy(original)) return runSessionCore(...args);
  const deps = Object.isExtensible(original) ? original : simulationDeps(original);
  if (!("executionMode" in deps)) {
    Object.defineProperty(deps, "executionMode", { value: "simulation", enumerable: true });
  }
  const descriptor = Object.getOwnPropertyDescriptor(deps, "readListing");
  if (descriptor && "value" in descriptor && typeof descriptor.value === "function" && descriptor.configurable) {
    const read = descriptor.value;
    Object.defineProperty(deps, "readListing", { ...descriptor,
      value: async (ref: string) => fixtureListingRead(await Reflect.apply(read, original, [ref])) });
  }
  return runSessionCore(args[0], args[1], deps, args[3]);
}

/** Full ordered admission for locally authored seller historical fixtures. */
export async function admitFixtureListing(listing: import("../../src/artifacts/types.js").Listing) {
  const result = await validateFixtureListingArtifact(listing as unknown as Record<string, unknown>, {
    executionMode: "simulation",
    nowMs: () => listing.validity.notBefore,
    verifyListingSignature: () => true,
    verifyIdentityPresentation: () => true,
    verifySellerControl: () => true,
    resolvePayloadVerificationCapability: () => ({ disposition: "supported" }),
    revocation: { surfaces: [{ kind: "well-known", status: "active", integrity: "verified" }],
      readMarker: async () => null, verifyMarkerSignature: () => true },
    loadRailResolution: () => ({
      trustPhase: "PA-1", trustPolicyAcceptsPA1: true,
      registry: { state: "not-used", entries: [], definitions: [] },
      inCodeDefinitions: (listing.acceptedRails ?? []).map((rail) => ({
        railId: rail.railId, railVersion: rail.railVersion ?? 1,
        phaseHandler: listing.pipeline.find((phase) => phase.kind.startsWith("pay-"))!.kind,
        governanceAnchoring: "in-code" as const, signatureValid: true as const,
      })),
    }),
  });
  if (result.disposition !== "verified") throw new Error(`fixture admission failed: ${result.reason}`);
  return result;
}

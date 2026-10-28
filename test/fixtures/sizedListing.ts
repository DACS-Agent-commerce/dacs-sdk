import type { Listing } from "../../src/artifacts/types.js";
import { canonicalize, contentHash } from "../../src/canonical/index.js";
import {
  ed25519Sign,
  ed25519Verify,
  privateKeyFromSeed,
  publicKeyFromSeed,
  signedBytes,
} from "../../src/crypto/index.js";

const seed = Uint8Array.from(Buffer.alloc(32, 47));

/** A valid signature and multibyte padding at an exact canonical UTF-8 size. */
export function sizedListing(input: Listing, bytes: number): Listing {
  const listing = structuredClone(input) as Listing & { padding: string };
  listing.signature.value = Buffer.alloc(64).toString("base64url");
  listing.padding = "é";
  const remaining = bytes - Buffer.byteLength(canonicalize(listing), "utf8");
  listing.padding += "x".repeat(remaining);
  listing.signature.value = Buffer.from(ed25519Sign(
    signedBytes("dacs-listing:v1:", contentHash(listing as unknown as Record<string, unknown>)),
    privateKeyFromSeed(seed),
  )).toString("base64url");
  return listing;
}

export function verifySizedListingSignature(input: {
  signedBytes: Uint8Array;
  signature: { value: string };
}): boolean {
  return ed25519Verify(
    input.signedBytes,
    Buffer.from(input.signature.value, "base64url"),
    publicKeyFromSeed(seed),
  );
}

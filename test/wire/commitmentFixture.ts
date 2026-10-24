import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "../../src/crypto/ed25519.js";

/** A party whose one key signs its Agreement, its commitment record or its wire messages; `calls` counts wire signatures. */
export function seededParty(byte: number) {
  const seed = Uint8Array.from(Buffer.alloc(32, byte));
  const key = publicKeyFromSeed(seed);
  const raw = Buffer.from(rawPublicKey(key)).toString("hex");
  const signBytes = (bytes: Uint8Array) => ed25519Sign(bytes, privateKeyFromSeed(seed));
  return { raw, claim: `did:demos:agent:${raw}`, key, signBytes, calls: 0, sign(bytes: Uint8Array) { this.calls++; return signBytes(bytes); } };
}

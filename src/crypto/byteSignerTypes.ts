/** Signs raw bytes, returning the signature bytes (e.g. wired to the wallet). */
export type Signer = (bytes: Uint8Array) => Promise<Uint8Array> | Uint8Array;

/** Verifies a signature over raw bytes for a given public key. */
export type Verifier = (
  bytes: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
) => Promise<boolean> | boolean;

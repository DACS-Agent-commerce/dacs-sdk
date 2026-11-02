// Shared helpers for the dacs-seller-http/v1 fixture and vector generators.
// Keys are generated at run time and discarded: generated files hold public
// keys and signatures only. The TP-1 identity record here is SYNTHETIC: it is
// not the approved record and not a Demos chain identity.
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { writeFileSync } from "node:fs";

/** Fixed clock for every generated case: 2026-10-14T12:00:00Z. */
export const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
export const HOUR = 3_600_000;
export const JOB_ID = "01K7FZ8Q9W3V5T2R1N0M8K6J4H";
export const OTHER_JOB_ID = "01K7FZ8Q9W3V5T2R1N0M8K6J4J";
export const NONCE = Buffer.from(Array.from({ length: 24 }, (_, i) => i)).toString("base64url");
export const sha256Hex = (input) => createHash("sha256").update(input).digest("hex");
export const LISTING_PIN = Object.freeze({ listingId: "wire-fixture-report", version: 1, contentHash: sha256Hex("wire-fixture-listing") });
export const AGREEMENT_HASH = sha256Hex("wire-fixture-agreement");
export const PUBLIC_ENDPOINT = "https://seller.wire-fixture.invalid";
export const LOCAL_A = Object.freeze({ endpoint: "https://rpc-a.wire-fixture.invalid/", transportAuthority: "test-transport-a", connectionId: "conn-a-1" });
export const LOCAL_B = Object.freeze({ endpoint: "https://rpc-b.wire-fixture.invalid/", transportAuthority: "test-transport-b", connectionId: "conn-b-1" });

/** An Ed25519 test party; the private key never leaves this process. */
export function party() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const claim = `did:demos:agent:${raw}`;
  return { claim, raw, signer: { claim, sign: (bytes) => new Uint8Array(sign(null, Buffer.from(bytes), privateKey)) } };
}

/** A synthetic, test-only TP-1 identity record. Never the approved record. */
export function syntheticIdentityRecord(label = "synthetic-testnet") {
  const nonce = randomBytes(16).toString("hex");
  return {
    format: "dacs-testnet-identity-record/v1",
    recordId: `synthetic-test-only/${label}/${nonce.slice(0, 8)}`,
    network: "demos-testnet",
    chainIdentity: sha256Hex(`dacs-sdk/wire-test/SYNTHETIC/${label}/${nonce}`),
    pinVersion: "synthetic-test-only/1",
    provenance: {
      approvedBy: "SYNTHETIC test generator; approves nothing outside tests",
      approvedAt: new Date(NOW).toISOString(),
      source: "generated at run time; not a Demos chain identity",
    },
  };
}

export const canonicalBase64 = (text) => Buffer.from(text, "utf8").toString("base64url");

export function writeJson(path, value, { exclusive = false } = {}) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: exclusive ? "wx" : "w", mode: 0o644 });
}

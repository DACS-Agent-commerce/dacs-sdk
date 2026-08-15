import {
  ed25519Sign,
  privateKeyFromSeed,
  publicKeyFromSeed,
  rawPublicKey,
} from "@kynesyslabs/dacs/crypto";
import { canonicalize } from "@kynesyslabs/dacs/canonical";
import { describe, expect, it, vi } from "vitest";

import vectorDocument from "../vectors/dacs-http-envelope-v1.json" with { type: "json" };

import {
  authenticateDacsHttpEnvelopeV1,
  createDacsHttpAcknowledgementEnvelopeV1,
  createDacsHttpEnvelopeV1,
  dacsHttpEnvelopeHashV1,
  dacsHttpEnvelopeSignedBytesV1,
  paymentEvidencePeerFromDacsHttpEnvelopeV1,
  verifyDacsHttpAcknowledgementBindingV1,
  type DacsHttpAuthenticatedEnvelopeV1,
  type DacsHttpEnvelopeCreateInput,
  type DacsHttpEnvelopeV1,
  type DacsHttpMessageType,
} from "../src/transport/index.js";

const JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ISSUED_AT = 1_800_000_000_000;
const EXPIRES_AT = ISSUED_AT + 300_000;
const IDENTITY_EVIDENCE_HASH = "c".repeat(64);
const SEED = Uint8Array.from({ length: 32 }, (_, index) => index);
const PRIVATE_KEY = privateKeyFromSeed(SEED);
const PUBLIC_KEY = rawPublicKey(publicKeyFromSeed(SEED));
const AUDIENCE_SEED = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
const AUDIENCE_PRIVATE_KEY = privateKeyFromSeed(AUDIENCE_SEED);
const AUDIENCE_PUBLIC_KEY = rawPublicKey(publicKeyFromSeed(AUDIENCE_SEED));
const SENDER_KEY_HEX = Buffer.from(PUBLIC_KEY).toString("hex");
const SENDER = `did:demos:agent:${SENDER_KEY_HEX}`;
const AUDIENCE = `did:demos:agent:${Buffer.from(AUDIENCE_PUBLIC_KEY).toString("hex")}`;

const PAYLOADS: Readonly<Record<DacsHttpMessageType, unknown>> = Object.freeze({
  "agreement-proposal": {
    transportIdentity: { sender: SENDER, audience: AUDIENCE },
    proposal: { jobId: JOB_ID, label: "Café", numericEdge: Number.MAX_SAFE_INTEGER },
  },
  "agreement-response": {
    responseVersion: "vector",
    accepted: true,
    note: "键顺序",
  },
  "payment-evidence-request": {
    messageId: "request-vector",
    requestHash: "1".repeat(64),
    jobId: JOB_ID,
    seller: SENDER,
    buyer: AUDIENCE,
  },
  "payment-evidence-completion": {
    messageId: "completion-vector",
    completionHash: "2".repeat(64),
    jobId: JOB_ID,
    buyer: SENDER,
  },
  "bundle-signature-request": {
    bundleContentHash: "3".repeat(64),
    signedScope: { z: 0, a: "Å" },
    signedBytes: "AQID",
    requiredCounterSigners: [AUDIENCE],
  },
  "bundle-signature-response": {
    party: SENDER,
    algorithm: "ed25519",
    signature: "vector-signature",
  },
  acknowledgement: {
    acknowledgedEnvelopeId: "4".repeat(64),
    acknowledgedPayloadHash: "5".repeat(64),
    disposition: "accepted",
  },
});

function roleFor(type: DacsHttpMessageType): "buyer" | "seller" {
  return type === "agreement-response" || type === "payment-evidence-request" ||
      type === "bundle-signature-request" ? "seller" : "buyer";
}

function nonce(index: number): string {
  return Buffer.alloc(32, index + 1).toString("base64url");
}

async function createVectorEnvelope(
  type: DacsHttpMessageType,
  index: number,
): Promise<Readonly<DacsHttpEnvelopeV1>> {
  return createDacsHttpEnvelopeV1({
    type,
    jobId: JOB_ID,
    sender: SENDER,
    audience: AUDIENCE,
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    nonce: nonce(index),
    payload: PAYLOADS[type],
  } as DacsHttpEnvelopeCreateInput<DacsHttpMessageType>, (bytes) =>
    ed25519Sign(bytes, PRIVATE_KEY)) as Promise<Readonly<DacsHttpEnvelopeV1>>;
}

async function authenticate(
  envelope: unknown,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  const type = (envelope as { type?: DacsHttpMessageType }).type ?? "agreement-proposal";
  return authenticateDacsHttpEnvelopeV1(envelope, {
    storeTime: ISSUED_AT,
    expectedAudience: AUDIENCE,
    resolveIdentity: async () => ({
      status: "authenticated",
      principal: SENDER,
      jobId: JOB_ID,
      role: roleFor(type),
      publicKey: PUBLIC_KEY,
      evidenceHash: IDENTITY_EVIDENCE_HASH,
    }),
    validatePayload: async () => ({ status: "valid" }),
    ...overrides,
  });
}

describe("DACS HTTP envelope v1", () => {
  it("matches the published byte-exact vector for every message type", async () => {
    expect(vectorDocument.publicKeyHex).toBe(Buffer.from(PUBLIC_KEY).toString("hex"));
    expect(vectorDocument.cases).toHaveLength(7);
    for (const vectorCase of vectorDocument.cases) {
      const envelope = await createDacsHttpEnvelopeV1({
        type: vectorCase.type as DacsHttpMessageType,
        jobId: vectorDocument.jobId,
        sender: vectorDocument.sender,
        audience: vectorDocument.audience,
        issuedAt: vectorDocument.issuedAt,
        expiresAt: vectorDocument.expiresAt,
        nonce: vectorCase.nonce,
        payload: vectorCase.payload,
      } as DacsHttpEnvelopeCreateInput<DacsHttpMessageType>, (bytes) =>
        ed25519Sign(bytes, PRIVATE_KEY));
      expect(canonicalize(envelope.payload)).toBe(vectorCase.payloadCanonical);
      expect(envelope.payloadHash).toBe(vectorCase.payloadHash);
      expect(envelope.envelopeId).toBe(vectorCase.envelopeId);
      expect(dacsHttpEnvelopeHashV1(envelope as DacsHttpEnvelopeV1)).toBe(
        vectorCase.envelopeHash,
      );
      expect(Buffer.from(
        dacsHttpEnvelopeSignedBytesV1(envelope as DacsHttpEnvelopeV1),
      ).toString("hex")).toBe(vectorCase.signedBytesHex);
      expect(envelope.signature).toBe(vectorCase.signature);
    }
    expect(vectorDocument.negativeCases.map((entry) => entry.name)).toEqual([
      "modified-payload",
      "modified-audience",
      "wrong-signature-domain",
      "padded-nonce",
      "padded-signature",
      "unsafe-time",
      "non-canonical-principal",
    ]);
  });

  it("creates and authenticates every closed message type", async () => {
    for (const [index, type] of Object.keys(PAYLOADS).entries()) {
      const envelope = await createVectorEnvelope(type as DacsHttpMessageType, index);
      const result = await authenticate(envelope);
      expect(result).toMatchObject({
        status: "authenticated",
        authenticationHash: dacsHttpEnvelopeHashV1(envelope),
        identityEvidenceHash: IDENTITY_EVIDENCE_HASH,
      });
    }
  });

  it("detaches and freezes the signed payload graph", async () => {
    const payload = { nested: { label: "before" } };
    const envelope = await createDacsHttpEnvelopeV1({
      type: "agreement-proposal",
      jobId: JOB_ID,
      sender: SENDER,
      audience: AUDIENCE,
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
      nonce: nonce(20),
      payload: payload as never,
    }, (bytes) => ed25519Sign(bytes, PRIVATE_KEY));
    payload.nested.label = "after";
    expect((envelope.payload as unknown as typeof payload).nested.label).toBe("before");
    expect(Object.isFrozen((envelope.payload as unknown as typeof payload).nested)).toBe(true);
  });

  it("rejects modified payload, audience, key ID, unsafe time, and padded Base64URL", async () => {
    const envelope = await createVectorEnvelope("agreement-proposal", 0);
    const cases: readonly [unknown, Readonly<Record<string, unknown>>, string][] = [
      [{ ...envelope, payload: { changed: true } }, {}, "envelope-payload-hash-mismatch"],
      [{ ...envelope, audience: `did:demos:agent:${"d".repeat(64)}` }, { expectedAudience: undefined }, "envelope-id-mismatch"],
      [{ ...envelope, keyId: `did:demos:agent:${"e".repeat(64)}` }, {}, "envelope-identity-fields-invalid"],
      [{ ...envelope, sender: SENDER_KEY_HEX, keyId: SENDER_KEY_HEX }, {}, "envelope-identity-fields-invalid"],
      [{ ...envelope, nonce: envelope.nonce + "=" }, {}, "nonce-base64url-invalid"],
      [{ ...envelope, signature: envelope.signature + "=" }, {}, "signature-base64url-invalid"],
      [{ ...envelope, expiresAt: Number.MAX_SAFE_INTEGER + 1 }, {}, "envelope-canonical-json-invalid"],
    ];
    for (const [changed, options, reasonCode] of cases) {
      await expect(authenticate(changed, options)).resolves.toMatchObject({
        status: "rejected",
        reasonCode,
      });
    }
  });

  it.each([
    ["bare Demos key", SENDER_KEY_HEX],
    ["foreign DID", `did:example:${SENDER_KEY_HEX}`],
    ["uppercase key", `did:demos:agent:${SENDER_KEY_HEX.toUpperCase()}`],
    ["non-canonical leading scheme", SENDER.replace(/^did:/, "DID:")],
    ["native address notation", `demos:0x${SENDER_KEY_HEX}`],
  ])("rejects a %s as a signed transport principal", async (_label, sender) => {
    await expect(createDacsHttpEnvelopeV1({
      type: "agreement-proposal",
      jobId: JOB_ID,
      sender,
      audience: AUDIENCE,
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
      nonce: nonce(21),
      payload: PAYLOADS["agreement-proposal"] as never,
    }, (bytes) => ed25519Sign(bytes, PRIVATE_KEY))).rejects.toThrow(
      "envelope-create-input-invalid",
    );
  });

  it("rejects identity resolution whose key does not match the self-certifying sender", async () => {
    const envelope = await createVectorEnvelope("agreement-proposal", 0);
    await expect(authenticate(envelope, {
      resolveIdentity: async () => ({
        status: "authenticated",
        principal: SENDER,
        jobId: JOB_ID,
        role: "buyer",
        publicKey: AUDIENCE_PUBLIC_KEY,
        evidenceHash: IDENTITY_EVIDENCE_HASH,
      }),
    })).resolves.toMatchObject({
      status: "rejected",
      reasonCode: "identity-resolution-mismatch",
    });
  });

  it("rejects a valid Ed25519 signature made under the wrong domain", async () => {
    const envelope = await createVectorEnvelope("agreement-proposal", 0);
    const wrongBytes = Buffer.concat([
      Buffer.from("dacs-artifact:v1:", "utf8"),
      Buffer.from(dacsHttpEnvelopeSignedBytesV1(envelope).subarray(-32)),
    ]);
    const changed = {
      ...envelope,
      signature: Buffer.from(ed25519Sign(wrongBytes, PRIVATE_KEY)).toString("base64url"),
    };
    await expect(authenticate(changed)).resolves.toEqual({
      status: "rejected",
      category: "authentication",
      reasonCode: "envelope-signature-invalid",
    });
  });

  it("uses store time, enforces sender role, and fails closed without payload validation", async () => {
    const envelope = await createVectorEnvelope("agreement-proposal", 0);
    await expect(authenticate(envelope, { storeTime: EXPIRES_AT })).resolves.toMatchObject({
      status: "rejected",
      reasonCode: "envelope-expired",
    });
    await expect(authenticate(envelope, {
      resolveIdentity: async () => ({
        status: "authenticated",
        principal: SENDER,
        jobId: JOB_ID,
        role: "seller",
        publicKey: PUBLIC_KEY,
        evidenceHash: IDENTITY_EVIDENCE_HASH,
      }),
    })).resolves.toMatchObject({
      status: "rejected",
      reasonCode: "identity-role-incompatible",
    });
    await expect(authenticate(envelope, { validatePayload: undefined })).resolves.toMatchObject({
      status: "rejected",
      reasonCode: "payload-validator-unavailable",
    });
  });

  it("creates and validates a signed acknowledgement bound to the original", async () => {
    const original = await createVectorEnvelope("agreement-proposal", 0);
    const acknowledgement = await createDacsHttpAcknowledgementEnvelopeV1(original, {
      disposition: "accepted",
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
      nonce: nonce(30),
    }, (bytes) => ed25519Sign(bytes, AUDIENCE_PRIVATE_KEY));
    const authenticated = await authenticateDacsHttpEnvelopeV1(acknowledgement, {
      storeTime: ISSUED_AT,
      expectedAudience: original.sender,
      resolveIdentity: async () => ({
        status: "authenticated",
        principal: original.audience,
        jobId: JOB_ID,
        role: "seller",
        publicKey: AUDIENCE_PUBLIC_KEY,
        evidenceHash: IDENTITY_EVIDENCE_HASH,
      }),
    });
    expect(authenticated.status).toBe("authenticated");
    expect(verifyDacsHttpAcknowledgementBindingV1(
      authenticated as DacsHttpAuthenticatedEnvelopeV1,
      original,
    )).toEqual({ status: "valid", disposition: "accepted" });
  });

  it("projects payment authentication into the exact SDK peer fields", async () => {
    const envelope = await createVectorEnvelope("payment-evidence-request", 2);
    const authenticated = await authenticate(envelope);
    expect(authenticated.status).toBe("authenticated");
    expect(paymentEvidencePeerFromDacsHttpEnvelopeV1(
      authenticated as DacsHttpAuthenticatedEnvelopeV1,
    )).toEqual({
      principal: SENDER,
      audience: AUDIENCE,
      messageId: "request-vector",
      messageHash: "1".repeat(64),
      authenticationHash: dacsHttpEnvelopeHashV1(envelope),
    });
  });

  it("resolves identity only after hashes and expected audience pass", async () => {
    const resolver = vi.fn();
    const envelope = await createVectorEnvelope("agreement-proposal", 0);
    await authenticateDacsHttpEnvelopeV1({ ...envelope, payloadHash: "0".repeat(64) }, {
      storeTime: ISSUED_AT,
      expectedAudience: AUDIENCE,
      resolveIdentity: resolver,
      validatePayload: async () => ({ status: "valid" }),
    });
    expect(resolver).not.toHaveBeenCalled();
  });
});

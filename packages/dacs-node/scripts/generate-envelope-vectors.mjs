import { readFile, writeFile } from "node:fs/promises";

import { canonicalize } from "@kynesyslabs/dacs/canonical";
import {
  ed25519Sign,
  privateKeyFromSeed,
  publicKeyFromSeed,
  rawPublicKey,
} from "@kynesyslabs/dacs/crypto";

import {
  createDacsHttpEnvelopeV1,
  dacsHttpEnvelopeHashV1,
  dacsHttpEnvelopeSignedBytesV1,
} from "../dist/transport/index.js";

const path = new URL("../vectors/dacs-http-envelope-v1.json", import.meta.url);
const document = JSON.parse(await readFile(path, "utf8"));
const privateKey = privateKeyFromSeed(Buffer.from(document.seedHex, "hex"));
const sender = document.sender;
const audience = document.audience;
const jobId = document.jobId;
const issuedAt = document.issuedAt;

const payloads = {
  "agreement-proposal": {
    transportIdentity: { sender, audience },
    proposal: { jobId, label: "Café", numericEdge: Number.MAX_SAFE_INTEGER },
    sellerVetRecord: {
      recordVersion: "1",
      jobId,
      evaluatedParty: audience,
      bundleHash: "a".repeat(64),
      requirementHash: "b".repeat(64),
      freshness: [],
      supplementary: [],
      dealSpecific: [],
      overallDecision: "pass",
      generatedAt: issuedAt,
      signature: {
        algorithm: "ed25519",
        signer: sender,
        value: "buyer-vet-vector-signature",
      },
    },
    sellerVetRef: {
      anchor: { kind: "storage-program", locator: "dacs2:vector:seller-vet" },
      contentHash: "c".repeat(64),
      signer: sender,
    },
    sellerVetReceipt: {
      receiptVersion: "1",
      substrate: "demos",
      finalityProfile: "demos-bft-confirmed-native-read",
      logicalAddress: "dacs2:vector:seller-vet",
      nativeAddress: `stor-${"d".repeat(40)}`,
      contentHash: "c".repeat(64),
      transactionRef: { kind: "demos-storage-program", value: "tx-vector-seller-vet" },
      writer: sender,
      state: "finalized",
      observationDisposition: "established",
      observedAt: issuedAt,
      blockRef: { id: "block-vector-seller-vet", height: "41" },
      evidence: { kind: "demos-bft-write-proof-v1", value: "vector-proof" },
    },
  },
  "agreement-response": {
    responseVersion: "vector",
    accepted: true,
    note: "键顺序",
  },
  "pay-dem-payment-notice": {
    paymentNoticeVersion: "1",
    payment: {
      authorityVersion: "1",
      jobId,
      phaseIndex: 2,
      railId: "demos-native:DEM",
      railVersion: 1,
      railDescriptorHash: "d".repeat(64),
      network: "demos",
      payer: "1".repeat(64),
      payee: "2".repeat(64),
      amountOs: "1000000000",
      maxTotalDebitOs: "2000000000",
      agreementHash: "3".repeat(64),
      termsHash: "4".repeat(64),
      payoutBindingHash: "5".repeat(64),
      paymentInputVersion: "1",
      orderBindingHash: "6".repeat(64),
      orderLocalBindingHash: "7".repeat(64),
      settlementKey: `demos-native:DEM:${jobId}:2`,
    },
    settlement: {
      ok: true,
      txHash: "8".repeat(64),
      chainId: "demos",
      payer: "1".repeat(64),
      payee: "2".repeat(64),
      finality: { model: "bft-final" },
      blockNumber: 42,
      txRefKind: "demos",
    },
  },
  "payment-evidence-request": {
    messageId: "request-vector",
    requestHash: "1".repeat(64),
    jobId,
    seller: sender,
    buyer: audience,
  },
  "payment-evidence-completion": {
    messageId: "completion-vector",
    completionHash: "2".repeat(64),
    jobId,
    buyer: sender,
  },
  "bundle-signature-request": {
    bundleContentHash: "3".repeat(64),
    signedScope: { z: 0, a: "Å" },
    signedBytes: "AQID",
    requiredCounterSigners: [audience],
  },
  "bundle-signature-response": {
    party: sender,
    algorithm: "ed25519",
    signature: "vector-signature",
  },
  "terminal-bundle-proposal-buyer": { vector: "buyer-terminal-proposal" },
  "terminal-bundle-proposal-seller": { vector: "seller-terminal-proposal" },
  "terminal-bundle-contribution-buyer": { vector: "buyer-terminal-contribution" },
  "terminal-bundle-contribution-seller": { vector: "seller-terminal-contribution" },
  acknowledgement: {
    acknowledgedEnvelopeId: "4".repeat(64),
    acknowledgedPayloadHash: "5".repeat(64),
    disposition: "accepted",
  },
  "diagnostic-probe-buyer": {
    purpose: "transport-readiness",
    challenge: Buffer.alloc(32, 8).toString("base64url"),
  },
  "diagnostic-probe-seller": {
    purpose: "transport-readiness",
    challenge: Buffer.alloc(32, 9).toString("base64url"),
  },
  "session-init": {
    bootstrapVersion: "1",
    order: { jobId, buyer: sender, seller: audience },
    application: { requestVersion: "1", query: "session vector" },
    sellerChallenge: "6".repeat(64),
  },
  "session-challenge": {
    bootstrapVersion: "1",
    initPayloadHash: "7".repeat(64),
    sellerChallenge: "6".repeat(64),
    buyerChallenge: "8".repeat(64),
    sellerIdentity: {
      bundleVersion: "1",
      presentedBy: audience,
      presentedAt: issuedAt,
      sessionNonce: "6".repeat(64),
      claims: [{ ref: audience }],
      presentation: {
        kind: "per-claim",
        signatures: [{ ref: audience, signature: "seller-vector-signature" }],
      },
    },
  },
  "session-presentation": {
    bootstrapVersion: "1",
    challengePayloadHash: "9".repeat(64),
    buyerChallenge: "8".repeat(64),
    buyerIdentity: {
      bundleVersion: "1",
      presentedBy: sender,
      presentedAt: issuedAt,
      sessionNonce: "8".repeat(64),
      claims: [{ ref: sender }],
      presentation: {
        kind: "per-claim",
        signatures: [{ ref: sender, signature: "buyer-vector-signature" }],
      },
    },
  },
  "session-admission": {
    bootstrapVersion: "1",
    presentationPayloadHash: "a".repeat(64),
    buyerIdentityHash: "b".repeat(64),
    sellerIdentityHash: "c".repeat(64),
    buyerVetRecord: {
      recordVersion: "1",
      jobId,
      evaluatedParty: sender,
      bundleHash: "b".repeat(64),
      requirementHash: "d".repeat(64),
      freshness: [],
      supplementary: [],
      dealSpecific: [],
      overallDecision: "pass",
      generatedAt: issuedAt,
      signature: {
        algorithm: "ed25519",
        signer: audience,
        value: "seller-vet-vector-signature",
      },
    },
    buyerVetRef: {
      anchor: { kind: "storage-program", locator: "dacs2:vector:buyer-vet" },
      contentHash: "e".repeat(64),
      signer: audience,
    },
    buyerVetReceipt: {
      receiptVersion: "1",
      substrate: "demos",
      finalityProfile: "demos-bft-confirmed-native-read",
      logicalAddress: "dacs2:vector:buyer-vet",
      nativeAddress: `stor-${"f".repeat(40)}`,
      contentHash: "e".repeat(64),
      transactionRef: { kind: "demos-storage-program", value: "tx-vector-buyer-vet" },
      writer: audience,
      state: "finalized",
      observationDisposition: "established",
      observedAt: issuedAt,
      blockRef: { id: "block-vector-buyer-vet", height: "42" },
      evidence: { kind: "demos-bft-write-proof-v1", value: "vector-proof" },
    },
  },
};

const cases = [];
for (const [index, [type, payload]] of Object.entries(payloads).entries()) {
  const nonce = Buffer.alloc(32, index + 1).toString("base64url");
  const envelope = await createDacsHttpEnvelopeV1({
    type,
    jobId,
    sender,
    audience,
    issuedAt,
    expiresAt: document.expiresAt,
    nonce,
    payload,
  }, (bytes) => ed25519Sign(bytes, privateKey));
  cases.push({
    type,
    nonce,
    payload,
    payloadCanonical: canonicalize(envelope.payload),
    payloadHash: envelope.payloadHash,
    envelopeId: envelope.envelopeId,
    envelopeHash: dacsHttpEnvelopeHashV1(envelope),
    signedBytesHex: Buffer.from(dacsHttpEnvelopeSignedBytesV1(envelope)).toString("hex"),
    signature: envelope.signature,
  });
}

const expectedPublicKey = Buffer.from(rawPublicKey(publicKeyFromSeed(
  Buffer.from(document.seedHex, "hex"),
))).toString("hex");
if (expectedPublicKey !== document.publicKeyHex) {
  throw new Error("vector seed does not match its public key");
}

await writeFile(path, `${JSON.stringify({ ...document, cases }, null, 2)}\n`, "utf8");

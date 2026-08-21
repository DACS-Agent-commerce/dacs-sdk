import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ARTIFACT_SEPARATORS,
  type CompositeVerificationRecord,
  type IdentityBundle,
} from "@kynesyslabs/dacs/artifacts";
import { canonicalize, contentHash } from "@kynesyslabs/dacs/canonical";
import {
  FIXED_PRICE_X402_COMMERCE_PROFILE,
  FIXED_PRICE_X402_REGISTRY_INDEX_REF,
  FIXED_PRICE_X402_STANDARD_REVISION,
  type FixedPriceX402OrderRecord,
  type FixedPriceX402TrackOperationInput,
} from "@kynesyslabs/dacs/commerce";
import { rawPublicKey, signedBytes } from "@kynesyslabs/dacs/crypto";
import {
  compositeVerificationAddress,
  demosAgentClaimRef,
  identityBundleHash,
} from "@kynesyslabs/dacs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DACS_NODE_LIVE_PROFILE } from "../src/config.js";
import { createDacsFixedPriceX402OrderPairV1 } from "../src/liveOrder.js";
import { putDacsLiveOrderInputV1 } from "../src/orderInput.js";
import {
  createDacsBuyerSessionBootstrapTransportRuntimeV1,
  createDacsSellerSessionBootstrapTransportRuntimeV1,
} from "../src/sessionBootstrapTransportRuntime.js";
import {
  openDacsNodeSqliteDatabase,
  type DacsNodeSqliteDatabase,
} from "../src/sqlite.js";
import {
  createDacsHttpEnvelopeV1,
  dacsHttpEnvelopeHashV1,
  dacsHttpPayloadHashV1,
  type DacsHttpAuthenticatedEnvelopeV1,
  type DacsHttpEnvelopeV1,
  type DacsHttpMessageType,
  type DacsHttpPayloadByType,
} from "../src/transport/envelope.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const APPLICATION = Object.freeze({ requestVersion: "1", query: "bounded test" });
const roots: string[] = [];
const databases: DacsNodeSqliteDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function protocol(seller: string) {
  return {
    commerceProfile: FIXED_PRICE_X402_COMMERCE_PROFILE,
    standardRevision: FIXED_PRICE_X402_STANDARD_REVISION,
    phase: "pay-x402" as const,
    orchestratorTopology: "seller-as-phase-orchestrator-v1" as const,
    orchestrator: seller,
    rail: {
      registryIndexRef: FIXED_PRICE_X402_REGISTRY_INDEX_REF,
      registryIndexHash: "1".repeat(64),
      railDefinitionRef: "dacs4:rail:x402%3Atest:2",
      railDefinitionHash: "2".repeat(64),
      railId: "x402:test",
      railVersion: 2,
      railType: "x402" as const,
      phaseHandler: "pay-x402" as const,
      network: "eip155:84532" as const,
      availability: "live" as const,
    },
  };
}

function sessionIdentity(
  authority: string,
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  challenge: string,
): Readonly<IdentityBundle> {
  const bundle: IdentityBundle = {
    bundleVersion: "1",
    presentedBy: authority,
    presentedAt: 1_800_000_000_000,
    sessionNonce: challenge,
    claims: [{ ref: authority }],
    presentation: {
      kind: "per-claim",
      signatures: [{ ref: authority, signature: "pending" }],
    },
  };
  if (bundle.presentation.kind !== "per-claim") throw new Error("identity fixture invalid");
  bundle.presentation.signatures[0]!.signature = sign(
    null,
    signedBytes("dacs-bundle-presentation:v1:", identityBundleHash(bundle)),
    privateKey,
  ).toString("base64url");
  return Object.freeze(structuredClone(bundle));
}

function buyerVet(
  buyer: string,
  seller: string,
  sellerPrivateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  bundleHash: string,
): Readonly<CompositeVerificationRecord> {
  const unsigned = {
    recordVersion: "1" as const,
    jobId: JOB_ID,
    evaluatedParty: buyer,
    bundleHash,
    requirementHash: "3".repeat(64),
    freshness: [],
    supplementary: [],
    dealSpecific: [],
    overallDecision: "pass" as const,
    generatedAt: 1_800_000_000_100,
  };
  return Object.freeze({
    ...unsigned,
    signature: {
      algorithm: "ed25519" as const,
      signer: seller,
      value: sign(null, signedBytes(
        ARTIFACT_SEPARATORS.CompositeVerificationRecord,
        contentHash(unsigned),
      ), sellerPrivateKey).toString("base64url"),
    },
  });
}

function operation(order: Readonly<FixedPriceX402OrderRecord>) {
  return Object.freeze({
    order,
    fence: Object.freeze({
      role: order.role,
      track: "agreement" as const,
      jobId: order.jobId,
      bindingHash: order.bindingHash,
      localBindingHash: order.localBindingHash,
      assertCurrent: vi.fn(async () => undefined),
    }),
  }) as unknown as Readonly<FixedPriceX402TrackOperationInput>;
}

async function authenticated<Type extends Exclude<DacsHttpMessageType, "acknowledgement">>(
  type: Type,
  payload: Readonly<DacsHttpPayloadByType[Type]>,
  input: Readonly<{
    sender: string;
    audience: string;
    privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
    role: "buyer" | "seller";
    nonceByte: number;
  }>,
): Promise<Readonly<DacsHttpAuthenticatedEnvelopeV1>> {
  const envelope = await createDacsHttpEnvelopeV1({
    type,
    jobId: JOB_ID,
    sender: input.sender,
    audience: input.audience,
    issuedAt: 1_800_000_000_000,
    expiresAt: 1_800_000_300_000,
    nonce: Buffer.alloc(32, input.nonceByte).toString("base64url"),
    payload,
  }, (bytes) => sign(null, bytes, input.privateKey));
  const capturedEnvelope = envelope as Readonly<DacsHttpEnvelopeV1>;
  return Object.freeze({
    status: "authenticated",
    envelope: capturedEnvelope,
    authenticationHash: dacsHttpEnvelopeHashV1(capturedEnvelope),
    identityEvidenceHash: "4".repeat(64),
    identityRole: input.role,
    receivedAt: 1_800_000_000_001,
  });
}

function acknowledgement() {
  return Object.freeze({
    envelope: {
      type: "acknowledgement",
      payload: { disposition: "accepted" },
    },
  }) as never;
}

async function fixture() {
  const buyerKeys = generateKeyPairSync("ed25519");
  const sellerKeys = generateKeyPairSync("ed25519");
  const buyer = demosAgentClaimRef(rawPublicKey(buyerKeys.publicKey));
  const seller = demosAgentClaimRef(rawPublicKey(sellerKeys.publicKey));
  const pair = createDacsFixedPriceX402OrderPairV1({
    jobId: JOB_ID,
    buyer,
    seller,
    protocol: protocol(seller),
  });
  const root = mkdtempSync(join(tmpdir(), "dacs-session-bootstrap-"));
  roots.push(root);
  const [buyerDatabase, sellerDatabase] = await Promise.all([
    openDacsNodeSqliteDatabase({
      databasePath: join(root, "buyer.sqlite"),
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role: "buyer",
      authority: buyer,
    }),
    openDacsNodeSqliteDatabase({
      databasePath: join(root, "seller.sqlite"),
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role: "seller",
      authority: seller,
    }),
  ]);
  databases.push(buyerDatabase, sellerDatabase);
  putDacsLiveOrderInputV1({ database: buyerDatabase, order: pair.buyer,
    application: APPLICATION });
  const buyerStore = buyerDatabase.createLiveCoordinatorStore("buyer");
  await buyerStore.create({
    role: "buyer",
    order: pair.buyer,
    bindingHash: pair.bindingHash,
    localBindingHash: pair.buyerLocalBindingHash,
  });
  const loadedBuyer = await buyerStore.load("buyer", JOB_ID);
  if (loadedBuyer.status !== "ok") throw new Error("buyer order missing");

  const buyerContext = {
    role: "buyer",
    database: buyerDatabase,
    sendMessage: vi.fn(async () => acknowledgement()),
  } as never;
  const sellerContext = {
    role: "seller",
    database: sellerDatabase,
    sendMessage: vi.fn(async () => acknowledgement()),
  } as never;
  const buyerRuntime = createDacsBuyerSessionBootstrapTransportRuntimeV1(buyerContext);
  const sellerStore = sellerDatabase.createLiveCoordinatorStore("seller");
  const startOrder = vi.fn(async () => sellerStore.create({
    role: "seller",
    order: pair.seller,
    bindingHash: pair.bindingHash,
    localBindingHash: pair.sellerLocalBindingHash,
  }));
  const admitInit = vi.fn(() => ({ order: pair.seller, application: APPLICATION }));
  const sellerRuntime = createDacsSellerSessionBootstrapTransportRuntimeV1({
    context: sellerContext,
    admitInit,
  });
  return { buyerKeys, sellerKeys, buyer, seller, pair, buyerDatabase, sellerDatabase,
    buyerRuntime, sellerRuntime, buyerOperation: operation(loadedBuyer.record),
    sellerStore, startOrder, admitInit };
}

describe("pre-agreement session bootstrap transport", () => {
  it("retains an authenticated, replay-safe linked transcript across both role stores", async () => {
    const value = await fixture();
    const sellerChallenge = "5".repeat(64);
    const buyerChallenge = "6".repeat(64);
    const init = Object.freeze({
      bootstrapVersion: "1" as const,
      order: value.pair.buyer,
      application: APPLICATION,
      sellerChallenge,
    });
    await expect(value.buyerRuntime.publishInit(value.buyerOperation, init))
      .resolves.toBe("acknowledged");
    const initEnvelope = await authenticated("session-init", init, {
      sender: value.buyer,
      audience: value.seller,
      privateKey: value.buyerKeys.privateKey,
      role: "buyer",
      nonceByte: 1,
    });
    const sellerInbound = { role: "seller", coordinator: {
      startOrder: value.startOrder,
    } } as never;
    await expect(value.sellerRuntime.handleMessage(initEnvelope, sellerInbound))
      .resolves.toEqual({ disposition: "accepted" });
    await expect(value.sellerRuntime.handleMessage(initEnvelope, sellerInbound))
      .resolves.toEqual({ disposition: "accepted" });
    expect(value.startOrder).toHaveBeenCalledTimes(2);

    const loadedSeller = await value.sellerStore.load("seller", JOB_ID);
    if (loadedSeller.status !== "ok") throw new Error("seller order missing");
    const sellerOperation = operation(loadedSeller.record);
    expect(value.sellerRuntime.resolveInit(sellerOperation)).toEqual(init);

    const challenge = Object.freeze({
      bootstrapVersion: "1" as const,
      initPayloadHash: dacsHttpPayloadHashV1(init),
      sellerChallenge,
      buyerChallenge,
      sellerIdentity: sessionIdentity(
        value.seller, value.sellerKeys.privateKey, sellerChallenge,
      ),
    });
    await expect(value.sellerRuntime.publishChallenge(sellerOperation, challenge))
      .resolves.toBe("acknowledged");
    const challengeEnvelope = await authenticated("session-challenge", challenge, {
      sender: value.seller,
      audience: value.buyer,
      privateKey: value.sellerKeys.privateKey,
      role: "seller",
      nonceByte: 2,
    });
    const buyerInbound = { role: "buyer" } as never;
    await expect(value.buyerRuntime.handleMessage(challengeEnvelope, buyerInbound))
      .resolves.toEqual({ disposition: "accepted" });
    expect(value.buyerRuntime.resolveChallenge(value.buyerOperation)).toEqual(challenge);

    const presentation = Object.freeze({
      bootstrapVersion: "1" as const,
      challengePayloadHash: dacsHttpPayloadHashV1(challenge),
      buyerChallenge,
      buyerIdentity: sessionIdentity(
        value.buyer, value.buyerKeys.privateKey, buyerChallenge,
      ),
    });
    await expect(value.buyerRuntime.publishPresentation(value.buyerOperation, presentation))
      .resolves.toBe("acknowledged");
    const presentationEnvelope = await authenticated("session-presentation", presentation, {
      sender: value.buyer,
      audience: value.seller,
      privateKey: value.buyerKeys.privateKey,
      role: "buyer",
      nonceByte: 3,
    });
    await expect(value.sellerRuntime.handleMessage(presentationEnvelope, sellerInbound))
      .resolves.toEqual({ disposition: "accepted" });
    expect(value.sellerRuntime.resolvePresentation(sellerOperation)).toEqual(presentation);

    const record = buyerVet(
      value.buyer,
      value.seller,
      value.sellerKeys.privateKey,
      identityBundleHash(presentation.buyerIdentity),
    );
    const admission = Object.freeze({
      bootstrapVersion: "1" as const,
      presentationPayloadHash: dacsHttpPayloadHashV1(presentation),
      buyerIdentityHash: identityBundleHash(presentation.buyerIdentity),
      sellerIdentityHash: identityBundleHash(challenge.sellerIdentity),
      buyerVetRecord: record,
      buyerVetRef: Object.freeze({
        anchor: Object.freeze({
          kind: "storage-program" as const,
          locator: compositeVerificationAddress(JOB_ID, value.buyer),
        }),
        contentHash: contentHash(record as unknown as Record<string, unknown>),
        signer: value.seller,
      }),
      buyerVetReceipt: Object.freeze({
        receiptVersion: "1" as const,
        substrate: "demos" as const,
        finalityProfile: "demos-bft-confirmed-native-read",
        logicalAddress: compositeVerificationAddress(JOB_ID, value.buyer),
        nativeAddress: `stor-${"a".repeat(40)}`,
        contentHash: contentHash(record as unknown as Record<string, unknown>),
        transactionRef: { kind: "demos-storage-program", value: "tx-buyer-vet" },
        writer: value.seller,
        state: "finalized" as const,
        observationDisposition: "established" as const,
        observedAt: 1_800_000_000_200,
        blockRef: { id: "block-buyer-vet", height: "42" },
        evidence: { kind: "demos-bft-write-proof-v1", value: "proof" },
      }),
    });
    const forgedRecord = Object.freeze({
      ...record,
      signature: Object.freeze({
        ...record.signature,
        value: `${record.signature.value[0] === "A" ? "B" : "A"}${record.signature.value.slice(1)}`,
      }),
    });
    await expect(value.sellerRuntime.publishAdmission(sellerOperation, {
      ...admission,
      buyerVetRecord: forgedRecord,
      buyerVetRef: {
        ...admission.buyerVetRef,
        contentHash: contentHash(forgedRecord as unknown as Record<string, unknown>),
      },
      buyerVetReceipt: {
        ...admission.buyerVetReceipt,
        contentHash: contentHash(forgedRecord as unknown as Record<string, unknown>),
      },
    })).rejects.toMatchObject({ reasonCode: "session-admission-binding-mismatch" });
    await expect(value.sellerRuntime.publishAdmission(sellerOperation, admission))
      .resolves.toBe("acknowledged");
    const admissionEnvelope = await authenticated("session-admission", admission, {
      sender: value.seller,
      audience: value.buyer,
      privateKey: value.sellerKeys.privateKey,
      role: "seller",
      nonceByte: 4,
    });
    await expect(value.buyerRuntime.handleMessage(admissionEnvelope, buyerInbound))
      .resolves.toEqual({ disposition: "accepted" });
    expect(value.buyerRuntime.resolveAdmission(value.buyerOperation)).toEqual(admission);
  });

  it("fails closed on pre-admission shape errors and transcript substitution", async () => {
    const value = await fixture();
    const init = {
      bootstrapVersion: "1" as const,
      order: value.pair.buyer,
      application: APPLICATION,
      sellerChallenge: "7".repeat(64),
    };
    const malformed = await authenticated("session-init", {
      ...init,
      extra: true,
    } as never, {
      sender: value.buyer,
      audience: value.seller,
      privateKey: value.buyerKeys.privateKey,
      role: "buyer",
      nonceByte: 5,
    });
    await expect(value.sellerRuntime.handleMessage(malformed, {
      role: "seller", coordinator: { startOrder: value.startOrder },
    } as never)).resolves.toEqual({ disposition: "rejected",
      reasonCode: "session-init-envelope-invalid" });
    expect(value.admitInit).not.toHaveBeenCalled();

    await value.buyerRuntime.publishInit(value.buyerOperation, init);
    const wrongChallenge = {
      bootstrapVersion: "1" as const,
      initPayloadHash: "8".repeat(64),
      sellerChallenge: init.sellerChallenge,
      buyerChallenge: "9".repeat(64),
      sellerIdentity: sessionIdentity(
        value.seller, value.sellerKeys.privateKey, init.sellerChallenge,
      ),
    };
    await expect(value.buyerRuntime.handleMessage(await authenticated(
      "session-challenge", wrongChallenge, {
        sender: value.seller,
        audience: value.buyer,
        privateKey: value.sellerKeys.privateKey,
        role: "seller",
        nonceByte: 6,
      }), { role: "buyer" } as never)).resolves.toEqual({ disposition: "rejected",
        reasonCode: "session-message-binding-invalid" });

    const stored = value.buyerDatabase.loadReservation(
      "session", `session-nonce:${init.sellerChallenge}`,
    );
    expect(stored).toMatchObject({ jobId: JOB_ID });
    expect(canonicalize(value.buyerRuntime.resolveChallenge(value.buyerOperation) ?? null))
      .toBe("null");
  });
});

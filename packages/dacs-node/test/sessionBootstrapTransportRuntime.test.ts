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
  FIXED_PRICE_PAY_DEM_COMMERCE_PROFILE,
  FIXED_PRICE_PAY_DEM_REGISTRY_INDEX_REF,
  FIXED_PRICE_PAY_DEM_STANDARD_REVISION,
  FIXED_PRICE_X402_COMMERCE_PROFILE,
  FIXED_PRICE_X402_REGISTRY_INDEX_REF,
  FIXED_PRICE_X402_STANDARD_REVISION,
  type FixedPricePayDemOrderInput,
  type FixedPricePayDemOrderRecord,
  type FixedPriceX402OrderRecord,
} from "@kynesyslabs/dacs/commerce";
import { rawPublicKey, signedBytes } from "@kynesyslabs/dacs/crypto";
import {
  compositeVerificationAddress,
  demosAgentClaimRef,
  identityBundleHash,
} from "@kynesyslabs/dacs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";

import { DACS_NODE_LIVE_PROFILE } from "../src/config.js";
import {
  createDacsFixedPricePayDemOrderPairV1,
  createDacsFixedPriceX402OrderPairV1,
} from "../src/liveOrder.js";
import {
  putDacsLiveOrderInputV1,
  type DacsLiveTrackOperationInputV1,
} from "../src/orderInput.js";
import {
  DacsSellerSessionAdmissionUnavailableError,
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
  vi.restoreAllMocks();
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

function payDemProtocol(seller: string) {
  return {
    commerceProfile: FIXED_PRICE_PAY_DEM_COMMERCE_PROFILE,
    standardRevision: FIXED_PRICE_PAY_DEM_STANDARD_REVISION,
    phase: "pay-dem" as const,
    orchestratorTopology: "seller-as-phase-orchestrator-v1" as const,
    orchestrator: seller,
    rail: {
      registryIndexRef: FIXED_PRICE_PAY_DEM_REGISTRY_INDEX_REF,
      registryIndexHash: "a".repeat(64),
      railDefinitionRef: "dacs4:rail:demos-native%3ADEM:1",
      railDefinitionHash: "b".repeat(64),
      railId: "demos-native:DEM",
      railVersion: 1,
      railType: "demos-native" as const,
      phaseHandler: "pay-dem" as const,
      network: "demos" as const,
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

async function buyerSessionIdentity(
  authority: string,
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  challenge: string,
  evmPrivateKey: `0x${string}`,
): Promise<Readonly<IdentityBundle>> {
  const account = privateKeyToAccount(evmPrivateKey);
  const evmClaim = `cci-xm:evm:84532:${account.address}`;
  const bundle: IdentityBundle = {
    bundleVersion: "1",
    presentedBy: authority,
    presentedAt: 1_800_000_000_000,
    sessionNonce: challenge,
    claims: [{ ref: authority }, { ref: evmClaim }],
    presentation: {
      kind: "per-claim",
      signatures: [
        { ref: authority, signature: "pending" },
        { ref: evmClaim, signature: "pending" },
      ],
    },
  };
  if (bundle.presentation.kind !== "per-claim") throw new Error("identity fixture invalid");
  const bytes = signedBytes("dacs-bundle-presentation:v1:", identityBundleHash(bundle));
  bundle.presentation.signatures[0]!.signature = sign(null, bytes, privateKey)
    .toString("base64url");
  bundle.presentation.signatures[1]!.signature = await account.signMessage({
    message: { raw: bytes },
  });
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

function operation(
  order: Readonly<FixedPriceX402OrderRecord | FixedPricePayDemOrderRecord>,
) {
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
  }) as unknown as Readonly<DacsLiveTrackOperationInputV1>;
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
  const buyerEvmPrivateKey = `0x${"33".repeat(32)}` as const;
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
    buyerRuntime, sellerRuntime, buyerContext, sellerContext, root, buyerOperation: operation(loadedBuyer.record),
    sellerStore, startOrder, admitInit, buyerEvmPrivateKey };
}

async function presentationFixture() {
  const value = await fixture();
  const init = { bootstrapVersion: "1" as const, order: value.pair.buyer,
    application: APPLICATION, sellerChallenge: "c".repeat(64) };
  await value.buyerRuntime.publishInit(value.buyerOperation, init);
  const inbound = { role: "seller", coordinator: { startOrder: value.startOrder } } as never;
  await value.sellerRuntime.handleMessage(await authenticated("session-init", init, {
    sender: value.buyer, audience: value.seller, privateKey: value.buyerKeys.privateKey,
    role: "buyer", nonceByte: 61,
  }), inbound);
  const loaded = await value.sellerStore.load("seller", JOB_ID);
  if (loaded.status !== "ok") throw new Error("seller fixture missing");
  const sellerOperation = operation(loaded.record);
  const challenge = { bootstrapVersion: "1" as const, initPayloadHash: dacsHttpPayloadHashV1(init),
    sellerChallenge: init.sellerChallenge, buyerChallenge: "d".repeat(64),
    sellerIdentity: sessionIdentity(value.seller, value.sellerKeys.privateKey, init.sellerChallenge) };
  await value.sellerRuntime.publishChallenge(sellerOperation, challenge);
  const challengeEnvelope = await authenticated("session-challenge", challenge, {
    sender: value.seller, audience: value.buyer, privateKey: value.sellerKeys.privateKey,
    role: "seller", nonceByte: 62,
  });
  const presentation = { bootstrapVersion: "1" as const, challengePayloadHash: dacsHttpPayloadHashV1(challenge),
    buyerChallenge: challenge.buyerChallenge,
    buyerIdentity: await buyerSessionIdentity(value.buyer, value.buyerKeys.privateKey,
      challenge.buyerChallenge, value.buyerEvmPrivateKey) };
  const presentationEnvelope = (payload = presentation, nonceByte = 63) => authenticated("session-presentation", payload, {
    sender: value.buyer, audience: value.seller, privateKey: value.buyerKeys.privateKey,
    role: "buyer", nonceByte,
  });
  return { ...value, init, challenge, challengeEnvelope, presentation, presentationEnvelope, sellerOperation, inbound };
}

describe("pre-agreement session bootstrap transport", () => {
  it.each((["buyer", "seller"] as const).flatMap((role) =>
    (["shape", "signature", "binding", "nonce-binding", "missing-nonces",
      "wrong-nonces", "missing-identity"] as const).map((fault) => ({ role, fault })),
  ))("$role consumes a $fault attempt before validation and retains it on restart", async ({ role, fault }) => {
    const value = await presentationFixture();
    const runtime = role === "buyer" ? value.buyerRuntime : value.sellerRuntime;
    const envelope = role === "buyer" ? value.challengeEnvelope : await value.presentationEnvelope();
    const identityKey = role === "buyer" ? "sellerIdentity" : "buyerIdentity";
    const payload = structuredClone(envelope.envelope.payload) as unknown as Record<string, any>;
    if (fault === "shape") payload[identityKey] = null;
    else if (fault === "signature") {
      const signature = payload[identityKey].presentation.signatures[0];
      signature.signature = (signature.signature.startsWith("A") ? "B" : "A") + signature.signature.slice(1);
    } else if (fault === "binding") payload[role === "buyer" ? "initPayloadHash" : "challengePayloadHash"] = "0".repeat(64);
    else if (fault === "missing-nonces" || fault === "missing-identity") {
      delete payload[role === "buyer" ? "sellerChallenge" : "buyerChallenge"];
      if (fault === "missing-identity") delete payload[identityKey];
      else delete payload[identityKey].sessionNonce;
    } else {
      payload[role === "buyer" ? "sellerChallenge" : "buyerChallenge"] = "0".repeat(64);
      if (fault === "wrong-nonces") payload[identityKey].sessionNonce = "0".repeat(64);
    }
    const invalid = await authenticated(envelope.envelope.type as "session-challenge", payload as never, {
      sender: envelope.envelope.sender, audience: envelope.envelope.audience,
      privateKey: role === "buyer" ? value.sellerKeys.privateKey : value.buyerKeys.privateKey,
      role: role === "buyer" ? "seller" : "buyer", nonceByte: 64,
    });
    expect(await runtime.validatePayload({ type: invalid.envelope.type as "session-challenge",
      payload: invalid.envelope.payload, jobId: JOB_ID, sender: invalid.envelope.sender,
      audience: invalid.envelope.audience })).toEqual({ status: "valid" });
    await expect(runtime.handleMessage(invalid, { role } as never)).resolves.toMatchObject({ disposition: "rejected" });
    await expect(runtime.handleMessage(envelope, { role } as never)).resolves.toMatchObject({ disposition: "rejected" });
    const old = role === "buyer" ? value.buyerDatabase : value.sellerDatabase;
    old.close();
    databases.splice(databases.indexOf(old), 1);
    const reopened = await openDacsNodeSqliteDatabase({ databasePath: join(value.root, `${role}.sqlite`),
      mode: "live-demos", profile: DACS_NODE_LIVE_PROFILE, role, authority: value[role] });
    databases.push(reopened);
    const restarted = role === "buyer"
      ? createDacsBuyerSessionBootstrapTransportRuntimeV1({ role, database: reopened } as never)
      : createDacsSellerSessionBootstrapTransportRuntimeV1({ context: { role, database: reopened } as never,
        admitInit: value.admitInit });
    await expect(restarted.handleMessage(envelope, { role } as never)).resolves.toMatchObject({ disposition: "rejected" });
    await expect(restarted.handleMessage(invalid, { role } as never)).resolves.toMatchObject({ disposition: "rejected" });
  });

  it.each(["buyer", "seller"] as const)("%s rejects an expired pending challenge without extending its deadline on retry", async (role) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_900_000_000_000);
    const value = await presentationFixture();
    clock.mockReturnValue(1_900_000_300_000);
    // Republishing the local verifier's message must not refresh issuance.
    if (role === "buyer") await value.buyerRuntime.publishInit(value.buyerOperation, value.init);
    else await value.sellerRuntime.publishChallenge(value.sellerOperation, value.challenge);
    const runtime = role === "buyer" ? value.buyerRuntime : value.sellerRuntime;
    const envelope = role === "buyer" ? value.challengeEnvelope : await value.presentationEnvelope();
    await expect(runtime.handleMessage(envelope, { role } as never)).resolves.toMatchObject({ disposition: "rejected" });
  });

  it("deduplicates accepted delivery but rejects fresh and re-signed presentation attempts", async () => {
    const value = await presentationFixture();
    const accepted = await value.presentationEnvelope();
    await expect(value.sellerRuntime.handleMessage(accepted, value.inbound)).resolves.toEqual({ disposition: "accepted" });
    await expect(value.sellerRuntime.handleMessage(accepted, value.inbound)).resolves.toEqual({ disposition: "accepted" });
    await expect(value.sellerRuntime.handleMessage(await value.presentationEnvelope(value.presentation, 65), value.inbound))
      .resolves.toMatchObject({ disposition: "rejected" });
    const identity = { ...structuredClone(value.presentation.buyerIdentity),
      presentedAt: value.presentation.buyerIdentity.presentedAt + 1 };
    if (identity.presentation.kind !== "per-claim") throw new Error();
    const bytes = signedBytes("dacs-bundle-presentation:v1:", identityBundleHash(identity));
    identity.presentation.signatures[0]!.signature = sign(null, bytes, value.buyerKeys.privateKey).toString("base64url");
    identity.presentation.signatures[1]!.signature = await privateKeyToAccount(value.buyerEvmPrivateKey)
      .signMessage({ message: { raw: bytes } });
    await expect(value.sellerRuntime.handleMessage(await value.presentationEnvelope({
      ...value.presentation, buyerIdentity: identity,
    }, 66), value.inbound)).resolves.toMatchObject({ disposition: "rejected" });
  });

  it("rejects issuance of the same challenge to the other presenter", async () => {
    const value = await presentationFixture();
    await expect(value.sellerRuntime.publishChallenge(value.sellerOperation, {
      ...value.challenge, buyerChallenge: value.init.sellerChallenge,
    })).rejects.toMatchObject({ reasonCode: "session-challenge-binding-mismatch" });
  });

  it("atomically admits at most one of two concurrent presentation attempts", async () => {
    const value = await presentationFixture();
    const [first, second] = await Promise.all([
      value.presentationEnvelope(value.presentation, 68), value.presentationEnvelope(value.presentation, 69),
    ]);
    const results = await Promise.all([value.sellerRuntime.handleMessage(first, value.inbound),
      value.sellerRuntime.handleMessage(second, value.inbound)]);
    expect(results.filter((result) => result.disposition === "accepted")).toHaveLength(1);
    expect(results.filter((result) => result.disposition === "rejected")).toHaveLength(1);
  });

  it.each(["buyer", "seller"] as const)("%s checks job, presenter and audience before consuming its challenge", async (role) => {
    const value = await presentationFixture();
    const runtime = role === "buyer" ? value.buyerRuntime : value.sellerRuntime;
    const valid = role === "buyer" ? value.challengeEnvelope : await value.presentationEnvelope();
    for (const patch of [{ jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7E" },
      { sender: valid.envelope.audience }, { audience: valid.envelope.sender }]) {
      await expect(runtime.handleMessage({ ...valid, envelope: {
        ...valid.envelope, ...patch,
      } } as never, { role } as never)).resolves.toMatchObject({ disposition: "rejected" });
    }
    await expect(runtime.handleMessage(valid, { role } as never)).resolves.toEqual({ disposition: "accepted" });
  });

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
      buyerIdentity: await buyerSessionIdentity(
        value.buyer, value.buyerKeys.privateKey, buyerChallenge,
        value.buyerEvmPrivateKey,
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

  it.each([false, true])("runs native DEM identity admission with a prior incompatible attempt: %s", async (firstInvalid) => {
    const buyerKeys = generateKeyPairSync("ed25519");
    const sellerKeys = generateKeyPairSync("ed25519");
    const buyer = demosAgentClaimRef(rawPublicKey(buyerKeys.publicKey));
    const seller = demosAgentClaimRef(rawPublicKey(sellerKeys.publicKey));
    const pair = createDacsFixedPricePayDemOrderPairV1({
      jobId: JOB_ID,
      buyer,
      seller,
      protocol: payDemProtocol(seller),
    });
    const root = mkdtempSync(join(tmpdir(), "dacs-session-bootstrap-dem-"));
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
    putDacsLiveOrderInputV1({
      database: buyerDatabase,
      order: pair.buyer,
      application: APPLICATION,
    });
    const buyerStore = buyerDatabase.createPayDemCoordinatorStore("buyer");
    await buyerStore.create({
      role: "buyer",
      order: pair.buyer,
      bindingHash: pair.bindingHash,
      localBindingHash: pair.buyerLocalBindingHash,
    });
    const loadedBuyer = await buyerStore.load("buyer", JOB_ID);
    if (loadedBuyer.status !== "ok") throw new Error("native buyer order missing");
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
    const sellerStore = sellerDatabase.createPayDemCoordinatorStore("seller");
    const startOrder = vi.fn(async () => sellerStore.create({
      role: "seller",
      order: pair.seller,
      bindingHash: pair.bindingHash,
      localBindingHash: pair.sellerLocalBindingHash,
    }));
    const sellerRuntime = createDacsSellerSessionBootstrapTransportRuntimeV1<
      FixedPricePayDemOrderInput
    >({
      context: sellerContext,
      admitInit: () => ({ order: pair.seller, application: APPLICATION }),
    });
    const buyerOperation = operation(loadedBuyer.record);
    const sellerChallenge = "c".repeat(64);
    const buyerChallenge = "d".repeat(64);
    const init = Object.freeze({
      bootstrapVersion: "1" as const,
      order: pair.buyer,
      application: APPLICATION,
      sellerChallenge,
    });
    await expect(buyerRuntime.publishInit(buyerOperation, init))
      .resolves.toBe("acknowledged");
    await expect(sellerRuntime.handleMessage(await authenticated("session-init", init, {
      sender: buyer,
      audience: seller,
      privateKey: buyerKeys.privateKey,
      role: "buyer",
      nonceByte: 40,
    }), { role: "seller", coordinator: { startOrder } } as never))
      .resolves.toEqual({ disposition: "accepted" });
    const loadedSeller = await sellerStore.load("seller", JOB_ID);
    if (loadedSeller.status !== "ok") throw new Error("native seller order missing");
    const sellerOperation = operation(loadedSeller.record);
    const challenge = Object.freeze({
      bootstrapVersion: "1" as const,
      initPayloadHash: dacsHttpPayloadHashV1(init),
      sellerChallenge,
      buyerChallenge,
      sellerIdentity: sessionIdentity(seller, sellerKeys.privateKey, sellerChallenge),
    });
    await sellerRuntime.publishChallenge(sellerOperation, challenge);
    await expect(buyerRuntime.handleMessage(await authenticated(
      "session-challenge",
      challenge,
      {
        sender: seller,
        audience: buyer,
        privateKey: sellerKeys.privateKey,
        role: "seller",
        nonceByte: 41,
      },
    ), { role: "buyer" } as never)).resolves.toEqual({ disposition: "accepted" });

    const x402Identity = await buyerSessionIdentity(
      buyer,
      buyerKeys.privateKey,
      buyerChallenge,
      `0x${"44".repeat(32)}`,
    );
    const wrongPresentation = Object.freeze({
      bootstrapVersion: "1" as const,
      challengePayloadHash: dacsHttpPayloadHashV1(challenge),
      buyerChallenge,
      buyerIdentity: x402Identity,
    });
    if (firstInvalid) await expect(sellerRuntime.handleMessage(await authenticated(
      "session-presentation",
      wrongPresentation,
      {
        sender: buyer,
        audience: seller,
        privateKey: buyerKeys.privateKey,
        role: "buyer",
        nonceByte: 42,
      },
    ), { role: "seller" } as never)).resolves.toEqual({
      disposition: "rejected",
      reasonCode: "session-message-binding-invalid",
    });

    const presentation = Object.freeze({
      ...wrongPresentation,
      buyerIdentity: sessionIdentity(buyer, buyerKeys.privateKey, buyerChallenge),
    });
    await buyerRuntime.publishPresentation(buyerOperation, presentation);
    await expect(sellerRuntime.handleMessage(await authenticated(
      "session-presentation",
      presentation,
      {
        sender: buyer,
        audience: seller,
        privateKey: buyerKeys.privateKey,
        role: "buyer",
        nonceByte: 43,
      },
    ), { role: "seller" } as never)).resolves.toEqual(firstInvalid ? { disposition: "rejected",
      reasonCode: "session-message-binding-invalid" } : { disposition: "accepted" });
    expect(sellerRuntime.resolvePresentation(sellerOperation)).toEqual(firstInvalid ? undefined : presentation);
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

    value.admitInit.mockImplementationOnce(() => {
      throw Object.assign(new Error("blocked"), {
        reasonCode: "listing-anchor-read-unavailable",
      });
    });
    const blocked = await authenticated("session-init", init, {
      sender: value.buyer,
      audience: value.seller,
      privateKey: value.buyerKeys.privateKey,
      role: "buyer",
      nonceByte: 8,
    });
    await expect(value.sellerRuntime.handleMessage(blocked, {
      role: "seller", coordinator: { startOrder: value.startOrder },
    } as never)).resolves.toEqual({ disposition: "rejected",
      reasonCode: "listing-anchor-read-unavailable" });

    value.admitInit.mockImplementationOnce(() => {
      throw new DacsSellerSessionAdmissionUnavailableError(
        "listing-registry-resolution-unavailable",
      );
    });
    const unavailable = await authenticated("session-init", init, {
      sender: value.buyer,
      audience: value.seller,
      privateKey: value.buyerKeys.privateKey,
      role: "buyer",
      nonceByte: 9,
    });
    await expect(value.sellerRuntime.handleMessage(unavailable, {
      role: "seller", coordinator: { startOrder: value.startOrder },
    } as never)).rejects.toMatchObject({
      reasonCode: "listing-registry-resolution-unavailable",
    });

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

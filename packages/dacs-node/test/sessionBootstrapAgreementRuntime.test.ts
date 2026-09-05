import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FIXED_PRICE_X402_COMMERCE_PROFILE,
  FIXED_PRICE_X402_REGISTRY_INDEX_REF,
  FIXED_PRICE_X402_STANDARD_REVISION,
  type FixedPriceX402OrderRecord,
  type FixedPriceX402TrackOperationInput,
} from "@kynesyslabs/dacs/commerce";
import { rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { signedBytes } from "@kynesyslabs/dacs/crypto";
import { demosAgentClaimRef } from "@kynesyslabs/dacs/identity";
import { sha256Hex } from "@kynesyslabs/dacs/canonical";
import { afterEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";

import { DACS_NODE_LIVE_PROFILE } from "../src/config.js";
import { createDacsFixedPriceX402OrderPairV1 } from "../src/liveOrder.js";
import { putDacsLiveOrderInputV1 } from "../src/orderInput.js";
import { retainDacsFixedPricePurchaseDemosBudgetGrantV1 } from
  "../src/purchaseDemosBudget.js";
import {
  createDacsBuyerSessionBootstrapAgreementTrackV1,
  createDacsSellerSessionBootstrapAgreementTrackV1,
  loadDacsBuyerSessionAgreementFactsV1,
  loadDacsSellerSessionAgreementFactsV1,
} from "../src/sessionBootstrapAgreementRuntime.js";
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
  type DacsHttpAuthenticatedEnvelopeV1,
  type DacsHttpEnvelopeV1,
  type DacsHttpMessageType,
  type DacsHttpPayloadByType,
} from "../src/transport/envelope.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const APPLICATION = Object.freeze({ applicationVersion: "1", request: { query: "test" } });
const EMPTY_REQUIREMENT = Object.freeze({ requirementVersion: "1" as const, required: [] });
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

function operation(order: Readonly<FixedPriceX402OrderRecord>) {
  return Object.freeze({
    order,
    fence: Object.freeze({
      role: order.role,
      track: "agreement" as const,
      jobId: order.jobId,
      bindingHash: order.bindingHash,
      localBindingHash: order.localBindingHash,
      owner: `${order.role}-test-worker`,
      generation: 1,
      idempotencyKey: `${order.role}-agreement:${order.jobId}`,
      assertCurrent: vi.fn(async () => undefined),
    }),
  }) as unknown as Readonly<FixedPriceX402TrackOperationInput>;
}

function acknowledgement() {
  return Object.freeze({
    envelope: { type: "acknowledgement", payload: { disposition: "accepted" } },
  }) as never;
}

async function authenticated<Type extends Exclude<DacsHttpMessageType, "acknowledgement">>(
  input: Readonly<{
    type: Type;
    payload: Readonly<DacsHttpPayloadByType[Type]>;
    sender: string;
    audience: string;
    privateKey: KeyObject;
    role: "buyer" | "seller";
    nonceByte: number;
  }>,
): Promise<Readonly<DacsHttpAuthenticatedEnvelopeV1>> {
  const envelope = await createDacsHttpEnvelopeV1({
    type: input.type,
    jobId: JOB_ID,
    sender: input.sender,
    audience: input.audience,
    issuedAt: 1_800_000_000_000,
    expiresAt: 1_800_000_300_000,
    nonce: Buffer.alloc(32, input.nonceByte).toString("base64url"),
    payload: input.payload,
  }, (bytes) => sign(null, bytes, input.privateKey));
  const captured = envelope as Readonly<DacsHttpEnvelopeV1>;
  return Object.freeze({
    status: "authenticated",
    envelope: captured,
    authenticationHash: dacsHttpEnvelopeHashV1(captured),
    identityEvidenceHash: "4".repeat(64),
    identityRole: input.role,
    receivedAt: 1_800_000_000_001,
  });
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
  const root = mkdtempSync(join(tmpdir(), "dacs-session-agreement-"));
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
  retainDacsFixedPricePurchaseDemosBudgetGrantV1({
    database: buyerDatabase,
    jobId: JOB_ID,
    role: "buyer",
    authority: buyer,
    maximumPerWriteFeeDem: "2",
  });
  retainDacsFixedPricePurchaseDemosBudgetGrantV1({
    database: sellerDatabase,
    jobId: JOB_ID,
    role: "seller",
    authority: seller,
    maximumPerWriteFeeDem: "2",
  });
  putDacsLiveOrderInputV1({ database: buyerDatabase, order: pair.buyer,
    application: APPLICATION });
  const buyerStore = buyerDatabase.createLiveCoordinatorStore("buyer");
  await buyerStore.create({ role: "buyer", order: pair.buyer,
    bindingHash: pair.bindingHash, localBindingHash: pair.buyerLocalBindingHash });
  const buyerLoaded = await buyerStore.load("buyer", JOB_ID);
  if (buyerLoaded.status !== "ok") throw new Error("buyer order missing");

  const anchors = new Map<string, Readonly<Record<string, unknown>>>();
  function demos(
    role: "buyer" | "seller",
    authority: string,
    privateKey: KeyObject,
  ) {
    const anchorWriteOnce = vi.fn(async (
      logicalAddress: string,
      artifact: Readonly<Record<string, unknown>>,
    ) => {
      const address = `stor-${sha256Hex(logicalAddress).slice(0, 40)}`;
      const existing = anchors.get(address);
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(artifact)) {
        throw new Error("anchor conflict");
      }
      anchors.set(address, structuredClone(artifact));
      return { address, txRef: `tx:${address}` };
    });
    return Object.freeze({
      role,
      authority,
      signComponent: async (bytes: Uint8Array) => sign(null, bytes, privateKey),
      adapter: {
        anchorWriteOnce,
        resolveDemosAnchorReceipt: async (input: Readonly<{
          logicalAddress: string;
          nativeAddress: string;
          contentHash: string;
          writer: string;
        }>) => ({
          receiptVersion: "1" as const,
          substrate: "demos" as const,
          finalityProfile: "demos-bft-confirmed-native-read",
          logicalAddress: input.logicalAddress,
          nativeAddress: input.nativeAddress,
          contentHash: input.contentHash,
          transactionRef: { kind: "demos-storage-program", value: `tx:${input.nativeAddress}` },
          writer: input.writer,
          state: "finalized" as const,
          observationDisposition: "established" as const,
          observedAt: 1_800_000_000_100,
          blockRef: { id: `block:${input.nativeAddress}`, height: "42" },
          evidence: { kind: "demos-bft-write-proof-v1", value: "proof" },
        }),
        verifyDemosAnchorReceipt: vi.fn(async () => true),
        readAnchor: vi.fn(async (address: string) =>
          structuredClone(anchors.get(address) ?? null)),
      },
    });
  }
  const buyerSend = vi.fn(async () => acknowledgement());
  const sellerSend = vi.fn(async () => acknowledgement());
  const buyerEvm = privateKeyToAccount(`0x${"33".repeat(32)}`);
  const buyerContext = {
    role: "buyer",
    authority: buyer,
    peerAuthority: seller,
    database: buyerDatabase,
    demos: demos("buyer", buyer, buyerKeys.privateKey),
    config: {
      role: "buyer",
      rail: { requestedNetwork: "eip155:84532" },
      limits: { maxDemosNetworkFeeDem: "2" },
    },
    evm: {
      role: "buyer",
      address: buyerEvm.address,
      runtime: {
        network: "eip155:84532",
        chainId: 84532,
        payerAddress: buyerEvm.address,
        signIdentityPresentation: vi.fn(async (bundleHash: string) =>
          buyerEvm.signMessage({
            message: {
              raw: signedBytes("dacs-bundle-presentation:v1:", bundleHash),
            },
          })),
      },
    },
    sendMessage: buyerSend,
  } as never;
  const sellerContext = {
    role: "seller",
    authority: seller,
    peerAuthority: buyer,
    database: sellerDatabase,
    demos: demos("seller", seller, sellerKeys.privateKey),
    config: {
      role: "seller",
      rail: { requestedNetwork: "eip155:84532" },
      limits: { maxDemosNetworkFeeDem: "2" },
    },
    sendMessage: sellerSend,
  } as never;
  const buyerTransport = createDacsBuyerSessionBootstrapTransportRuntimeV1(buyerContext);
  const sellerStore = sellerDatabase.createLiveCoordinatorStore("seller");
  const startOrder = vi.fn(async () => sellerStore.create({
    role: "seller",
    order: pair.seller,
    bindingHash: pair.bindingHash,
    localBindingHash: pair.sellerLocalBindingHash,
  }));
  const sellerTransport = createDacsSellerSessionBootstrapTransportRuntimeV1({
    context: sellerContext,
    admitInit: () => ({ order: pair.seller, application: APPLICATION }),
  });
  return { buyerKeys, sellerKeys, buyer, seller, pair, buyerContext, sellerContext,
    buyerTransport, sellerTransport, buyerSend, sellerSend, buyerStore, sellerStore,
    startOrder, buyerOperation: operation(buyerLoaded.record) };
}

function lastMessage(mock: ReturnType<typeof vi.fn>) {
  const input = mock.mock.calls.at(-1)?.[0] as Readonly<{
    type: Exclude<DacsHttpMessageType, "acknowledgement">;
    payload: DacsHttpPayloadByType[Exclude<DacsHttpMessageType, "acknowledgement">];
  }> | undefined;
  if (input === undefined) throw new Error("outbound message missing");
  return input;
}

describe("session bootstrap agreement tracks", () => {
  it("runs two challenge-bound Vets concurrently before handing agreement to each role", async () => {
    const value = await fixture();
    const buyerAgreement = vi.fn(async () => ({
      status: "final" as const,
      outcome: "success" as const,
      reference: "buyer-agreement",
    }));
    const sellerAgreement = vi.fn(async () => ({
      status: "final" as const,
      outcome: "success" as const,
      reference: "seller-agreement",
    }));
    const proposalReady = { value: false };
    const buyerTrack = createDacsBuyerSessionBootstrapAgreementTrackV1({
      context: value.buyerContext,
      sessionBootstrap: value.buyerTransport,
      resolveRequirements: () => ({ buyer: EMPTY_REQUIREMENT, seller: EMPTY_REQUIREMENT }),
      agreement: buyerAgreement,
    });
    const sellerTrack = createDacsSellerSessionBootstrapAgreementTrackV1({
      context: value.sellerContext,
      sessionBootstrap: value.sellerTransport,
      resolveBuyerRequirement: () => EMPTY_REQUIREMENT,
      agreementProposalReady: () => proposalReady.value,
      agreement: sellerAgreement,
    });

    await expect(buyerTrack(value.buyerOperation)).resolves.toMatchObject({
      status: "pending-retry",
      reasonCode: "buyer-session-challenge-pending",
    });
    const init = lastMessage(value.buyerSend);
    expect(init.type).toBe("session-init");
    await expect(value.sellerTransport.handleMessage(await authenticated({
      type: "session-init",
      payload: init.payload as DacsHttpPayloadByType["session-init"],
      sender: value.buyer,
      audience: value.seller,
      privateKey: value.buyerKeys.privateKey,
      role: "buyer",
      nonceByte: 1,
    }), { role: "seller", coordinator: { startOrder: value.startOrder } } as never))
      .resolves.toEqual({ disposition: "accepted" });
    const sellerLoaded = await value.sellerStore.load("seller", JOB_ID);
    if (sellerLoaded.status !== "ok") throw new Error("seller order missing");
    const sellerOperation = operation(sellerLoaded.record);

    await expect(sellerTrack(sellerOperation)).resolves.toMatchObject({
      status: "pending-retry",
      reasonCode: "seller-session-presentation-pending",
    });
    const challenge = lastMessage(value.sellerSend);
    expect(challenge.type).toBe("session-challenge");
    await expect(value.buyerTransport.handleMessage(await authenticated({
      type: "session-challenge",
      payload: challenge.payload as DacsHttpPayloadByType["session-challenge"],
      sender: value.seller,
      audience: value.buyer,
      privateKey: value.sellerKeys.privateKey,
      role: "seller",
      nonceByte: 2,
    }), { role: "buyer" } as never)).resolves.toEqual({ disposition: "accepted" });

    await expect(buyerTrack(value.buyerOperation)).resolves.toMatchObject({
      status: "pending-retry",
      reasonCode: "buyer-session-admission-pending",
    });
    const presentation = lastMessage(value.buyerSend);
    expect(presentation.type).toBe("session-presentation");
    await expect(value.sellerTransport.handleMessage(await authenticated({
      type: "session-presentation",
      payload: presentation.payload as DacsHttpPayloadByType["session-presentation"],
      sender: value.buyer,
      audience: value.seller,
      privateKey: value.buyerKeys.privateKey,
      role: "buyer",
      nonceByte: 3,
    }), { role: "seller" } as never)).resolves.toEqual({ disposition: "accepted" });

    await expect(sellerTrack(sellerOperation)).resolves.toMatchObject({
      status: "pending-retry",
      reasonCode: "seller-agreement-proposal-pending",
    });
    const admission = lastMessage(value.sellerSend);
    expect(admission.type).toBe("session-admission");
    await expect(value.buyerTransport.handleMessage(await authenticated({
      type: "session-admission",
      payload: admission.payload as DacsHttpPayloadByType["session-admission"],
      sender: value.seller,
      audience: value.buyer,
      privateKey: value.sellerKeys.privateKey,
      role: "seller",
      nonceByte: 4,
    }), { role: "buyer" } as never)).resolves.toEqual({ disposition: "accepted" });

    await expect(buyerTrack(value.buyerOperation)).resolves.toMatchObject({
      status: "final",
      reference: "buyer-agreement",
    });
    const buyerFacts = loadDacsBuyerSessionAgreementFactsV1(
      value.buyerContext,
      value.buyerOperation,
    );
    expect(buyerFacts.buyerIdentity.claims).toEqual([
      { ref: value.buyer },
      { ref: expect.stringMatching(/^cci-xm:evm:84532:0x[0-9a-fA-F]{40}$/) },
    ]);
    expect(buyerFacts.buyerIdentity.presentation).toMatchObject({
      kind: "per-claim",
      signatures: [{ ref: value.buyer }, {
        ref: expect.stringMatching(/^cci-xm:evm:84532:/),
        signature: expect.stringMatching(/^0x[0-9a-fA-F]{130}$/),
      }],
    });
    expect(buyerFacts.buyerVetRecord.signature.signer).toBe(value.seller);
    expect(buyerFacts.sellerVetRecord.signature.signer).toBe(value.buyer);
    expect(buyerFacts.buyerVetReceipt.nativeAddress)
      .not.toBe(buyerFacts.sellerVetReceipt.nativeAddress);
    expect(buyerAgreement).toHaveBeenCalledTimes(1);

    proposalReady.value = true;
    await expect(sellerTrack(sellerOperation)).resolves.toMatchObject({
      status: "final",
      reference: "seller-agreement",
    });
    const sellerFacts = loadDacsSellerSessionAgreementFactsV1(
      value.sellerContext,
      sellerOperation,
    );
    expect(sellerFacts.buyerVetRecord.signature.signer).toBe(value.seller);
    expect(sellerAgreement).toHaveBeenCalledTimes(1);
  });

  it("rejects non-empty requirements before publishing identity or Vet effects", async () => {
    const value = await fixture();
    const track = createDacsBuyerSessionBootstrapAgreementTrackV1({
      context: value.buyerContext,
      sessionBootstrap: value.buyerTransport,
      resolveRequirements: () => ({
        buyer: EMPTY_REQUIREMENT,
        seller: {
          requirementVersion: "1",
          required: [{ scheme: "did", verificationRequired: true }],
        },
      }),
      agreement: vi.fn(),
    });
    await expect(track(value.buyerOperation)).resolves.toEqual({
      status: "operator-action",
      reasonCode: "buyer-session-requirements-invalid",
    });
    expect(value.buyerSend).not.toHaveBeenCalled();
  });
});

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

import { produceDacsEmptyRequirementSessionVetV1 } from "../src/sessionIdentityVetRuntime.js";

import { DACS_NODE_LIVE_PROFILE } from "../src/config.js";
import { createDacsFixedPriceX402OrderPairV1 } from "../src/liveOrder.js";
import { putDacsLiveOrderInputV1 } from "../src/orderInput.js";
import { retainDacsFixedPricePurchaseDemosBudgetGrantV1 } from
  "../src/purchaseDemosBudget.js";
import {
  advanceDacsVetTerminalTrackV1,
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
  DACS_VET_TERMINAL_PLAN_DISAGREEMENT,
  DACS_VET_TERMINAL_PLAN_DISAGREEMENT_NOTICE_PENDING,
  DacsVetTerminalBundleTransportError,
} from "../src/terminalBundleTransportRuntime.js";
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

    const checkpointDatabase = (value.buyerContext as unknown as { database: DacsNodeSqliteDatabase }).database;
    const checkpointPut = checkpointDatabase.putEffectIntent.bind(checkpointDatabase);
    const checkpointLock = vi.spyOn(checkpointDatabase, "putEffectIntent").mockImplementation((input) => {
      if ((input.input as { invocationVersion?: string }).invocationVersion === "1") {
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      }
      return checkpointPut(input);
    });
    await expect(buyerTrack(value.buyerOperation)).resolves.toMatchObject({
      status: "indeterminate", reasonCode: "buyer-session-seller-vet-invocation-invalid-busy",
    });
    checkpointLock.mockRestore();

    const recordLock = vi.spyOn(checkpointDatabase, "putEffectIntent").mockImplementation((input) => {
      if ((input.input as { record?: unknown }).record !== undefined) {
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      }
      return checkpointPut(input);
    });
    await expect(produceDacsEmptyRequirementSessionVetV1({
      context: value.buyerContext, operation: value.buyerOperation,
      evaluatedIdentity: (challenge.payload as DacsHttpPayloadByType["session-challenge"]).sellerIdentity,
      requirement: EMPTY_REQUIREMENT,
    })).resolves.toEqual({ status: "indeterminate", reasonCode: "session-vet-record-busy" });
    recordLock.mockRestore();
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

    const sellerCheckpointDatabase = (value.sellerContext as unknown as { database: DacsNodeSqliteDatabase }).database;
    const sellerPut = sellerCheckpointDatabase.putEffectIntent.bind(sellerCheckpointDatabase);
    const sellerLock = vi.spyOn(sellerCheckpointDatabase, "putEffectIntent");
    sellerLock.mockImplementation((input) => {
      if ((input.input as { invocationVersion?: string }).invocationVersion === "1") {
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_LOCKED" });
      }
      return sellerPut(input);
    });
    await expect(sellerTrack(sellerOperation)).resolves.toMatchObject({
      status: "indeterminate", reasonCode: "seller-session-buyer-vet-invocation-invalid-busy",
    });
    sellerLock.mockRestore();
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

    const buyerDatabase = (value.buyerContext as unknown as { database: DacsNodeSqliteDatabase }).database;
    const put = buyerDatabase.putEffectIntent.bind(buyerDatabase);
    const busy = vi.spyOn(buyerDatabase, "putEffectIntent").mockImplementation((input) => {
      if ((input.input as { phase?: string }).phase === "agreement") {
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      }
      return put(input);
    });
    await expect(buyerTrack(value.buyerOperation)).resolves.toMatchObject({
      status: "indeterminate", reasonCode: "pre-agreement-phase-corrupt-busy",
    });
    expect(buyerAgreement).not.toHaveBeenCalled();
    busy.mockRestore();
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

  it.each(["buyer", "seller"] as const)(
    "refuses custom non-empty Vet before any %s session effect", async (role) => {
      const value = await fixture();
      const nonEmpty = { requirementVersion: "1" as const,
        required: [{ scheme: "did", verificationRequired: true }] };
      const buyerAgreement = vi.fn();
      const sellerAgreement = vi.fn();
      const vet = { produce: vi.fn(async () => ({ status: "ready" as const,
        production: { record: { overallDecision: "pass" } } as never })),
        authenticate: vi.fn(async () => "valid" as const) };
      const buyerTrack = createDacsBuyerSessionBootstrapAgreementTrackV1({
        context: value.buyerContext, sessionBootstrap: value.buyerTransport,
        resolveRequirements: () => ({ buyer: role === "seller" ? nonEmpty : EMPTY_REQUIREMENT,
          seller: role === "buyer" ? nonEmpty : EMPTY_REQUIREMENT }),
        vet, agreement: buyerAgreement,
      });
      const sellerTrack = createDacsSellerSessionBootstrapAgreementTrackV1({
        context: value.sellerContext, sessionBootstrap: value.sellerTransport,
        resolveBuyerRequirement: () => role === "seller" ? nonEmpty : EMPTY_REQUIREMENT,
        ...(role === "seller" ? { vet } : {}), agreementProposalReady: () => true,
        agreement: sellerAgreement,
      });
      if (role === "buyer") {
        await expect(buyerTrack(value.buyerOperation)).resolves.toEqual({
          status: "operator-action", reasonCode: "buyer-session-requirements-invalid",
        });
      } else {
        // The seller refuses its unsupported requirement before even waiting
        // for init, so no transport or Vet effect can have happened.
        const sellerDatabase = (value.sellerContext as unknown as { database: DacsNodeSqliteDatabase }).database;
        putDacsLiveOrderInputV1({ database: sellerDatabase, order: value.pair.seller, application: APPLICATION });
        await value.startOrder();
        const loaded = await value.sellerStore.load("seller", JOB_ID);
        if (loaded.status !== "ok") throw new Error("seller order missing");
        await expect(sellerTrack(operation(loaded.record))).resolves.toEqual({
          status: "operator-action", reasonCode: "seller-session-requirement-invalid",
        });
      }
      expect(value.buyerSend).not.toHaveBeenCalled();
      expect(value.sellerSend).not.toHaveBeenCalled();
      expect(vet.produce).not.toHaveBeenCalled();
      expect(vet.authenticate).not.toHaveBeenCalled();
      expect(buyerAgreement).not.toHaveBeenCalled();
      expect(sellerAgreement).not.toHaveBeenCalled();
      expect(value.sellerSend).not.toHaveBeenCalledWith(expect.objectContaining({ type: "session-admission" }));
    });

  // DACS-2 VPC-4/VP-R4: every authenticated non-pass decision ends the phase.
  // A `fail` is the seller's fault; `indeterminate` or `error` is the buyer's
  // own `permanent` failure as the verifier.
  it.each<[
    "fail" | "indeterminate" | "error",
    string,
    string,
    Readonly<{ planHash?: string; nativeAddress?: unknown }>?,
  ]>([
    ["fail", "counterparty", "seller"],
    ["indeterminate", "permanent", "buyer"],
    ["error", "permanent", "buyer"],
    // A finalized bundle whose Vet phase carries no VPC-4 class is refused,
    // as is one that blames no party or names no plan or copy.
    ["fail", "transient", "seller"],
    ["fail", "counterparty", "verifier"],
    ["fail", "counterparty", "seller", { planHash: "A".repeat(64) }],
    ["fail", "counterparty", "seller", { nativeAddress: "" }],
    ["fail", "counterparty", "seller", { nativeAddress: 7 }],
  ])("stops before agreement and resumes a locally produced Vet %s (%s, %s)", async (decision, errorClass, faultedParty, finalised = {}) => {
    const refused = errorClass === "transient" || faultedParty === "verifier" || Object.keys(finalised).length > 0;
    const value = await fixture();
    const sellerTrack = createDacsSellerSessionBootstrapAgreementTrackV1({
      context: value.sellerContext,
      sessionBootstrap: value.sellerTransport,
      resolveBuyerRequirement: () => EMPTY_REQUIREMENT,
      agreementProposalReady: () => false,
      agreement: vi.fn(),
    });
    const supportedRequirement = Object.freeze({
      requirementVersion: "1" as const,
      required: [],
    });
    const production = Object.freeze({
      record: Object.freeze({ overallDecision: decision }),
    }) as never;
    const vet = {
      produce: vi.fn(async () => Object.freeze({
        status: "ready" as const,
        production,
      })),
      authenticate: vi.fn(async () => "valid" as const),
    };
    let registered = false;
    let advancesAfterRegistration = 0;
    const registerLocalTerminal = vi.fn(async () => {
      registered = true;
      return {} as never;
    });
    const advanceRegisteredTerminal = vi.fn(async () => {
      if (!registered) {
        throw new DacsVetTerminalBundleTransportError(
          "vet-terminal-material-unavailable",
        );
      }
      advancesAfterRegistration += 1;
      if (advancesAfterRegistration === 1) {
        return Object.freeze({
          disposition: "waiting" as const,
          stage: "signature-matrix" as const,
          reason: "counterparty contribution pending",
        });
      }
      return Object.freeze({
        disposition: "finalised" as const,
        recovered: true,
        result: {
          bundle: {
            faultedParty,
            phaseSummary: [{ index: 0, kind: "vet-credentials", outcome: "fail", errorClass }],
          },
          planHash: finalised.planHash ?? "a".repeat(64),
          publication: {
            nativeAddress: "nativeAddress" in finalised ? finalised.nativeAddress : "stor-terminal-buyer-copy",
          },
        },
      }) as never;
    });
    const createInput = vi.fn(() => ({ terminalInputVersion: "test" }) as never);
    const agreement = vi.fn();
    const buyerTrack = createDacsBuyerSessionBootstrapAgreementTrackV1({
      context: value.buyerContext,
      sessionBootstrap: value.buyerTransport,
      resolveRequirements: () => ({
        buyer: EMPTY_REQUIREMENT,
        seller: supportedRequirement,
      }),
      vet,
      terminalBundle: {
        runtime: {
          registerLocalTerminal,
          advanceRegisteredTerminal,
        } as never,
        createInput,
      },
      agreement,
    });

    await expect(buyerTrack(value.buyerOperation)).resolves.toMatchObject({
      reasonCode: "buyer-session-challenge-pending",
    });
    const init = lastMessage(value.buyerSend);
    await value.sellerTransport.handleMessage(await authenticated({
      type: "session-init",
      payload: init.payload as DacsHttpPayloadByType["session-init"],
      sender: value.buyer,
      audience: value.seller,
      privateKey: value.buyerKeys.privateKey,
      role: "buyer",
      nonceByte: 11,
    }), { role: "seller", coordinator: { startOrder: value.startOrder } } as never);
    const sellerLoaded = await value.sellerStore.load("seller", JOB_ID);
    if (sellerLoaded.status !== "ok") throw new Error("seller order missing");
    await sellerTrack(operation(sellerLoaded.record));
    const challenge = lastMessage(value.sellerSend);
    await value.buyerTransport.handleMessage(await authenticated({
      type: "session-challenge",
      payload: challenge.payload as DacsHttpPayloadByType["session-challenge"],
      sender: value.seller,
      audience: value.buyer,
      privateKey: value.sellerKeys.privateKey,
      role: "seller",
      nonceByte: 12,
    }), { role: "buyer" } as never);

    await expect(buyerTrack(value.buyerOperation)).resolves.toEqual({
      status: "pending-retry",
      reasonCode: "vet-terminal-finalization-pending",
      retryAt: expect.any(Number),
    });
    expect(createInput).toHaveBeenCalledWith(expect.objectContaining({
      evaluatedRole: "seller",
      production,
      vetInvokedAt: expect.any(Number),
    }));
    expect(registerLocalTerminal).toHaveBeenCalledTimes(1);
    expect(vet.produce).toHaveBeenCalledTimes(1);
    expect(agreement).not.toHaveBeenCalled();

    await expect(buyerTrack(value.buyerOperation)).resolves.toEqual(refused
      ? { status: "operator-action", reasonCode: "vet-terminal-finalization-invalid" }
      : {
          status: "final",
          outcome: "failure",
          errorClass,
          faultedParty,
          reference: "stor-terminal-buyer-copy",
          authenticationHash: "a".repeat(64),
        });
    expect(registerLocalTerminal).toHaveBeenCalledTimes(1);
    expect(vet.produce).toHaveBeenCalledTimes(1);
    expect(agreement).not.toHaveBeenCalled();
  });

  // Registering this role's own Vet result: a production not established yet
  // or a busy store is retried; a conflict or an invalid registration needs an
  // operator.
  const err = (reasonCode: string) => new DacsVetTerminalBundleTransportError(reasonCode);
  it.each<["pass" | "fail", () => unknown, Readonly<Record<string, unknown>>]>([
    ["fail", () => err("vet-terminal-production-indeterminate"),
      { status: "indeterminate", reasonCode: "vet-terminal-production-indeterminate" }],
    ["fail", () => err("agreement-vet-terminal-phase-conflict"),
      { status: "operator-action", reasonCode: "agreement-vet-terminal-phase-conflict" }],
    ["fail", () => err("vet-terminal-binding-conflict"),
      { status: "operator-action", reasonCode: "vet-terminal-registration-conflict" }],
    ["fail", () => err("vet-terminal-input-invalid"),
      { status: "operator-action", reasonCode: "vet-terminal-registration-invalid" }],
    ["fail", () => new TypeError("registration crashed"),
      { status: "operator-action", reasonCode: "vet-terminal-registration-invalid" }],
    ["fail", () => Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }),
      { status: "indeterminate", reasonCode: "vet-terminal-registration-invalid-busy" }],
    ["pass", () => err("vet-terminal-binding-conflict"),
      { status: "operator-action", reasonCode: "vet-terminal-registration-conflict" }],
    ["pass", () => new TypeError("store unavailable"),
      { status: "indeterminate", reasonCode: "vet-terminal-local-vet-unavailable" }],
  ])("classifies a local Vet %s whose registration throws (%#)", async (decision, thrown, expected) => {
    const value = await fixture();
    const sellerTrack = createDacsSellerSessionBootstrapAgreementTrackV1({
      context: value.sellerContext,
      sessionBootstrap: value.sellerTransport,
      resolveBuyerRequirement: () => EMPTY_REQUIREMENT,
      agreementProposalReady: () => false,
      agreement: vi.fn(),
    });
    const vet = {
      produce: vi.fn(async () => Object.freeze({
        status: "ready" as const,
        production: Object.freeze({ record: Object.freeze({ overallDecision: decision }) }) as never,
      })),
      authenticate: vi.fn(async () => "valid" as const),
    };
    const registerLocalTerminal = vi.fn(async () => { throw thrown(); });
    const registerLocalVetPass = vi.fn(async () => { throw thrown(); });
    const agreement = vi.fn();
    const buyerTrack = createDacsBuyerSessionBootstrapAgreementTrackV1({
      context: value.buyerContext,
      sessionBootstrap: value.buyerTransport,
      resolveRequirements: () => ({
        buyer: EMPTY_REQUIREMENT,
        seller: Object.freeze({
          requirementVersion: "1" as const,
          required: [],
        }),
      }),
      vet,
      terminalBundle: {
        runtime: {
          registerLocalTerminal,
          registerLocalVetPass,
          advanceRegisteredTerminal: vi.fn(async () => {
            throw new DacsVetTerminalBundleTransportError("vet-terminal-material-unavailable");
          }),
        } as never,
        createInput: vi.fn(() => ({ terminalInputVersion: "test" }) as never),
      },
      agreement,
    });
    await expect(buyerTrack(value.buyerOperation)).resolves.toMatchObject({
      reasonCode: "buyer-session-challenge-pending",
    });
    await value.sellerTransport.handleMessage(await authenticated({
      type: "session-init",
      payload: lastMessage(value.buyerSend).payload as DacsHttpPayloadByType["session-init"],
      sender: value.buyer,
      audience: value.seller,
      privateKey: value.buyerKeys.privateKey,
      role: "buyer",
      nonceByte: 11,
    }), { role: "seller", coordinator: { startOrder: value.startOrder } } as never);
    const sellerLoaded = await value.sellerStore.load("seller", JOB_ID);
    if (sellerLoaded.status !== "ok") throw new Error("seller order missing");
    await sellerTrack(operation(sellerLoaded.record));
    await value.buyerTransport.handleMessage(await authenticated({
      type: "session-challenge",
      payload: lastMessage(value.sellerSend).payload as DacsHttpPayloadByType["session-challenge"],
      sender: value.seller,
      audience: value.buyer,
      privateKey: value.sellerKeys.privateKey,
      role: "seller",
      nonceByte: 12,
    }), { role: "buyer" } as never);

    await expect(buyerTrack(value.buyerOperation)).resolves.toMatchObject(expected);
    expect(decision === "pass" ? registerLocalVetPass : registerLocalTerminal).toHaveBeenCalledTimes(1);
    expect(agreement).not.toHaveBeenCalled();
  });

  // Registration finds that the peer's first plan differs from this role's
  // own Vet failure, records the disagreement and throws. Operator action is
  // terminal, so the same tick sends this role's plan first; without it the
  // peer would wait for a signature that never comes.
  it("sends this role's plan before stopping on a disagreement found at registration", async () => {
    const value = await fixture();
    const sellerTrack = createDacsSellerSessionBootstrapAgreementTrackV1({
      context: value.sellerContext,
      sessionBootstrap: value.sellerTransport,
      resolveBuyerRequirement: () => EMPTY_REQUIREMENT,
      agreementProposalReady: () => false,
      agreement: vi.fn(),
    });
    const vet = {
      produce: vi.fn(async () => Object.freeze({
        status: "ready" as const,
        production: Object.freeze({
          record: Object.freeze({ overallDecision: "fail" as const }),
        }) as never,
      })),
      authenticate: vi.fn(async () => "valid" as const),
    };
    let registered = false;
    const registerLocalTerminal = vi.fn(async () => {
      // The runtime records the disagreement before it throws.
      registered = true;
      throw new DacsVetTerminalBundleTransportError(DACS_VET_TERMINAL_PLAN_DISAGREEMENT);
    });
    // Each advance after registration is one attempt to send this role's
    // plan: the first finds the peer unreachable, the second is acknowledged.
    const notices: string[] = [];
    const advanceRegisteredTerminal = vi.fn(async () => {
      if (!registered) {
        throw new DacsVetTerminalBundleTransportError("vet-terminal-material-unavailable");
      }
      notices.push(notices.length === 0 ? "unreachable" : "acknowledged");
      throw new DacsVetTerminalBundleTransportError(notices.length === 1
        ? DACS_VET_TERMINAL_PLAN_DISAGREEMENT_NOTICE_PENDING
        : DACS_VET_TERMINAL_PLAN_DISAGREEMENT);
    });
    const agreement = vi.fn();
    const buyerTrack = createDacsBuyerSessionBootstrapAgreementTrackV1({
      context: value.buyerContext,
      sessionBootstrap: value.buyerTransport,
      resolveRequirements: () => ({
        buyer: EMPTY_REQUIREMENT,
        seller: {
          requirementVersion: "1",
          required: [],
        },
      }),
      vet,
      terminalBundle: {
        runtime: { registerLocalTerminal, advanceRegisteredTerminal } as never,
        createInput: vi.fn(() => ({ terminalInputVersion: "test" }) as never),
      },
      agreement,
    });

    await expect(buyerTrack(value.buyerOperation)).resolves.toMatchObject({
      reasonCode: "buyer-session-challenge-pending",
    });
    const init = lastMessage(value.buyerSend);
    await value.sellerTransport.handleMessage(await authenticated({
      type: "session-init",
      payload: init.payload as DacsHttpPayloadByType["session-init"],
      sender: value.buyer,
      audience: value.seller,
      privateKey: value.buyerKeys.privateKey,
      role: "buyer",
      nonceByte: 11,
    }), { role: "seller", coordinator: { startOrder: value.startOrder } } as never);
    const sellerLoaded = await value.sellerStore.load("seller", JOB_ID);
    if (sellerLoaded.status !== "ok") throw new Error("seller order missing");
    await sellerTrack(operation(sellerLoaded.record));
    const challenge = lastMessage(value.sellerSend);
    await value.buyerTransport.handleMessage(await authenticated({
      type: "session-challenge",
      payload: challenge.payload as DacsHttpPayloadByType["session-challenge"],
      sender: value.seller,
      audience: value.buyer,
      privateKey: value.sellerKeys.privateKey,
      role: "seller",
      nonceByte: 12,
    }), { role: "buyer" } as never);

    await expect(buyerTrack(value.buyerOperation)).resolves.toEqual({
      status: "pending-retry",
      reasonCode: "vet-terminal-plan-disagreement-notice-pending",
      retryAt: expect.any(Number),
    });
    expect(notices).toEqual(["unreachable"]);
    await expect(buyerTrack(value.buyerOperation)).resolves.toEqual({
      status: "operator-action",
      reasonCode: "vet-terminal-plan-disagreement",
    });
    expect(notices).toEqual(["unreachable", "acknowledged"]);
    expect(registerLocalTerminal).toHaveBeenCalledTimes(1);
    expect(vet.produce).toHaveBeenCalledTimes(1);
    expect(agreement).not.toHaveBeenCalled();
  });

  // DACS-2 VPC-3: this role acts on a produced Vet only once it authenticates.
  it.each<[
    string,
    "pass" | "fail" | "indeterminate" | "error",
    "valid" | "invalid" | "indeterminate",
    Readonly<Record<string, unknown>>,
  ]>([
    ["an unauthenticated failure", "fail", "indeterminate",
      { status: "indeterminate", reasonCode: "buyer-session-seller-vet-pending" }],
    ["an unauthenticated pass", "pass", "indeterminate",
      { status: "indeterminate", reasonCode: "buyer-session-seller-vet-pending" }],
    ["an invalid pass", "pass", "invalid",
      { status: "operator-action", reasonCode: "buyer-session-seller-vet-invalid" }],
    // An authenticator that answers outside its contract, or throws, has not
    // authenticated anything: retry, never blame.
    ["a pass the authenticator answers with an unknown verdict", "pass", "authentic" as never,
      { status: "indeterminate", reasonCode: "buyer-session-seller-vet-pending" }],
    ["a pass whose authenticator throws", "pass", "throws" as never,
      { status: "indeterminate", reasonCode: "buyer-session-seller-vet-pending" }],
  ])("the buyer does not act on %s", async (_label, decision, authentication, expected) => {
    const value = await fixture();
    const sellerTrack = createDacsSellerSessionBootstrapAgreementTrackV1({
      context: value.sellerContext,
      sessionBootstrap: value.sellerTransport,
      resolveBuyerRequirement: () => EMPTY_REQUIREMENT,
      agreementProposalReady: () => false,
      agreement: vi.fn(),
    });
    const vet = {
      produce: vi.fn(async () => Object.freeze({
        status: "ready" as const,
        production: Object.freeze({ record: Object.freeze({ overallDecision: decision }) }) as never,
      })),
      authenticate: vi.fn(async () => {
        if (authentication === ("throws" as never)) throw new Error("authenticator unavailable");
        return authentication;
      }),
    };
    const registerLocalTerminal = vi.fn();
    const registerLocalVetPass = vi.fn();
    const agreement = vi.fn();
    const buyerTrack = createDacsBuyerSessionBootstrapAgreementTrackV1({
      context: value.buyerContext,
      sessionBootstrap: value.buyerTransport,
      resolveRequirements: () => ({
        buyer: EMPTY_REQUIREMENT,
        seller: Object.freeze({
          requirementVersion: "1" as const,
          required: [],
        }),
      }),
      vet,
      terminalBundle: {
        runtime: {
          registerLocalTerminal,
          registerLocalVetPass,
          // Nothing is registered for this job.
          advanceRegisteredTerminal: vi.fn(async () => {
            throw new DacsVetTerminalBundleTransportError("vet-terminal-material-unavailable");
          }),
        } as never,
        createInput: vi.fn(() => ({}) as never),
      },
      agreement,
    });
    await expect(buyerTrack(value.buyerOperation)).resolves.toMatchObject({
      reasonCode: "buyer-session-challenge-pending",
    });
    await value.sellerTransport.handleMessage(await authenticated({
      type: "session-init",
      payload: lastMessage(value.buyerSend).payload as DacsHttpPayloadByType["session-init"],
      sender: value.buyer,
      audience: value.seller,
      privateKey: value.buyerKeys.privateKey,
      role: "buyer",
      nonceByte: 11,
    }), { role: "seller", coordinator: { startOrder: value.startOrder } } as never);
    const sellerLoaded = await value.sellerStore.load("seller", JOB_ID);
    if (sellerLoaded.status !== "ok") throw new Error("seller order missing");
    await sellerTrack(operation(sellerLoaded.record));
    await value.buyerTransport.handleMessage(await authenticated({
      type: "session-challenge",
      payload: lastMessage(value.sellerSend).payload as DacsHttpPayloadByType["session-challenge"],
      sender: value.seller,
      audience: value.buyer,
      privateKey: value.sellerKeys.privateKey,
      role: "seller",
      nonceByte: 12,
    }), { role: "buyer" } as never);

    await expect(buyerTrack(value.buyerOperation)).resolves.toMatchObject(expected);
    expect(vet.authenticate).toHaveBeenCalled();
    expect(registerLocalTerminal).not.toHaveBeenCalled();
    expect(registerLocalVetPass).not.toHaveBeenCalled();
    expect(agreement).not.toHaveBeenCalled();
  });

  // An authenticated non-pass decision is this seller's terminal to produce
  // (DACS-2 VPC-4); it never admits the buyer.
  it.each<[
    string,
    "pass" | "fail" | "indeterminate" | "error",
    "valid" | "indeterminate",
    Readonly<Record<string, unknown>>,
    boolean,
  ]>([
    ["an unauthenticated failure", "fail", "indeterminate",
      { status: "indeterminate", reasonCode: "seller-session-buyer-vet-pending" }, false],
    ["an unauthenticated pass", "pass", "indeterminate",
      { status: "indeterminate", reasonCode: "seller-session-buyer-vet-pending" }, false],
    ["an authenticated failure", "fail", "valid", {}, true],
    ["an authenticated indeterminate decision", "indeterminate", "valid", {}, true],
    ["an authenticated error decision", "error", "valid", {}, true],
  ])("the seller does not admit the buyer on %s", async (_label, decision, authentication, expected, terminal) => {
    const value = await fixture();
    const vet = {
      produce: vi.fn(async () => Object.freeze({
        status: "ready" as const,
        production: Object.freeze({ record: Object.freeze({ overallDecision: decision }) }) as never,
      })),
      authenticate: vi.fn(async () => authentication),
    };
    const registerLocalTerminal = vi.fn();
    const registerLocalVetPass = vi.fn();
    const sellerAgreement = vi.fn();
    const buyerTrack = createDacsBuyerSessionBootstrapAgreementTrackV1({
      context: value.buyerContext,
      sessionBootstrap: value.buyerTransport,
      resolveRequirements: () => ({ buyer: EMPTY_REQUIREMENT, seller: EMPTY_REQUIREMENT }),
      agreement: vi.fn(),
    });
    const sellerTrack = createDacsSellerSessionBootstrapAgreementTrackV1({
      context: value.sellerContext,
      sessionBootstrap: value.sellerTransport,
      resolveBuyerRequirement: () => EMPTY_REQUIREMENT,
      agreementProposalReady: () => true,
      vet,
      terminalBundle: {
        runtime: {
          registerLocalTerminal,
          registerLocalVetPass,
          advanceRegisteredTerminal: vi.fn(async () => {
            throw new DacsVetTerminalBundleTransportError("vet-terminal-material-unavailable");
          }),
        } as never,
        createInput: vi.fn(() => ({}) as never),
      },
      agreement: sellerAgreement,
    });
    await buyerTrack(value.buyerOperation);
    await value.sellerTransport.handleMessage(await authenticated({
      type: "session-init",
      payload: lastMessage(value.buyerSend).payload as DacsHttpPayloadByType["session-init"],
      sender: value.buyer,
      audience: value.seller,
      privateKey: value.buyerKeys.privateKey,
      role: "buyer",
      nonceByte: 21,
    }), { role: "seller", coordinator: { startOrder: value.startOrder } } as never);
    const sellerLoaded = await value.sellerStore.load("seller", JOB_ID);
    if (sellerLoaded.status !== "ok") throw new Error("seller order missing");
    const sellerOperation = operation(sellerLoaded.record);
    await sellerTrack(sellerOperation);
    await value.buyerTransport.handleMessage(await authenticated({
      type: "session-challenge",
      payload: lastMessage(value.sellerSend).payload as DacsHttpPayloadByType["session-challenge"],
      sender: value.seller,
      audience: value.buyer,
      privateKey: value.sellerKeys.privateKey,
      role: "seller",
      nonceByte: 22,
    }), { role: "buyer" } as never);
    await expect(buyerTrack(value.buyerOperation)).resolves.toMatchObject({
      reasonCode: "buyer-session-admission-pending",
    });
    await value.sellerTransport.handleMessage(await authenticated({
      type: "session-presentation",
      payload: lastMessage(value.buyerSend).payload as DacsHttpPayloadByType["session-presentation"],
      sender: value.buyer,
      audience: value.seller,
      privateKey: value.buyerKeys.privateKey,
      role: "buyer",
      nonceByte: 23,
    }), { role: "seller" } as never);

    await expect(sellerTrack(sellerOperation)).resolves.toMatchObject(expected);
    expect(vet.authenticate).toHaveBeenCalled();
    expect(lastMessage(value.sellerSend).type).not.toBe("session-admission");
    expect(registerLocalTerminal).toHaveBeenCalledTimes(terminal ? 1 : 0);
    expect(registerLocalVetPass).not.toHaveBeenCalled();
    expect(sellerAgreement).not.toHaveBeenCalled();
  });

  it("keeps a registered terminal pending when recursive authentication is unavailable", async () => {
    const context = {
      database: { readTime: () => 10_000 },
    } as never;
    const runtime = {
      advanceRegisteredTerminal: vi.fn(async () => {
        throw new DacsVetTerminalBundleTransportError(
          "vet-terminal-production-indeterminate",
        );
      }),
    } as never;

    await expect(advanceDacsVetTerminalTrackV1(
      runtime,
      context,
      1_000,
      JOB_ID,
    )).resolves.toEqual({
      status: "indeterminate",
      reasonCode: "vet-terminal-production-indeterminate",
      retryAt: 11_000,
    });
  });
});

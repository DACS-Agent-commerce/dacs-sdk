import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createInMemoryFencedSessionStore,
  createTerminalBundleSignatureContribution,
  compositeVerificationAddress,
  terminalBundleSignedBytes,
  type PrepareVetTerminalBundleInput,
  type ProtocolAnchorReceipt,
  type TerminalBundlePlan,
} from "@kynesyslabs/dacs";
import type { CompositeVerificationRecord, IdentityBundle } from
  "@kynesyslabs/dacs/artifacts";
import { canonicalize, contentHash, sha256Hex } from "@kynesyslabs/dacs/canonical";
import {
  ed25519Sign,
  privateKeyFromSeed,
  publicKeyFromSeed,
  rawPublicKey,
} from "@kynesyslabs/dacs/crypto";
import {
  FIXED_PRICE_PAY_DEM_COMMERCE_PROFILE,
  FIXED_PRICE_PAY_DEM_REGISTRY_INDEX_REF,
  FIXED_PRICE_PAY_DEM_STANDARD_REVISION,
  FIXED_PRICE_X402_COMMERCE_PROFILE,
  FIXED_PRICE_X402_REGISTRY_INDEX_REF,
  FIXED_PRICE_X402_STANDARD_REVISION,
  fixedPriceX402OrderBindingHash,
  fixedPriceX402OrderLocalBindingHash,
  type FixedPriceX402OrderInput,
} from "@kynesyslabs/dacs/commerce";
import { identityBundleHash } from "@kynesyslabs/dacs/identity";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DACS_NODE_LIVE_PROFILE } from "../src/config.js";
import type { DacsDemosActorRuntimeV1 } from "../src/demosRuntime.js";
import { createDacsFixedPricePayDemOrderPairV1 } from "../src/liveOrder.js";
import { retainDacsFixedPricePurchaseDemosBudgetGrantV1 } from
  "../src/purchaseDemosBudget.js";
import type {
  DacsLiveRoleInboundOperationContextV1,
  DacsLiveRoleOperationContextV1,
} from "../src/roleRuntime.js";
import {
  openDacsNodeSqliteDatabase,
  type DacsNodeSqliteDatabase,
} from "../src/sqlite.js";
import {
  createDacsVetTerminalBundleTransportRuntimeV1,
  type DacsVetTerminalBundleTransportRuntimeV1,
} from "../src/terminalBundleTransportRuntime.js";
import type { DacsHttpAuthenticatedEnvelopeV1 } from
  "../src/transport/envelope.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const BUYER_SEED = new Uint8Array(32).fill(71);
const SELLER_SEED = new Uint8Array(32).fill(72);
const claim = (seed: Uint8Array) =>
  `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
const BUYER = claim(BUYER_SEED);
const SELLER = claim(SELLER_SEED);
const STARTED_AT = 1_800_000_000_000;

function identity(role: "buyer" | "seller"): IdentityBundle {
  const presentedBy = role === "buyer" ? BUYER : SELLER;
  return {
    bundleVersion: "1" as const,
    presentedBy,
    presentedAt: STARTED_AT - 1_000,
    sessionNonce: `terminal-${role}`,
    claims: [{ ref: presentedBy }],
    presentation: {
      kind: "session-key" as const,
      key: `terminal-${role}-session-key`,
      signature: `terminal-${role}-presentation`,
    },
  };
}

function terminalInput(
  decision: CompositeVerificationRecord["overallDecision"] = "fail",
  paymentPhase: "pay-x402" | "pay-dem" = "pay-x402",
): PrepareVetTerminalBundleInput {
  const sellerIdentity = identity("seller");
  const logicalAddress = compositeVerificationAddress(JOB_ID, SELLER);
  const record: CompositeVerificationRecord = {
    recordVersion: "1",
    jobId: JOB_ID,
    evaluatedParty: SELLER,
    bundleHash: identityBundleHash(sellerIdentity),
    requirementHash: "3".repeat(64),
    freshness: [],
    supplementary: [],
    dealSpecific: [],
    overallDecision: decision,
    generatedAt: STARTED_AT + 100,
    signature: {
      algorithm: "ed25519",
      signer: BUYER,
      value: Buffer.alloc(64, 7).toString("base64url"),
    },
  };
  const recordHash = contentHash(record as unknown as Record<string, unknown>);
  const nativeAddress = `stor-${"4".repeat(64)}`;
  return {
    jobId: JOB_ID,
    listingRef: {
      listingId: "terminal-listing",
      version: 1,
      contentHash: "8".repeat(64),
    },
    pipeline: [
      { kind: "vet-credentials" },
      { kind: "negotiate-fixed-price" },
      { kind: "commit-agreement" },
      paymentPhase === "pay-x402"
        ? { kind: "pay-x402", parameters: { rail: "x402:terminal" } }
        : { kind: "pay-dem", parameters: { rail: "demos-native:DEM" } },
      { kind: "deliver-attested-payload" },
    ],
    vetPhaseIndex: 0,
    vetInvokedAt: STARTED_AT + 50,
    startedAt: STARTED_AT,
    recipeRegistryVersion: 1,
    railRegistryVersion: 1,
    parties: [
      { role: "buyer", identityBundle: identity("buyer") },
      { role: "seller", identityBundle: sellerIdentity },
    ],
    evaluatedRole: "seller",
    production: {
      record,
      recordRef: {
        anchor: { kind: "storage-program", locator: nativeAddress },
        contentHash: recordHash,
        signer: BUYER,
      },
      anchorReceipt: {
        receiptVersion: "1",
        substrate: "demos",
        finalityProfile: "demos-bft",
        logicalAddress,
        nativeAddress,
        contentHash: recordHash,
        transactionRef: { kind: "demos", value: "5".repeat(64) },
        writer: BUYER,
        nonce: "7",
        state: "finalized",
        observationDisposition: "established",
        observedAt: STARTED_AT + 500,
        blockRef: {
          id: "6".repeat(64),
          height: "42",
          timestamp: STARTED_AT + 450,
        },
        evidence: { kind: "demos-bft", value: "7".repeat(64) },
      },
    },
  };
}

function contribution(
  exactPlan: Readonly<TerminalBundlePlan>,
  role: "buyer" | "seller",
) {
  const privateKey = privateKeyFromSeed(role === "buyer" ? BUYER_SEED : SELLER_SEED);
  return createTerminalBundleSignatureContribution(
    exactPlan,
    role,
    exactPlan.copies.map((copy) => ({
      copyRole: copy.role,
      value: Buffer.from(ed25519Sign(
        terminalBundleSignedBytes(copy),
        privateKey,
      )).toString("base64url"),
    })),
  );
}

function order(role: "buyer" | "seller"): FixedPriceX402OrderInput {
  return {
    jobId: JOB_ID,
    buyer: BUYER,
    seller: SELLER,
    protocol: {
      commerceProfile: FIXED_PRICE_X402_COMMERCE_PROFILE,
      standardRevision: FIXED_PRICE_X402_STANDARD_REVISION,
      phase: "pay-x402",
      orchestratorTopology: "seller-as-phase-orchestrator-v1",
      orchestrator: SELLER,
      rail: {
        registryIndexRef: FIXED_PRICE_X402_REGISTRY_INDEX_REF,
        registryIndexHash: "9".repeat(64),
        railDefinitionRef: "dacs4:rail:x402%3Aterminal:1",
        railDefinitionHash: "a".repeat(64),
        railId: "x402:terminal",
        railVersion: 1,
        railType: "x402",
        phaseHandler: "pay-x402",
        network: "eip155:84532",
        availability: "live",
      },
    },
    sdkJobs: role === "buyer"
      ? {
          role,
          agreement: `buyer:agreement:${JOB_ID}`,
          payment: `buyer:payment:${JOB_ID}`,
          paymentEvidence: `buyer:payment-evidence:${JOB_ID}`,
          buyerReceived: `buyer:received:${JOB_ID}`,
          audit: `buyer:audit:${JOB_ID}`,
        }
      : {
          role,
          agreement: `seller:agreement:${JOB_ID}`,
          payment: `seller:payment:${JOB_ID}`,
          paymentEvidence: `seller:payment-evidence:${JOB_ID}`,
          fulfilment: `seller:fulfilment:${JOB_ID}`,
          deliveryEvidence: `seller:delivery-evidence:${JOB_ID}`,
          audit: `seller:audit:${JOB_ID}`,
        },
  };
}

function authenticated(
  type:
    | "terminal-bundle-proposal-buyer"
    | "terminal-bundle-proposal-seller"
    | "terminal-bundle-contribution-buyer"
    | "terminal-bundle-contribution-seller",
  payload: unknown,
  sender: string,
  audience: string,
): Readonly<DacsHttpAuthenticatedEnvelopeV1> {
  return {
    status: "authenticated",
    envelope: {
      version: "1",
      type,
      envelopeId: "b".repeat(64),
      jobId: JOB_ID,
      sender,
      audience,
      keyId: sender,
      algorithm: "ed25519",
      issuedAt: 1_800_000_000_000,
      expiresAt: 1_800_000_060_000,
      nonce: Buffer.alloc(32, 1).toString("base64url"),
      payloadHash: sha256Hex(canonicalize(payload)),
      payload,
      signature: Buffer.alloc(64, 2).toString("base64url"),
    },
    authenticationHash: "c".repeat(64),
    identityEvidenceHash: "d".repeat(64),
    identityRole: sender === BUYER ? "buyer" : "seller",
    receivedAt: 1_800_000_000_001,
  } as unknown as Readonly<DacsHttpAuthenticatedEnvelopeV1>;
}

function acknowledgement(disposition: "accepted" | "existing" | "rejected") {
  return {
    envelope: { type: "acknowledgement", payload: { disposition } },
  } as unknown as Readonly<DacsHttpAuthenticatedEnvelopeV1>;
}

describe("role-separated Vet terminal bundle transport", () => {
  const roots: string[] = [];
  const databases: DacsNodeSqliteDatabase[] = [];

  afterEach(() => {
    for (const database of databases.splice(0).reverse()) database.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function open(
    role: "buyer" | "seller",
    rail: "x402" | "pay-dem" = "x402",
  ): Promise<DacsNodeSqliteDatabase> {
    const root = mkdtempSync(join(tmpdir(), `dacs-vet-terminal-${role}-`));
    roots.push(root);
    const database = await openDacsNodeSqliteDatabase({
      databasePath: join(root, "actor.sqlite"),
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role,
      authority: role === "buyer" ? BUYER : SELLER,
    });
    databases.push(database);
    if (rail === "x402") {
      const exactOrder = order(role);
      await database.createLiveCoordinatorStore(role).create({
        role,
        order: exactOrder,
        bindingHash: fixedPriceX402OrderBindingHash(exactOrder),
        localBindingHash: fixedPriceX402OrderLocalBindingHash(exactOrder),
      });
    } else {
      const pair = createDacsFixedPricePayDemOrderPairV1({
        jobId: JOB_ID,
        buyer: BUYER,
        seller: SELLER,
        protocol: {
          commerceProfile: FIXED_PRICE_PAY_DEM_COMMERCE_PROFILE,
          standardRevision: FIXED_PRICE_PAY_DEM_STANDARD_REVISION,
          phase: "pay-dem",
          orchestratorTopology: "seller-as-phase-orchestrator-v1",
          orchestrator: SELLER,
          rail: {
            registryIndexRef: FIXED_PRICE_PAY_DEM_REGISTRY_INDEX_REF,
            registryIndexHash: "9".repeat(64),
            railDefinitionRef: "dacs4:rail:demos-native%3ADEM:1",
            railDefinitionHash: "a".repeat(64),
            railId: "demos-native:DEM",
            railVersion: 1,
            railType: "demos-native",
            phaseHandler: "pay-dem",
            network: "demos",
            availability: "live",
          },
        },
      });
      await database.createPayDemCoordinatorStore(role).create({
        role,
        order: pair[role],
        bindingHash: pair.bindingHash,
        localBindingHash: role === "buyer"
          ? pair.buyerLocalBindingHash : pair.sellerLocalBindingHash,
      });
    }
    return database;
  }

  it("exchanges one exact authorized plan and each role's own verified row", async () => {
    const buyerDatabase = await open("buyer");
    const sellerDatabase = await open("seller");
    const buyerAuthenticate = vi.fn(async () => ({ status: "valid" as const }));
    const sellerAuthenticate = vi.fn(async () => ({ status: "valid" as const }));
    let buyerRuntime: Readonly<DacsVetTerminalBundleTransportRuntimeV1>;
    let sellerRuntime: Readonly<DacsVetTerminalBundleTransportRuntimeV1>;
    const buyerSend = vi.fn(async (message: Readonly<{ type: string; payload: unknown }>) => {
      const result = await sellerRuntime.handleMessage(
        authenticated(message.type as never, message.payload, BUYER, SELLER),
        { role: "seller" } as DacsLiveRoleInboundOperationContextV1,
      );
      return acknowledgement(result.disposition);
    });
    const sellerSend = vi.fn(async (message: Readonly<{ type: string; payload: unknown }>) => {
      const result = await buyerRuntime.handleMessage(
        authenticated(message.type as never, message.payload, SELLER, BUYER),
        { role: "buyer" } as DacsLiveRoleInboundOperationContextV1,
      );
      return acknowledgement(result.disposition);
    });
    const buyerContext = {
      role: "buyer", authority: BUYER, peerAuthority: SELLER,
      database: buyerDatabase, sendMessage: buyerSend,
    } as unknown as DacsLiveRoleOperationContextV1;
    const sellerContext = {
      role: "seller", authority: SELLER, peerAuthority: BUYER,
      database: sellerDatabase, sendMessage: sellerSend,
    } as unknown as DacsLiveRoleOperationContextV1;
    buyerRuntime = createDacsVetTerminalBundleTransportRuntimeV1({
      context: buyerContext,
      authenticateProduction: buyerAuthenticate,
    });
    sellerRuntime = createDacsVetTerminalBundleTransportRuntimeV1({
      context: sellerContext,
      authenticateProduction: sellerAuthenticate,
    });
    const registered = await buyerRuntime.registerLocalTerminal(terminalInput());
    const exactPlan = registered.proposal.plan;
    const transportIdentity = {
      jobId: JOB_ID,
      authorityHash: exactPlan.authorityHash,
      planHash: exactPlan.planHash,
    };

    await buyerRuntime.transport.publishProposal({
      identity: transportIdentity,
      plan: exactPlan,
    }, {} as never);
    await expect(buyerRuntime.transport.resolveProposal(transportIdentity))
      .resolves.toMatchObject({ disposition: "present", value: exactPlan });
    await expect(sellerRuntime.transport.resolveProposal(transportIdentity))
      .resolves.toMatchObject({ disposition: "present", value: exactPlan });
    expect(buyerAuthenticate).toHaveBeenCalled();
    expect(sellerAuthenticate).toHaveBeenCalled();

    const buyerContribution = contribution(exactPlan, "buyer");
    const sellerContribution = contribution(exactPlan, "seller");
    await buyerRuntime.transport.publishContribution({
      identity: transportIdentity,
      contribution: buyerContribution,
    }, {} as never);
    await sellerRuntime.transport.publishContribution({
      identity: transportIdentity,
      contribution: sellerContribution,
    }, {} as never);
    await expect(buyerRuntime.transport.resolveContribution({
      identity: transportIdentity,
      signerRole: "seller",
    })).resolves.toMatchObject({ disposition: "present", value: sellerContribution });
    await expect(sellerRuntime.transport.resolveContribution({
      identity: transportIdentity,
      signerRole: "buyer",
    })).resolves.toMatchObject({ disposition: "present", value: buyerContribution });

    const restartedBuyer = createDacsVetTerminalBundleTransportRuntimeV1({
      context: buyerContext,
      authenticateProduction: buyerAuthenticate,
    });
    await expect(restartedBuyer.transport.resolveContribution({
      identity: transportIdentity,
      signerRole: "seller",
    })).resolves.toMatchObject({ disposition: "present", value: sellerContribution });
    expect(buyerSend).toHaveBeenCalledTimes(2);
    expect(sellerSend).toHaveBeenCalledOnce();
  });

  it("durably finalizes both role-owned bundles and recovers the exact heads", async () => {
    const buyerDatabase = await open("buyer");
    const sellerDatabase = await open("seller");
    retainDacsFixedPricePurchaseDemosBudgetGrantV1({
      database: buyerDatabase,
      jobId: JOB_ID,
      role: "buyer",
      authority: BUYER,
      maximumPerWriteFeeDem: "1",
    });
    retainDacsFixedPricePurchaseDemosBudgetGrantV1({
      database: sellerDatabase,
      jobId: JOB_ID,
      role: "seller",
      authority: SELLER,
      maximumPerWriteFeeDem: "1",
    });
    type StoredAnchor = Readonly<{
      address: string;
      value: Readonly<Record<string, unknown>>;
      receipt: Readonly<ProtocolAnchorReceipt>;
    }>;
    const byName = new Map<string, StoredAnchor>();
    const byAddress = new Map<string, StoredAnchor>();
    const demos = (role: "buyer" | "seller"): Readonly<DacsDemosActorRuntimeV1> => {
      const authority = role === "buyer" ? BUYER : SELLER;
      const seed = role === "buyer" ? BUYER_SEED : SELLER_SEED;
      const owner = authority.slice("did:demos:agent:".length);
      const adapter = {
        raw: {
          getNetworkInfo: async () => ({}),
          getAddressNonce: async () => 0,
          getAddressInfo: async () => ({}),
        },
        connect: async () => undefined,
        getAddress: () => owner,
        getPublicKey: async () => rawPublicKey(publicKeyFromSeed(seed)),
        sign: async (bytes: Uint8Array) => ed25519Sign(
          bytes,
          privateKeyFromSeed(seed),
        ),
        resolveIdentity: async (ref: string) => ({ ref, raw: {} }),
        readAnchor: async (address: string) =>
          structuredClone(byAddress.get(address)?.value ?? null),
        resolveAnchorByName: async (name: string, expectedOwner: string) => {
          const retained = byName.get(`${expectedOwner}:${name}`);
          return retained === undefined
            ? { status: "absent" as const }
            : { status: "present" as const, address: retained.address };
        },
        scanOwnAnchorsByNamePrefix: async () => ({
          status: "ok" as const,
          anchors: [],
        }),
        anchorWriteOnce: async (
          name: string,
          value: object,
          options?: Readonly<{ metadata?: Readonly<Record<string, unknown>> }>,
        ) => {
          const key = `${owner}:${name}`;
          const exactValue = structuredClone(value) as Readonly<Record<string, unknown>>;
          const retained = byName.get(key);
          if (retained !== undefined) {
            if (canonicalize(retained.value) !== canonicalize(exactValue)) throw new Error();
            return { address: retained.address, txRef: retained.receipt.transactionRef.value };
          }
          const hash = typeof options?.metadata?.contentHash === "string"
            ? options.metadata.contentHash : contentHash(exactValue);
          const address = `stor-${sha256Hex(canonicalize({ owner, name }))}`;
          const receipt: ProtocolAnchorReceipt = {
            receiptVersion: "1",
            substrate: "demos",
            finalityProfile: "demos-bft-confirmed-native-read",
            logicalAddress: name,
            nativeAddress: address,
            contentHash: hash,
            transactionRef: { kind: "demos", value: sha256Hex(address) },
            writer: authority,
            nonce: String(byName.size + 1),
            state: "finalized",
            observationDisposition: "established",
            observedAt: STARTED_AT + 1_000 + byName.size,
            blockRef: { id: sha256Hex(`block:${address}`), height: "43" },
            evidence: { kind: "demos-bft", value: sha256Hex(`proof:${address}`) },
          };
          const stored = Object.freeze({ address, value: exactValue, receipt });
          byName.set(key, stored);
          byAddress.set(address, stored);
          return { address, txRef: receipt.transactionRef.value };
        },
        verifyDemosAnchorReceipt: async (receipt: Readonly<ProtocolAnchorReceipt>) => {
          const retained = byAddress.get(receipt.nativeAddress);
          return retained !== undefined &&
            canonicalize(retained.receipt) === canonicalize(receipt);
        },
        resolveDemosAnchorReceipt: async (input: Readonly<{
          logicalAddress: string;
          nativeAddress: string;
          contentHash: string;
          writer: string;
        }>) => {
          const retained = byAddress.get(input.nativeAddress);
          return retained !== undefined &&
              retained.receipt.logicalAddress === input.logicalAddress &&
              retained.receipt.contentHash === input.contentHash &&
              retained.receipt.writer === input.writer
            ? structuredClone(retained.receipt) : null;
        },
        reconcileWalletJournal: async () => undefined,
        reconcileNativeTransferJournal: async () => undefined,
      };
      return {
        role,
        authority,
        walletAddress: owner,
        publicKey: rawPublicKey(publicKeyFromSeed(seed)),
        adapter,
        signTransportEnvelope: async (bytes: Uint8Array) => ed25519Sign(
          bytes,
          privateKeyFromSeed(seed),
        ),
        signComponent: async (bytes: Uint8Array) => ed25519Sign(
          bytes,
          privateKeyFromSeed(seed),
        ),
        networkInfo: async () => ({}),
        addressNonce: async () => 0,
        addressInfo: async () => ({}),
      } as unknown as Readonly<DacsDemosActorRuntimeV1>;
    };

    let buyerRuntime: Readonly<DacsVetTerminalBundleTransportRuntimeV1>;
    let sellerRuntime: Readonly<DacsVetTerminalBundleTransportRuntimeV1>;
    const buyerContext = {
      role: "buyer", authority: BUYER, peerAuthority: SELLER,
      config: { role: "buyer" },
      database: buyerDatabase,
      demos: demos("buyer"),
      sessionStore: createInMemoryFencedSessionStore(),
      sendMessage: async (message: Readonly<{ type: string; payload: unknown }>) => {
        const result = await sellerRuntime.handleMessage(
          authenticated(message.type as never, message.payload, BUYER, SELLER),
          { role: "seller" } as DacsLiveRoleInboundOperationContextV1,
        );
        return acknowledgement(result.disposition);
      },
    } as unknown as DacsLiveRoleOperationContextV1;
    const sellerContext = {
      role: "seller", authority: SELLER, peerAuthority: BUYER,
      config: { role: "seller" },
      database: sellerDatabase,
      demos: demos("seller"),
      sessionStore: createInMemoryFencedSessionStore(),
      sendMessage: async (message: Readonly<{ type: string; payload: unknown }>) => {
        const result = await buyerRuntime.handleMessage(
          authenticated(message.type as never, message.payload, SELLER, BUYER),
          { role: "buyer" } as DacsLiveRoleInboundOperationContextV1,
        );
        return acknowledgement(result.disposition);
      },
    } as unknown as DacsLiveRoleOperationContextV1;
    buyerRuntime = createDacsVetTerminalBundleTransportRuntimeV1({
      context: buyerContext,
      authenticateProduction: async () => ({ status: "valid" }),
    });
    sellerRuntime = createDacsVetTerminalBundleTransportRuntimeV1({
      context: sellerContext,
      authenticateProduction: async () => ({ status: "valid" }),
    });
    await buyerRuntime.registerLocalTerminal(terminalInput());

    await expect(buyerRuntime.advanceRegisteredTerminal(JOB_ID)).resolves.toMatchObject({
      disposition: "waiting",
    });
    const sellerProgress = await sellerRuntime.advanceRegisteredTerminal(JOB_ID);
    expect(
      sellerProgress.disposition,
      JSON.stringify(sellerProgress),
    ).toBe("finalised");
    await expect(buyerRuntime.advanceRegisteredTerminal(JOB_ID)).resolves.toMatchObject({
      disposition: "finalised",
    });
    expect(byName).toHaveProperty("size", 4);

    const restartedBuyer = createDacsVetTerminalBundleTransportRuntimeV1({
      context: buyerContext,
      authenticateProduction: async () => ({ status: "valid" }),
    });
    await expect(restartedBuyer.advanceRegisteredTerminal(JOB_ID)).resolves.toMatchObject({
      disposition: "finalised",
      recovered: true,
    });
    expect(byName).toHaveProperty("size", 4);
  }, 15_000);

  it("does not retain or sign a plan the peer cannot independently authorize", async () => {
    const buyerDatabase = await open("buyer");
    const sellerDatabase = await open("seller");
    let buyerRuntime: Readonly<DacsVetTerminalBundleTransportRuntimeV1>;
    const buyerContext = {
      role: "buyer", authority: BUYER, peerAuthority: SELLER,
      database: buyerDatabase,
      sendMessage: vi.fn(),
    } as unknown as DacsLiveRoleOperationContextV1;
    const sellerContext = {
      role: "seller", authority: SELLER, peerAuthority: BUYER,
      database: sellerDatabase,
      sendMessage: async (message: Readonly<{ type: string; payload: unknown }>) => {
        const result = await buyerRuntime.handleMessage(
          authenticated(message.type as never, message.payload, SELLER, BUYER),
          { role: "buyer" } as DacsLiveRoleInboundOperationContextV1,
        );
        return acknowledgement(result.disposition);
      },
    } as unknown as DacsLiveRoleOperationContextV1;
    buyerRuntime = createDacsVetTerminalBundleTransportRuntimeV1({
      context: buyerContext,
      authenticateProduction: async () => ({
        status: "invalid",
        reason: "Vet failure not authenticated",
      }),
    });
    const sellerRuntime = createDacsVetTerminalBundleTransportRuntimeV1({
      context: sellerContext,
      authenticateProduction: async () => ({ status: "valid" }),
    });
    const registered = await sellerRuntime.registerLocalTerminal(terminalInput());
    const exactPlan = registered.proposal.plan;
    const transportIdentity = {
      jobId: JOB_ID,
      authorityHash: exactPlan.authorityHash,
      planHash: exactPlan.planHash,
    };
    await expect(sellerRuntime.transport.publishProposal({
      identity: transportIdentity,
      plan: exactPlan,
    }, {} as never)).rejects.toMatchObject({
      reasonCode: "vet-terminal-proposal-rejected",
    });
    await expect(buyerRuntime.transport.resolveProposal(transportIdentity)).resolves.toEqual({
      disposition: "authoritatively-absent",
      reason: "vet-terminal-proposal-absent",
    });
    await expect(sellerRuntime.transport.resolveProposal(transportIdentity)).resolves.toEqual({
      disposition: "authoritatively-absent",
      reason: "vet-terminal-proposal-absent",
    });
  });

  it("recovers the exact proposal after the peer retained it but the acknowledgement was lost", async () => {
    const buyerDatabase = await open("buyer");
    const sellerDatabase = await open("seller");
    let sellerRuntime: Readonly<DacsVetTerminalBundleTransportRuntimeV1>;
    let attempt = 0;
    const buyerContext = {
      role: "buyer", authority: BUYER, peerAuthority: SELLER,
      database: buyerDatabase,
      sendMessage: async (message: Readonly<{ type: string; payload: unknown }>) => {
        const result = await sellerRuntime.handleMessage(
          authenticated(message.type as never, message.payload, BUYER, SELLER),
          { role: "seller" } as DacsLiveRoleInboundOperationContextV1,
        );
        attempt += 1;
        if (attempt === 1) throw new Error("acknowledgement lost");
        return acknowledgement(result.disposition === "accepted" ? "existing" : "rejected");
      },
    } as unknown as DacsLiveRoleOperationContextV1;
    const sellerContext = {
      role: "seller", authority: SELLER, peerAuthority: BUYER,
      database: sellerDatabase, sendMessage: vi.fn(),
    } as unknown as DacsLiveRoleOperationContextV1;
    const buyerRuntime = createDacsVetTerminalBundleTransportRuntimeV1({
      context: buyerContext,
      authenticateProduction: async () => ({ status: "valid" }),
    });
    sellerRuntime = createDacsVetTerminalBundleTransportRuntimeV1({
      context: sellerContext,
      authenticateProduction: async () => ({ status: "valid" }),
    });
    const registered = await buyerRuntime.registerLocalTerminal(terminalInput());
    const identity = {
      jobId: JOB_ID,
      authorityHash: registered.proposal.plan.authorityHash,
      planHash: registered.proposal.plan.planHash,
    };

    await expect(buyerRuntime.transport.publishProposal({
      identity,
      plan: registered.proposal.plan,
    }, {} as never)).rejects.toThrow("acknowledgement lost");
    await expect(buyerRuntime.transport.resolveProposal(identity)).resolves.toEqual({
      disposition: "authoritatively-absent",
      reason: "vet-terminal-proposal-absent",
    });
    await expect(sellerRuntime.transport.resolveProposal(identity)).resolves.toMatchObject({
      disposition: "present",
      value: registered.proposal.plan,
    });

    await expect(buyerRuntime.transport.publishProposal({
      identity,
      plan: registered.proposal.plan,
    }, {} as never)).resolves.toBeUndefined();
    await expect(buyerRuntime.transport.resolveProposal(identity)).resolves.toMatchObject({
      disposition: "present",
      value: registered.proposal.plan,
    });
    expect(attempt).toBe(2);
  });

  it("keeps an authentication outage pending without retaining terminal authority", async () => {
    const buyerDatabase = await open("buyer");
    const context = {
      role: "buyer", authority: BUYER, peerAuthority: SELLER,
      database: buyerDatabase, sendMessage: vi.fn(),
    } as unknown as DacsLiveRoleOperationContextV1;
    const validRuntime = createDacsVetTerminalBundleTransportRuntimeV1({
      context,
      authenticateProduction: async () => ({ status: "valid" }),
    });
    const registered = await validRuntime.registerLocalTerminal(terminalInput());
    const unavailableRuntime = createDacsVetTerminalBundleTransportRuntimeV1({
      context,
      authenticateProduction: async () => ({
        status: "indeterminate",
        reason: "recursive Vet evidence unavailable",
      }),
    });

    await expect(unavailableRuntime.handleMessage(
      authenticated(
        "terminal-bundle-proposal-seller",
        registered.proposal,
        SELLER,
        BUYER,
      ),
      { role: "buyer" } as DacsLiveRoleInboundOperationContextV1,
    )).rejects.toMatchObject({
      reasonCode: "vet-terminal-production-indeterminate",
    });
    await expect(unavailableRuntime.transport.resolveProposal({
      jobId: JOB_ID,
      authorityHash: registered.proposal.plan.authorityHash,
      planHash: registered.proposal.plan.planHash,
    })).resolves.toEqual({
      disposition: "authoritatively-absent",
      reason: "vet-terminal-proposal-absent",
    });
  });

  it("accepts native DEM terminal material but rejects a substituted rail pipeline", async () => {
    const buyerDatabase = await open("buyer", "pay-dem");
    const context = {
      role: "buyer", authority: BUYER, peerAuthority: SELLER,
      database: buyerDatabase, sendMessage: vi.fn(),
    } as unknown as DacsLiveRoleOperationContextV1;
    const runtime = createDacsVetTerminalBundleTransportRuntimeV1({
      context,
      authenticateProduction: async () => ({ status: "valid" }),
    });

    await expect(runtime.registerLocalTerminal(
      terminalInput("fail", "pay-dem"),
    )).resolves.toMatchObject({
      prepared: { status: "terminal" },
      proposal: { plan: { authority: { faultedParty: "seller" } } },
    });
    await expect(runtime.registerLocalTerminal(
      terminalInput("fail", "pay-x402"),
    )).rejects.toMatchObject({
      reasonCode: "vet-terminal-proposal-rail-mismatch",
    });
  });

  it("rejects a contribution whose detached signature row was altered", async () => {
    const buyerDatabase = await open("buyer");
    const buyerContext = {
      role: "buyer", authority: BUYER, peerAuthority: SELLER,
      database: buyerDatabase, sendMessage: vi.fn(),
    } as unknown as DacsLiveRoleOperationContextV1;
    const runtime = createDacsVetTerminalBundleTransportRuntimeV1({
      context: buyerContext,
      authenticateProduction: async () => ({ status: "valid" }),
    });
    const registered = await runtime.registerLocalTerminal(terminalInput());
    const exactPlan = registered.proposal.plan;
    await runtime.handleMessage(
      authenticated(
        "terminal-bundle-proposal-seller",
        registered.proposal,
        SELLER,
        BUYER,
      ),
      { role: "buyer" } as DacsLiveRoleInboundOperationContextV1,
    );
    const valid = contribution(exactPlan, "seller");
    const changed = {
      ...structuredClone(valid),
      signatures: valid.signatures.map((entry, index) => index === 0
        ? {
            ...entry,
            signature: {
              ...entry.signature,
              value: Buffer.alloc(64, 99).toString("base64url"),
            },
          }
        : structuredClone(entry)),
    };
    await expect(runtime.validatePayload({
      type: "terminal-bundle-contribution-seller",
      payload: changed,
      jobId: JOB_ID,
      sender: SELLER,
      audience: BUYER,
    })).resolves.toMatchObject({
      status: "invalid",
      reasonCode: "vet-terminal-contribution-invalid",
    });
  });
});

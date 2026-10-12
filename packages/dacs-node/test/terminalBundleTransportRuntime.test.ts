import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bundleAddress,
  createInMemoryFencedSessionStore,
  createTerminalBundlePlan,
  createTerminalBundleSignatureContribution,
  compositeVerificationAddress,
  prepareVetTerminalBundle,
  terminalBundleSignedBytes,
  type PrepareVetTerminalBundleInput,
  type ProtocolAnchorReceipt,
  type TerminalBundlePlan,
} from "@kynesyslabs/dacs";
import type { CompositeVerificationRecord, IdentityBundle, Listing } from
  "@kynesyslabs/dacs/artifacts";
import {
  canonicalize,
  contentHash,
  listingAddress,
  sha256Hex,
} from "@kynesyslabs/dacs/canonical";
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
import { putDacsLiveOrderInputV1 } from "../src/orderInput.js";
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
import { advanceDacsVetTerminalTrackV1 } from
  "../src/sessionBootstrapAgreementRuntime.js";
import {
  createDacsVetTerminalBundleTransportRuntimeV1,
  type DacsVetTerminalBundleTransportRuntimeV1,
} from "../src/terminalBundleTransportRuntime.js";
import type {
  DacsHttpAuthenticatedEnvelopeV1,
  DacsVetTerminalBundleProposalV1,
} from
  "../src/transport/envelope.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const BUYER_SEED = new Uint8Array(32).fill(71);
const SELLER_SEED = new Uint8Array(32).fill(72);
const claim = (seed: Uint8Array) =>
  `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
const BUYER = claim(BUYER_SEED);
const SELLER = claim(SELLER_SEED);
const STARTED_AT = 1_800_000_000_000;
const LISTING_ID = "terminal-listing";
const LISTING_VERSION = 1;
const REGISTRY_VERSIONS = Object.freeze({
  recipeRegistryVersion: 1,
  railRegistryVersion: 1,
});
const TERMINAL_TRANSPORT_ID_DOMAIN =
  "dacs-live-vet-terminal-transport:v1:" as const;

function terminalTransportEffectId(
  role: "buyer" | "seller",
  kind: "material" | "proposal" | "contribution" | "conflict" | "selection" | "disagreement",
  signerRole?: "buyer" | "seller",
): string {
  return sha256Hex(`${TERMINAL_TRANSPORT_ID_DOMAIN}${canonicalize({
    role,
    kind,
    jobId: JOB_ID,
    ...(signerRole === undefined ? {} : { signerRole }),
  })}`);
}

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

function listing(paymentPhase: "pay-x402" | "pay-dem" = "pay-x402"): Listing {
  const railId = paymentPhase === "pay-x402" ? "x402:terminal" : "demos-native:DEM";
  const railVersion = 1;
  return {
    dacsVersion: "1",
    listingVersion: LISTING_VERSION,
    listingId: LISTING_ID,
    seller: {
      identity: identity("seller"),
      displayName: "Terminal seller",
      publicEndpoint: "https://seller.example/dacs",
    },
    offering: {
      title: "Terminal result",
      description: "Authenticated terminal transport result",
      category: "data.test",
      tags: ["test"],
      deliverable: {
        kind: "attested-payload",
        payloadFormat: "application/json",
        verificationMethod: { kind: "self-signed" },
      },
    },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [
      { kind: "vet-credentials" },
      { kind: "negotiate-fixed-price" },
      { kind: "commit-agreement" },
      { kind: paymentPhase, parameters: { rail: railId } },
      { kind: "deliver-attested-payload" },
    ],
    pricing: { kind: "fixed", price: { amount: "1", currency: "DEM" } },
    acceptedRails: [{
      railId,
      railVersion,
      parameters: paymentPhase === "pay-x402"
        ? { network: "eip155:84532" }
        : { network: "demos" },
    }],
    terms: { deadlineSecAfterCommit: 600 },
    validity: { notBefore: STARTED_AT - 10_000, notAfter: STARTED_AT + 1_000_000 },
    signature: {
      algorithm: "ed25519",
      signer: SELLER,
      value: Buffer.alloc(64, 3).toString("base64url"),
    },
  };
}

function application(paymentPhase: "pay-x402" | "pay-dem" = "pay-x402") {
  const exactListing = listing(paymentPhase);
  const request = { query: "terminal" };
  return {
    applicationVersion: "1" as const,
    listingRef: `stor-${"5".repeat(40)}`,
    listingContentHash: contentHash(exactListing as unknown as Record<string, unknown>),
    listingLogicalAddress: listingAddress(
      exactListing.seller.identity.presentedBy,
      exactListing.listingId,
      exactListing.listingVersion,
    ),
    listing: exactListing,
    demosWriteFeeCeilings: { buyer: "1", seller: "1" },
    requestHash: sha256Hex(canonicalize(request)),
    request,
  };
}

function terminalInput(
  decision: CompositeVerificationRecord["overallDecision"] = "fail",
  paymentPhase: "pay-x402" | "pay-dem" = "pay-x402",
  evaluatedRole: "buyer" | "seller" = "seller",
): PrepareVetTerminalBundleInput {
  const exactListing = listing(paymentPhase);
  const evaluatedParty = evaluatedRole === "buyer" ? BUYER : SELLER;
  const verifier = evaluatedRole === "buyer" ? SELLER : BUYER;
  const evaluatedIdentity = identity(evaluatedRole);
  const logicalAddress = compositeVerificationAddress(JOB_ID, evaluatedParty);
  const record: CompositeVerificationRecord = {
    recordVersion: "1",
    jobId: JOB_ID,
    evaluatedParty,
    bundleHash: identityBundleHash(evaluatedIdentity),
    requirementHash: "3".repeat(64),
    freshness: [],
    supplementary: [],
    dealSpecific: [],
    overallDecision: decision,
    generatedAt: STARTED_AT + 100,
    signature: {
      algorithm: "ed25519",
      signer: verifier,
      value: Buffer.alloc(64, 7).toString("base64url"),
    },
  };
  const recordHash = contentHash(record as unknown as Record<string, unknown>);
  const nativeAddress = `stor-${"4".repeat(64)}`;
  return {
    jobId: JOB_ID,
    listingRef: {
      listingId: exactListing.listingId,
      version: exactListing.listingVersion,
      contentHash: contentHash(exactListing as unknown as Record<string, unknown>),
    },
    pipeline: exactListing.pipeline,
    vetPhaseIndex: 0,
    vetInvokedAt: STARTED_AT + 50,
    startedAt: STARTED_AT,
    recipeRegistryVersion: 1,
    railRegistryVersion: 1,
    parties: [
      { role: "buyer", identityBundle: identity("buyer") },
      { role: "seller", identityBundle: identity("seller") },
    ],
    evaluatedRole,
    production: {
      record,
      recordRef: {
        anchor: { kind: "storage-program", locator: nativeAddress },
        contentHash: recordHash,
        signer: verifier,
      },
      anchorReceipt: {
        receiptVersion: "1",
        substrate: "demos",
        finalityProfile: "demos-bft",
        logicalAddress,
        nativeAddress,
        contentHash: recordHash,
        transactionRef: { kind: "demos", value: "5".repeat(64) },
        writer: verifier,
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

async function terminalProposal(
  input: Readonly<PrepareVetTerminalBundleInput>,
): Promise<Readonly<DacsVetTerminalBundleProposalV1>> {
  const prepared = await prepareVetTerminalBundle(input, {
    authenticateProduction: async () => ({ status: "valid" }),
  });
  if (prepared.status !== "terminal") throw new Error("terminal fixture did not fail Vet");
  return Object.freeze({
    proposalVersion: "1" as const,
    terminalInput: input,
    plan: createTerminalBundlePlan(prepared.authority, { kind: "co-signed" }),
  });
}

function payDemOrderPair() {
  return createDacsFixedPricePayDemOrderPairV1({
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
  const databasePaths = new Map<DacsNodeSqliteDatabase, string>();

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
    databasePaths.set(database, join(root, "actor.sqlite"));
    if (rail === "x402") {
      const exactOrder = order(role);
      await database.createLiveCoordinatorStore(role).create({
        role,
        order: exactOrder,
        bindingHash: fixedPriceX402OrderBindingHash(exactOrder),
        localBindingHash: fixedPriceX402OrderLocalBindingHash(exactOrder),
      });
      putDacsLiveOrderInputV1({
        database,
        order: exactOrder,
        application: application("pay-x402"),
      });
    } else {
      const pair = payDemOrderPair();
      await database.createPayDemCoordinatorStore(role).create({
        role,
        order: pair[role],
        bindingHash: pair.bindingHash,
        localBindingHash: role === "buyer"
          ? pair.buyerLocalBindingHash : pair.sellerLocalBindingHash,
      });
      putDacsLiveOrderInputV1({
        database,
        order: pair[role],
        application: application("pay-dem"),
      });
    }
    return database;
  }

  type IrreversibleSink = "signer" | "bundle-submit" | "binding-publish";
  type PauseTiming = "before" | "inside";

  async function raceReadyBuyer(
    pauseAt: (sink: IrreversibleSink, timing: PauseTiming) => Promise<void>,
  ) {
    const database = await open("buyer");
    retainDacsFixedPricePurchaseDemosBudgetGrantV1({
      database,
      jobId: JOB_ID,
      role: "buyer",
      authority: BUYER,
      maximumPerWriteFeeDem: "1",
    });
    type StoredAnchor = Readonly<{
      address: string;
      value: Readonly<Record<string, unknown>>;
      receipt: Readonly<ProtocolAnchorReceipt>;
    }>;
    const byName = new Map<string, StoredAnchor>();
    const byAddress = new Map<string, StoredAnchor>();
    const owner = BUYER.slice("did:demos:agent:".length);
    const ownBundleAddress = bundleAddress(JOB_ID, "buyer");
    const ownBindingAddress = `dacs5:bundle-binding:${JOB_ID}:buyer`;
    const signComponent = vi.fn(async (bytes: Uint8Array) => {
      await pauseAt("signer", "inside");
      return ed25519Sign(bytes, privateKeyFromSeed(BUYER_SEED));
    });
    const anchorWriteOnce = vi.fn(async (
      name: string,
      value: object,
      options?: Readonly<{ metadata?: Readonly<Record<string, unknown>> }>,
    ) => {
      if (name === ownBundleAddress) await pauseAt("bundle-submit", "inside");
      if (name === ownBindingAddress) await pauseAt("binding-publish", "inside");
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
        writer: BUYER,
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
    });
    const adapter = {
      raw: {
        getNetworkInfo: async () => ({}),
        getAddressNonce: async () => 0,
        getAddressInfo: async () => ({}),
      },
      connect: async () => undefined,
      getAddress: () => owner,
      getPublicKey: async () => rawPublicKey(publicKeyFromSeed(BUYER_SEED)),
      sign: async (bytes: Uint8Array) => ed25519Sign(
        bytes,
        privateKeyFromSeed(BUYER_SEED),
      ),
      resolveIdentity: async (ref: string) => ({ ref, raw: {} }),
      readAnchor: async (address: string) =>
        structuredClone(byAddress.get(address)?.value ?? null),
      resolveAnchorByName: async (name: string, expectedOwner: string) => {
        const retained = byName.get(`${expectedOwner}:${name}`);
        if (retained === undefined && name === ownBundleAddress) {
          await pauseAt("bundle-submit", "before");
        }
        if (retained === undefined && name === ownBindingAddress) {
          await pauseAt("binding-publish", "before");
        }
        return retained === undefined
          ? { status: "absent" as const }
          : { status: "present" as const, address: retained.address };
      },
      scanOwnAnchorsByNamePrefix: async () => ({
        status: "ok" as const,
        anchors: [],
      }),
      anchorWriteOnce,
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
    const baseSessionStore = createInMemoryFencedSessionStore();
    const sessionStore = {
      apiVersion: baseSessionStore.apiVersion,
      create: (input: Parameters<typeof baseSessionStore.create>[0]) =>
        baseSessionStore.create(input),
      load: (jobId: string) => baseSessionStore.load(jobId),
      transition: (input: Parameters<typeof baseSessionStore.transition>[0]) =>
        baseSessionStore.transition(input),
      claimCheckpoint: async (
        input: Parameters<typeof baseSessionStore.claimCheckpoint>[0],
      ) => {
        if (input.phase?.endsWith(":contribution-signing") &&
            input.key.includes("signature:")) {
          await pauseAt("signer", "before");
        }
        return await baseSessionStore.claimCheckpoint(input);
      },
      acquireLease: (input: Parameters<typeof baseSessionStore.acquireLease>[0]) =>
        baseSessionStore.acquireLease(input),
      renewLease: (input: Parameters<typeof baseSessionStore.renewLease>[0]) =>
        baseSessionStore.renewLease(input),
      bindSessionAuthorization: (
        input: Parameters<typeof baseSessionStore.bindSessionAuthorization>[0],
      ) => baseSessionStore.bindSessionAuthorization(input),
      bindHash: (input: Parameters<typeof baseSessionStore.bindHash>[0]) =>
        baseSessionStore.bindHash(input),
      list: (filter?: Parameters<typeof baseSessionStore.list>[0]) =>
        baseSessionStore.list(filter),
    };
    const demos = {
      role: "buyer",
      authority: BUYER,
      walletAddress: owner,
      publicKey: rawPublicKey(publicKeyFromSeed(BUYER_SEED)),
      adapter,
      signTransportEnvelope: async (bytes: Uint8Array) => ed25519Sign(
        bytes,
        privateKeyFromSeed(BUYER_SEED),
      ),
      signComponent,
      networkInfo: async () => ({}),
      addressNonce: async () => 0,
      addressInfo: async () => ({}),
    } as unknown as Readonly<DacsDemosActorRuntimeV1>;
    const context = {
      role: "buyer", authority: BUYER, peerAuthority: SELLER,
      config: { role: "buyer" },
      database,
      demos,
      sessionStore,
      sendMessage: vi.fn(async () => acknowledgement("accepted")),
    } as unknown as DacsLiveRoleOperationContextV1;
    const runtime = createDacsVetTerminalBundleTransportRuntimeV1({
      context,
      expectedRegistryVersions: REGISTRY_VERSIONS,
      authenticateProduction: async () => ({ status: "valid" }),
    });
    const registered = await runtime.registerLocalTerminal(
      terminalInput("fail", "pay-x402", "seller"),
    );
    await runtime.handleMessage(
      authenticated(
        "terminal-bundle-proposal-seller",
        registered.proposal,
        SELLER,
        BUYER,
      ),
      { role: "buyer" } as DacsLiveRoleInboundOperationContextV1,
    );
    await runtime.handleMessage(
      authenticated(
        "terminal-bundle-contribution-seller",
        contribution(registered.proposal.plan, "seller"),
        SELLER,
        BUYER,
      ),
      { role: "buyer" } as DacsLiveRoleInboundOperationContextV1,
    );
    return {
      database,
      runtime,
      conflictProposal: await terminalProposal(
        terminalInput("fail", "pay-x402", "buyer"),
      ),
      signComponent,
      anchorWriteOnce,
    };
  }

  // Two processes on one SQLite file: one registers the buyer's own Vet
  // failure, the other accepts the seller's different first plan. The one
  // insert-once selection decides; the other plan becomes disagreement
  // evidence, never a second retained plan that a restart would seal.
  it("selects one plan when a local failure and the peer's proposal race on two connections", async () => {
    const first = await open("buyer");
    const second = await openDacsNodeSqliteDatabase({
      databasePath: databasePaths.get(first)!,
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role: "buyer",
      authority: BUYER,
    });
    databases.push(second);
    const runtimeOn = (database: DacsNodeSqliteDatabase) => createDacsVetTerminalBundleTransportRuntimeV1({
      context: {
        role: "buyer", authority: BUYER, peerAuthority: SELLER, database,
        demos: { signComponent: vi.fn() },
        sessionStore: createInMemoryFencedSessionStore(),
        sendMessage: vi.fn(async () => acknowledgement("accepted")),
      } as unknown as DacsLiveRoleOperationContextV1,
      expectedRegistryVersions: REGISTRY_VERSIONS,
      authenticateProduction: async () => ({ status: "valid" }),
    });
    const planB = await terminalProposal(terminalInput("fail", "pay-x402", "buyer"));
    await Promise.allSettled([
      runtimeOn(first).registerLocalTerminal(terminalInput("fail", "pay-x402")),
      runtimeOn(second).handleMessage(
        authenticated("terminal-bundle-proposal-seller", planB, SELLER, BUYER),
        { role: "buyer" } as DacsLiveRoleInboundOperationContextV1,
      ),
    ]);
    const load = (kind: "material" | "proposal" | "conflict" | "selection" | "disagreement") =>
      first.loadEffectInput("session", terminalTransportEffectId("buyer", kind));
    expect(load("selection")).toMatchObject({ kind: "plan-selection" });
    expect(load("material") !== undefined && load("proposal") !== undefined).toBe(false);
    expect(load("conflict")).toBeUndefined();
    expect(load("disagreement")).toMatchObject({
      kind: "plan-disagreement", operatorAlert: true, peerPlanHash: planB.plan.planHash,
    });
  });

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
      expectedRegistryVersions: REGISTRY_VERSIONS,
      authenticateProduction: buyerAuthenticate,
    });
    sellerRuntime = createDacsVetTerminalBundleTransportRuntimeV1({
      context: sellerContext,
      expectedRegistryVersions: REGISTRY_VERSIONS,
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
      expectedRegistryVersions: REGISTRY_VERSIONS,
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
      expectedRegistryVersions: REGISTRY_VERSIONS,
      authenticateProduction: async () => ({ status: "valid" }),
    });
    sellerRuntime = createDacsVetTerminalBundleTransportRuntimeV1({
      context: sellerContext,
      expectedRegistryVersions: REGISTRY_VERSIONS,
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
      expectedRegistryVersions: REGISTRY_VERSIONS,
      authenticateProduction: async () => ({ status: "valid" }),
    });
    await expect(restartedBuyer.advanceRegisteredTerminal(JOB_ID)).resolves.toMatchObject({
      disposition: "finalised",
      recovered: true,
    });
    expect(byName).toHaveProperty("size", 4);
  });

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
      expectedRegistryVersions: REGISTRY_VERSIONS,
      authenticateProduction: async () => ({
        status: "invalid",
        reason: "Vet failure not authenticated",
      }),
    });
    const sellerRuntime = createDacsVetTerminalBundleTransportRuntimeV1({
      context: sellerContext,
      expectedRegistryVersions: REGISTRY_VERSIONS,
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
      expectedRegistryVersions: REGISTRY_VERSIONS,
      authenticateProduction: async () => ({ status: "valid" }),
    });
    sellerRuntime = createDacsVetTerminalBundleTransportRuntimeV1({
      context: sellerContext,
      expectedRegistryVersions: REGISTRY_VERSIONS,
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
      expectedRegistryVersions: REGISTRY_VERSIONS,
      authenticateProduction: async () => ({ status: "valid" }),
    });
    const registered = await validRuntime.registerLocalTerminal(terminalInput());
    const unavailableRuntime = createDacsVetTerminalBundleTransportRuntimeV1({
      context,
      expectedRegistryVersions: REGISTRY_VERSIONS,
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
      expectedRegistryVersions: REGISTRY_VERSIONS,
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

  it.each([
    [
      "alternate same-kind rail",
      (input: PrepareVetTerminalBundleInput) => ({
        ...input,
        pipeline: input.pipeline.map((step) => step.kind === "pay-x402"
          ? { ...step, parameters: { ...step.parameters, rail: "x402:substituted" } }
          : step),
      }),
      "vet-terminal-proposal-rail-mismatch",
    ],
    [
      "Listing identity",
      (input: PrepareVetTerminalBundleInput) => ({
        ...input,
        listingRef: { ...input.listingRef, listingId: "substituted-listing" },
      }),
      "vet-terminal-proposal-listing-mismatch",
    ],
    [
      "Listing content reference",
      (input: PrepareVetTerminalBundleInput) => ({
        ...input,
        listingRef: { ...input.listingRef, contentHash: "f".repeat(64) },
      }),
      "vet-terminal-proposal-listing-mismatch",
    ],
    [
      "Listing pipeline",
      (input: PrepareVetTerminalBundleInput) => ({
        ...input,
        pipeline: input.pipeline.map((step, index) => index === 1
          ? { kind: "commit-agreement" as const }
          : step),
      }),
      "vet-terminal-proposal-listing-mismatch",
    ],
    [
      "Listing version",
      (input: PrepareVetTerminalBundleInput) => ({
        ...input,
        listingRef: { ...input.listingRef, version: input.listingRef.version + 1 },
      }),
      "vet-terminal-proposal-version-mismatch",
    ],
    [
      "recipe registry version",
      (input: PrepareVetTerminalBundleInput) => ({
        ...input,
        recipeRegistryVersion: input.recipeRegistryVersion + 1,
      }),
      "vet-terminal-proposal-version-mismatch",
    ],
    [
      "rail registry version",
      (input: PrepareVetTerminalBundleInput) => ({
        ...input,
        railRegistryVersion: input.railRegistryVersion + 1,
      }),
      "vet-terminal-proposal-version-mismatch",
    ],
  ] as const)("rejects a substituted %s before authentication or retention", async (
    _label,
    mutate,
    reasonCode,
  ) => {
    const buyerDatabase = await open("buyer");
    const authenticate = vi.fn(async () => ({ status: "valid" as const }));
    const sendMessage = vi.fn();
    const context = {
      role: "buyer", authority: BUYER, peerAuthority: SELLER,
      database: buyerDatabase, sendMessage,
    } as unknown as DacsLiveRoleOperationContextV1;
    const runtime = createDacsVetTerminalBundleTransportRuntimeV1({
      context,
      expectedRegistryVersions: REGISTRY_VERSIONS,
      authenticateProduction: authenticate,
    });
    await runtime.registerLocalTerminal(terminalInput());
    authenticate.mockClear();
    const persist = vi.spyOn(buyerDatabase, "putEffectIntent");
    const proposal = await terminalProposal(mutate(terminalInput()));

    await expect(runtime.handleMessage(
      authenticated("terminal-bundle-proposal-seller", proposal, SELLER, BUYER),
      { role: "buyer" } as DacsLiveRoleInboundOperationContextV1,
    )).resolves.toEqual({ disposition: "rejected", reasonCode });
    expect(authenticate).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    await expect(runtime.transport.resolveProposal({
      jobId: JOB_ID,
      authorityHash: proposal.plan.authorityHash,
      planHash: proposal.plan.planHash,
    })).resolves.toEqual({
      disposition: "authoritatively-absent",
      reason: "vet-terminal-proposal-absent",
    });
  });

  it.each([
    ["recipe", (input: PrepareVetTerminalBundleInput) => ({
      ...input,
      recipeRegistryVersion: input.recipeRegistryVersion + 1,
    })],
    ["rail", (input: PrepareVetTerminalBundleInput) => ({
      ...input,
      railRegistryVersion: input.railRegistryVersion + 1,
    })],
  ] as const)("rejects a first-arriving peer %s registry mismatch", async (
    _label,
    mutate,
  ) => {
    const buyerDatabase = await open("buyer");
    const authenticate = vi.fn(async () => ({ status: "valid" as const }));
    const sendMessage = vi.fn();
    const signComponent = vi.fn();
    const context = {
      role: "buyer", authority: BUYER, peerAuthority: SELLER,
      database: buyerDatabase,
      sessionStore: createInMemoryFencedSessionStore(),
      demos: { signComponent },
      sendMessage,
    } as unknown as DacsLiveRoleOperationContextV1;
    const runtime = createDacsVetTerminalBundleTransportRuntimeV1({
      context,
      expectedRegistryVersions: REGISTRY_VERSIONS,
      authenticateProduction: authenticate,
    });
    const persist = vi.spyOn(buyerDatabase, "putEffectIntent");
    const proposal = await terminalProposal(mutate(terminalInput()));

    await expect(runtime.handleMessage(
      authenticated("terminal-bundle-proposal-seller", proposal, SELLER, BUYER),
      { role: "buyer" } as DacsLiveRoleInboundOperationContextV1,
    )).resolves.toEqual({
      disposition: "rejected",
      reasonCode: "vet-terminal-proposal-version-mismatch",
    });
    expect(authenticate).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    await expect(runtime.advanceRegisteredTerminal(JOB_ID)).rejects.toMatchObject({
      reasonCode: "vet-terminal-material-unavailable",
    });
    expect(signComponent).not.toHaveBeenCalled();
  });

  it("snapshots trusted registry versions before admitting a first proposal", async () => {
    const buyerDatabase = await open("buyer");
    const configuredVersions = {
      recipeRegistryVersion: 1,
      railRegistryVersion: 1,
    };
    const context = {
      role: "buyer", authority: BUYER, peerAuthority: SELLER,
      database: buyerDatabase, sendMessage: vi.fn(),
    } as unknown as DacsLiveRoleOperationContextV1;
    const runtime = createDacsVetTerminalBundleTransportRuntimeV1({
      context,
      expectedRegistryVersions: configuredVersions,
      authenticateProduction: async () => ({ status: "valid" }),
    });
    configuredVersions.recipeRegistryVersion = 2;
    configuredVersions.railRegistryVersion = 2;
    const proposal = await terminalProposal(terminalInput());

    await expect(runtime.handleMessage(
      authenticated("terminal-bundle-proposal-seller", proposal, SELLER, BUYER),
      { role: "buyer" } as DacsLiveRoleInboundOperationContextV1,
    )).resolves.toEqual({ disposition: "accepted" });
    await expect(runtime.transport.resolveProposal({
      jobId: JOB_ID,
      authorityHash: proposal.plan.authorityHash,
      planHash: proposal.plan.planHash,
    })).resolves.toMatchObject({ disposition: "present" });
  });

  // This role's own Vet failure and the peer's first, different plan stop the
  // job at the same two-sided disagreement in either arrival order. Nothing is
  // sealed, signed or retained twice; the track sends this role's own plan.
  it.each([
    ["local material first", "material"],
    ["peer proposal first", "proposal"],
  ] as const)("durably stops distinct authenticated Vet plans with %s", async (
    _label,
    first,
  ) => {
    const buyerDatabase = await open("buyer");
    const authenticate = vi.fn(async () => ({ status: "valid" as const }));
    const sendMessage = vi.fn(async () => acknowledgement("rejected"));
    const signComponent = vi.fn();
    const context = {
      role: "buyer", authority: BUYER, peerAuthority: SELLER,
      database: buyerDatabase,
      sessionStore: createInMemoryFencedSessionStore(),
      demos: { signComponent },
      sendMessage,
    } as unknown as DacsLiveRoleOperationContextV1;
    const createRuntime = () => createDacsVetTerminalBundleTransportRuntimeV1({
      context,
      expectedRegistryVersions: REGISTRY_VERSIONS,
      authenticateProduction: authenticate,
    });
    const runtime = createRuntime();
    const localInput = terminalInput("fail", "pay-x402", "seller");
    const localProposal = await terminalProposal(localInput);
    const peerProposal = await terminalProposal(
      terminalInput("fail", "pay-x402", "buyer"),
    );
    expect(localProposal.plan.planHash).not.toBe(peerProposal.plan.planHash);
    expect(localProposal.plan.authority.faultedParty).toBe("seller");
    expect(peerProposal.plan.authority.faultedParty).toBe("buyer");

    if (first === "material") {
      await expect(runtime.registerLocalTerminal(localInput)).resolves.toMatchObject({
        proposal: { plan: { planHash: localProposal.plan.planHash } },
      });
      // Validation lets the inbox retain the peer's plan as evidence.
      await expect(runtime.validatePayload({
        type: "terminal-bundle-proposal-seller",
        payload: peerProposal,
        jobId: JOB_ID,
        sender: SELLER,
        audience: BUYER,
      })).resolves.toMatchObject({ status: "valid" });
      await expect(runtime.handleMessage(
        authenticated(
          "terminal-bundle-proposal-seller",
          peerProposal,
          SELLER,
          BUYER,
        ),
        { role: "buyer" } as DacsLiveRoleInboundOperationContextV1,
      )).resolves.toEqual({
        disposition: "rejected",
        reasonCode: "vet-terminal-plan-disagreement",
      });
    } else {
      await expect(runtime.handleMessage(
        authenticated(
          "terminal-bundle-proposal-seller",
          peerProposal,
          SELLER,
          BUYER,
        ),
        { role: "buyer" } as DacsLiveRoleInboundOperationContextV1,
      )).resolves.toEqual({ disposition: "accepted" });
      await expect(runtime.registerLocalTerminal(localInput)).rejects.toMatchObject({
        reasonCode: "vet-terminal-plan-disagreement",
      });
    }

    const material = buyerDatabase.loadEffectInput(
      "session",
      terminalTransportEffectId("buyer", "material"),
    );
    const proposal = buyerDatabase.loadEffectInput(
      "session",
      terminalTransportEffectId("buyer", "proposal"),
    );
    expect(material === undefined).toBe(first === "proposal");
    expect(proposal === undefined).toBe(first === "material");
    expect(buyerDatabase.loadEffectInput(
      "session",
      terminalTransportEffectId("buyer", "conflict"),
    )).toBeUndefined();
    expect(buyerDatabase.loadEffectInput(
      "session",
      terminalTransportEffectId("buyer", "disagreement"),
    )).toMatchObject({
      evidenceVersion: "1",
      localBindingHash: fixedPriceX402OrderLocalBindingHash(order("buyer")),
      kind: "plan-disagreement",
      localPlanHash: localProposal.plan.planHash,
      peerPlanHash: peerProposal.plan.planHash,
      selected: first === "material" ? "local" : "peer",
      operatorAlert: true,
    });

    const retainedPlan = first === "material" ? localProposal.plan : peerProposal.plan;
    const identity = {
      jobId: JOB_ID,
      authorityHash: retainedPlan.authorityHash,
      planHash: retainedPlan.planHash,
    };
    const restarted = createRuntime();
    await expect(restarted.transport.resolveProposal(identity)).resolves.toEqual({
      disposition: "rejected",
      reason: "vet-terminal-plan-disagreement",
    });
    await expect(restarted.transport.resolveContribution({
      identity,
      signerRole: "seller",
    })).resolves.toEqual({
      disposition: "rejected",
      reason: "vet-terminal-plan-disagreement",
    });
    await expect(restarted.transport.publishContribution({
      identity,
      contribution: contribution(retainedPlan, "buyer"),
    }, {} as never)).rejects.toMatchObject({
      reasonCode: "vet-terminal-plan-disagreement",
    });
    expect(sendMessage).not.toHaveBeenCalled();
    // The track sends this role's own plan once, then stops for an operator.
    await expect(restarted.advanceRegisteredTerminal(JOB_ID)).rejects.toMatchObject({
      reasonCode: "vet-terminal-plan-disagreement",
    });
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "terminal-bundle-proposal-buyer", payload: localProposal,
    }));
    authenticate.mockClear();
    await expect(restarted.registerLocalTerminal(localInput)).rejects.toMatchObject({
      reasonCode: "vet-terminal-plan-disagreement",
    });
    expect(authenticate).not.toHaveBeenCalled();
    expect(signComponent).not.toHaveBeenCalled();
  });

  it.each([
    ["proposal", "before"],
    ["proposal", "inside"],
    ["contribution", "before"],
    ["contribution", "inside"],
  ] as const)(
    "fences the %s send when a conflict is sealed %s",
    async (kind, timing) => {
      const database = await open("buyer");
      let enter = (): void => undefined;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      let release = (): void => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let pauseEnabled = false;
      let paused = false;
      const pause = async (candidateTiming: PauseTiming) => {
        if (pauseEnabled && !paused && candidateTiming === timing) {
          paused = true;
          enter();
          await released;
        }
      };
      const sendMessage = vi.fn(async () => {
        await pause("inside");
        return acknowledgement("accepted");
      });
      const signComponent = vi.fn();
      const anchorWriteOnce = vi.fn();
      const context = {
        role: "buyer", authority: BUYER, peerAuthority: SELLER,
        database,
        demos: { signComponent, adapter: { anchorWriteOnce } },
        sendMessage,
      } as unknown as DacsLiveRoleOperationContextV1;
      const publisher = createDacsVetTerminalBundleTransportRuntimeV1({
        context,
        expectedRegistryVersions: REGISTRY_VERSIONS,
        authenticateProduction: async () => {
          await pause("before");
          return { status: "valid" as const };
        },
      });
      const sealer = createDacsVetTerminalBundleTransportRuntimeV1({
        context,
        expectedRegistryVersions: REGISTRY_VERSIONS,
        authenticateProduction: async () => ({ status: "valid" }),
      });
      const registered = await publisher.registerLocalTerminal(
        terminalInput("fail", "pay-x402", "seller"),
      );
      const identity = {
        jobId: JOB_ID,
        authorityHash: registered.proposal.plan.authorityHash,
        planHash: registered.proposal.plan.planHash,
      };
      if (kind === "contribution") {
        await publisher.handleMessage(
          authenticated(
            "terminal-bundle-proposal-seller",
            registered.proposal,
            SELLER,
            BUYER,
          ),
          { role: "buyer" } as DacsLiveRoleInboundOperationContextV1,
        );
      }
      pauseEnabled = true;
      const publishing = kind === "proposal"
        ? publisher.transport.publishProposal({
            identity,
            plan: registered.proposal.plan,
          }, {} as never)
        : publisher.transport.publishContribution({
            identity,
            contribution: contribution(registered.proposal.plan, "buyer"),
          }, {} as never);
      await entered;
      try {
        // A peer's message never seals (it is refused as a disagreement or
        // equivocation); a second local plan over the retained one does.
        await expect(sealer.registerLocalTerminal(
          terminalInput("fail", "pay-x402", "buyer"),
        )).rejects.toMatchObject({
          reasonCode: "vet-terminal-binding-conflict",
        });
      } finally {
        release();
      }
      await expect(publishing).rejects.toMatchObject({
        reasonCode: "vet-terminal-binding-conflict",
      });
      expect(sendMessage).toHaveBeenCalledTimes(timing === "inside" ? 1 : 0);
      expect(database.loadEffectInput(
        "session",
        terminalTransportEffectId(
          "buyer",
          kind,
          kind === "contribution" ? "buyer" : undefined,
        ),
      )).toBeUndefined();
      await expect(publisher.advanceRegisteredTerminal(JOB_ID)).rejects.toMatchObject({
        reasonCode: "vet-terminal-binding-conflict",
      });
      expect(signComponent).not.toHaveBeenCalled();
      expect(anchorWriteOnce).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["signer", "before", 0, 0],
    ["signer", "inside", 1, 0],
    ["bundle-submit", "before", 2, 0],
    ["bundle-submit", "inside", 2, 1],
    ["binding-publish", "before", 3, 1],
    ["binding-publish", "inside", 3, 2],
  ] as const)(
    "stops irreversible progress when a conflict is sealed %s %s",
    async (sink, timing, expectedSignatures, expectedWrites) => {
      let enter = (): void => undefined;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      let release = (): void => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let paused = false;
      const harness = await raceReadyBuyer(async (candidateSink, candidateTiming) => {
        if (!paused && candidateSink === sink && candidateTiming === timing) {
          paused = true;
          enter();
          await released;
        }
      });
      const advancing = harness.runtime.advanceRegisteredTerminal(JOB_ID);
      await entered;
      try {
        // A peer's message never seals (it is refused as a disagreement or
        // equivocation); a second local plan over the retained one does.
        await expect(harness.runtime.registerLocalTerminal(
          harness.conflictProposal.terminalInput,
        )).rejects.toMatchObject({
          reasonCode: "vet-terminal-binding-conflict",
        });
      } finally {
        release();
      }
      const result = await advancing;
      expect(result.disposition).not.toBe("finalised");
      expect(harness.signComponent).toHaveBeenCalledTimes(expectedSignatures);
      expect(harness.anchorWriteOnce).toHaveBeenCalledTimes(expectedWrites);
      expect(harness.database.loadEffectInput(
        "session",
        terminalTransportEffectId("buyer", "conflict"),
      )).toMatchObject({ kind: "plan-conflict" });
    },
  );

  it.each([
    ["invalid", "invalid", "vet-terminal-production-invalid"],
    ["indeterminate", "authentication-failure", "vet-terminal-production-indeterminate"],
  ] as const)("does not tombstone a distinct peer plan when Vet authentication is %s", async (
    authenticationStatus,
    validationStatus,
    reasonCode,
  ) => {
    const buyerDatabase = await open("buyer");
    const context = {
      role: "buyer", authority: BUYER, peerAuthority: SELLER,
      database: buyerDatabase, sendMessage: vi.fn(),
    } as unknown as DacsLiveRoleOperationContextV1;
    const validRuntime = createDacsVetTerminalBundleTransportRuntimeV1({
      context,
      expectedRegistryVersions: REGISTRY_VERSIONS,
      authenticateProduction: async () => ({ status: "valid" }),
    });
    const localInput = terminalInput("fail", "pay-x402", "seller");
    await validRuntime.registerLocalTerminal(localInput);
    const untrustedRuntime = createDacsVetTerminalBundleTransportRuntimeV1({
      context,
      expectedRegistryVersions: REGISTRY_VERSIONS,
      authenticateProduction: async () => ({
        status: authenticationStatus,
        reason: "recursive Vet authentication failed",
      }),
    });
    const peer = await terminalProposal(
      terminalInput("fail", "pay-x402", "buyer"),
    );

    await expect(untrustedRuntime.validatePayload({
      type: "terminal-bundle-proposal-seller",
      payload: peer,
      jobId: JOB_ID,
      sender: SELLER,
      audience: BUYER,
    })).resolves.toEqual({ status: validationStatus, reasonCode });
    expect(buyerDatabase.loadEffectInput(
      "session",
      terminalTransportEffectId("buyer", "conflict"),
    )).toBeUndefined();
    expect(buyerDatabase.loadEffectInput(
      "session",
      terminalTransportEffectId("buyer", "proposal"),
    )).toBeUndefined();
    await expect(validRuntime.registerLocalTerminal(localInput)).resolves.toMatchObject({
      proposal: { plan: { authority: { faultedParty: "seller" } } },
    });
  });

  it("seals a pre-existing split material/proposal state before restart can sign", async () => {
    const buyerDatabase = await open("buyer");
    const signComponent = vi.fn();
    const context = {
      role: "buyer", authority: BUYER, peerAuthority: SELLER,
      database: buyerDatabase,
      sessionStore: createInMemoryFencedSessionStore(),
      demos: { signComponent },
      sendMessage: vi.fn(),
    } as unknown as DacsLiveRoleOperationContextV1;
    const createRuntime = () => createDacsVetTerminalBundleTransportRuntimeV1({
      context,
      expectedRegistryVersions: REGISTRY_VERSIONS,
      authenticateProduction: async () => ({ status: "valid" as const }),
    });
    const local = await createRuntime().registerLocalTerminal(
      terminalInput("fail", "pay-x402", "seller"),
    );
    const peer = await terminalProposal(
      terminalInput("fail", "pay-x402", "buyer"),
    );
    const localBindingHash = fixedPriceX402OrderLocalBindingHash(order("buyer"));
    const proposalId = terminalTransportEffectId("buyer", "proposal");
    expect(buyerDatabase.putEffectIntent({
      kind: "session",
      effectId: proposalId,
      bindingHash: localBindingHash,
      input: {
        bindingVersion: "1",
        localBindingHash,
        kind: "proposal",
        payloadHash: sha256Hex(canonicalize(peer)),
        payload: peer,
        authenticationHash: "c".repeat(64),
        identityEvidenceHash: "d".repeat(64),
      },
      idempotencyKey: proposalId,
      jobId: JOB_ID,
    })).toMatchObject({ status: "created" });
    expect(buyerDatabase.loadEffectInput(
      "session",
      terminalTransportEffectId("buyer", "conflict"),
    )).toBeUndefined();

    const restarted = createRuntime();
    await expect(restarted.advanceRegisteredTerminal(JOB_ID)).rejects.toMatchObject({
      reasonCode: "vet-terminal-binding-conflict",
    });
    expect(buyerDatabase.loadEffectInput(
      "session",
      terminalTransportEffectId("buyer", "conflict"),
    )).toMatchObject({
      conflictVersion: "1",
      localBindingHash,
      kind: "plan-conflict",
      planHashes: [local.proposal.plan.planHash, peer.plan.planHash].sort(),
    });
    expect(signComponent).not.toHaveBeenCalled();
  });

  it("fails closed when a first proposal has no trusted registry authority", async () => {
    const buyerDatabase = await open("buyer");
    const authenticate = vi.fn(async () => ({ status: "valid" as const }));
    const context = {
      role: "buyer", authority: BUYER, peerAuthority: SELLER,
      database: buyerDatabase, sendMessage: vi.fn(),
    } as unknown as DacsLiveRoleOperationContextV1;
    const runtime = createDacsVetTerminalBundleTransportRuntimeV1({
      context,
      authenticateProduction: authenticate,
    });
    const persist = vi.spyOn(buyerDatabase, "putEffectIntent");
    const proposal = await terminalProposal(terminalInput());

    await expect(runtime.handleMessage(
      authenticated("terminal-bundle-proposal-seller", proposal, SELLER, BUYER),
      { role: "buyer" } as DacsLiveRoleInboundOperationContextV1,
    )).resolves.toEqual({
      disposition: "rejected",
      reasonCode: "vet-terminal-proposal-version-authority-unavailable",
    });
    expect(authenticate).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it("rejects a contribution whose detached signature row was altered", async () => {
    const buyerDatabase = await open("buyer");
    const buyerContext = {
      role: "buyer", authority: BUYER, peerAuthority: SELLER,
      database: buyerDatabase, sendMessage: vi.fn(),
    } as unknown as DacsLiveRoleOperationContextV1;
    const runtime = createDacsVetTerminalBundleTransportRuntimeV1({
      context: buyerContext,
      expectedRegistryVersions: REGISTRY_VERSIONS,
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

const SESSION_AGREEMENT_FACTS_DOMAIN = "dacs-live-session-agreement-facts:v1:" as const;

// The terminal transport's durable dependencies, held in memory: the role's
// x402 coordinator record, its retained order input, and session effects.
function memoryRoleDatabase(
  role: "buyer" | "seller",
  orderApplication?: ReturnType<typeof application>,
  rail: "x402" | "pay-dem" = "x402",
) {
  const pair = rail === "pay-dem" ? payDemOrderPair() : undefined;
  const exactOrder = pair === undefined ? order(role) : pair[role];
  orderApplication ??= application(rail === "pay-dem" ? "pay-dem" : "pay-x402");
  const effects = new Map<string, unknown>();
  const tracks: Record<string, unknown> = {};
  let coordinatorStatus: "ok" | "missing" = "ok";
  const coordinatorRecord = () => ({
    ...exactOrder,
    role,
    bindingHash: pair === undefined
      ? fixedPriceX402OrderBindingHash(exactOrder as FixedPriceX402OrderInput) : pair.bindingHash,
    localBindingHash: pair === undefined
      ? fixedPriceX402OrderLocalBindingHash(exactOrder as FixedPriceX402OrderInput)
      : role === "buyer" ? pair.buyerLocalBindingHash : pair.sellerLocalBindingHash,
    tracks: structuredClone(tracks),
  });
  const coordinatorLoad = (owner: "x402" | "pay-dem") => async () =>
    coordinatorStatus === "ok" && owner === rail
      ? { status: "ok" as const, record: coordinatorRecord() }
      : { status: "missing" as const };
  const database = {
    metadata: {
      mode: "live-demos",
      role,
      authority: role === "buyer" ? BUYER : SELLER,
    },
    readTime: () => STARTED_AT + 1_000,
    loadEffectInput: (kind: string, effectId: string) =>
      structuredClone(effects.get(`${kind}:${effectId}`)),
    putEffectIntent: (input: Readonly<{ kind: string; effectId: string; input: unknown }>) => {
      const key = `${input.kind}:${input.effectId}`;
      const existing = effects.get(key);
      if (existing !== undefined) {
        return { status: canonicalize(existing) === canonicalize(input.input)
          ? "existing" as const : "conflict" as const };
      }
      effects.set(key, structuredClone(input.input));
      return { status: "created" as const };
    },
    createLiveCoordinatorStore: () => ({ load: coordinatorLoad("x402") }),
    createPayDemCoordinatorStore: () => ({ load: coordinatorLoad("pay-dem") }),
  };
  expect(putDacsLiveOrderInputV1({
    database: database as unknown as DacsNodeSqliteDatabase,
    order: exactOrder,
    application: orderApplication,
  }).status).toBe("created");
  const signComponent = vi.fn(async (bytes: Uint8Array) => ed25519Sign(
    bytes,
    privateKeyFromSeed(role === "buyer" ? BUYER_SEED : SELLER_SEED),
  ));
  const context = {
    role,
    authority: role === "buyer" ? BUYER : SELLER,
    peerAuthority: role === "buyer" ? SELLER : BUYER,
    database,
    demos: { signComponent },
    sessionStore: createInMemoryFencedSessionStore(),
    sendMessage: vi.fn(async () => acknowledgement("accepted")),
  } as unknown as DacsLiveRoleOperationContextV1;
  const runtime = createDacsVetTerminalBundleTransportRuntimeV1({
    context,
    expectedRegistryVersions: REGISTRY_VERSIONS,
    authenticateProduction: async () => ({ status: "valid" }),
  });
  return {
    context,
    effects,
    runtime,
    signComponent,
    concludeAgreement() {
      tracks.agreement = {
        state: "final",
        generation: 1,
        attempts: 1,
        updatedAt: STARTED_AT + 900,
        outcome: "success",
        reference: "agreement-reference",
      };
    },
    retainAgreementFacts() {
      effects.set(`session:${sha256Hex(`${SESSION_AGREEMENT_FACTS_DOMAIN}${canonicalize({
        role,
        jobId: JOB_ID,
      })}`)}`, { factsVersion: "1", role, jobId: JOB_ID });
    },
    loseCoordinatorRecord() {
      coordinatorStatus = "missing";
    },
    retainedProposal: () =>
      effects.get(`session:${terminalTransportEffectId(role, "proposal")}`),
  };
}

// Each role receives the peer's proposal that the receiver failed the peer's Vet.
async function peerProposal(receiver: "buyer" | "seller") {
  const proposer = receiver === "buyer" ? "seller" : "buyer";
  const proposal = await terminalProposal(terminalInput("fail", "pay-x402", receiver));
  return authenticated(
    `terminal-bundle-proposal-${proposer}`,
    proposal,
    proposer === "buyer" ? BUYER : SELLER,
    receiver === "buyer" ? BUYER : SELLER,
  );
}

describe("Vet terminal pre-agreement boundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["buyer", "seller"] as const)(
    "the %s accepts a peer's authenticated Vet failure before agreement",
    async (receiver) => {
      const actor = memoryRoleDatabase(receiver);

      await expect(actor.runtime.handleMessage(
        await peerProposal(receiver),
        { role: receiver } as DacsLiveRoleInboundOperationContextV1,
      )).resolves.toEqual({ disposition: "accepted" });
      expect(actor.retainedProposal()).toBeDefined();
    },
  );

  it.each(["buyer", "seller"] as const)(
    "the %s rejects a peer's Vet failure once its agreement succeeded",
    async (receiver) => {
      const actor = memoryRoleDatabase(receiver);
      actor.concludeAgreement();

      await expect(actor.runtime.handleMessage(
        await peerProposal(receiver),
        { role: receiver } as DacsLiveRoleInboundOperationContextV1,
      )).resolves.toEqual({
        disposition: "rejected",
        reasonCode: "vet-terminal-not-pre-agreement",
      });
      expect(actor.retainedProposal()).toBeUndefined();
    },
  );

  it("the buyer rejects a seller's Vet failure after retaining the seller's passed Vet", async () => {
    const actor = memoryRoleDatabase("buyer");
    actor.retainAgreementFacts();

    await expect(actor.runtime.handleMessage(
      await peerProposal("buyer"),
      { role: "buyer" } as DacsLiveRoleInboundOperationContextV1,
    )).resolves.toEqual({
      disposition: "rejected",
      reasonCode: "vet-terminal-not-pre-agreement",
    });
    expect(actor.retainedProposal()).toBeUndefined();
  });

  it("the seller still accepts the buyer's failure of its Vet after retaining its own pass", async () => {
    const actor = memoryRoleDatabase("seller");
    actor.retainAgreementFacts();

    await expect(actor.runtime.handleMessage(
      await peerProposal("seller"),
      { role: "seller" } as DacsLiveRoleInboundOperationContextV1,
    )).resolves.toEqual({ disposition: "accepted" });
  });

  it.each(["buyer", "seller"] as const)(
    "the %s does not sign a retained Vet failure once agreement succeeded",
    async (receiver) => {
      const actor = memoryRoleDatabase(receiver);
      await expect(actor.runtime.handleMessage(
        await peerProposal(receiver),
        { role: receiver } as DacsLiveRoleInboundOperationContextV1,
      )).resolves.toEqual({ disposition: "accepted" });
      actor.concludeAgreement();

      // Retaining the terminal committed the job to it, so a concluded
      // agreement is a contradiction for an operator, not a fall-through.
      await expect(actor.runtime.advanceRegisteredTerminal(JOB_ID))
        .rejects.toMatchObject({ reasonCode: "agreement-vet-terminal-phase-conflict" });
      await expect(advanceDacsVetTerminalTrackV1(actor.runtime, actor.context, 1_000, JOB_ID))
        .resolves.toEqual({
          status: "operator-action",
          reasonCode: "agreement-vet-terminal-phase-conflict",
        });
      expect(actor.signComponent).not.toHaveBeenCalled();
      expect(actor.context.sendMessage).not.toHaveBeenCalled();
    },
  );

  it.each<[
    string,
    (actor: ReturnType<typeof memoryRoleDatabase>) => void,
    "pay-x402" | "pay-dem",
  ]>([
    ["no coordinator store owns the order", (actor) => actor.loseCoordinatorRecord(), "pay-x402"],
    ["the retained listing does not match the order rail", () => undefined, "pay-dem"],
  ])(
    "a job with no Vet failure is not blocked when %s",
    async (_label, arrange, applicationRail) => {
      const actor = memoryRoleDatabase("buyer", application(applicationRail));
      arrange(actor);

      await expect(advanceDacsVetTerminalTrackV1(actor.runtime, actor.context, 1_000, JOB_ID))
        .resolves.toBeUndefined();
    },
  );

  it("still fails closed when retained terminal state cannot be bound to its order", async () => {
    const actor = memoryRoleDatabase("buyer");
    await expect(actor.runtime.handleMessage(
      await peerProposal("buyer"),
      { role: "buyer" } as DacsLiveRoleInboundOperationContextV1,
    )).resolves.toEqual({ disposition: "accepted" });
    actor.loseCoordinatorRecord();

    await expect(advanceDacsVetTerminalTrackV1(actor.runtime, actor.context, 1_000, JOB_ID))
      .resolves.toEqual({
        status: "operator-action",
        reasonCode: "vet-terminal-finalization-unavailable",
      });
  });
});

// Plan A: the buyer's own Vet of the seller failed (local material). Plan B:
// the seller's Vet of the buyer failed (the seller's proposal). Both are
// authentic. This role's own failure against the peer's first plan is a
// two-sided disagreement in either arrival order; a second plan from the peer
// after one this role retained from it is equivocation.
describe("authenticated peer plans on the Vet terminal", () => {
  const phaseOf = (rail: "x402" | "pay-dem") => rail === "x402" ? "pay-x402" as const : "pay-dem" as const;
  const inbound = { role: "buyer" } as DacsLiveRoleInboundOperationContextV1;
  const fromSeller = (payload: unknown) =>
    authenticated("terminal-bundle-proposal-seller", payload, SELLER, BUYER);
  const restart = (actor: ReturnType<typeof memoryRoleDatabase>) =>
    createDacsVetTerminalBundleTransportRuntimeV1({
      context: actor.context,
      expectedRegistryVersions: REGISTRY_VERSIONS,
      authenticateProduction: async () => ({ status: "valid" }),
    });
  const sealed = (actor: ReturnType<typeof memoryRoleDatabase>) =>
    actor.effects.get(`session:${terminalTransportEffectId("buyer", "conflict")}`);
  const row = (actor: ReturnType<typeof memoryRoleDatabase>,
    kind: "material" | "proposal" | "selection" | "disagreement") =>
    actor.effects.get(`session:${terminalTransportEffectId("buyer", kind)}`);
  const disagreementStop = { status: "operator-action", reasonCode: "vet-terminal-plan-disagreement" };
  // Fails the next write of one row once, as a crash right before it would.
  const crashBefore = (actor: ReturnType<typeof memoryRoleDatabase>, kind: "material" | "proposal") => {
    const database = actor.context.database as unknown as {
      putEffectIntent: (input: Readonly<{ effectId: string }>) => unknown;
    };
    const put = database.putEffectIntent;
    database.putEffectIntent = (input) => {
      if (input.effectId !== terminalTransportEffectId("buyer", kind)) return put(input);
      database.putEffectIntent = put;
      throw new Error(`crash before the ${kind} binding`);
    };
  };

  for (const rail of ["x402", "pay-dem"] as const) {
    it(`${rail}: stops both roles for an operator when the peer's first plan differs from this role's own failure`, async () => {
      const actor = memoryRoleDatabase("buyer", undefined, rail);
      const registered = await actor.runtime.registerLocalTerminal(terminalInput("fail", phaseOf(rail)));
      const planB = await terminalProposal(terminalInput("fail", phaseOf(rail), "buyer"));
      expect(planB.plan.planHash).not.toBe(registered.proposal.plan.planHash);

      // Validation writes nothing and lets the authentic envelope be retained.
      const before = new Map(actor.effects);
      await expect(actor.runtime.validatePayload({
        type: "terminal-bundle-proposal-seller", payload: planB, jobId: JOB_ID, sender: SELLER, audience: BUYER,
      })).resolves.toMatchObject({ status: "valid" });
      expect(actor.effects).toEqual(before);

      await expect(actor.runtime.handleMessage(fromSeller(planB), inbound)).resolves.toEqual({
        disposition: "rejected", reasonCode: "vet-terminal-plan-disagreement",
      });
      expect(sealed(actor)).toBeUndefined();
      expect(actor.retainedProposal()).toBeUndefined();
      // The peer's losing plan is kept, with the envelope's authentication.
      await expect(actor.runtime.loadPlanDisagreementEvidence!(JOB_ID)).resolves.toEqual(expect.objectContaining({
        kind: "plan-disagreement", operatorAlert: true, selected: "local",
        localPlanHash: registered.proposal.plan.planHash, peerPlanHash: planB.plan.planHash,
        losingPayload: planB, losingPayloadHash: sha256Hex(canonicalize(planB)),
        authenticationHash: "c".repeat(64), identityEvidenceHash: "d".repeat(64),
      }));
      await expect(actor.runtime.loadPeerEquivocationEvidence!(JOB_ID)).resolves.toEqual({});

      // After a restart the track sends this role's own plan, which stops the
      // peer as well, and then reports the operator action. Nothing is signed.
      const restarted = restart(actor);
      await expect(advanceDacsVetTerminalTrackV1(restarted, actor.context, 1_000, JOB_ID))
        .resolves.toEqual(disagreementStop);
      expect(actor.context.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
        type: "terminal-bundle-proposal-buyer", payload: registered.proposal,
        idempotencyKey: `vet-terminal-proposal:v1:${registered.proposal.plan.planHash}` }));
      await expect(restarted.transport.publishProposal({
        identity: { jobId: JOB_ID, authorityHash: registered.proposal.plan.authorityHash,
          planHash: registered.proposal.plan.planHash },
        plan: registered.proposal.plan,
      }, {} as never)).rejects.toMatchObject({ reasonCode: "vet-terminal-plan-disagreement" });
      // A replay of the peer's plan is refused the same way.
      await expect(restarted.handleMessage(fromSeller(planB), inbound)).resolves.toEqual({
        disposition: "rejected", reasonCode: "vet-terminal-plan-disagreement",
      });
      expect(sealed(actor)).toBeUndefined();
      expect(actor.signComponent).not.toHaveBeenCalled();
    });

    it(`${rail}: reaches the same disagreement when this role's own failure follows the peer's accepted plan`, async () => {
      const actor = memoryRoleDatabase("buyer", undefined, rail);
      const planB = await terminalProposal(terminalInput("fail", phaseOf(rail), "buyer"));
      await expect(actor.runtime.handleMessage(fromSeller(planB), inbound))
        .resolves.toEqual({ disposition: "accepted" });
      await expect(restart(actor).registerLocalTerminal(terminalInput("fail", phaseOf(rail))))
        .rejects.toMatchObject({ reasonCode: "vet-terminal-plan-disagreement" });
      expect(sealed(actor)).toBeUndefined();
      const evidence = await actor.runtime.loadPlanDisagreementEvidence!(JOB_ID);
      expect(evidence).toMatchObject({ kind: "plan-disagreement", operatorAlert: true, selected: "peer",
        peerPlanHash: planB.plan.planHash });
      // This role's own losing plan is kept; no envelope authenticated it.
      expect(evidence?.losingPayload.plan.planHash).toBe(evidence?.localPlanHash);
      expect(evidence?.authenticationHash).toBeUndefined();
      expect(row(actor, "material")).toBeUndefined();

      await expect(advanceDacsVetTerminalTrackV1(restart(actor), actor.context, 1_000, JOB_ID))
        .resolves.toEqual(disagreementStop);
      expect(actor.context.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
        type: "terminal-bundle-proposal-buyer", payload: evidence?.losingPayload }));
      expect(actor.signComponent).not.toHaveBeenCalled();
    });

    it(`${rail}: alerts the operator for a conflicting plan after commit and keeps the committed plan`, async () => {
      const actor = memoryRoleDatabase("buyer", undefined, rail);
      const planA = await terminalProposal(terminalInput("fail", phaseOf(rail), "buyer"));
      await expect(actor.runtime.handleMessage(fromSeller(planA), inbound))
        .resolves.toEqual({ disposition: "accepted" });
      // A replay of the same plan is not a conflict.
      await expect(restart(actor).handleMessage(fromSeller(planA), inbound))
        .resolves.toEqual({ disposition: "accepted" });
      await expect(actor.runtime.loadPeerEquivocationEvidence!(JOB_ID)).resolves.toEqual({});

      const planB = await terminalProposal(terminalInput("fail", phaseOf(rail)));
      expect(planB.plan.planHash).not.toBe(planA.plan.planHash);
      const restarted = restart(actor);
      await expect(restarted.handleMessage(fromSeller(planB), inbound)).resolves.toEqual({
        disposition: "rejected", reasonCode: "vet-terminal-proposal-equivocation",
      });
      expect(sealed(actor)).toBeUndefined();
      expect(row(actor, "disagreement")).toBeUndefined();
      await expect(restarted.loadPeerEquivocationEvidence!(JOB_ID)).resolves.toEqual({
        afterCommit: expect.objectContaining({ operatorAlert: true,
          retainedPlanHash: planA.plan.planHash, offeredPlanHash: planB.plan.planHash }),
      });
      const identity = { jobId: JOB_ID, authorityHash: planA.plan.authorityHash, planHash: planA.plan.planHash };
      await expect(restarted.transport.resolveProposal(identity))
        .resolves.toEqual({ disposition: "present", value: planA.plan });
      // Only plan A's material is ever offered for signing.
      await expect(restarted.handleMessage(fromSeller(planA), inbound))
        .resolves.toEqual({ disposition: "accepted" });
      expect(actor.retainedProposal()).toMatchObject({ payload: planA });
      // The job continues with plan A, and its track reports the alert.
      await expect(advanceDacsVetTerminalTrackV1(restarted, actor.context, 1_000, JOB_ID))
        .resolves.toMatchObject({ reasonCode: "vet-terminal-peer-equivocation-alert" });
    });

    it(`${rail}: refuses a second peer plan before commit and continues the first after a restart`, async () => {
      const actor = memoryRoleDatabase("buyer", undefined, rail);
      const planA = await terminalProposal(terminalInput("fail", phaseOf(rail), "buyer"));
      // The first plan is selected, then the process dies before its binding.
      crashBefore(actor, "proposal");
      await expect(actor.runtime.handleMessage(fromSeller(planA), inbound)).rejects.toThrow("crash");
      expect(row(actor, "selection")).toMatchObject({ source: "peer", planHash: planA.plan.planHash });
      expect(actor.retainedProposal()).toBeUndefined();

      const planB = await terminalProposal(terminalInput("fail", phaseOf(rail)));
      const restarted = restart(actor);
      await expect(restarted.handleMessage(fromSeller(planB), inbound)).resolves.toEqual({
        disposition: "rejected", reasonCode: "vet-terminal-proposal-equivocation",
      });
      await expect(restarted.loadPeerEquivocationEvidence!(JOB_ID)).resolves.toEqual({
        beforeCommit: expect.objectContaining({ kind: "peer-equivocation", operatorAlert: false,
          retainedPlanHash: planA.plan.planHash, offeredPlanHash: planB.plan.planHash,
          payloadHash: sha256Hex(canonicalize(planB)), authenticationHash: "c".repeat(64) }),
      });
      // The next tick completes the selected plan's binding and continues it.
      const progress = await advanceDacsVetTerminalTrackV1(restart(actor), actor.context, 1_000, JOB_ID);
      expect(progress?.status).not.toBe("operator-action");
      expect(actor.retainedProposal()).toMatchObject({ payload: planA, authenticationHash: "c".repeat(64) });
      expect(sealed(actor)).toBeUndefined();
      expect(row(actor, "disagreement")).toBeUndefined();
    });

    it(`${rail}: finishes a local registration that crashed after selecting its plan instead of stranding the phase`, async () => {
      const actor = memoryRoleDatabase("buyer", undefined, rail);
      crashBefore(actor, "material");
      await expect(actor.runtime.registerLocalTerminal(terminalInput("fail", phaseOf(rail))))
        .rejects.toThrow("crash");
      expect(row(actor, "selection")).toMatchObject({ source: "material" });
      expect(row(actor, "material")).toBeUndefined();
      // The bootstrap's stranded-phase check runs only when this returns
      // undefined; the selected plan is completed and proposed instead.
      const progress = await advanceDacsVetTerminalTrackV1(restart(actor), actor.context, 1_000, JOB_ID);
      expect(progress).toBeDefined();
      expect(progress?.status).not.toBe("operator-action");
      expect(row(actor, "material")).toMatchObject({ kind: "material" });
      expect(actor.context.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        type: "terminal-bundle-proposal-buyer" }));
    });
  }

  it("keeps a disagreement pending until the peer acknowledges this role's plan", async () => {
    const actor = memoryRoleDatabase("buyer");
    await actor.runtime.registerLocalTerminal(terminalInput("fail", "pay-x402"));
    await actor.runtime.handleMessage(
      fromSeller(await terminalProposal(terminalInput("fail", "pay-x402", "buyer"))), inbound);
    vi.mocked(actor.context.sendMessage).mockRejectedValueOnce(new Error("peer unreachable"));
    await expect(advanceDacsVetTerminalTrackV1(actor.runtime, actor.context, 1_000, JOB_ID))
      .resolves.toMatchObject({ status: "pending-retry",
        reasonCode: "vet-terminal-plan-disagreement-notice-pending" });
    await expect(advanceDacsVetTerminalTrackV1(actor.runtime, actor.context, 1_000, JOB_ID))
      .resolves.toEqual(disagreementStop);
    expect(actor.signComponent).not.toHaveBeenCalled();
  });

  // Two processes share one role database: one registers this role's own Vet
  // failure while the other accepts the peer's proposal. The one insert-once
  // selection decides; the other plan is the disagreement's evidence, never a
  // second retained plan or a sealed split.
  it.each(["local registration", "inbound proposal"])(
    "decides a local failure racing the peer's proposal with one selection (%s started first)",
    async (first) => {
      const actor = memoryRoleDatabase("buyer");
      const planB = await terminalProposal(terminalInput("fail", "pay-x402", "buyer"));
      const local = () => restart(actor).registerLocalTerminal(terminalInput("fail", "pay-x402"));
      const peer = () => restart(actor).handleMessage(fromSeller(planB), inbound);
      const settled = await Promise.allSettled(first === "local registration"
        ? [local(), peer()] : [peer(), local()]);
      expect(settled.some((result) => result.status === "fulfilled" &&
        (result.value as { disposition?: string }).disposition === "accepted")).toBe(false);
      expect(row(actor, "material") !== undefined && row(actor, "proposal") !== undefined).toBe(false);
      expect(sealed(actor)).toBeUndefined();
      await expect(actor.runtime.loadPlanDisagreementEvidence!(JOB_ID)).resolves.toMatchObject({
        operatorAlert: true, peerPlanHash: planB.plan.planHash });
      await expect(advanceDacsVetTerminalTrackV1(restart(actor), actor.context, 1_000, JOB_ID))
        .resolves.toEqual(disagreementStop);
      expect(actor.signComponent).not.toHaveBeenCalled();
    },
  );

  it("drives the track for an implementation without the optional evidence loaders", async () => {
    const actor = memoryRoleDatabase("buyer");
    await actor.runtime.registerLocalTerminal(terminalInput("fail", "pay-x402"));
    // This object literal type-checks only while both loaders stay optional.
    const minimal: DacsVetTerminalBundleTransportRuntimeV1 = {
      transport: actor.runtime.transport,
      validatePayload: actor.runtime.validatePayload,
      registerLocalTerminal: actor.runtime.registerLocalTerminal,
      advanceRegisteredTerminal: actor.runtime.advanceRegisteredTerminal,
      handleMessage: actor.runtime.handleMessage,
    };
    await expect(advanceDacsVetTerminalTrackV1(minimal, actor.context, 1_000, JOB_ID))
      .resolves.toMatchObject({ status: "pending-retry" });
  });

  it("accepts the peer's proposal of the same plan that this role's own failure selected", async () => {
    const actor = memoryRoleDatabase("buyer");
    const registered = await actor.runtime.registerLocalTerminal(terminalInput("fail", "pay-x402"));
    await expect(restart(actor).handleMessage(fromSeller(registered.proposal), inbound))
      .resolves.toEqual({ disposition: "accepted" });
    expect(actor.retainedProposal()).toMatchObject({ payload: registered.proposal });
    expect(row(actor, "disagreement")).toBeUndefined();
  });

  // Both roles hold the same plan: either arrival order selects it once and
  // the job finalizes it, with no disagreement, equivocation or seal.
  for (const rail of ["x402", "pay-dem"] as const) {
    it.each(["local failure", "peer proposal"] as const)(
      `${rail}: continues the one plan both roles hold (%s first)`,
      async (first) => {
        const actor = memoryRoleDatabase("buyer", undefined, rail);
        const own = await terminalProposal(terminalInput("fail", phaseOf(rail)));
        const register = (runtime: Readonly<DacsVetTerminalBundleTransportRuntimeV1>) =>
          expect(runtime.registerLocalTerminal(terminalInput("fail", phaseOf(rail))))
            .resolves.toMatchObject({ proposal: { plan: { planHash: own.plan.planHash } } });
        const receive = (runtime: Readonly<DacsVetTerminalBundleTransportRuntimeV1>) =>
          expect(runtime.handleMessage(fromSeller(own), inbound))
            .resolves.toEqual({ disposition: "accepted" });
        if (first === "local failure") {
          await register(actor.runtime);
          await receive(restart(actor));
        } else {
          await receive(actor.runtime);
          await register(restart(actor));
        }
        expect(row(actor, "selection")).toMatchObject({ planHash: own.plan.planHash,
          source: first === "local failure" ? "material" : "peer" });
        expect(row(actor, "disagreement")).toBeUndefined();
        expect(sealed(actor)).toBeUndefined();
        await expect(actor.runtime.loadPeerEquivocationEvidence!(JOB_ID)).resolves.toEqual({});
        const progress = await advanceDacsVetTerminalTrackV1(restart(actor), actor.context, 1_000, JOB_ID);
        expect(progress).toBeDefined();
        expect(progress?.status).not.toBe("operator-action");
      },
    );
  }

  // The SDK only checks the shape of the host's recursive DACS-2 verifier.
  // Anything but a well-formed `valid` must fail closed with nothing signed.
  it.each<[string, () => Promise<unknown>]>([
    ["invalid", async () => ({ status: "invalid", reason: "recursive Vet authentication failed" })],
    ["indeterminate", async () => ({ status: "indeterminate", reason: "verifier unavailable" })],
    ["a thrown error", async () => { throw new Error("verifier crashed"); }],
    ["an empty result", async () => ({})],
    ["an unknown status", async () => ({ status: "trusted" })],
    ["a valid status with extra members", async () => ({ status: "valid", trusted: true })],
    ["no result", async () => undefined],
  ])("fails closed when the host Vet verifier returns %s", async (_label, verifier) => {
    for (const rail of ["x402", "pay-dem"] as const) {
      const actor = memoryRoleDatabase("buyer", undefined, rail);
      const runtime = createDacsVetTerminalBundleTransportRuntimeV1({
        context: actor.context,
        expectedRegistryVersions: REGISTRY_VERSIONS,
        authenticateProduction: verifier as never,
      });
      const proposal = await terminalProposal(terminalInput("fail", phaseOf(rail), "buyer"));
      const validation = await runtime.validatePayload({
        type: "terminal-bundle-proposal-seller", payload: proposal, jobId: JOB_ID, sender: SELLER, audience: BUYER,
      });
      expect(validation.status).not.toBe("valid");
      const handled = await runtime.handleMessage(fromSeller(proposal), inbound)
        .then((value) => value, (error: unknown) => ({ thrown: error }));
      expect(handled).not.toEqual({ disposition: "accepted" });
      await expect(runtime.registerLocalTerminal(terminalInput("fail", phaseOf(rail))))
        .rejects.toBeInstanceOf(Error);
      expect(actor.retainedProposal()).toBeUndefined();
      expect(actor.effects.get(`session:${terminalTransportEffectId("buyer", "material")}`)).toBeUndefined();
      expect(actor.signComponent).not.toHaveBeenCalled();
      expect(actor.context.sendMessage).not.toHaveBeenCalled();
    }
  });

  it("seals when this role registers a second local plan over its retained material", async () => {
    const actor = memoryRoleDatabase("buyer");
    await actor.runtime.registerLocalTerminal(terminalInput("fail", "pay-x402"));
    await expect(restart(actor).registerLocalTerminal(terminalInput("fail", "pay-x402", "buyer")))
      .rejects.toMatchObject({ reasonCode: "vet-terminal-binding-conflict" });
    expect(sealed(actor)).toMatchObject({ kind: "plan-conflict" });
  });
});

// The code reviewer's round-5 two-actor probe, as a test: each role's Vet of
// the other failed, so each holds its own plan. The two transports deliver to
// each other's handleMessage, and both bootstrap terminal tracks tick.
describe("two honest, different Vet failures", () => {
  type Actor = ReturnType<typeof memoryRoleDatabase>;
  const stop = { status: "operator-action", reasonCode: "vet-terminal-plan-disagreement" };
  const pair = (rail: "x402" | "pay-dem") => {
    const buyer = memoryRoleDatabase("buyer", undefined, rail);
    const seller = memoryRoleDatabase("seller", undefined, rail);
    const runtimes = {} as Record<"buyer" | "seller", Readonly<DacsVetTerminalBundleTransportRuntimeV1>>;
    for (const [role, actor] of [["buyer", buyer], ["seller", seller]] as const) {
      const peer = role === "buyer" ? "seller" : "buyer";
      (actor.context as unknown as { sendMessage: unknown }).sendMessage = vi.fn(
        async (message: Readonly<{ type: string; payload: unknown }>) => acknowledgement((await runtimes[peer]
          .handleMessage(authenticated(message.type as never, message.payload,
            role === "buyer" ? BUYER : SELLER, role === "buyer" ? SELLER : BUYER),
          { role: peer } as DacsLiveRoleInboundOperationContextV1)).disposition as never));
      runtimes[role] = createDacsVetTerminalBundleTransportRuntimeV1({
        context: actor.context,
        expectedRegistryVersions: REGISTRY_VERSIONS,
        authenticateProduction: async () => ({ status: "valid" }),
      });
    }
    const actors: Record<"buyer" | "seller", Actor> = { buyer, seller };
    const tick = (role: "buyer" | "seller") =>
      advanceDacsVetTerminalTrackV1(runtimes[role], actors[role].context, 1_000, JOB_ID);
    return { actors, runtimes, tick };
  };
  const conflictSealed = (actor: Actor, role: "buyer" | "seller") =>
    actor.effects.has(`session:${terminalTransportEffectId(role, "conflict")}`);

  for (const rail of ["x402", "pay-dem"] as const) {
    const phase = rail === "x402" ? "pay-x402" as const : "pay-dem" as const;
    for (const first of ["buyer", "seller"] as const) {
      it(`${rail}: stops both roles at the same operator action when the ${first}'s plan arrives first`, async () => {
        const { actors, runtimes, tick } = pair(rail);
        await runtimes.buyer.registerLocalTerminal(terminalInput("fail", phase, "seller"));
        await runtimes.seller.registerLocalTerminal(terminalInput("fail", phase, "buyer"));
        const order = first === "buyer" ? ["buyer", "seller"] as const : ["seller", "buyer"] as const;
        const last: Record<string, unknown> = {};
        for (let round = 0; round < 3; round += 1) {
          for (const role of order) last[role] = await tick(role);
        }
        expect(last).toEqual({ buyer: stop, seller: stop });
        for (const role of ["buyer", "seller"] as const) {
          expect(actors[role].signComponent).not.toHaveBeenCalled();
          expect(conflictSealed(actors[role], role)).toBe(false);
          await expect(runtimes[role].loadPlanDisagreementEvidence!(JOB_ID))
            .resolves.toMatchObject({ operatorAlert: true, selected: "local" });
        }
      });
    }

    it(`${rail}: stops both roles when the buyer's own failure follows the seller's accepted plan`, async () => {
      const { actors, runtimes, tick } = pair(rail);
      await runtimes.seller.registerLocalTerminal(terminalInput("fail", phase, "buyer"));
      await tick("seller");
      expect(actors.buyer.retainedProposal()).toBeDefined();
      await runtimes.buyer.registerLocalTerminal(terminalInput("fail", phase, "seller"))
        .then(() => { throw new Error("registered"); }, (error: { reasonCode?: string }) =>
          expect(error.reasonCode).toBe("vet-terminal-plan-disagreement"));
      // The seller contributed its own signature to its plan while that plan
      // was the only one; the buyer never co-signs it.
      const sellerSignatures = vi.mocked(actors.seller.signComponent).mock.calls.length;
      const last: Record<string, unknown> = {};
      for (let round = 0; round < 3; round += 1) {
        for (const role of ["buyer", "seller"] as const) last[role] = await tick(role);
      }
      expect(last).toEqual({ buyer: stop, seller: stop });
      // The buyer signs nothing, nothing more is signed after the
      // disagreement, and neither role finalizes a bundle.
      expect(actors.buyer.signComponent).not.toHaveBeenCalled();
      expect(actors.seller.signComponent).toHaveBeenCalledTimes(sellerSignatures);
      await expect(runtimes.buyer.loadPlanDisagreementEvidence!(JOB_ID))
        .resolves.toMatchObject({ selected: "peer" });
      await expect(runtimes.seller.loadPlanDisagreementEvidence!(JOB_ID))
        .resolves.toMatchObject({ selected: "local" });
    });
  }
});

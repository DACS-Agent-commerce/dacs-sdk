import { trustedSessionProfile } from "./helpers/sessionProfile.js";
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
  type PrepareVetTerminalBundleDeps,
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
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

// Explicitly non-live harness: the live paths here run against a released
// profile record; the real record at the pin refuses every admission.
vi.mock("../../../src/discovery/standardProfileRelease.js", () => ({ DACS_STANDARD_PROFILE_STATUS: "released" }));

import { DACS_NODE_LIVE_PROFILE } from "../src/config.js";
import type { DacsDemosActorRuntimeV1 } from "../src/demosRuntime.js";
import { createDacsFixedPricePayDemOrderPairV1 } from "../src/liveOrder.js";
import { putDacsLiveOrderInputV1 } from "../src/orderInput.js";
import { claimDacsPreAgreementPhaseV1 } from "../src/preAgreementPhase.js";
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
  advanceDacsVetTerminalTrackV1,
  createDacsBuyerSessionBootstrapAgreementTrackV1,
  createDacsPayDemBuyerSessionBootstrapAgreementTrackV1,
  createDacsPayDemSellerSessionBootstrapAgreementTrackV1,
  createDacsSellerSessionBootstrapAgreementTrackV1,
} from "../src/sessionBootstrapAgreementRuntime.js";
import {
  createDacsVetTerminalBundleTransportRuntimeV1,
  type DacsVetTerminalBundleTransportRuntimeV1,
} from "../src/terminalBundleTransportRuntime.js";
import { inProcessHttpFetch } from "./helpers/httpInProcess.js";
import { createDacsHttpEnvelopeV1 } from "../src/transport/envelope.js";
import { createDacsHttpMessageClientV1 } from "../src/transport/http.js";
import type {
  DacsHttpAuthenticatedEnvelopeV1,
  DacsHttpEnvelopeV1,
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
  kind: "material" | "proposal" | "contribution" | "conflict" | "selection" | "disagreement" |
    "local-vet",
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
  complete = true,
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
  const nativeAddress = `stor-${(evaluatedRole === "buyer" ? "4" : "8").repeat(64)}`;
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
    ...(decision !== "pass" && complete ? { complementaryProduction:
      terminalInput("pass", paymentPhase, evaluatedRole === "buyer" ? "seller" : "buyer", false).production } : {}),
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

// Records that `role`'s own Vet of its peer passed, on an order opened by
// `open(role, rail)`.
function passOwnVet(
  runtime: Readonly<DacsVetTerminalBundleTransportRuntimeV1>,
  role: "buyer" | "seller",
  rail: "x402" | "pay-dem" = "x402",
) {
  const pair = rail === "pay-dem" ? payDemOrderPair() : undefined;
  return runtime.registerLocalVetPass!({
    jobId: JOB_ID,
    localBindingHash: pair === undefined
      ? fixedPriceX402OrderLocalBindingHash(order(role))
      : role === "buyer" ? pair.buyerLocalBindingHash : pair.sellerLocalBindingHash,
  }, terminalInput("pass", rail === "x402" ? "pay-x402" : "pay-dem", role === "buyer" ? "seller" : "buyer"));
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
    const context = { authenticateSessionProfile: () => trustedSessionProfile(JOB_ID, BUYER, SELLER),
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
        authenticateSessionProfile: () => trustedSessionProfile(JOB_ID, BUYER, SELLER),
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
      authenticateSessionProfile: () => trustedSessionProfile(JOB_ID, BUYER, SELLER),
      role: "buyer", authority: BUYER, peerAuthority: SELLER,
      database: buyerDatabase, sendMessage: buyerSend,
    } as unknown as DacsLiveRoleOperationContextV1;
    const sellerContext = {
      authenticateSessionProfile: () => trustedSessionProfile(JOB_ID, BUYER, SELLER),
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
    // The seller's own Vet of the buyer passed, so it accepts the buyer's plan.
    await passOwnVet(sellerRuntime, "seller");
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
    expect(sellerSend.mock.calls.filter(([message]) => message.type === "terminal-bundle-contribution-seller")).toHaveLength(1);
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
      authenticateSessionProfile: () => trustedSessionProfile(JOB_ID, BUYER, SELLER),
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
      authenticateSessionProfile: () => trustedSessionProfile(JOB_ID, BUYER, SELLER),
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
    await passOwnVet(sellerRuntime, "seller");

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
  }, 20_000);

  it.each(["error", "indeterminate"] as const)(
    "retains authenticated parse cause for %s without blaming the verifier", async (decision) => {
      const database = await open("buyer");
      const context = { authenticateSessionProfile: () => trustedSessionProfile(JOB_ID, BUYER, SELLER), role: "buyer", authority: BUYER, peerAuthority: SELLER,
        database, sendMessage: vi.fn() } as unknown as DacsLiveRoleOperationContextV1;
      const input = terminalInput(decision);
      const authenticateProduction = vi.fn(async ({ production, evaluatedIdentity, verifierIdentity }:
        Parameters<PrepareVetTerminalBundleDeps["authenticateProduction"]>[0]) => ({
        status: "valid" as const,
        cause: { kind: "counterparty-presentation-parse" as const,
          jobId: production.record.jobId, recordHash: production.recordRef.contentHash,
          evaluatedIdentityHash: identityBundleHash(evaluatedIdentity),
          verifierIdentityHash: identityBundleHash(verifierIdentity) },
      }));
      const runtime = createDacsVetTerminalBundleTransportRuntimeV1({ context,
        expectedRegistryVersions: REGISTRY_VERSIONS, authenticateProduction });
      const registered = await runtime.registerLocalTerminal(input);
      expect(registered).toMatchObject({ prepared: { authority: { faultedParty: "seller" } } });
      const restarted = createDacsVetTerminalBundleTransportRuntimeV1({ context,
        expectedRegistryVersions: REGISTRY_VERSIONS, authenticateProduction });
      await expect(restarted.registerLocalTerminal(input)).resolves.toEqual(registered);
    });

  it("does not retain or sign a plan the peer cannot independently authorize", async () => {
    const buyerDatabase = await open("buyer");
    const sellerDatabase = await open("seller");
    let buyerRuntime: Readonly<DacsVetTerminalBundleTransportRuntimeV1>;
    const buyerContext = {
      authenticateSessionProfile: () => trustedSessionProfile(JOB_ID, BUYER, SELLER),
      role: "buyer", authority: BUYER, peerAuthority: SELLER,
      database: buyerDatabase,
      sendMessage: vi.fn(),
    } as unknown as DacsLiveRoleOperationContextV1;
    const sellerContext = {
      authenticateSessionProfile: () => trustedSessionProfile(JOB_ID, BUYER, SELLER),
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
      authenticateSessionProfile: () => trustedSessionProfile(JOB_ID, BUYER, SELLER),
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
      authenticateSessionProfile: () => trustedSessionProfile(JOB_ID, BUYER, SELLER),
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
    await passOwnVet(sellerRuntime, "seller");
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

  it.each(["proposal", "contribution"] as const)(
    "retries the exact terminal %s over HTTP after a verifier outage and sender restart", async (kind) => {
      const buyerDatabase = await open("buyer");
      const sellerDatabase = await open("seller");
      let available = true;
      const runtime = createDacsVetTerminalBundleTransportRuntimeV1({
        context: { authenticateSessionProfile: () => trustedSessionProfile(JOB_ID, BUYER, SELLER), role: "buyer", authority: BUYER, peerAuthority: SELLER,
          database: buyerDatabase, sendMessage: vi.fn() } as unknown as DacsLiveRoleOperationContextV1,
        expectedRegistryVersions: REGISTRY_VERSIONS,
        authenticateProduction: async () => available
          ? { status: "valid" } : { status: "indeterminate", reason: "recursive evidence pending" },
      });
      const registered = await runtime.registerLocalTerminal(terminalInput());
      if (kind === "contribution") {
        await runtime.handleMessage(authenticated("terminal-bundle-proposal-seller",
          registered.proposal, SELLER, BUYER), { role: "buyer" } as DacsLiveRoleInboundOperationContextV1);
      }
      const resolveIdentity = async (input: { sender: string; jobId: string }) => {
        const buyer = input.sender === BUYER;
        return { status: "authenticated" as const, principal: input.sender, jobId: input.jobId,
          role: buyer ? "buyer" as const : "seller" as const,
          publicKey: rawPublicKey(publicKeyFromSeed(buyer ? BUYER_SEED : SELLER_SEED)),
          evidenceHash: (buyer ? "a" : "b").repeat(64) };
      };
      const handle = vi.fn((message: Readonly<DacsHttpAuthenticatedEnvelopeV1>) =>
        runtime.handleMessage(message, { role: "buyer" } as DacsLiveRoleInboundOperationContextV1));
      const exchange = inProcessHttpFetch({
        authority: BUYER,
        inbox: buyerDatabase.createHttpInboxStore(), resolveIdentity,
        validatePayload: runtime.validatePayload, handleMessage: handle,
        signAcknowledgement: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(BUYER_SEED)),
      });
      {
        const outbox = sellerDatabase.createHttpOutboxStore({ retryJitter: () => 0 });
        const now = await outbox.readTime();
        const signed = await createDacsHttpEnvelopeV1({
          type: kind === "proposal" ? "terminal-bundle-proposal-seller" : "terminal-bundle-contribution-seller",
          jobId: JOB_ID, sender: SELLER, audience: BUYER,
          issuedAt: now - 1000, expiresAt: now + 299000,
          nonce: Buffer.alloc(32, 17).toString("base64url"),
          payload: kind === "proposal" ? registered.proposal : contribution(registered.proposal.plan, "seller"),
        }, (bytes) => ed25519Sign(bytes, privateKeyFromSeed(SELLER_SEED))) as Readonly<DacsHttpEnvelopeV1>;
        const statuses: number[] = [];
        const bodies: unknown[] = [];
        const options = { endpoint: "http://127.0.0.1/dacs-transport/v1/messages", authority: SELLER, outbox, resolveIdentity,
          workerId: "seller-before-restart", fetch: async (...args: Parameters<typeof fetch>) => {
            bodies.push(args[1]?.body);
            const response = await exchange(...args);
            statuses.push(response.status);
            return response;
          } };
        available = false;
        const client = createDacsHttpMessageClientV1(options);
        await client.queue(signed);
        await expect(client.dispatch(signed.envelopeId)).resolves.toMatchObject({ status: "retry-scheduled" });
        expect(statuses).toEqual([503]);
        const retained = (await outbox.load(signed.envelopeId))!;
        expect(retained).toMatchObject({ state: "pending", attempts: 1, envelope: signed });
        expect(handle).not.toHaveBeenCalled();
        available = true;
        const raw = new BetterSqlite3(databasePaths.get(sellerDatabase)!);
        try { raw.prepare("UPDATE dacs_http_clock SET last_time = ? WHERE singleton = 1").run(retained.nextAttemptAt + 1); }
        finally { raw.close(); }
        const restarted = createDacsHttpMessageClientV1({ ...options, workerId: "seller-after-restart" });
        await expect(restarted.dispatch(signed.envelopeId)).resolves.toMatchObject({ status: "acknowledged" });
        await expect(restarted.dispatch(signed.envelopeId)).resolves.toMatchObject({ status: "acknowledged" });
        expect(statuses).toEqual([503, 202]);
        expect(bodies).toEqual([canonicalize(signed), canonicalize(signed)]);
        expect(handle).toHaveBeenCalledOnce();
        await expect(outbox.load(signed.envelopeId)).resolves.toMatchObject({ state: "acknowledged", attempts: 2 });
      }
    },
  );

  it.each(["order", "application"] as const)("retries a proposal while its local %s is pending", async (prerequisite) => {
    const database = await open("buyer");
    const runtime = createDacsVetTerminalBundleTransportRuntimeV1({
      context: { authenticateSessionProfile: () => trustedSessionProfile(JOB_ID, BUYER, SELLER), role: "buyer", authority: BUYER, peerAuthority: SELLER,
        database, sendMessage: vi.fn() } as unknown as DacsLiveRoleOperationContextV1,
      expectedRegistryVersions: REGISTRY_VERSIONS,
      authenticateProduction: async () => ({ status: "valid" }),
    });
    const proposal = await terminalProposal(terminalInput());
    const restore = prerequisite === "order"
      ? vi.spyOn(database, "createLiveCoordinatorStore").mockReturnValue({
          load: async () => ({ status: "missing" }),
        } as never)
      : vi.spyOn(database, "loadEffectInput").mockReturnValue(undefined);
    const input = { type: "terminal-bundle-proposal-seller" as const,
      payload: proposal, jobId: JOB_ID, sender: SELLER, audience: BUYER };
    await expect(runtime.validatePayload(input)).resolves.toEqual({
      status: "unavailable", reasonCode: prerequisite === "order"
        ? "vet-terminal-order-pending" : "vet-terminal-order-input-pending",
    });
    restore.mockRestore();
    await expect(runtime.validatePayload(input)).resolves.toEqual({ status: "valid" });
  });

  it("retries an early contribution until its proposal is retained and rejects proven invalid production", async () => {
    const database = await open("buyer");
    let valid = true;
    const runtime = createDacsVetTerminalBundleTransportRuntimeV1({
      context: { authenticateSessionProfile: () => trustedSessionProfile(JOB_ID, BUYER, SELLER), role: "buyer", authority: BUYER, peerAuthority: SELLER,
        database, sendMessage: vi.fn() } as unknown as DacsLiveRoleOperationContextV1,
      expectedRegistryVersions: REGISTRY_VERSIONS,
      authenticateProduction: async () => valid ? { status: "valid" }
        : { status: "invalid", reason: "proven invalid production" },
    });
    const proposal = await terminalProposal(terminalInput());
    const input = { type: "terminal-bundle-contribution-seller" as const,
      payload: contribution(proposal.plan, "seller"), jobId: JOB_ID, sender: SELLER, audience: BUYER };
    await expect(runtime.validatePayload(input)).resolves.toEqual({
      status: "unavailable", reasonCode: "vet-terminal-proposal-pending",
    });
    await runtime.registerLocalTerminal(terminalInput());
    await runtime.handleMessage(authenticated("terminal-bundle-proposal-seller", proposal, SELLER, BUYER),
      { role: "buyer" } as DacsLiveRoleInboundOperationContextV1);
    await expect(runtime.validatePayload(input)).resolves.toEqual({ status: "valid" });
    valid = false;
    await expect(runtime.validatePayload(input)).resolves.toEqual({
      status: "invalid", reasonCode: "vet-terminal-production-invalid",
    });
  });

  it("keeps an authentication outage pending without retaining terminal authority", async () => {
    const buyerDatabase = await open("buyer");
    const context = { authenticateSessionProfile: () => trustedSessionProfile(JOB_ID, BUYER, SELLER),
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

  // The local Vet production's own authentication decides whether the node
  // may propose a terminal: unavailable evidence is retried, never proposed.
  it.each([
    ["indeterminate", "vet-terminal-production-indeterminate"],
    ["invalid", "vet-terminal-production-invalid"],
  ] as const)("registers no local terminal whose Vet production is %s", async (status, reasonCode) => {
    const buyerDatabase = await open("buyer");
    const sendMessage = vi.fn();
    const context = { authenticateSessionProfile: () => trustedSessionProfile(JOB_ID, BUYER, SELLER),
      role: "buyer", authority: BUYER, peerAuthority: SELLER,
      database: buyerDatabase, sendMessage,
    } as unknown as DacsLiveRoleOperationContextV1;
    const runtime = createDacsVetTerminalBundleTransportRuntimeV1({
      context,
      expectedRegistryVersions: REGISTRY_VERSIONS,
      authenticateProduction: async () => ({ status, reason: "recursive Vet evidence unavailable" }),
    });

    await expect(runtime.registerLocalTerminal(terminalInput("fail", "pay-x402")))
      .rejects.toMatchObject({ reasonCode });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(buyerDatabase.loadEffectInput(
      "session",
      terminalTransportEffectId("buyer", "proposal"),
    )).toBeUndefined();
  });

  it("accepts native DEM terminal material but rejects a substituted rail pipeline", async () => {
    const buyerDatabase = await open("buyer", "pay-dem");
    const context = { authenticateSessionProfile: () => trustedSessionProfile(JOB_ID, BUYER, SELLER),
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
    const context = { authenticateSessionProfile: () => trustedSessionProfile(JOB_ID, BUYER, SELLER),
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

  // DACS-5 §10.4.1 required signers, BB-5 role authority: only
  // the plan-party check binds a plan's buyer, seller and required signers
  // to this role's authority and its authenticated peer.
  it("refuses a plan whose parties are not this role and its authenticated peer", async () => {
    const OTHER = claim(new Uint8Array(32).fill(73));
    const buyerDatabase = await open("buyer");
    const authenticate = vi.fn(async () => ({ status: "valid" as const }));
    const sendMessage = vi.fn();
    const runtime = createDacsVetTerminalBundleTransportRuntimeV1({
      context: {
        authenticateSessionProfile: () => trustedSessionProfile(JOB_ID, BUYER, OTHER),
        role: "buyer", authority: BUYER, peerAuthority: OTHER,
        database: buyerDatabase, sendMessage,
      } as unknown as DacsLiveRoleOperationContextV1,
      expectedRegistryVersions: REGISTRY_VERSIONS,
      authenticateProduction: authenticate,
    });
    const persist = vi.spyOn(buyerDatabase, "putEffectIntent");
    // A context whose peer is not the order's is refused before any plan.
    await expect(runtime.registerLocalTerminal(terminalInput()))
      .rejects.toMatchObject({ reasonCode: "vet-terminal-order-mismatch" });
    expect(persist).not.toHaveBeenCalled();

    // The order's own peer proposes a self-consistent plan that names another
    // buyer: its Vet of the seller is signed and anchored by that buyer.
    const sellerDatabase = await open("seller");
    const sellerSend = vi.fn();
    const seller = createDacsVetTerminalBundleTransportRuntimeV1({
      context: {
        authenticateSessionProfile: () => trustedSessionProfile(JOB_ID, BUYER, SELLER),
        role: "seller", authority: SELLER, peerAuthority: BUYER,
        database: sellerDatabase, sendMessage: sellerSend,
      } as unknown as DacsLiveRoleOperationContextV1,
      expectedRegistryVersions: REGISTRY_VERSIONS,
      authenticateProduction: authenticate,
    });
    const sellerPersist = vi.spyOn(sellerDatabase, "putEffectIntent");
    const input = terminalInput();
    const record = { ...input.production.record,
      signature: { ...input.production.record.signature, signer: OTHER } };
    const recordHash = contentHash(record as unknown as Record<string, unknown>);
    const substituted: PrepareVetTerminalBundleInput = {
      ...input,
      parties: [
        { role: "buyer", identityBundle: { ...identity("buyer"), presentedBy: OTHER, claims: [{ ref: OTHER }] } },
        input.parties[1]!,
      ],
      production: {
        record,
        recordRef: { ...input.production.recordRef, contentHash: recordHash, signer: OTHER },
        anchorReceipt: { ...input.production.anchorReceipt!, contentHash: recordHash, writer: OTHER },
      },
    };
    const opposite = substituted.complementaryProduction!;
    const oppositeRecord = { ...opposite.record, evaluatedParty: OTHER,
      bundleHash: identityBundleHash(substituted.parties[0]!.identityBundle) };
    const oppositeHash = contentHash(oppositeRecord as unknown as Record<string, unknown>);
    substituted.complementaryProduction = { ...opposite, record: oppositeRecord,
      recordRef: { ...opposite.recordRef, contentHash: oppositeHash },
      anchorReceipt: { ...opposite.anchorReceipt, contentHash: oppositeHash,
        logicalAddress: compositeVerificationAddress(JOB_ID, OTHER) } };
    const proposal = await terminalProposal(substituted);
    expect(proposal.plan.authority.parties.find((party) => party.role === "buyer")?.primaryClaim)
      .toBe(OTHER);
    await expect(seller.handleMessage(
      authenticated("terminal-bundle-proposal-buyer", proposal, BUYER, SELLER),
      { role: "seller" } as DacsLiveRoleInboundOperationContextV1,
    )).resolves.toEqual({ disposition: "rejected", reasonCode: "vet-terminal-plan-party-mismatch" });
    expect(sellerPersist).not.toHaveBeenCalled();
    expect(sellerSend).not.toHaveBeenCalled();
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
    const context = { authenticateSessionProfile: () => trustedSessionProfile(JOB_ID, BUYER, SELLER),
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
    const context = { authenticateSessionProfile: () => trustedSessionProfile(JOB_ID, BUYER, SELLER),
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
    // The seller's failure of the buyer, whose own Vet of the seller passed.
    const proposal = await terminalProposal(terminalInput("fail", "pay-x402", "buyer"));
    await passOwnVet(runtime, "buyer");

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
    const context = { authenticateSessionProfile: () => trustedSessionProfile(JOB_ID, BUYER, SELLER),
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
      // The buyer's own Vet has not decided: the peer's plan is selected but
      // neither accepted nor bound, and the inbox keeps the message pending.
      await expect(runtime.handleMessage(
        authenticated(
          "terminal-bundle-proposal-seller",
          peerProposal,
          SELLER,
          BUYER,
        ),
        { role: "buyer" } as DacsLiveRoleInboundOperationContextV1,
      )).rejects.toMatchObject({ reasonCode: "vet-terminal-local-vet-pending" });
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
    expect(proposal).toBeUndefined();
    expect(buyerDatabase.loadEffectInput(
      "session",
      terminalTransportEffectId("buyer", "selection"),
    )).toMatchObject({ source: first === "material" ? "material" : "peer" });
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
      const context = { authenticateSessionProfile: () => trustedSessionProfile(JOB_ID, BUYER, SELLER),
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
    ["indeterminate", "unavailable", "vet-terminal-production-indeterminate"],
  ] as const)("does not tombstone a distinct peer plan when Vet authentication is %s", async (
    authenticationStatus,
    validationStatus,
    reasonCode,
  ) => {
    const buyerDatabase = await open("buyer");
    const context = { authenticateSessionProfile: () => trustedSessionProfile(JOB_ID, BUYER, SELLER),
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
    const context = { authenticateSessionProfile: () => trustedSessionProfile(JOB_ID, BUYER, SELLER),
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
    const context = { authenticateSessionProfile: () => trustedSessionProfile(JOB_ID, BUYER, SELLER),
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
    )).rejects.toMatchObject({
      reasonCode: "vet-terminal-proposal-version-authority-unavailable",
    });
    expect(authenticate).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it("rejects a contribution whose detached signature row was altered", async () => {
    const buyerDatabase = await open("buyer");
    const buyerContext = {
      authenticateSessionProfile: () => trustedSessionProfile(JOB_ID, BUYER, SELLER),
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
  const context = { authenticateSessionProfile: () => trustedSessionProfile(JOB_ID, BUYER, SELLER),
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
    // This role's own Vet of the peer passed. A peer's plan is accepted and
    // signed only once this, or this role's own failure of it, is recorded.
    passOwnVet: () => runtime.registerLocalVetPass!({
      jobId: JOB_ID,
      localBindingHash: coordinatorRecord().localBindingHash,
    }, terminalInput("pass", rail === "x402" ? "pay-x402" : "pay-dem", role === "buyer" ? "seller" : "buyer")),
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
    "the %s accepts a peer's authenticated Vet failure before agreement once its own Vet passed",
    async (receiver) => {
      const actor = memoryRoleDatabase(receiver);
      const message = await peerProposal(receiver);

      // Until this role's own Vet of the peer decides, the plan waits: the
      // message stays pending and nothing is bound or acknowledged.
      await expect(actor.runtime.handleMessage(
        message,
        { role: receiver } as DacsLiveRoleInboundOperationContextV1,
      )).rejects.toMatchObject({ reasonCode: "vet-terminal-local-vet-pending" });
      expect(actor.retainedProposal()).toBeUndefined();
      await expect(advanceDacsVetTerminalTrackV1(actor.runtime, actor.context, 1_000, JOB_ID))
        .resolves.toBeUndefined();
      await actor.passOwnVet();
      await expect(actor.runtime.handleMessage(
        message,
        { role: receiver } as DacsLiveRoleInboundOperationContextV1,
      )).resolves.toEqual({ disposition: "accepted" });
      expect(actor.retainedProposal()).toBeDefined();
      expect(actor.signComponent).not.toHaveBeenCalled();
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
    await actor.passOwnVet();
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
    await actor.passOwnVet();
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
      await actor.passOwnVet();
      await expect(actor.runtime.handleMessage(
        await peerProposal(receiver),
        { role: receiver } as DacsLiveRoleInboundOperationContextV1,
      )).resolves.toEqual({ disposition: "accepted" });
      actor.concludeAgreement();
      vi.mocked(actor.context.sendMessage).mockClear();

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
    await actor.passOwnVet();
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

  // Final r11 review: a durable read that SQLite could not serve under lock
  // contention parked a healthy job at operator action.
  it.each([
    ["better-sqlite3's SQLITE_BUSY", () => Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" })],
    ["better-sqlite3's SQLITE_LOCKED_SHAREDCACHE", () =>
      Object.assign(new Error("database table is locked"), { code: "SQLITE_LOCKED_SHAREDCACHE" })],
    ["node:sqlite's busy result code", () =>
      Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 })],
  ])("retries the terminal track when a terminal read meets %s", async (_label, busy) => {
    const actor = memoryRoleDatabase("buyer");
    await actor.passOwnVet();
    await expect(actor.runtime.handleMessage(
      await peerProposal("buyer"),
      { role: "buyer" } as DacsLiveRoleInboundOperationContextV1,
    )).resolves.toEqual({ disposition: "accepted" });
    const database = actor.context.database as unknown as { loadEffectInput: (kind: string, id: string) => unknown };
    const load = database.loadEffectInput;
    database.loadEffectInput = () => { throw busy(); };
    const retried = await advanceDacsVetTerminalTrackV1(actor.runtime, actor.context, 1_000, JOB_ID);
    expect(retried).toMatchObject({ status: "indeterminate", reasonCode: "vet-terminal-finalization-unavailable-busy" });
    expect(actor.signComponent).not.toHaveBeenCalled();
    // Any other read failure still needs an operator.
    database.loadEffectInput = () => { throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" }); };
    await expect(advanceDacsVetTerminalTrackV1(actor.runtime, actor.context, 1_000, JOB_ID))
      .resolves.toMatchObject({ status: "operator-action" });
    // Once the lock clears, the same job advances.
    database.loadEffectInput = load;
    await expect(advanceDacsVetTerminalTrackV1(actor.runtime, actor.context, 1_000, JOB_ID))
      .resolves.not.toMatchObject({ status: "operator-action" });
  });

  // The runtime reads the pre-agreement phase through a wrapper that reports
  // an unreadable decision as corrupt; lock contention must pass through it.
  it("retries the terminal track when only its phase decision read meets lock contention", async () => {
    const actor = memoryRoleDatabase("buyer");
    await actor.passOwnVet();
    await expect(actor.runtime.handleMessage(
      await peerProposal("buyer"),
      { role: "buyer" } as DacsLiveRoleInboundOperationContextV1,
    )).resolves.toEqual({ disposition: "accepted" });
    const decision = sha256Hex(`dacs-live-pre-agreement-phase:v1:${canonicalize({ role: "buyer", jobId: JOB_ID })}`);
    const database = actor.context.database as unknown as { loadEffectInput: (kind: string, id: string) => unknown };
    const load = database.loadEffectInput;
    let reads = 0;
    database.loadEffectInput = (kind, id) => {
      if (kind === "session" && id === decision) {
        reads += 1;
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      }
      return load(kind, id);
    };
    await expect(advanceDacsVetTerminalTrackV1(actor.runtime, actor.context, 1_000, JOB_ID))
      .resolves.toMatchObject({ status: "indeterminate", reasonCode: "vet-terminal-finalization-unavailable-busy" });
    expect(reads).toBeGreaterThan(0);
    expect(actor.signComponent).not.toHaveBeenCalled();
  });

  // Final re-review 1: the re-reads inside proposal assessment and inbound
  // validation still turned one busy read into a rejection, so the job went to
  // an operator. These lock the store from the k-th durable read on.
  const lockedFrom = (actor: ReturnType<typeof memoryRoleDatabase>, k: number,
    error: () => Error = () => Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" })) => {
    const database = actor.context.database as unknown as { loadEffectInput: (kind: string, id: string) => unknown };
    const load = database.loadEffectInput;
    const state = { reads: 0, unlock: () => { database.loadEffectInput = load; } };
    database.loadEffectInput = (kind, id) => {
      state.reads += 1;
      if (state.reads > k) throw error();
      return load(kind, id);
    };
    return state;
  };
  // The buyer's own Vet passed and it accepted the seller's plan. Built once,
  // then copied, since the sweeps need a fresh actor per read.
  let acceptedEffects: Map<string, unknown> | undefined;
  const acceptedPeerPlan = async () => {
    const actor = memoryRoleDatabase("buyer");
    if (acceptedEffects === undefined) {
      await actor.passOwnVet();
      await expect(actor.runtime.handleMessage(
        await peerProposal("buyer"),
        { role: "buyer" } as DacsLiveRoleInboundOperationContextV1,
      )).resolves.toEqual({ disposition: "accepted" });
      acceptedEffects = new Map(actor.effects);
    }
    for (const [key, value] of acceptedEffects) actor.effects.set(key, structuredClone(value));
    return actor;
  };

  it("never sends a healthy terminal tick to an operator for lock contention, only other read errors", async () => {
    // Reads 1-120: past the 80 the review's probe swept (its reads 44-70 were
    // the assessment's) and into the durable core, which answers any callback
    // failure as indeterminate.
    const reasons = new Set<string>();
    let parked = 0;
    for (let k = 0; k < 120; k += 1) {
      const actor = await acceptedPeerPlan();
      const locked = lockedFrom(actor, k);
      const result = await advanceDacsVetTerminalTrackV1(actor.runtime, actor.context, 1_000, JOB_ID) as
        Readonly<{ status: string; reasonCode?: string }> | undefined;
      expect(locked.reads, `the tick reaches read ${k + 1}`).toBeGreaterThan(k);
      expect(["indeterminate", "pending-retry"], `read ${k + 1} locked`).toContain(result?.status);
      reasons.add(String(result?.reasonCode));
      // The same read failing for another reason still needs an operator.
      if (result?.reasonCode !== "vet-terminal-finalization-unavailable-busy") continue;
      const failing = await acceptedPeerPlan();
      lockedFrom(failing, k, () => Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" }));
      await expect(advanceDacsVetTerminalTrackV1(failing.runtime, failing.context, 1_000, JOB_ID), `read ${k + 1}`)
        .resolves.toEqual({ status: "operator-action", reasonCode: "vet-terminal-finalization-unavailable" });
      parked += 1;
    }
    expect(parked).toBeGreaterThan(70);
    expect(reasons).toContain("vet-terminal-finalization-indeterminate");
  }, 120_000);

  it(
    "never rejects an inbound peer plan or contribution for lock contention at any read",
    async () => {
      const proposalMessage = await peerProposal("buyer");
      const plan = (proposalMessage.envelope.payload as DacsVetTerminalBundleProposalV1).plan;
      const contributionMessage = authenticated(
        "terminal-bundle-contribution-seller",
        contribution(plan, "seller"),
        SELLER,
        BUYER,
      );
      const cases = [
        ["proposal", proposalMessage, async () => {
          const actor = memoryRoleDatabase("buyer");
          await actor.passOwnVet();
          return actor;
        }],
        ["contribution", contributionMessage, acceptedPeerPlan],
      ] as const;
      for (const [label, message, arrange] of cases) {
        const envelope = message.envelope;
        // Validation alone (the HTTP endpoint's check): a locked read decides
        // nothing, which the endpoint answers with 503.
        let validationReads = 0;
        for (let k = 0; ; k += 1) {
          expect(k).toBeLessThan(500);
          const actor = await arrange();
          const locked = lockedFrom(actor, k);
          const validation = await actor.runtime.validatePayload({
            type: envelope.type as "terminal-bundle-proposal-seller",
            payload: envelope.payload,
            jobId: envelope.jobId,
            sender: envelope.sender,
            audience: envelope.audience,
          });
          if (locked.reads <= k) {
            expect(validation).toEqual({ status: "valid" });
            validationReads = k;
            break;
          }
          expect(validation, `${label} validation read ${k + 1} locked`)
            .toEqual({ status: "unavailable", reasonCode: "vet-terminal-store-busy" });
        }
        // The handler, which validates first: it throws, so the inbox keeps
        // the message pending, never a durable rejection the peer would have
        // to take to an operator.
        let handlerReads = 0;
        for (let k = 0; ; k += 1) {
          expect(k).toBeLessThan(500);
          const actor = await arrange();
          const locked = lockedFrom(actor, k);
          const outcome = await actor.runtime.handleMessage(
            message,
            { role: "buyer" } as DacsLiveRoleInboundOperationContextV1,
          ).then((value) => ({ value }), (error: unknown) => ({ error }));
          if (locked.reads <= k) {
            expect(outcome).toEqual({ value: { disposition: "accepted" } });
            handlerReads = k - validationReads;
            break;
          }
          expect(outcome, `${label} read ${k + 1} locked`).toHaveProperty("error");
          const error = (outcome as { error: unknown }).error;
          if (k < validationReads) {
            expect(error, `${label} read ${k + 1} locked`).toMatchObject({ reasonCode: "vet-terminal-store-busy" });
            continue;
          }
          // The lock met the handler after it may have written: once it
          // clears, the same message is accepted.
          expect(error, `${label} read ${k + 1} locked`).toMatchObject({ code: "SQLITE_BUSY" });
          locked.unlock();
          await expect(actor.runtime.handleMessage(
            message,
            { role: "buyer" } as DacsLiveRoleInboundOperationContextV1,
          ), `${label} after read ${k + 1} unlocks`).resolves.toEqual({ disposition: "accepted" });
        }
        expect(validationReads, label).toBeGreaterThan(10);
        expect(handlerReads, label).toBeGreaterThan(10);
      }
    },
    120_000,
  );
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

    it(`${rail}: reaches the same disagreement when this role's own failure follows the peer's pending plan`, async () => {
      const actor = memoryRoleDatabase("buyer", undefined, rail);
      const planB = await terminalProposal(terminalInput("fail", phaseOf(rail), "buyer"));
      // Selected, but not accepted while this role's own Vet is undecided.
      await expect(actor.runtime.handleMessage(fromSeller(planB), inbound))
        .rejects.toMatchObject({ reasonCode: "vet-terminal-local-vet-pending" });
      expect(row(actor, "selection")).toMatchObject({ source: "peer", planHash: planB.plan.planHash });
      expect(actor.retainedProposal()).toBeUndefined();
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

    // Daybreak r9 P3: this role's own failure is claimed, but its plan not yet
    // selected (here a crash stops it there), when the peer's different plan
    // arrives and wins the selection. That is the plan disagreement, not a
    // pass-against-failure conflict of this role's own Vet.
    it(`${rail}: reports a peer plan that arrives in this role's own failure's claim window as the disagreement`, async () => {
      const actor = memoryRoleDatabase("buyer", undefined, rail);
      const database = actor.context.database as unknown as {
        putEffectIntent: (input: Readonly<{ effectId: string }>) => unknown;
      };
      const put = database.putEffectIntent;
      database.putEffectIntent = (input) => {
        if (input.effectId !== terminalTransportEffectId("buyer", "selection")) return put(input);
        database.putEffectIntent = put;
        throw new Error("crash before the selection");
      };
      await expect(actor.runtime.registerLocalTerminal(terminalInput("fail", phaseOf(rail))))
        .rejects.toThrow("crash before the selection");
      expect(actor.effects.get(`session:${terminalTransportEffectId("buyer", "local-vet")}`))
        .toMatchObject({ kind: "local-vet-failure" });
      expect(row(actor, "selection")).toBeUndefined();

      const planB = await terminalProposal(terminalInput("fail", phaseOf(rail), "buyer"));
      await expect(restart(actor).handleMessage(fromSeller(planB), inbound)).resolves.toEqual({
        disposition: "rejected", reasonCode: "vet-terminal-plan-disagreement",
      });
      expect(row(actor, "selection")).toMatchObject({ source: "peer", planHash: planB.plan.planHash });
      expect(actor.retainedProposal()).toBeUndefined();
      // The resumed local failure records the disagreement with its own plan.
      await expect(restart(actor).registerLocalTerminal(terminalInput("fail", phaseOf(rail))))
        .rejects.toMatchObject({ reasonCode: "vet-terminal-plan-disagreement" });
      await expect(actor.runtime.loadPlanDisagreementEvidence!(JOB_ID)).resolves.toMatchObject({
        kind: "plan-disagreement", operatorAlert: true, selected: "peer", peerPlanHash: planB.plan.planHash });
      await expect(advanceDacsVetTerminalTrackV1(restart(actor), actor.context, 1_000, JOB_ID))
        .resolves.toEqual(disagreementStop);
      expect(sealed(actor)).toBeUndefined();
      expect(actor.signComponent).not.toHaveBeenCalled();
    });

    it(`${rail}: alerts the operator for a conflicting plan after commit and keeps the committed plan`, async () => {
      const actor = memoryRoleDatabase("buyer", undefined, rail);
      await actor.passOwnVet();
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
      await actor.passOwnVet();
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

    // Another process commits the job to the agreement before the peer's plan
    // arrives, or between that plan's selection and its binding. Either way
    // the plan is refused and the agreement track decides the job.
    it.each(["before the peer's plan arrives", "between the plan's selection and its binding"] as const)(
      `${rail}: lets the agreement decide when it takes the phase %s`,
      async (when) => {
        const actor = memoryRoleDatabase("buyer", undefined, rail);
        await actor.passOwnVet();
        const planA = await terminalProposal(terminalInput("fail", phaseOf(rail), "buyer"));
        const database = actor.context.database as unknown as {
          putEffectIntent: (input: Readonly<{ effectId: string; bindingHash: string }>) => unknown;
          createLiveCoordinatorStore: () => { load: () => Promise<{ record: { localBindingHash: string } }> };
          createPayDemCoordinatorStore: () => { load: () => Promise<{ record: { localBindingHash: string } }> };
        };
        const claimAgreement = (localBindingHash: string) =>
          claimDacsPreAgreementPhaseV1(actor.context, { jobId: JOB_ID, localBindingHash }, "agreement");
        if (when === "before the peer's plan arrives") {
          const store = rail === "x402"
            ? database.createLiveCoordinatorStore() : database.createPayDemCoordinatorStore();
          claimAgreement((await store.load()).record.localBindingHash);
        } else {
          const put = database.putEffectIntent;
          database.putEffectIntent = (input) => {
            const result = put(input);
            if (input.effectId === terminalTransportEffectId("buyer", "selection")) {
              database.putEffectIntent = put;
              claimAgreement(input.bindingHash);
            }
            return result;
          };
        }
        await expect(actor.runtime.handleMessage(fromSeller(planA), inbound)).resolves.toEqual({
          disposition: "rejected", reasonCode: "agreement-vet-terminal-phase-conflict",
        });
        expect(actor.retainedProposal()).toBeUndefined();
        await expect(advanceDacsVetTerminalTrackV1(restart(actor), actor.context, 1_000, JOB_ID))
          .resolves.toBeUndefined();
        expect(actor.retainedProposal()).toBeUndefined();
        expect(actor.signComponent).not.toHaveBeenCalled();
      },
    );
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
          // The peer's copy waits for this role's own failure, then is accepted.
          await expect(actor.runtime.handleMessage(fromSeller(own), inbound))
            .rejects.toMatchObject({ reasonCode: "vet-terminal-local-vet-pending" });
          await register(restart(actor));
          await receive(restart(actor));
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

  // This role's own Vet result is recorded once: a pass and a failure of the
  // same Vet contradict each other, and an operator decides.
  it("refuses a peer plan that blames the peer after this role's own Vet of the peer passed", async () => {
    const actor = memoryRoleDatabase("buyer");
    await actor.passOwnVet();
    // The seller sends the buyer's failure of the seller, which the buyer's
    // recorded pass contradicts.
    await expect(actor.runtime.handleMessage(
      fromSeller(await terminalProposal(terminalInput("fail", "pay-x402"))), inbound,
    )).resolves.toEqual({ disposition: "rejected", reasonCode: "vet-terminal-local-vet-conflict" });
    expect(actor.retainedProposal()).toBeUndefined();
    await expect(advanceDacsVetTerminalTrackV1(restart(actor), actor.context, 1_000, JOB_ID))
      .resolves.toEqual({ status: "operator-action", reasonCode: "vet-terminal-finalization-conflict" });
    expect(actor.signComponent).not.toHaveBeenCalled();
  });

  it.each(["pass then failure", "failure then pass"] as const)(
    "refuses to record this role's own Vet twice with different results (%s)",
    async (order) => {
      const actor = memoryRoleDatabase("buyer");
      if (order === "pass then failure") {
        await actor.passOwnVet();
        await expect(actor.runtime.registerLocalTerminal(terminalInput("fail", "pay-x402")))
          .rejects.toMatchObject({ reasonCode: "vet-terminal-local-vet-conflict" });
        expect(row(actor, "selection")).toBeUndefined();
      } else {
        await actor.runtime.registerLocalTerminal(terminalInput("fail", "pay-x402"));
        await expect(actor.passOwnVet()).rejects.toMatchObject({ reasonCode: "vet-terminal-local-vet-conflict" });
        expect(actor.effects.get(`session:${terminalTransportEffectId("buyer", "local-vet")}`))
          .toMatchObject({ kind: "local-vet-failure" });
      }
      expect(actor.signComponent).not.toHaveBeenCalled();
    },
  );

  // Daybreak's round-7 interleaving, in one process standing in for two: the
  // failure has authenticated its production and found no pass, and the pass
  // is recorded just before the failure's first write. Pass and failure claim
  // one row, so exactly one of them is recorded and nothing is signed.
  for (const rail of ["x402", "pay-dem"] as const) {
    it(`${rail}: records one result when a pass lands between a failure's check and its first write`, async () => {
      const actor = memoryRoleDatabase("buyer", undefined, rail);
      let passed = false;
      const runtime = createDacsVetTerminalBundleTransportRuntimeV1({
        context: actor.context, expectedRegistryVersions: REGISTRY_VERSIONS,
        authenticateProduction: async () => {
          if (!passed) { passed = true; await actor.passOwnVet(); }
          return { status: "valid" };
        },
      });
      await expect(runtime.registerLocalTerminal(terminalInput("fail", phaseOf(rail))))
        .rejects.toMatchObject({ reasonCode: "vet-terminal-local-vet-conflict" });
      expect(actor.effects.get(`session:${terminalTransportEffectId("buyer", "local-vet")}`))
        .toMatchObject({ kind: "local-vet-pass" });
      expect(row(actor, "selection")).toBeUndefined();
      expect(row(actor, "material")).toBeUndefined();
      await advanceDacsVetTerminalTrackV1(restart(actor), actor.context, 1_000, JOB_ID);
      expect(actor.signComponent).not.toHaveBeenCalled();
    });

    // The other order: the failure's claim is recorded first, and a pass that
    // lands before its plan is selected finds it and is refused.
    it(`${rail}: refuses a pass that lands after a failure's claim and before its plan is selected`, async () => {
      const actor = memoryRoleDatabase("buyer", undefined, rail);
      const database = actor.context.database as unknown as {
        putEffectIntent: (input: Readonly<{ effectId: string }>) => unknown;
      };
      const put = database.putEffectIntent;
      let passed: Promise<void> | undefined;
      database.putEffectIntent = (input) => {
        if (input.effectId !== terminalTransportEffectId("buyer", "selection")) return put(input);
        database.putEffectIntent = put;
        passed = actor.passOwnVet();
        return put(input);
      };
      const own = await actor.runtime.registerLocalTerminal(terminalInput("fail", phaseOf(rail)));
      await expect(passed).rejects.toMatchObject({ reasonCode: "vet-terminal-local-vet-conflict" });
      expect(actor.effects.get(`session:${terminalTransportEffectId("buyer", "local-vet")}`))
        .toEqual(expect.objectContaining({ kind: "local-vet-failure", planHash: own.proposal.plan.planHash }));
      expect(row(actor, "material")).toBeDefined();
    });

    // A pass and a failure's plan both durable, as the round-7 race left them:
    // neither stands, and this role's own plan is not signed.
    it(`${rail}: stops for an operator, sending and signing nothing, when a recorded pass sits beside this role's own plan`, async () => {
      const actor = memoryRoleDatabase("buyer", undefined, rail);
      await actor.runtime.registerLocalTerminal(terminalInput("fail", phaseOf(rail)));
      actor.effects.set(`session:${terminalTransportEffectId("buyer", "local-vet")}`, {
        resultVersion: "1",
        localBindingHash: rail === "x402"
          ? fixedPriceX402OrderLocalBindingHash(order("buyer"))
          : payDemOrderPair().buyerLocalBindingHash,
        kind: "local-vet-pass",
        evaluatedRole: "seller",
      });
      await expect(advanceDacsVetTerminalTrackV1(restart(actor), actor.context, 1_000, JOB_ID))
        .resolves.toMatchObject({ status: "operator-action" });
      expect(actor.signComponent).not.toHaveBeenCalled();
      expect(actor.context.sendMessage).not.toHaveBeenCalled();
    });

    // Daybreak r9 P3 (code r8 mutant R5): a recorded failure whose plan is not
    // the plan retained as this role's material, or selected from it, is
    // corrupt state. Neither plan stands, and nothing is sent or signed.
    it.each(["material", "selection"] as const)(
      `${rail}: stops as corrupt, sending and signing nothing, when the recorded failure's plan is not the retained %s's`,
      async (retained) => {
        const actor = memoryRoleDatabase("buyer", undefined, rail);
        const own = await actor.runtime.registerLocalTerminal(terminalInput("fail", phaseOf(rail)));
        // Only the selection is left after a crash before the material binding.
        if (retained === "selection") actor.effects.delete(`session:${terminalTransportEffectId("buyer", "material")}`);
        expect(row(actor, "selection")).toMatchObject({ source: "material", planHash: own.proposal.plan.planHash });
        const localVet = `session:${terminalTransportEffectId("buyer", "local-vet")}`;
        expect(actor.effects.get(localVet)).toMatchObject({ kind: "local-vet-failure", planHash: own.proposal.plan.planHash });
        actor.effects.set(localVet, { ...actor.effects.get(localVet) as object, planHash: "e".repeat(64) });
        const corrupt = { reasonCode: "vet-terminal-binding-corrupt" };
        await expect(restart(actor).advanceRegisteredTerminal(JOB_ID)).rejects.toMatchObject(corrupt);
        await expect(restart(actor).registerLocalTerminal(terminalInput("fail", phaseOf(rail))))
          .rejects.toMatchObject(corrupt);
        await expect(advanceDacsVetTerminalTrackV1(restart(actor), actor.context, 1_000, JOB_ID))
          .resolves.toEqual({ status: "operator-action", reasonCode: "vet-terminal-finalization-unavailable" });
        expect(actor.signComponent).not.toHaveBeenCalled();
        expect(actor.context.sendMessage).not.toHaveBeenCalled();
      },
    );
  }

  // A pass recorded for another binding of the job is not this order's pass.
  it("refuses a peer plan against a pass recorded for another binding", async () => {
    const actor = memoryRoleDatabase("buyer");
    await actor.runtime.registerLocalVetPass!({ jobId: JOB_ID, localBindingHash: "f".repeat(64) });
    await expect(actor.runtime.handleMessage(
      fromSeller(await terminalProposal(terminalInput("fail", "pay-x402", "buyer"))), inbound,
    ).catch((error: unknown) => error)).resolves.toMatchObject({ reasonCode: "vet-terminal-binding-corrupt" });
    expect(actor.retainedProposal()).toBeUndefined();
    expect(actor.signComponent).not.toHaveBeenCalled();
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
  // Passing `restartOf` builds new runtimes over the same durable state.
  const pair = (rail: "x402" | "pay-dem", restartOf?: Record<"buyer" | "seller", Actor>) => {
    const buyer = restartOf?.buyer ?? memoryRoleDatabase("buyer", undefined, rail);
    const seller = restartOf?.seller ?? memoryRoleDatabase("seller", undefined, rail);
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

    // Daybreak's restart probe: the seller's plan reaches the buyer before the
    // buyer's own Vet decides, which then fails differently. The buyer never
    // accepted the plan, so the seller never signed it either.
    it(`${rail}: signs nothing on either role when the buyer's own failure follows the seller's plan, across ticks and a restart`, async () => {
      const { actors, runtimes, tick } = pair(rail);
      await runtimes.seller.registerLocalTerminal(terminalInput("fail", phase, "buyer"));
      // Several ticks while the buyer's own Vet is undecided: the seller's
      // proposal waits at the buyer, and the buyer's track has nothing to do.
      for (let round = 0; round < 3; round += 1) {
        expect(await tick("seller")).toMatchObject({ status: "indeterminate" });
        await expect(tick("buyer")).resolves.toBeUndefined();
      }
      expect(actors.buyer.retainedProposal()).toBeUndefined();
      expect(actors.buyer.effects.get(`session:${terminalTransportEffectId("buyer", "selection")}`))
        .toMatchObject({ source: "peer" });
      await runtimes.buyer.registerLocalTerminal(terminalInput("fail", phase, "seller"))
        .then(() => { throw new Error("registered"); }, (error: { reasonCode?: string }) =>
          expect(error.reasonCode).toBe("vet-terminal-plan-disagreement"));
      const last: Record<string, unknown> = {};
      for (let round = 0; round < 3; round += 1) {
        for (const role of ["buyer", "seller"] as const) last[role] = await tick(role);
      }
      expect(last).toEqual({ buyer: stop, seller: stop });
      await expect(runtimes.buyer.loadPlanDisagreementEvidence!(JOB_ID))
        .resolves.toMatchObject({ selected: "peer" });
      await expect(runtimes.seller.loadPlanDisagreementEvidence!(JOB_ID))
        .resolves.toMatchObject({ selected: "local" });

      // Both processes restart on their durable state and stay stopped.
      const restarted = pair(rail, actors);
      for (let round = 0; round < 3; round += 1) {
        for (const role of ["buyer", "seller"] as const) last[role] = await restarted.tick(role);
      }
      expect(last).toEqual({ buyer: stop, seller: stop });
      for (const role of ["buyer", "seller"] as const) {
        expect(actors[role].signComponent).not.toHaveBeenCalled();
        expect(conflictSealed(actors[role], role)).toBe(false);
      }
    });

    it(`${rail}: signs the seller's plan on both roles only after the buyer's own Vet passed`, async () => {
      const { actors, runtimes, tick } = pair(rail);
      await runtimes.seller.registerLocalTerminal(terminalInput("fail", phase, "buyer"));
      await tick("seller");
      await expect(tick("buyer")).resolves.toBeUndefined();
      expect(actors.seller.signComponent).not.toHaveBeenCalled();
      expect(actors.buyer.signComponent).not.toHaveBeenCalled();

      await actors.buyer.passOwnVet();
      await tick("seller");
      await tick("buyer");
      expect(actors.seller.signComponent).toHaveBeenCalled();
      expect(actors.buyer.signComponent).toHaveBeenCalled();
      expect(actors.buyer.retainedProposal()).toBeDefined();
      for (const role of ["buyer", "seller"] as const) {
        await expect(runtimes[role].loadPlanDisagreementEvidence!(JOB_ID)).resolves.toBeUndefined();
      }
    });
  }
});

// The code reviewer's round-6 P2-1 through the real bootstrap tracks: each
// role's agreement track drives the real terminal runtime on the memory
// database; only the session-bootstrap transport and the Vet producer are
// stubs. The seller's Vet of the buyer fails first, and its plan reaches the
// buyer before the buyer's own Vet of the seller decides.
describe("bootstrap tracks read this role's own Vet before a peer's plan", () => {
  type Actor = ReturnType<typeof memoryRoleDatabase>;
  type Role = "buyer" | "seller";
  type Decision = "fail" | "pass" | "pending";
  const EMPTY = Object.freeze({ requirementVersion: "1" as const, required: [] });
  const stop = { status: "operator-action", reasonCode: "vet-terminal-plan-disagreement" };
  const roles = ["buyer", "seller"] as const;

  // `decisions` is read on every Vet, so a test can decide a role's own Vet
  // later. Passing `restartOf` builds new runtimes and tracks over the same
  // durable state.
  const tracks = (
    rail: "x402" | "pay-dem",
    decisions: Record<Role, Decision>,
    restartOf?: Record<Role, Actor>,
    complete = true,
  ) => {
    const phase = rail === "x402" ? "pay-x402" as const : "pay-dem" as const;
    const actors: Record<Role, Actor> = {
      buyer: restartOf?.buyer ?? memoryRoleDatabase("buyer", undefined, rail),
      seller: restartOf?.seller ?? memoryRoleDatabase("seller", undefined, rail),
    };
    const runtimes = {} as Record<Role, Readonly<DacsVetTerminalBundleTransportRuntimeV1>>;
    for (const role of roles) {
      const peer = role === "buyer" ? "seller" : "buyer";
      (actors[role].context as unknown as { sendMessage: unknown }).sendMessage = vi.fn(
        async (message: Readonly<{ type: string; payload: unknown }>) => acknowledgement((await runtimes[peer]
          .handleMessage(authenticated(message.type as never, message.payload,
            role === "buyer" ? BUYER : SELLER, role === "buyer" ? SELLER : BUYER),
          { role: peer } as DacsLiveRoleInboundOperationContextV1)).disposition as never));
      runtimes[role] = createDacsVetTerminalBundleTransportRuntimeV1({
        context: actors[role].context,
        expectedRegistryVersions: REGISTRY_VERSIONS,
        authenticateProduction: async () => ({ status: "valid" }),
      });
    }
    const agreement = vi.fn();
    const common = (role: Role) => ({
      context: actors[role].context,
      agreement,
      vet: {
        produce: vi.fn(async () => decisions[role] === "pending"
          ? { status: "indeterminate" as const, reasonCode: `${role}-vet-producer-pending` }
          : { status: "ready" as const,
              production: terminalInput(decisions[role] as "fail" | "pass", phase, role === "buyer" ? "seller" : "buyer", false).production as never }),
        authenticate: vi.fn(async () => "valid" as const),
      },
      terminalBundle: {
        runtime: runtimes[role],
        createInput: (input: Readonly<{ evaluatedRole: Role; production: PrepareVetTerminalBundleInput["production"] }>) =>
          ({ ...terminalInput(input.production.record.overallDecision, phase, input.evaluatedRole, complete), production: input.production }),
      },
    });
    const buyerOptions = {
      ...common("buyer"),
      sessionBootstrap: {
        resolveInit: () => ({ bootstrapVersion: "1" }),
        publishInit: vi.fn(async () => "accepted"),
        resolveChallenge: () => ({ buyerChallenge: "challenge", sellerIdentity: identity("seller") }),
        resolvePresentation: () => ({ buyerIdentity: identity("buyer") }),
        publishPresentation: vi.fn(async () => "accepted"),
        resolveAdmission: () => undefined,
        handleMessage: vi.fn(),
      },
      resolveRequirements: () => ({ buyer: EMPTY, seller: EMPTY }),
    } as never;
    const sellerOptions = {
      ...common("seller"),
      sessionBootstrap: {
        resolveInit: () => ({ bootstrapVersion: "1" }),
        resolveChallenge: () => ({ sellerIdentity: identity("seller") }),
        publishChallenge: vi.fn(async () => "accepted"),
        resolvePresentation: () => ({ buyerIdentity: identity("buyer") }),
        resolveAdmission: () => undefined,
        publishAdmission: vi.fn(async () => "accepted"),
        handleMessage: vi.fn(),
      },
      resolveBuyerRequirement: () => EMPTY,
      agreementProposalReady: () => false,
    } as never;
    const track: Record<Role, (operation: never) => Promise<unknown>> = rail === "x402"
      ? { buyer: createDacsBuyerSessionBootstrapAgreementTrackV1(buyerOptions) as never,
          seller: createDacsSellerSessionBootstrapAgreementTrackV1(sellerOptions) as never }
      : { buyer: createDacsPayDemBuyerSessionBootstrapAgreementTrackV1(buyerOptions) as never,
          seller: createDacsPayDemSellerSessionBootstrapAgreementTrackV1(sellerOptions) as never };
    const tick = async (role: Role) => {
      const database = actors[role].context.database as unknown as Record<
        "createLiveCoordinatorStore" | "createPayDemCoordinatorStore",
        () => { load: () => Promise<{ record: Readonly<Record<string, unknown>> }> }
      >;
      const { record } = await (rail === "x402"
        ? database.createLiveCoordinatorStore() : database.createPayDemCoordinatorStore()).load();
      return await track[role]({
        order: record,
        fence: {
          role, track: "agreement", jobId: JOB_ID,
          bindingHash: record.bindingHash, localBindingHash: record.localBindingHash,
          owner: `${role}-worker`, generation: 1, idempotencyKey: `${role}-agreement:${JOB_ID}`,
          assertCurrent: vi.fn(async () => undefined),
        },
      } as never);
    };
    return { actors, runtimes, tick, agreement };
  };
  it.each(["x402", "pay-dem"] as const)("%s retries local failure evidence delivery after a network outage", async (rail) => {
    const value = tracks(rail, { buyer: "fail", seller: "pass" }, undefined, false);
    vi.mocked(value.actors.buyer.context.sendMessage).mockRejectedValueOnce(new Error("network unavailable"));
    await expect(value.tick("buyer")).resolves.toMatchObject({
      status: "indeterminate", reasonCode: "vet-terminal-production-indeterminate" });
    const resumed = tracks(rail, { buyer: "fail", seller: "pass" }, value.actors, false);
    for (let turn = 0; turn < 4; turn++) {
      await resumed.tick("seller");
      await resumed.tick("buyer");
    }
    expect(resumed.actors.buyer.signComponent).toHaveBeenCalled();
    expect(resumed.actors.seller.signComponent).toHaveBeenCalled();
  });

  const effect = (actor: Actor, kind: "selection" | "local-vet") =>
    actor.effects.get(`session:${terminalTransportEffectId(actor.context.role, kind)}`);

  for (const rail of ["x402", "pay-dem"] as const) {
    // `first` fails its Vet of the other role at once; `late`'s own Vet of
    // `first` decides afterwards, so each role's track is the late one once.
    for (const [first, late] of [["seller", "buyer"], ["buyer", "seller"]] as const) {
      for (const timing of ["at once", "after two undecided ticks"] as const) {
        it(`${rail}: registers the ${late}'s own failure after the ${first}'s plan (deciding ${timing}); neither role signs, across a restart`, async () => {
          const decisions = {
            [first]: "fail", [late]: timing === "at once" ? "fail" : "pending",
          } as Record<Role, Decision>;
          const value = tracks(rail, decisions);
          // The first role's own failure; its plan waits at the late role.
          await expect(value.tick(first)).resolves.toMatchObject({ status: "indeterminate" });
          expect(effect(value.actors[late], "selection")).toMatchObject({ source: "peer" });
          if (timing !== "at once") {
            for (let round = 0; round < 2; round += 1) {
              await expect(value.tick(late)).resolves.toMatchObject({
                status: "indeterminate", reasonCode: `${late}-vet-producer-pending` });
              await expect(value.tick(first)).resolves.toMatchObject({ status: "indeterminate" });
            }
            decisions[late] = "fail";
          }
          const last: Record<string, unknown> = {};
          for (let round = 0; round < 3; round += 1) {
            for (const role of [late, first]) last[role] = await value.tick(role);
          }
          expect(last).toEqual({ buyer: stop, seller: stop });
          // The late role's own failure was registered against the first's plan.
          await expect(value.runtimes[late].loadPlanDisagreementEvidence!(JOB_ID))
            .resolves.toMatchObject({ selected: "peer" });
          await expect(value.runtimes[first].loadPlanDisagreementEvidence!(JOB_ID))
            .resolves.toMatchObject({ selected: "local" });

          const restarted = tracks(rail, decisions, value.actors);
          for (let round = 0; round < 3; round += 1) {
            for (const role of roles) last[role] = await restarted.tick(role);
          }
          expect(last).toEqual({ buyer: stop, seller: stop });
          for (const role of roles) {
            expect(value.actors[role].signComponent).not.toHaveBeenCalled();
          }
          expect(value.agreement).not.toHaveBeenCalled();
          expect(restarted.agreement).not.toHaveBeenCalled();
        });
      }

      it(`${rail}: exchanges both finalized CVRs with ${first} failing and survives a restart before signing`, async () => {
        const phase = rail === "x402" ? "pay-x402" : "pay-dem";
        const decisions = { [first]: "fail", [late]: "pending" } as Record<Role, Decision>;
        const initial = tracks(rail, decisions, undefined, false);
        await initial.tick(first);
        expect(initial.actors[first].signComponent).not.toHaveBeenCalled();
        // A crash after retaining the failing production loses neither receipt nor bytes.
        const resumed = tracks(rail, decisions, initial.actors, false);
        decisions[late] = "pass";
        for (let turn = 0; turn < 4; turn++) {
          await resumed.tick(late);
          await resumed.tick(first);
        }
        for (const role of roles) expect(resumed.actors[role].signComponent).toHaveBeenCalled();
        const proposal = (resumed.actors[late].retainedProposal() as { payload: DacsVetTerminalBundleProposalV1 }).payload;
        expect(proposal.plan.authority.vetRecords).toHaveLength(2);
        const expectedRefs = ["buyer", "seller"].map((evaluated) =>
          terminalInput(evaluated === late ? "fail" : "pass", phase, evaluated as Role, false).production.recordRef);
        expect(proposal.plan.authority.vetRecords).toEqual(expectedRefs);
        const rederived = await prepareVetTerminalBundle(proposal.terminalInput, {
          authenticateProduction: () => ({ status: "valid" }),
        });
        if (rederived.status !== "terminal") throw new Error("terminal not rederived");
        expect(proposal.plan.authority.dependencySetHash).toBe(rederived.authority.dependencySetHash);
        for (const field of ["production", "complementaryProduction"] as const) {
          const missing = structuredClone(proposal) as any;
          delete missing.terminalInput[field];
          expect((await resumed.runtimes[late].validatePayload({
            type: `terminal-bundle-proposal-${first}`, jobId: JOB_ID,
            sender: first === "buyer" ? BUYER : SELLER, audience: late === "buyer" ? BUYER : SELLER,
            payload: missing,
          } as never)).status).toBe("invalid");
        }
        expect(resumed.agreement).not.toHaveBeenCalled();
      });

      it(`${rail}: the ${late} co-signs the ${first}'s plan only after its own Vet passed`, async () => {
        const decisions = { [first]: "fail", [late]: "pending" } as Record<Role, Decision>;
        const value = tracks(rail, decisions);
        await value.tick(first);
        await value.tick(late);
        expect(value.actors[late].signComponent).not.toHaveBeenCalled();
        expect(value.actors[first].signComponent).not.toHaveBeenCalled();

        decisions[late] = "pass";
        await value.tick(late);
        expect(effect(value.actors[late], "local-vet")).toMatchObject({
          kind: "local-vet-pass", evaluatedRole: first });
        expect(value.actors[late].signComponent).toHaveBeenCalled();
        await value.tick(first);
        expect(value.actors[first].signComponent).toHaveBeenCalled();
        expect((value.actors[late].retainedProposal() as { payload: DacsVetTerminalBundleProposalV1 }).payload.plan.authority.vetRecords).toHaveLength(2);
        expect(value.agreement).not.toHaveBeenCalled();
      });
    }
  }
});

// handleMessage writes the peer's plan to the one selection row and then
// classifies it again: another writer, in another process, may have won the
// row between the plan's first check and that write. Simulated by writing the
// winner's row just before the peer's.
describe("a peer plan that loses the selection between its check and its write", () => {
  const inbound = { role: "buyer" } as DacsLiveRoleInboundOperationContextV1;
  const fromSeller = (payload: unknown) =>
    authenticated("terminal-bundle-proposal-seller", payload, SELLER, BUYER);
  const selectionKey = `session:${terminalTransportEffectId("buyer", "selection")}`;
  const loseSelectionTo = (actor: ReturnType<typeof memoryRoleDatabase>, row: unknown) => {
    const database = actor.context.database as unknown as {
      putEffectIntent: (input: Readonly<{ effectId: string; input: unknown }>) => unknown;
    };
    const put = database.putEffectIntent;
    database.putEffectIntent = (input) => {
      if (input.effectId === terminalTransportEffectId("buyer", "selection")) {
        database.putEffectIntent = put;
        actor.effects.set(selectionKey, structuredClone(row));
      }
      return put(input);
    };
  };

  for (const rail of ["x402", "pay-dem"] as const) {
    const phase = rail === "x402" ? "pay-x402" as const : "pay-dem" as const;

    it(`${rail}: refuses it as a disagreement when this role's own failure won`, async () => {
      const winner = memoryRoleDatabase("buyer", undefined, rail);
      const own = await winner.runtime.registerLocalTerminal(terminalInput("fail", phase));
      const actor = memoryRoleDatabase("buyer", undefined, rail);
      const planB = await terminalProposal(terminalInput("fail", phase, "buyer"));
      loseSelectionTo(actor, winner.effects.get(selectionKey));

      await expect(actor.runtime.handleMessage(fromSeller(planB), inbound)).resolves.toEqual({
        disposition: "rejected", reasonCode: "vet-terminal-plan-disagreement",
      });
      await expect(actor.runtime.loadPlanDisagreementEvidence!(JOB_ID)).resolves.toMatchObject({
        selected: "local", localPlanHash: own.proposal.plan.planHash,
        peerPlanHash: planB.plan.planHash, losingPayload: planB, authenticationHash: "c".repeat(64),
      });
      expect(actor.retainedProposal()).toBeUndefined();
      expect(actor.signComponent).not.toHaveBeenCalled();
    });

    it(`${rail}: refuses it as equivocation when another plan from the peer won`, async () => {
      const winner = memoryRoleDatabase("buyer", undefined, rail);
      const planC = await terminalProposal(terminalInput("fail", phase));
      // The winner's own Vet is undecided, so planC is selected and held.
      await expect(winner.runtime.handleMessage(fromSeller(planC), inbound))
        .rejects.toMatchObject({ reasonCode: "vet-terminal-local-vet-pending" });
      const actor = memoryRoleDatabase("buyer", undefined, rail);
      await actor.passOwnVet();
      const planB = await terminalProposal(terminalInput("fail", phase, "buyer"));
      loseSelectionTo(actor, winner.effects.get(selectionKey));

      await expect(actor.runtime.handleMessage(fromSeller(planB), inbound)).resolves.toEqual({
        disposition: "rejected", reasonCode: "vet-terminal-proposal-equivocation",
      });
      await expect(actor.runtime.loadPeerEquivocationEvidence!(JOB_ID)).resolves.toEqual({
        beforeCommit: expect.objectContaining({ operatorAlert: false,
          retainedPlanHash: planC.plan.planHash, offeredPlanHash: planB.plan.planHash }),
      });
      expect(actor.retainedProposal()).toBeUndefined();
      expect(actor.signComponent).not.toHaveBeenCalled();
    });
  }
});

it("keeps exchanged Vet evidence retryable while independent authentication is unavailable", async () => {
  const actor = memoryRoleDatabase("buyer");
  let available = false;
  const runtime = createDacsVetTerminalBundleTransportRuntimeV1({
    context: actor.context, expectedRegistryVersions: REGISTRY_VERSIONS,
    authenticateProduction: () => available ? { status: "valid" } : { status: "indeterminate", reason: "read pending" },
  });
  const payload = { vetEvidenceVersion: "1", terminalInput: terminalInput("pass", "pay-x402", "buyer", false) };
  const query = { type: "terminal-bundle-proposal-seller", jobId: JOB_ID,
    sender: SELLER, audience: BUYER, payload } as never;
  await expect(runtime.validatePayload(query)).resolves.toEqual({
    status: "unavailable", reasonCode: "vet-terminal-production-indeterminate",
  });
  await expect(runtime.handleMessage(authenticated("terminal-bundle-proposal-seller", payload, SELLER, BUYER),
    { role: "buyer" } as never)).rejects.toMatchObject({ reasonCode: "vet-terminal-production-indeterminate" });
  available = true;
  await expect(runtime.validatePayload(query)).resolves.toMatchObject({ status: "valid" });
  await expect(runtime.handleMessage(authenticated("terminal-bundle-proposal-seller", payload, SELLER, BUYER),
    { role: "buyer" } as never)).resolves.toEqual({ disposition: "accepted" });
});


describe("retained terminal evidence and admission", () => {
  it("re-admits direct runtime calls and recovered signing before effects", async () => {
    const actor = memoryRoleDatabase("buyer");
    await actor.runtime.registerLocalTerminal(terminalInput("fail"));
    const count = actor.effects.size;
    (actor.context as { authenticateSessionProfile?: unknown }).authenticateSessionProfile = undefined;
    await expect(actor.runtime.advanceRegisteredTerminal(JOB_ID)).rejects.toThrow(/session profile/);
    await expect(actor.runtime.registerLocalTerminal(terminalInput("fail"))).rejects.toThrow(/session profile/);
    await expect(actor.runtime.loadPeerEquivocationEvidence!(JOB_ID)).resolves.toEqual({});
    await expect(actor.runtime.loadPlanDisagreementEvidence!(JOB_ID)).resolves.toBeUndefined();
    expect(actor.effects.size).toBe(count);
    expect(actor.signComponent).not.toHaveBeenCalled();
  });

  it.each(["pass", "fail"] as const)("reuses and re-authenticates retained %s production after a fresh receipt", async (decision) => {
    const actor = memoryRoleDatabase("buyer");
    const authenticateProduction = vi.fn(() => ({ status: "valid" as const }));
    const runtime = createDacsVetTerminalBundleTransportRuntimeV1({ context: actor.context,
      expectedRegistryVersions: REGISTRY_VERSIONS, authenticateProduction });
    const input = terminalInput(decision, "pay-x402", "seller", false);
    // The exact local binding is available from the retained application/order.
    const { record } = await (actor.context.database as any).createLiveCoordinatorStore("buyer").load(JOB_ID);
    const run = (value: typeof input) => decision === "pass"
      ? runtime.registerLocalVetPass!({ jobId: JOB_ID, localBindingHash: (record as any).localBindingHash }, value)
      : runtime.registerLocalTerminal(value).catch((error) => {
          expect(error).toMatchObject({ reasonCode: "vet-terminal-production-indeterminate" });
        });
    await run(input);
    const fresh = structuredClone(input);
    fresh.production.anchorReceipt.observedAt += 1;
    await run(fresh);
    expect(authenticateProduction).toHaveBeenLastCalledWith(expect.objectContaining({
      production: expect.objectContaining({ anchorReceipt: input.production.anchorReceipt }),
    }));
  });

  it.each(["x402", "pay-dem"] as const)("%s reuses complete retained material after both receipt observations advance", async (rail) => {
    const actor = memoryRoleDatabase("buyer", undefined, rail);
    const input = terminalInput("fail", rail === "x402" ? "pay-x402" : "pay-dem");
    const first = await actor.runtime.registerLocalTerminal(input);
    const fresh = structuredClone(input);
    fresh.production.anchorReceipt.observedAt += 1;
    fresh.complementaryProduction!.anchorReceipt.observedAt += 2;
    const authenticateProduction = vi.fn(() => ({ status: "valid" as const }));
    const recovered = createDacsVetTerminalBundleTransportRuntimeV1({ context: actor.context,
      expectedRegistryVersions: REGISTRY_VERSIONS, authenticateProduction });
    await expect(recovered.registerLocalTerminal(fresh)).resolves.toEqual(first);
    for (const production of [input.production, input.complementaryProduction]) {
      expect(authenticateProduction).toHaveBeenCalledWith(expect.objectContaining({ production }));
    }
    expect(actor.signComponent).not.toHaveBeenCalled();
  });

  it("retains evidence and retries a failed send", async () => {
    const actor = memoryRoleDatabase("buyer");
    vi.mocked(actor.context.sendMessage).mockRejectedValueOnce(new Error("network unavailable"));
    const input = terminalInput("fail", "pay-x402", "seller", false);
    await expect(actor.runtime.registerLocalTerminal(input)).rejects.toMatchObject({
      reasonCode: "vet-terminal-production-indeterminate" });
    const count = actor.effects.size;
    await expect(actor.runtime.registerLocalTerminal(input)).rejects.toMatchObject({
      reasonCode: "vet-terminal-production-indeterminate" });
    expect(actor.effects.size).toBe(count);
    expect(actor.context.sendMessage).toHaveBeenCalledTimes(2);
    expect(actor.signComponent).not.toHaveBeenCalled();
  });

  it("refuses complete proposals that replace retained peer evidence, including recovery", async () => {
    const actor = memoryRoleDatabase("buyer");
    await actor.passOwnVet();
    const retained = terminalInput("fail", "pay-x402", "buyer", false);
    const evidence = { vetEvidenceVersion: "1", terminalInput: retained };
    const inbound = { role: "buyer" } as DacsLiveRoleInboundOperationContextV1;
    await actor.runtime.handleMessage(authenticated("terminal-bundle-proposal-seller", evidence, SELLER, BUYER), inbound);
    const replacement = terminalInput("fail", "pay-x402", "buyer");
    replacement.production.record.generatedAt += 1;
    replacement.production.recordRef.contentHash = contentHash(replacement.production.record as any);
    replacement.production.anchorReceipt.contentHash = replacement.production.recordRef.contentHash;
    const proposal = await terminalProposal(replacement);
    for (let attempt = 0; attempt < 2; attempt++) {
      const runtime = createDacsVetTerminalBundleTransportRuntimeV1({ context: actor.context,
        expectedRegistryVersions: REGISTRY_VERSIONS, authenticateProduction: () => ({ status: "valid" }) });
      await expect(runtime.handleMessage(authenticated("terminal-bundle-proposal-seller", proposal, SELLER, BUYER), inbound))
        .resolves.toMatchObject({ disposition: "rejected" });
      expect(actor.signComponent).not.toHaveBeenCalled();
    }
    const refreshed = terminalInput("fail", "pay-x402", "buyer", false);
    refreshed.production.anchorReceipt.observedAt += 1;
    await expect(actor.runtime.handleMessage(authenticated("terminal-bundle-proposal-seller",
      { vetEvidenceVersion: "1", terminalInput: refreshed }, SELLER, BUYER), inbound))
      .resolves.toEqual({ disposition: "accepted" });
    const allowedInput = terminalInput("fail", "pay-x402", "buyer");
    allowedInput.production.anchorReceipt.observedAt += 2;
    const allowed = await terminalProposal(allowedInput);
    await expect(actor.runtime.handleMessage(authenticated("terminal-bundle-proposal-seller", allowed, SELLER, BUYER), inbound))
      .resolves.toEqual({ disposition: "accepted" });
    // Model a retained conflicting proposal from an earlier process/version.
    const conflicting = memoryRoleDatabase("buyer");
    await conflicting.passOwnVet();
    await conflicting.runtime.handleMessage(authenticated("terminal-bundle-proposal-seller", proposal, SELLER, BUYER), inbound);
    for (const kind of ["proposal", "selection"] as const) {
      const key = `session:${terminalTransportEffectId("buyer", kind)}`;
      actor.effects.set(key, structuredClone(conflicting.effects.get(key)));
    }
    const recovered = createDacsVetTerminalBundleTransportRuntimeV1({ context: actor.context,
      expectedRegistryVersions: REGISTRY_VERSIONS, authenticateProduction: () => ({ status: "valid" }) });
    await expect(recovered.advanceRegisteredTerminal(JOB_ID)).rejects.toMatchObject({
      reasonCode: "vet-terminal-local-vet-conflict" });
    expect(actor.signComponent).not.toHaveBeenCalled();
  });
});

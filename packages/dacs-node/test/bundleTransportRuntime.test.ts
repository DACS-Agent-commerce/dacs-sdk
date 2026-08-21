import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalize, sha256Hex } from "@kynesyslabs/dacs/canonical";
import {
  ed25519Sign,
  privateKeyFromSeed,
  publicKeyFromSeed,
  rawPublicKey,
} from "@kynesyslabs/dacs/crypto";
import {
  FIXED_PRICE_X402_COMMERCE_PROFILE,
  FIXED_PRICE_X402_REGISTRY_INDEX_REF,
  FIXED_PRICE_X402_STANDARD_REVISION,
  fixedPriceX402OrderBindingHash,
  fixedPriceX402OrderLocalBindingHash,
  type FixedPriceX402OrderInput,
} from "@kynesyslabs/dacs/commerce";
import { afterEach, describe, expect, it, vi } from "vitest";

const verifyRequest = vi.hoisted(() => vi.fn(async (_input, request) => request));
vi.mock("@kynesyslabs/dacs/seller", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@kynesyslabs/dacs/seller")>()),
  verifyCompletedSellerBundleCounterSignatureRequest: verifyRequest,
}));

import {
  createDacsBuyerBundleTransportRuntimeV1,
  createDacsSellerBundleTransportRuntimeV1,
} from "../src/bundleTransportRuntime.js";
import { DACS_NODE_LIVE_PROFILE } from "../src/config.js";
import { putDacsLiveOrderInputV1 } from "../src/orderInput.js";
import type {
  DacsLiveRoleInboundOperationContextV1,
  DacsLiveRoleOperationContextV1,
} from "../src/roleRuntime.js";
import {
  openDacsNodeSqliteDatabase,
  type DacsNodeSqliteDatabase,
} from "../src/sqlite.js";
import type { DacsHttpAuthenticatedEnvelopeV1 } from "../src/transport/envelope.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const BUYER_SEED = new Uint8Array(32).fill(41);
const SELLER_SEED = new Uint8Array(32).fill(42);
const claim = (seed: Uint8Array) =>
  `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
const BUYER = claim(BUYER_SEED);
const SELLER = claim(SELLER_SEED);

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
        registryIndexHash: "1".repeat(64),
        railDefinitionRef: "dacs4:rail:x402%3Aruntime:2",
        railDefinitionHash: "2".repeat(64),
        railId: "x402:runtime",
        railVersion: 2,
        railType: "x402",
        phaseHandler: "pay-x402",
        network: "eip155:8453",
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
  type: "bundle-signature-request" | "bundle-signature-response",
  payload: unknown,
  sender: string,
  audience: string,
): Readonly<DacsHttpAuthenticatedEnvelopeV1> {
  return {
    status: "authenticated",
    envelope: {
      version: "1",
      type,
      envelopeId: "a".repeat(64),
      jobId: JOB_ID,
      sender,
      audience,
      keyId: sender,
      algorithm: "ed25519",
      issuedAt: 1_000,
      expiresAt: 61_000,
      nonce: Buffer.alloc(32, 1).toString("base64url"),
      payloadHash: sha256Hex(canonicalize(payload)),
      payload,
      signature: Buffer.alloc(64, 2).toString("base64url"),
    },
    authenticationHash: "b".repeat(64),
    identityEvidenceHash: "c".repeat(64),
    identityRole: sender === BUYER ? "buyer" : "seller",
    receivedAt: 1_001,
  } as unknown as Readonly<DacsHttpAuthenticatedEnvelopeV1>;
}

function acknowledgement(disposition: "accepted" | "existing" | "rejected") {
  return {
    envelope: { type: "acknowledgement", payload: { disposition } },
  } as unknown as Readonly<DacsHttpAuthenticatedEnvelopeV1>;
}

describe("bundle signature HTTP transport", () => {
  const roots: string[] = [];
  const databases: DacsNodeSqliteDatabase[] = [];

  afterEach(() => {
    vi.clearAllMocks();
    for (const database of databases.splice(0).reverse()) database.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  async function open(role: "buyer" | "seller"): Promise<DacsNodeSqliteDatabase> {
    const root = mkdtempSync(join(tmpdir(), `dacs-bundle-transport-${role}-`));
    roots.push(root);
    const database = await openDacsNodeSqliteDatabase({
      databasePath: join(root, "actor.sqlite"),
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role,
      authority: role === "buyer" ? BUYER : SELLER,
    });
    databases.push(database);
    const exactOrder = order(role);
    await database.createLiveCoordinatorStore(role).create({
      role,
      order: exactOrder,
      bindingHash: fixedPriceX402OrderBindingHash(exactOrder),
      localBindingHash: fixedPriceX402OrderLocalBindingHash(exactOrder),
    });
    putDacsLiveOrderInputV1({ database, order: exactOrder, application: {} });
    return database;
  }

  it("requires buyer re-verification and seller cryptographic signature verification", async () => {
    const buyerDatabase = await open("buyer");
    const sellerDatabase = await open("seller");
    let buyerRuntime: ReturnType<typeof createDacsBuyerBundleTransportRuntimeV1>;
    let sellerRuntime: ReturnType<typeof createDacsSellerBundleTransportRuntimeV1>;
    const buyerContext = {
      role: "buyer",
      authority: BUYER,
      peerAuthority: SELLER,
      database: buyerDatabase,
      sendMessage: async (message: { type: "bundle-signature-response"; payload: unknown }) => {
        const result = await sellerRuntime.handleMessage(
          authenticated(message.type, message.payload, BUYER, SELLER),
          { role: "seller" } as DacsLiveRoleInboundOperationContextV1,
        );
        return acknowledgement(result.disposition);
      },
    } as unknown as DacsLiveRoleOperationContextV1;
    const sellerContext = {
      role: "seller",
      authority: SELLER,
      peerAuthority: BUYER,
      database: sellerDatabase,
      sendMessage: async (message: { type: "bundle-signature-request"; payload: unknown }) => {
        const result = await buyerRuntime.handleMessage(
          authenticated(message.type, message.payload, SELLER, BUYER),
          { role: "buyer" } as DacsLiveRoleInboundOperationContextV1,
        );
        return acknowledgement(result.disposition);
      },
    } as unknown as DacsLiveRoleOperationContextV1;
    buyerRuntime = createDacsBuyerBundleTransportRuntimeV1({
      context: buyerContext,
      resolveVerification: () => ({ input: {} as never, provider: {} as never }),
      resolveSellerFinalization: async () => ({
        disposition: "absent",
        reason: "seller-finalization-pending",
      }),
    });
    sellerRuntime = createDacsSellerBundleTransportRuntimeV1(sellerContext);

    const signedBytes = Uint8Array.from(Buffer.from("exact bundle signing bytes"));
    const request = {
      bundleContentHash: "d".repeat(64),
      signedScope: { jobId: JOB_ID, outcome: "completed" },
      signedBytes,
      requiredCounterSigners: [BUYER],
    };
    const published = await sellerRuntime.publishRequest({ jobId: JOB_ID, request });
    expect(published.status).toBe("acknowledged");
    expect(verifyRequest).toHaveBeenCalledOnce();

    const identity = {
      jobId: JOB_ID,
      agreementHash: "e".repeat(64),
      settlementId: "settlement-runtime",
      settlementIdentityHash: "f".repeat(64),
      buyer: BUYER,
      buyerBundleHash: "1".repeat(64),
      seller: SELLER,
    };
    await expect(buyerRuntime.transport.resolveSellerRequest(identity)).resolves.toMatchObject({
      disposition: "present",
      value: { bundleContentHash: request.bundleContentHash },
    });
    const signature = {
      party: BUYER,
      algorithm: "ed25519" as const,
      value: Buffer.from(ed25519Sign(signedBytes, privateKeyFromSeed(BUYER_SEED)))
        .toString("base64url"),
    };
    await expect(buyerRuntime.transport.publishCounterSignature({
      identity,
      requestHash: published.requestHash,
      signature,
    }, {
      owner: "buyer-worker",
      generation: 1,
      idempotencyKey: "bundle-signature",
    })).resolves.toEqual({ disposition: "published" });
    await expect(sellerRuntime.resolveCounterSignatures(JOB_ID)).resolves.toEqual([signature]);
    await expect(buyerRuntime.transport.resolveCounterSignatures({
      identity,
      requestHash: published.requestHash,
      requiredCounterSignersHash: sha256Hex(canonicalize([BUYER])),
      buyerSignature: signature,
    })).resolves.toEqual({ disposition: "present", value: [signature] });
  });

  it("rejects a forged buyer bundle signature before retention", async () => {
    const sellerDatabase = await open("seller");
    const context = {
      role: "seller",
      authority: SELLER,
      peerAuthority: BUYER,
      database: sellerDatabase,
      sendMessage: async () => acknowledgement("accepted"),
    } as unknown as DacsLiveRoleOperationContextV1;
    const runtime = createDacsSellerBundleTransportRuntimeV1(context);
    const request = {
      bundleContentHash: "d".repeat(64),
      signedScope: { jobId: JOB_ID },
      signedBytes: Uint8Array.from([1, 2, 3]),
      requiredCounterSigners: [BUYER],
    };
    expect((await runtime.publishRequest({ jobId: JOB_ID, request })).status).toBe("acknowledged");
    const forged = {
      party: BUYER,
      algorithm: "ed25519" as const,
      value: Buffer.alloc(64, 9).toString("base64url"),
    };
    expect(await runtime.validatePayload({
      type: "bundle-signature-response",
      payload: forged,
      jobId: JOB_ID,
      sender: BUYER,
      audience: SELLER,
    })).toMatchObject({ status: "invalid" });
  });
});

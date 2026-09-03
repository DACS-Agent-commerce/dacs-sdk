import { describe, expect, it } from "vitest";
import { createPublicClient, erc20Abi, http } from "viem";

import {
  ARTIFACT_SEPARATORS,
  contentHash,
  createUcpDacsMerchantAttestor,
  createUcpMerchantIdentityBinding,
  createUcpRestClient,
  createX402Rail,
  deriveUcpRfqAgreement,
  discoverUcpBusiness,
  ed25519Sign,
  ed25519Verify,
  generateCanonicalJobId,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  RAIL_REGISTRY_INDEX_ADDRESS,
  rawPublicKey,
  resolveRail,
  runUcpX402Mvp,
  signComponentArtifact,
  signFixedPriceAgreement,
  x402Settle,
  type AttestationRef,
  type AuthenticatedRailDefinition,
  type BuildComponentSignatureOptions,
  type CommitmentSignatureVerifier,
  type IdentityBundle,
  type Listing,
  type PaymentRailRef,
  type RailDefinition,
  type RailRegistryDefinitionRef,
  type RailRegistryIndexDocument,
  type RailRegistrySelectionProvider,
  type UcpCompositionSignatureVerifier,
} from "../../src/index.js";
import type { AnchorReceipt } from "../../src/artifacts/types.js";
import { startLiveX402Paywall } from "./live-x402-paywall.js";
import { startLiveUcpMerchant } from "./live-ucp-merchant.js";

const REQUIRED_ENV = [
  "BUYER_EVM_KEY",
  "SELLER_EVM",
  "PAY_NETWORK",
  "PAY_TOKEN",
] as const;
const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
const ready = missing.length === 0;
const PAYMENT_DISPLAY_AMOUNT = "0.01";
const PAYMENT_BASE_UNITS = 10_000n;
const BUYER_SEED = Uint8Array.from(Buffer.alloc(32, 71));
const SELLER_SEED = Uint8Array.from(Buffer.alloc(32, 72));
const STEWARD_SEED = Uint8Array.from(Buffer.alloc(32, 73));
const HASH = "a".repeat(64);

const claim = (seed: Uint8Array) =>
  `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
const BUYER = claim(BUYER_SEED);
const SELLER = claim(SELLER_SEED);
const STEWARD = claim(STEWARD_SEED);

function signer(
  party: string,
  seed: Uint8Array,
): BuildComponentSignatureOptions {
  return {
    algorithm: "ed25519",
    signer: party,
    sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(seed)),
  };
}

const buyerSigner = signer(BUYER, BUYER_SEED);
const sellerSigner = signer(SELLER, SELLER_SEED);
const publicKeys = new Map([
  [BUYER, publicKeyFromSeed(BUYER_SEED)],
  [SELLER, publicKeyFromSeed(SELLER_SEED)],
]);
const verifyBytes = (party: string, bytes: Uint8Array, value: string): boolean => {
  const key = publicKeys.get(party);
  return key
    ? ed25519Verify(bytes, Buffer.from(value, "base64url"), key)
    : false;
};
const verifyAgreementSignature: CommitmentSignatureVerifier = (input) =>
  verifyBytes(input.signer, input.signedBytes, input.value) ? "valid" : "invalid";
const verifyCompositionSignature: UcpCompositionSignatureVerifier = (input) =>
  verifyBytes(input.signer, input.signedBytes, input.value) ? "valid" : "invalid";

function identity(primaryClaim: string): IdentityBundle {
  return {
    bundleVersion: "1",
    presentedBy: primaryClaim,
    presentedAt: Date.now() - 1_000,
    claims: [{ ref: primaryClaim }],
    presentation: {
      kind: "per-claim",
      signatures: [{ ref: primaryClaim, signature: "live-integration-proof" }],
    },
  };
}

function vetRef(locator: string): AttestationRef {
  return { anchor: { kind: "storage-program", locator }, contentHash: HASH };
}

function receipt(
  ref: RailRegistryDefinitionRef,
  logicalAddress: string,
): AnchorReceipt {
  return {
    receiptVersion: "1",
    substrate: "live-test-control-plane",
    finalityProfile: "instant-finality",
    logicalAddress,
    nativeAddress: ref.anchor.locator,
    contentHash: ref.contentHash,
    transactionRef: { kind: "test", value: `tx:${ref.contentHash}` },
    writer: STEWARD,
    state: "finalized",
    observationDisposition: "established",
    observedAt: Date.now(),
    blockRef: { id: "live-test-control-plane:1", height: "1" },
    evidence: { kind: "test-proof", value: `proof:${ref.contentHash}` },
  };
}

async function authenticatedRail(input: {
  selected: PaymentRailRef;
  network: `eip155:${number}`;
  token: `0x${string}`;
  resourceBaseUrl: string;
}): Promise<AuthenticatedRailDefinition> {
  const chainId = Number(input.network.slice("eip155:".length));
  const definition = await signComponentArtifact({
    railVersion: input.selected.railVersion!,
    railId: input.selected.railId,
    railType: "x402",
    asset: {
      kind: "erc20",
      chainId,
      contract: input.token,
      symbol: "USDC",
      decimals: 6,
    },
    network: { kind: "x402-resource", resourceBaseUrl: input.resourceBaseUrl },
    phaseHandler: "pay-x402",
    parameters: { authorization: "eip-3009", finalityBlocks: 1 },
    availability: "live",
    governance: {
      proposedBy: STEWARD,
      acceptedAt: Date.now() - 60_000,
      anchoring: "single-signer",
    },
  } satisfies Omit<RailDefinition, "signature">, "dacs-rail:v1:", {
    algorithm: "ed25519",
    signer: STEWARD,
    sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(STEWARD_SEED)),
  });
  const definitionRef: RailRegistryDefinitionRef = {
    logicalAddress: "dacs4:rail:x402-default:live-test",
    anchor: { kind: "storage-program", locator: "rail:x402-default:live-test" },
    contentHash: contentHash(definition as unknown as Record<string, unknown>),
  };
  const index: RailRegistryIndexDocument = {
    registryId: RAIL_REGISTRY_INDEX_ADDRESS,
    entries: [definitionRef],
  };
  const indexRef: RailRegistryDefinitionRef = {
    logicalAddress: RAIL_REGISTRY_INDEX_ADDRESS,
    anchor: { kind: "storage-program", locator: "rail:index:live-test" },
    contentHash: contentHash(index as unknown as Record<string, unknown>),
  };
  const documents = new Map<string, Record<string, unknown>>([
    [definitionRef.anchor.locator, definition as unknown as Record<string, unknown>],
    [indexRef.anchor.locator, index as unknown as Record<string, unknown>],
  ]);
  const provider: RailRegistrySelectionProvider = {
    resolveCurrentIndex: async () => ({
      registryVersion: 1,
      indexRef,
      receipt: receipt(indexRef, RAIL_REGISTRY_INDEX_ADDRESS),
    }),
    authenticateCurrentIndex: () => "valid",
    readAnchoredJson: async (ref) => documents.get(ref.anchor.locator) ?? null,
    resolveDefinitionReceipt: async () => receipt(
      definitionRef,
      definitionRef.logicalAddress,
    ),
    authenticateDefinition: () => "valid",
    stewardWriter: STEWARD,
    stewardPublicKey: rawPublicKey(publicKeyFromSeed(STEWARD_SEED)),
    stewardSigner: STEWARD,
    verify: (bytes, signature, publicKey) =>
      ed25519Verify(bytes, signature, publicKeyFromRaw(publicKey)),
  };
  return resolveRail(RAIL_REGISTRY_INDEX_ADDRESS, {
    railId: input.selected.railId,
    railVersion: input.selected.railVersion,
  }, provider);
}

function paymentRpc(network: string): string {
  const configured = process.env.PAY_RPC;
  if (configured) return configured;
  if (network === "eip155:84532") return "https://sepolia.base.org";
  throw new Error("PAY_RPC is required for this live x402 network");
}

describe("LIVE DACS + UCP + x402 composition", () => {
  if (!ready) {
    it.skip(`needs funded x402 inputs — set ${missing.join(", ")}`, () => {});
    return;
  }

  it("negotiates, checks identity, pays through x402, and returns signed order evidence", async () => {
    if (process.env.LIVE_UCP_X402_CONFIRM !== "1") {
      throw new Error(
        "set LIVE_UCP_X402_CONFIRM=1 to acknowledge the 0.01 USDC testnet payment",
      );
    }
    const network = process.env.PAY_NETWORK! as `eip155:${number}`;
    if (!/^eip155:[1-9][0-9]*$/.test(network)) {
      throw new Error("PAY_NETWORK must be a canonical EVM CAIP-2 identifier");
    }
    if (
      network === "eip155:8453" &&
      process.env.LIVE_E2E_ALLOW_MAINNET !== "1"
    ) {
      throw new Error("refusing a mainnet payment without LIVE_E2E_ALLOW_MAINNET=1");
    }
    const token = process.env.PAY_TOKEN! as `0x${string}`;
    const payTo = process.env.SELLER_EVM! as `0x${string}`;
    if (!/^0x[0-9a-fA-F]{40}$/.test(token) || !/^0x[0-9a-fA-F]{40}$/.test(payTo)) {
      throw new Error("PAY_TOKEN and SELLER_EVM must be EVM addresses");
    }
    const rpcUrl = paymentRpc(network);
    const x402 = await createX402Rail({
      evmPrivateKey: process.env.BUYER_EVM_KEY!,
      rpcUrl,
      finalityBlocks: 1,
      requireSessionBinding: true,
    });
    const chain = createPublicClient({ transport: http(rpcUrl) });
    const [balance, decimals, symbol] = await Promise.all([
      chain.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [x402.address as `0x${string}`],
      }),
      chain.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
      chain.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
    ]);
    if (decimals !== 6 || symbol !== "USDC") {
      throw new Error(`live MVP requires a 6-decimal USDC token; received ${symbol}/${decimals}`);
    }
    if (balance < PAYMENT_BASE_UNITS) {
      throw new Error(
        `x402 buyer has ${balance} base units; ${PAYMENT_BASE_UNITS} are required`,
      );
    }

    const paywall = await startLiveX402Paywall({
      network,
      payTo,
      asset: token,
      amount: PAYMENT_BASE_UNITS.toString(),
      facilitatorUrl: process.env.X402_FACILITATOR ?? "https://x402.org/facilitator",
    });
    const merchant = await startLiveUcpMerchant({
      paywallUrl: paywall.url,
      network,
      token,
      tokenSymbol: "USDC",
      tokenDecimals: 6,
      payTo,
      checkoutMinorAmount: 1,
      finalityBlocks: 1,
      merchantPublicKey: Buffer.from(rawPublicKey(publicKeyFromSeed(SELLER_SEED)))
        .toString("base64url"),
    });

    try {
      const now = Date.now();
      const selectedRail: PaymentRailRef = {
        railId: "x402:default",
        railVersion: 1,
        parameters: { network, asset: token },
      };
      const business = await discoverUcpBusiness({ profileUrl: merchant.profileUrl });
      const unsignedListing = {
        dacsVersion: "1" as const,
        listingVersion: 1,
        listingId: `ucp-x402-live-${now}`,
        seller: {
          identity: identity(SELLER),
          displayName: "DACS UCP live merchant",
          publicEndpoint: "https://merchant.example/dacs",
        },
        offering: {
          title: "Live UCP integration item",
          description: "A testnet purchase exercising DACS, UCP and x402",
          category: "sdk.integration",
          tags: ["live", "ucp", "x402"],
          deliverable: {
            kind: "attested-payload" as const,
            payloadFormat: "application/json",
            verificationMethod: { kind: "self-signed" as const },
          },
        },
        buyerRequirement: { requirementVersion: "1" as const, required: [] },
        pipeline: [
          { kind: "negotiate-rfq" as const, parameters: { maxTurns: 2, timeoutSec: 120 } },
          { kind: "commit-agreement" as const },
          { kind: "pay-x402" as const, parameters: { rail: selectedRail.railId } },
          { kind: "deliver-attested-payload" as const },
        ],
        pricing: {
          kind: "negotiable" as const,
          bandCenter: { amount: PAYMENT_DISPLAY_AMOUNT, currency: "USDC" },
          minPct: 10,
          maxPct: 10,
        },
        acceptedRails: [selectedRail],
        terms: { deadlineSecAfterCommit: 1_800 },
        validity: { notBefore: now - 1_000, notAfter: now + 3_600_000 },
      };
      const listing = await signComponentArtifact(
        unsignedListing,
        ARTIFACT_SEPARATORS.Listing,
        sellerSigner,
      ) as Listing;
      const derivation = {
        jobId: generateCanonicalJobId({ timestamp: now }),
        verifiedListing: {
          disposition: "verified" as const,
          listing,
          pin: {
            listingId: listing.listingId,
            version: listing.listingVersion,
            contentHash: contentHash(listing as unknown as Record<string, unknown>),
          },
        },
        buyer: { identityBundle: identity(BUYER), vetRecordRef: vetRef("live:buyer-vet") },
        seller: { identityBundle: identity(SELLER), vetRecordRef: vetRef("live:seller-vet") },
        selectedRail,
        agreedPrice: { amount: PAYMENT_DISPLAY_AMOUNT, currency: "USDC" },
        channel: {
          subnet: "dacs-ucp-live-rfq",
          lastMessageHash: "d".repeat(64),
          turnCount: 2,
        },
        business,
        generatedAt: now,
      };
      const agreement = await signFixedPriceAgreement(
        deriveUcpRfqAgreement(derivation),
        {
          party: BUYER,
          algorithm: "ed25519",
          sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(BUYER_SEED)),
        },
        {
          party: SELLER,
          algorithm: "ed25519",
          sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(SELLER_SEED)),
        },
      );
      const identityBinding = await createUcpMerchantIdentityBinding({
        merchantClaim: SELLER,
        business,
        issuedAt: now - 1_000,
        expiresAt: now + 3_600_000,
        signer: sellerSigner,
      });
      const railDefinition = await authenticatedRail({
        selected: selectedRail,
        network,
        token,
        resourceBaseUrl: paywall.url,
      });
      const settle = x402Settle(x402, {
        url: paywall.url,
        network,
        recipientEvm: payTo,
        asset: token,
      });
      const result = await runUcpX402Mvp({
        agreement,
        derivation,
        business,
        identityBinding,
        authenticatedRail: railDefinition,
        lineItems: [{ item: { id: "dacs-ucp-live-item" }, quantity: 1 }],
        paymentPhaseOrchestrator: BUYER,
        nowMs: () => Date.now(),
        paymentEvidenceSigner: buyerSigner,
      }, {
        ucp: createUcpRestClient({
          business,
          platformProfileUrl: merchant.profileUrl,
        }),
        settle,
        merchantAttestor: createUcpDacsMerchantAttestor({ merchantSigner: sellerSigner }),
        authorizeCompletion: async () => ({
          approved: true,
          mechanism: "trusted-ui",
          reference: "live-test-operator-approval",
        }),
        verifyAgreementSignature,
        verifyCompositionSignature,
      });

      expect(result.completedCheckout.status).toBe("completed");
      expect(result.checkoutBinding.payment.amount).toBe(PAYMENT_BASE_UNITS.toString());
      expect(result.settlement.txRef?.kind).toBe("x402-event");
      expect(result.paymentEvidence.outcome).toBe("success");
      expect(result.orderEvidence.orderId).toBe(merchant.orderId);
      expect(merchant.calls.create()).toBe(1);
      expect(merchant.calls.complete()).toBe(1);
      console.info("LIVE UCP+x402 MVP completed", {
        checkoutId: result.completedCheckout.id,
        orderId: result.order.id,
        txHash: result.settlement.txHash,
        network: result.settlement.chainId,
        paymentBaseUnits: PAYMENT_BASE_UNITS.toString(),
      });
    } finally {
      await merchant.close();
      await paywall.close();
    }
  }, 360_000);
});

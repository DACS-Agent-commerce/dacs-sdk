import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { createPublicClient, erc20Abi, http } from "viem";

import {
  AnchorWaitError,
  createAgent,
  createFsDemosWriteJournal,
  createFsSessionStore,
  createInMemoryBindingStore,
  createX402Rail,
  ed25519Verify,
  generateCanonicalJobId,
  identityBundleHash,
  listingAddress,
  logicalToStorageProgramName,
  publicKeyFromRaw,
  signedBytes,
  SubstrateError,
  x402Settle,
  type IdentityBundle,
  type ListingDraft,
  type ListingValidationDeps,
  type PaymentRailRef,
} from "../../src/index.js";
import { startLiveX402Paywall } from "./live-x402-paywall.js";

/**
 * LIVE on-chain end-to-end gate: real Demos anchors plus an x402 settlement.
 * CI remains offline unless every credential and the explicit spend
 * acknowledgement are supplied.
 *
 *   DEMOS_RPC=… SELLER_WALLET=… SELLER_DID=… BUYER_WALLET=… BUYER_DID=… \
 *   SELLER_IDENTITY_BUNDLE_JSON=… BUYER_IDENTITY_BUNDLE_JSON=… \
 *   BUYER_EVM_KEY=0x… PAYWALL_URL=local PAY_NETWORK=eip155:84532 \
 *   SELLER_EVM=0x… PAY_TOKEN=0x… DACS_STATE_DIR=… LIVE_E2E_CONFIRM=1 \
 *   npx vitest run test/integration/live.e2e.test.ts
 */

const ENV = [
  "DEMOS_RPC",
  "SELLER_WALLET",
  "SELLER_DID",
  "SELLER_IDENTITY_BUNDLE_JSON",
  "BUYER_WALLET",
  "BUYER_DID",
  "BUYER_IDENTITY_BUNDLE_JSON",
  "BUYER_EVM_KEY",
  "PAYWALL_URL",
  "PAY_NETWORK",
  "SELLER_EVM",
  "PAY_TOKEN",
  "DACS_STATE_DIR",
  "LIVE_E2E_CONFIRM",
] as const;

const env = Object.fromEntries(ENV.map((key) => [key, process.env[key]])) as Record<
  (typeof ENV)[number],
  string | undefined
>;
const missing = ENV.filter((key) => !env[key]);
const ready = missing.length === 0;

const OS_PER_DEM = 1_000_000_000n;
// One seller listing and three buyer session anchors currently cost 2 DEM each.
// The extra DEM is deliberate live-test headroom, not a general fee estimator.
const SELLER_MINIMUM_OS = 3n * OS_PER_DEM;
const BUYER_MINIMUM_OS = 7n * OS_PER_DEM;
// A real non-zero settlement is sufficient for this finality gate. Keep the
// irreversible spend aligned with the Listing's base-unit price and capped at
// the smallest representable USDC amount.
const PAYMENT_AMOUNT = 1n;
const MAX_PAYMENT_AMOUNT = 1n;

const payloadCapability = () => ({ disposition: "supported" as const });

async function retryDefinitiveDemosFailure<T>(input: {
  operation: () => Promise<T>;
  expectedNames: ReadonlySet<string>;
  label: string;
}): Promise<T> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await input.operation();
    } catch (error) {
      const definitivelyFailed =
        error instanceof AnchorWaitError &&
        error.code === "inclusion-failed" &&
        error.receipt.state === "failed" &&
        input.expectedNames.has(error.receipt.name);
      if (!definitivelyFailed || attempt === 3) throw error;
      console.warn("LIVE E2E retrying definitively failed Demos write", {
        label: input.label,
        attempt,
        name: error.receipt.name,
        txRef: error.receipt.txRef,
      });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw new Error(`${input.label} exhausted its bounded Demos retries`);
}

async function retryListingHistoryRead<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const preWriteReadFailure =
        error instanceof SubstrateError &&
        error.message.startsWith(
          "listing version history lookup was indeterminate (name-prefix lookup failed:",
        );
      if (!preWriteReadFailure || attempt === 3) throw error;
      console.warn("LIVE E2E retrying read-only listing history preflight", {
        attempt,
        message: error.message,
      });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw new Error("listing history preflight exhausted its bounded retries");
}

function railAuthority(selectedRail: PaymentRailRef) {
  return {
    trustPhase: "PA-1" as const,
    trustPolicyAcceptsPA1: true,
    registry: { state: "not-used" as const, entries: [], definitions: [] },
    inCodeDefinitions: [
      {
        railId: selectedRail.railId,
        railVersion: selectedRail.railVersion!,
        phaseHandler: "pay-x402",
        governanceAnchoring: "in-code" as const,
        signatureValid: true,
      },
    ],
  };
}

async function signedIdentity(
  primaryClaim: string,
  signer: { sign(bytes: Uint8Array): Promise<Uint8Array> },
  presentedAt: number,
): Promise<IdentityBundle> {
  const presentation = {
    kind: "per-claim" as const,
    signatures: [{ ref: primaryClaim, signature: "pending" }],
  };
  const bundle: IdentityBundle = {
    bundleVersion: "1",
    presentedBy: primaryClaim,
    presentedAt,
    claims: [{ ref: primaryClaim }],
    presentation,
  };
  const signature = await signer.sign(
    signedBytes("dacs-bundle-presentation:v1:", identityBundleHash(bundle)),
  );
  presentation.signatures[0]!.signature = Buffer.from(signature).toString("base64url");
  return bundle;
}

function listingValidationDeps(input: {
  sellerDid: string;
  sellerPublicKey: Uint8Array;
  selectedRail: PaymentRailRef;
}): ListingValidationDeps {
  const verifyEd25519 = (bytes: Uint8Array, value: string): boolean => {
    try {
      return ed25519Verify(
        bytes,
        Uint8Array.from(Buffer.from(value, "base64url")),
        publicKeyFromRaw(input.sellerPublicKey),
      );
    } catch {
      return false;
    }
  };
  return {
    nowMs: () => Date.now(),
    verifyListingSignature: ({ signedBytes: bytes, signature }) =>
      signature.signer === input.sellerDid &&
      signature.algorithm === "ed25519" &&
      verifyEd25519(bytes, signature.value),
    revocation: {
      surfaces: [{ kind: "well-known", status: "active", integrity: "verified" }],
      readMarker: async () => null,
      verifyMarkerSignature: () => false,
    },
    verifyIdentityPresentation: ({ bundle, signedBytes: bytes }) =>
      bundle.presentedBy === input.sellerDid &&
      bundle.presentation.kind === "per-claim" &&
      bundle.presentation.signatures.length === 1 &&
      bundle.presentation.signatures[0]?.ref === input.sellerDid &&
      verifyEd25519(bytes, bundle.presentation.signatures[0].signature),
    loadRailResolution: () => railAuthority(input.selectedRail),
    resolvePayloadVerificationCapability: payloadCapability,
    verifySellerControl: ({ bundle, signer }) =>
      signer === input.sellerDid &&
      bundle.presentedBy === signer &&
      bundle.claims.some(({ ref }) => ref === signer),
  };
}

function formatDem(os: bigint): string {
  const whole = os / OS_PER_DEM;
  const fraction = (os % OS_PER_DEM)
    .toString()
    .padStart(9, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

async function balanceInOs(agent: Awaited<ReturnType<typeof createAgent>>) {
  const network = await agent.adapter.raw.getNetworkInfo();
  if (!network) {
    throw new Error(
      "balance preflight could not determine denomination fork status; refusing to spend",
    );
  }
  const info = await agent.adapter.raw.getAddressInfo(agent.adapter.getAddress());
  if (!info) {
    throw new Error(`balance preflight found no account for ${agent.adapter.getAddress()}`);
  }
  return network.forks.osDenomination.activated
    ? info.balance
    : info.balance * OS_PER_DEM;
}

function requireBalance(label: string, actualOs: bigint, minimumOs: bigint) {
  if (actualOs < minimumOs) {
    throw new Error(
      `${label} has ${actualOs} OS (${formatDem(actualOs)} DEM), but this E2E requires ` +
        `at least ${minimumOs} OS (${formatDem(minimumOs)} DEM) including fee headroom`,
    );
  }
}

function requireIdentity(label: string, address: string, did: string) {
  const expected = `did:demos:agent:${address.replace(/^0x/, "")}`.toLowerCase();
  if (did.toLowerCase() !== expected) {
    throw new Error(`${label} DID does not match its wallet address; refusing all writes`);
  }
}

function verifyDemosIdentityPresentation(input: {
  bundle: Readonly<IdentityBundle>;
  signedBytes: Uint8Array;
}): boolean {
  if (
    input.bundle.presentation.kind !== "per-claim" ||
    input.bundle.presentation.signatures.length !== input.bundle.claims.length ||
    !input.bundle.claims.some(({ ref }) => ref === input.bundle.presentedBy)
  ) {
    return false;
  }
  const proofs = new Map<string, string>();
  for (const proof of input.bundle.presentation.signatures) {
    if (proofs.has(proof.ref)) return false;
    proofs.set(proof.ref, proof.signature);
  }
  return input.bundle.claims.every(({ ref }) => {
    const keyHex = ref.match(/^did:demos:agent:([0-9a-f]{64})$/)?.[1];
    const encoded = proofs.get(ref);
    if (!keyHex || !encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return false;
    const signature = Uint8Array.from(Buffer.from(encoded, "base64url"));
    return signature.length === 64 &&
      Buffer.from(signature).toString("base64url") === encoded &&
      ed25519Verify(
        input.signedBytes,
        signature,
        publicKeyFromRaw(Uint8Array.from(Buffer.from(keyHex, "hex"))),
      );
  });
}

function paymentRpc(): string {
  const rpc =
    process.env.PAY_RPC ??
    (env.PAY_NETWORK === "eip155:84532" ? "https://sepolia.base.org" : undefined);
  if (!rpc) {
    throw new Error("PAY_RPC is required to preflight token funds on this network");
  }
  return rpc;
}

async function tokenBalance(address: string): Promise<bigint> {
  const rpc = paymentRpc();
  const client = createPublicClient({ transport: http(rpc) });
  return client.readContract({
    address: env.PAY_TOKEN! as `0x${string}`,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address as `0x${string}`],
  });
}

describe("LIVE on-chain lifecycle (publish → settle → verify)", () => {
  if (!ready) {
    it.skip(`needs a live node + creds — set ${missing.join(", ")}`, () => {});
    return;
  }

  it(
    "anchors a paid buyer session and verifies every available artifact",
    async () => {
      if (env.LIVE_E2E_CONFIRM !== "1") {
        throw new Error(
          "set LIVE_E2E_CONFIRM=1 to acknowledge the Demos writes and x402 payment",
        );
      }
      if (PAYMENT_AMOUNT <= 0n || PAYMENT_AMOUNT > MAX_PAYMENT_AMOUNT) {
        throw new Error("live x402 payment exceeds the one-base-unit spend cap");
      }
      if (
        env.PAY_NETWORK === "eip155:8453" &&
        process.env.LIVE_E2E_ALLOW_MAINNET !== "1"
      ) {
        throw new Error(
          "refusing a Base mainnet payment; set LIVE_E2E_ALLOW_MAINNET=1 after explicit review",
        );
      }

      const sellerBindings = createInMemoryBindingStore();
      const [sellerWriteJournal, buyerWriteJournal] = await Promise.all([
        createFsDemosWriteJournal({
          dir: join(env.DACS_STATE_DIR!, "live-e2e-seller-demos-writes"),
        }),
        createFsDemosWriteJournal({
          dir: join(env.DACS_STATE_DIR!, "live-e2e-buyer-demos-writes"),
        }),
      ]);
      const sellerIdentity = JSON.parse(
        env.SELLER_IDENTITY_BUNDLE_JSON!,
      ) as IdentityBundle;
      const buyerIdentity = JSON.parse(
        env.BUYER_IDENTITY_BUNDLE_JSON!,
      ) as IdentityBundle;
      const buyerSessionStore = await createFsSessionStore({
        dir: join(env.DACS_STATE_DIR!, "live-e2e-buyer-sessions"),
      });
      const selectedRail: PaymentRailRef = {
        railId: "x402:default",
        railVersion: 1,
        parameters: {
          network: env.PAY_NETWORK!,
          asset: env.PAY_TOKEN!,
        },
      };
      const seller = await createAgent({
        demosRpc: env.DEMOS_RPC!,
        wallet: env.SELLER_WALLET!,
        demosWriteJournal: sellerWriteJournal,
        identity: { agentId: env.SELLER_DID!, bundle: sellerIdentity },
        bindings: { index: sellerBindings, publisher: sellerBindings },
        loadListingRailResolution: () => railAuthority(selectedRail),
        resolvePayloadVerificationCapability: payloadCapability,
      });
      const sellerPublicKey = await seller.adapter.getPublicKey();
      const buyer = await createAgent({
        demosRpc: env.DEMOS_RPC!,
        wallet: env.BUYER_WALLET!,
        demosWriteJournal: buyerWriteJournal,
        identity: {
          agentId: env.BUYER_DID!,
          bundle: buyerIdentity,
          verifyPresentation: verifyDemosIdentityPresentation,
        },
        listingValidationDeps: listingValidationDeps({
          sellerDid: env.SELLER_DID!,
          sellerPublicKey,
          selectedRail,
        }),
      });
      const rail = await createX402Rail({
        evmPrivateKey: env.BUYER_EVM_KEY!,
        rpcUrl: paymentRpc(),
        finalityBlocks: 1,
      });

      const [sellerBalanceOs, buyerBalanceOs, buyerTokenBalance] = await Promise.all([
        balanceInOs(seller),
        balanceInOs(buyer),
        tokenBalance(rail.address),
      ]);
      requireIdentity("seller", seller.adapter.getAddress(), env.SELLER_DID!);
      requireIdentity("buyer", buyer.adapter.getAddress(), env.BUYER_DID!);
      requireBalance("seller", sellerBalanceOs, SELLER_MINIMUM_OS);
      requireBalance("buyer", buyerBalanceOs, BUYER_MINIMUM_OS);
      if (buyerTokenBalance < PAYMENT_AMOUNT) {
        throw new Error(
          `x402 buyer has ${buyerTokenBalance} token base units, but the E2E ` +
            `requires ${PAYMENT_AMOUNT}; refusing all Demos writes`,
        );
      }
      console.info("LIVE E2E preflight", {
        rpc: env.DEMOS_RPC,
        sellerAddress: seller.adapter.getAddress(),
        sellerBalanceDem: formatDem(sellerBalanceOs),
        buyerAddress: buyer.adapter.getAddress(),
        buyerBalanceDem: formatDem(buyerBalanceOs),
        payNetwork: env.PAY_NETWORK,
        x402BuyerAddress: rail.address,
        x402BuyerTokenBalance: buyerTokenBalance.toString(),
      });

      // One captured destination drives the paywall, buyer-signed session
      // binding, and x402 bridge. A seller DID and an EVM recipient are distinct
      // namespaces; omitting this explicit binding must fail before payment.
      const sellerEvm = env.SELLER_EVM!;
      const localPaywall =
        env.PAYWALL_URL === "local"
          ? await startLiveX402Paywall({
              network: env.PAY_NETWORK! as `${string}:${string}`,
              payTo: sellerEvm,
              asset: env.PAY_TOKEN!,
              amount: PAYMENT_AMOUNT.toString(),
              facilitatorUrl:
                process.env.X402_FACILITATOR ?? "https://x402.org/facilitator",
            })
          : undefined;

      try {
        const runStartedAt = Date.now();
        const listingId = `live-e2e-${runStartedAt}-${randomUUID()}`;
        const jobId = generateCanonicalJobId({ timestamp: runStartedAt });
        const sellerIdentity = await signedIdentity(
          env.SELLER_DID!,
          seller.adapter,
          runStartedAt,
        );
        const listing: ListingDraft = {
          dacsVersion: "1",
          listingVersion: 1,
          listingId,
          seller: {
            identity: sellerIdentity,
            displayName: "Live E2E",
            // DACS-1 advertisements are HTTPS-only. The loopback HTTP paywall
            // is an isolated test transport supplied directly to x402Settle.
            publicEndpoint: "https://seller.example/dacs/live-e2e",
          },
          offering: {
            title: "Live E2E",
            description: "integration test listing",
            category: "sdk.integration",
            tags: ["live", "x402"],
            deliverable: {
              kind: "attested-payload",
              payloadFormat: "application/json",
              verificationMethod: { kind: "self-signed" },
            },
          },
          buyerRequirement: { requirementVersion: "1", required: [] },
          pipeline: [
            { kind: "negotiate-fixed-price" },
            { kind: "commit-agreement" },
            { kind: "pay-x402", parameters: { rail: "x402:default" } },
            { kind: "deliver-attested-payload" },
          ],
          pricing: {
            kind: "fixed",
            price: { amount: "1", currency: "USDC" },
          },
          acceptedRails: [selectedRail],
          terms: { deadlineSecAfterCommit: 3_600 },
          validity: {
            notBefore: runStartedAt - 1_000,
            notAfter: runStartedAt + 3_600_000,
          },
        };
        const listingStorageName = logicalToStorageProgramName(
          listingAddress(env.SELLER_DID!, listingId, 1),
        );
        const published = await retryListingHistoryRead(() =>
          retryDefinitiveDemosFailure({
            label: "listing publication",
            expectedNames: new Set([listingStorageName]),
            operation: () => seller.publishListing(listing),
          }),
        );
        expect(published.status).toBe("published");
        if (published.status !== "published") {
          throw new Error("live listing binding publication failed");
        }
        expect(published.ref).toBeTruthy();
        expect(published.listingPin.listingId).toBe(listingId);

        const settle = x402Settle(rail, {
          url: localPaywall?.url ?? env.PAYWALL_URL!,
          network: env.PAY_NETWORK!,
          recipientEvm: sellerEvm,
          asset: env.PAY_TOKEN!,
        });
        const session = await retryDefinitiveDemosFailure({
          label: "buyer session",
          expectedNames: new Set([
            `dacs3:agreement:${jobId}`,
            `dacs4:evidence:${jobId}`,
            `dacs5:bundle:${jobId}`,
          ]),
          operation: () =>
            buyer.runSession(published.ref, {
              jobId,
              sessionStore: buyerSessionStore,
              terms: {
                price: {
                  amount: PAYMENT_AMOUNT.toString(),
                  asset: "USDC",
                  decimals: 6,
                  rail: "x402:default",
                },
                deliveryPhase: "deliver-attested-payload",
                deliveryFormat: "application/json",
              },
              expectedSettlementPayee: sellerEvm,
              settle,
            }),
        });
        expect(session.outcome).toBe("completed");

        const verdict = await buyer.verifyBundle(session.bundleRef);
        expect(verdict.signatures.some((item) => item.verdict === "valid")).toBe(true);
        expect(verdict.refs.length).toBeGreaterThan(0);
        expect(verdict.refs.every((item) => item.verdict === "ok")).toBe(true);
        // runSessionCore still emits its explicitly quarantined buyer-only MVP
        // bundle and reports commerceComplete:false.
        // Strict two-sided finality must honestly remain false until the seller
        // co-signature is wired into orchestration.
        expect(verdict.ok).toBe(false);
        // The SDK names the missing co-signer by its ClaimReference (DID), so
        // assert the reason is a missing-required-signature verdict AND that it
        // is specifically the seller's DID that is missing.
        expect(verdict.reason).toMatch(/missing required signature/i);
        expect(verdict.reason).toContain(env.SELLER_DID!);
      } finally {
        await localPaywall?.close();
      }
    },
    360_000,
  );
});

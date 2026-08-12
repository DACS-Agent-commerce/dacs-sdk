import {
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  createServer as createHttpsServer,
  request as httpsRequest,
} from "node:https";
import { createPrivateKey } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HTTPFacilitatorClient } from "@x402/core/server";
import { encodePaymentResponseHeader } from "@x402/core/http";
import { afterEach, describe, it } from "vitest";
import {
  createPublicClient,
  erc20Abi,
  getAddress,
  http,
  parseAbi,
  verifyMessage,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Guarded funded proof for issue #114.
 *
 * The deterministic composition and its negative cases live in
 * `test/e2e/normativePublicTwoAgent.e2e.test.ts`. This file replaces only the
 * transport/substrate seams with real Demos, Base Sepolia and x402 adapters.
 * It is intentionally invisible to CI unless the complete live configuration
 * is supplied, and LIVE_E2E_CONFIRM=1 is checked again after the no-write
 * preflight and immediately before the first Demos write.
 */
import {
  ARTIFACT_SEPARATORS,
  BUNDLE_BINDING_SEPARATOR,
  EIP3009_AUTHORIZATION_USED_TOPIC,
  ERC20_TRANSFER_TOPIC,
  FINALITY_COMMITMENT_SEPARATOR,
  advanceFixedPriceAgreementDurable,
  advanceCompletedBuyerBundleDurable,
  advanceX402BuyerSettlement,
  attestationBundleHash,
  bundleAddress,
  bundleConsistency,
  canonicalize,
  commitFixedPriceAgreement,
  contentHash,
  createAgent,
  createDacsX402BuyerEvmChallengeClient,
  createFixedPriceAgreementSigningPlan,
  createFsFencedSessionStore,
  createFsSellerReceiptStore,
  createFsX402BuyerSettlementStore,
  createFsX402PaywallSettlementStore,
  createInMemoryBindingStore,
  createViemX402BuyerEvmReadClient,
  createX402BuyerEvmAuthorizationProvider,
  createX402BuyerPaidRequestTransport,
  createX402Paywall,
  createX402SellerSpine,
  deriveFixedPriceAgreement,
  discoverListings,
  deriveX402ReceiptCommitment,
  ed25519Verify,
  ed25519Sign,
  encodeAddressSegment,
  finalityCommitmentAddress,
  finalizeCompletedSellerBundleDurable,
  generateCanonicalJobId,
  getSellerFulfilmentStatus,
  identityBundleHash,
  isFaultAttestationBundle,
  listingAddress,
  logicalToStorageProgramName,
  prepareCompletedSellerBundleCounterSignatureRequest,
  prepareX402BuyerSettlement,
  projectDurableSellerAuditPending,
  publishSellerSessionSettlement,
  publicKeyFromRaw,
  privateKeyFromSeed,
  publicKeyFromSeed,
  rawPublicKey,
  respondToFixedPriceAgreementProposalDurable,
  sha256Hex,
  signedBytes,
  validateListingArtifact,
  validateFixedPriceAgreementBinding,
  verifyBundleCopy,
  verifyDurableSellerTerminalResult,
  verifyFinalizedSessionSettlement,
  x402Eip3009Nonce,
  x402PaywallSettlementKey,
  type AgreementArtifact,
  type AnchorBinding,
  type ProtocolAnchorReceipt as AnchorReceipt,
  type AnchoredBuyerBundle,
  type AnchoredFinalityCommitment,
  type AnchoredSellerBundle,
  type AttestationRef,
  type BuyerBundleEffectFence,
  type BundleBinding,
  type BuyerBundleFinalizationDurability,
  type BundleSignature,
  type CommittedAgreementResolution,
  type CommitmentSignatureVerifier,
  type CompositeVerificationRecord,
  type DemosBackedAdapter,
  type DurableFixedPriceAgreementDurability,
  type DurableFixedPriceAgreementInput,
  type DurableBuyerBundleFinalizationInput,
  type DurableBuyerBundleFinalizationProvider,
  type DurableSellerFixedPriceAgreementDurability,
  type DurableSellerFulfilmentDeps,
  type DurableSellerBundleFinalizationProvider,
  type FaultAttestationBundle,
  type FinalityCommitmentProvider,
  type FinalizedSellerBundle,
  type FinalizeCompletedSellerBundleInput,
  type FinalizeCompletedSellerBundleDurableInput,
  type FixedPriceAgreementProposal,
  type FixedPriceAgreementSignatureContribution,
  type FixedPriceAgreementTransportIdentity,
  type IdentityBundle,
  type Listing,
  type ListingDraft,
  type ListingValidationDeps,
  type PaymentRailRef,
  type SellerBundleEffectFence,
  type SellerBundleFinalizationDurability,
  type SellerDeliveredArtifact,
  type SellerFinalSessionReceiptResult,
  type SellerFulfilmentAgreement,
  type SellerFulfilmentDurability,
  type SellerFulfilmentListing,
  type SellerFulfilmentResult,
  type SellerFulfilmentSessionRecord,
  type SellerListingAtCommitResolution,
  type SellerPaymentIntakeDeps,
  type SellerSessionSettlementNativeProofAuthentication,
  type SellerSessionSettlementPublicationDeps,
  type SellerX402RailDefinition,
  type SessionSettlementContext,
  type SessionSettlementNativeProofRef,
  type SessionSettlementVerificationProvider,
  type SettlementEvidence,
  type SignedSellerDeliveryEvidence,
  type X402BuyerEvmReadClient,
  type X402BuyerPaymentRequirements,
  type X402BuyerSettlementIntent,
  type X402Paywall,
  type X402PaywallHttpAdapter,
  type X402PaywallSettlementResult,
  type X402PaywallSettlementStore,
  type X402SellerCommittedSessionScope,
  type X402SellerPaymentPermitAuthorization,
  type X402TransferObservation,
} from "../../src/index.js";

const BASE_SEPOLIA_CHAIN_ID = 84_532;
const BASE_SEPOLIA_NETWORK = `eip155:${BASE_SEPOLIA_CHAIN_ID}` as const;
const PAYMENT_PHASE_INDEX = 2;
const DELIVERY_PHASE_INDEX = 3;
const RAIL_REGISTRY_VERSION = 7;
const RECIPE_REGISTRY_VERSION = 3;
const PAYMENT_AMOUNT = 1n;
const MAX_PAYMENT_AMOUNT = 1n;
const PAYMENT_TIMEOUT_SECONDS = 120;
const X402_VERSION = 2;
const TOKEN_NAME = "USDC";
const TOKEN_VERSION = "2";
const TOKEN_SYMBOL = "USDC";
const TOKEN_DECIMALS = 6;
const OS_PER_DEM = 1_000_000_000n;
// Eleven seller writes and seven buyer writes at the currently observed 2 DEM
// storage-program fee, plus one DEM per identity of explicit headroom. The
// extra writes are the role-owned BundleBindings and buyer finalization handoff.
const SELLER_MINIMUM_OS = 23n * OS_PER_DEM;
const BUYER_MINIMUM_OS = 15n * OS_PER_DEM;
const LEASE_DURATION_MS = 120_000;

// Test-only loopback identity. The key material is an intentionally public DER
// fixture, not a credential. Both exact local routes use TLS because the
// normative Listing and production x402 paywall require HTTPS. Trust is scoped
// to the host's exact URL/method pairs by the explicit client below.
const LOCAL_HTTPS_CERT = `-----BEGIN CERTIFICATE-----
MIICyTCCAbGgAwIBAgIJAJU/oKkKq187MA0GCSqGSIb3DQEBCwUAMBQxEjAQBgNV
BAMMCWxvY2FsaG9zdDAeFw0yNjA4MTIwNzM5MDJaFw0zNjA4MDkwNzM5MDJaMBQx
EjAQBgNVBAMMCWxvY2FsaG9zdDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoC
ggEBAK/uzRX9HAr5tqzKhAYGcoJaDnWh1Q5XTaZOU9AYwkQuqFLiT2J6baPwmpXb
RsqjGH+3Z8eNkyX9Gf0XlHpu6schzeEKmoaqhUnDTSu1Jy5HVaDjXx9ldJMMX8s/
+RRmqAo14nS0kNoXRXxEqBv+qLQ3pHi0lsMWWWcHPJutitWFdOL1qzopzoyuI1dU
HfnUdU/Gnb1OZJ71zWxpsr04cTDaj5Utqh3r9IOIR0t7V7dKcj2c1ymJqC2m59LP
9JYRXG23dfZcNhT+Yk4fdhCVVr6rdHbCyUtNX/pVax4wXiIFgK5ui0v39hR3c7SG
2sqCF+QYX7ybOt0UNiHYSp8ZRK0CAwEAAaMeMBwwGgYDVR0RBBMwEYIJbG9jYWxo
b3N0hwR/AAABMA0GCSqGSIb3DQEBCwUAA4IBAQAGlKHj9DK7yesZtmuYjr+PqPWo
016lXP2OVBOgxSk8LKoxUSAVuRoLYaxx0j2rFT4q67oUw07aBkaBOue0Mo6225ei
xeDY+YceWaB2pYvQgO1Xq1gcYRw5iqe3YrhXn9j2tBIJK5E3PBMFuLxtzzN8OtOi
IHHai4Qlvb+r4AzlPqkPFiG9ZCs0uNl5weH1SlV6k6lmfMoJ7kvallb0u/brJVNh
q3v3a9VWSzAvOPfB9tLqrv0BMyUSb/6UJTqZUBAiJD0DCMXKhg00aniWHuxsbuUW
24T473rqPEdgP9aRgUfTi5oFLLTVdBMHwy+mGz6Sg6m7siIODueb8kp34ymQ
-----END CERTIFICATE-----`;
const LOCAL_HTTPS_KEY_DER_BASE64 = `
MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQCv7s0V/RwK+bas
yoQGBnKCWg51odUOV02mTlPQGMJELqhS4k9iem2j8JqV20bKoxh/t2fHjZMl/Rn9
F5R6burHIc3hCpqGqoVJw00rtScuR1Wg418fZXSTDF/LP/kUZqgKNeJ0tJDaF0V8
RKgb/qi0N6R4tJbDFllnBzybrYrVhXTi9as6Kc6MriNXVB351HVPxp29TmSe9c1s
abK9OHEw2o+VLaod6/SDiEdLe1e3SnI9nNcpiagtpufSz/SWEVxtt3X2XDYU/mJO
H3YQlVa+q3R2wslLTV/6VWseMF4iBYCubotL9/YUd3O0htrKghfkGF+8mzrdFDYh
2EqfGUStAgMBAAECggEBAKlNWaiuYT0inyta23/c1ncgaMfEi334f63ptHgOS2xH
pg3U4OX4wOfBk1FgqZg5KUtGWKVNVWx6S3cmKOlFMcOdgTzt8lRjZk7clbfY5TKA
zSM9iv1wqaUUhF7YWj7KpyzkO99pH/fv6xsyCsCd6QU8gpbx2h80s6YU7bs2XuMn
qSLDMYiBIoVkIwdexHiJ+bsZZ8e9jZ4QnuyiCTwPr0zhFWmFslKWlPZ/01VQkzXh
eL47ld7hUVDVDKqQl86YSKQ8SnyEsXaR5ztmVBWXQ/ky6RgW998BA8xoZPMN/1MO
7wd6YumZsU1iEfp/sYYIWbGd00HL7zvME/7gY1snDOECgYEA1fDRR1d2LujIBbQF
D7hH1ME9PxBGZMqkANyhfWUCNLmWGJBJyZcQdlp+NZdMhDueLGrfYWf44hBfhLuO
EZBG66UxWUtcafZgr6JyYhe9FHE48mTD0cE1XTBTtwZszRUqzZcFB0Mt++4ikOdG
0sFd6txnUuayDKXBBMMposZ8GCUCgYEA0oUgqq3Fd7ZIxsDXE0KAXQH7qRNwVsdI
2DXgJE3DjQSXEm8w/nAMnV3uZgAKiPJZKJo2+JG7P5B02x5AEiL/Bav2uxo3P/N+
cGQjk1dXR80C65BvWXR4lWJtisn1N4ZeZBs54kGGkiUua3OaxSVKzdrNmlcITmDH
sjIyOYkur+kCgYAsPiX5W/P71XXv//9/9bsdG21ACmyUUXfDGd1noijnoG2S3Nv1
jYEBCMvK52QSgIXAZ8WUTj0g+wPV3jeOGEkiWEIxVi1hWGs8RxrigEhA3v1I21/H
k+4mPGVDl1eOvc7hP1bx3om27NNHJhz2Xri+ZiAT+9NcXDbjdjy5BdUJ5QKBgQDA
NQRKUTYFwsxXiyHTV9hTEshu6mybDoCXxzjKbKWqTxKPpi2ZYTxjQau0PT1hI8P7
qjGeaZAIzR+kH85nwMQOrZ8r3Resr+g1PXitwgTSbX/JC6pehlTCL4fMO/BDrc7o
n2MODL2NGZ10Rax9azsNEETAMc5HoV0yeVoZ5gJWYQKBgQDJmCJ6ng/wtyOFOotD
M8bZeaKfFLOtLvyEHY2hlOkcx22BS65Ud7VKaIZuMAYqr6kL2MBhp5/lgp3cC91w
0mz63DJMLcRjZ8cwpT+2jagM77HKsz0yTjmu1iDI83N9PBKIWi2f3qFBDUjCbwDG
jI2yFCg3mHHQj4lRcLo7lKxOtA==
`.replace(/\s/g, "");
const LOCAL_HTTPS_KEY = createPrivateKey({
  key: Buffer.from(LOCAL_HTTPS_KEY_DER_BASE64, "base64"),
  format: "der",
  type: "pkcs8",
}).export({ format: "pem", type: "pkcs8" });

const READ_ONLY_ENV = [
  "DEMOS_RPC",
  "SELLER_WALLET",
  "SELLER_DID",
  "BUYER_WALLET",
  "BUYER_DID",
  "BUYER_EVM_KEY",
  "SELLER_EVM_KEY",
  "SELLER_EVM",
  "PAYWALL_URL",
  "PAY_NETWORK",
  "PAY_RPC",
  "PAY_TOKEN",
  "X402_FACILITATOR",
  "LIVE_E2E_RUN_ID",
] as const;
const FUNDED_ENV = [...READ_ONLY_ENV, "LIVE_E2E_CONFIRM"] as const;

type ReadOnlyEnvKey = (typeof READ_ONLY_ENV)[number];
type FundedEnvKey = (typeof FUNDED_ENV)[number];
type LiveEnv = Record<FundedEnvKey, string>;

const rawEnv = Object.fromEntries(
  FUNDED_ENV.map((key) => [key, process.env[key]]),
) as Record<FundedEnvKey, string | undefined>;
const missingReadOnly = READ_ONLY_ENV.filter((key) => !rawEnv[key]);
const missingFunded = FUNDED_ENV.filter((key) => !rawEnv[key]);

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true })
    ),
  );
});

function requireCondition(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(`funded-e2e:${code}`);
}

function safeStageFailureClass(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/normative unsigned/.test(message)) return "listing-draft-invalid";
  if (/signed Listing failed/.test(message)) return "listing-signature-envelope-invalid";
  if (/canonical JSON|exact snapshot|stable/.test(message)) return "canonical-snapshot-invalid";
  if (/rail/i.test(message)) return "rail-authority-invalid";
  if (/history|prior listing|version/i.test(message)) return "listing-history-invalid";
  if (/identity|self-certifying|wallet/i.test(message)) return "listing-identity-invalid";
  if (/binding/i.test(message)) return "listing-binding-invalid";
  if (/publication|anchor|write/i.test(message)) return "listing-publication-invalid";
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9]*Error$/.test(error.name)
    ? error.name
    : "unknown-error";
}

function verifyEd25519ArtifactSignature(
  separator: string,
  artifact: Record<string, unknown>,
  signature: { algorithm: string; signer?: string; party?: string; value: string },
  expectedSigner: string,
  rawKey: Uint8Array,
): boolean {
  const signer = signature.signer ?? signature.party;
  try {
    return signature.algorithm === "ed25519" && signer === expectedSigner &&
      ed25519Verify(
        signedBytes(separator, contentHash(artifact)),
        Uint8Array.from(Buffer.from(signature.value, "base64url")),
        publicKeyFromRaw(rawKey),
      );
  } catch {
    return false;
  }
}

async function stage<T>(code: string, operation: () => Promise<T>): Promise<T> {
  requireCondition(/^[a-z0-9-]+$/.test(code), "stage-code-invalid");
  process.stderr.write(`funded-e2e-stage:${code}:start\n`);
  try {
    const result = await operation();
    process.stderr.write(`funded-e2e-stage:${code}:passed\n`);
    return result;
  } catch (error) {
    process.stderr.write(`funded-e2e-stage:${code}:failed\n`);
    process.stderr.write(
      `funded-e2e-stage:${code}:detail:${safeStageFailureClass(error)}\n`,
    );
    if (
      error instanceof Error &&
      /^funded-e2e:[a-z0-9-]+$/.test(error.message)
    ) {
      throw error;
    }
    throw new Error(`funded-e2e:${code}`);
  }
}

async function temporaryDirectory(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `dacs-funded-${label}-`));
  temporaryDirectories.push(dir);
  return dir;
}

function completeEnv(): LiveEnv {
  requireCondition(missingFunded.length === 0, "configuration-incomplete");
  return rawEnv as LiveEnv;
}

function completeReadOnlyEnv(): LiveEnv {
  requireCondition(missingReadOnly.length === 0, "configuration-incomplete");
  return {
    ...(rawEnv as Record<ReadOnlyEnvKey, string>),
    LIVE_E2E_CONFIRM: rawEnv.LIVE_E2E_CONFIRM ?? "",
  };
}

function didForAddress(address: string): string {
  return `did:demos:agent:${address.replace(/^0x/, "")}`.toLowerCase();
}

function demosIdentityMatches(address: string, did: string): boolean {
  return did.toLowerCase() === didForAddress(address);
}

function assertDemosIdentity(adapter: DemosBackedAdapter, did: string): void {
  requireCondition(
    did === didForAddress(adapter.getAddress()),
    "demos-wallet-did-mismatch",
  );
}

interface FundedPreflightInput {
  connectedChainId: number;
  sellerDemosBalance: bigint;
  buyerDemosBalance: bigint;
  paymentBalance: bigint;
}

function fundedPreflightDecision(input: FundedPreflightInput):
  | { disposition: "ready" }
  | { disposition: "rejected"; reason: string } {
  if (input.connectedChainId !== BASE_SEPOLIA_CHAIN_ID) {
    return { disposition: "rejected", reason: "wrong-network" };
  }
  if (input.sellerDemosBalance < SELLER_MINIMUM_OS) {
    return { disposition: "rejected", reason: "seller-demos-headroom-insufficient" };
  }
  if (input.buyerDemosBalance < BUYER_MINIMUM_OS) {
    return { disposition: "rejected", reason: "buyer-demos-headroom-insufficient" };
  }
  if (input.paymentBalance < PAYMENT_AMOUNT) {
    return { disposition: "rejected", reason: "payment-token-balance-insufficient" };
  }
  return { disposition: "ready" };
}

async function demosBalanceOs(adapter: DemosBackedAdapter): Promise<bigint> {
  const network = await adapter.raw.getNetworkInfo();
  requireCondition(network?.forks?.osDenomination !== undefined, "demos-denomination-unavailable");
  const account = await adapter.raw.getAddressInfo(adapter.getAddress());
  requireCondition(account && typeof account.balance === "bigint", "demos-balance-unavailable");
  return network.forks.osDenomination.activated
    ? account.balance
    : account.balance * OS_PER_DEM;
}

function validateStaticConfiguration(env: LiveEnv): void {
  requireCondition(env.PAYWALL_URL === "local", "paywall-must-be-local");
  requireCondition(env.PAY_NETWORK === BASE_SEPOLIA_NETWORK, "network-not-base-sepolia");
  requireCondition(/^0x[0-9a-fA-F]{40}$/.test(env.PAY_TOKEN), "token-address-invalid");
  requireCondition(/^0x[0-9a-fA-F]{40}$/.test(env.SELLER_EVM), "payee-address-invalid");
  requireCondition(/^0x[0-9a-fA-F]{64}$/.test(env.BUYER_EVM_KEY), "buyer-evm-key-invalid");
  requireCondition(/^0x[0-9a-fA-F]{64}$/.test(env.SELLER_EVM_KEY), "seller-evm-key-invalid");
  requireCondition(/^[A-Za-z0-9._-]{1,64}$/.test(env.LIVE_E2E_RUN_ID), "run-id-invalid");
  requireCondition(PAYMENT_AMOUNT > 0n && PAYMENT_AMOUNT <= MAX_PAYMENT_AMOUNT, "spend-cap-invalid");
  for (const key of ["DEMOS_RPC", "PAY_RPC", "X402_FACILITATOR"] as const) {
    let parsed: URL;
    try {
      parsed = new URL(env[key]);
    } catch {
      throw new Error("funded-e2e:url-invalid");
    }
    requireCondition(parsed.protocol === "https:", "url-scheme-invalid");
    requireCondition(!parsed.username && !parsed.password && !parsed.hash, "url-authority-invalid");
    requireCondition(
      parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1" &&
      parsed.hostname !== "[::1]",
      "remote-url-loopback-invalid",
    );
  }
}

interface LocalPaywallHost {
  readonly resourceUrl: string;
  readonly engagementUrl: string;
  readonly route: string;
  readonly fetchImpl: typeof fetch;
  install(paywall: X402Paywall<{ delivered: true }>): void;
  installEngagement(
    handler: (proposal: unknown, identity: unknown) => Promise<unknown>,
  ): void;
  close(): Promise<void>;
  readonly requestCounts: { unpaid: number; paid: number; engagement: number };
}

function requestAdapter(req: IncomingMessage, url: URL): X402PaywallHttpAdapter {
  return Object.freeze({
    getHeader: (name: string) => {
      const value = req.headers[name.toLowerCase()];
      return Array.isArray(value) ? value[0] : value;
    },
    getMethod: () => req.method ?? "GET",
    getPath: () => url.pathname,
    getUrl: () => url.toString(),
    getAcceptHeader: () => typeof req.headers.accept === "string"
      ? req.headers.accept
      : "application/json",
    getUserAgent: () => typeof req.headers["user-agent"] === "string"
      ? req.headers["user-agent"]
      : "dacs-funded-e2e",
  });
}

function writePaywallResponse(
  res: ServerResponse,
  response: { status: number; headers: Record<string, string>; body?: unknown },
): void {
  res.writeHead(response.status, response.headers);
  res.end(typeof response.body === "string"
    ? response.body
    : JSON.stringify(response.body ?? {}));
}

async function startLocalPaywallHost(
  runId: string,
  jobId: string,
): Promise<LocalPaywallHost> {
  let paywall: X402Paywall<{ delivered: true }> | undefined;
  let engagement: ((proposal: unknown, identity: unknown) => Promise<unknown>) | undefined;
  const requestCounts = { unpaid: 0, paid: 0, engagement: 0 };
  const routePath = `/issue-114/${sha256Hex(runId).slice(0, 24)}`;
  const engagementPath = `${routePath}/engage`;
  const server = createHttpsServer({
    cert: LOCAL_HTTPS_CERT,
    key: LOCAL_HTTPS_KEY,
  }, (req, res) => {
    void (async () => {
      const address = server.address();
      requireCondition(address && typeof address !== "string", "local-server-address-unavailable");
      const url = new URL(req.url ?? "/", `https://127.0.0.1:${address.port}`);
      if (url.pathname === engagementPath && req.method === "POST") {
        if (!engagement) {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "engagement-not-ready" }));
          return;
        }
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of req) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          length += bytes.byteLength;
          requireCondition(length <= 1_000_000, "engagement-request-too-large");
          chunks.push(bytes);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          proposal?: unknown;
          identity?: unknown;
        };
        requestCounts.engagement += 1;
        const result = await engagement(body.proposal, body.identity);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }
      if (url.pathname !== routePath || req.method !== "GET") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not-found" }));
        return;
      }
      if (!paywall) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "paywall-not-ready" }));
        return;
      }
      if (req.headers["payment-signature"] === undefined) requestCounts.unpaid += 1;
      else requestCounts.paid += 1;
      const result = await paywall.handle({
        jobId,
        phaseIndex: PAYMENT_PHASE_INDEX,
        request: requestAdapter(req, url),
      });
      writePaywallResponse(res, result.response);
    })().catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: "funded-e2e-local-handler-failed" }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  requireCondition(address && typeof address !== "string", "local-server-address-unavailable");
  const resourceUrl = `https://127.0.0.1:${address.port}${routePath}`;
  const engagementUrl = `https://127.0.0.1:${address.port}${engagementPath}`;
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const method = request.method.toUpperCase();
    const exactRoute = request.url === resourceUrl && method === "GET" ||
      request.url === engagementUrl && method === "POST";
    requireCondition(exactRoute, "local-tls-request-out-of-scope");
    requireCondition(request.redirect === "error", "local-tls-redirect-policy-invalid");
    const url = new URL(request.url);
    requireCondition(
      url.protocol === "https:" && url.hostname === "127.0.0.1" &&
      !url.username && !url.password && !url.hash,
      "local-tls-url-invalid",
    );
    const body = method === "GET"
      ? undefined
      : Buffer.from(await request.arrayBuffer());
    requireCondition(body === undefined || body.byteLength <= 1_000_000, "local-tls-request-too-large");
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      headers[name] = value;
    });
    headers.connection = "close";
    if (body !== undefined) headers["content-length"] = String(body.byteLength);
    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const finish = (operation: () => void) => {
        if (settled) return;
        settled = true;
        operation();
      };
      const client = httpsRequest(url, {
        method,
        headers,
        ca: LOCAL_HTTPS_CERT,
        rejectUnauthorized: true,
        agent: false,
      }, (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer | Uint8Array | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          length += bytes.byteLength;
          if (length > 1_000_000) {
            response.destroy();
            finish(() => reject(new Error("funded-e2e:local-tls-response-too-large")));
            return;
          }
          chunks.push(bytes);
        });
        response.once("error", (error) => finish(() => reject(error)));
        response.once("end", () => finish(() => {
          const responseHeaders = new Headers();
          for (let index = 0; index < response.rawHeaders.length; index += 2) {
            responseHeaders.append(
              response.rawHeaders[index]!,
              response.rawHeaders[index + 1]!,
            );
          }
          resolve(new Response(Buffer.concat(chunks), {
            status: response.statusCode ?? 500,
            statusText: response.statusMessage,
            headers: responseHeaders,
          }));
        }));
      });
      client.once("error", (error) => finish(() => reject(error)));
      client.end(body);
    });
  };
  return {
    resourceUrl,
    engagementUrl,
    route: `GET ${routePath}`,
    fetchImpl,
    install(value) {
      paywall = value;
    },
    installEngagement(handler) {
      engagement = handler;
    },
    requestCounts,
    close: () => server.listening
      ? new Promise((resolve) => server.close(() => resolve()))
      : Promise.resolve(),
  };
}

interface Preflight {
  env: LiveEnv;
  jobId: string;
  seller: Awaited<ReturnType<typeof createAgent>>;
  buyer: Awaited<ReturnType<typeof createAgent>>;
  evm: PublicClient;
  evmReader: X402BuyerEvmReadClient;
  payer: `0x${string}`;
  payee: `0x${string}`;
  asset: `0x${string}`;
  authorizationSearchFromBlock: number;
  host: LocalPaywallHost;
  facilitator: HTTPFacilitatorClient;
}

const tokenMetadataAbi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function version() view returns (string)",
]);

async function runNoWritePreflight(env: LiveEnv): Promise<Preflight> {
  validateStaticConfiguration(env);
  const buyerEvm = privateKeyToAccount(env.BUYER_EVM_KEY as `0x${string}`);
  const sellerEvm = privateKeyToAccount(env.SELLER_EVM_KEY as `0x${string}`);
  const payer = getAddress(buyerEvm.address);
  const payee = getAddress(env.SELLER_EVM);
  const asset = getAddress(env.PAY_TOKEN);
  requireCondition(sellerEvm.address.toLowerCase() === payee.toLowerCase(), "seller-payee-key-mismatch");
  requireCondition(payer.toLowerCase() !== payee.toLowerCase(), "payer-payee-not-independent");

  const bindings = createInMemoryBindingStore();
  const railAuthority = () => ({
    trustPhase: "PA-1" as const,
    trustPolicyAcceptsPA1: true,
    registry: { state: "not-used" as const, entries: [], definitions: [] },
    inCodeDefinitions: [{
      railId: "x402:base-sepolia",
      railVersion: 1,
      phaseHandler: "pay-x402",
      governanceAnchoring: "in-code" as const,
      signatureValid: true,
    }],
  });
  const [seller, buyer] = await Promise.all([
    createAgent({
      demosRpc: env.DEMOS_RPC,
      wallet: env.SELLER_WALLET,
      identity: { agentId: env.SELLER_DID },
      bindings: { index: bindings, publisher: bindings },
      loadListingRailResolution: railAuthority,
    }),
    createAgent({
      demosRpc: env.DEMOS_RPC,
      wallet: env.BUYER_WALLET,
      identity: { agentId: env.BUYER_DID },
      bindings: { index: bindings },
    }),
  ]);
  assertDemosIdentity(seller.adapter, env.SELLER_DID);
  assertDemosIdentity(buyer.adapter, env.BUYER_DID);
  requireCondition(
    seller.adapter.getAddress().toLowerCase() !== buyer.adapter.getAddress().toLowerCase(),
    "demos-agents-not-independent",
  );

  const evm = createPublicClient({ transport: http(env.PAY_RPC) });
  const facilitator = new HTTPFacilitatorClient({ url: env.X402_FACILITATOR });
  const [
    sellerBalance,
    buyerBalance,
    chainId,
    tokenBalance,
    tokenName,
    tokenSymbol,
    tokenDecimals,
    tokenVersion,
    currentBlock,
    supported,
  ] = await Promise.all([
    demosBalanceOs(seller.adapter),
    demosBalanceOs(buyer.adapter),
    evm.getChainId(),
    evm.readContract({ address: asset, abi: erc20Abi, functionName: "balanceOf", args: [payer] }),
    evm.readContract({ address: asset, abi: tokenMetadataAbi, functionName: "name" }),
    evm.readContract({ address: asset, abi: tokenMetadataAbi, functionName: "symbol" }),
    evm.readContract({ address: asset, abi: tokenMetadataAbi, functionName: "decimals" }),
    evm.readContract({ address: asset, abi: tokenMetadataAbi, functionName: "version" }),
    evm.getBlockNumber(),
    facilitator.getSupported(),
  ]);
  const funding = fundedPreflightDecision({
    connectedChainId: chainId,
    sellerDemosBalance: sellerBalance,
    buyerDemosBalance: buyerBalance,
    paymentBalance: tokenBalance,
  });
  requireCondition(
    funding.disposition === "ready",
    funding.disposition === "rejected" ? funding.reason : "funding-preflight-failed",
  );
  requireCondition(tokenName === TOKEN_NAME, "token-domain-name-mismatch");
  requireCondition(tokenSymbol === TOKEN_SYMBOL, "token-symbol-mismatch");
  requireCondition(tokenDecimals === TOKEN_DECIMALS, "token-decimals-mismatch");
  requireCondition(tokenVersion === TOKEN_VERSION, "token-domain-version-mismatch");
  requireCondition(
    supported.kinds.some((kind) =>
      kind.x402Version === 2 && kind.scheme === "exact" &&
      kind.network === BASE_SEPOLIA_NETWORK
    ),
    "facilitator-network-unsupported",
  );
  requireCondition(currentBlock <= BigInt(Number.MAX_SAFE_INTEGER), "evm-height-unsupported");
  // Construct every remaining fallible read adapter before opening the local
  // listener, so a failed no-write preflight cannot leave a host behind.
  const evmReader = await createViemX402BuyerEvmReadClient({
    rpcUrl: env.PAY_RPC,
    chainId: BASE_SEPOLIA_CHAIN_ID,
    chainName: "Base Sepolia",
    finalityTag: "latest",
  });
  const jobId = generateCanonicalJobId({
    timestamp: Date.now(),
    entropy: Uint8Array.from(
      Buffer.from(sha256Hex(env.LIVE_E2E_RUN_ID), "hex").subarray(0, 10),
    ),
  });
  const listingId = `funded-${env.LIVE_E2E_RUN_ID}`;
  const listingPrefix = logicalToStorageProgramName(
    listingAddress(env.SELLER_DID, listingId, "v"),
  );
  const listingName = logicalToStorageProgramName(
    listingAddress(env.SELLER_DID, listingId, 1),
  );
  const listingScan = await seller.adapter.scanOwnAnchorsByNamePrefix(listingPrefix);
  requireCondition(listingScan.status === "ok", "run-id-listing-scan-indeterminate");
  requireCondition(
    !listingScan.anchors.some((anchor) => anchor.programName === listingName),
    "run-id-already-published",
  );
  const host = await startLocalPaywallHost(env.LIVE_E2E_RUN_ID, jobId);
  try {
    const resource = new URL(host.resourceUrl);
    const engagement = new URL(host.engagementUrl);
    requireCondition(resource.hostname === "127.0.0.1", "resource-not-loopback");
    requireCondition(resource.protocol === "https:" && !resource.hash, "resource-config-invalid");
    requireCondition(
      engagement.protocol === "https:" && engagement.hostname === "127.0.0.1" &&
      !engagement.username && !engagement.password && !engagement.hash,
      "engagement-config-invalid",
    );
    const tlsProbe = await host.fetchImpl(host.resourceUrl, {
      method: "GET",
      redirect: "error",
    });
    await tlsProbe.arrayBuffer();
    requireCondition(tlsProbe.status === 503, "local-tls-preflight-failed");
    return {
      env,
      jobId,
      seller,
      buyer,
      evm,
      evmReader,
      payer,
      payee,
      asset,
      authorizationSearchFromBlock: Number(currentBlock),
      host,
      facilitator,
    };
  } catch {
    await host.close();
    throw new Error("funded-e2e:local-host-preflight-failed");
  }
}

async function identity(
  primaryClaim: string,
  signer: DemosBackedAdapter,
  now = Date.now(),
  evmPrivateKey?: string,
): Promise<IdentityBundle> {
  const evmAccount = evmPrivateKey === undefined
    ? undefined
    : privateKeyToAccount(evmPrivateKey as `0x${string}`);
  const claims = [
    { ref: primaryClaim },
    ...(evmAccount === undefined
      ? []
      : [{ ref: `cci-xm:evm:base-sepolia:${getAddress(evmAccount.address)}` }]),
  ];
  const bundle: IdentityBundle = {
    bundleVersion: "1",
    presentedBy: primaryClaim,
    presentedAt: now,
    sessionNonce: sha256Hex(`${primaryClaim}:${now}`),
    claims,
    presentation: {
      kind: "per-claim",
      signatures: claims.map(({ ref }) => ({ ref, signature: "pending" })),
    },
  };
  requireCondition(bundle.presentation.kind === "per-claim", "identity-presentation-shape-invalid");
  const bytes = signedBytes(
    "dacs-bundle-presentation:v1:",
    identityBundleHash(bundle),
  );
  const primarySignature = await signer.sign(bytes);
  bundle.presentation.signatures[0]!.signature =
    Buffer.from(primarySignature).toString("base64url");
  if (evmAccount !== undefined) {
    bundle.presentation.signatures[1]!.signature = await evmAccount.signMessage({
      message: { raw: bytes },
    });
  }
  return bundle;
}

async function verifyFundedIdentityPresentation(input: {
  bundle: Readonly<IdentityBundle>;
  expectedPrimaryClaim: string;
  primaryPublicKey: Uint8Array;
  evmAddress?: `0x${string}`;
}): Promise<boolean> {
  try {
    const { bundle } = input;
    if (bundle.presentedBy !== input.expectedPrimaryClaim ||
        bundle.presentation.kind !== "per-claim" ||
        bundle.presentation.signatures.length !== bundle.claims.length) return false;
    const bytes = signedBytes(
      "dacs-bundle-presentation:v1:",
      identityBundleHash(bundle),
    );
    for (const [index, proof] of bundle.presentation.signatures.entries()) {
      const claim = bundle.claims[index]?.ref;
      if (proof.ref !== claim) return false;
      if (claim === input.expectedPrimaryClaim) {
        if (!ed25519Verify(
          bytes,
          Uint8Array.from(Buffer.from(proof.signature, "base64url")),
          publicKeyFromRaw(input.primaryPublicKey),
        )) return false;
        continue;
      }
      const expectedEvmClaim = input.evmAddress === undefined
        ? undefined
        : `cci-xm:evm:base-sepolia:${getAddress(input.evmAddress)}`;
      if (claim !== expectedEvmClaim || !await verifyMessage({
        address: input.evmAddress!,
        message: { raw: bytes },
        signature: proof.signature as `0x${string}`,
      })) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function rail(resourceUrl: string): PaymentRailRef {
  return {
    railId: "x402:base-sepolia",
    railVersion: 1,
    parameters: { network: BASE_SEPOLIA_NETWORK, httpResource: resourceUrl },
  };
}

function railAuthority(selectedRail: PaymentRailRef) {
  return {
    trustPhase: "PA-1" as const,
    trustPolicyAcceptsPA1: true,
    registry: { state: "not-used" as const, entries: [], definitions: [] },
    inCodeDefinitions: [{
      railId: selectedRail.railId,
      railVersion: selectedRail.railVersion!,
      phaseHandler: "pay-x402",
      governanceAnchoring: "in-code" as const,
      signatureValid: true,
    }],
  };
}

function listingValidationDeps(input: {
  sellerDid: string;
  sellerPublicKey: Uint8Array;
  selectedRail: PaymentRailRef;
  now: number;
}): ListingValidationDeps {
  return {
    nowMs: () => input.now,
    verifyListingSignature: ({ signedBytes: bytes, signature }) =>
      signature.signer === input.sellerDid && signature.algorithm === "ed25519" &&
      ed25519Verify(
        bytes,
        Uint8Array.from(Buffer.from(signature.value, "base64url")),
        publicKeyFromRaw(input.sellerPublicKey),
      ),
    revocation: {
      surfaces: [{ kind: "well-known", status: "active", integrity: "verified" }],
      readMarker: async () => null,
      verifyMarkerSignature: () => false,
    },
    verifyIdentityPresentation: ({ bundle, signedBytes: bytes }) => {
      if (bundle.presentedBy !== input.sellerDid ||
          bundle.presentation.kind !== "per-claim" ||
          bundle.presentation.signatures.length !== 1 ||
          bundle.presentation.signatures[0]?.ref !== input.sellerDid) return false;
      try {
        return ed25519Verify(
          bytes,
          Uint8Array.from(Buffer.from(bundle.presentation.signatures[0].signature, "base64url")),
          publicKeyFromRaw(input.sellerPublicKey),
        );
      } catch {
        return false;
      }
    },
    loadRailResolution: () => railAuthority(input.selectedRail),
    verifySellerControl: ({ bundle, signer }) =>
      signer === input.sellerDid && bundle.presentedBy === signer &&
      bundle.claims.some(({ ref }) => ref === signer),
  };
}

interface PublishedListing {
  listing: Listing;
  listingRef: string;
  listingPin: { listingId: string; version: number; contentHash: string };
  logicalAddress: string;
  receipt: AnchorReceipt;
}

function portableReceipt(input: {
  logicalAddress: string;
  nativeAddress: string;
  contentHash: string;
  writer: string;
  transactionRef: string;
  observedAt: number;
  blockNumber?: number;
}): AnchorReceipt {
  return {
    receiptVersion: "1",
    substrate: "demos",
    finalityProfile: "demos-bft-read-visible",
    logicalAddress: input.logicalAddress,
    nativeAddress: input.nativeAddress,
    contentHash: input.contentHash,
    transactionRef: { kind: "demos-storage-program", value: input.transactionRef },
    writer: input.writer,
    state: "finalized",
    observationDisposition: "established",
    observedAt: input.observedAt,
    blockRef: {
      id: input.transactionRef,
      ...(input.blockNumber === undefined ? {} : { height: String(input.blockNumber) }),
      timestamp: input.observedAt,
    },
    evidence: { kind: "demos-owner-bound-readback", value: input.contentHash },
  };
}

async function anchorArtifact(input: {
  adapter: DemosBackedAdapter;
  writer: string;
  logicalAddress: string;
  artifact: Record<string, unknown>;
  refSigner?: string;
}): Promise<{ ref: AttestationRef; receipt: AnchorReceipt }> {
  const hash = isFaultAttestationBundle(input.artifact)
    ? attestationBundleHash(input.artifact)
    : contentHash(input.artifact);
  const anchored = await input.adapter.anchorWriteOnce(
    input.logicalAddress,
    structuredClone(input.artifact),
    {
      metadata: {
        logicalAddress: input.logicalAddress,
        contentHash: hash,
        // `contentHash` intentionally excludes signature envelopes. Retain the
        // exact JCS envelope as immutable metadata too, so write-once replay
        // cannot accept a different signature over the same signed scope.
        envelopeHash: sha256Hex(canonicalize(input.artifact)),
      },
    },
  );
  requireCondition(typeof anchored.txRef === "string" && anchored.txRef.length > 0, "anchor-tx-missing");
  const resolution = await input.adapter.resolveAnchorByName(
    input.logicalAddress,
    input.adapter.getAddress(),
  );
  requireCondition(
    resolution.status === "present" && resolution.address === anchored.address,
    "anchor-owner-bound-resolution-mismatch",
  );
  const readback = await input.adapter.readAnchor(anchored.address);
  const readbackHash = readback !== null && isFaultAttestationBundle(readback)
    ? attestationBundleHash(readback)
    : readback === null ? null : contentHash(readback);
  requireCondition(
    readbackHash === hash && canonicalize(readback) === canonicalize(input.artifact),
    "anchor-readback-mismatch",
  );
  const receipt = portableReceipt({
    logicalAddress: input.logicalAddress,
    nativeAddress: anchored.address,
    contentHash: hash,
    writer: input.writer,
    transactionRef: anchored.txRef,
    observedAt: Date.now(),
    ...(anchored.blockNumber === undefined ? {} : { blockNumber: anchored.blockNumber }),
  });
  return {
    ref: {
      anchor: { kind: "storage-program", locator: input.logicalAddress },
      contentHash: hash,
      signer: input.refSigner ?? input.writer,
    },
    receipt,
  };
}

async function verifyAnchorReceipt(
  adapter: DemosBackedAdapter,
  receipt: Readonly<AnchorReceipt>,
  expectedWriter: string,
): Promise<boolean> {
  if (receipt.writer !== expectedWriter || receipt.state !== "finalized" ||
      receipt.observationDisposition !== "established") return false;
  const readback = await adapter.readAnchor(receipt.nativeAddress);
  if (!readback) return false;
  const readbackHash = isFaultAttestationBundle(readback)
    ? attestationBundleHash(readback)
    : contentHash(readback);
  if (readbackHash !== receipt.contentHash) return false;
  const resolution = await adapter.resolveAnchorByName(
    receipt.logicalAddress,
    expectedWriter.replace(/^did:demos:agent:/, ""),
  );
  return resolution.status === "present" && resolution.address === receipt.nativeAddress;
}

async function publishAndDiscoverListing(input: {
  preflight: Preflight;
  jobId: string;
  sellerIdentity: IdentityBundle;
  selectedRail: PaymentRailRef;
  now: number;
}): Promise<PublishedListing> {
  const { preflight, sellerIdentity, selectedRail, now } = input;
  const draft: ListingDraft = {
    dacsVersion: "1",
    listingVersion: 1,
    listingId: `funded-${preflight.env.LIVE_E2E_RUN_ID}`,
    seller: {
      identity: structuredClone(sellerIdentity),
      displayName: "DACS funded E2E seller",
      publicEndpoint: preflight.host.engagementUrl,
    },
    offering: {
      title: "Funded restart-safe result",
      description: "Issue 114 funded two-agent proof",
      category: "sdk.integration",
      tags: ["issue-114", "funded"],
      deliverable: { kind: "storage-program", accessModel: "public" },
    },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [
      { kind: "negotiate-fixed-price" },
      { kind: "commit-payee-bound-agreement" },
      { kind: "pay-x402", parameters: { rail: selectedRail.railId } },
      { kind: "deliver-storage-program" },
    ],
    pricing: { kind: "fixed", price: { amount: "0.000001", currency: TOKEN_SYMBOL } },
    acceptedRails: [structuredClone(selectedRail)],
    terms: { deadlineSecAfterCommit: 3_600 },
    validity: { notBefore: now - 60_000, notAfter: now + 3_600_000 },
  };
  const published = await preflight.seller.publishListing(draft);
  requireCondition(published.status === "published" || published.status === "already-published", "listing-publication-failed");
  const sellerPublicKey = await preflight.seller.adapter.getPublicKey();
  const validation = listingValidationDeps({
    sellerDid: preflight.env.SELLER_DID,
    sellerPublicKey,
    selectedRail,
    now,
  });
  const discovered = await discoverListings(
    [published.ref],
    (ref) => preflight.buyer.adapter.readAnchor(ref),
    {
      verify: (bytes, signature, publicKey) =>
        ed25519Verify(bytes, signature, publicKeyFromRaw(publicKey)),
      resolvePublicKey: (claim) => claim === preflight.env.SELLER_DID
        ? sellerPublicKey
        : null,
      validateListing: (raw) => validateListingArtifact(raw, validation),
      nowMs: () => now,
    },
  );
  requireCondition(discovered.length === 1, "listing-discovery-failed");
  const selected = discovered[0]!;
  requireCondition(selected.compatibility === "normative", "listing-not-normative");
  const listing = selected.listing;
  const pin = published.listingPin;
  requireCondition(
    pin.listingId === listing.listingId && pin.version === listing.listingVersion &&
    pin.contentHash === contentHash(listing as unknown as Record<string, unknown>),
    "listing-pin-mismatch",
  );
  const anchor = published.publication.anchor;
  requireCondition(typeof anchor.txRef === "string" && anchor.txRef.length > 0, "listing-anchor-tx-missing");
  const listingResolution = await preflight.buyer.adapter.resolveAnchorByName(
    published.logicalAddress,
    preflight.seller.adapter.getAddress(),
  );
  const listingReadback = listingResolution.status === "present"
    ? await preflight.buyer.adapter.readAnchor(listingResolution.address)
    : null;
  requireCondition(
    listingResolution.status === "present" &&
    listingResolution.address === published.ref && listingReadback !== null &&
    canonicalize(listingReadback) === canonicalize(listing),
    "listing-owner-bound-readback-mismatch",
  );
  return {
    listing,
    listingRef: published.ref,
    listingPin: pin,
    logicalAddress: published.logicalAddress,
    receipt: portableReceipt({
      logicalAddress: published.logicalAddress,
      nativeAddress: published.ref,
      contentHash: pin.contentHash,
      writer: preflight.env.SELLER_DID,
      transactionRef: anchor.txRef,
      observedAt: now,
      ...(anchor.blockNumber === undefined ? {} : { blockNumber: anchor.blockNumber }),
    }),
  };
}

const EMPTY_REQUIREMENT = { requirementVersion: "1" as const, required: [] };
const EXTERNAL_VET_PROVENANCE_SEPARATOR = "DACS-funded-e2e:external-vet-provenance:v1";

interface ExternalVetProvenance {
  provenanceVersion: "dacs-sdk-funded-e2e-1";
  profile: "issue-114-local-operational-v1";
  normative: false;
  standardsGap: "DACS-Standard#331";
  jobId: string;
  evaluatedParty: string;
  verifier: string;
  requirementHash: string;
  vetRecordHash: string;
  signature: {
    algorithm: "ed25519";
    signer: string;
    value: string;
  };
}

async function signedVetRecord(input: {
  jobId: string;
  evaluatedParty: string;
  bundle: IdentityBundle;
  verifier: string;
  signer: DemosBackedAdapter;
  generatedAt: number;
}): Promise<CompositeVerificationRecord> {
  const unsigned = {
    recordVersion: "1" as const,
    jobId: input.jobId,
    evaluatedParty: input.evaluatedParty,
    bundleHash: identityBundleHash(input.bundle),
    requirementHash: sha256Hex(canonicalize(EMPTY_REQUIREMENT)),
    freshness: [],
    supplementary: [],
    dealSpecific: [],
    overallDecision: "pass" as const,
    generatedAt: input.generatedAt,
  };
  const signature = await input.signer.sign(signedBytes(
    ARTIFACT_SEPARATORS.CompositeVerificationRecord,
    contentHash(unsigned),
  ));
  return {
    ...unsigned,
    signature: {
      algorithm: "ed25519",
      signer: input.verifier,
      value: Buffer.from(signature).toString("base64url"),
    },
  };
}

interface VetArtifacts {
  buyer: CompositeVerificationRecord;
  seller: CompositeVerificationRecord;
  buyerRef: AttestationRef;
  sellerRef: AttestationRef;
  buyerReceipt: AnchorReceipt;
  sellerReceipt: AnchorReceipt;
  externalSellerProvenance: ExternalVetProvenance;
  externalSellerProvenanceRef: AttestationRef;
  externalSellerProvenanceReceipt: AnchorReceipt;
}

async function publishVetRecords(input: {
  preflight: Preflight;
  jobId: string;
  buyerIdentity: IdentityBundle;
  sellerIdentity: IdentityBundle;
  now: number;
}): Promise<VetArtifacts> {
  const [buyerRecord, sellerRecord] = await Promise.all([
    signedVetRecord({
      jobId: input.jobId,
      evaluatedParty: input.preflight.env.BUYER_DID,
      bundle: input.buyerIdentity,
      verifier: input.preflight.env.SELLER_DID,
      signer: input.preflight.seller.adapter,
      generatedAt: input.now,
    }),
    signedVetRecord({
      jobId: input.jobId,
      evaluatedParty: input.preflight.env.SELLER_DID,
      bundle: input.sellerIdentity,
      verifier: input.preflight.env.SELLER_DID,
      signer: input.preflight.seller.adapter,
      generatedAt: input.now,
    }),
  ]);
  const [buyerAnchor, sellerAnchor] = await Promise.all([
    anchorArtifact({
      adapter: input.preflight.seller.adapter,
      writer: input.preflight.env.SELLER_DID,
      logicalAddress: `dacs2:vet:${input.jobId}:buyer`,
      artifact: buyerRecord as unknown as Record<string, unknown>,
    }),
    anchorArtifact({
      adapter: input.preflight.buyer.adapter,
      writer: input.preflight.env.BUYER_DID,
      refSigner: input.preflight.env.SELLER_DID,
      logicalAddress: `dacs2:vet:${input.jobId}:seller`,
      artifact: sellerRecord as unknown as Record<string, unknown>,
    }),
  ]);
  // DACS Standard #331 has not yet defined authenticated provenance for a
  // complementary VPC requirement. This is an explicit, external, fail-closed
  // policy seam for the funded test only; it is not represented as normative
  // #331 provenance.
  const unsignedProvenance = {
    provenanceVersion: "dacs-sdk-funded-e2e-1" as const,
    profile: "issue-114-local-operational-v1" as const,
    normative: false as const,
    standardsGap: "DACS-Standard#331" as const,
    jobId: input.jobId,
    evaluatedParty: input.preflight.env.SELLER_DID,
    verifier: input.preflight.env.SELLER_DID,
    requirementHash: sha256Hex(canonicalize(EMPTY_REQUIREMENT)),
    vetRecordHash: sellerAnchor.ref.contentHash,
  };
  const provenanceSignature = await input.preflight.buyer.adapter.sign(signedBytes(
    EXTERNAL_VET_PROVENANCE_SEPARATOR,
    contentHash(unsignedProvenance),
  ));
  const externalSellerProvenance: ExternalVetProvenance = {
    ...unsignedProvenance,
    signature: {
      algorithm: "ed25519",
      signer: input.preflight.env.BUYER_DID,
      value: Buffer.from(provenanceSignature).toString("base64url"),
    },
  };
  const externalSellerProvenanceAnchor = await anchorArtifact({
    adapter: input.preflight.buyer.adapter,
    writer: input.preflight.env.BUYER_DID,
    logicalAddress: `dacs-test:vet-provenance:${input.jobId}`,
    artifact: externalSellerProvenance as unknown as Record<string, unknown>,
  });
  return {
    buyer: buyerRecord,
    seller: sellerRecord,
    buyerRef: buyerAnchor.ref,
    sellerRef: sellerAnchor.ref,
    buyerReceipt: buyerAnchor.receipt,
    sellerReceipt: sellerAnchor.receipt,
    externalSellerProvenance,
    externalSellerProvenanceRef: externalSellerProvenanceAnchor.ref,
    externalSellerProvenanceReceipt: externalSellerProvenanceAnchor.receipt,
  };
}

interface AgreementRun {
  agreement: AgreementArtifact;
  agreementHash: string;
  agreementRef: AttestationRef;
  anchorReceipt: AnchorReceipt;
}

async function negotiateAgreement(input: {
  preflight: Preflight;
  jobId: string;
  published: PublishedListing;
  selectedRail: PaymentRailRef;
  buyerIdentity: IdentityBundle;
  sellerIdentity: IdentityBundle;
  vet: VetArtifacts;
  now: number;
  buyerDir: string;
  sellerDir: string;
}): Promise<AgreementRun> {
  const { preflight, jobId, published, selectedRail, buyerIdentity, sellerIdentity, vet, now } = input;
  const context = {
    jobId,
    verifiedListing: {
      disposition: "verified" as const,
      listing: published.listing,
      pin: published.listingPin,
    },
    buyer: { identityBundle: buyerIdentity, vetRecordRef: vet.buyerRef },
    seller: { identityBundle: sellerIdentity, vetRecordRef: vet.sellerRef },
    selectedRail,
    payoutBindings: [{
      railId: selectedRail.railId,
      phaseIndex: PAYMENT_PHASE_INDEX,
      payeeAddress: preflight.payee,
    }],
    generatedAt: now,
  };
  const draft = deriveFixedPriceAgreement(context);
  const plan = createFixedPriceAgreementSigningPlan(draft);
  const publicKeys = new Map<string, Uint8Array>([
    [preflight.env.BUYER_DID, await preflight.buyer.adapter.getPublicKey()],
    [preflight.env.SELLER_DID, await preflight.seller.adapter.getPublicKey()],
  ]);
  const verifyContribution = ({
    role,
    algorithm,
    value,
    signedBytes: bytes,
  }: {
    role: "buyer" | "seller";
    algorithm: string;
    value: string;
    signedBytes: Uint8Array;
  }): "valid" | "invalid" => {
    const party = role === "buyer" ? preflight.env.BUYER_DID : preflight.env.SELLER_DID;
    const key = publicKeys.get(party);
    return algorithm === "ed25519" && key && ed25519Verify(
      bytes,
      Uint8Array.from(Buffer.from(value, "base64url")),
      publicKeyFromRaw(key),
    ) ? "valid" : "invalid";
  };
  let buyerSignature: Uint8Array | undefined;
  let sellerSignature: Uint8Array | undefined;
  let proposal: FixedPriceAgreementProposal | undefined;
  let contribution: FixedPriceAgreementSignatureContribution | undefined;
  let anchored: { artifact: Record<string, unknown>; ref: AttestationRef; anchorReceipt: AnchorReceipt } | undefined;
  let binding: AnchorBinding | undefined;
  const sellerDurability: DurableSellerFixedPriceAgreementDurability = {
    store: await createFsFencedSessionStore({ dir: input.sellerDir }),
    workerId: "funded-seller-agreement",
    leaseTtlMs: LEASE_DURATION_MS,
    leaseNowMs: Date.now,
    resolveAuthenticatedAgreementContext: () => ({ disposition: "present", value: structuredClone(context) }),
    verifyContribution,
    reconcileSellerSignature: () => sellerSignature
      ? { disposition: "present", value: Uint8Array.from(sellerSignature) }
      : { disposition: "absent", reason: "seller-signature-absent" },
    transport: {
      publishSellerContribution: (value) => {
        contribution = structuredClone(value);
        return { disposition: "submitted" as const };
      },
      reconcileSellerContributionPublication: () => contribution
        ? { disposition: "present", value: structuredClone(contribution) }
        : { disposition: "absent", reason: "seller-contribution-absent" },
    },
  };
  const durableInput: DurableFixedPriceAgreementInput = {
    draft,
    buyer: {
      party: preflight.env.BUYER_DID,
      algorithm: "ed25519",
      sign: async (bytes) => {
        buyerSignature = await preflight.buyer.adapter.sign(bytes);
        return Uint8Array.from(buyerSignature);
      },
    },
  };
  preflight.host.installEngagement(async (rawProposal, rawIdentity) =>
    respondToFixedPriceAgreementProposalDurable({
      proposal: rawProposal as FixedPriceAgreementProposal,
      transportIdentity: rawIdentity as FixedPriceAgreementTransportIdentity,
      seller: {
        party: preflight.env.SELLER_DID,
        algorithm: "ed25519",
        sign: async (bytes) => {
          sellerSignature = await preflight.seller.adapter.sign(bytes);
          return Uint8Array.from(sellerSignature);
        },
      },
    }, sellerDurability)
  );
  const buyerDurability: DurableFixedPriceAgreementDurability = {
    store: await createFsFencedSessionStore({ dir: input.buyerDir }),
    workerId: "funded-buyer-agreement",
    leaseTtlMs: LEASE_DURATION_MS,
    leaseNowMs: Date.now,
    reconcileBuyerSignature: () => buyerSignature
      ? { disposition: "present", value: Uint8Array.from(buyerSignature) }
      : { disposition: "absent", reason: "buyer-signature-absent" },
    verifyContribution,
    transport: {
      publishProposal: async (value, identity) => {
        proposal = structuredClone(value);
        requireCondition(
          published.listing.seller.publicEndpoint === preflight.host.engagementUrl,
          "advertised-engagement-endpoint-mismatch",
        );
        const transportResponse = await preflight.host.fetchImpl(
          published.listing.seller.publicEndpoint,
          {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ proposal: value, identity }),
          redirect: "error",
          },
        );
        requireCondition(transportResponse.status === 200, "seller-engagement-http-failed");
        const response = await transportResponse.json() as Awaited<
          ReturnType<typeof respondToFixedPriceAgreementProposalDurable>
        >;
        requireCondition(response.disposition === "complete", "seller-agreement-incomplete");
        contribution = structuredClone(response.result.sellerContribution);
        return { disposition: "submitted" };
      },
      reconcileProposalPublication: () => proposal
        ? { disposition: "present", value: structuredClone(proposal) }
        : { disposition: "absent", reason: "proposal-absent" },
      resolveSellerContributions: () => contribution
        ? { disposition: "present", value: [structuredClone(contribution)] }
        : { disposition: "absent", reason: "contribution-absent" },
    },
    anchor: {
      anchorAgreement: async (value) => {
        const live = await anchorArtifact({
          adapter: preflight.buyer.adapter,
          writer: preflight.env.BUYER_DID,
          logicalAddress: value.logicalAddress,
          artifact: value.artifact,
        });
        anchored = {
          artifact: structuredClone(value.artifact),
          ref: live.ref,
          anchorReceipt: live.receipt,
        };
        return { disposition: "submitted" };
      },
      reconcileAgreementAnchor: () => anchored
        ? { disposition: "present", value: structuredClone(anchored) }
        : { disposition: "absent", reason: "agreement-anchor-absent" },
      verifyAnchorReceipt: ({ receipt }) => verifyAnchorReceipt(
        preflight.buyer.adapter,
        receipt,
        preflight.env.BUYER_DID,
      ).then((valid) => valid ? "valid" as const : "invalid" as const),
      publishBinding: (value) => {
        binding = structuredClone(value);
        return { disposition: "submitted" as const };
      },
      reconcileBindingPublication: () => binding
        ? { disposition: "present", value: structuredClone(binding) }
        : { disposition: "absent", reason: "agreement-binding-absent" },
    },
  };
  const result = await advanceFixedPriceAgreementDurable(durableInput, buyerDurability);
  requireCondition(result.disposition === "anchored", "agreement-not-anchored");
  // A fresh process-store instance must recover the exact terminal agreement.
  buyerDurability.store = await createFsFencedSessionStore({ dir: input.buyerDir });
  sellerDurability.store = await createFsFencedSessionStore({ dir: input.sellerDir });
  const recovered = await advanceFixedPriceAgreementDurable(durableInput, buyerDurability);
  requireCondition(recovered.disposition === "anchored" && recovered.recovered, "agreement-recovery-failed");
  requireCondition(proposal !== undefined, "agreement-proposal-missing");
  const transportIdentity: FixedPriceAgreementTransportIdentity = {
    jobId: draft.jobId,
    planHash: plan.planHash,
    agreementHash: plan.agreementHash,
    buyer: preflight.env.BUYER_DID,
    seller: preflight.env.SELLER_DID,
    proposalHash: proposal.proposalHash,
  };
  const sellerRecovered = await respondToFixedPriceAgreementProposalDurable({
    proposal,
    transportIdentity,
    seller: {
      party: preflight.env.SELLER_DID,
      algorithm: "ed25519",
      sign: () => { throw new Error("duplicate-seller-sign"); },
    },
  }, sellerDurability);
  requireCondition(sellerRecovered.disposition === "complete" && sellerRecovered.recovered, "seller-agreement-recovery-failed");
  return {
    agreement: result.result.agreement,
    agreementHash: result.result.agreementHash,
    agreementRef: result.result.agreementRef,
    anchorReceipt: result.result.anchorReceipt,
  };
}

async function commitAgreement(input: {
  preflight: Preflight;
  jobId: string;
  published: PublishedListing;
  agreement: AgreementRun;
  vet: VetArtifacts;
  now: number;
}) {
  let retained: AnchoredFinalityCommitment | undefined;
  const provider: FinalityCommitmentProvider = {
    resolve: async () => {
      if (retained) return { disposition: "present", anchored: structuredClone(retained) };
      const logical = finalityCommitmentAddress(input.jobId);
      const resolved = await input.preflight.seller.adapter.resolveAnchorByName(
        logical,
        input.preflight.seller.adapter.getAddress(),
      );
      if (resolved.status === "indeterminate") return { disposition: "indeterminate", reason: "commitment-resolution-indeterminate" };
      if (resolved.status === "absent") return { disposition: "absent" };
      return { disposition: "indeterminate", reason: "unexpected-preexisting-commitment" };
    },
    submit: async (logicalAddress, record) => {
      const live = await anchorArtifact({
        adapter: input.preflight.seller.adapter,
        writer: input.preflight.env.SELLER_DID,
        logicalAddress,
        artifact: record as unknown as Record<string, unknown>,
      });
      retained = {
        record,
        nativeAddress: live.receipt.nativeAddress,
        anchorTxRef: {
          kind: "storage-program",
          address: live.receipt.nativeAddress,
          writeTxHash: live.receipt.transactionRef.value,
        },
        anchorReceipt: live.receipt,
      };
      return structuredClone(retained);
    },
    verifyAnchorReceipt: (anchored) => verifyAnchorReceipt(
      input.preflight.seller.adapter,
      anchored.anchorReceipt,
      input.preflight.env.SELLER_DID,
    ).then((valid) => valid ? "valid" as const : "invalid" as const),
  };
  const publicKeys = new Map<string, Uint8Array>([
    [input.preflight.env.BUYER_DID, await input.preflight.buyer.adapter.getPublicKey()],
    [input.preflight.env.SELLER_DID, await input.preflight.seller.adapter.getPublicKey()],
  ]);
  const verify: CommitmentSignatureVerifier = (request) => {
    const key = publicKeys.get(request.signer);
    return key && request.algorithm === "ed25519" && ed25519Verify(
      request.signedBytes,
      Uint8Array.from(Buffer.from(request.value, "base64url")),
      publicKeyFromRaw(key),
    ) ? "valid" : "invalid";
  };
  const committed = await commitFixedPriceAgreement({
    agreement: structuredClone(input.agreement.agreement),
    verifiedListing: {
      disposition: "verified",
      listing: structuredClone(input.published.listing),
      pin: structuredClone(input.published.listingPin),
    },
    session: {
      jobId: input.jobId,
      listingRef: structuredClone(input.published.listingPin),
      phaseKind: "commit-payee-bound-agreement",
      orchestrator: input.preflight.env.SELLER_DID,
      buyer: {
        primaryClaim: input.preflight.env.BUYER_DID,
        bundleHash: input.vet.buyer.bundleHash,
        vetRecordRef: structuredClone(input.vet.buyerRef),
      },
      seller: {
        primaryClaim: input.preflight.env.SELLER_DID,
        bundleHash: input.vet.seller.bundleHash,
        vetRecordRef: structuredClone(input.vet.sellerRef),
      },
    },
    createdAt: input.now,
    commitmentSigner: {
      algorithm: "ed25519",
      signer: input.preflight.env.SELLER_DID,
      sign: (bytes) => input.preflight.seller.adapter.sign(bytes),
    },
  }, provider, verify);
  const resumed = await commitFixedPriceAgreement({
    agreement: structuredClone(input.agreement.agreement),
    verifiedListing: {
      disposition: "verified",
      listing: structuredClone(input.published.listing),
      pin: structuredClone(input.published.listingPin),
    },
    session: {
      jobId: input.jobId,
      listingRef: structuredClone(input.published.listingPin),
      phaseKind: "commit-payee-bound-agreement",
      orchestrator: input.preflight.env.SELLER_DID,
      buyer: {
        primaryClaim: input.preflight.env.BUYER_DID,
        bundleHash: input.vet.buyer.bundleHash,
        vetRecordRef: structuredClone(input.vet.buyerRef),
      },
      seller: {
        primaryClaim: input.preflight.env.SELLER_DID,
        bundleHash: input.vet.seller.bundleHash,
        vetRecordRef: structuredClone(input.vet.sellerRef),
      },
    },
    createdAt: input.now,
    commitmentSigner: {
      algorithm: "ed25519",
      signer: input.preflight.env.SELLER_DID,
      sign: () => { throw new Error("duplicate-commitment-sign"); },
    },
  }, provider, verify);
  requireCondition(!committed.resumed && resumed.resumed, "commitment-recovery-failed");
  const readback = await input.preflight.buyer.adapter.readAnchor(committed.nativeAddress);
  requireCondition(
    readback !== null && contentHash(readback) === contentHash(committed.record as unknown as Record<string, unknown>),
    "commitment-not-readable",
  );
  return committed;
}

function addressTopic(address: string): string {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

function asSafeNumber(value: bigint, code: string): number {
  requireCondition(value <= BigInt(Number.MAX_SAFE_INTEGER), code);
  return Number(value);
}

async function observeFundedTransfer(input: {
  preflight: Preflight;
  jobId: string;
  txHash: string;
}): Promise<X402TransferObservation> {
  requireCondition(/^0x[0-9a-fA-F]{64}$/.test(input.txHash), "settlement-tx-invalid");
  const transactionHash = input.txHash as `0x${string}`;
  // The facilitator returns only after broadcast/inclusion. Poll a bounded
  // latest-head window so the seller never promotes a pending transfer.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const [receipt, head] = await Promise.all([
        input.preflight.evm.getTransactionReceipt({ hash: transactionHash }),
        input.preflight.evm.getBlockNumber(),
      ]);
      if (receipt.status !== "success") return { status: "failed", reason: "transaction-reverted" };
      const confirmations = head >= receipt.blockNumber
        ? head - receipt.blockNumber + 1n
        : 0n;
      if (confirmations < 1n) continue;
      const payerTopic = addressTopic(input.preflight.payer);
      const payeeTopic = addressTopic(input.preflight.payee);
      const nonce = x402Eip3009Nonce(input.jobId, PAYMENT_PHASE_INDEX).toLowerCase();
      const used = receipt.logs.filter((log) =>
        log.address.toLowerCase() === input.preflight.asset.toLowerCase() &&
        log.topics.length === 3 &&
        log.topics[0]?.toLowerCase() === EIP3009_AUTHORIZATION_USED_TOPIC &&
        log.topics[1]?.toLowerCase() === payerTopic &&
        log.topics[2]?.toLowerCase() === nonce
      );
      const transfers = receipt.logs.filter((log) =>
        log.address.toLowerCase() === input.preflight.asset.toLowerCase() &&
        log.topics.length === 3 &&
        log.topics[0]?.toLowerCase() === ERC20_TRANSFER_TOPIC &&
        log.topics[1]?.toLowerCase() === payerTopic &&
        log.topics[2]?.toLowerCase() === payeeTopic &&
        BigInt(log.data) === PAYMENT_AMOUNT
      );
      requireCondition(used.length === 1 && transfers.length === 1, "settlement-events-mismatch");
      const block = await input.preflight.evm.getBlock({ blockHash: receipt.blockHash });
      const includedAt = asSafeNumber(block.timestamp * 1_000n, "settlement-time-unsupported");
      return {
        status: "finalized",
        chainId: BASE_SEPOLIA_CHAIN_ID,
        txHash: transactionHash,
        logIndex: transfers[0]!.logIndex,
        payer: input.preflight.payer,
        payee: input.preflight.payee,
        amountBaseUnits: PAYMENT_AMOUNT.toString(),
        asset: {
          contract: input.preflight.asset,
          symbol: TOKEN_SYMBOL,
          decimals: TOKEN_DECIMALS,
        },
        confirmations: asSafeNumber(confirmations, "settlement-confirmations-unsupported"),
        includedAt,
        finalityObservedAt: Date.now(),
        sessionBinding: { kind: "eip3009", nonce },
      };
    } catch {
      // A just-mined transaction may not be visible on every RPC backend yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return { status: "unavailable", reason: "settlement-finality-timeout" };
}

function sameFinalizedTransfer(
  left: Extract<X402TransferObservation, { status: "finalized" }>,
  right: Extract<X402TransferObservation, { status: "finalized" }>,
): boolean {
  const {
    confirmations: _leftConfirmations,
    finalityObservedAt: _leftObservedAt,
    ...leftImmutable
  } = left;
  const {
    confirmations: _rightConfirmations,
    finalityObservedAt: _rightObservedAt,
    ...rightImmutable
  } = right;
  return left.confirmations >= 1 && right.confirmations >= 1 &&
    canonicalize(leftImmutable) === canonicalize(rightImmutable);
}

interface CommerceCounts {
  facilitatorVerify: number;
  facilitatorSettle: number;
  applicationCallback: number;
  delivery: number;
  evidence: number;
  finalReceipt: number;
  render: number;
}

interface CommerceState {
  loseResponseAcknowledgement: boolean;
  facilitatorVerifyOutcome?: "valid" | "invalid" | "threw";
  facilitatorOutcome?: "success" | "failure" | "threw";
  preSettlementOutcome?: "authorized" | "rejected" | "indeterminate";
  permit?: X402SellerPaymentPermitAuthorization;
  observedTransfer?: Extract<X402TransferObservation, { status: "finalized" }>;
  delivered?: Awaited<ReturnType<DurableSellerFulfilmentDeps["submitDelivery"]>>;
  deliveryPublication?: { artifact: SellerDeliveredArtifact; receipt: AnchorReceipt };
  anchoredEvidence?: SignedSellerDeliveryEvidence;
  evidencePublication?: Awaited<ReturnType<DurableSellerFulfilmentDeps["anchorEvidence"]>>;
  finalReceipt?: SellerFinalSessionReceiptResult;
  fulfilment?: Extract<SellerFulfilmentResult, { decision: "completed" }>;
  settlementResult?: X402PaywallSettlementResult & { success: true };
  counts: CommerceCounts;
}

function legacyFacilitatorRequirements(
  requirements: X402BuyerPaymentRequirements,
): X402BuyerPaymentRequirements {
  requireCondition(
    requirements.extra.assetTransferMethod === "eip3009",
    "facilitator-requirements-not-eip3009",
  );
  const { assetTransferMethod: _method, ...extra } = requirements.extra;
  return structuredClone({ ...requirements, extra });
}

function commerceState(): CommerceState {
  return {
    loseResponseAcknowledgement: true,
    counts: {
      facilitatorVerify: 0,
      facilitatorSettle: 0,
      applicationCallback: 0,
      delivery: 0,
      evidence: 0,
      finalReceipt: 0,
      render: 0,
    },
  };
}

async function retainSuccessfulFacilitatorSettlement<
  T extends Awaited<ReturnType<HTTPFacilitatorClient["settle"]>>,
>(
  state: CommerceState,
  store: Pick<X402PaywallSettlementStore, "load" | "recordOutcome">,
  settlementKey: string,
  result: T,
  requirements: X402BuyerPaymentRequirements,
  expectedPayer: string,
): Promise<T> {
  if (result.success) {
    const receipt = structuredClone(result);
    // Recreate exactly the HTTP resource server's successful local envelope.
    // The remote facilitator returns only the receipt; the local server owns
    // PAYMENT-RESPONSE and the matched requirements fields.
    const settlement = {
      ...receipt,
      success: true as const,
      headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader(receipt) },
      requirements: structuredClone(requirements),
    } as X402PaywallSettlementResult & { success: true };
    const commitment = deriveX402ReceiptCommitment({
      protocolVersion: "2",
      responseHeader: {
        name: "PAYMENT-RESPONSE",
        value: settlement.headers["PAYMENT-RESPONSE"]!,
      },
    });
    requireCondition(
      commitment.disposition === "pass" &&
        settlement.network === requirements.network &&
        settlement.payer?.toLowerCase() === expectedPayer.toLowerCase() &&
        (settlement.amount === undefined || settlement.amount === requirements.amount),
      "settlement-handoff-receipt-invalid",
    );
    const outcome = { status: "settled" as const, settlement };
    const retained = await store.load(settlementKey);
    requireCondition(retained.status === "held", "settlement-handoff-intent-not-held");
    let terminal;
    try {
      terminal = await store.recordOutcome({
        settlementKey,
        bindingHash: retained.intent.bindingHash,
        outcome,
      });
    } catch {
      // A failed acknowledgement cannot erase a committed WAL write.
      terminal = await store.load(settlementKey);
    }
    requireCondition(
      terminal.status === "settled" &&
        canonicalize(terminal.outcome) === canonicalize(outcome),
      "settlement-handoff-not-durable",
    );
    state.settlementResult = structuredClone(settlement);
  }
  return result;
}

interface SellerDirectories {
  settlement: string;
  receipt: string;
  fulfilment: string;
}

interface SellerRuntime {
  paywall: X402Paywall<{ delivered: true }>;
  receiptStore: Awaited<ReturnType<typeof createFsSellerReceiptStore>>;
  fulfilmentStore: Awaited<ReturnType<typeof createFsFencedSessionStore>>;
}

async function createSellerRuntime(input: {
  preflight: Preflight;
  jobId: string;
  published: PublishedListing;
  agreement: AgreementRun;
  commitment: Awaited<ReturnType<typeof commitAgreement>>;
  selectedRail: PaymentRailRef;
  buyerIdentity: IdentityBundle;
  sellerIdentity: IdentityBundle;
  vet: VetArtifacts;
  directories: SellerDirectories;
  state: CommerceState;
  workerId: string;
}): Promise<SellerRuntime> {
  const {
    preflight,
    jobId,
    published,
    agreement,
    commitment,
    selectedRail,
    buyerIdentity,
    sellerIdentity,
    vet,
    state,
  } = input;
  const settlementStore = await createFsX402PaywallSettlementStore({
    dir: input.directories.settlement,
  });
  const receiptStore = await createFsSellerReceiptStore({ dir: input.directories.receipt });
  const fulfilmentStore = await createFsFencedSessionStore({ dir: input.directories.fulfilment });
  const buyerHash = identityBundleHash(buyerIdentity);
  const sellerHash = identityBundleHash(sellerIdentity);
  const commitmentHash = contentHash(commitment.record as unknown as Record<string, unknown>);
  const commitmentRef: AttestationRef = {
    anchor: { kind: "storage-program", locator: commitment.logicalAddress },
    contentHash: commitmentHash,
    signer: preflight.env.SELLER_DID,
  };
  const railDefinition: SellerX402RailDefinition = {
    railVersion: selectedRail.railVersion!,
    railId: selectedRail.railId,
    railType: "x402",
    asset: {
      kind: "erc20",
      chainId: BASE_SEPOLIA_CHAIN_ID,
      contract: preflight.asset,
      symbol: TOKEN_SYMBOL,
      decimals: TOKEN_DECIMALS,
    },
    network: {
      kind: "x402-resource",
      resourceBaseUrl: new URL(preflight.host.resourceUrl).origin,
    },
    phaseHandler: "pay-x402",
    parameters: { finalityBlocks: 1 },
    availability: "live",
  };
  const committedResolution: Extract<CommittedAgreementResolution, { disposition: "verified" }> = {
    disposition: "verified",
    agreement: agreement.agreement as unknown as Record<string, unknown>,
    agreementHash: agreement.agreementHash,
    commitment: {
      finality: "finalized",
      ref: commitment.logicalAddress,
      contentHash: commitmentHash,
      jobId,
      agreementHash: agreement.agreementHash,
      listingRef: published.listingPin,
      committedAt: commitment.committedAt,
      signer: preflight.env.SELLER_DID,
    },
    railRegistryVersion: RAIL_REGISTRY_VERSION,
  };
  const listingResolution: SellerListingAtCommitResolution = {
    rawListing: published.listing as unknown as Record<string, unknown>,
    validation: await validateListingArtifact(
      published.listing as unknown as Record<string, unknown>,
      listingValidationDeps({
        sellerDid: preflight.env.SELLER_DID,
        sellerPublicKey: await preflight.seller.adapter.getPublicKey(),
        selectedRail,
        now: commitment.committedAt,
      }),
    ),
  };
  const [sellerPublicKey, buyerPublicKey] = await Promise.all([
    preflight.seller.adapter.getPublicKey(),
    preflight.buyer.adapter.getPublicKey(),
  ]);
  const verifyColdCommittedAuthority = async (): Promise<boolean> => {
    const [listingArtifact, agreementArtifact, commitmentArtifact, listingReceiptValid,
      agreementReceiptValid, commitmentReceiptValid] = await Promise.all([
      preflight.buyer.adapter.readAnchor(published.receipt.nativeAddress),
      preflight.seller.adapter.readAnchor(agreement.anchorReceipt.nativeAddress),
      preflight.buyer.adapter.readAnchor(commitment.anchorReceipt.nativeAddress),
      verifyAnchorReceipt(preflight.buyer.adapter, published.receipt, preflight.env.SELLER_DID),
      verifyAnchorReceipt(preflight.seller.adapter, agreement.anchorReceipt, preflight.env.BUYER_DID),
      verifyAnchorReceipt(preflight.buyer.adapter, commitment.anchorReceipt, preflight.env.SELLER_DID),
    ]);
    if (!listingArtifact || !agreementArtifact || !commitmentArtifact ||
        !listingReceiptValid || !agreementReceiptValid || !commitmentReceiptValid ||
        canonicalize(listingArtifact) !== canonicalize(published.listing) ||
        canonicalize(agreementArtifact) !== canonicalize(agreement.agreement) ||
        canonicalize(commitmentArtifact) !== canonicalize(commitment.record)) return false;
    const listingCheck = await validateListingArtifact(
      listingArtifact,
      listingValidationDeps({
        sellerDid: preflight.env.SELLER_DID,
        sellerPublicKey,
        selectedRail,
        now: commitment.committedAt,
      }),
    );
    if (listingCheck.disposition !== "verified") return false;
    try {
      validateFixedPriceAgreementBinding({
        agreement: agreement.agreement,
        verifiedListing: {
          disposition: "verified",
          listing: published.listing,
          pin: published.listingPin,
        },
        committedAt: commitment.committedAt,
      });
    } catch {
      return false;
    }
    const agreementSeparator = "agreementVersion" in agreement.agreement
      ? ARTIFACT_SEPARATORS.AgreementDocument
      : ARTIFACT_SEPARATORS.PayeeBoundAgreementDocument;
    const agreementBytes = signedBytes(agreementSeparator, agreement.agreementHash);
    const agreementSignaturesValid = agreement.agreement.signatures.length === 2 &&
      agreement.agreement.signatures.every((signature) => {
        const key = signature.party === preflight.env.BUYER_DID ? buyerPublicKey
          : signature.party === preflight.env.SELLER_DID ? sellerPublicKey : null;
        return signature.algorithm === "ed25519" && key !== null && ed25519Verify(
          agreementBytes,
          Uint8Array.from(Buffer.from(signature.value, "base64url")),
          publicKeyFromRaw(key),
        );
      });
    const commitmentSignature = commitment.record.signature;
    const commitmentSignatureValid = commitmentSignature.algorithm === "ed25519" &&
      commitmentSignature.signer === preflight.env.SELLER_DID && ed25519Verify(
        signedBytes(FINALITY_COMMITMENT_SEPARATOR, commitmentHash),
        Uint8Array.from(Buffer.from(commitmentSignature.value, "base64url")),
        publicKeyFromRaw(sellerPublicKey),
      );
    return agreementSignaturesValid && commitmentSignatureValid &&
      commitment.record.jobId === jobId &&
      commitment.record.agreementHash === agreement.agreementHash &&
      canonicalize(commitment.record.listingRef) === canonicalize(published.listingPin);
  };
  const paymentIntakeDeps: Omit<SellerPaymentIntakeDeps, "receiptStore"> = {
    resolveCommittedAgreement: async (candidateJobId) =>
      candidateJobId === jobId && await verifyColdCommittedAuthority()
        ? structuredClone(committedResolution)
        : { disposition: "rejected", reason: "committed-authority-unverified" },
    resolveListingAtCommit: async (pin) => {
      if (canonicalize(pin) !== canonicalize(published.listingPin)) {
        throw new Error("listing-pin-mismatch");
      }
      requireCondition(await verifyColdCommittedAuthority(), "listing-authority-unverified");
      return structuredClone(listingResolution);
    },
    resolveRail: async ({ ref, railRegistryVersion }) =>
      canonicalize(ref) === canonicalize(selectedRail) &&
      railRegistryVersion === RAIL_REGISTRY_VERSION
        ? { disposition: "verified", rail: railDefinition, railRegistryVersion }
        : { disposition: "rejected", reason: "rail-mismatch" },
    resolveIdentityBundle: async (hash) => {
      const bundle = hash === buyerHash ? buyerIdentity : hash === sellerHash ? sellerIdentity : null;
      const key = hash === buyerHash ? buyerPublicKey : hash === sellerHash ? sellerPublicKey : null;
      if (!bundle || !key) {
        return { disposition: "rejected", reason: "identity-bundle-mismatch" };
      }
      const isBuyer = hash === buyerHash;
      const valid = await verifyFundedIdentityPresentation({
        bundle,
        expectedPrimaryClaim: isBuyer
          ? preflight.env.BUYER_DID : preflight.env.SELLER_DID,
        primaryPublicKey: key,
        ...(isBuyer ? { evmAddress: preflight.payer } : {}),
      });
      return valid
        ? { disposition: "verified", bundle: structuredClone(bundle) }
        : { disposition: "rejected", reason: "identity-presentation-invalid" };
    },
    resolvePayerAddress: async ({ payingKey, buyerBundle }) =>
      payingKey === `cci-xm:evm:base-sepolia:${preflight.payer}` &&
      buyerBundle.claims.some(({ ref }) => ref === payingKey) &&
      identityBundleHash(buyerBundle) === buyerHash &&
      await verifyFundedIdentityPresentation({
        bundle: buyerBundle,
        expectedPrimaryClaim: preflight.env.BUYER_DID,
        primaryPublicKey: buyerPublicKey,
        evmAddress: preflight.payer,
      })
        ? { disposition: "verified", address: preflight.payer }
        : { disposition: "rejected", reason: "payer-binding-mismatch" },
    resolvePayeeDestination: async ({ payeePrimaryClaim, payeeBundle, payoutAddress }) =>
      payeePrimaryClaim === preflight.env.SELLER_DID &&
      identityBundleHash(payeeBundle) === sellerHash &&
      payoutAddress.toLowerCase() === preflight.payee.toLowerCase()
        ? { disposition: "bound", address: preflight.payee, tier: 3 }
        : { disposition: "mismatch", reason: "payee-binding-mismatch", tier: 3 },
    observeDemosTransfer: async () => ({ status: "not-found" }),
    observeX402Transfer: async ({ chainId, txHash }) => {
      if (chainId !== BASE_SEPOLIA_CHAIN_ID) return { status: "failed", reason: "chain-mismatch" };
      const observed = await observeFundedTransfer({ preflight, jobId, txHash });
      if (observed.status === "finalized") state.observedTransfer = structuredClone(observed);
      return observed;
    },
    verifyX402ReceiptExtensions: ({ protocolVersion, receipt }) => {
      const allowed = new Set(["success", "transaction", "network", "payer", "amount"]);
      const keys = Object.keys(receipt);
      const valid = protocolVersion === String(X402_VERSION) &&
        keys.every((key) => allowed.has(key)) &&
        receipt.success === true &&
        typeof receipt.transaction === "string" &&
        /^0x[0-9a-fA-F]{64}$/.test(receipt.transaction) &&
        receipt.network === BASE_SEPOLIA_NETWORK &&
        typeof receipt.payer === "string" &&
        receipt.payer.toLowerCase() === preflight.payer.toLowerCase() &&
        (receipt.amount === undefined || receipt.amount === PAYMENT_AMOUNT.toString()) &&
        !Object.hasOwn(receipt, "extensions") && !Object.hasOwn(receipt, "extra");
      return valid
        ? { disposition: "pass" }
        : { disposition: "fail", reason: "unexpected-or-unbound-settlement-extension" };
    },
    classifyX402SettlementChain: ({ chainId, rail: candidate }) =>
      chainId === BASE_SEPOLIA_CHAIN_ID &&
        canonicalize(candidate) === canonicalize(railDefinition)
        ? { disposition: "l2" }
        : { disposition: "unsupported", reason: "unregistered-settlement-chain" },
  };

  const fulfilmentListing: SellerFulfilmentListing = {
    pin: published.listingPin,
    sellerPrimaryClaim: preflight.env.SELLER_DID,
    buyerRequirement: structuredClone(published.listing.buyerRequirement),
    pipeline: published.listing.pipeline,
    deliverable: published.listing.offering.deliverable,
  };
  const fulfilmentAgreement: SellerFulfilmentAgreement = {
    artifactKind: "payee-bound",
    ref: agreement.agreementRef.anchor.locator,
    contentHash: agreement.agreementHash,
    jobId,
    listingPin: published.listingPin,
    buyer: {
      primaryClaim: preflight.env.BUYER_DID,
      bundleHash: buyerHash,
      vetRecordRef: structuredClone(input.vet.buyerRef),
      storageAddress: preflight.buyer.adapter.getAddress(),
    },
    seller: {
      primaryClaim: preflight.env.SELLER_DID,
      bundleHash: sellerHash,
      vetRecordRef: structuredClone(input.vet.sellerRef),
    },
    deliverableRef: {
      deliverableType: "storage-program",
      hash: sha256Hex(canonicalize(published.listing.offering.deliverable)),
    },
    commitment: {
      status: "finalized",
      ref: commitment.logicalAddress,
      agreementHash: agreement.agreementHash,
      recordContentHash: commitmentHash,
      finalizedAt: commitment.committedAt,
      signer: preflight.env.SELLER_DID,
    },
  };
  const deliveredArtifact: SellerDeliveredArtifact = {
    kind: "deliver-storage-program",
    cleartextPayload: { result: "funded-proof", jobId },
    anchoredValue: { result: "funded-proof", jobId },
    access: { model: "public" },
  };
  const deliveryLogicalAddress = `dacs4:deliverable:${jobId}`;
  const evidenceLogicalAddress = `dacs4:delivery-evidence:${jobId}`;
  const finalReceiptLogicalAddress = `dacs4:final-receipt:${jobId}`;
  const resolveSellerAnchor = async (logicalAddress: string) => {
    const resolved = await preflight.buyer.adapter.resolveAnchorByName(
      logicalAddress,
      preflight.seller.adapter.getAddress(),
    );
    if (resolved.status !== "present") return null;
    const artifact = await preflight.buyer.adapter.readAnchor(resolved.address);
    if (!artifact) return null;
    return { address: resolved.address, artifact };
  };
  const sessionRecord = (): SellerFulfilmentSessionRecord => ({
    recordVersion: "1",
    jobId,
    state: "settle-pending",
    listingRef: published.listingPin,
    parties: [
      {
        role: "buyer",
        bundleHash: buyerHash,
        primaryClaim: preflight.env.BUYER_DID,
        vetRecordRef: structuredClone(input.vet.buyerRef),
      },
      {
        role: "seller",
        bundleHash: sellerHash,
        primaryClaim: preflight.env.SELLER_DID,
        vetRecordRef: structuredClone(input.vet.sellerRef),
      },
      { role: "orchestrator", bundleHash: sellerHash, primaryClaim: preflight.env.SELLER_DID },
    ],
    pipeline: published.listing.pipeline,
    phaseResults: [
      {
        index: 0,
        step: published.listing.pipeline[0]!,
        invokedAt: agreement.agreement.generatedAt,
        result: {
          ok: true,
          contextDelta: {
            "negotiate-fixed-price": {
              agreementHash: agreement.agreementHash,
              agreementRef: agreement.agreementRef,
            },
          },
        },
        contextDelta: {
          "negotiate-fixed-price": {
            agreementHash: agreement.agreementHash,
            agreementRef: agreement.agreementRef,
          },
        },
      },
      {
        index: 1,
        step: published.listing.pipeline[1]!,
        invokedAt: commitment.committedAt,
        result: {
          ok: true,
          txRefs: [structuredClone(commitment.anchorTxRef)],
          attestationRef: commitmentRef,
          anchorReceipt: structuredClone(commitment.anchorReceipt),
          contextDelta: {
            "commit-payee-bound-agreement": {
              agreementHash: agreement.agreementHash,
              anchorTxRef: structuredClone(commitment.anchorTxRef),
              anchorReceipt: structuredClone(commitment.anchorReceipt),
              committedAt: commitment.committedAt,
            },
          },
        },
        contextDelta: {
          "commit-payee-bound-agreement": {
            agreementHash: agreement.agreementHash,
            anchorTxRef: structuredClone(commitment.anchorTxRef),
            anchorReceipt: structuredClone(commitment.anchorReceipt),
            committedAt: commitment.committedAt,
          },
        },
      },
      {
        index: PAYMENT_PHASE_INDEX,
        step: published.listing.pipeline[PAYMENT_PHASE_INDEX]!,
        invokedAt: Date.now(),
        result: {
          ok: true,
          txRefs: state.permit?.paymentAuthorization.evidenceInput.paymentTxRefs ?? [],
          contextDelta: {},
        },
        contextDelta: {},
      },
    ],
    startedAt: agreement.agreement.generatedAt,
    lastUpdatedAt: Date.now(),
    recipeRegistryVersion: RECIPE_REGISTRY_VERSION,
    railRegistryVersion: RAIL_REGISTRY_VERSION,
  });
  const fulfilmentDeps: Omit<DurableSellerFulfilmentDeps, "receiptStore"> = {
    auditSourceProfile: "v2",
    resolveAgreement: async () => ({ status: "verified", value: structuredClone(fulfilmentAgreement) }),
    resolveListing: async () => ({ status: "verified", value: structuredClone(fulfilmentListing) }),
    resolveAuditSource: async () => {
      const retainedAuthorization = state.permit?.paymentAuthorization;
      if (!retainedAuthorization) {
        return {
          status: "indeterminate" as const,
          reason: "payment authorization is unavailable for audit-source binding",
        };
      }
      return {
        status: "verified" as const,
        value: {
          sourceVersion: "1" as const,
          session: sessionRecord(),
          artifacts: {
            agreementCommitment: structuredClone(commitmentRef),
            vetRecords: [structuredClone(vet.buyerRef), structuredClone(vet.sellerRef)],
            vetRequirements: [
              {
                vetRecordRef: structuredClone(vet.buyerRef),
                evaluatedParty: preflight.env.BUYER_DID,
                requirement: structuredClone(EMPTY_REQUIREMENT),
                verifier: preflight.env.SELLER_DID,
                freshness: [],
                dealSpecific: [],
              },
              {
                vetRecordRef: structuredClone(vet.sellerRef),
                evaluatedParty: preflight.env.SELLER_DID,
                requirement: structuredClone(EMPTY_REQUIREMENT),
                verifier: preflight.env.SELLER_DID,
                freshness: [],
                dealSpecific: [],
              },
            ],
            settlementEvidence: [{
              anchor: {
                kind: "storage-program" as const,
                locator:
                  `dacs4:payment:${jobId}:${encodeAddressSegment(selectedRail.railId)}:${PAYMENT_PHASE_INDEX}`,
              },
              contentHash: retainedAuthorization.evidenceHash,
              signer: preflight.env.SELLER_DID,
            }],
          },
          provenanceProfile: "dacs-sdk-operational-v1",
        },
      };
    },
    prepareDelivery: async () => ({ status: "prepared", delivery: { artifact: deliveredArtifact } }),
    submitDelivery: async () => {
      state.counts.applicationCallback += 1;
      const anchored = await anchorArtifact({
        adapter: preflight.seller.adapter,
        writer: preflight.env.SELLER_DID,
        logicalAddress: deliveryLogicalAddress,
        artifact: deliveredArtifact.anchoredValue as Record<string, unknown>,
      });
      state.counts.delivery += 1;
      state.deliveryPublication = {
        artifact: structuredClone(deliveredArtifact),
        receipt: anchored.receipt,
      };
      state.delivered = {
        status: "accepted",
        reconciliationId: `delivery:${sha256Hex(jobId)}`,
      };
      return state.delivered;
    },
    reconcileDelivery: async () => {
      const recovered = await resolveSellerAnchor(deliveryLogicalAddress);
      return recovered && canonicalize(recovered.artifact) ===
          canonicalize(deliveredArtifact.anchoredValue)
        ? {
            status: "complete",
            reconciliationId: `delivery:${sha256Hex(jobId)}`,
            observedAt: Date.now(),
          }
        : { status: "absent", reason: "delivery-absent" };
    },
    resolveDelivery: async () => {
      const recovered = await resolveSellerAnchor(deliveryLogicalAddress);
      if (!recovered || canonicalize(recovered.artifact) !==
          canonicalize(deliveredArtifact.anchoredValue)) {
        return { status: "indeterminate", reason: "delivery-publication-absent" };
      }
      const retainedReceipt = state.deliveryPublication?.receipt;
      if (!retainedReceipt || retainedReceipt.logicalAddress !== deliveryLogicalAddress ||
          retainedReceipt.nativeAddress !== recovered.address ||
          retainedReceipt.contentHash !== contentHash(recovered.artifact) ||
          !await verifyAnchorReceipt(
            preflight.buyer.adapter,
            retainedReceipt,
            preflight.env.SELLER_DID,
          )) {
        return {
          status: "indeterminate",
          reason: "exact-delivery-anchor-receipt-unavailable",
        };
      }
      return {
        status: "verified",
        value: {
          artifact: structuredClone(deliveredArtifact),
          anchorReceipt: structuredClone(retainedReceipt),
        },
      };
    },
    verifyAnchorReceipt: async ({ receipt, expectedWriter }) => {
      const valid = expectedWriter.primaryClaim === preflight.env.SELLER_DID &&
        await verifyAnchorReceipt(
        preflight.seller.adapter,
        receipt,
        preflight.env.SELLER_DID,
      );
      return valid
        ? { disposition: "valid" }
        : { disposition: "invalid", reason: "anchor-receipt-invalid" };
    },
    evidenceSigner: {
      algorithm: "ed25519",
      signer: preflight.env.SELLER_DID,
      sign: (bytes) => preflight.seller.adapter.sign(bytes),
    },
    auditSourceCommitmentSigner: {
      algorithm: "ed25519",
      signer: preflight.env.SELLER_DID,
      sign: (bytes) => preflight.seller.adapter.sign(bytes),
    },
    verifyEvidenceSignature: async ({ signedBytes: bytes, signature, expectedSigner }) => {
      const valid = expectedSigner === preflight.env.SELLER_DID &&
        signature.algorithm === "ed25519" &&
        signature.signer === expectedSigner &&
        ed25519Verify(
          bytes,
          Uint8Array.from(Buffer.from(signature.value, "base64url")),
          publicKeyFromRaw(await preflight.seller.adapter.getPublicKey()),
        );
      return valid
        ? { disposition: "valid" }
        : { disposition: "invalid", reason: "delivery-evidence-signature-invalid" };
    },
    verifyAuditSourceCommitmentSignature: async ({
      signedBytes: bytes,
      signature,
      expectedSigner,
    }) => {
      const valid = expectedSigner === preflight.env.SELLER_DID &&
        signature.algorithm === "ed25519" &&
        signature.signer === expectedSigner &&
        ed25519Verify(
          bytes,
          Uint8Array.from(Buffer.from(signature.value, "base64url")),
          publicKeyFromRaw(await preflight.seller.adapter.getPublicKey()),
        );
      return valid
        ? { disposition: "valid" }
        : { disposition: "invalid", reason: "audit-source-signature-invalid" };
    },
    anchorEvidence: async ({ evidence, evidenceHash }) => {
      state.counts.evidence += 1;
      const anchored = await anchorArtifact({
        adapter: preflight.seller.adapter,
        writer: preflight.env.SELLER_DID,
        logicalAddress: evidenceLogicalAddress,
        artifact: evidence as unknown as Record<string, unknown>,
      });
      requireCondition(anchored.ref.contentHash === evidenceHash, "delivery-evidence-hash-mismatch");
      state.anchoredEvidence = structuredClone(evidence);
      state.evidencePublication = {
        status: "anchored",
        ref: anchored.ref,
        anchorReceipt: anchored.receipt,
      };
      return state.evidencePublication;
    },
    resolveEvidence: async () => {
      const recovered = await resolveSellerAnchor(evidenceLogicalAddress);
      return recovered
        ? {
            status: "verified",
            value: recovered.artifact as unknown as SignedSellerDeliveryEvidence,
          }
        : { status: "indeterminate", reason: "delivery-evidence-absent" };
    },
    nowMs: Date.now,
  };
  const fulfilmentDurability: SellerFulfilmentDurability = {
    store: fulfilmentStore,
    workerId: input.workerId,
    leaseTtlMs: LEASE_DURATION_MS,
    leaseNowMs: Date.now,
    reconcilePayloadAttestation: async () => ({
      status: "absent",
      reason: "storage-delivery-has-no-payload-attestation",
    }),
    reconcileDeliverySubmission: async () => {
      const recovered = await resolveSellerAnchor(deliveryLogicalAddress);
      return recovered && canonicalize(recovered.artifact) ===
          canonicalize(deliveredArtifact.anchoredValue)
        ? { status: "accepted", reconciliationId: `delivery:${sha256Hex(jobId)}` }
        : { status: "absent", reason: "delivery-absent" };
    },
    reconcileEvidencePublication: async (candidate) => {
      const recovered = await resolveSellerAnchor(evidenceLogicalAddress);
      if (!recovered || contentHash(recovered.artifact) !== candidate.evidenceHash) {
        return { status: "absent", reason: "delivery-evidence-absent" };
      }
      const retained = state.evidencePublication;
      return retained?.status === "anchored" &&
          retained.ref.contentHash === candidate.evidenceHash &&
          retained.anchorReceipt.nativeAddress === recovered.address &&
          await verifyAnchorReceipt(
            preflight.buyer.adapter,
            retained.anchorReceipt,
            preflight.env.SELLER_DID,
          )
        ? structuredClone(retained)
        : {
            status: "indeterminate",
            reason: "exact-delivery-evidence-anchor-receipt-unavailable",
          };
    },
    publishFinalSessionReceipt: async (candidate) => {
      state.counts.finalReceipt += 1;
      const receiptArtifact = {
        receiptVersion: "dacs-sdk-funded-e2e-1",
        jobId,
        fulfilmentId: candidate.fulfilmentId,
        authorizationBinding: candidate.authorizationBinding,
        resultHash: candidate.resultHash,
      };
      const anchored = await anchorArtifact({
        adapter: preflight.seller.adapter,
        writer: preflight.env.SELLER_DID,
        logicalAddress: finalReceiptLogicalAddress,
        artifact: receiptArtifact,
      });
      state.finalReceipt = {
        status: "recorded",
        receipt: {
          ...receiptArtifact,
          anchorReceipt: anchored.receipt,
        },
      };
      return state.finalReceipt;
    },
    reconcileFinalSessionReceipt: async (candidate) => {
      const recovered = await resolveSellerAnchor(finalReceiptLogicalAddress);
      if (!recovered || recovered.artifact.fulfilmentId !== candidate.fulfilmentId ||
          recovered.artifact.resultHash !== candidate.resultHash ||
          canonicalize(recovered.artifact.authorizationBinding) !==
            canonicalize(candidate.authorizationBinding)) {
        return { status: "absent", reason: "final-receipt-absent" };
      }
      return state.finalReceipt?.status === "recorded"
        ? structuredClone(state.finalReceipt)
        : {
            status: "indeterminate",
            reason: "exact-final-session-receipt-anchor-unavailable",
          };
    },
  };
  const expected = {
    network: BASE_SEPOLIA_NETWORK,
    payTo: preflight.payee,
    amount: PAYMENT_AMOUNT.toString(),
    asset: preflight.asset,
    eip712: { name: TOKEN_NAME, version: TOKEN_VERSION },
  };
  const scope: X402SellerCommittedSessionScope = {
    scopeVersion: "1",
    jobId,
    paymentPhaseIndex: PAYMENT_PHASE_INDEX,
    deliveryPhaseIndex: DELIVERY_PHASE_INDEX,
    payer: preflight.payer,
    payerPayingKey: `cci-xm:evm:base-sepolia:${preflight.payer}`,
    httpResource: preflight.host.resourceUrl,
    railId: selectedRail.railId,
    railRegistryVersion: RAIL_REGISTRY_VERSION,
    agreementRef: agreement.agreementRef.anchor.locator,
    agreementHash: agreement.agreementHash,
    listingRef: published.listingPin,
    commitmentRef: commitment.logicalAddress,
    commitmentContentHash: commitmentHash,
    commitmentFinalizedAt: commitment.committedAt,
    expected,
  };
  const spine = createX402SellerSpine<{ delivered: true }>({
    settlementStore,
    reconcileSettlement: async () => state.settlementResult
      ? { status: "settled", settlement: structuredClone(state.settlementResult) }
      : { status: "pending", reason: "settlement-not-observed" },
    receiptStore,
    resolveCommittedSession: async () => await verifyColdCommittedAuthority()
      ? { disposition: "verified", session: structuredClone(scope) }
      : { disposition: "rejected", reason: "committed-session-authority-unverified" },
    paymentIntakeDeps,
    fulfilmentDeps,
    fulfilmentDurability,
    renderResponse: async (context) => {
      state.counts.render += 1;
      state.fulfilment = structuredClone(context.fulfilment);
      if (state.loseResponseAcknowledgement) {
        state.loseResponseAcknowledgement = false;
        throw new Error("injected-response-acknowledgement-loss");
      }
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: { delivered: true },
      };
    },
  });
  const facilitator = {
    getSupported: () => preflight.facilitator.getSupported(),
    verify: async (payload: unknown, requirements: unknown) => {
      state.counts.facilitatorVerify += 1;
      try {
        const result = await preflight.facilitator.verify(
          payload as never,
          legacyFacilitatorRequirements(
            requirements as X402BuyerPaymentRequirements,
          ) as never,
        );
        state.facilitatorVerifyOutcome = result.isValid ? "valid" : "invalid";
        return result;
      } catch (error) {
        state.facilitatorVerifyOutcome = "threw";
        throw error;
      }
    },
    settle: async (payload: unknown, requirements: unknown) => {
      state.counts.facilitatorSettle += 1;
      let result: Awaited<ReturnType<HTTPFacilitatorClient["settle"]>>;
      try {
        result = await preflight.facilitator.settle(
          payload as never,
          legacyFacilitatorRequirements(
            requirements as X402BuyerPaymentRequirements,
          ) as never,
        );
      } catch (error) {
        state.facilitatorOutcome = "threw";
        throw error;
      }
      state.facilitatorOutcome = result.success ? "success" : "failure";
      // This is the seller's durable handoff for the ambiguity window after
      // the facilitator has returned but before the paywall WAL is terminal.
      return retainSuccessfulFacilitatorSettlement(
        state,
        settlementStore,
        x402PaywallSettlementKey({ jobId, phaseIndex: PAYMENT_PHASE_INDEX }),
        result,
        requirements as X402BuyerPaymentRequirements,
        preflight.payer,
      );
    },
  };
  const paywall = await createX402Paywall<
    X402SellerPaymentPermitAuthorization,
    { delivered: true }
  >({
    route: preflight.host.route,
    network: BASE_SEPOLIA_NETWORK,
    payTo: preflight.payee,
    amount: PAYMENT_AMOUNT.toString(),
    asset: preflight.asset,
    eip712: { name: TOKEN_NAME, version: TOKEN_VERSION },
    facilitator,
    maxTimeoutSeconds: PAYMENT_TIMEOUT_SECONDS,
    extra: { assetTransferMethod: "eip3009" },
    description: "DACS issue 114 funded proof",
    mimeType: "application/json",
  }, {
    ...spine,
    authorizeSettlement: async (context) => {
      const result = await spine.authorizeSettlement(context);
      state.preSettlementOutcome = result.disposition;
      return result;
    },
    authorizePayment: async (context) => {
      const result = await spine.authorizePayment(context);
      if (result.disposition === "authorized") {
        state.permit = structuredClone(result.authorization);
      }
      return result;
    },
  });
  requireCondition(canonicalize(paywall.terms) === canonicalize(expected), "paywall-terms-mismatch");
  return { paywall, receiptStore, fulfilmentStore };
}

interface SettlementRun {
  intent: Readonly<X402BuyerSettlementIntent>;
  state: CommerceState;
  seller: SellerRuntime;
  buyerStoreDir: string;
  sellerDirectories: SellerDirectories;
}

async function settleAndRecover(input: {
  preflight: Preflight;
  jobId: string;
  published: PublishedListing;
  agreement: AgreementRun;
  commitment: Awaited<ReturnType<typeof commitAgreement>>;
  selectedRail: PaymentRailRef;
  buyerIdentity: IdentityBundle;
  sellerIdentity: IdentityBundle;
  vet: VetArtifacts;
}): Promise<SettlementRun> {
  const sellerDirectories = {
    settlement: await temporaryDirectory("seller-settlement"),
    receipt: await temporaryDirectory("seller-receipt"),
    fulfilment: await temporaryDirectory("seller-fulfilment"),
  };
  const buyerStoreDir = await temporaryDirectory("buyer-settlement");
  const state = commerceState();
  let seller = await createSellerRuntime({
    ...input,
    directories: sellerDirectories,
    state,
    workerId: "funded-seller-process-a",
  });
  input.preflight.host.install(seller.paywall);
  const authority = {
    jobId: input.jobId,
    phaseIndex: PAYMENT_PHASE_INDEX,
    railId: input.selectedRail.railId,
    railVersion: String(input.selectedRail.railVersion),
    railDescriptorHash: sha256Hex(canonicalize(input.selectedRail)),
    agreementHash: input.agreement.agreementHash,
    termsHash: sha256Hex(canonicalize(input.agreement.agreement.terms)),
    sessionBindingHash: sha256Hex(canonicalize({
      jobId: input.jobId,
      payer: input.preflight.payer,
      commitment: input.commitment.logicalAddress,
    })),
    network: BASE_SEPOLIA_NETWORK,
    payer: input.preflight.payer,
    payee: input.preflight.payee,
    asset: input.preflight.asset,
    amount: PAYMENT_AMOUNT.toString(),
    httpResource: input.preflight.host.resourceUrl,
    method: "GET" as const,
  };
  const expectedRequirements: X402BuyerPaymentRequirements = {
    scheme: "exact",
    network: BASE_SEPOLIA_NETWORK,
    amount: PAYMENT_AMOUNT.toString(),
    asset: input.preflight.asset,
    payTo: input.preflight.payee,
    maxTimeoutSeconds: PAYMENT_TIMEOUT_SECONDS,
    extra: {
      name: TOKEN_NAME,
      version: TOKEN_VERSION,
      assetTransferMethod: "eip3009",
    },
  };
  const client = await createDacsX402BuyerEvmChallengeClient({
    evmPrivateKey: input.preflight.env.BUYER_EVM_KEY,
    authority,
    expectedRequirements,
  });
  const prepared = await prepareX402BuyerSettlement({ authority }, {
    client,
    fetchImpl: input.preflight.host.fetchImpl,
  });
  requireCondition(prepared.disposition === "prepared", "buyer-preparation-failed");
  const intent = prepared.intent;
  const createAuthorizationProvider = (readClient: X402BuyerEvmReadClient) =>
    createX402BuyerEvmAuthorizationProvider({
      chainId: BASE_SEPOLIA_CHAIN_ID,
      minimumConfirmations: 1,
      authorizationSearchFromBlock: input.preflight.authorizationSearchFromBlock,
      client: readClient,
      authorizeIntent: async ({ intent: candidate }) => {
        const authorized = candidate.bindingHash === intent.bindingHash &&
          candidate.agreementHash === input.agreement.agreementHash &&
          candidate.railDescriptorHash === sha256Hex(canonicalize(input.selectedRail)) &&
          candidate.httpResource === input.preflight.host.resourceUrl &&
          candidate.amount === PAYMENT_AMOUNT.toString();
        return authorized
          ? { disposition: "authorized", bindingHash: candidate.bindingHash }
          : { disposition: "rejected", reason: "finalized-session-authority-mismatch" };
      },
    });
  let finalityHeadReads = 0;
  const disruptedReader: X402BuyerEvmReadClient = {
    getFinalityHead: async () => {
      finalityHeadReads += 1;
      // The first read authorizes the retained bearer. Withhold only the first
      // post-submit chain lookup, after the response disclosure is durable.
      if (finalityHeadReads === 2) throw new Error("injected-chain-read-loss");
      return input.preflight.evmReader.getFinalityHead();
    },
    getLogs: (request) => input.preflight.evmReader.getLogs(request),
    getTransactionReceipt: (transactionHash) =>
      input.preflight.evmReader.getTransactionReceipt(transactionHash),
    readAuthorizationState: (request) =>
      input.preflight.evmReader.readAuthorizationState(request),
    confirmBlockAncestor: (request) =>
      input.preflight.evmReader.confirmBlockAncestor(request),
  };
  const disruptedAuthorizationProvider = createAuthorizationProvider(disruptedReader);
  const authorizationProvider = createAuthorizationProvider(input.preflight.evmReader);
  let buyerStore = await createFsX402BuyerSettlementStore({ dir: buyerStoreDir });
  const productionTransport = createX402BuyerPaidRequestTransport({
    fetchImpl: input.preflight.host.fetchImpl,
  });
  let buyerTransportSubmissions = 0;
  let buyerNow = Date.now();
  const chainOnlyRecoveryTransport = {
    submitRetained: async () => {
      buyerTransportSubmissions += 1;
      throw new Error("duplicate-paid-request");
    },
  };
  const recoverBuyerSettlementFromChain = async (
    ownerPrefix: string,
    failureCode: string,
  ) => {
    // A paid response can arrive before every configured RPC sees the mined
    // authorization. Each retry takes a fresh generation and performs only
    // authenticated chain reconciliation; it is never allowed to redrive the
    // retained HTTP request.
    for (let attempt = 1; attempt <= 60; attempt += 1) {
      buyerNow += 2_000;
      buyerStore = await createFsX402BuyerSettlementStore({ dir: buyerStoreDir });
      const progress = await advanceX402BuyerSettlement({
        intent,
        owner: `${ownerPrefix}-${attempt}`,
        store: buyerStore,
        authorizationProvider,
        transport: chainOnlyRecoveryTransport,
        now: () => buyerNow,
        leaseDurationMs: 1_000,
      });
      requireCondition(buyerTransportSubmissions === 1, "buyer-paid-request-replayed");
      if (progress.status === "captured") return progress;
      requireCondition(progress.status === "indeterminate", `${failureCode}-terminal`);
      if (attempt < 60) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
    throw new Error(`funded-e2e:${failureCode}-timeout`);
  };
  const submitted = await advanceX402BuyerSettlement({
    intent,
    owner: "funded-buyer-process-a",
    store: buyerStore,
    authorizationProvider: disruptedAuthorizationProvider,
    transport: {
      submitRetained: (candidate, fence) => {
        buyerTransportSubmissions += 1;
        return productionTransport.submitRetained(candidate, fence);
      },
    },
    now: () => buyerNow,
    leaseDurationMs: 1_000,
  });
  requireCondition(
    submitted.status === "indeterminate" &&
      submitted.reason === "evm-authorization-lookup-unavailable",
    "buyer-post-response-chain-loss-not-indeterminate",
  );
  const pending = await buyerStore.load(intent.settlementKey);
  if (pending.status !== "held" || pending.pendingDisclosure === undefined) {
    throw new Error(
      `funded-e2e:buyer-disclosure-missing-after-verify-${state.facilitatorVerifyOutcome ?? "not-called"}-presettle-${state.preSettlementOutcome ?? "not-called"}-settle-${state.facilitatorOutcome ?? "not-called"}`,
    );
  }
  requireCondition(
    pending.status === "held" && pending.pendingDisclosure !== undefined,
    "buyer-pending-disclosure-not-durable",
  );
  requireCondition(input.preflight.host.requestCounts.unpaid === 1, "challenge-count-mismatch");
  requireCondition(input.preflight.host.requestCounts.paid === 1, "paid-request-count-mismatch");
  requireCondition(buyerTransportSubmissions === 1, "buyer-submit-count-mismatch");
  requireCondition(state.counts.facilitatorSettle === 1, "settlement-effect-count-mismatch");
  requireCondition(state.counts.delivery === 1 && state.counts.evidence === 1, "fulfilment-effect-count-mismatch");

  // Runtime B has only the filesystem WAL and a fresh production chain reader.
  // It captures the already-mined authorization without another HTTP request.
  const captured = await recoverBuyerSettlementFromChain(
    "funded-buyer-process-b",
    "buyer-chain-recovery",
  );
  requireCondition(buyerTransportSubmissions === 1, "buyer-paid-request-replayed");

  // Recreate both seller and buyer durable stacks. Neither restarted runtime is
  // permitted to reach a second payment, delivery, or evidence effect. This is
  // a cold-store recovery proof inside one test invocation, not a same-run-ID
  // process-crash resurrection harness.
  const processAEffectCounts = structuredClone(state.counts);
  state.permit = undefined;
  state.observedTransfer = undefined;
  state.delivered = undefined;
  state.deliveryPublication = undefined;
  state.anchoredEvidence = undefined;
  state.evidencePublication = undefined;
  state.finalReceipt = undefined;
  state.fulfilment = undefined;
  state.settlementResult = undefined;
  const restartedState = commerceState();
  restartedState.loseResponseAcknowledgement = false;
  seller = await createSellerRuntime({
    ...input,
    directories: sellerDirectories,
    state: restartedState,
    workerId: "funded-seller-process-b",
  });
  input.preflight.host.install(seller.paywall);
  const fulfilmentStatus = await getSellerFulfilmentStatus(
    seller.fulfilmentStore,
    input.jobId,
    DELIVERY_PHASE_INDEX,
  );
  requireCondition(
    fulfilmentStatus.status === "ok" && fulfilmentStatus.delivery === "outcome" &&
    fulfilmentStatus.evidence === "outcome",
    "seller-cold-recovery-failed",
  );
  const replayResponse = await input.preflight.host.fetchImpl(input.preflight.host.resourceUrl, {
    method: "GET",
    headers: { [intent.paymentHeader.name]: intent.paymentHeader.value },
    redirect: "error",
  });
  await replayResponse.arrayBuffer();
  requireCondition(replayResponse.status === 200, "seller-request-replay-failed");
  requireCondition(Number(input.preflight.host.requestCounts.paid) === 2, "seller-replay-not-observed");
  requireCondition(
    restartedState.counts.facilitatorVerify === 0 &&
    restartedState.counts.facilitatorSettle === 0 &&
    restartedState.counts.applicationCallback === 0 &&
    restartedState.counts.delivery === 0 && restartedState.counts.evidence === 0 &&
    restartedState.counts.finalReceipt === 0 && restartedState.counts.render === 1,
    "seller-replay-produced-duplicate-effect",
  );
  requireCondition(restartedState.permit !== undefined, "seller-recovered-permit-missing");
  requireCondition(restartedState.fulfilment !== undefined, "seller-recovered-fulfilment-missing");
  const recoveredTxHash = restartedState.permit.paymentAuthorization.settlementIdentity.txHash;
  const recoveredObservation = await observeFundedTransfer({
    preflight: input.preflight,
    jobId: input.jobId,
    txHash: recoveredTxHash,
  });
  requireCondition(recoveredObservation.status === "finalized", "seller-chain-recovery-failed");
  restartedState.observedTransfer = structuredClone(recoveredObservation);
  const recovered = await recoverBuyerSettlementFromChain(
    "funded-buyer-process-c",
    "buyer-cold-recovery",
  );
  requireCondition(buyerTransportSubmissions === 1, "buyer-paid-request-replayed");
  requireCondition(
    processAEffectCounts.applicationCallback === 1 && processAEffectCounts.delivery === 1 &&
    processAEffectCounts.evidence === 1 && processAEffectCounts.finalReceipt === 1,
    "seller-effects-replayed",
  );
  return {
    intent,
    state: restartedState,
    seller,
    buyerStoreDir,
    sellerDirectories,
  };
}

async function publishAndVerifySellerSettlement(input: {
  preflight: Preflight;
  jobId: string;
  agreement: AgreementRun;
  selectedRail: PaymentRailRef;
  settlement: SettlementRun;
}) {
  const permit = input.settlement.state.permit;
  const observation = input.settlement.state.observedTransfer;
  requireCondition(permit !== undefined, "seller-payment-permit-missing");
  requireCondition(observation !== undefined, "seller-chain-observation-missing");
  const authorization = permit.paymentAuthorization;
  const proofArtifact = {
    proofVersion: "evm-event-1",
    settlementId: authorization.settlementId,
    event: structuredClone(authorization.settlementIdentity),
    observation: structuredClone(observation),
  };
  const nativeProofRef: SessionSettlementNativeProofRef = {
    proofVersion: "1",
    kind: "authenticated-x402-event",
    locator: `eip155:${BASE_SEPOLIA_CHAIN_ID}:${observation.txHash}:${observation.logIndex}`,
    contentHash: sha256Hex(canonicalize(proofArtifact)),
    encoding: "jcs",
  };
  const proofAuthentication: SellerSessionSettlementNativeProofAuthentication = {
    disposition: "authenticated",
    binding: {
      bindingVersion: "1",
      jobId: input.jobId,
      railId: input.selectedRail.railId,
      phaseIndex: PAYMENT_PHASE_INDEX,
      phase: "pay-x402",
      evidenceHash: authorization.evidenceHash,
      settlementId: authorization.settlementId,
      network: BASE_SEPOLIA_NETWORK,
      event: structuredClone(authorization.settlementIdentity),
      settlementFinality: structuredClone(authorization.evidenceInput.settlementFinality),
    },
    proof: {
      encoding: "jcs",
      kind: "authenticated-x402-event",
      locator: nativeProofRef.locator,
      artifact: proofArtifact,
    },
  };
  const sellerPublicKey = await input.preflight.seller.adapter.getPublicKey();
  const buyerPublicKey = await input.preflight.buyer.adapter.getPublicKey();
  const evidenceVerifier = {
    resolvePublicKey: async (signer: string) => signer === input.preflight.env.SELLER_DID
      ? sellerPublicKey
      : null,
    verify: (bytes: Uint8Array, signature: Uint8Array, publicKey: Uint8Array) =>
      ed25519Verify(bytes, signature, publicKeyFromRaw(publicKey)),
  };
  let retainedEvidence: SettlementEvidence | undefined;
  let publication: { ref: AttestationRef; receipt: AnchorReceipt } | undefined;
  let anchorCalls = 0;
  const deps: SellerSessionSettlementPublicationDeps = {
    receiptStore: input.settlement.seller.receiptStore,
    evidenceSigner: {
      algorithm: "ed25519",
      signer: input.preflight.env.SELLER_DID,
      sign: (bytes) => input.preflight.seller.adapter.sign(bytes),
    },
    evidence: evidenceVerifier,
    resolveAuthenticatedNativeProof: async () => {
      const revalidated = await observeFundedTransfer({
        preflight: input.preflight,
        jobId: input.jobId,
        txHash: observation.txHash,
      });
      return revalidated.status === "finalized" && observation.status === "finalized" &&
        sameFinalizedTransfer(revalidated, observation)
        ? proofAuthentication
        : { disposition: "indeterminate", reason: "native-proof-revalidation-mismatch" };
    },
    resolveRetainedSignedEvidence: async (request) => retainedEvidence
      ? {
          disposition: "present",
          effectId: request.effectId,
          evidence: structuredClone(retainedEvidence),
        }
      : { disposition: "absent" },
    anchorEvidence: async ({ logicalAddress, evidence, evidenceHash }) => {
      if (publication || retainedEvidence) {
        requireCondition(
          publication !== undefined && retainedEvidence !== undefined &&
          publication.ref.anchor.locator === logicalAddress &&
          publication.ref.contentHash === evidenceHash &&
          canonicalize(retainedEvidence) === canonicalize(evidence) &&
          await verifyAnchorReceipt(
            input.preflight.buyer.adapter,
            publication.receipt,
            input.preflight.env.SELLER_DID,
          ),
          "settlement-evidence-publication-rebound",
        );
        return {
          disposition: "anchored",
          evidenceRef: structuredClone(publication.ref),
          anchorReceipt: structuredClone(publication.receipt),
        };
      }
      anchorCalls += 1;
      const anchored = await anchorArtifact({
        adapter: input.preflight.seller.adapter,
        writer: input.preflight.env.SELLER_DID,
        logicalAddress,
        artifact: evidence as unknown as Record<string, unknown>,
      });
      requireCondition(anchored.ref.contentHash === evidenceHash, "settlement-evidence-hash-mismatch");
      retainedEvidence = structuredClone(evidence);
      publication = { ref: anchored.ref, receipt: anchored.receipt };
      return {
        disposition: "anchored",
        evidenceRef: anchored.ref,
        anchorReceipt: anchored.receipt,
      };
    },
    verifyAnchorReceipt: async ({ anchorReceipt }) => {
      const valid = await verifyAnchorReceipt(
        input.preflight.seller.adapter,
        anchorReceipt,
        input.preflight.env.SELLER_DID,
      );
      return valid
        ? { disposition: "pass" }
        : { disposition: "fail", reason: "settlement-evidence-anchor-invalid" };
    },
    resolveEvidence: async () => {
      if (!publication) return { disposition: "absent" };
      const artifact = await input.preflight.buyer.adapter.readAnchor(publication.receipt.nativeAddress);
      return artifact && contentHash(artifact) === publication.ref.contentHash
        ? { disposition: "present", evidence: artifact as unknown as SettlementEvidence }
        : { disposition: "indeterminate", reason: "settlement-evidence-readback-mismatch" };
    },
  };
  const request = {
    paymentPermitId: permit.paymentPermitId,
    authorization,
    nativeProofRef,
  };
  const published = await publishSellerSessionSettlement(request, deps);
  requireCondition(published.disposition === "published", "settlement-evidence-publication-failed");
  const replayed = await publishSellerSessionSettlement(request, deps);
  requireCondition(replayed.disposition === "published", "settlement-evidence-replay-failed");
  requireCondition(anchorCalls === 1, "settlement-evidence-effect-replayed");
  requireCondition(
    canonicalize(replayed) === canonicalize(published),
    "settlement-evidence-replay-mismatch",
  );

  const context: SessionSettlementContext = {
    contextVersion: "1",
    jobId: input.jobId,
    agreementRef: input.agreement.agreementRef,
    agreementHash: input.agreement.agreementHash,
    paymentPhaseIndex: PAYMENT_PHASE_INDEX,
    orchestrator: input.preflight.env.SELLER_DID,
    payer: {
      primaryClaim: input.preflight.env.BUYER_DID,
      payingKey: input.preflight.payer,
    },
    payee: {
      primaryClaim: input.preflight.env.SELLER_DID,
      receivingKey: input.preflight.payee,
    },
    paymentAmount: structuredClone(authorization.evidenceInput.paymentAmount),
    rail: {
      railId: input.selectedRail.railId,
      railVersion: input.selectedRail.railVersion!,
      railRegistryVersion: authorization.railRegistryVersion,
      descriptorHash: sha256Hex(canonicalize(input.selectedRail)),
      railType: "x402",
      handler: "pay-x402",
      asset: TOKEN_SYMBOL,
      network: BASE_SEPOLIA_NETWORK,
      finality: { model: "block-depth", finalityBlocks: 1 },
    },
  };
  const provider: SessionSettlementVerificationProvider = {
    authenticateContext: async (candidate) => {
      if (canonicalize(candidate) !== canonicalize(context)) {
        return { disposition: "fail", reason: "settlement-context-mismatch" };
      }
      const [agreementReadback, agreementReceiptValid] = await Promise.all([
        input.preflight.seller.adapter.readAnchor(input.agreement.anchorReceipt.nativeAddress),
        verifyAnchorReceipt(
          input.preflight.seller.adapter,
          input.agreement.anchorReceipt,
          input.preflight.env.BUYER_DID,
        ),
      ]);
      if (!agreementReadback || !agreementReceiptValid ||
          contentHash(agreementReadback) !== input.agreement.agreementHash ||
          canonicalize(agreementReadback) !== canonicalize(input.agreement.agreement)) {
        return { disposition: "fail", reason: "settlement-agreement-binding-invalid" };
      }
      const separator = "agreementVersion" in input.agreement.agreement
        ? ARTIFACT_SEPARATORS.AgreementDocument
        : ARTIFACT_SEPARATORS.PayeeBoundAgreementDocument;
      const agreementBytes = signedBytes(separator, input.agreement.agreementHash);
      const signaturesValid = input.agreement.agreement.signatures.length === 2 &&
        input.agreement.agreement.signatures.every((signature) => {
          const key = signature.party === input.preflight.env.BUYER_DID
            ? buyerPublicKey
            : signature.party === input.preflight.env.SELLER_DID
              ? sellerPublicKey
              : null;
          return signature.algorithm === "ed25519" && key !== null && ed25519Verify(
            agreementBytes,
            Uint8Array.from(Buffer.from(signature.value, "base64url")),
            publicKeyFromRaw(key),
          );
        });
      return signaturesValid
        ? { disposition: "pass" }
        : { disposition: "fail", reason: "settlement-agreement-signatures-invalid" };
    },
    verifyEvidenceAnchor: async ({ evidence, evidenceRef, anchorReceipt }) =>
      publication && canonicalize(evidence) === canonicalize(retainedEvidence) &&
        canonicalize(evidenceRef) === canonicalize(publication.ref) &&
        canonicalize(anchorReceipt) === canonicalize(publication.receipt) &&
        await verifyAnchorReceipt(
          input.preflight.buyer.adapter,
          publication.receipt,
          input.preflight.env.SELLER_DID,
        ) ? { disposition: "pass" } : { disposition: "fail", reason: "anchor-invalid" },
    resolveNativeProof: (candidate) =>
      canonicalize(candidate) === canonicalize(nativeProofRef)
        ? { disposition: "present", artifact: proofArtifact }
        : { disposition: "absent" },
    revalidateSettlement: async (requestValue) => {
      const fresh = await observeFundedTransfer({
        preflight: input.preflight,
        jobId: input.jobId,
        txHash: observation.txHash,
      });
      if (fresh.status !== "finalized") {
        return { disposition: "indeterminate", reason: "evm-revalidation-unavailable" };
      }
      if (observation.status !== "finalized" || !sameFinalizedTransfer(fresh, observation)) {
        return { disposition: "fail", reason: "evm-revalidation-mismatch" };
      }
      return {
        disposition: "pass",
        outcome: "success",
        binding: {
          jobId: requestValue.context.jobId,
          railId: requestValue.context.rail.railId,
          phaseIndex: requestValue.context.paymentPhaseIndex,
          settlementId: authorization.settlementId,
        },
        nativeObservation: {
          observationVersion: "1",
          kind: "authenticated-x402-event",
          observedAt: fresh.finalityObservedAt,
          finality: structuredClone(authorization.evidenceInput.settlementFinality),
          sessionBinding: {
            disposition: "established",
            kind: "eip3009",
            bindingHash: input.settlement.intent.bindingHash,
          },
          details: {
            chainId: fresh.chainId,
            transactionHash: fresh.txHash,
            logIndex: fresh.logIndex,
          },
        },
      };
    },
    evidence: evidenceVerifier,
  };
  const verified = await verifyFinalizedSessionSettlement(context, published.settlement, provider);
  requireCondition(verified.disposition === "verified", "settlement-evidence-verification-failed");
  return {
    settlement: published.settlement,
    context,
    provider,
  };
}

async function closeDurableDetachedRoleBundles(input: {
  preflight: Preflight;
  jobId: string;
  now: number;
  published: PublishedListing;
  agreement: AgreementRun;
  commitment: Awaited<ReturnType<typeof commitAgreement>>;
  settlement: SettlementRun;
  sellerSettlement: Awaited<ReturnType<typeof publishAndVerifySellerSettlement>>;
  buyerIdentity: IdentityBundle;
  sellerIdentity: IdentityBundle;
  vet: VetArtifacts;
}) {
  const suppliedFulfilment = input.settlement.state.fulfilment;
  requireCondition(suppliedFulfilment?.decision === "completed", "recovered-fulfilment-missing");
  const [sellerPublicKey, buyerPublicKey] = await Promise.all([
    input.preflight.seller.adapter.getPublicKey(),
    input.preflight.buyer.adapter.getPublicKey(),
  ]);
  const terminalStore = await createFsFencedSessionStore({
    dir: input.settlement.sellerDirectories.fulfilment,
  });
  const terminalRecord = await terminalStore.load(input.jobId);
  requireCondition(terminalRecord.status === "ok", "terminal-fulfilment-record-missing");
  const commitmentHash = contentHash(
    input.commitment.record as unknown as Record<string, unknown>,
  );
  const commitmentRef: AttestationRef = {
    anchor: { kind: "storage-program", locator: input.commitment.logicalAddress },
    contentHash: commitmentHash,
    signer: input.preflight.env.SELLER_DID,
  };
  const verifiedAgreement: SellerFulfilmentAgreement = {
    artifactKind: "payee-bound",
    ref: input.agreement.agreementRef.anchor.locator,
    contentHash: input.agreement.agreementHash,
    jobId: input.jobId,
    listingPin: input.published.listingPin,
    buyer: {
      primaryClaim: input.preflight.env.BUYER_DID,
      bundleHash: identityBundleHash(input.buyerIdentity),
      vetRecordRef: input.vet.buyerRef,
      storageAddress: input.preflight.buyer.adapter.getAddress(),
    },
    seller: {
      primaryClaim: input.preflight.env.SELLER_DID,
      bundleHash: identityBundleHash(input.sellerIdentity),
      vetRecordRef: input.vet.sellerRef,
    },
    deliverableRef: {
      deliverableType: "storage-program",
      hash: sha256Hex(canonicalize(input.published.listing.offering.deliverable)),
    },
    commitment: {
      status: "finalized",
      ref: input.commitment.logicalAddress,
      agreementHash: input.agreement.agreementHash,
      recordContentHash: commitmentHash,
      finalizedAt: input.commitment.committedAt,
      signer: input.preflight.env.SELLER_DID,
    },
  };
  const verifiedListing: SellerFulfilmentListing = {
    pin: structuredClone(input.published.listingPin),
    sellerPrimaryClaim: input.preflight.env.SELLER_DID,
    buyerRequirement: structuredClone(input.published.listing.buyerRequirement),
    pipeline: structuredClone(input.published.listing.pipeline),
    deliverable: structuredClone(input.published.listing.offering.deliverable),
  };
  const terminalVerification: Parameters<
    typeof projectDurableSellerAuditPending
  >[0] = {
    record: terminalRecord.record,
    verifiedAgreement: structuredClone(verifiedAgreement),
    verifiedListing: structuredClone(verifiedListing),
    expectedDeliveryWriter: {
      role: "seller",
      primaryClaim: input.preflight.env.SELLER_DID,
    },
    verifyEvidenceSignature: async ({ signedBytes: bytes, signature, expectedSigner }) =>
      expectedSigner === input.preflight.env.SELLER_DID &&
        signature.algorithm === "ed25519" && signature.signer === expectedSigner &&
        ed25519Verify(
          bytes,
          Uint8Array.from(Buffer.from(signature.value, "base64url")),
          publicKeyFromRaw(sellerPublicKey),
        ) ? { disposition: "valid" } : {
          disposition: "invalid",
          reason: "terminal-evidence-signature-invalid",
        },
    verifyAuditSourceCommitmentSignature: async ({
      signedBytes: bytes,
      signature,
      expectedSigner,
    }) => expectedSigner === input.preflight.env.SELLER_DID &&
        signature.algorithm === "ed25519" && signature.signer === expectedSigner &&
        ed25519Verify(
          bytes,
          Uint8Array.from(Buffer.from(signature.value, "base64url")),
          publicKeyFromRaw(sellerPublicKey),
        ) ? { disposition: "valid" } : {
          disposition: "invalid",
          reason: "terminal-audit-source-signature-invalid",
        },
    verifyAnchorReceipt: async ({ receipt, expectedWriter }) =>
      expectedWriter.primaryClaim === input.preflight.env.SELLER_DID &&
        await verifyAnchorReceipt(
          input.preflight.buyer.adapter,
          receipt,
          input.preflight.env.SELLER_DID,
        ) ? { disposition: "valid" } : {
          disposition: "invalid",
          reason: "terminal-evidence-receipt-invalid",
        },
  };
  const projection = await projectDurableSellerAuditPending(terminalVerification);
  const verifiedTerminal = projection.terminal;
  const fulfilment = verifiedTerminal.result;
  requireCondition(
    verifiedTerminal.handoff.jobId === input.jobId &&
    verifiedTerminal.handoff.agreementHash === input.agreement.agreementHash &&
    verifiedTerminal.handoff.paymentPhaseIndex === PAYMENT_PHASE_INDEX &&
    verifiedTerminal.handoff.deliveryPhaseIndex === DELIVERY_PHASE_INDEX &&
    verifiedTerminal.binding.fulfilmentId === fulfilment.fulfilmentId &&
    verifiedTerminal.binding.agreementHash === input.agreement.agreementHash &&
    verifiedTerminal.binding.paymentPhaseIndex === PAYMENT_PHASE_INDEX &&
    verifiedTerminal.binding.deliveryPhaseIndex === DELIVERY_PHASE_INDEX,
    "terminal-fulfilment-authority-mismatch",
  );
  const deliveryEvidence = fulfilment.evidence;
  requireCondition(deliveryEvidence.outcome === "success", "delivery-evidence-not-successful");
  const deliverableResolution = await input.preflight.buyer.adapter.resolveAnchorByName(
    deliveryEvidence.deliverableAnchor.locator,
    input.preflight.seller.adapter.getAddress(),
  );
  requireCondition(
    deliverableResolution.status === "present",
    "delivered-artifact-resolution-failed",
  );
  const deliverable = await input.preflight.buyer.adapter.readAnchor(
    deliverableResolution.address,
  );
  requireCondition(
    deliverable !== null && contentHash(deliverable) === deliveryEvidence.deliverableContentHash,
    "delivered-artifact-readback-mismatch",
  );

  const paymentRef = input.sellerSettlement.settlement.evidenceRef;
  const deliveryRef = fulfilment.evidenceRef;
  const finalisedAt = Math.max(Date.now(), input.now + 5_000);
  const sellerInput: FinalizeCompletedSellerBundleDurableInput = {
    agreement: structuredClone(verifiedAgreement),
    verifiedListing: structuredClone(verifiedListing),
    agreementRef: input.agreement.agreementRef,
    fulfilment,
    session: projection.session,
    sessionArtifacts: projection.sessionArtifacts,
    finalisedAt,
    seller: {
      primaryClaim: input.preflight.env.SELLER_DID,
      bundleHash: identityBundleHash(input.sellerIdentity),
      signer: async (bytes, fence) => {
        sellerCounters.sign += 1;
        const value = await input.preflight.seller.adapter.sign(bytes);
        sellerSignatures.set(fence.idempotencyKey, Uint8Array.from(value));
        return value;
      },
    },
    bindingSigner: {
      algorithm: "ed25519",
      signer: input.preflight.env.SELLER_DID,
      sign: async (bytes, _context, fence) => {
        sellerCounters.bindingSign += 1;
        const value = await input.preflight.seller.adapter.sign(bytes);
        sellerSignatures.set(fence.idempotencyKey, Uint8Array.from(value));
        return value;
      },
    },
    counterSignatures: [],
    dependencies: [],
  };

  const deliveryReceipt = structuredClone(verifiedTerminal.deliveryAnchorReceipt);
  requireCondition(
    deliveryReceipt.logicalAddress === deliveryEvidence.deliverableAnchor.locator &&
    deliveryReceipt.nativeAddress === deliverableResolution.address &&
    deliveryReceipt.contentHash === deliveryEvidence.deliverableContentHash &&
    deliveryReceipt.writer === input.preflight.env.SELLER_DID,
    "authenticated-delivery-receipt-rebound",
  );
  const dependency = (
    source: FinalizeCompletedSellerBundleInput["dependencies"][number]["source"],
    anchorReceipt: AnchorReceipt,
  ): FinalizeCompletedSellerBundleInput["dependencies"][number] => ({
    source,
    anchorReceipt,
  });
  sellerInput.dependencies = [
    dependency({ kind: "listing", listingRef: input.published.listingPin }, input.published.receipt),
    dependency({ kind: "attestation-ref", ref: input.agreement.agreementRef }, input.agreement.anchorReceipt),
    dependency({ kind: "attestation-ref", ref: commitmentRef }, input.commitment.anchorReceipt),
    dependency({ kind: "attestation-ref", ref: paymentRef }, input.sellerSettlement.settlement.anchorReceipt),
    dependency({ kind: "attestation-ref", ref: deliveryRef }, fulfilment.evidenceAnchorReceipt),
    dependency({ kind: "attestation-ref", ref: input.vet.buyerRef }, input.vet.buyerReceipt),
    dependency({ kind: "attestation-ref", ref: input.vet.sellerRef }, input.vet.sellerReceipt),
    dependency({
      kind: "deliverable",
      anchor: deliveryEvidence.deliverableAnchor,
      contentHash: deliveryEvidence.deliverableContentHash,
      encoding: "jcs",
    }, deliveryReceipt),
  ];

  const publicKey = (claim: string): Uint8Array | null =>
    claim === input.preflight.env.SELLER_DID ? sellerPublicKey
      : claim === input.preflight.env.BUYER_DID ? buyerPublicKey
      : null;
  const verifyEd25519 = (
    separator: string,
    artifact: Record<string, unknown>,
    signature: { algorithm: string; signer?: string; party?: string; value: string },
    expectedSigner: string,
  ): boolean => {
    const key = publicKey(expectedSigner);
    return key !== null && verifyEd25519ArtifactSignature(
      separator,
      artifact,
      signature,
      expectedSigner,
      key,
    );
  };
  const writerByNativeAddress = new Map<string, string>([
    [input.published.receipt.nativeAddress, input.preflight.env.SELLER_DID],
    [input.agreement.anchorReceipt.nativeAddress, input.preflight.env.BUYER_DID],
    [input.commitment.anchorReceipt.nativeAddress, input.preflight.env.SELLER_DID],
    [input.sellerSettlement.settlement.anchorReceipt.nativeAddress, input.preflight.env.SELLER_DID],
    [fulfilment.evidenceAnchorReceipt.nativeAddress, input.preflight.env.SELLER_DID],
    [input.vet.buyerReceipt.nativeAddress, input.preflight.env.SELLER_DID],
    [input.vet.sellerReceipt.nativeAddress, input.preflight.env.BUYER_DID],
    [deliveryReceipt.nativeAddress, input.preflight.env.SELLER_DID],
  ]);

  let sellerAnchored: AnchoredSellerBundle | undefined;
  let buyerAnchored: AnchoredBuyerBundle | undefined;
  const sellerCounters = { sign: 0, bindingSign: 0, anchor: 0, bindingPublication: 0 };
  const buyerCounters = { sign: 0, counterPublication: 0, anchor: 0, bindingPublication: 0 };
  const sellerSignatures = new Map<string, Uint8Array>();
  const buyerSignatures = new Map<string, string>();
  const requestLogicalAddress = `dacs-test:bundle-request:${input.jobId}`;
  const counterSignatureLogicalAddress = `dacs-test:bundle-counter-signature:${input.jobId}`;
  const sellerFinalizationLogicalAddress = `dacs-test:bundle-finalization:${input.jobId}:seller`;
  const buyerFinalizationLogicalAddress = `dacs-test:bundle-finalization:${input.jobId}:buyer`;
  const sellerBindingLogicalAddress = `dacs-test:bundle-binding:${input.jobId}:seller`;
  const buyerBindingLogicalAddress = `dacs-test:bundle-binding:${input.jobId}:buyer`;
  const resolveHandoff = async (logicalAddress: string, ownerDid: string) => {
    const owner = ownerDid.replace(/^did:demos:agent:/, "");
    const resolved = await input.preflight.buyer.adapter.resolveAnchorByName(logicalAddress, owner);
    if (resolved.status === "indeterminate") {
      throw new Error("funded-e2e:demos-handoff-resolution-indeterminate");
    }
    if (resolved.status !== "present") return null;
    const artifact = await input.preflight.buyer.adapter.readAnchor(resolved.address);
    if (artifact === null) {
      throw new Error("funded-e2e:demos-handoff-read-indeterminate");
    }
    return artifact;
  };
  const resolveRoleOwnedBundle = async (
    role: "buyer" | "seller",
  ): Promise<AnchoredSellerBundle | null> => {
    const logicalAddress = bundleAddress(input.jobId, role);
    const ownerDid = role === "seller"
      ? input.preflight.env.SELLER_DID : input.preflight.env.BUYER_DID;
    const resolved = await input.preflight.buyer.adapter.resolveAnchorByName(
      logicalAddress,
      ownerDid.replace(/^did:demos:agent:/, ""),
    );
    if (resolved.status === "indeterminate") {
      throw new Error("funded-e2e:role-bundle-resolution-indeterminate");
    }
    if (resolved.status !== "present") return null;
    const bundle = await input.preflight.buyer.adapter.readAnchor(resolved.address);
    if (!bundle) throw new Error("funded-e2e:role-bundle-read-indeterminate");
    const hash = attestationBundleHash(bundle as unknown as FaultAttestationBundle);
    const cached = role === "seller" ? sellerAnchored : buyerAnchored;
    if (cached) {
      if (
        cached.nativeAddress !== resolved.address ||
        cached.anchorReceipt.logicalAddress !== logicalAddress ||
        cached.anchorReceipt.contentHash !== hash
      ) return null;
      return {
        bundle,
        nativeAddress: resolved.address,
        anchorReceipt: cached.anchorReceipt,
        ...(cached.anchorTx ? { anchorTx: cached.anchorTx } : {}),
      };
    }

    // A cold runtime must recover the exact original receipt and transaction
    // pointer from an owner-bound finalization handoff. A successful Demos read
    // is not itself an anchor receipt and must never be promoted into one.
    const finalizationLogicalAddress = role === "seller"
      ? sellerFinalizationLogicalAddress : buyerFinalizationLogicalAddress;
    const stored = await resolveHandoff(finalizationLogicalAddress, ownerDid);
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return null;
    const finalization = stored as Record<string, unknown>;
    const retainedBundle = role === "seller"
      ? finalization.sellerBundle : finalization.buyerBundle;
    const receiptCandidate = finalization.anchorReceipt;
    if (
      finalization.state !== "finalised" ||
      finalization.logicalAddress !== logicalAddress ||
      finalization.nativeAddress !== resolved.address ||
      finalization.bundleContentHash !== hash ||
      !retainedBundle || typeof retainedBundle !== "object" || Array.isArray(retainedBundle) ||
      canonicalize(retainedBundle) !== canonicalize(bundle) ||
      !receiptCandidate || typeof receiptCandidate !== "object" || Array.isArray(receiptCandidate) ||
      (finalization.anchorTx !== undefined && typeof finalization.anchorTx !== "string")
    ) return null;
    const receipt = receiptCandidate as unknown as AnchorReceipt;
    if (
      receipt.logicalAddress !== logicalAddress ||
      receipt.nativeAddress !== resolved.address ||
      receipt.contentHash !== hash ||
      !(await verifyAnchorReceipt(input.preflight.buyer.adapter, receipt, ownerDid))
    ) return null;
    return {
      bundle,
      nativeAddress: resolved.address,
      anchorReceipt: receipt,
      ...(typeof finalization.anchorTx === "string"
        ? { anchorTx: finalization.anchorTx }
        : {}),
    };
  };
  const bundleCopyVerifier = {
    resolvePublicKey: async (claim: string) => publicKey(claim),
    verify: async (bytes: Uint8Array, signature: Uint8Array, key: Uint8Array) =>
      ed25519Verify(bytes, signature, publicKeyFromRaw(key)),
  };
  const bindingRole = (
    logicalAddress: string,
    signer: string,
  ): "buyer" | "seller" | null =>
    logicalAddress === bundleAddress(input.jobId, "seller") &&
        signer === input.preflight.env.SELLER_DID
      ? "seller"
      : logicalAddress === bundleAddress(input.jobId, "buyer") &&
          signer === input.preflight.env.BUYER_DID
        ? "buyer"
        : null;
  const resolveBundleBinding = async (logicalAddress: string, signer: string) => {
    const role = bindingRole(logicalAddress, signer);
    if (!role) return { disposition: "absent" as const };
    const ownerDid = role === "seller"
      ? input.preflight.env.SELLER_DID : input.preflight.env.BUYER_DID;
    const bindingAddress = role === "seller"
      ? sellerBindingLogicalAddress : buyerBindingLogicalAddress;
    const stored = await resolveHandoff(bindingAddress, ownerDid);
    return stored === null
      ? { disposition: "absent" as const }
      : { disposition: "present" as const, binding: stored };
  };
  const verifyBundleBinding = async (binding: Readonly<BundleBinding>) => {
    const role = bindingRole(binding.logicalAddress, binding.signer);
    const signatureValue = binding.signature?.value;
    if (
      !role || binding.bindingVersion !== "1" || binding.jobId !== input.jobId ||
      binding.role !== role || binding.signature?.algorithm !== "ed25519" ||
      binding.signature.signer !== binding.signer || typeof signatureValue !== "string"
    ) return "invalid" as const;
    const signature = Buffer.from(signatureValue, "base64url");
    const key = publicKey(binding.signer);
    if (
      signature.byteLength !== 64 || signature.toString("base64url") !== signatureValue || !key ||
      !ed25519Verify(
        signedBytes(
          BUNDLE_BINDING_SEPARATOR,
          contentHash(binding as unknown as Record<string, unknown>),
        ),
        Uint8Array.from(signature),
        publicKeyFromRaw(key),
      )
    ) return "invalid" as const;
    const anchored = await resolveRoleOwnedBundle(role);
    return anchored &&
        anchored.nativeAddress === binding.nativeAddress &&
        anchored.anchorReceipt.logicalAddress === binding.logicalAddress &&
        anchored.anchorReceipt.contentHash === binding.bundleContentHash &&
        attestationBundleHash(anchored.bundle as FaultAttestationBundle) ===
          binding.bundleContentHash &&
        (binding.anchorTx === undefined || anchored.anchorTx === binding.anchorTx)
      ? "valid" as const : "invalid" as const;
  };
  const publishRoleBundleBinding = async (
    role: "buyer" | "seller",
    binding: Readonly<BundleBinding>,
  ) => {
    const expectedSigner = role === "seller"
      ? input.preflight.env.SELLER_DID : input.preflight.env.BUYER_DID;
    const expectedLogicalAddress = bundleAddress(input.jobId, role);
    if (
      binding.role !== role || binding.signer !== expectedSigner ||
      binding.logicalAddress !== expectedLogicalAddress ||
      await verifyBundleBinding(binding) !== "valid"
    ) return { disposition: "rejected" as const, reason: "bundle-binding-invalid" };
    const bindingAddress = role === "seller"
      ? sellerBindingLogicalAddress : buyerBindingLogicalAddress;
    const adapter = role === "seller"
      ? input.preflight.seller.adapter : input.preflight.buyer.adapter;
    if (role === "seller") sellerCounters.bindingPublication += 1;
    else buyerCounters.bindingPublication += 1;
    await anchorArtifact({
      adapter,
      writer: expectedSigner,
      logicalAddress: bindingAddress,
      artifact: binding as unknown as Record<string, unknown>,
    });
    const published = await resolveBundleBinding(binding.logicalAddress, binding.signer);
    return published.disposition === "present" &&
        canonicalize(published.binding) === canonicalize(binding) &&
        await verifyBundleBinding(binding) === "valid"
      ? { disposition: "published" as const }
      : { disposition: "indeterminate" as const, reason: "bundle-binding-readback-failed" };
  };
  const reconcileRoleBindingPublication = async (
    role: "buyer" | "seller",
    binding: Readonly<BundleBinding>,
  ) => {
    try {
      const expectedSigner = role === "seller"
        ? input.preflight.env.SELLER_DID : input.preflight.env.BUYER_DID;
      if (
        binding.role !== role || binding.signer !== expectedSigner ||
        binding.logicalAddress !== bundleAddress(input.jobId, role)
      ) return { disposition: "rejected" as const, reason: "bundle-binding-rebound" };
      const published = await resolveBundleBinding(binding.logicalAddress, binding.signer);
      if (published.disposition === "absent") {
        return {
          disposition: "authoritatively-absent" as const,
          reason: "bundle-binding-absent",
        };
      }
      return canonicalize(published.binding) === canonicalize(binding) &&
          await verifyBundleBinding(binding) === "valid"
        ? { disposition: "published" as const }
        : { disposition: "rejected" as const, reason: "bundle-binding-readback-invalid" };
    } catch {
      return { disposition: "indeterminate" as const, reason: "bundle-binding-readback-error" };
    }
  };
  const commonReadProvider = {
    mapping: "write-input" as const,
    bundleCopyVerifier,
    compositeVerificationDeps: {
      resolveRecipe: async () => null,
      isRecipeSignerAuthorized: () => false,
      isVerifyResultSignerAuthorized: (result: unknown, signature: { signer: string }) => {
        if (!result || typeof result !== "object" || Array.isArray(result)) return false;
        const evaluatedParty = (result as Record<string, unknown>).evaluatedParty;
        return (evaluatedParty === input.preflight.env.BUYER_DID ||
          evaluatedParty === input.preflight.env.SELLER_DID) &&
          signature.signer === input.preflight.env.SELLER_DID;
      },
      resolvePublicKey: async (signature: { signer: string; algorithm: string }) =>
        signature.algorithm === "ed25519" ? publicKey(signature.signer) : null,
      verify: ({ signedBytes: bytes, signature, publicKey: key }: {
        signedBytes: Uint8Array;
        signature: { value: string };
        publicKey: Uint8Array;
      }) => ed25519Verify(
        bytes,
        Uint8Array.from(Buffer.from(signature.value, "base64url")),
        publicKeyFromRaw(key),
      ),
      verifyAuthorityAttestation: () => "unresolved" as const,
    },
    resolveDependency: async (candidate: FinalizeCompletedSellerBundleInput["dependencies"][number]) => {
      const artifact = await input.preflight.buyer.adapter.readAnchor(
        candidate.anchorReceipt.nativeAddress,
      );
      return artifact === null
        ? { disposition: "absent" as const }
        : { disposition: "present" as const, artifact };
    },
    verifyDependencyReceipt: async (
      candidate: FinalizeCompletedSellerBundleInput["dependencies"][number],
    ) => {
      const writer = writerByNativeAddress.get(candidate.anchorReceipt.nativeAddress);
      if (!writer) return "invalid" as const;
      return await verifyAnchorReceipt(
        input.preflight.buyer.adapter,
        candidate.anchorReceipt,
        writer,
      ) ? "valid" as const : "invalid" as const;
    },
    verifyDependencyBinding: async ({ requirement, artifact }: {
      requirement: { contentHash: string };
      artifact: unknown;
    }) => {
      if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
        return "invalid" as const;
      }
      const record = artifact as Record<string, unknown>;
      if (contentHash(record) !== requirement.contentHash) return "invalid" as const;
      if (requirement.contentHash === input.published.listingPin.contentHash) {
        const validation = await validateListingArtifact(
          record,
          listingValidationDeps({
            sellerDid: input.preflight.env.SELLER_DID,
            sellerPublicKey,
            selectedRail: rail(input.preflight.host.resourceUrl),
            now: input.commitment.committedAt,
          }),
        );
        return validation.disposition === "verified" ? "valid" as const : "invalid" as const;
      }
      if (requirement.contentHash === input.agreement.agreementRef.contentHash) {
        if (canonicalize(record) !== canonicalize(input.agreement.agreement)) return "invalid" as const;
        try {
          validateFixedPriceAgreementBinding({
            agreement: input.agreement.agreement,
            verifiedListing: {
              disposition: "verified",
              listing: input.published.listing,
              pin: input.published.listingPin,
            },
            committedAt: input.commitment.committedAt,
          });
        } catch {
          return "invalid" as const;
        }
        const separator = "agreementVersion" in input.agreement.agreement
          ? ARTIFACT_SEPARATORS.AgreementDocument
          : ARTIFACT_SEPARATORS.PayeeBoundAgreementDocument;
        return input.agreement.agreement.signatures.every((signature) =>
          verifyEd25519(
            separator,
            input.agreement.agreement as unknown as Record<string, unknown>,
            signature,
            signature.party,
          )
        ) ? "valid" as const : "invalid" as const;
      }
      if (requirement.contentHash === commitmentHash) {
        return verifyEd25519(
          FINALITY_COMMITMENT_SEPARATOR,
          input.commitment.record as unknown as Record<string, unknown>,
          input.commitment.record.signature,
          input.preflight.env.SELLER_DID,
        ) ? "valid" as const : "invalid" as const;
      }
      if (requirement.contentHash === paymentRef.contentHash) {
        return verifyEd25519(
          ARTIFACT_SEPARATORS.SettlementEvidence,
          input.sellerSettlement.settlement.evidence as unknown as Record<string, unknown>,
          input.sellerSettlement.settlement.evidence.signature,
          input.preflight.env.SELLER_DID,
        ) ? "valid" as const : "invalid" as const;
      }
      if (requirement.contentHash === deliveryRef.contentHash) {
        return verifyEd25519(
          ARTIFACT_SEPARATORS.SettlementEvidence,
          deliveryEvidence as unknown as Record<string, unknown>,
          deliveryEvidence.signature,
          input.preflight.env.SELLER_DID,
        ) ? "valid" as const : "invalid" as const;
      }
      if (requirement.contentHash === input.vet.buyerRef.contentHash ||
          requirement.contentHash === input.vet.sellerRef.contentHash) {
        const vetRecord = requirement.contentHash === input.vet.buyerRef.contentHash
          ? input.vet.buyer : input.vet.seller;
        const verifier = input.preflight.env.SELLER_DID;
        return canonicalize(record) === canonicalize(vetRecord) && verifyEd25519(
          ARTIFACT_SEPARATORS.CompositeVerificationRecord,
          vetRecord as unknown as Record<string, unknown>,
          vetRecord.signature,
          verifier,
        ) ? "valid" as const : "invalid" as const;
      }
      if (requirement.contentHash === deliveryEvidence.deliverableContentHash) {
        return canonicalize(record) === canonicalize(deliverable) ? "valid" as const : "invalid" as const;
      }
      return "invalid" as const;
    },
    verifyListingPublisherIdentityLinkage: ({
      listingIdentity,
      listingBundleHash,
      sessionBundleHash,
      primaryClaim,
    }: {
      listingIdentity: Readonly<IdentityBundle>;
      listingBundleHash: string;
      sessionBundleHash: string;
      primaryClaim: string;
    }) => primaryClaim === input.preflight.env.SELLER_DID &&
      listingIdentity.presentedBy === primaryClaim &&
      listingIdentity.claims.some(({ ref }) => ref === primaryClaim) &&
      listingBundleHash === identityBundleHash(input.published.listing.seller.identity) &&
      sessionBundleHash === identityBundleHash(input.sellerIdentity)
        ? "valid" as const : "invalid" as const,
    verifyVetRequirementProvenance: async ({ invocation, compositeRecord, listingOwned }: {
      invocation: FinalizeCompletedSellerBundleInput["sessionArtifacts"]["vetRequirements"][number];
      compositeRecord: Readonly<CompositeVerificationRecord>;
      listingOwned: boolean;
    }) => {
      if (listingOwned) {
        return invocation.evaluatedParty === input.preflight.env.BUYER_DID &&
          invocation.verifier === input.preflight.env.SELLER_DID &&
          canonicalize(invocation.requirement) === canonicalize(input.published.listing.buyerRequirement) &&
          canonicalize(compositeRecord) === canonicalize(input.vet.buyer)
          ? "valid" as const : "invalid" as const;
      }
      const publishedProvenance = await input.preflight.buyer.adapter.readAnchor(
        input.vet.externalSellerProvenanceReceipt.nativeAddress,
      );
      const receiptValid = await verifyAnchorReceipt(
        input.preflight.buyer.adapter,
        input.vet.externalSellerProvenanceReceipt,
        input.preflight.env.BUYER_DID,
      );
      const provenance = input.vet.externalSellerProvenance;
      const { signature, ...unsigned } = provenance;
      const signatureValid = verifyEd25519(
        EXTERNAL_VET_PROVENANCE_SEPARATOR,
        unsigned,
        signature,
        input.preflight.env.BUYER_DID,
      );
      return receiptValid && publishedProvenance !== null &&
        canonicalize(publishedProvenance) === canonicalize(provenance) &&
        invocation.evaluatedParty === provenance.evaluatedParty &&
        invocation.verifier === provenance.verifier &&
        sha256Hex(canonicalize(invocation.requirement)) === provenance.requirementHash &&
        canonicalize(compositeRecord) === canonicalize(input.vet.seller) &&
        contentHash(compositeRecord as unknown as Record<string, unknown>) === provenance.vetRecordHash &&
        signatureValid ? "valid" as const : "invalid" as const;
    },
    resolvePaymentPhaseIndex: ({ dependency: candidate, evidence }: {
      dependency: FinalizeCompletedSellerBundleInput["dependencies"][number];
      evidence: Record<string, unknown>;
    }) => {
      const authorization = input.settlement.state.permit?.paymentAuthorization;
      const exactEvidence = input.sellerSettlement.settlement.evidence;
      const exact = authorization !== undefined &&
        contentHash(evidence) === paymentRef.contentHash &&
        canonicalize(evidence) === canonicalize(exactEvidence) &&
        exactEvidence.phase === "pay-x402" && exactEvidence.outcome === "success" &&
        exactEvidence.jobId === authorization.jobId &&
        authorization.jobId === input.settlement.intent.jobId &&
        authorization.phaseIndex === input.settlement.intent.phaseIndex &&
        authorization.railId === input.settlement.intent.railId &&
        canonicalize(exactEvidence.paymentTxRefs) ===
          canonicalize(authorization.evidenceInput.paymentTxRefs) &&
        canonicalize(exactEvidence.paymentAmount) ===
          canonicalize(authorization.evidenceInput.paymentAmount) &&
        paymentRef.anchor.locator === candidate.anchorReceipt.logicalAddress &&
        candidate.anchorReceipt.contentHash === paymentRef.contentHash &&
        input.sellerSettlement.settlement.nativeProofRef.locator.includes(
          authorization.settlementIdentity.txHash,
        );
      return exact
        ? {
            disposition: "valid" as const,
            jobId: authorization.jobId,
            railId: authorization.railId,
            phaseIndex: authorization.phaseIndex,
            resolved: false,
          }
        : { disposition: "invalid" as const, reason: "payment-anchor-binding-invalid" };
    },
    resolveSellerBundle: async (logicalAddress: string) => {
      if (logicalAddress !== bundleAddress(input.jobId, "seller")) {
        return { disposition: "absent" as const };
      }
      const anchored = await resolveRoleOwnedBundle("seller");
      return anchored
        ? { disposition: "present" as const, anchored }
        : { disposition: "absent" as const };
    },
    verifyBundleAnchorReceipt: async (anchored: AnchoredSellerBundle) => {
      const role = anchored.anchorReceipt.logicalAddress === bundleAddress(input.jobId, "seller")
        ? "seller" : anchored.anchorReceipt.logicalAddress === bundleAddress(input.jobId, "buyer")
          ? "buyer" : null;
      if (!role) return "invalid" as const;
      const writer = role === "seller" ? input.preflight.env.SELLER_DID : input.preflight.env.BUYER_DID;
      const valid = await verifyAnchorReceipt(
        input.preflight.buyer.adapter,
        anchored.anchorReceipt,
        writer,
      );
      return valid && attestationBundleHash(anchored.bundle as FaultAttestationBundle) ===
          anchored.anchorReceipt.contentHash ? "valid" as const : "invalid" as const;
    },
    resolveBundleBinding,
    verifyBundleBinding,
  };

  const sellerProvider = {
    ...commonReadProvider,
    publishBundleBinding: async (
      binding: Readonly<BundleBinding>,
      _fence: Readonly<SellerBundleEffectFence>,
    ) => publishRoleBundleBinding("seller", binding),
    submitSellerBundle: async (
      logicalAddress: string,
      bundle: Readonly<FaultAttestationBundle>,
      _fence: Readonly<SellerBundleEffectFence>,
    ) => {
      sellerCounters.anchor += 1;
      const anchored = await anchorArtifact({
        adapter: input.preflight.seller.adapter,
        writer: input.preflight.env.SELLER_DID,
        logicalAddress,
        artifact: bundle as unknown as Record<string, unknown>,
      });
      sellerAnchored = {
        bundle: structuredClone(bundle),
        nativeAddress: anchored.receipt.nativeAddress,
        anchorReceipt: anchored.receipt,
        anchorTx: anchored.receipt.transactionRef.value,
      };
    },
  } satisfies DurableSellerBundleFinalizationProvider;

  const buyerProvider = {
    ...commonReadProvider,
    publishBundleBinding: async (
      binding: Readonly<BundleBinding>,
      _fence: Readonly<BuyerBundleEffectFence>,
    ) => publishRoleBundleBinding("buyer", binding),
    resolveBuyerBundle: async (logicalAddress: string) => {
      if (logicalAddress !== bundleAddress(input.jobId, "buyer")) {
        return { disposition: "absent" as const };
      }
      const anchored = await resolveRoleOwnedBundle("buyer");
      return anchored
        ? { disposition: "present" as const, anchored }
        : { disposition: "absent" as const };
    },
    submitBuyerBundle: async (
      logicalAddress: string,
      bundle: Readonly<FaultAttestationBundle>,
      _fence: Readonly<BuyerBundleEffectFence>,
    ) => {
      buyerCounters.anchor += 1;
      const anchored = await anchorArtifact({
        adapter: input.preflight.buyer.adapter,
        writer: input.preflight.env.BUYER_DID,
        logicalAddress,
        artifact: bundle as unknown as Record<string, unknown>,
      });
      buyerAnchored = {
        bundle: structuredClone(bundle),
        nativeAddress: anchored.receipt.nativeAddress,
        anchorReceipt: anchored.receipt,
        anchorTx: anchored.receipt.transactionRef.value,
      };
    },
  } satisfies DurableBuyerBundleFinalizationProvider;

  const {
    seller: sellerSigner,
    counterSignatures: _counterSignatures,
    bindingSigner: _bindingSigner,
    ...verificationFacts
  } = sellerInput;
  const requestVerificationInput = {
    ...verificationFacts,
    seller: {
      primaryClaim: sellerSigner.primaryClaim,
      bundleHash: sellerSigner.bundleHash,
    },
  };
  const requestInput: FinalizeCompletedSellerBundleInput = {
    ...verificationFacts,
    seller: {
      primaryClaim: sellerSigner.primaryClaim,
      bundleHash: sellerSigner.bundleHash,
      signer: () => {
        throw new Error("counter-signature request preparation must not sign");
      },
    },
  };
  const request = prepareCompletedSellerBundleCounterSignatureRequest(requestInput);
  await anchorArtifact({
    adapter: input.preflight.seller.adapter,
    writer: input.preflight.env.SELLER_DID,
    logicalAddress: requestLogicalAddress,
    artifact: {
      bundleContentHash: request.bundleContentHash,
      signedScope: request.signedScope,
      signedBytes: Buffer.from(request.signedBytes).toString("base64url"),
      requiredCounterSigners: request.requiredCounterSigners,
    },
  });
  const resolvePublishedRequest = async () => {
    const stored = await resolveHandoff(requestLogicalAddress, input.preflight.env.SELLER_DID);
    if (!stored || typeof stored.signedBytes !== "string") return null;
    return {
      bundleContentHash: stored.bundleContentHash,
      signedScope: stored.signedScope,
      signedBytes: Uint8Array.from(Buffer.from(stored.signedBytes, "base64url")),
      requiredCounterSigners: stored.requiredCounterSigners,
    };
  };
  let counterSignature: BundleSignature | undefined;
  let sellerFinalization: FinalizedSellerBundle | undefined;
  const buyerBundleDir = await temporaryDirectory("buyer-bundle");
  let buyerBundleStore = await createFsFencedSessionStore({ dir: buyerBundleDir });
  await buyerBundleStore.create({
    jobId: input.jobId,
    agreementHash: input.agreement.agreementHash,
    phase: "settled",
    now: finalisedAt,
  });
  const buyerInput: DurableBuyerBundleFinalizationInput = {
    sellerVerificationInput: requestVerificationInput,
    settlementContext: input.sellerSettlement.context,
    settlement: input.sellerSettlement.settlement,
    buyer: {
      primaryClaim: input.preflight.env.BUYER_DID,
      bundleHash: identityBundleHash(input.buyerIdentity),
      signer: async (bytes, fence) => {
        buyerCounters.sign += 1;
        const signature = Buffer.from(
          await input.preflight.buyer.adapter.sign(bytes),
        ).toString("base64url");
        buyerSignatures.set(fence.idempotencyKey, signature);
        return signature;
      },
    },
  };
  const buyerDurability = (workerId: string): BuyerBundleFinalizationDurability => ({
    store: buyerBundleStore,
    workerId,
    leaseTtlMs: LEASE_DURATION_MS,
    leaseNowMs: Date.now,
    settlementVerification: input.sellerSettlement.provider,
    transport: {
      resolveSellerRequest: async () => {
        const stored = await resolvePublishedRequest();
        return stored
          ? { disposition: "present", value: stored }
          : { disposition: "absent", reason: "seller-request-pending" };
      },
      publishCounterSignature: async (publication) => {
        buyerCounters.counterPublication += 1;
        counterSignature = structuredClone(publication.signature);
        await anchorArtifact({
          adapter: input.preflight.buyer.adapter,
          writer: input.preflight.env.BUYER_DID,
          logicalAddress: counterSignatureLogicalAddress,
          artifact: {
            requestHash: publication.requestHash,
            signature: publication.signature,
          },
        });
        return { disposition: "published" };
      },
      resolveCounterSignatures: async () => {
        const stored = await resolveHandoff(
          counterSignatureLogicalAddress,
          input.preflight.env.BUYER_DID,
        );
        return stored?.signature
          ? { disposition: "present", value: [stored.signature] }
          : { disposition: "absent", reason: "buyer-counter-signature-pending" };
      },
      resolveSellerFinalization: async () => {
        const stored = await resolveHandoff(
          sellerFinalizationLogicalAddress,
          input.preflight.env.SELLER_DID,
        );
        return stored
          ? { disposition: "present", value: stored }
          : { disposition: "absent", reason: "seller-finalization-pending" };
      },
    },
    reconcileSignature: ({ fence }) => {
      const value = buyerSignatures.get(fence.idempotencyKey);
      return value
        ? { disposition: "signed", value }
        : { disposition: "authoritatively-absent", reason: "buyer-signature-absent" };
    },
    reconcileCounterSignaturePublication: async ({ signature }) => {
      const stored = await resolveHandoff(
        counterSignatureLogicalAddress,
        input.preflight.env.BUYER_DID,
      );
      return stored?.signature && canonicalize(stored.signature) === canonicalize(signature)
        ? { disposition: "present", signature: stored.signature as BundleSignature }
        : { disposition: "authoritatively-absent", reason: "counter-signature-absent" };
    },
    reconcileBuyerBundleAnchor: async ({ logicalAddress, bundleContentHash }) => {
      const anchored = await resolveRoleOwnedBundle("buyer");
      return anchored && anchored.anchorReceipt.logicalAddress === logicalAddress &&
          anchored.anchorReceipt.contentHash === bundleContentHash &&
          await verifyAnchorReceipt(
            input.preflight.seller.adapter,
            anchored.anchorReceipt,
            input.preflight.env.BUYER_DID,
          )
        ? { disposition: "present" }
        : { disposition: "authoritatively-absent", reason: "buyer-bundle-absent" };
    },
    reconcileBindingPublication: (binding) =>
      reconcileRoleBindingPublication("buyer", binding),
  });
  const waiting = await advanceCompletedBuyerBundleDurable(
    buyerInput,
    buyerProvider,
    buyerDurability("funded-buyer-bundle-process-a"),
  );
  requireCondition(
    waiting.disposition === "waiting" && waiting.stage === "seller-finalisation" &&
    counterSignature !== undefined,
    "buyer-counter-signature-handoff-failed",
  );
  sellerInput.counterSignatures = [counterSignature];
  const sellerDurability = (
    store: SellerBundleFinalizationDurability["store"],
    workerId: string,
  ): SellerBundleFinalizationDurability => ({
    store,
    workerId,
    leaseTtlMs: LEASE_DURATION_MS,
    leaseNowMs: Date.now,
    terminalVerification: {
      verifyEvidenceSignature: async ({ signedBytes: bytes, signature, expectedSigner }) => {
        const key = publicKey(expectedSigner);
        return key && signature.algorithm === "ed25519" &&
          signature.signer === expectedSigner && ed25519Verify(
            bytes,
            Uint8Array.from(Buffer.from(signature.value, "base64url")),
            publicKeyFromRaw(key),
          ) ? { disposition: "valid" } : {
            disposition: "invalid",
            reason: "terminal-evidence-signature-invalid",
          };
      },
      verifyAuditSourceCommitmentSignature: async ({
        signedBytes: bytes,
        signature,
        expectedSigner,
      }) => {
        const key = publicKey(expectedSigner);
        return key && signature.algorithm === "ed25519" &&
          signature.signer === expectedSigner && ed25519Verify(
            bytes,
            Uint8Array.from(Buffer.from(signature.value, "base64url")),
            publicKeyFromRaw(key),
          ) ? { disposition: "valid" } : {
            disposition: "invalid",
            reason: "terminal-audit-source-signature-invalid",
          };
      },
      verifyAnchorReceipt: async ({ receipt, expectedWriter }) =>
        expectedWriter.primaryClaim === input.preflight.env.SELLER_DID &&
          await verifyAnchorReceipt(
            input.preflight.buyer.adapter,
            receipt,
            input.preflight.env.SELLER_DID,
          ) ? { disposition: "valid" } : {
            disposition: "invalid",
            reason: "terminal-evidence-receipt-invalid",
          },
    },
    reconcileSignature: ({ fence }) => {
      const value = sellerSignatures.get(fence.idempotencyKey);
      return value
        ? { disposition: "signed", value: Uint8Array.from(value) }
        : { disposition: "authoritatively-absent", reason: "seller-signature-absent" };
    },
    reconcileBundleAnchor: async ({ logicalAddress, bundleContentHash }) => {
      const anchored = await resolveRoleOwnedBundle("seller");
      return anchored && anchored.anchorReceipt.logicalAddress === logicalAddress &&
          anchored.anchorReceipt.contentHash === bundleContentHash &&
          await verifyAnchorReceipt(
            input.preflight.buyer.adapter,
            anchored.anchorReceipt,
            input.preflight.env.SELLER_DID,
          )
        ? { disposition: "present" }
        : { disposition: "authoritatively-absent", reason: "seller-bundle-absent" };
    },
    reconcileBindingPublication: (binding) =>
      reconcileRoleBindingPublication("seller", binding),
  });
  sellerFinalization = await finalizeCompletedSellerBundleDurable(
    sellerInput,
    sellerProvider,
    sellerDurability(input.settlement.seller.fulfilmentStore, "funded-seller-bundle-process-a"),
  );
  await anchorArtifact({
    adapter: input.preflight.seller.adapter,
    writer: input.preflight.env.SELLER_DID,
    logicalAddress: sellerFinalizationLogicalAddress,
    artifact: sellerFinalization as unknown as Record<string, unknown>,
  });
  buyerBundleStore = await createFsFencedSessionStore({ dir: buyerBundleDir });
  const buyerFinalization = await advanceCompletedBuyerBundleDurable(
    buyerInput,
    buyerProvider,
    buyerDurability("funded-buyer-bundle-process-b"),
  );
  requireCondition(buyerFinalization.disposition === "finalised", "buyer-bundle-finalization-failed");
  await anchorArtifact({
    adapter: input.preflight.buyer.adapter,
    writer: input.preflight.env.BUYER_DID,
    logicalAddress: buyerFinalizationLogicalAddress,
    artifact: buyerFinalization.result as unknown as Record<string, unknown>,
  });

  const expectedSellerFinalization = structuredClone(sellerFinalization);
  const expectedBuyerFinalization = structuredClone(buyerFinalization.result);
  const durableCounter = await resolveHandoff(
    counterSignatureLogicalAddress,
    input.preflight.env.BUYER_DID,
  );
  requireCondition(durableCounter?.signature !== undefined, "durable-counter-signature-missing");
  const replaySellerInput: FinalizeCompletedSellerBundleDurableInput = {
    ...sellerInput,
    counterSignatures: [durableCounter.signature as BundleSignature],
  };
  // Simulate a cold runtime boundary. Only filesystem WALs, Demos role
  // publications and the explicit Demos handoff artifacts survive.
  sellerAnchored = undefined;
  buyerAnchored = undefined;
  counterSignature = undefined;
  sellerFinalization = undefined;
  sellerSignatures.clear();
  buyerSignatures.clear();
  const sellerReplayStore = await createFsFencedSessionStore({
    dir: input.settlement.sellerDirectories.fulfilment,
  });
  const sellerReplay = await finalizeCompletedSellerBundleDurable(
    replaySellerInput,
    sellerProvider,
    sellerDurability(sellerReplayStore, "funded-seller-bundle-process-b"),
  );
  buyerBundleStore = await createFsFencedSessionStore({ dir: buyerBundleDir });
  const buyerReplay = await advanceCompletedBuyerBundleDurable(
    buyerInput,
    buyerProvider,
    buyerDurability("funded-buyer-bundle-process-c"),
  );
  requireCondition(
    buyerReplay.disposition === "finalised" && buyerReplay.recovered &&
    canonicalize(sellerReplay) === canonicalize(expectedSellerFinalization) &&
    sellerCounters.sign === 1 && sellerCounters.bindingSign === 1 &&
    sellerCounters.anchor === 1 && sellerCounters.bindingPublication === 1 &&
    buyerCounters.sign === 2 && buyerCounters.counterPublication === 1 &&
    buyerCounters.anchor === 1 && buyerCounters.bindingPublication === 1,
    "bundle-replay-produced-duplicate-effect",
  );

  const sellerPublished = await input.preflight.buyer.adapter.readAnchor(
    expectedSellerFinalization.nativeAddress,
  );
  const buyerPublished = await input.preflight.seller.adapter.readAnchor(
    buyerFinalization.result.nativeAddress,
  );
  requireCondition(
    sellerPublished !== null && buyerPublished !== null &&
    attestationBundleHash(sellerPublished as unknown as FaultAttestationBundle) ===
      expectedSellerFinalization.bundleContentHash &&
    attestationBundleHash(buyerPublished as unknown as FaultAttestationBundle) ===
      buyerFinalization.result.bundleContentHash,
    "role-owned-bundle-readback-failed",
  );
  const [sellerCopy, buyerCopy] = await Promise.all([
    verifyBundleCopy(
      sellerPublished as Record<string, unknown>,
      "seller",
      bundleCopyVerifier,
    ),
    verifyBundleCopy(
      buyerPublished as Record<string, unknown>,
      "buyer",
      bundleCopyVerifier,
    ),
  ]);
  requireCondition(
    sellerCopy.valid && sellerCopy.fullySigned && buyerCopy.valid && buyerCopy.fullySigned,
    "role-owned-bundle-signature-verification-failed",
  );
  const consistency = await bundleConsistency({
    seller: { disposition: "present", bundle: sellerPublished as Record<string, unknown> },
    buyer: { disposition: "present", bundle: buyerPublished as Record<string, unknown> },
  }, {
    isValid: async (bundle, role) => (await verifyBundleCopy(bundle, role, bundleCopyVerifier)).valid,
  });
  requireCondition(consistency === "unified", "role-owned-bundle-consistency-failed");
  requireCondition(
    canonicalize(buyerReplay.result) === canonicalize(expectedBuyerFinalization),
    "buyer-bundle-cold-recovery-mismatch",
  );
  return {
    sellerFinalization: expectedSellerFinalization,
    buyerFinalization: expectedBuyerFinalization,
  };
}

describe("issue #114 guarded funded two-agent spine", () => {
  it("cryptographically self-checks every funded dependency signature domain", () => {
    const seed = new Uint8Array(32).fill(114);
    const privateKey = privateKeyFromSeed(seed);
    const publicKey = rawPublicKey(publicKeyFromSeed(seed));
    const signer = "did:demos:agent:funded-self-check";
    const cases = [
      [ARTIFACT_SEPARATORS.AgreementDocument, "plural"],
      [ARTIFACT_SEPARATORS.PayeeBoundAgreementDocument, "plural"],
      [FINALITY_COMMITMENT_SEPARATOR, "singular"],
      [ARTIFACT_SEPARATORS.SettlementEvidence, "singular"],
      [ARTIFACT_SEPARATORS.CompositeVerificationRecord, "singular"],
      [EXTERNAL_VET_PROVENANCE_SEPARATOR, "singular"],
      [BUNDLE_BINDING_SEPARATOR, "singular"],
    ] as const;
    for (const [separator, signatureKind] of cases) {
      const unsigned = { fixtureVersion: "1", separator, value: "authenticated" };
      const encoded = Buffer.from(ed25519Sign(
        signedBytes(separator, contentHash(unsigned)),
        privateKey,
      )).toString("base64url");
      const signature = signatureKind === "plural"
        ? { algorithm: "ed25519", party: signer, value: encoded }
        : { algorithm: "ed25519", signer, value: encoded };
      const signedArtifact = signatureKind === "plural"
        ? { ...unsigned, signatures: [signature] }
        : { ...unsigned, signature };
      requireCondition(
        verifyEd25519ArtifactSignature(
          separator,
          signedArtifact,
          signature,
          signer,
          publicKey,
        ),
        "dependency-signature-self-check-failed",
      );
      requireCondition(
        !verifyEd25519ArtifactSignature(
          separator,
          { ...signedArtifact, value: "tampered" },
          signature,
          signer,
          publicKey,
        ),
        "dependency-signature-tamper-self-check-failed",
      );
    }
  });

  it("uses a certificate-pinned loopback TLS transport for both exact routes", async () => {
    const host = await startLocalPaywallHost("tls-self-check", "issue-114-tls-self-check");
    try {
      host.installEngagement(async (proposal, identity) => ({ proposal, identity }));
      const engagement = await host.fetchImpl(host.engagementUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proposal: { ok: true }, identity: { ok: true } }),
        redirect: "error",
      });
      const engagementBody = await engagement.json() as {
        proposal?: { ok?: boolean };
        identity?: { ok?: boolean };
      };
      requireCondition(
        engagement.status === 200 && engagementBody.proposal?.ok === true &&
        engagementBody.identity?.ok === true && host.requestCounts.engagement === 1,
        "local-tls-engagement-self-check-failed",
      );
      const resource = await host.fetchImpl(host.resourceUrl, {
        method: "GET",
        redirect: "error",
      });
      await resource.arrayBuffer();
      requireCondition(resource.status === 503, "local-tls-resource-self-check-failed");
      let rejectedOutOfScope = false;
      try {
        await host.fetchImpl(host.resourceUrl, { method: "POST", redirect: "error" });
      } catch {
        rejectedOutOfScope = true;
      }
      requireCondition(rejectedOutOfScope, "local-tls-scope-self-check-failed");
    } finally {
      await host.close();
    }
  });

  it("fails closed on wallet/DID mismatch and insufficient funded preflight balances", () => {
    const wallet = `0x${"1".repeat(40)}`;
    requireCondition(demosIdentityMatches(wallet, didForAddress(wallet)), "identity-match-regression");
    requireCondition(
      !demosIdentityMatches(wallet, `did:demos:agent:${"2".repeat(40)}`),
      "identity-mismatch-not-rejected",
    );
    const wrongNetwork = fundedPreflightDecision({
      connectedChainId: 1,
      sellerDemosBalance: SELLER_MINIMUM_OS,
      buyerDemosBalance: BUYER_MINIMUM_OS,
      paymentBalance: PAYMENT_AMOUNT,
    });
    const sellerShort = fundedPreflightDecision({
      connectedChainId: BASE_SEPOLIA_CHAIN_ID,
      sellerDemosBalance: SELLER_MINIMUM_OS - 1n,
      buyerDemosBalance: BUYER_MINIMUM_OS,
      paymentBalance: PAYMENT_AMOUNT,
    });
    const buyerShort = fundedPreflightDecision({
      connectedChainId: BASE_SEPOLIA_CHAIN_ID,
      sellerDemosBalance: SELLER_MINIMUM_OS,
      buyerDemosBalance: BUYER_MINIMUM_OS - 1n,
      paymentBalance: PAYMENT_AMOUNT,
    });
    const tokenShort = fundedPreflightDecision({
      connectedChainId: BASE_SEPOLIA_CHAIN_ID,
      sellerDemosBalance: SELLER_MINIMUM_OS,
      buyerDemosBalance: BUYER_MINIMUM_OS,
      paymentBalance: PAYMENT_AMOUNT - 1n,
    });
    requireCondition(
      wrongNetwork.disposition === "rejected" && wrongNetwork.reason === "wrong-network" &&
      sellerShort.disposition === "rejected" &&
      sellerShort.reason === "seller-demos-headroom-insufficient" &&
      buyerShort.disposition === "rejected" &&
      buyerShort.reason === "buyer-demos-headroom-insufficient" &&
      tokenShort.disposition === "rejected" &&
      tokenShort.reason === "payment-token-balance-insufficient",
      "funded-preflight-negative-case-regression",
    );
  });

  it("durably detaches a successful facilitator result before acknowledgement loss", async () => {
    const state = commerceState();
    const bindingHash = "a".repeat(64);
    let recordedOutcome: unknown;
    const handoffStore: Pick<X402PaywallSettlementStore, "load" | "recordOutcome"> = {
      load: async () => recordedOutcome === undefined
        ? {
            status: "held",
            intent: { bindingHash } as never,
          }
        : {
            status: "settled",
            intent: { bindingHash } as never,
            outcome: structuredClone(recordedOutcome) as never,
          },
      recordOutcome: async (input) => {
        recordedOutcome = structuredClone(input.outcome);
        throw new Error("injected-WAL-acknowledgement-loss");
      },
    };
    const result = {
      success: true,
      transaction: `0x${"1".repeat(64)}`,
      network: BASE_SEPOLIA_NETWORK,
      payer: `0x${"2".repeat(40)}`,
      amount: PAYMENT_AMOUNT.toString(),
    };
    const expectedHeader = encodePaymentResponseHeader(result);
    const requirements: X402BuyerPaymentRequirements = {
      scheme: "exact",
      network: BASE_SEPOLIA_NETWORK,
      amount: PAYMENT_AMOUNT.toString(),
      asset: `0x${"3".repeat(40)}`,
      payTo: `0x${"4".repeat(40)}`,
      maxTimeoutSeconds: PAYMENT_TIMEOUT_SECONDS,
      extra: { name: TOKEN_NAME, version: TOKEN_VERSION, assetTransferMethod: "eip3009" },
    };
    requireCondition(
      await retainSuccessfulFacilitatorSettlement(
        state,
        handoffStore,
        "dacs:x402-settlement:test",
        result,
        requirements,
        result.payer,
      ) === result,
      "facilitator-result-identity-changed",
    );
    result.transaction = `0x${"5".repeat(64)}`;
    requireCondition(
      state.settlementResult?.headers["PAYMENT-RESPONSE"] === expectedHeader,
      "facilitator-result-not-detached",
    );
    requireCondition(
      canonicalize(recordedOutcome) === canonicalize({
        status: "settled",
        settlement: state.settlementResult,
      }),
      "facilitator-result-not-written-to-wal",
    );
  });

  it("projects only the x402-defined EIP-3009 default for a legacy facilitator", () => {
    const requirements: X402BuyerPaymentRequirements = {
      scheme: "exact",
      network: BASE_SEPOLIA_NETWORK,
      amount: PAYMENT_AMOUNT.toString(),
      asset: `0x${"3".repeat(40)}`,
      payTo: `0x${"4".repeat(40)}`,
      maxTimeoutSeconds: PAYMENT_TIMEOUT_SECONDS,
      extra: {
        name: TOKEN_NAME,
        version: TOKEN_VERSION,
        assetTransferMethod: "eip3009",
      },
    };
    const projected = legacyFacilitatorRequirements(requirements);
    requireCondition(
      projected.extra.assetTransferMethod === undefined &&
        requirements.extra.assetTransferMethod === "eip3009",
      "legacy-facilitator-projection-mutated-authority",
    );
    let rejectedPermit2 = false;
    try {
      legacyFacilitatorRequirements({
        ...requirements,
        extra: { ...requirements.extra, assetTransferMethod: "permit2" },
      });
    } catch {
      rejectedPermit2 = true;
    }
    requireCondition(rejectedPermit2, "legacy-facilitator-projection-not-fail-closed");
  });

  if (missingReadOnly.length > 0) {
    it.skip(`read-only preflight requires ${missingReadOnly.join(", ")}`, () => undefined);
  } else {
    it("runs the complete read-only preflight without requiring spend confirmation", async () => {
      let preflight: Preflight | undefined;
      try {
        preflight = await stage("read-only-preflight", () =>
          runNoWritePreflight(completeReadOnlyEnv())
        );
        const resource = new URL(preflight.host.resourceUrl);
        const engagement = new URL(preflight.host.engagementUrl);
        requireCondition(
          resource.protocol === "https:" && resource.hostname === "127.0.0.1" &&
          engagement.protocol === "https:" && engagement.hostname === "127.0.0.1",
          "host-not-local-tls",
        );
      } finally {
        if (preflight) await preflight.host.close();
      }
    }, 180_000);
  }

  if (missingFunded.length > 0) {
    it.skip(`funded run requires ${missingFunded.join(", ")}`, () => undefined);
  } else {
    it("completes the real funded spine through cold-store-recovered role-owned bundles", async () => {
      const env = completeEnv();
      let preflight: Preflight | undefined;
      try {
        preflight = await stage("preflight", () => runNoWritePreflight(env));
        const now = Date.now();
        const jobId = preflight.jobId;
        const selectedRail = rail(preflight.host.resourceUrl);
        const [buyerIdentity, sellerIdentity] = await Promise.all([
          identity(env.BUYER_DID, preflight.buyer.adapter, now, env.BUYER_EVM_KEY),
          identity(env.SELLER_DID, preflight.seller.adapter, now),
        ]);
        const [buyerAgreementDir, sellerAgreementDir] = await Promise.all([
          temporaryDirectory("buyer-agreement"),
          temporaryDirectory("seller-agreement"),
        ]);

        // This check is deliberately adjacent to the first live Demos write.
        // Every operation above it is local or read-only.
        requireCondition(env.LIVE_E2E_CONFIRM === "1", "spend-not-confirmed");
        const published = await stage("listing", () => publishAndDiscoverListing({
          preflight: preflight!,
          jobId,
          sellerIdentity,
          selectedRail,
          now,
        }));
        requireCondition(
          published.listing.seller.publicEndpoint === preflight.host.engagementUrl,
          "advertised-endpoint-mismatch",
        );
        const vet = await stage("vet", () => publishVetRecords({
          preflight: preflight!,
          jobId,
          buyerIdentity,
          sellerIdentity,
          now: now + 1,
        }));
        const agreement = await stage("agreement", () => negotiateAgreement({
          preflight: preflight!,
          jobId,
          published,
          selectedRail,
          buyerIdentity,
          sellerIdentity,
          vet,
          now: now + 2,
          buyerDir: buyerAgreementDir,
          sellerDir: sellerAgreementDir,
        }));
        requireCondition(
          preflight.host.requestCounts.engagement === 1,
          "advertised-engagement-endpoint-not-invoked",
        );
        const commitment = await stage("commitment", () => commitAgreement({
          preflight: preflight!,
          jobId,
          published,
          agreement,
          vet,
          now: now + 3,
        }));
        const settlement = await stage("settlement", () => settleAndRecover({
          preflight: preflight!,
          jobId,
          published,
          agreement,
          commitment,
          selectedRail,
          buyerIdentity,
          sellerIdentity,
          vet,
        }));
        const sellerSettlement = await stage("settlement-publication", () =>
          publishAndVerifySellerSettlement({
            preflight: preflight!,
            jobId,
            agreement,
            selectedRail,
            settlement,
          })
        );
        const bundles = await stage("bundle-finalization", () =>
          closeDurableDetachedRoleBundles({
            preflight: preflight!,
            jobId,
            now,
            published,
            agreement,
            commitment,
            settlement,
            sellerSettlement,
            buyerIdentity,
            sellerIdentity,
            vet,
          })
        );
        requireCondition(
          bundles.sellerFinalization.sellerBundle.anchoredByRole === "seller" &&
          bundles.buyerFinalization.buyerBundle.anchoredByRole === "buyer",
          "funded-role-owned-bundle-closure-failed",
        );
      } finally {
        if (preflight) await preflight.host.close();
      }
    }, 900_000);
  }
});

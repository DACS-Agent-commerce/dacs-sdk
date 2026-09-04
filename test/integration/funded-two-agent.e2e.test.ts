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
import { afterEach, describe, expect, it } from "vitest";
import {
  createPublicClient,
  erc20Abi,
  getAddress,
  http,
  parseAbi,
  parseAbiItem,
  verifyMessage,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  executeFundedRun,
  recordFundedRunOutcome,
  type ArmedFundedRun,
} from "./funded-run-marker.js";

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
  AnchorWaitError,
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
  compositeVerificationAddress,
  contentHash,
  createUnsafeManualAgent,
  createDacsX402BuyerEvmChallengeClient,
  createFixedPriceAgreementSigningPlan,
  createFsDemosWriteJournal,
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
  demosWriteEvidenceToAnchorReceipt,
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
  resumeDeliveryFinalisation,
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
  type DurableBuyerBundleFinalizationProgress,
  type DurableBuyerBundleFinalizationProvider,
  type DurableSellerFixedPriceAgreementDurability,
  type DurableSellerFulfilmentDeps,
  type DeliveryReadyResult,
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
  type SellerFinalSessionReceiptInput,
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
  type X402PaywallSettlementIntent,
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
const HARD_MAX_PAYMENT_AMOUNT = 1n;
const PAYMENT_TIMEOUT_SECONDS = 120;
const X402_VERSION = 2;
const TOKEN_NAME = "USDC";
const TOKEN_VERSION = "2";
const TOKEN_SYMBOL = "USDC";
const TOKEN_DECIMALS = 6;
const OS_PER_DEM = 1_000_000_000n;
// Ten seller writes and six buyer writes at the currently observed 2 DEM
// storage-program fee, plus the currently observed 1 DEM finalization effect
// debit and explicit headroom. The extra writes are the role-owned
// BundleBindings and buyer finalization handoff.
const SELLER_MINIMUM_OS = 23n * OS_PER_DEM;
const BUYER_MINIMUM_OS = 15n * OS_PER_DEM;
const PROJECTED_DEMOS_DEBIT_OS = 33n * OS_PER_DEM;
const HARD_MAX_DEMOS_DEBIT_OS = SELLER_MINIMUM_OS + BUYER_MINIMUM_OS;
const LEASE_DURATION_MS = 120_000;
const EIP3009_AUTHORIZATION_USED_EVENT = parseAbiItem(
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
);
const FUNDED_DELIVERABLE_SEPARATOR = "DACS-funded-e2e:deliverable:v1";

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
const FUNDED_ENV = [
  ...READ_ONLY_ENV,
  "LIVE_E2E_MARKER_DIR",
  "LIVE_E2E_MAX_PAYMENT_AMOUNT",
  "LIVE_E2E_MAX_DEMOS_DEBIT_OS",
  "LIVE_E2E_CONFIRM",
] as const;

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
  if (/^funded-e2e:[a-z0-9-]+$/.test(message)) return message.slice("funded-e2e:".length);
  const digest = sha256Hex(message).slice(0, 12);
  // viem BaseError appends a package-version footer to unrelated RPC errors.
  // Keep the raw message in the digest, but exclude only that trailing metadata
  // line from the free-text fallback classifier so "Version: viem@..." cannot
  // masquerade as a Listing-history failure (issue #189).
  const classificationMessage = message.replace(
    /\nVersion:\s+[A-Za-z0-9@/_-]+@[0-9A-Za-z.+-]+\s*$/,
    "",
  );
  if (/normative unsigned/.test(classificationMessage)) return `listing-draft-invalid-${digest}`;
  if (/signed Listing failed/.test(classificationMessage)) return `listing-signature-envelope-invalid-${digest}`;
  if (/canonical JSON|exact snapshot|stable/.test(classificationMessage)) return `canonical-snapshot-invalid-${digest}`;
  if (/rail/i.test(classificationMessage)) return `rail-authority-invalid-${digest}`;
  if (/history|prior listing|version/i.test(classificationMessage)) return `listing-history-invalid-${digest}`;
  if (/identity|self-certifying|wallet/i.test(classificationMessage)) return `listing-identity-invalid-${digest}`;
  if (/binding/i.test(classificationMessage)) return `listing-binding-invalid-${digest}`;
  if (/publication|anchor|write/i.test(classificationMessage)) return `listing-publication-invalid-${digest}`;
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9]*Error$/.test(error.name)
    ? `${error.name.toLowerCase()}-${digest}`
    : "unknown-error";
}

describe("funded diagnostic failure classification", () => {
  it("does not classify a viem package footer as Listing version history", () => {
    const error = new Error([
      "RPC Request failed.",
      "Details: Too Many Requests",
      "Version: viem@2.52.2",
    ].join("\n"));
    error.name = "HttpRequestError";
    expect(safeStageFailureClass(error)).toMatch(/^httprequesterror-[0-9a-f]{12}$/);
  });

  it("still classifies a substantive Listing-version failure with that footer", () => {
    const error = new Error([
      "prior listing version is invalid",
      "Version: viem@2.52.2",
    ].join("\n"));
    expect(safeStageFailureClass(error)).toMatch(/^listing-history-invalid-[0-9a-f]{12}$/);
  });
});

async function diagnosticStep<T>(code: string, operation: () => Promise<T> | T): Promise<T> {
  requireCondition(/^[a-z0-9-]+$/.test(code), "diagnostic-step-code-invalid");
  const startedAt = Date.now();
  process.stderr.write(`funded-e2e-step:${code}:start\n`);
  try {
    const result = await operation();
    process.stderr.write(`funded-e2e-step:${code}:passed\n`);
    process.stderr.write(`funded-e2e-step:${code}:elapsed-ms:${Date.now() - startedAt}\n`);
    return result;
  } catch (error) {
    process.stderr.write(`funded-e2e-step:${code}:failed\n`);
    process.stderr.write(`funded-e2e-step:${code}:elapsed-ms:${Date.now() - startedAt}\n`);
    process.stderr.write(
      `funded-e2e-step:${code}:detail:${safeStageFailureClass(error)}\n`,
    );
    throw error;
  }
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
  const startedAt = Date.now();
  process.stderr.write(`funded-e2e-stage:${code}:start\n`);
  try {
    const result = await operation();
    process.stderr.write(`funded-e2e-stage:${code}:passed\n`);
    process.stderr.write(`funded-e2e-stage:${code}:elapsed-ms:${Date.now() - startedAt}\n`);
    return result;
  } catch (error) {
    process.stderr.write(`funded-e2e-stage:${code}:failed\n`);
    process.stderr.write(`funded-e2e-stage:${code}:elapsed-ms:${Date.now() - startedAt}\n`);
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

function safeAnchorFamily(name: string): string {
  const decoded = name.replaceAll("%3A", ":");
  const segments = decoded.split(":");
  const family = segments[0] === "dacs-test"
    ? segments.slice(0, 2).join("-")
    : segments.slice(0, 2).join("-");
  return /^[a-z0-9-]+$/.test(family) ? family : "unclassified";
}

function installFundedAnchorTelemetry(
  adapter: DemosBackedAdapter,
  actor: "buyer" | "seller",
): void {
  const anchorWriteOnce = adapter.anchorWriteOnce.bind(adapter);
  let sequence = 0;
  adapter.anchorWriteOnce = async (name, value, options) => {
    sequence += 1;
    const operation = sequence;
    const family = safeAnchorFamily(name);
    const startedAt = Date.now();
    let progress: Parameters<NonNullable<NonNullable<typeof options>["onProgress"]>>[0]
      | undefined;
    const onProgress = options?.onProgress;
    process.stderr.write(
      `funded-e2e-anchor:${actor}:${operation}:${family}:start\n`,
    );
    try {
      const result = await anchorWriteOnce(name, value, {
        ...options,
        onProgress: (receipt) => {
          progress = receipt;
          onProgress?.(receipt);
        },
      });
      const operationStartedAt = progress?.timings.startedAt ?? startedAt;
      const relative = (value: number | undefined) => value === undefined
        ? "na" : String(value - operationStartedAt);
      const totalMs = Date.now() - startedAt;
      const queueMs = operationStartedAt - startedAt;
      process.stderr.write(
        `funded-e2e-anchor:${actor}:${operation}:${family}:passed:` +
          `${totalMs}:${queueMs}:${relative(progress?.timings.acceptedAt)}:` +
          `${relative(progress?.timings.includedAt)}:` +
          `${relative(progress?.timings.readVisibleAt)}:` +
          `${progress?.attempts.inclusionPolls ?? 0}:` +
          `${progress?.attempts.visibilityReads ?? 0}\n`,
      );
      return result;
    } catch (error) {
      process.stderr.write(
        `funded-e2e-anchor:${actor}:${operation}:${family}:failed:${Date.now() - startedAt}\n`,
      );
      throw error;
    }
  };
}

async function retryReadOnly<T>(
  operation: () => Promise<T>,
  attempts = 3,
  delayMs = 250,
): Promise<T> {
  requireCondition(Number.isInteger(attempts) && attempts > 0, "read-retry-count-invalid");
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs * attempt));
      }
    }
  }
  throw lastError;
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
    LIVE_E2E_MARKER_DIR: rawEnv.LIVE_E2E_MARKER_DIR ?? "",
    LIVE_E2E_MAX_PAYMENT_AMOUNT: rawEnv.LIVE_E2E_MAX_PAYMENT_AMOUNT ?? "",
    LIVE_E2E_MAX_DEMOS_DEBIT_OS: rawEnv.LIVE_E2E_MAX_DEMOS_DEBIT_OS ?? "",
    LIVE_E2E_CONFIRM: rawEnv.LIVE_E2E_CONFIRM ?? "",
  };
}

function configuredPositiveInteger(value: string, code: string): bigint {
  requireCondition(/^[1-9][0-9]*$/.test(value), code);
  return BigInt(value);
}

function confirmedDemosDebitOs(value: unknown): bigint | undefined {
  const content = (value as {
    response?: {
      data?: {
        transaction?: {
          content?: { from?: unknown; gcr_edits?: unknown };
        };
      };
    };
  })?.response?.data?.transaction?.content;
  if (typeof content?.from !== "string" || !Array.isArray(content.gcr_edits)) {
    return undefined;
  }
  const sender = content.from.toLowerCase();
  let debitOs = 0n;
  let foundSenderDebit = false;
  for (const candidate of content.gcr_edits) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return undefined;
    }
    const edit = candidate as Record<string, unknown>;
    if (edit.type !== "balance" || edit.operation !== "remove") {
      continue;
    }
    if (typeof edit.account !== "string" || typeof edit.isRollback !== "boolean") {
      return undefined;
    }
    if (edit.account.toLowerCase() !== sender || edit.isRollback) {
      continue;
    }
    if (typeof edit.amount !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(edit.amount)) {
      return undefined;
    }
    foundSenderDebit = true;
    debitOs += BigInt(edit.amount);
  }
  return foundSenderDebit ? debitOs : undefined;
}

interface FundedDemosDebitBudget {
  readonly maximumOs: bigint;
  readonly reservedOs: bigint;
  reserve(validity: unknown): void;
}

function createFundedDemosDebitBudget(maximumOs: bigint): FundedDemosDebitBudget {
  requireCondition(maximumOs > 0n, "demos-debit-cap-invalid");
  let reservedOs = 0n;
  const transactions = new Set<string>();
  return {
    maximumOs,
    get reservedOs() {
      return reservedOs;
    },
    reserve(validity) {
      const transaction = (validity as {
        response?: { data?: { transaction?: { hash?: unknown } } };
      })?.response?.data?.transaction;
      requireCondition(
        typeof transaction?.hash === "string" && /^(?:0x)?[0-9a-fA-F]{64}$/.test(transaction.hash),
        "demos-debit-transaction-hash-invalid",
      );
      const hash = transaction.hash.replace(/^0x/i, "").toLowerCase();
      if (transactions.has(hash)) return;
      const transactionDebitOs = confirmedDemosDebitOs(validity);
      requireCondition(transactionDebitOs !== undefined, "demos-debit-effect-unavailable");
      const next = reservedOs + transactionDebitOs;
      requireCondition(next <= maximumOs, "demos-debit-cap-exceeded");
      transactions.add(hash);
      reservedOs = next;
    },
  };
}

function installFundedDemosDebitGuard(
  adapter: DemosBackedAdapter,
  budget: FundedDemosDebitBudget,
): void {
  const tx = adapter.raw?.tx as {
    broadcast?: (validity: unknown, ...args: unknown[]) => Promise<unknown>;
  } | undefined;
  requireCondition(typeof tx?.broadcast === "function", "demos-broadcast-unavailable");
  const broadcast = tx.broadcast.bind(tx);
  tx.broadcast = (validity, ...args) => {
    // `confirm` has already returned the exact transaction and its fee. Reserve
    // that fee synchronously before the first network broadcast; an unknown or
    // over-budget confirmation fails closed without invoking the transport.
    budget.reserve(validity);
    return broadcast(validity, ...args);
  };
}

function x402FundedRunIntent(preflight: Preflight) {
  return {
    directory: preflight.env.LIVE_E2E_MARKER_DIR,
    operation: "x402-funded-e2e",
    runId: preflight.env.LIVE_E2E_RUN_ID,
    details: {
      asset: preflight.asset,
      authorizationSearchFromBlock: preflight.authorizationSearchFromBlock,
      buyerDemosAddress: preflight.buyer.adapter.getAddress().toLowerCase(),
      demosNetwork: "demos",
      jobId: preflight.jobId,
      maxDemosDebitOs: preflight.env.LIVE_E2E_MAX_DEMOS_DEBIT_OS,
      maxPaymentAmount: preflight.env.LIVE_E2E_MAX_PAYMENT_AMOUNT,
      payee: preflight.payee.toLowerCase(),
      payer: preflight.payer.toLowerCase(),
      paymentAmount: PAYMENT_AMOUNT.toString(),
      paymentNetwork: BASE_SEPOLIA_NETWORK,
      sellerDemosAddress: preflight.seller.adapter.getAddress().toLowerCase(),
    },
  } as const;
}

async function recordX402FundedOutcome(
  marker: Readonly<ArmedFundedRun>,
  status: "delivery-complete" | "audit-complete",
  jobId: string,
  reservedDemosDebitOs: bigint,
): Promise<void> {
  await recordFundedRunOutcome(marker, {
    status,
    details: {
      jobId,
      reservedDemosDebitOs: reservedDemosDebitOs.toString(),
    },
  });
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
  maxDemosDebitOs?: bigint;
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
  if (input.maxDemosDebitOs !== undefined &&
      input.sellerDemosBalance + input.buyerDemosBalance < input.maxDemosDebitOs) {
    return { disposition: "rejected", reason: "demos-debit-cap-unfunded" };
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

function validateStaticConfiguration(env: LiveEnv, funded: boolean): void {
  requireCondition(env.PAYWALL_URL === "local", "paywall-must-be-local");
  requireCondition(env.PAY_NETWORK === BASE_SEPOLIA_NETWORK, "network-not-base-sepolia");
  requireCondition(/^0x[0-9a-fA-F]{40}$/.test(env.PAY_TOKEN), "token-address-invalid");
  requireCondition(/^0x[0-9a-fA-F]{40}$/.test(env.SELLER_EVM), "payee-address-invalid");
  requireCondition(/^0x[0-9a-fA-F]{64}$/.test(env.BUYER_EVM_KEY), "buyer-evm-key-invalid");
  requireCondition(/^0x[0-9a-fA-F]{64}$/.test(env.SELLER_EVM_KEY), "seller-evm-key-invalid");
  requireCondition(/^[A-Za-z0-9._-]{1,64}$/.test(env.LIVE_E2E_RUN_ID), "run-id-invalid");
  if (funded) {
    const maxPaymentAmount = configuredPositiveInteger(
      env.LIVE_E2E_MAX_PAYMENT_AMOUNT,
      "payment-debit-cap-invalid",
    );
    requireCondition(
      PAYMENT_AMOUNT > 0n && PAYMENT_AMOUNT <= maxPaymentAmount &&
        maxPaymentAmount <= HARD_MAX_PAYMENT_AMOUNT,
      "payment-debit-cap-invalid",
    );
    const maxDemosDebitOs = configuredPositiveInteger(
      env.LIVE_E2E_MAX_DEMOS_DEBIT_OS,
      "demos-debit-cap-invalid",
    );
    requireCondition(
      maxDemosDebitOs >= PROJECTED_DEMOS_DEBIT_OS &&
        maxDemosDebitOs <= HARD_MAX_DEMOS_DEBIT_OS,
      "demos-debit-cap-invalid",
    );
  }
  for (const endpoint of [
    env.DEMOS_RPC,
    env.PAY_RPC,
    env.X402_FACILITATOR,
    ...(process.env.PAY_RPC_SECONDARY === undefined
      ? [] : [process.env.PAY_RPC_SECONDARY]),
  ]) {
    let parsed: URL;
    try {
      parsed = new URL(endpoint);
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
  if (process.env.PAY_RPC_SECONDARY !== undefined) {
    requireCondition(
      new URL(process.env.PAY_RPC_SECONDARY).origin !== new URL(env.PAY_RPC).origin,
      "secondary-rpc-not-independent",
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
  readonly lastHandlerFailure: string | undefined;
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
  let lastHandlerFailure: string | undefined;
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
    })().catch((error) => {
      lastHandlerFailure = safeStageFailureClass(error);
      process.stderr.write(
        `funded-e2e-step:local-handler-failure:${lastHandlerFailure}\n`,
      );
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
    get lastHandlerFailure() {
      return lastHandlerFailure;
    },
    close: () => server.listening
      ? new Promise((resolve) => server.close(() => resolve()))
      : Promise.resolve(),
  };
}

interface Preflight {
  env: LiveEnv;
  jobId: string;
  seller: Awaited<ReturnType<typeof createUnsafeManualAgent>>;
  buyer: Awaited<ReturnType<typeof createUnsafeManualAgent>>;
  evm: PublicClient;
  evmVerificationClients: readonly PublicClient[];
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

async function runNoWritePreflight(env: LiveEnv, funded = false): Promise<Preflight> {
  validateStaticConfiguration(env, funded);
  const buyerEvm = privateKeyToAccount(env.BUYER_EVM_KEY as `0x${string}`);
  const sellerEvm = privateKeyToAccount(env.SELLER_EVM_KEY as `0x${string}`);
  const payer = getAddress(buyerEvm.address);
  const payee = getAddress(env.SELLER_EVM);
  const asset = getAddress(env.PAY_TOKEN);
  requireCondition(sellerEvm.address.toLowerCase() === payee.toLowerCase(), "seller-payee-key-mismatch");
  requireCondition(payer.toLowerCase() !== payee.toLowerCase(), "payer-payee-not-independent");

  const bindings = createInMemoryBindingStore();
  const [sellerWriteJournal, buyerWriteJournal] = await Promise.all([
    temporaryDirectory("seller-demos-writes").then((dir) =>
      createFsDemosWriteJournal({ dir })
    ),
    temporaryDirectory("buyer-demos-writes").then((dir) =>
      createFsDemosWriteJournal({ dir })
    ),
  ]);
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
  const [seller, buyer] = await diagnosticStep("preflight-agent-connect", () =>
    Promise.all([
      createUnsafeManualAgent({
      demosRpc: env.DEMOS_RPC,
      wallet: env.SELLER_WALLET,
      demosWriteJournal: sellerWriteJournal,
      identity: { agentId: env.SELLER_DID },
      bindings: { index: bindings, publisher: bindings },
      loadListingRailResolution: railAuthority,
    }),
      createUnsafeManualAgent({
      demosRpc: env.DEMOS_RPC,
      wallet: env.BUYER_WALLET,
      demosWriteJournal: buyerWriteJournal,
      identity: { agentId: env.BUYER_DID },
      bindings: { index: bindings },
      }),
    ])
  );
  installFundedAnchorTelemetry(seller.adapter, "seller");
  installFundedAnchorTelemetry(buyer.adapter, "buyer");
  assertDemosIdentity(seller.adapter, env.SELLER_DID);
  assertDemosIdentity(buyer.adapter, env.BUYER_DID);
  requireCondition(
    seller.adapter.getAddress().toLowerCase() !== buyer.adapter.getAddress().toLowerCase(),
    "demos-agents-not-independent",
  );

  const evm = createPublicClient({ transport: http(env.PAY_RPC) });
  const secondaryRpc = process.env.PAY_RPC_SECONDARY;
  const secondaryEvm = secondaryRpc === undefined
    ? undefined
    : createPublicClient({ transport: http(secondaryRpc) });
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
    secondaryChainId,
  ] = await diagnosticStep("preflight-remote-reads", () =>
    retryReadOnly(() => Promise.all([
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
      secondaryEvm?.getChainId() ?? Promise.resolve(BASE_SEPOLIA_CHAIN_ID),
    ]), 3, 250)
  );
  const funding = fundedPreflightDecision({
    connectedChainId: chainId,
    sellerDemosBalance: sellerBalance,
    buyerDemosBalance: buyerBalance,
    paymentBalance: tokenBalance,
    ...(funded
      ? {
          maxDemosDebitOs: configuredPositiveInteger(
            env.LIVE_E2E_MAX_DEMOS_DEBIT_OS,
            "demos-debit-cap-invalid",
          ),
        }
      : {}),
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
  requireCondition(secondaryChainId === BASE_SEPOLIA_CHAIN_ID, "secondary-rpc-chain-invalid");
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
      evmVerificationClients: secondaryEvm === undefined ? [evm] : [evm, secondaryEvm],
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
  sessionBound = true,
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
    ...(sessionBound
      ? { sessionNonce: sha256Hex(`${primaryClaim}:${now}`) }
      : {}),
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
  const metadata = {
    logicalAddress: input.logicalAddress,
    contentHash: hash,
    // `contentHash` intentionally excludes signature envelopes. Retain the
    // exact JCS envelope as immutable metadata too, so write-once replay
    // cannot accept a different signature over the same signed scope.
    envelopeHash: sha256Hex(canonicalize(input.artifact)),
  };
  let anchored: Awaited<ReturnType<DemosBackedAdapter["anchorWriteOnce"]>> | undefined;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      anchored = await input.adapter.anchorWriteOnce(
        input.logicalAddress,
        structuredClone(input.artifact),
        { metadata },
      );
      break;
    } catch (error) {
      if (
        !(error instanceof AnchorWaitError) ||
        error.receipt.name !== input.logicalAddress ||
        attempt === 3
      ) throw error;
      const state = typeof error.receipt.state === "string" &&
          /^[a-z-]+$/.test(error.receipt.state)
        ? error.receipt.state : "unknown";
      process.stderr.write(
        `funded-e2e-step:anchor-write-recovery-${attempt}-${error.code}-${state}\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  requireCondition(anchored !== undefined, "anchor-write-result-missing");
  requireCondition(typeof anchored.txRef === "string" && anchored.txRef.length > 0, "anchor-tx-missing");
  requireCondition(anchored.demosEvidence !== undefined, "anchor-evidence-missing");
  const receipt = demosWriteEvidenceToAnchorReceipt({
    logicalAddress: input.logicalAddress,
    contentHash: hash,
    writer: input.writer,
    evidence: anchored.demosEvidence,
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
  return retryEstablishedRead(
    () => adapter.verifyDemosAnchorReceipt(receipt),
    3,
    250,
  );
}

async function retryEstablishedRead(
  operation: () => Promise<boolean>,
  attempts: number,
  delayMs: number,
): Promise<boolean> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if (await operation()) return true;
    } catch {
      // A finalized immutable proof may be temporarily absent or malformed in
      // one RPC view. A later exact authentication can establish it; no false
      // or thrown observation is ever promoted to valid.
    }
    if (attempt < attempts && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return false;
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
  const expectedLogicalAddress = listingAddress(
    preflight.env.SELLER_DID,
    draft.listingId,
    draft.listingVersion,
  );
  const expectedStorageName = logicalToStorageProgramName(expectedLogicalAddress);
  let published: Awaited<ReturnType<typeof preflight.seller.publishListing>> | undefined;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      published = await preflight.seller.publishListing(draft);
      break;
    } catch (error) {
      if (
        !(error instanceof AnchorWaitError) ||
        error.receipt.name !== expectedStorageName ||
        attempt === 3
      ) throw error;
      const state = typeof error.receipt.state === "string" &&
          /^[a-z-]+$/.test(error.receipt.state)
        ? error.receipt.state : "unknown";
      process.stderr.write(
        `funded-e2e-step:listing-write-recovery-${attempt}-${error.code}-${state}\n`,
      );
      // The adapter retains the signed transaction hash and reconciles its
      // nonce before the next call. Re-entering the exact write-once publish
      // can therefore finish a lost acknowledgement or binding publication,
      // but can never issue a conflicting update.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  requireCondition(published !== undefined, "listing-publication-missing");
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
  const listingReadback = await preflight.buyer.adapter.readAnchor(published.ref);
  requireCondition(
    listingReadback !== null &&
    canonicalize(listingReadback) === canonicalize(listing),
    "listing-native-readback-mismatch",
  );
  requireCondition(anchor.demosEvidence !== undefined, "listing-anchor-evidence-missing");
  const receipt = demosWriteEvidenceToAnchorReceipt({
    logicalAddress: published.logicalAddress,
    contentHash: pin.contentHash,
    writer: preflight.env.SELLER_DID,
    evidence: anchor.demosEvidence,
  });
  requireCondition(
    await verifyAnchorReceipt(
      preflight.buyer.adapter,
      receipt,
      preflight.env.SELLER_DID,
    ),
    "listing-anchor-receipt-invalid",
  );
  return {
    listing,
    listingRef: published.ref,
    listingPin: pin,
    logicalAddress: published.logicalAddress,
    receipt,
  };
}

async function rediscoverPublishedListing(input: {
  preflight: Preflight;
  published: PublishedListing;
  selectedRail: PaymentRailRef;
  now: number;
}): Promise<PublishedListing> {
  const sellerPublicKey = await input.preflight.seller.adapter.getPublicKey();
  const discovered = await discoverListings(
    [input.published.listingRef],
    (ref) => input.preflight.buyer.adapter.readAnchor(ref),
    {
      verify: (bytes, signature, publicKey) =>
        ed25519Verify(bytes, signature, publicKeyFromRaw(publicKey)),
      resolvePublicKey: (claim) => claim === input.preflight.env.SELLER_DID
        ? sellerPublicKey
        : null,
      validateListing: (raw) => validateListingArtifact(raw, listingValidationDeps({
        sellerDid: input.preflight.env.SELLER_DID,
        sellerPublicKey,
        selectedRail: input.selectedRail,
        now: input.now,
      })),
      nowMs: () => input.now,
    },
  );
  requireCondition(discovered.length === 1, "listing-rediscovery-failed");
  const selected = discovered[0]!;
  requireCondition(selected.compatibility === "normative", "listing-rediscovery-not-normative");
  const listing = selected.listing;
  const listingHash = contentHash(listing as unknown as Record<string, unknown>);
  requireCondition(
    input.published.listingPin.listingId === listing.listingId &&
      input.published.listingPin.version === listing.listingVersion &&
      input.published.listingPin.contentHash === listingHash &&
      input.published.receipt.nativeAddress === input.published.listingRef &&
      input.published.receipt.contentHash === listingHash,
    "listing-rediscovery-pin-mismatch",
  );
  const listingResolution = await input.preflight.buyer.adapter.resolveAnchorByName(
    input.published.logicalAddress,
    input.preflight.seller.adapter.getAddress(),
  );
  requireCondition(
    listingResolution.status === "present" &&
      listingResolution.address === input.published.listingRef,
    "listing-rediscovery-owner-binding-mismatch",
  );
  return { ...input.published, listing };
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

interface PreparedVetArtifacts {
  buyer: CompositeVerificationRecord;
  seller: CompositeVerificationRecord;
  buyerRef: AttestationRef;
  sellerRef: AttestationRef;
  externalSellerProvenance: ExternalVetProvenance;
}

interface VetArtifacts extends PreparedVetArtifacts {
  buyerReceipt: AnchorReceipt;
  sellerReceipt: AnchorReceipt;
}

interface PublishedVetArtifacts extends VetArtifacts {
  externalSellerProvenanceRef: AttestationRef;
  externalSellerProvenanceReceipt: AnchorReceipt;
}

function assertPreparedVetSignerBindings(
  prepared: PreparedVetArtifacts,
  buyerDid: string,
  sellerDid: string,
): void {
  requireCondition(
    prepared.buyer.signature.signer === sellerDid &&
      prepared.buyerRef.signer === sellerDid &&
      prepared.seller.signature.signer === buyerDid &&
      prepared.sellerRef.signer === buyerDid,
    "prepared-vet-signer-binding-invalid",
  );
}

async function prepareVetRecords(input: {
  preflight: Preflight;
  jobId: string;
  buyerIdentity: IdentityBundle;
  sellerIdentity: IdentityBundle;
  now: number;
}): Promise<PreparedVetArtifacts> {
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
      verifier: input.preflight.env.BUYER_DID,
      signer: input.preflight.buyer.adapter,
      generatedAt: input.now,
    }),
  ]);
  const buyerRef: AttestationRef = {
    anchor: {
      kind: "storage-program",
      locator: compositeVerificationAddress(
        input.jobId,
        input.preflight.env.BUYER_DID,
      ),
    },
    contentHash: contentHash(buyerRecord as unknown as Record<string, unknown>),
    signer: input.preflight.env.SELLER_DID,
  };
  const sellerRef: AttestationRef = {
    anchor: {
      kind: "storage-program",
      locator: compositeVerificationAddress(
        input.jobId,
        input.preflight.env.SELLER_DID,
      ),
    },
    contentHash: contentHash(sellerRecord as unknown as Record<string, unknown>),
    signer: input.preflight.env.BUYER_DID,
  };
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
    verifier: input.preflight.env.BUYER_DID,
    requirementHash: sha256Hex(canonicalize(EMPTY_REQUIREMENT)),
    vetRecordHash: sellerRef.contentHash,
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
  const { signature, ...unsigned } = externalSellerProvenance;
  requireCondition(
    signature.signer === input.preflight.env.BUYER_DID &&
      ed25519Verify(
        signedBytes(EXTERNAL_VET_PROVENANCE_SEPARATOR, contentHash(unsigned)),
        Uint8Array.from(Buffer.from(signature.value, "base64url")),
        publicKeyFromRaw(await input.preflight.buyer.adapter.getPublicKey()),
      ),
    "external-vet-provenance-signature-invalid",
  );
  return {
    buyer: buyerRecord,
    seller: sellerRecord,
    buyerRef,
    sellerRef,
    externalSellerProvenance,
  };
}

async function publishPreparedVetRecords(input: {
  preflight: Preflight;
  prepared: PreparedVetArtifacts;
}): Promise<VetArtifacts> {
  assertPreparedVetSignerBindings(
    input.prepared,
    input.preflight.env.BUYER_DID,
    input.preflight.env.SELLER_DID,
  );
  const [buyerAnchor, sellerAnchor] = await Promise.all([
    anchorArtifact({
      adapter: input.preflight.seller.adapter,
      writer: input.preflight.env.SELLER_DID,
      refSigner: input.prepared.buyerRef.signer,
      logicalAddress: input.prepared.buyerRef.anchor.locator,
      artifact: input.prepared.buyer as unknown as Record<string, unknown>,
    }),
    anchorArtifact({
      adapter: input.preflight.buyer.adapter,
      writer: input.preflight.env.BUYER_DID,
      refSigner: input.prepared.sellerRef.signer,
      logicalAddress: input.prepared.sellerRef.anchor.locator,
      artifact: input.prepared.seller as unknown as Record<string, unknown>,
    }),
  ]);
  requireCondition(
    canonicalize(buyerAnchor.ref) === canonicalize(input.prepared.buyerRef) &&
      canonicalize(sellerAnchor.ref) === canonicalize(input.prepared.sellerRef),
    "prepared-vet-anchor-ref-mismatch",
  );
  return {
    ...structuredClone(input.prepared),
    buyerReceipt: buyerAnchor.receipt,
    sellerReceipt: sellerAnchor.receipt,
  };
}

async function publishExternalSellerVetProvenance(input: {
  preflight: Preflight;
  jobId: string;
  vet: VetArtifacts;
}): Promise<PublishedVetArtifacts> {
  requireCondition(
    input.vet.externalSellerProvenance.jobId === input.jobId &&
      input.vet.externalSellerProvenance.vetRecordHash === input.vet.sellerRef.contentHash,
    "external-vet-provenance-rebound",
  );
  // This signed record authenticates the funded harness's non-normative #331
  // policy seam before negotiation. Its public copy is audit material, not a
  // VPC finality gate, so it can be published after buyer-visible delivery.
  const anchored = await anchorArtifact({
    adapter: input.preflight.buyer.adapter,
    writer: input.preflight.env.BUYER_DID,
    logicalAddress: `dacs-test:vet-provenance:${input.jobId}`,
    artifact: input.vet.externalSellerProvenance as unknown as Record<string, unknown>,
  });
  return {
    ...structuredClone(input.vet),
    externalSellerProvenanceRef: anchored.ref,
    externalSellerProvenanceReceipt: anchored.receipt,
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
  vet: Pick<PreparedVetArtifacts, "buyerRef" | "sellerRef">;
  now: number;
  buyerDir: string;
  sellerDir: string;
  beforeAgreementPublication?: () => Promise<void>;
  onSignedAgreement?: (agreement: AgreementArtifact) => void;
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
        // The agreement is complete and both signatures have already passed
        // the durable negotiator's verification gate. Publication remains
        // fenced on both exact Vet anchors: preparation may overlap their
        // inclusion wait, but no agreement/commitment write or payment can
        // cross the finalized VPC-3 money gate.
        await input.beforeAgreementPublication?.();
        input.onSignedAgreement?.(
          structuredClone(value.artifact) as unknown as AgreementArtifact,
        );
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
  agreement: Pick<AgreementRun, "agreement">;
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
  requireAllRpcs?: boolean;
}): Promise<X402TransferObservation> {
  requireCondition(/^0x[0-9a-fA-F]{64}$/.test(input.txHash), "settlement-tx-invalid");
  const transactionHash = input.txHash as `0x${string}`;
  // Older deterministic fixtures construct the preflight boundary directly.
  const verificationClients = input.preflight.evmVerificationClients ?? [input.preflight.evm];
  const observeOnce = async (client: PublicClient): Promise<X402TransferObservation> => {
    try {
      const [receipt, head] = await Promise.all([
        client.getTransactionReceipt({ hash: transactionHash }),
        client.getBlockNumber(),
      ]);
      if (receipt.status !== "success") return { status: "failed", reason: "transaction-reverted" };
      const confirmations = head >= receipt.blockNumber
        ? head - receipt.blockNumber + 1n
        : 0n;
      if (confirmations < 1n) {
        return { status: "unavailable", reason: "settlement-not-final" };
      }
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
      const block = await client.getBlock({ blockHash: receipt.blockHash });
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
      return { status: "unavailable", reason: "settlement-rpc-unavailable" };
    }
  };
  // Race independently configured RPCs, but accept only a complete receipt,
  // canonical block, exact nonce event, and exact value-transfer event.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const observations = await Promise.all(
      verificationClients.map(observeOnce),
    );
    const failed = observations.find((candidate) => candidate.status === "failed");
    if (failed !== undefined) return failed;
    const finalized = observations.filter(
      (candidate): candidate is Extract<X402TransferObservation, { status: "finalized" }> =>
        candidate.status === "finalized",
    );
    if (finalized.length > 0 &&
        (!input.requireAllRpcs || finalized.length === observations.length)) {
      requireCondition(
        finalized.every((candidate) => sameFinalizedTransfer(finalized[0]!, candidate)),
        "cross-rpc-settlement-mismatch",
      );
      process.stderr.write(
        `funded-e2e-step:settlement-rpc-proof:${
          input.requireAllRpcs ? "all" : "first"
        }-${finalized.length}-of-${observations.length}\n`,
      );
      return finalized[0]!;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return { status: "unavailable", reason: "settlement-finality-timeout" };
}

function fundedPaymentResponseReceipt(
  preflight: Preflight,
  transaction: string,
): Readonly<{
  success: true;
  transaction: string;
  network: typeof BASE_SEPOLIA_NETWORK;
  payer: string;
  amount: string;
}> {
  requireCondition(/^0x[0-9a-fA-F]{64}$/.test(transaction), "recovered-settlement-tx-invalid");
  return {
    success: true,
    transaction: transaction.toLowerCase(),
    network: BASE_SEPOLIA_NETWORK,
    payer: preflight.payer,
    amount: PAYMENT_AMOUNT.toString(),
  };
}

function fundedRecoveredSettlement(
  preflight: Preflight,
  requirements: X402PaywallSettlementIntent["paymentRequirements"],
  transaction: string,
): X402PaywallSettlementResult & { success: true } {
  const receipt = fundedPaymentResponseReceipt(preflight, transaction);
  return {
    ...receipt,
    headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader(receipt) },
    requirements: structuredClone(requirements),
  };
}

async function recoverFundedSellerSettlement(input: {
  preflight: Preflight;
  jobId: string;
  intent: Readonly<X402PaywallSettlementIntent>;
}): Promise<
  | { status: "settled"; settlement: X402PaywallSettlementResult & { success: true } }
  | { status: "pending" | "indeterminate"; reason: string }
> {
  if (input.intent.jobId !== input.jobId ||
      input.intent.phaseIndex !== PAYMENT_PHASE_INDEX ||
      input.intent.payer.toLowerCase() !== input.preflight.payer.toLowerCase() ||
      input.intent.httpResource !== input.preflight.host.resourceUrl) {
    return { status: "indeterminate", reason: "recovered-settlement-intent-mismatch" };
  }
  try {
    const head = await input.preflight.evm.getBlockNumber();
    const used = await input.preflight.evm.getLogs({
      address: input.preflight.asset,
      event: EIP3009_AUTHORIZATION_USED_EVENT,
      args: {
        authorizer: input.preflight.payer,
        nonce: x402Eip3009Nonce(input.jobId, PAYMENT_PHASE_INDEX) as `0x${string}`,
      },
      fromBlock: BigInt(input.preflight.authorizationSearchFromBlock),
      toBlock: head,
    });
    if (used.length === 0) {
      return { status: "pending", reason: "settlement-authorization-not-yet-observed" };
    }
    if (used.length !== 1 || used[0]!.transactionHash === null) {
      return { status: "indeterminate", reason: "settlement-authorization-events-ambiguous" };
    }
    const observed = await observeFundedTransfer({
      preflight: input.preflight,
      jobId: input.jobId,
      txHash: used[0]!.transactionHash,
    });
    if (observed.status !== "finalized") {
      return {
        status: "indeterminate",
        reason: observed.status === "failed"
          ? "recovered-settlement-transfer-failed"
          : "recovered-settlement-transfer-unavailable",
      };
    }
    return {
      status: "settled",
      settlement: fundedRecoveredSettlement(
        input.preflight,
        input.intent.paymentRequirements,
        observed.txHash,
      ),
    };
  } catch {
    return { status: "indeterminate", reason: "settlement-chain-recovery-unavailable" };
  }
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
  loseFacilitatorResponse: boolean;
  facilitatorVerifyOutcome?: "valid" | "invalid" | "threw";
  facilitatorOutcome?: "success" | "failure" | "threw";
  facilitatorFailureCode?: string;
  preSettlementOutcome?: "authorized" | "rejected" | "indeterminate";
  preSettlementReason?: string;
  paymentAuthorizationOutcome?: "authorized" | "rejected" | "indeterminate";
  paymentAuthorizationReason?: string;
  fulfilmentOutcome?: "fulfilled" | "failed" | "indeterminate";
  fulfilmentReason?: string;
  coldAuthorityOutcome?: string;
  settlementReconciliationOutcome?: "settled" | "pending" | "indeterminate";
  settlementReconciliationReason?: string;
  permit?: X402SellerPaymentPermitAuthorization;
  observedTransfer?: Extract<X402TransferObservation, { status: "finalized" }>;
  delivered?: Awaited<ReturnType<DurableSellerFulfilmentDeps["submitDelivery"]>>;
  deliveryPublication?: { artifact: SellerDeliveredArtifact; receipt: AnchorReceipt };
  anchoredEvidence?: SignedSellerDeliveryEvidence;
  evidencePublication?: Awaited<ReturnType<DurableSellerFulfilmentDeps["anchorEvidence"]>>;
  finalReceipt?: SellerFinalSessionReceiptResult;
  fulfilment?: Extract<SellerFulfilmentResult, { decision: "completed" }>;
  deliveryReady?: DeliveryReadyResult;
  settlementResult?: X402PaywallSettlementResult & { success: true };
  deliveryEvidenceSignatureVerified?: boolean;
  deliveryReadyAt?: number;
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

function agreementBindingFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/input is not exact/.test(message)) return "input-not-exact";
  if (/non-normative Listing or agreement shape/.test(message)) return "shape-invalid";
  if (/exact verified Listing pin/.test(message)) return "listing-pin-mismatch";
  if (/fixed-price agreements/.test(message)) return "pattern-mismatch";
  if (/price|pricing/.test(message)) return "price-mismatch";
  if (/deliverable/.test(message)) return "deliverable-mismatch";
  if (/payee-bound|pay phases|payout/i.test(message)) return "payout-mismatch";
  if (/parties/.test(message)) return "party-mismatch";
  if (/authenticated finality time/.test(message)) return "finality-time-invalid";
  if (/deadline exceeds/.test(message)) return "deadline-invalid";
  return "unclassified";
}

function facilitatorFailureCode(reason: unknown): string {
  return typeof reason === "string" && /^[a-z0-9_]{1,96}$/.test(reason)
    ? reason.replace(/_/g, "-")
    : "unclassified";
}

function safeDiagnosticCode(reason: unknown): string {
  return typeof reason === "string" && /^[a-z0-9-]{1,128}$/.test(reason)
    ? reason
    : "unclassified";
}

function commerceState(): CommerceState {
  return {
    loseResponseAcknowledgement: true,
    loseFacilitatorResponse: false,
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

function requireNoExplicitFacilitatorFailure(state: CommerceState): void {
  if (state.facilitatorOutcome !== "failure") return;
  throw new Error(
    `funded-e2e:facilitator-settlement-failed-${state.facilitatorFailureCode ?? "unclassified"}`,
  );
}

function fundedFulfilmentEffectsComplete(state: CommerceState): boolean {
  return state.counts.applicationCallback === 1 && state.counts.delivery === 1 &&
    state.counts.evidence === 1 && state.counts.finalReceipt === 1 &&
    state.counts.render === 1 && state.permit !== undefined &&
    state.fulfilment !== undefined;
}

function fundedFinalSessionReceipt(
  jobId: string,
  input: Pick<
    SellerFinalSessionReceiptInput,
    "fulfilmentId" | "authorizationBinding" | "resultHash"
  >,
): Extract<SellerFinalSessionReceiptResult, { status: "recorded" }> {
  return {
    status: "recorded",
    receipt: {
      receiptVersion: "dacs-sdk-funded-e2e-1",
      jobId,
      fulfilmentId: input.fulfilmentId,
      authorizationBinding: structuredClone(input.authorizationBinding),
      resultHash: input.resultHash,
    },
  };
}

function productionLatencyProfile(): boolean {
  const profile = process.env.LIVE_E2E_PROFILE;
  // `fast` remains as a compatibility alias for the earlier funded campaign.
  return profile === "production-latency" || profile === "fast";
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
  warmCommittedAuthority: () => Promise<boolean>;
  resumeFinalisation: (workerId: string) => Promise<SellerFulfilmentResult>;
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
  startPaymentEvidencePublication?: (input: Readonly<{
    permit: X402SellerPaymentPermitAuthorization;
    observation: Extract<X402TransferObservation, { status: "finalized" }>;
    receiptStore: SellerRuntime["receiptStore"];
  }>) => void;
  notifyDeliveryReady?: () => void;
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
  const verifyColdReceipt = async (
    adapter: DemosBackedAdapter,
    receipt: Readonly<AnchorReceipt>,
    expectedWriter: string,
    artifact: Readonly<Record<string, unknown>> | null,
  ): Promise<boolean> => {
    if (!artifact || receipt.writer !== expectedWriter || receipt.state !== "finalized" ||
        receipt.observationDisposition !== "established" ||
        contentHash(artifact) !== receipt.contentHash) return false;
    const resolution = await retryReadOnly(() => adapter.resolveAnchorByName(
      receipt.logicalAddress,
      expectedWriter.replace(/^did:demos:agent:/, ""),
    ));
    return resolution.status === "present" && resolution.address === receipt.nativeAddress;
  };
  const verifyColdCommittedAuthorityOnce = async (): Promise<boolean> => {
    const rejectColdAuthority = (reason: string): false => {
      state.coldAuthorityOutcome = reason;
      return false;
    };
    // These authorities are immutable and already finalized. Preserve
    // sequential access within each Demos wallet, but run the independent
    // buyer/seller read lanes together. Receipt authentication reuses the exact
    // artifact readback instead of fetching the same bytes a second time.
    const [buyerAuthority, sellerAuthority] = await Promise.all([
      (async () => {
        const listingArtifact = await retryReadOnly(() =>
          preflight.buyer.adapter.readAnchor(published.receipt.nativeAddress)
        );
        const commitmentArtifact = await retryReadOnly(() =>
          preflight.buyer.adapter.readAnchor(commitment.anchorReceipt.nativeAddress)
        );
        const listingReceiptValid = await verifyColdReceipt(
          preflight.buyer.adapter,
          published.receipt,
          preflight.env.SELLER_DID,
          listingArtifact,
        );
        const commitmentReceiptValid = await verifyColdReceipt(
          preflight.buyer.adapter,
          commitment.anchorReceipt,
          preflight.env.SELLER_DID,
          commitmentArtifact,
        );
        return {
          listingArtifact,
          commitmentArtifact,
          listingReceiptValid,
          commitmentReceiptValid,
        };
      })(),
      (async () => {
        const agreementArtifact = await retryReadOnly(() =>
          preflight.seller.adapter.readAnchor(agreement.anchorReceipt.nativeAddress)
        );
        const agreementReceiptValid = await verifyColdReceipt(
          preflight.seller.adapter,
          agreement.anchorReceipt,
          preflight.env.BUYER_DID,
          agreementArtifact,
        );
        return { agreementArtifact, agreementReceiptValid };
      })(),
    ]);
    const {
      listingArtifact,
      commitmentArtifact,
      listingReceiptValid,
      commitmentReceiptValid,
    } = buyerAuthority;
    const { agreementArtifact, agreementReceiptValid } = sellerAuthority;
    if (!listingArtifact) return rejectColdAuthority("listing-artifact-absent");
    if (!agreementArtifact) return rejectColdAuthority("agreement-artifact-absent");
    if (!commitmentArtifact) return rejectColdAuthority("commitment-artifact-absent");
    if (!listingReceiptValid) return rejectColdAuthority("listing-receipt-invalid");
    if (!agreementReceiptValid) return rejectColdAuthority("agreement-receipt-invalid");
    if (!commitmentReceiptValid) return rejectColdAuthority("commitment-receipt-invalid");
    if (canonicalize(listingArtifact) !== canonicalize(published.listing)) {
      return rejectColdAuthority("listing-artifact-mismatch");
    }
    if (canonicalize(agreementArtifact) !== canonicalize(agreement.agreement)) {
      return rejectColdAuthority("agreement-artifact-mismatch");
    }
    if (canonicalize(commitmentArtifact) !== canonicalize(commitment.record)) {
      return rejectColdAuthority("commitment-artifact-mismatch");
    }
    const listingCheck = await validateListingArtifact(
      listingArtifact,
      listingValidationDeps({
        sellerDid: preflight.env.SELLER_DID,
        sellerPublicKey,
        selectedRail,
        now: commitment.committedAt,
      }),
    );
    if (listingCheck.disposition !== "verified") {
      return rejectColdAuthority("listing-validation-failed");
    }
    try {
      validateFixedPriceAgreementBinding({
        agreement: agreementArtifact as unknown as AgreementArtifact,
        verifiedListing: {
          disposition: "verified",
          listing: listingArtifact as unknown as Listing,
          pin: published.listingPin,
        },
        committedAt: commitment.committedAt,
      });
    } catch (error) {
      return rejectColdAuthority(`agreement-binding-${agreementBindingFailure(error)}`);
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
    if (!agreementSignaturesValid) return rejectColdAuthority("agreement-signatures-invalid");
    if (!commitmentSignatureValid) return rejectColdAuthority("commitment-signature-invalid");
    if (commitment.record.jobId !== jobId) return rejectColdAuthority("commitment-job-mismatch");
    if (commitment.record.agreementHash !== agreement.agreementHash) {
      return rejectColdAuthority("commitment-agreement-mismatch");
    }
    if (canonicalize(commitment.record.listingRef) !== canonicalize(published.listingPin)) {
      return rejectColdAuthority("commitment-listing-mismatch");
    }
    state.coldAuthorityOutcome = "verified";
    return true;
  };
  let coldAuthorityVerification: Promise<boolean> | undefined;
  const verifyColdCommittedAuthority = (): Promise<boolean> => {
    coldAuthorityVerification ??= diagnosticStep(
      "cold-authority-verification",
      verifyColdCommittedAuthorityOnce,
    );
    return coldAuthorityVerification;
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
      const observed = await diagnosticStep("seller-transfer-observation", () =>
        observeFundedTransfer({ preflight, jobId, txHash })
      );
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
  const unsignedDeliverable = {
    deliverableVersion: "dacs-sdk-funded-e2e-1" as const,
    jobId,
    result: "funded-proof" as const,
  };
  const deliverableSignature = {
    algorithm: "ed25519" as const,
    signer: preflight.env.SELLER_DID,
    value: Buffer.from(await preflight.seller.adapter.sign(
      signedBytes(FUNDED_DELIVERABLE_SEPARATOR, contentHash(unsignedDeliverable)),
    )).toString("base64url"),
  };
  const signedDeliverable = {
    ...unsignedDeliverable,
    // This is application payload proof, not a DACS component-signature
    // envelope. Keeping its distinct name makes the SR-2 receipt commit the
    // entire anchored payload, including the proof bytes.
    sellerProof: deliverableSignature,
  };
  const deliveryPublicKey = await preflight.seller.adapter.getPublicKey();
  requireCondition(
    verifyEd25519ArtifactSignature(
      FUNDED_DELIVERABLE_SEPARATOR,
      unsignedDeliverable,
      deliverableSignature,
      preflight.env.SELLER_DID,
      deliveryPublicKey,
    ),
    "prepared-deliverable-signature-invalid",
  );
  const deliveredArtifact: SellerDeliveredArtifact = {
    kind: "deliver-storage-program",
    cleartextPayload: structuredClone(signedDeliverable),
    anchoredValue: structuredClone(signedDeliverable),
    access: { model: "public" },
  };
  const deliveryLogicalAddress = `dacs4:deliverable:${jobId}`;
  const evidenceLogicalAddress = `dacs4:delivery-evidence:${jobId}`;
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
                verifier: preflight.env.BUYER_DID,
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
      if (input.startPaymentEvidencePublication) {
        requireCondition(state.permit !== undefined, "payment-evidence-permit-missing");
        requireCondition(
          state.observedTransfer !== undefined,
          "payment-evidence-native-observation-missing",
        );
        input.startPaymentEvidencePublication(Object.freeze({
          permit: structuredClone(state.permit),
          observation: structuredClone(state.observedTransfer),
          receiptStore,
        }));
      }
      state.counts.applicationCallback += 1;
      const anchored = await anchorArtifact({
        adapter: preflight.seller.adapter,
        writer: preflight.env.SELLER_DID,
        logicalAddress: deliveryLogicalAddress,
        artifact: deliveredArtifact.anchoredValue as Record<string, unknown>,
      });
      const [buyerReadback, durableStatus] = await Promise.all([
        preflight.buyer.adapter.readAnchor(anchored.receipt.nativeAddress),
        getSellerFulfilmentStatus(fulfilmentStore, jobId, DELIVERY_PHASE_INDEX),
      ]);
      requireCondition(
        buyerReadback !== null &&
          canonicalize(buyerReadback) === canonicalize(signedDeliverable) &&
          verifyEd25519ArtifactSignature(
            FUNDED_DELIVERABLE_SEPARATOR,
            unsignedDeliverable,
            deliverableSignature,
            preflight.env.SELLER_DID,
            deliveryPublicKey,
          ),
        "buyer-deliverable-verification-failed",
      );
      requireCondition(
        durableStatus.status === "ok" &&
          durableStatus.delivery === "intent" &&
          durableStatus.evidence === "not-started",
        "delivery-ready-handoff-not-durable",
      );
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
      state.deliveryEvidenceSignatureVerified = valid;
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
      const durableStatus = await getSellerFulfilmentStatus(
        fulfilmentStore,
        jobId,
        DELIVERY_PHASE_INDEX,
      );
      requireCondition(
        state.deliveryEvidenceSignatureVerified === true &&
          durableStatus.status === "ok" &&
          durableStatus.delivery === "outcome" &&
          durableStatus.evidence === "intent",
        "delivery-ready-evidence-handoff-not-durable",
      );
      // The core has now verified the independently readable seller-signed
      // deliverable and the signed content-bound delivery evidence. The durable
      // wrapper has persisted that exact evidence intent before invoking us.
      // Public evidence anchoring and final receipt closure continue below.
      if (state.deliveryReadyAt === undefined) {
        state.deliveryReadyAt = Date.now();
        process.stderr.write("funded-e2e-step:delivery-ready:emitted\n");
      }
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
      // This is an operational receipt, not normative public evidence. The
      // durable fulfilment coordinator commits this deterministic value to its
      // fsync-backed WAL before rendering success. If acknowledgement is lost,
      // recomputing the exact value is safe and the WAL remains authoritative.
      state.finalReceipt = fundedFinalSessionReceipt(jobId, candidate);
      return state.finalReceipt;
    },
    reconcileFinalSessionReceipt: async (candidate) => {
      const receipt = state.finalReceipt;
      if (receipt?.status === "recorded" &&
          canonicalize(receipt) === canonicalize(
            fundedFinalSessionReceipt(jobId, candidate),
          )) return structuredClone(receipt);
      // There is no external effect to recover: the exact deterministic
      // receipt can be regenerated and durably committed by the coordinator.
      return { status: "absent", reason: "final-receipt-wal-outcome-absent" };
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
    reconcileSettlement: async (intent) => {
      if (state.settlementResult) {
        state.settlementReconciliationOutcome = "settled";
        state.settlementReconciliationReason = undefined;
        return { status: "settled", settlement: structuredClone(state.settlementResult) };
      }
      const recovered = await diagnosticStep("seller-settlement-reconciliation", () =>
        recoverFundedSellerSettlement({ preflight, jobId, intent })
      );
      state.settlementReconciliationOutcome = recovered.status;
      state.settlementReconciliationReason = recovered.status === "settled"
        ? undefined
        : safeDiagnosticCode(recovered.reason);
      process.stderr.write(
        `funded-e2e-step:seller-settlement-reconciliation-outcome:${recovered.status}${
          recovered.status === "settled" ? "" : `-${state.settlementReconciliationReason}`
        }\n`,
      );
      if (recovered.status === "settled") {
        state.settlementResult = structuredClone(recovered.settlement);
      }
      return recovered;
    },
    receiptStore,
    resolveCommittedSession: async () => await verifyColdCommittedAuthority()
      ? { disposition: "verified", session: structuredClone(scope) }
      : { disposition: "rejected", reason: "committed-session-authority-unverified" },
    paymentIntakeDeps,
    fulfilmentDeps,
    fulfilmentDurability,
    ...(productionLatencyProfile()
      ? {
          deliveryReady: {
            renderResponse: async (context) => {
              state.counts.render += 1;
              state.deliveryReady = structuredClone(context.deliveryReady);
              state.deliveryReadyAt = Date.now();
              process.stderr.write("funded-e2e-step:delivery-ready:emitted\n");
              input.notifyDeliveryReady?.();
              return {
                status: 200,
                headers: { "content-type": "application/json" },
                body: { delivered: true as const },
              };
            },
          },
        }
      : {}),
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
      const projected = legacyFacilitatorRequirements(
        requirements as X402BuyerPaymentRequirements,
      );
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        state.counts.facilitatorVerify += 1;
        try {
          const result = await diagnosticStep("facilitator-verify", () =>
            preflight.facilitator.verify(
              payload as never,
              projected as never,
            )
          );
          state.facilitatorVerifyOutcome = result.isValid ? "valid" : "invalid";
          return result;
        } catch (error) {
          state.facilitatorVerifyOutcome = "threw";
          if (attempt === 3) throw error;
          process.stderr.write(`funded-e2e-step:facilitator-verify-retry-${attempt}\n`);
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
      }
      throw new Error("funded-e2e:facilitator-verify-retry-exhausted");
    },
    settle: async (payload: unknown, requirements: unknown) => {
      state.counts.facilitatorSettle += 1;
      let result: Awaited<ReturnType<HTTPFacilitatorClient["settle"]>>;
      try {
        result = await diagnosticStep("facilitator-settle", () =>
          preflight.facilitator.settle(
            payload as never,
            legacyFacilitatorRequirements(
              requirements as X402BuyerPaymentRequirements,
            ) as never,
          )
        );
      } catch (error) {
        state.facilitatorOutcome = "threw";
        throw error;
      }
      state.facilitatorOutcome = result.success ? "success" : "failure";
      if (!result.success) {
        state.facilitatorFailureCode = facilitatorFailureCode(result.errorReason);
        process.stderr.write(
          `funded-e2e-step:facilitator-settle-outcome:failure-${state.facilitatorFailureCode}\n`,
        );
      } else {
        process.stderr.write("funded-e2e-step:facilitator-settle-outcome:success\n");
      }
      if (result.success && state.loseFacilitatorResponse) {
        state.loseFacilitatorResponse = false;
        state.facilitatorOutcome = "threw";
        throw new Error("injected-facilitator-response-loss");
      }
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
      state.preSettlementReason = result.disposition === "authorized"
        ? "authorized" : result.reason;
      return result;
    },
    authorizePayment: async (context) => {
      const result = await spine.authorizePayment(context);
      state.paymentAuthorizationOutcome = result.disposition;
      state.paymentAuthorizationReason = result.disposition === "authorized"
        ? "authorized" : safeDiagnosticCode(result.reason);
      if (result.disposition === "authorized") {
        state.permit = structuredClone(result.authorization);
      }
      return result;
    },
    fulfil: async (context) => {
      const result = await spine.fulfil(context);
      state.fulfilmentOutcome = result.disposition;
      state.fulfilmentReason = result.disposition === "fulfilled"
        ? "fulfilled" : safeDiagnosticCode(result.reason);
      process.stderr.write(
        `funded-e2e-step:seller-fulfilment-outcome:${state.fulfilmentOutcome}-${
          state.fulfilmentReason
        }:effects-${state.counts.applicationCallback}-${state.counts.delivery}-${
          state.counts.evidence
        }-${state.counts.finalReceipt}-${state.counts.render}\n`,
      );
      return result;
    },
  });
  requireCondition(canonicalize(paywall.terms) === canonicalize(expected), "paywall-terms-mismatch");
  return {
    paywall,
    receiptStore,
    fulfilmentStore,
    warmCommittedAuthority: verifyColdCommittedAuthority,
    resumeFinalisation: async (workerId) => {
      const [restartedReceiptStore, restartedFulfilmentStore] = await Promise.all([
        createFsSellerReceiptStore({ dir: input.directories.receipt }),
        createFsFencedSessionStore({ dir: input.directories.fulfilment }),
      ]);
      const result = await resumeDeliveryFinalisation(
        jobId,
        {
          agreementRef: agreement.agreementRef.anchor.locator,
          agreementHash: agreement.agreementHash,
          commitmentRef: commitment.logicalAddress,
          deliveryPhaseIndex: DELIVERY_PHASE_INDEX,
          paymentPermitId: state.permit?.paymentPermitId ?? "unavailable-payment-permit",
        },
        { ...fulfilmentDeps, receiptStore: restartedReceiptStore },
        {
          ...fulfilmentDurability,
          store: restartedFulfilmentStore,
          workerId,
        },
      );
      if (result.decision === "completed") state.fulfilment = structuredClone(result);
      return result;
    },
  };
}

interface SettlementRun {
  intent: Readonly<X402BuyerSettlementIntent>;
  state: CommerceState;
  seller: SellerRuntime;
  buyerStoreDir: string;
  sellerDirectories: SellerDirectories;
  paymentEvidencePublication?: ReturnType<typeof publishAndVerifySellerSettlement>;
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
  const fastProfile = productionLatencyProfile();
  const sellerDirectories = {
    settlement: await temporaryDirectory("seller-settlement"),
    receipt: await temporaryDirectory("seller-receipt"),
    fulfilment: await temporaryDirectory("seller-fulfilment"),
  };
  const buyerStoreDir = await temporaryDirectory("buyer-settlement");
  const state = commerceState();
  state.loseResponseAcknowledgement = !fastProfile;
  state.loseFacilitatorResponse = fastProfile &&
    process.env.LIVE_E2E_INJECT_FACILITATOR_RESPONSE_LOSS === "1";
  let paymentEvidencePublication:
    | ReturnType<typeof publishAndVerifySellerSettlement>
    | undefined;
  let paymentEvidencePublicationBinding: string | undefined;
  let retainedBuyerIntent: Readonly<X402BuyerSettlementIntent> | undefined;
  const startPaymentEvidencePublication = fastProfile
    ? (publicationInput: Readonly<{
        permit: X402SellerPaymentPermitAuthorization;
        observation: Extract<X402TransferObservation, { status: "finalized" }>;
        receiptStore: SellerRuntime["receiptStore"];
      }>) => {
        if (!retainedBuyerIntent) {
          throw new Error("funded-e2e:buyer-settlement-intent-missing");
        }
        const sessionBindingHash = retainedBuyerIntent.bindingHash;
        const publicationBinding = sha256Hex(canonicalize({
          permit: publicationInput.permit,
          observation: publicationInput.observation,
          sessionBindingHash,
        }));
        if (paymentEvidencePublication) {
          requireCondition(
            paymentEvidencePublicationBinding === publicationBinding,
            "payment-evidence-publication-rebound",
          );
          return;
        }
        paymentEvidencePublicationBinding = publicationBinding;
        paymentEvidencePublication = stage("settlement-publication", () =>
          publishAndVerifySellerSettlement({
            preflight: input.preflight,
            jobId: input.jobId,
            agreement: input.agreement,
            selectedRail: input.selectedRail,
            payment: {
              ...publicationInput,
              sessionBindingHash,
            },
          })
        );
        // The settlement coordinator owns and awaits this exact promise after
        // delivery finality. Attach a handler now so an early failure cannot
        // become an unhandled rejection while the seller lane is still active.
        void paymentEvidencePublication.catch(() => undefined);
      }
    : undefined;
  let seller: SellerRuntime;
  let deliveryFinalisationPromise: Promise<void> | undefined;
  let finaliserAttempts = 0;
  const advanceReadyFinalisation = async (): Promise<void> => {
    if (state.deliveryReady === undefined || state.fulfilment !== undefined) return;
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline && state.fulfilment === undefined) {
      finaliserAttempts += 1;
      const result = await diagnosticStep("delivery-finalisation-resume", () =>
        seller.resumeFinalisation(`funded-fast-finaliser-${finaliserAttempts}`)
      );
      if (result.decision === "completed") return;
      if (result.decision === "failed" || result.decision === "rejected") {
        throw new Error(`funded-e2e:delivery-finalisation-${result.decision}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error("funded-e2e:delivery-finalisation-timeout");
  };
  const ensureDeliveryFinalisation = (): Promise<void> => {
    deliveryFinalisationPromise ??= advanceReadyFinalisation();
    void deliveryFinalisationPromise.catch(() => undefined);
    return deliveryFinalisationPromise;
  };
  seller = await createSellerRuntime({
    ...input,
    directories: sellerDirectories,
    state,
    workerId: "funded-seller-process-a",
    ...(startPaymentEvidencePublication ? { startPaymentEvidencePublication } : {}),
    ...(fastProfile
      ? { notifyDeliveryReady: () => { void ensureDeliveryFinalisation(); } }
      : {}),
  });
  // The three immutable authority anchors are already finalized. Start their
  // independent cold readback while the buyer prepares the exact bearer so
  // the seller's payment gate consumes the same memoized proof without adding
  // another serial RPC round trip after facilitator verification.
  const coldAuthorityWarmup = seller.warmCommittedAuthority();
  void coldAuthorityWarmup.catch(() => undefined);
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
  const prepared = await diagnosticStep("buyer-settlement-prepare", () =>
    prepareX402BuyerSettlement({ authority }, {
      client,
      fetchImpl: input.preflight.host.fetchImpl,
    })
  );
  requireCondition(prepared.disposition === "prepared", "buyer-preparation-failed");
  const intent = prepared.intent;
  retainedBuyerIntent = intent;
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
      recoverDisclosure: async ({ intent: candidate, transactionHash }) => {
        if (candidate.bindingHash !== intent.bindingHash ||
            candidate.authorizationNonce !== intent.authorizationNonce ||
            candidate.httpResource !== intent.httpResource) {
          return { disposition: "unavailable" };
        }
        // This is only a candidate reconstruction after an exact nonce event
        // supplied its transaction hash. The provider still independently
        // authenticates the receipt, AuthorizationUsed log, exact Transfer,
        // canonical ancestry, amount, payer, payee, asset, and session intent.
        const receipt = fundedPaymentResponseReceipt(input.preflight, transactionHash);
        return {
          protocolVersion: "2",
          headerName: "PAYMENT-RESPONSE",
          encodedSettlementHeader: encodePaymentResponseHeader(receipt),
          httpResource: candidate.httpResource,
        };
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
    let lastReason = "not-observed";
    const recoveryDeadline = Date.now() + 180_000;
    for (let attempt = 1; Date.now() < recoveryDeadline; attempt += 1) {
      buyerNow = Date.now();
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
      process.stderr.write(
        `funded-e2e-step:${failureCode}-attempt-${attempt}-progress-` +
          `${progress.status}-${"reason" in progress ? safeDiagnosticCode(progress.reason) : "terminal"}-` +
          `submissions-${buyerTransportSubmissions}\n`,
      );
      requireCondition(buyerTransportSubmissions === 1, "buyer-paid-request-replayed");
      if (progress.status === "captured") return progress;
      if (progress.status === "failed") {
        throw new Error(
          `funded-e2e:${failureCode}-terminal-${progress.outcome.failure}`,
        );
      }
      requireCondition(progress.status === "indeterminate", `${failureCode}-invalid-progress`);
      lastReason = safeDiagnosticCode(progress.reason);
      if (attempt % 10 === 0) {
        process.stderr.write(
          `funded-e2e-step:${failureCode}-attempt-${attempt}-${lastReason}\n`,
        );
      }
      if (Date.now() < recoveryDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
    throw new Error(`funded-e2e:${failureCode}-timeout-${lastReason}`);
  };
  const submitted = await diagnosticStep("buyer-settlement-submit", () =>
    advanceX402BuyerSettlement({
      intent,
      owner: fastProfile ? "funded-fast-buyer" : "funded-buyer-process-a",
      store: buyerStore,
      authorizationProvider: fastProfile
        ? authorizationProvider
        : disruptedAuthorizationProvider,
      transport: {
        submitRetained: (candidate, fence) => {
          buyerTransportSubmissions += 1;
          return productionTransport.submitRetained(candidate, fence);
        },
      },
      now: () => buyerNow,
      leaseDurationMs: 1_000,
    })
  );
  process.stderr.write(
    `funded-e2e-step:buyer-settlement-submit-progress-${submitted.status}-` +
      `${"reason" in submitted ? safeDiagnosticCode(submitted.reason) : "terminal"}-` +
      `submissions-${buyerTransportSubmissions}\n`,
  );
  const submittedStore = await buyerStore.load(intent.settlementKey);
  process.stderr.write(
    `funded-e2e-step:buyer-settlement-store-${submittedStore.status}-` +
      `disclosure-${submittedStore.status === "held" && submittedStore.pendingDisclosure !== undefined ? "present" : "absent"}\n`,
  );
  // A completed HTTP call is not proof of settlement. A facilitator can
  // return a well-formed terminal rejection without broadcasting anything;
  // that case must never be misclassified as an ambiguous in-flight payment.
  requireNoExplicitFacilitatorFailure(state);
  if (fastProfile) {
    const captured = submitted.status === "captured"
      ? submitted
      : await recoverBuyerSettlementFromChain(
          "funded-fast-buyer-reconcile",
          "buyer-fast-chain-recovery",
        );
    requireCondition(captured.status === "captured", "buyer-fast-settlement-not-captured");
    requireCondition(buyerTransportSubmissions === 1, "buyer-fast-paid-request-replayed");
    requireCondition(input.preflight.host.requestCounts.unpaid === 1, "fast-challenge-count-mismatch");
    requireCondition(state.counts.facilitatorSettle === 1, "fast-settlement-effect-count-mismatch");

    // The host starts this explicitly owned worker at delivery-ready, and the
    // coordinator awaits the same promise here after buyer capture. Every
    // attempt still reopens both filesystem stores, so process-local state is
    // not authority for terminal fulfilment.
    await ensureDeliveryFinalisation();

    // If the facilitator broadcast succeeded but the seller's first RPC view
    // could not yet authenticate it, replay the exact retained bearer only
    // after the buyer has independently captured the finalized transfer. The
    // paywall's durable settlement WAL must bypass facilitator verify/settle.
    let sellerReplayAttempts = 0;
    if (!fundedFulfilmentEffectsComplete(state)) {
      const verifyCount = state.counts.facilitatorVerify;
      const settleCount = state.counts.facilitatorSettle;
      const replayDeadline = Date.now() + 180_000;
      while (Date.now() < replayDeadline && !fundedFulfilmentEffectsComplete(state)) {
        sellerReplayAttempts += 1;
        const replayResponse = await diagnosticStep("fast-seller-request-replay", async () => {
          const response = await input.preflight.host.fetchImpl(
            input.preflight.host.resourceUrl,
            {
              method: "GET",
              headers: { [intent.paymentHeader.name]: intent.paymentHeader.value },
              redirect: "error",
            },
          );
          await response.arrayBuffer();
          return response;
        });
        requireCondition(
          state.counts.facilitatorVerify === verifyCount &&
            state.counts.facilitatorSettle === settleCount,
          "fast-seller-replay-resettled",
        );
        if (replayResponse.status === 200) {
          deliveryFinalisationPromise = undefined;
          await ensureDeliveryFinalisation();
          if (fundedFulfilmentEffectsComplete(state)) break;
        }
        const retryableReason = state.settlementReconciliationReason;
        requireCondition(
          replayResponse.status === 503 &&
            (retryableReason === "settlement-authorization-not-yet-observed" ||
              retryableReason === "settlement-chain-recovery-unavailable" ||
              retryableReason === "recovered-settlement-transfer-unavailable"),
          `fast-seller-request-replay-http-${replayResponse.status}-${
            retryableReason ?? input.preflight.host.lastHandlerFailure ?? "no-reconciliation-reason"
          }`,
        );
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
    requireCondition(
      input.preflight.host.requestCounts.paid === 1 + sellerReplayAttempts,
      "fast-paid-request-count-mismatch",
    );
    requireCondition(
      fundedFulfilmentEffectsComplete(state),
      "fast-fulfilment-not-complete",
    );
    requireCondition(state.permit !== undefined, "fast-seller-permit-missing");
    if (state.observedTransfer === undefined) {
      const observed = await diagnosticStep("fast-transfer-reconciliation", () =>
        observeFundedTransfer({
          preflight: input.preflight,
          jobId: input.jobId,
          txHash: state.permit!.paymentAuthorization.settlementIdentity.txHash,
        })
      );
      requireCondition(observed.status === "finalized", "fast-seller-chain-observation-missing");
      state.observedTransfer = structuredClone(observed);
    }
    return {
      intent,
      state,
      seller,
      buyerStoreDir,
      sellerDirectories,
      ...(paymentEvidencePublication ? { paymentEvidencePublication } : {}),
    };
  }
  requireCondition(
    submitted.status === "indeterminate" &&
      submitted.reason === "evm-authorization-lookup-unavailable",
    "buyer-post-response-chain-loss-not-indeterminate",
  );
  const pending = await buyerStore.load(intent.settlementKey);
  const responseLostAfterSubmission = state.facilitatorOutcome === "threw";
  if (
    pending.status !== "held" ||
    (pending.pendingDisclosure === undefined && !responseLostAfterSubmission)
  ) {
    throw new Error(
      `funded-e2e:buyer-disclosure-missing-after-verify-${state.facilitatorVerifyOutcome ?? "not-called"}-presettle-${state.preSettlementOutcome ?? "not-called"}-${state.preSettlementReason ?? "no-reason"}-cold-${state.coldAuthorityOutcome ?? "not-called"}-settle-${state.facilitatorOutcome ?? "not-called"}-${state.facilitatorFailureCode ?? "no-failure-code"}`,
    );
  }
  requireCondition(
    pending.status === "held",
    "buyer-pending-settlement-not-durable",
  );
  requireCondition(
    responseLostAfterSubmission || pending.pendingDisclosure !== undefined,
    "buyer-pending-disclosure-not-durable",
  );
  requireCondition(input.preflight.host.requestCounts.unpaid === 1, "challenge-count-mismatch");
  requireCondition(input.preflight.host.requestCounts.paid === 1, "paid-request-count-mismatch");
  requireCondition(buyerTransportSubmissions === 1, "buyer-submit-count-mismatch");
  requireCondition(state.counts.facilitatorSettle === 1, "settlement-effect-count-mismatch");
  requireCondition(
    state.counts.applicationCallback <= 1 && state.counts.delivery <= 1 &&
      state.counts.evidence <= 1 && state.counts.finalReceipt <= 1,
    "pre-recovery-fulfilment-effect-duplicated",
  );

  // Runtime B has only the filesystem WAL and a fresh production chain reader.
  // It captures the already-mined authorization without another HTTP request.
  const captured = await recoverBuyerSettlementFromChain(
    "funded-buyer-process-b",
    "buyer-chain-recovery",
  );
  requireCondition(buyerTransportSubmissions === 1, "buyer-paid-request-replayed");

  // Recreate both seller and buyer durable stacks. The seller may complete work
  // that paused while the just-mined authorization was not yet visible, but it
  // may never duplicate an effect already completed by process A. This is a
  // cold-store recovery proof inside one test invocation, not a same-run-ID
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
  const processAHasNoFulfilmentEffects =
    processAEffectCounts.applicationCallback === 0 && processAEffectCounts.delivery === 0 &&
    processAEffectCounts.evidence === 0 && processAEffectCounts.finalReceipt === 0;
  requireCondition(
    fulfilmentStatus.status === "ok" ||
      (fulfilmentStatus.status === "missing" && processAHasNoFulfilmentEffects),
    "seller-cold-recovery-failed",
  );
  const replayResponse = await input.preflight.host.fetchImpl(input.preflight.host.resourceUrl, {
    method: "GET",
    headers: { [intent.paymentHeader.name]: intent.paymentHeader.value },
    redirect: "error",
  });
  await replayResponse.arrayBuffer();
  if (replayResponse.status !== 200) {
    const replayFulfilmentStatus = await getSellerFulfilmentStatus(
      seller.fulfilmentStore,
      input.jobId,
      DELIVERY_PHASE_INDEX,
    );
    const walCode = replayFulfilmentStatus.status === "ok"
      ? `${replayFulfilmentStatus.delivery}-${replayFulfilmentStatus.evidence}`
      : replayFulfilmentStatus.status;
    throw new Error(
      `funded-e2e:seller-request-replay-failed-http-${replayResponse.status}-auth-${restartedState.paymentAuthorizationOutcome ?? "not-called"}-${restartedState.paymentAuthorizationReason ?? "no-reason"}-fulfil-${restartedState.fulfilmentOutcome ?? "not-called"}-${restartedState.fulfilmentReason ?? "no-reason"}-wal-${walCode}-cold-${restartedState.coldAuthorityOutcome ?? "not-called"}`,
    );
  }
  requireCondition(Number(input.preflight.host.requestCounts.paid) === 2, "seller-replay-not-observed");
  requireCondition(
    restartedState.counts.facilitatorVerify === 0 &&
    restartedState.counts.facilitatorSettle === 0 && restartedState.counts.render === 1,
    "seller-replay-produced-duplicate-settlement",
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
    processAEffectCounts.applicationCallback + restartedState.counts.applicationCallback === 1 &&
    processAEffectCounts.delivery + restartedState.counts.delivery === 1 &&
    processAEffectCounts.evidence + restartedState.counts.evidence === 1 &&
    processAEffectCounts.finalReceipt + restartedState.counts.finalReceipt === 1,
    "seller-effects-not-exactly-once-across-recovery",
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
  payment: Readonly<{
    permit: X402SellerPaymentPermitAuthorization;
    observation: Extract<X402TransferObservation, { status: "finalized" }>;
    receiptStore: SellerRuntime["receiptStore"];
    sessionBindingHash: string;
  }>;
}) {
  const permit = input.payment.permit;
  const observation = input.payment.observation;
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
    receiptStore: input.payment.receiptStore,
    evidenceSigner: {
      algorithm: "ed25519",
      signer: input.preflight.env.SELLER_DID,
      sign: (bytes) => input.preflight.seller.adapter.sign(bytes),
    },
    anchorWriter: {
      role: "buyer",
      primaryClaim: input.preflight.env.BUYER_DID,
    },
    evidence: evidenceVerifier,
    resolveAuthenticatedNativeProof: async () => {
      const revalidated = await observeFundedTransfer({
        preflight: input.preflight,
        jobId: input.jobId,
        txHash: observation.txHash,
        requireAllRpcs: true,
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
    anchorEvidence: async ({ logicalAddress, evidence, evidenceHash, expectedWriter }) => {
      requireCondition(
        expectedWriter.role === "buyer" &&
          expectedWriter.primaryClaim === input.preflight.env.BUYER_DID,
        "settlement-evidence-anchor-writer-substituted",
      );
      if (publication || retainedEvidence) {
        requireCondition(
          publication !== undefined && retainedEvidence !== undefined &&
          publication.ref.anchor.locator === logicalAddress &&
          publication.ref.contentHash === evidenceHash &&
          canonicalize(retainedEvidence) === canonicalize(evidence) &&
          await verifyAnchorReceipt(
            input.preflight.buyer.adapter,
            publication.receipt,
            input.preflight.env.BUYER_DID,
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
        adapter: input.preflight.buyer.adapter,
        writer: input.preflight.env.BUYER_DID,
        refSigner: input.preflight.env.SELLER_DID,
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
    verifyAnchorReceipt: async ({ anchorReceipt, expectedWriter }) => {
      requireCondition(
        expectedWriter === input.preflight.env.BUYER_DID,
        "settlement-evidence-receipt-writer-substituted",
      );
      const valid = await verifyAnchorReceipt(
        input.preflight.buyer.adapter,
        anchorReceipt,
        input.preflight.env.BUYER_DID,
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
          input.preflight.env.BUYER_DID,
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
        requireAllRpcs: true,
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
            bindingHash: input.payment.sessionBindingHash,
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
  vet: PublishedVetArtifacts;
}) {
  const suppliedFulfilment = input.settlement.state.fulfilment;
  requireCondition(suppliedFulfilment?.decision === "completed", "recovered-fulfilment-missing");
  const [sellerPublicKey, buyerPublicKey] = await Promise.all([
    input.preflight.seller.adapter.getPublicKey(),
    input.preflight.buyer.adapter.getPublicKey(),
  ]);
  const terminalStore = await diagnosticStep("bundle-terminal-store-open", () =>
    createFsFencedSessionStore({
      dir: input.settlement.sellerDirectories.fulfilment,
    })
  );
  const terminalRecord = await diagnosticStep("bundle-terminal-record-load", () =>
    terminalStore.load(input.jobId)
  );
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
  const projection = await diagnosticStep("bundle-terminal-projection", () =>
    projectDurableSellerAuditPending(terminalVerification)
  );
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
    [input.sellerSettlement.settlement.anchorReceipt.nativeAddress, input.preflight.env.BUYER_DID],
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
  const bundleTransportDir = await temporaryDirectory("bundle-transport");
  const buyerFinalizationTransportPath = join(
    bundleTransportDir,
    `${sha256Hex(buyerFinalizationLogicalAddress)}.json`,
  );
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
  const resolveBuyerFinalizationHandoff = async () => {
    let encoded: string;
    try {
      encoded = await readFile(buyerFinalizationTransportPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const envelope = JSON.parse(encoded) as unknown;
    if (
      !envelope || typeof envelope !== "object" || Array.isArray(envelope) ||
      canonicalize(envelope) !== encoded
    ) return null;
    const record = envelope as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(",") !==
        "finalization,finalizationEnvelopeHash,logicalAddress,owner,transportVersion" ||
      record.transportVersion !== "1" ||
      record.logicalAddress !== buyerFinalizationLogicalAddress ||
      record.owner !== input.preflight.env.BUYER_DID ||
      !record.finalization || typeof record.finalization !== "object" ||
      Array.isArray(record.finalization) ||
      record.finalizationEnvelopeHash !== sha256Hex(canonicalize(record.finalization))
    ) return null;
    return structuredClone(record.finalization as Record<string, unknown>);
  };
  const resolveRoleOwnedBundle = async (
    role: "buyer" | "seller",
  ): Promise<AnchoredSellerBundle | null> => {
    const logicalAddress = bundleAddress(input.jobId, role);
    const ownerDid = role === "seller"
      ? input.preflight.env.SELLER_DID : input.preflight.env.BUYER_DID;
    const cached = role === "seller" ? sellerAnchored : buyerAnchored;
    if (cached) {
      const bundle = await input.preflight.buyer.adapter.readAnchor(
        cached.nativeAddress,
      );
      if (!bundle) throw new Error("funded-e2e:role-bundle-read-indeterminate");
      const hash = attestationBundleHash(
        bundle as unknown as FaultAttestationBundle,
      );
      if (
        cached.anchorReceipt.logicalAddress !== logicalAddress ||
        cached.anchorReceipt.nativeAddress !== cached.nativeAddress ||
        cached.anchorReceipt.contentHash !== hash ||
        !await verifyAnchorReceipt(
          input.preflight.buyer.adapter,
          cached.anchorReceipt,
          ownerDid,
        )
      ) return null;
      return {
        bundle,
        nativeAddress: cached.nativeAddress,
        anchorReceipt: cached.anchorReceipt,
        ...(cached.anchorTx ? { anchorTx: cached.anchorTx } : {}),
      };
    }
    const ownerAdapter = role === "seller"
      ? input.preflight.seller.adapter : input.preflight.buyer.adapter;
    const resolved = await ownerAdapter.resolveAnchorByName(
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
    // A cold runtime must recover the exact original receipt and transaction
    // pointer from an owner-bound finalization handoff. A successful Demos read
    // is not itself an anchor receipt and must never be promoted into one.
    const finalizationLogicalAddress = role === "seller"
      ? sellerFinalizationLogicalAddress : buyerFinalizationLogicalAddress;
    const stored = role === "buyer"
      ? await resolveBuyerFinalizationHandoff()
      : await resolveHandoff(finalizationLogicalAddress, ownerDid);
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
        return (evaluatedParty === input.preflight.env.BUYER_DID &&
          signature.signer === input.preflight.env.SELLER_DID) ||
          (evaluatedParty === input.preflight.env.SELLER_DID &&
            signature.signer === input.preflight.env.BUYER_DID);
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
        const listingReadback = await input.preflight.buyer.adapter.readAnchor(
          input.published.receipt.nativeAddress,
        );
        if (
          listingReadback === null ||
          contentHash(listingReadback) !== input.published.listingPin.contentHash ||
          !await verifyAnchorReceipt(
            input.preflight.buyer.adapter,
            input.published.receipt,
            input.preflight.env.SELLER_DID,
          )
        ) return "invalid" as const;
        try {
          validateFixedPriceAgreementBinding({
            agreement: record as unknown as AgreementArtifact,
            verifiedListing: {
              disposition: "verified",
              listing: listingReadback as unknown as Listing,
              pin: input.published.listingPin,
            },
            committedAt: input.commitment.committedAt,
          });
        } catch {
          return "invalid" as const;
        }
        const agreementRecord = record as unknown as AgreementArtifact;
        const separator = "agreementVersion" in agreementRecord
          ? ARTIFACT_SEPARATORS.AgreementDocument
          : ARTIFACT_SEPARATORS.PayeeBoundAgreementDocument;
        return agreementRecord.signatures.every((signature) =>
          verifyEd25519(
            separator,
            record,
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
        const verifier = requirement.contentHash === input.vet.buyerRef.contentHash
          ? input.preflight.env.SELLER_DID
          : input.preflight.env.BUYER_DID;
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
    verifiedListing: _verifiedListing,
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
  requireCondition(
    Object.keys(requestVerificationInput).sort().join(",") ===
      "agreement,agreementRef,dependencies,finalisedAt,fulfilment,seller,session,sessionArtifacts",
    "buyer-verification-input-shape-invalid",
  );
  const request = await diagnosticStep("bundle-request-prepare", () =>
    prepareCompletedSellerBundleCounterSignatureRequest(requestInput)
  );
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
  const advanceBuyerUntilFinalized = async (
    workerPrefix: string,
    maxAttempts = 180,
  ): Promise<Extract<DurableBuyerBundleFinalizationProgress, { disposition: "finalised" }>> => {
    let last = "not-started";
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      buyerBundleStore = await createFsFencedSessionStore({ dir: buyerBundleDir });
      const progress = await advanceCompletedBuyerBundleDurable(
        buyerInput,
        buyerProvider,
        buyerDurability(`${workerPrefix}-${attempt}`),
      );
      if (progress.disposition === "finalised") return progress;
      const reason = safeDiagnosticCode(progress.reason);
      last = `${progress.disposition}-${progress.stage}-${reason}`;
      requireCondition(
        progress.disposition !== "rejected",
        `buyer-bundle-rejected-${progress.stage}-${reason}`,
      );
      if (attempt % 30 === 0) {
        process.stderr.write(`funded-e2e-step:buyer-bundle-recovery-${attempt}-${last}\n`);
      }
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
    throw new Error(`funded-e2e:buyer-bundle-recovery-timeout-${last}`);
  };
  const waiting = await diagnosticStep("bundle-buyer-process-a", () =>
    advanceCompletedBuyerBundleDurable(
      buyerInput,
      buyerProvider,
      buyerDurability("funded-buyer-bundle-process-a"),
    )
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
  sellerFinalization = await diagnosticStep("bundle-seller-process-a", () =>
    finalizeCompletedSellerBundleDurable(
      sellerInput,
      sellerProvider,
      sellerDurability(input.settlement.seller.fulfilmentStore, "funded-seller-bundle-process-a"),
    )
  );
  await anchorArtifact({
    adapter: input.preflight.seller.adapter,
    writer: input.preflight.env.SELLER_DID,
    logicalAddress: sellerFinalizationLogicalAddress,
    artifact: sellerFinalization as unknown as Record<string, unknown>,
  });
  const buyerFinalization = await diagnosticStep("bundle-buyer-process-b", () =>
    advanceBuyerUntilFinalized("funded-buyer-bundle-process-b")
  );
  const buyerFinalizationTransport = {
    transportVersion: "1" as const,
    logicalAddress: buyerFinalizationLogicalAddress,
    owner: input.preflight.env.BUYER_DID,
    finalizationEnvelopeHash: sha256Hex(canonicalize(buyerFinalization.result)),
    finalization: structuredClone(buyerFinalization.result),
  };
  await writeFile(
    buyerFinalizationTransportPath,
    canonicalize(buyerFinalizationTransport),
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  requireCondition(
    canonicalize(await resolveBuyerFinalizationHandoff()) ===
      canonicalize(buyerFinalization.result),
    "buyer-finalization-transport-readback-failed",
  );

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
  // Simulate a cold runtime boundary. Only filesystem WALs, the explicit
  // data-only transport handoff, and authenticated Demos publications survive.
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
  const buyerReplay = await advanceBuyerUntilFinalized(
    "funded-buyer-bundle-process-c",
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
  it("binds each prepared Vet reference to the verifier that signed it", () => {
    const buyerDid = "did:demos:agent:buyer";
    const sellerDid = "did:demos:agent:seller";
    const prepared = {
      buyer: { signature: { signer: sellerDid } },
      buyerRef: { signer: sellerDid },
      seller: { signature: { signer: buyerDid } },
      sellerRef: { signer: buyerDid },
    } as unknown as PreparedVetArtifacts;

    expect(() =>
      assertPreparedVetSignerBindings(prepared, buyerDid, sellerDid)
    ).not.toThrow();

    const rebound = structuredClone(prepared);
    rebound.sellerRef.signer = sellerDid;
    expect(() =>
      assertPreparedVetSignerBindings(rebound, buyerDid, sellerDid)
    ).toThrow("funded-e2e:prepared-vet-signer-binding-invalid");
  });

  it("retries immutable proof reads without promoting a non-establishing view", async () => {
    let recoveringCalls = 0;
    const recovered = await retryEstablishedRead(async () => {
      recoveringCalls += 1;
      if (recoveringCalls === 1) return false;
      if (recoveringCalls === 2) throw new Error("injected-proof-read-outage");
      return true;
    }, 3, 0);
    let invalidCalls = 0;
    const invalid = await retryEstablishedRead(async () => {
      invalidCalls += 1;
      return false;
    }, 3, 0);
    requireCondition(
      recovered && recoveringCalls === 3 && !invalid && invalidCalls === 3,
      "immutable-proof-retry-regression",
    );
  });

  it("retries only thrown failures from immutable authority reads", async () => {
    let calls = 0;
    const result = await retryReadOnly(async () => {
      calls += 1;
      if (calls < 3) throw new Error("injected-read-transport-failure");
      return "authenticated-readback";
    }, 3, 0);
    requireCondition(
      result === "authenticated-readback" && calls === 3,
      "read-retry-did-not-recover",
    );

    let terminalCalls = 0;
    let terminalFailure = false;
    try {
      await retryReadOnly(async () => {
        terminalCalls += 1;
        throw new Error("injected-persistent-read-failure");
      }, 2, 0);
    } catch (error) {
      terminalFailure = error instanceof Error &&
        error.message === "injected-persistent-read-failure";
    }
    requireCondition(
      terminalFailure && terminalCalls === 2,
      "read-retry-did-not-fail-closed",
    );
  });

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

  it("derives a replay-stable isolated local final receipt for WAL commit", () => {
    const hash = (value: string) => sha256Hex(`funded-final-receipt:${value}`);
    const authorizationBinding = {
      authorizationHash: hash("authorization"),
      fulfilmentId: `dacs4:fulfilment:${hash("fulfilment")}`,
      handoffBindingHash: hash("handoff"),
      agreementHash: hash("agreement"),
      paymentEvidenceHash: hash("payment"),
      settlementId: `settlement:${hash("settlement")}`,
      paymentPhaseIndex: PAYMENT_PHASE_INDEX,
      deliveryPhaseIndex: DELIVERY_PHASE_INDEX,
    };
    const input = {
      fulfilmentId: authorizationBinding.fulfilmentId,
      authorizationBinding,
      resultHash: hash("result"),
    };
    const first = fundedFinalSessionReceipt("funded-final-receipt-job", input);
    const replay = fundedFinalSessionReceipt(
      "funded-final-receipt-job",
      structuredClone(input),
    );
    authorizationBinding.settlementId = "mutated-after-publication";
    requireCondition(
      canonicalize(first) === canonicalize(replay) &&
        canonicalize(first).includes("mutated-after-publication") === false &&
        canonicalize(fundedFinalSessionReceipt("funded-final-receipt-job", {
          ...structuredClone(input),
          resultHash: hash("different-result"),
        })) !== canonicalize(first),
      "local-final-receipt-is-not-replay-stable-and-isolated",
    );
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
      maxDemosDebitOs: HARD_MAX_DEMOS_DEBIT_OS,
    });
    const sellerShort = fundedPreflightDecision({
      connectedChainId: BASE_SEPOLIA_CHAIN_ID,
      sellerDemosBalance: SELLER_MINIMUM_OS - 1n,
      buyerDemosBalance: BUYER_MINIMUM_OS,
      paymentBalance: PAYMENT_AMOUNT,
      maxDemosDebitOs: HARD_MAX_DEMOS_DEBIT_OS,
    });
    const buyerShort = fundedPreflightDecision({
      connectedChainId: BASE_SEPOLIA_CHAIN_ID,
      sellerDemosBalance: SELLER_MINIMUM_OS,
      buyerDemosBalance: BUYER_MINIMUM_OS - 1n,
      paymentBalance: PAYMENT_AMOUNT,
      maxDemosDebitOs: HARD_MAX_DEMOS_DEBIT_OS,
    });
    const tokenShort = fundedPreflightDecision({
      connectedChainId: BASE_SEPOLIA_CHAIN_ID,
      sellerDemosBalance: SELLER_MINIMUM_OS,
      buyerDemosBalance: BUYER_MINIMUM_OS,
      paymentBalance: PAYMENT_AMOUNT - 1n,
      maxDemosDebitOs: HARD_MAX_DEMOS_DEBIT_OS,
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

  it("reserves every confirmed Demos debit effect before invoking its broadcast", async () => {
    const calls: unknown[] = [];
    const adapter = {
      raw: {
        tx: {
          broadcast: async (validity: unknown) => {
            calls.push(validity);
            return { accepted: true };
          },
        },
      },
    } as unknown as DemosBackedAdapter;
    const budget = createFundedDemosDebitBudget(4n);
    installFundedDemosDebitGuard(adapter, budget);
    const sender = `0x${"a".repeat(64)}`;
    const validity = (hash: string, balanceRemovals: readonly string[]) => ({
      response: {
        data: {
          transaction: {
            hash,
            content: {
              from: sender,
              transaction_fee: {
                network_fee: "2",
                rpc_fee: "1",
                additional_fee: "0",
              },
              gcr_edits: balanceRemovals.map((amount) => ({
                type: "balance",
                operation: "remove",
                isRollback: false,
                account: sender,
                amount,
              })),
            },
          },
        },
      },
    });
    // The first confirmed transaction declares a 3 OS fee but removes 4 OS
    // from the sender. The total sender effect, not only transaction_fee, is
    // the irreversible debit that the operator's cap must cover.
    await adapter.raw.tx.broadcast(validity("1".repeat(64), ["1", "2", "1"]));
    requireCondition(budget.reservedOs === 4n && calls.length === 1, "demos-debit-not-reserved");

    let rejected = false;
    try {
      await adapter.raw.tx.broadcast(validity("2".repeat(64), ["1"]));
    } catch (error) {
      rejected = error instanceof Error && error.message === "funded-e2e:demos-debit-cap-exceeded";
    }
    requireCondition(rejected && budget.reservedOs === 4n && calls.length === 1, "demos-cap-not-fail-closed");

    const malformedBudget = createFundedDemosDebitBudget(10n);
    installFundedDemosDebitGuard(adapter, malformedBudget);
    let malformedRejected = false;
    try {
      await adapter.raw.tx.broadcast({
        response: {
          data: {
            transaction: {
              hash: "3".repeat(64),
              content: { from: sender, gcr_edits: [] },
            },
          },
        },
      });
    } catch (error) {
      malformedRejected = error instanceof Error &&
        error.message === "funded-e2e:demos-debit-effect-unavailable";
    }
    requireCondition(
      malformedRejected && malformedBudget.reservedOs === 0n && calls.length === 1,
      "demos-malformed-effect-not-fail-closed",
    );
  });

  it("persists the public coordinates needed to reconcile the original x402 run", () => {
    const jobId = "01JZ0000000000000000000179";
    const authorizationSearchFromBlock = 45_000_000;
    const adapter = (address: string) => ({
      getAddress: () => address,
    }) as unknown as DemosBackedAdapter;
    const intent = x402FundedRunIntent({
      env: {
        LIVE_E2E_MARKER_DIR: "/persistent/dacs-funded-ledger",
        LIVE_E2E_RUN_ID: "x402-reconciliation-179",
        LIVE_E2E_MAX_DEMOS_DEBIT_OS: HARD_MAX_DEMOS_DEBIT_OS.toString(),
        LIVE_E2E_MAX_PAYMENT_AMOUNT: HARD_MAX_PAYMENT_AMOUNT.toString(),
      },
      jobId,
      authorizationSearchFromBlock,
      buyer: { adapter: adapter("b".repeat(64)) },
      seller: { adapter: adapter("c".repeat(64)) },
      payer: `0x${"1".repeat(40)}`,
      payee: `0x${"2".repeat(40)}`,
      asset: `0x${"3".repeat(40)}`,
    } as unknown as Preflight);
    requireCondition(
      intent.details.jobId === jobId &&
        intent.details.authorizationSearchFromBlock === authorizationSearchFromBlock &&
        intent.details.maxDemosDebitOs === HARD_MAX_DEMOS_DEBIT_OS.toString() &&
        intent.details.maxPaymentAmount === HARD_MAX_PAYMENT_AMOUNT.toString(),
      "x402-reconciliation-coordinates-not-persisted",
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
    requireCondition(
      facilitatorFailureCode("invalid_exact_evm_transaction_failed") ===
        "invalid-exact-evm-transaction-failed" &&
        facilitatorFailureCode("rpc failure: 0xsecret") === "unclassified",
      "facilitator-failure-code-not-safely-classified",
    );
  });

  it("never sends an explicit facilitator rejection into chain recovery", () => {
    const rejected = commerceState();
    rejected.facilitatorOutcome = "failure";
    rejected.facilitatorFailureCode = "invalid-exact-evm-transaction-failed";
    let failure = "";
    try {
      requireNoExplicitFacilitatorFailure(rejected);
    } catch (error) {
      failure = error instanceof Error ? error.message : "non-error";
    }
    requireCondition(
      failure ===
        "funded-e2e:facilitator-settlement-failed-invalid-exact-evm-transaction-failed",
      "facilitator-rejection-entered-chain-recovery",
    );

    const ambiguous = commerceState();
    ambiguous.facilitatorOutcome = "threw";
    requireNoExplicitFacilitatorFailure(ambiguous);
    const settled = commerceState();
    settled.facilitatorOutcome = "success";
    requireNoExplicitFacilitatorFailure(settled);
  });

  it("reconstructs a seller receipt only from the exact finalized nonce transfer", async () => {
    const payer = `0x${"11".repeat(20)}` as `0x${string}`;
    const payee = `0x${"22".repeat(20)}` as `0x${string}`;
    const asset = `0x${"33".repeat(20)}` as `0x${string}`;
    const transactionHash = `0x${"aa".repeat(32)}` as `0x${string}`;
    const blockHash = `0x${"bb".repeat(32)}` as `0x${string}`;
    const jobId = "01K2D6Y7W8Q9R0S1T2V3W4X5Y6";
    const nonce = x402Eip3009Nonce(jobId, PAYMENT_PHASE_INDEX);
    let logReads = 0;
    const preflight = {
      payer,
      payee,
      asset,
      authorizationSearchFromBlock: 90,
      host: { resourceUrl: "https://seller.example/recovered" },
      evm: {
        getBlockNumber: async () => 110n,
        getLogs: async () => {
          logReads += 1;
          return [{ transactionHash }];
        },
        getTransactionReceipt: async () => ({
          status: "success",
          blockNumber: 100n,
          blockHash,
          logs: [
            {
              address: asset,
              topics: [
                EIP3009_AUTHORIZATION_USED_TOPIC,
                addressTopic(payer),
                nonce,
              ],
              data: "0x",
              logIndex: 5,
            },
            {
              address: asset,
              topics: [ERC20_TRANSFER_TOPIC, addressTopic(payer), addressTopic(payee)],
              data: `0x${PAYMENT_AMOUNT.toString(16).padStart(64, "0")}`,
              logIndex: 7,
            },
          ],
        }),
        getBlock: async () => ({ timestamp: 2_000n }),
      },
    } as unknown as Preflight;
    const requirements: X402BuyerPaymentRequirements = {
      scheme: "exact",
      network: BASE_SEPOLIA_NETWORK,
      amount: PAYMENT_AMOUNT.toString(),
      asset,
      payTo: payee,
      maxTimeoutSeconds: PAYMENT_TIMEOUT_SECONDS,
      extra: {
        name: TOKEN_NAME,
        version: TOKEN_VERSION,
        assetTransferMethod: "eip3009",
      },
    };
    const intent = {
      jobId,
      phaseIndex: PAYMENT_PHASE_INDEX,
      payer,
      httpResource: preflight.host.resourceUrl,
      paymentRequirements: requirements,
    } as X402PaywallSettlementIntent;
    const recovered = await recoverFundedSellerSettlement({ preflight, jobId, intent });
    requireCondition(recovered.status === "settled", "seller-settlement-not-recovered");
    const commitment = deriveX402ReceiptCommitment({
      protocolVersion: "2",
      responseHeader: {
        name: "PAYMENT-RESPONSE",
        value: recovered.settlement.headers["PAYMENT-RESPONSE"]!,
      },
    });
    requireCondition(
      commitment.disposition === "pass" &&
        recovered.settlement.transaction === transactionHash &&
        recovered.settlement.payer === payer &&
        recovered.settlement.amount === PAYMENT_AMOUNT.toString() &&
        logReads === 1,
      "seller-settlement-reconstruction-invalid",
    );

    const rebound = await recoverFundedSellerSettlement({
      preflight,
      jobId: `${jobId}-different`,
      intent,
    });
    requireCondition(
      rebound.status === "indeterminate" && logReads === 1,
      "seller-settlement-reconstruction-not-session-bound",
    );
  });

  it("uses the first exact RPC proof and rejects cross-RPC disagreement", async () => {
    const payer = `0x${"11".repeat(20)}` as `0x${string}`;
    const payee = `0x${"22".repeat(20)}` as `0x${string}`;
    const asset = `0x${"33".repeat(20)}` as `0x${string}`;
    const transactionHash = `0x${"aa".repeat(32)}` as `0x${string}`;
    const blockHash = `0x${"bb".repeat(32)}` as `0x${string}`;
    const jobId = "01K2D6Y7W8Q9R0S1T2V3W4X5Y6";
    const nonce = x402Eip3009Nonce(jobId, PAYMENT_PHASE_INDEX);
    const receipt = {
      status: "success" as const,
      blockNumber: 100n,
      blockHash,
      logs: [
        {
          address: asset,
          topics: [EIP3009_AUTHORIZATION_USED_TOPIC, addressTopic(payer), nonce],
          data: "0x",
          logIndex: 5,
        },
        {
          address: asset,
          topics: [ERC20_TRANSFER_TOPIC, addressTopic(payer), addressTopic(payee)],
          data: `0x${PAYMENT_AMOUNT.toString(16).padStart(64, "0")}`,
          logIndex: 7,
        },
      ],
    };
    let laggingReads = 0;
    const lagging = {
      getTransactionReceipt: async () => {
        laggingReads += 1;
        throw new Error("not-yet-visible");
      },
      getBlockNumber: async () => 110n,
    } as unknown as PublicClient;
    const exact = {
      getTransactionReceipt: async () => receipt,
      getBlockNumber: async () => 110n,
      getBlock: async () => ({ timestamp: 2_000n }),
    } as unknown as PublicClient;
    const inconsistent = {
      getTransactionReceipt: async () => ({
        ...receipt,
        logs: receipt.logs.map((log, index) => index === 1
          ? { ...log, logIndex: 8 } : log),
      }),
      getBlockNumber: async () => 110n,
      getBlock: async () => ({ timestamp: 2_000n }),
    } as unknown as PublicClient;
    const preflight = {
      payer,
      payee,
      asset,
      evm: exact,
      evmVerificationClients: [lagging, exact],
    } as unknown as Preflight;
    const observed = await observeFundedTransfer({ preflight, jobId, txHash: transactionHash });
    requireCondition(
      observed.status === "finalized" && observed.logIndex === 7 && laggingReads === 1,
      "secondary-rpc-proof-not-used",
    );

    let mismatch = "";
    try {
      await observeFundedTransfer({
        preflight: { ...preflight, evmVerificationClients: [exact, inconsistent] },
        jobId,
        txHash: transactionHash,
        requireAllRpcs: true,
      });
    } catch (error) {
      mismatch = error instanceof Error ? error.message : "non-error";
    }
    requireCondition(
      mismatch === "funded-e2e:cross-rpc-settlement-mismatch",
      "cross-rpc-disagreement-not-rejected",
    );
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
      const fastProfile = productionLatencyProfile();
      let preflight: Preflight | undefined;
      try {
        preflight = await stage("preflight", () => runNoWritePreflight(env, true));
        requireCondition(env.LIVE_E2E_CONFIRM === "1", "spend-not-confirmed");
        const demosDebitBudget = createFundedDemosDebitBudget(
          configuredPositiveInteger(
            env.LIVE_E2E_MAX_DEMOS_DEBIT_OS,
            "demos-debit-cap-invalid",
          ),
        );
        installFundedDemosDebitGuard(preflight.seller.adapter, demosDebitBudget);
        installFundedDemosDebitGuard(preflight.buyer.adapter, demosDebitBudget);
        await executeFundedRun(x402FundedRunIntent(preflight), async (marker) => {
          const jobId = preflight!.jobId;
          const selectedRail = rail(preflight!.host.resourceUrl);
          let published: PublishedListing | undefined;

        // The fast profile measures an honest buyer-visible session. A listing
        // is a reusable discovery artifact, so publish it before the timer with
        // a non-session-bound seller presentation. Vet remains inside the timer.
          if (fastProfile) {
            const listingNow = Date.now();
            const listingSellerIdentity = await identity(
              env.SELLER_DID,
              preflight!.seller.adapter,
              listingNow,
              undefined,
              false,
            );
            requireCondition(env.LIVE_E2E_CONFIRM === "1", "spend-not-confirmed");
            published = await stage("listing-presession", () => publishAndDiscoverListing({
              preflight: preflight!,
              jobId,
              sellerIdentity: listingSellerIdentity,
              selectedRail,
              now: listingNow,
            }));
          }

        const sessionStartedAt = Date.now();
        const now = sessionStartedAt;
        const [buyerIdentity, sellerIdentity, rediscovered] = await Promise.all([
          identity(env.BUYER_DID, preflight!.buyer.adapter, now, env.BUYER_EVM_KEY),
          identity(env.SELLER_DID, preflight!.seller.adapter, now),
          fastProfile
            ? stage("listing-discovery", () => rediscoverPublishedListing({
                preflight: preflight!,
                published: published!,
                selectedRail,
                now,
              }))
            : Promise.resolve(published),
        ]);
        published = rediscovered;
        const [buyerAgreementDir, sellerAgreementDir] = await Promise.all([
          temporaryDirectory("buyer-agreement"),
          temporaryDirectory("seller-agreement"),
        ]);

        // This check is deliberately adjacent to the first session-bound live
        // Demos write (or the first write in the exhaustive profile).
        requireCondition(env.LIVE_E2E_CONFIRM === "1", "spend-not-confirmed");
        published ??= await stage("listing", () => publishAndDiscoverListing({
            preflight: preflight!,
            jobId,
            sellerIdentity,
            selectedRail,
            now,
          }));
        requireCondition(
          published.listing.seller.publicEndpoint === preflight!.host.engagementUrl,
          "advertised-endpoint-mismatch",
        );
        const preparedVet = await prepareVetRecords({
          preflight: preflight!,
          jobId,
          buyerIdentity,
          sellerIdentity,
          now: now + 1,
        });
        const vetPromise = stage("vet", () => publishPreparedVetRecords({
          preflight: preflight!,
          prepared: preparedVet,
        }));
        // Handle either concurrent failure immediately; the ordered awaits
        // below still rethrow the exact error after both branches are settled.
        void vetPromise.catch(() => undefined);
        let commitmentPromise: ReturnType<typeof commitAgreement> | undefined;
        let finalizedVet: VetArtifacts | undefined;
        let agreement: AgreementRun;
        try {
          agreement = await stage("agreement", () => negotiateAgreement({
            preflight: preflight!,
            jobId,
            published,
            selectedRail,
            buyerIdentity,
            sellerIdentity,
            vet: preparedVet,
            now: now + 2,
            buyerDir: buyerAgreementDir,
            sellerDir: sellerAgreementDir,
            beforeAgreementPublication: async () => {
              finalizedVet = await vetPromise;
            },
            onSignedAgreement: (signedAgreement) => {
              requireCondition(finalizedVet !== undefined, "agreement-publication-before-vet-finality");
              requireCondition(commitmentPromise === undefined, "commitment-started-more-than-once");
              commitmentPromise = stage("commitment", () => commitAgreement({
                preflight: preflight!,
                jobId,
                published: published!,
                agreement: { agreement: signedAgreement },
                vet: finalizedVet!,
                now: now + 3,
              }));
              // The agreement anchor may outlive a quickly rejected commitment.
              // Handle the concurrent promise now; awaiting it below still
              // preserves its exact failure after agreement closure.
              void commitmentPromise.catch(() => undefined);
            },
          }));
        } catch (error) {
          await vetPromise.catch(() => undefined);
          await commitmentPromise?.catch(() => undefined);
          throw error;
        }
        const vet = finalizedVet ?? await vetPromise;
        requireCondition(
          preflight!.host.requestCounts.engagement === 1,
          "advertised-engagement-endpoint-not-invoked",
        );
        requireCondition(commitmentPromise !== undefined, "commitment-not-started");
        const commitment = await commitmentPromise;
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
        if (fastProfile) {
          requireCondition(
            settlement.state.deliveryReadyAt !== undefined &&
              settlement.state.deliveryReadyAt >= sessionStartedAt,
            "delivery-ready-milestone-missing",
          );
          process.stderr.write(
            `funded-e2e-fast:delivery-ready-elapsed-ms:${
              settlement.state.deliveryReadyAt - sessionStartedAt
            }\n`,
          );
          if (process.env.LIVE_E2E_DELIVERY_ONLY === "1") {
            requireCondition(
              fundedFulfilmentEffectsComplete(settlement.state),
              "delivery-only-finalisation-incomplete",
            );
            const observation = settlement.state.observedTransfer;
            requireCondition(observation !== undefined, "delivery-only-transfer-observation-missing");
            const crossRpc = await diagnosticStep("delivery-only-cross-rpc", () =>
              observeFundedTransfer({
                preflight: preflight!,
                jobId,
                txHash: observation.txHash,
                requireAllRpcs: true,
              })
            );
            requireCondition(
              crossRpc.status === "finalized" &&
                sameFinalizedTransfer(crossRpc, observation),
              "delivery-only-cross-rpc-mismatch",
            );
            await recordX402FundedOutcome(
              marker,
              "delivery-complete",
              jobId,
              demosDebitBudget.reservedOs,
            );
            process.stderr.write("funded-e2e-fast:delivery-only-complete\n");
            return;
          }
        }
        let commerceCompleteAt: number | undefined;
        const paymentEvidencePublication = settlement.paymentEvidencePublication ??
          stage("settlement-publication", () => {
            const permit = settlement.state.permit;
            const observation = settlement.state.observedTransfer;
            requireCondition(permit !== undefined, "seller-payment-permit-missing");
            requireCondition(observation !== undefined, "seller-chain-observation-missing");
            return publishAndVerifySellerSettlement({
              preflight: preflight!,
              jobId,
              agreement,
              selectedRail,
              payment: {
                permit,
                observation,
                receiptStore: settlement.seller.receiptStore,
                sessionBindingHash: settlement.intent.bindingHash,
              },
            });
          });
        const [settlementPublicationResult, vetPublicationResult] = await Promise.allSettled([
          paymentEvidencePublication.then((result) => {
            commerceCompleteAt = Date.now();
            return result;
          }),
          stage("vet-provenance-publication", () =>
            publishExternalSellerVetProvenance({
              preflight: preflight!,
              jobId,
              vet,
            })
          ),
        ]);
        if (settlementPublicationResult.status === "rejected") {
          throw settlementPublicationResult.reason;
        }
        if (vetPublicationResult.status === "rejected") {
          throw vetPublicationResult.reason;
        }
        const sellerSettlement = settlementPublicationResult.value;
        const publishedVet = vetPublicationResult.value;
        if (fastProfile) {
          requireCondition(
            commerceCompleteAt !== undefined &&
              commerceCompleteAt >= settlement.state.deliveryReadyAt!,
            "commerce-complete-milestone-missing",
          );
          process.stderr.write(
            `funded-e2e-fast:commerce-complete-elapsed-ms:${
              commerceCompleteAt - sessionStartedAt
            }\n`,
          );
        }
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
            vet: publishedVet,
          })
        );
        requireCondition(
          bundles.sellerFinalization.sellerBundle.anchoredByRole === "seller" &&
          bundles.buyerFinalization.buyerBundle.anchoredByRole === "buyer",
          "funded-role-owned-bundle-closure-failed",
        );
        if (fastProfile) {
          process.stderr.write(
            `funded-e2e-fast:audit-complete-elapsed-ms:${Date.now() - sessionStartedAt}\n`,
          );
        }
        await recordX402FundedOutcome(
          marker,
          "audit-complete",
          jobId,
          demosDebitBudget.reservedOs,
        );
        });
      } finally {
        if (preflight) await preflight.host.close();
      }
    }, 900_000);
  }
});

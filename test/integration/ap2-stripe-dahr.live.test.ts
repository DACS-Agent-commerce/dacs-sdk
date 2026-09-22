import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  advanceAp2Settlement,
  canonicalize,
  contentHash,
  createUnsafeManualAgent,
  createFsAp2BindingStore,
  createFsDemosWriteJournal,
  createStripeAp2Integration,
  isSettlementEvidence,
  paymentEvidenceAddress,
  sha256Hex,
  signComponentArtifact,
  type ChainTxRef,
  type Ap2MandateVerifier,
  type Ap2VerifiedCheckoutMandate,
  type Ap2VerifiedPaymentMandate,
} from "../../src/index.js";

const OFFICIAL_AP2_COMMIT = "e1ea56db72a6385bce3e5c1112b3a56ce60acb43";
const DEMOS_RPC = "https://node2.demos.sh";
const FAUCET_URL = "https://faucetbackend.demos.sh/api/request";
const DEFAULT_JOB_ID = "01K4AP2PAY0000000000000000";
const JOB_ID = process.env.DACS_AP2_LIVE_JOB_ID?.trim() || DEFAULT_JOB_ID;
const PHASE_INDEX = 2;
const RAIL_ID = "ap2:stripe-paymentintents";
const AMOUNT = "0.5";
const AMOUNT_MINOR = 50;
const CURRENCY = "USD";
const MINIMUM_OS = 12n * 1_000_000_000n;
const FAUCET_REQUEST_DEM = 20;

interface OfficialReferenceBundle {
  officialAp2Commit: string;
  request: object;
  verified: OfficialVerifiedChain;
}

interface OfficialVerifiedChain {
  checkout: { checkoutJwt: string; sdAlg?: string };
  payment: {
    mandateId: string;
    transactionId: string;
    payee: { id: string };
    paymentAmount: { amount: number; currency: string };
    paymentInstrument: { id: string };
  };
  merchantSignature: {
    algorithm: string;
    generation: "non-deterministic";
  };
}

const requiredEnv = [
  "DACS_AP2_DEMOS_WALLET",
  "DACS_AP2_STRIPE_CREATE_KEY",
  "DACS_AP2_STRIPE_STATUS_KEY",
  "DACS_AP2_OFFICIAL_PYTHON",
  "DACS_AP2_STATE_DIR",
  "DACS_AP2_LIVE_CONFIRM",
] as const;
const missing = requiredEnv.filter((name) => !process.env[name]);
const ready = missing.length === 0;
if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(JOB_ID)) {
  throw new Error("DACS_AP2_LIVE_JOB_ID must be a canonical 26-character ULID");
}
const helperPath = fileURLToPath(
  new URL("./helpers/ap2-official-reference.py", import.meta.url),
);

function officialHelper<T>(mode: "generate" | "verify", input: unknown): T {
  const python = process.env.DACS_AP2_OFFICIAL_PYTHON!;
  const result = spawnSync(python, [helperPath, mode], {
    encoding: "utf8",
    input: JSON.stringify(input),
    maxBuffer: 2 * 1024 * 1024,
    timeout: 20_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`official AP2 helper rejected input: ${result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout) as T;
}

function officialVerifier(): Ap2MandateVerifier<unknown, unknown> {
  let pending: Promise<OfficialVerifiedChain> | undefined;
  const verify = (artifact: unknown) => pending ??= Promise.resolve().then(
    () => officialHelper<OfficialVerifiedChain>("verify", artifact),
  );
  return {
    async verifyCheckoutMandate(artifact) {
      const value = await verify(artifact);
      const mandate: Ap2VerifiedCheckoutMandate = {
        checkoutJws: value.checkout.checkoutJwt,
        ...(value.checkout.sdAlg === undefined ? {} : { sdAlg: value.checkout.sdAlg }),
        algorithm: value.merchantSignature.algorithm,
        signatureGeneration: value.merchantSignature.generation,
      };
      return { disposition: "verified", mandate };
    },
    async verifyPaymentMandate(artifact) {
      const value = await verify(artifact);
      const mandate: Ap2VerifiedPaymentMandate = {
        transactionId: value.payment.transactionId,
        mandateId: value.payment.mandateId,
        payee: value.payment.payee.id,
        amount: String(value.payment.paymentAmount.amount / 100),
        currency: value.payment.paymentAmount.currency,
        paymentInstrumentId: value.payment.paymentInstrument.id,
      };
      return { disposition: "verified", mandate };
    },
  };
}

async function secureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("AP2 live state directory is unsafe");
  }
  await chmod(path, 0o700);
}

async function loadOrCreatePresentation(path: string): Promise<OfficialReferenceBundle> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as OfficialReferenceBundle;
    if (parsed.officialAp2Commit !== OFFICIAL_AP2_COMMIT) {
      throw new Error("persisted AP2 presentation uses a different official SDK commit");
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const generated = officialHelper<OfficialReferenceBundle>("generate", {
    amountMinor: AMOUNT_MINOR,
    currency: CURRENCY,
    payeeId: "acct_dacs_reference",
    payeeName: "DACS AP2 Reference",
    paymentInstrumentId: "pm_card_visa",
  });
  const serialized = JSON.stringify(generated);
  // Trust material must contain public JWKs only.
  if (/"d"\s*:/.test(serialized)) {
    throw new Error("official AP2 helper returned private JWK material");
  }
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return generated;
}

async function balanceOs(
  agent: Awaited<ReturnType<typeof createUnsafeManualAgent>>,
): Promise<bigint> {
  const network = await agent.adapter.raw.getNetworkInfo();
  if (!network) throw new Error("Demos denomination preflight is unavailable");
  const info = await agent.adapter.raw.getAddressInfo(agent.adapter.getAddress());
  const raw = info?.balance ?? 0n;
  return network.forks?.osDenomination?.activated ? raw : raw * 1_000_000_000n;
}

async function ensureFaucetFunds(
  agent: Awaited<ReturnType<typeof createUnsafeManualAgent>>,
): Promise<bigint> {
  let balance = await balanceOs(agent);
  if (balance >= MINIMUM_OS) return balance;
  const response = await fetch(FAUCET_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      address: agent.adapter.getAddress(),
      amount: FAUCET_REQUEST_DEM,
    }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Demos faucet rejected the AP2 test wallet: HTTP ${response.status}`);
  }
  let publicReceipt: Record<string, unknown>;
  try {
    publicReceipt = JSON.parse(body) as Record<string, unknown>;
  } catch {
    throw new Error("Demos faucet returned malformed JSON");
  }
  console.info("AP2 live faucet accepted", {
    address: agent.adapter.getAddress(),
    status: publicReceipt.status,
  });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    balance = await balanceOs(agent);
    if (balance >= MINIMUM_OS) return balance;
  }
  throw new Error("faucet transfer was not visible before the live-test deadline");
}

describe("LIVE AP2 → Stripe → DAHR → Demos reference path", () => {
  if (!ready) {
    it.skip(`requires ${missing.join(", ")}`, () => {});
    return;
  }

  it("settles once, attests the provider receipt, and anchors signed evidence", async () => {
    if (process.env.DACS_AP2_LIVE_CONFIRM !== "1") {
      throw new Error("set DACS_AP2_LIVE_CONFIRM=1 to acknowledge test-mode effects");
    }
    const stateDir = process.env.DACS_AP2_STATE_DIR!;
    await secureDirectory(stateDir);
    const journal = await createFsDemosWriteJournal({
      dir: join(stateDir, "demos-write-journal"),
    });
    const agent = await createUnsafeManualAgent({
      demosRpc: DEMOS_RPC,
      wallet: process.env.DACS_AP2_DEMOS_WALLET!,
      demosWriteJournal: journal,
    });
    const address = agent.adapter.getAddress();
    const signer = `did:demos:agent:${address.replace(/^0x/, "").toLowerCase()}`;
    const fundedBalance = await ensureFaucetFunds(agent);
    console.info("AP2 live Demos preflight", {
      rpc: DEMOS_RPC,
      address,
      balanceOs: fundedBalance.toString(),
    });

    const official = await loadOrCreatePresentation(
      join(stateDir, "official-ap2-presentation.json"),
    );
    expect(official.officialAp2Commit).toBe(OFFICIAL_AP2_COMMIT);
    const verifier = officialVerifier();
    const agreementHash = sha256Hex(canonicalize({
      jobId: JOB_ID,
      phaseIndex: PHASE_INDEX,
      railId: RAIL_ID,
      payeeId: "acct_dacs_reference",
      amount: AMOUNT,
      currency: CURRENCY,
    }));
    const integration = createStripeAp2Integration({
      createCredential: process.env.DACS_AP2_STRIPE_CREATE_KEY!,
      statusCredential: process.env.DACS_AP2_STRIPE_STATUS_KEY!,
      payeeId: "acct_dacs_reference",
      currencyMinorUnits: 2,
      substrate: agent.adapter,
    });
    const store = await createFsAp2BindingStore({
      dir: join(stateDir, "ap2-settlement-store"),
    });
    const progress = await advanceAp2Settlement({
      jobId: JOB_ID,
      phaseIndex: PHASE_INDEX,
      agreementHash,
      protocolVersion: "0.2",
      expected: {
        payee: "acct_dacs_reference",
        amount: AMOUNT,
        currency: CURRENCY,
      },
      checkoutMandate: official.request,
      paymentMandate: official.request,
      owner: signer,
      verifier,
      provider: integration.provider,
      store,
    });
    expect(progress.status).toBe("settled");
    if (progress.status !== "settled") throw new Error("AP2 capture is still pending");
    const txRef: ChainTxRef = progress.settlement.receiptTransactionRef === undefined
      ? {
          kind: "ap2",
          mandateId: progress.settlement.mandateId,
          providerRef: progress.settlement.providerRef,
          protocolVersion: progress.settlement.protocolVersion,
          receiptAttestation: structuredClone(progress.settlement.receiptAttestation),
        }
      : {
          kind: "ap2-sr3",
          mandateId: progress.settlement.mandateId,
          providerRef: progress.settlement.providerRef,
          protocolVersion: progress.settlement.protocolVersion,
          receiptAttestation: structuredClone(progress.settlement.receiptAttestation),
          receiptTransactionRef: structuredClone(
            progress.settlement.receiptTransactionRef,
          ),
        };

    const unsignedEvidence = {
      evidenceVersion: "1" as const,
      jobId: JOB_ID,
      phase: "pay-ap2" as const,
      outcome: "success" as const,
      paymentTxRefs: [txRef],
      paymentAmount: { amount: AMOUNT, currency: CURRENCY },
      settlementFinality: {
        model: "provider-receipt" as const,
        finalityObservedAt: progress.settlement.capturedAt,
      },
      observedAt: progress.settlement.capturedAt,
    };
    const evidence = await signComponentArtifact(
      unsignedEvidence,
      "dacs-evidence:v1:",
      {
        algorithm: "ed25519",
        signer,
        sign: (bytes) => agent.adapter.sign(bytes),
      },
    );
    expect(isSettlementEvidence(evidence)).toBe(true);
    const logicalAddress = paymentEvidenceAddress(JOB_ID, RAIL_ID, PHASE_INDEX);
    const anchored = await agent.adapter.anchorWriteOnce(
      logicalAddress,
      evidence,
      {
        metadata: {
          logicalAddress,
          contentHash: contentHash(evidence),
          envelopeHash: sha256Hex(canonicalize(evidence)),
        },
      },
    );
    expect(anchored.txRef).toBeTruthy();
    expect(anchored.demosEvidence).toBeTruthy();
    const readback = await agent.adapter.readAnchor(anchored.address);
    expect(readback).not.toBeNull();
    expect(canonicalize(readback)).toBe(canonicalize(evidence));
    console.info("AP2 live reference completed", {
      officialAp2Commit: OFFICIAL_AP2_COMMIT,
      dacsJobId: JOB_ID,
      providerRef: progress.settlement.providerRef,
      receiptAttestationHash: progress.settlement.receiptAttestation.contentHash,
      evidenceAddress: anchored.address,
      evidenceTxRef: anchored.txRef,
      signer,
    });
  }, 300_000);
});

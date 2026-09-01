import { types as nodeTypes } from "node:util";

import {
  canonicalize,
  contentHash,
  encodeAddressSegment,
  stripSignature,
} from "../canonical/index.js";
import { canonicalizeDecimal } from "../canonical/decimal.js";
import {
  snapshotCanonicalJson,
  snapshotCanonicalJsonConfig,
  snapshotCanonicalJsonRead,
} from "../canonical/snapshot.js";
import { signedBytes } from "../crypto/index.js";
import { ARTIFACT_SEPARATORS } from "../artifacts/registry.js";
import type { AttestationRef, ChainTxRef } from "../artifacts/types.js";
import { isComponentSignature } from "../artifacts/signatures.js";
import {
  isAttestationRef,
  isChainTxRef,
  isSettlementEvidence,
} from "../artifacts/validators.js";
import { type Verifier } from "./signedArtifact.js";

/**
 * SettlementEvidence verifier (DACS-4 §9.7, driven by DACS-5 §14 settlement
 * vectors). A payment/delivery phase anchors one SettlementEvidence; DACS-5
 * reads it into the bundle. Before it can be trusted a verifier MUST confirm the
 * record is well-formed for its phase family, its money fields are canonical and
 * coherent with the agreement/rail, its attestation ref hash-matches, and its
 * signature verifies under the phase orchestrator's key.
 *
 * The four-valued result mirrors the rest of DACS verification: a definite
 * violation is `fail`; a key that resolves but is malformed is `error` (not a
 * false fail); a signer key that can't be resolved is `indeterminate`; an
 * all-clear record is `pass`. Worst-wins across checks, ordered
 * error > indeterminate > fail > pass (§7.7 composite discipline).
 *
 * Pure over injected context (the resolved agreement + rail + expected signer)
 * and a key resolver, so it's unit-tested without a node. Checks that need
 * context absent from the call are skipped (can't-evaluate ≠ fail), so a caller
 * that supplies only the record still gets the full structural verdict.
 */

export type EvidenceDecision = "pass" | "fail" | "error" | "indeterminate";

export interface EvidenceVerification {
  decision: EvidenceDecision;
  /** Human-readable violation reasons (empty on a clean pass). */
  reasons: string[];
}

/** The negotiated agreement price, for the currency / underpayment checks. */
export interface EvidenceAgreementContext {
  amount?: string;
  currency?: string;
}

/** Decision-bearing subset of the pinned DACS-4 AssetSpec. */
export interface EvidenceRailAssetSpecContext {
  kind: string;
  chainId?: number;
  cluster?: string;
}

/** Decision-bearing subset of the pinned DACS-4 NetworkSpec. */
export interface EvidenceRailNetworkSpecContext {
  kind: string;
  chainId?: number;
  cluster?: string;
}

/** The pinned rail, for the phase/rail-coherence checks (§9.4/§9.5). */
export interface EvidenceRailContext {
  railId?: string;
  /** evm-erc20 | solana-spl | cross-chain-htlc | cross-chain-liquidity-tank | ap2 | x402 | demos-native */
  railType?: string;
  /** The rail's settlement asset id/symbol the amount MUST resolve to (PC-5). */
  asset?: string;
  /** Structured pinned asset fields required for RD-5 kind/chain coherence. */
  assetSpec?: EvidenceRailAssetSpecContext;
  /**
   * Canonical pinned settlement network: `eip155:<chainId>`,
   * `solana:<mainnet|devnet|testnet>`, or `demos`. When supplied, explicit
   * ChainTxRef network fields MUST match it.
   */
  network?: string;
  /** Structured pinned network fields required for RD-5 kind/chain coherence. */
  networkSpec?: EvidenceRailNetworkSpecContext;
  /**
   * The phase handler the rail declares it settles through. MUST be coherent
   * with `railType` (a rail typed evm-erc20 whose handler is pay-solana-spl is
   * internally incoherent — RD-5).
   */
  handler?: string;
  /** REQUIRED HTLC route params (HTLC-7): both must be present for a cross-chain-htlc phase. */
  sourceFinalitySec?: number;
  safetyWindowSec?: number;
}

export interface EvidenceContext {
  /** The phase orchestrator — the only permitted signer of the evidence (§9.7). */
  orchestrator?: string;
  agreement?: EvidenceAgreementContext;
  rail?: EvidenceRailContext;
  /** The DACS-2 §7.5.2 ref under which this evidence is anchored. */
  attestationRef?: Readonly<AttestationRef>;
  /**
   * The phase-handler result envelope, when the caller has it. `ok`/`errorClass`
   * MUST be coherent: `ok: true` carries no `errorClass`; `ok: false` MUST carry
   * one (a fault the reader can classify). Skipped when absent.
   */
  result?: {
    ok?: boolean;
    errorClass?: string;
    /** Exact authenticated handler-return refs; order and values are binding. */
    txRefs?: readonly ChainTxRef[];
  };
  /**
   * Authenticated PC-2 address tuple for this payment invocation. The verifier
   * derives the complete logical locator itself; callers cannot substitute a
   * preassembled address or compare only the terminal phase index.
   */
  paymentAddress?: {
    railId: string;
    phaseIndex: number;
    resolved?: boolean;
  };
  /**
   * The locator the deliverable MUST be anchored at (derived by the caller from
   * the SR-2 address scheme). When set, `deliverableAnchor.locator` MUST equal it.
   */
  expectedAnchorLocator?: string;
  /**
   * Absolute HTLC expiry instants (unix ms/s), when a cross-chain-htlc route is
   * being checked for the HTLC-7 timelock margin. Skipped when absent.
   */
  htlcExpiry?: { source: number; dest: number };
}

export interface EvidenceDeps {
  /** Resolve the signer to its ed25519 public key (null = unresolvable). */
  resolvePublicKey?: (signer: string) => Promise<Uint8Array | null>;
  /** Verify a signature over raw bytes for a public key. */
  verify?: Verifier;
}

const PAYMENT_PHASES = new Set([
  "pay-evm-erc20",
  "pay-solana-spl",
  "pay-cross-chain-htlc",
  "pay-cross-chain-liquidity-tank",
  "pay-ap2",
  "pay-x402",
  "pay-dem",
]);
const DELIVERY_PHASES = new Set([
  "deliver-storage-program",
  "deliver-entitlement",
  "deliver-attested-payload",
]);

/** Phase → the railType its pinned rail MUST declare (PC-1 / RD-5 coherence). */
const PHASE_RAIL_TYPE: Record<string, string> = {
  "pay-evm-erc20": "evm-erc20",
  "pay-solana-spl": "solana-spl",
  "pay-cross-chain-htlc": "cross-chain-htlc",
  "pay-cross-chain-liquidity-tank": "cross-chain-liquidity-tank",
  "pay-ap2": "ap2",
  "pay-x402": "x402",
  "pay-dem": "demos-native",
};

const RAIL_SPEC_KINDS: Readonly<
  Record<string, Readonly<{ asset: string; network: string }>>
> = Object.freeze({
  "evm-erc20": Object.freeze({ asset: "erc20", network: "evm" }),
  "solana-spl": Object.freeze({ asset: "spl", network: "solana" }),
  "cross-chain-htlc": Object.freeze({
    asset: "stablecoin-cross-chain",
    network: "cross-chain",
  }),
  "cross-chain-liquidity-tank": Object.freeze({
    asset: "stablecoin-cross-chain",
    network: "cross-chain",
  }),
  ap2: Object.freeze({ asset: "fiat-via-ap2", network: "ap2-provider" }),
  "demos-native": Object.freeze({ asset: "native-dem", network: "demos" }),
});

/**
 * The closed set of §9.7 SettlementFinalityRecord.model tokens (PC-6). Presence
 * of `settlementFinality` is not enough — an out-of-set model (`"trust-me"`)
 * MUST be rejected, else a record can assert an unverifiable finality basis and
 * still pass. The v0.1 set is the first five; `bft-final` is the substrate-native
 * model the pay-dem rail (§9.5.9) reports and is carried in the SDK's
 * SettlementFinalityModel union, so it's accepted here too.
 */
const FINALITY_MODELS = new Set([
  "block-depth",
  "commitment-level",
  "provider-receipt",
  "htlc-reveal",
  "liquidity-tank",
  "bft-final",
]);
const SOLANA_COMMITMENTS = new Set(["processed", "confirmed", "finalized"]);

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const is64Hex = (v: unknown): v is string => isStr(v) && /^[0-9a-f]{64}$/.test(v);
const isPositiveSafeInteger = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const isSafeUint = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && !Object.is(v, -0);

function expectedPaymentEvidenceLocator(
  jobId: string,
  address: Readonly<NonNullable<EvidenceContext["paymentAddress"]>>,
): string {
  return (
    `dacs4:payment:${jobId}:${encodeAddressSegment(address.railId)}:` +
    `${address.phaseIndex}${address.resolved === true ? ":resolved" : ""}`
  );
}

type PinnedEvidenceNetwork =
  | { kind: "evm"; chainId: number }
  | { kind: "solana"; cluster: "mainnet" | "devnet" | "testnet" }
  | { kind: "demos" };

function parsePinnedEvidenceNetwork(
  value: string,
): PinnedEvidenceNetwork | null {
  if (value === "demos") return { kind: "demos" };
  const evm = /^eip155:([1-9][0-9]*)$/.exec(value);
  if (evm) {
    const chainId = Number(evm[1]);
    return Number.isSafeInteger(chainId) && chainId > 0
      ? { kind: "evm", chainId }
      : null;
  }
  const solana = /^solana:(mainnet|devnet|testnet)$/.exec(value);
  return solana
    ? {
        kind: "solana",
        cluster: solana[1] as "mainnet" | "devnet" | "testnet",
      }
    : null;
}

/** Canonical CD-1 decimal? (canonicalising it is a no-op.) */
function isCanonicalDecimal(v: unknown): boolean {
  if (!isStr(v)) return false;
  try {
    return canonicalizeDecimal(v) === v;
  } catch {
    return false;
  }
}
/** Numeric compare of two canonical decimal strings a<b / a==b via scaled bigint. */
function cmpDecimal(a: string, b: string): number {
  const [ai, af = ""] = a.split(".");
  const [bi, bf = ""] = b.split(".");
  const scale = Math.max(af.length, bf.length);
  const an = BigInt((ai ?? "0") + af.padEnd(scale, "0"));
  const bn = BigInt((bi ?? "0") + bf.padEnd(scale, "0"));
  return an < bn ? -1 : an > bn ? 1 : 0;
}
/** Sign of a canonical decimal: -1/0/1 (assumes valid CD-1, no leading "-" in CD-1 → never <0). */
function decimalIsPositive(v: string): boolean {
  return /[1-9]/.test(v);
}

/**
 * Verify one SettlementEvidence record (its signed scope = the record without
 * `signature`). See the module doc for the four-valued verdict.
 */
export async function verifySettlementEvidence(
  record: unknown,
  ctx: EvidenceContext = {},
  deps: EvidenceDeps = {},
): Promise<EvidenceVerification> {
  const reasons: string[] = [];
  let sawError = false;
  let sawIndeterminate = false;
  let failCount = 0;
  const fail = (r: string) => {
    failCount += 1;
    reasons.push(r);
  };

  // Pin callback implementations before inspecting either caller-owned input,
  // then own one exact JSON view of the record and contextual claims. Optional
  // context members whose value is `undefined` are equivalent to omission at
  // this JavaScript configuration boundary; protocol evidence remains strict.
  let resolvePublicKey: EvidenceDeps["resolvePublicKey"];
  let verify: EvidenceDeps["verify"];
  try {
    const resolveCandidate: unknown = deps.resolvePublicKey;
    const verifyCandidate: unknown = deps.verify;
    if (resolveCandidate !== undefined && typeof resolveCandidate !== "function") {
      throw new TypeError("resolvePublicKey must be a function");
    }
    if (verifyCandidate !== undefined && typeof verifyCandidate !== "function") {
      throw new TypeError("verify must be a function");
    }
    resolvePublicKey =
      resolveCandidate === undefined
        ? undefined
        : (Function.prototype.bind.call(
            resolveCandidate,
            deps,
          ) as NonNullable<EvidenceDeps["resolvePublicKey"]>);
    verify =
      verifyCandidate === undefined
        ? undefined
        : (Function.prototype.bind.call(
            verifyCandidate,
            deps,
          ) as NonNullable<EvidenceDeps["verify"]>);
  } catch {
    return {
      decision: "error",
      reasons: ["evidence verifier dependencies are malformed"],
    };
  }

  let recordSnapshot: unknown;
  let contextSnapshot: EvidenceContext;
  try {
    recordSnapshot = snapshotCanonicalJsonRead(record, "settlement evidence");
    contextSnapshot = snapshotCanonicalJsonConfig(
      ctx,
      "settlement evidence context",
    );
  } catch {
    return {
      decision: "error",
      reasons: ["evidence or verification context is not stable canonical JSON"],
    };
  }
  record = recordSnapshot;
  ctx = contextSnapshot;

  const assetSpec = ctx.rail?.assetSpec;
  const networkSpec = ctx.rail?.networkSpec;
  if (
    assetSpec !== undefined &&
    (!isObj(assetSpec) || !isStr(assetSpec.kind) || assetSpec.kind.length === 0 ||
      (assetSpec.chainId !== undefined && !isPositiveSafeInteger(assetSpec.chainId)) ||
      (assetSpec.cluster !== undefined &&
        (!isStr(assetSpec.cluster) || assetSpec.cluster.length === 0)))
  ) {
    sawError = true;
    reasons.push("pinned rail assetSpec is malformed");
  }
  if (
    networkSpec !== undefined &&
    (!isObj(networkSpec) || !isStr(networkSpec.kind) || networkSpec.kind.length === 0 ||
      (networkSpec.chainId !== undefined && !isPositiveSafeInteger(networkSpec.chainId)) ||
      (networkSpec.cluster !== undefined &&
        (!isStr(networkSpec.cluster) || networkSpec.cluster.length === 0)))
  ) {
    sawError = true;
    reasons.push("pinned rail networkSpec is malformed");
  }
  if (
    ctx.paymentAddress !== undefined &&
    (!isObj(ctx.paymentAddress) || !isStr(ctx.paymentAddress.railId) ||
      ctx.paymentAddress.railId.length === 0 ||
      ctx.paymentAddress.railId.normalize("NFC") !== ctx.paymentAddress.railId ||
      /[\s\u0000-\u001f\u007f]/.test(ctx.paymentAddress.railId) ||
      !isSafeUint(ctx.paymentAddress.phaseIndex) ||
      (ctx.paymentAddress.resolved !== undefined &&
        typeof ctx.paymentAddress.resolved !== "boolean"))
  ) {
    sawError = true;
    reasons.push("payment evidence address context is malformed");
  }
  if (
    ctx.result?.txRefs !== undefined &&
    (!Array.isArray(ctx.result.txRefs) ||
      !ctx.result.txRefs.every((ref) => isChainTxRef(ref)))
  ) {
    sawError = true;
    reasons.push("phase result txRefs context is malformed");
  }

  // A non-object root isn't a record at all — it can't be evaluated as evidence,
  // so it's `error` (input isn't parseable), not a definite `fail` (§7.5.1) —
  // consistent with the malformed-key line below.
  if (!isObj(record)) return { decision: "error", reasons: ["evidence is not an object"] };

  const ev = stripSignature(record);
  const phase = ev["phase"];
  const outcome = ev["outcome"];
  const isPayment = isStr(phase) && PAYMENT_PHASES.has(phase);
  const isDelivery = isStr(phase) && DELIVERY_PHASES.has(phase);

  // ── Basic shape (§9.7) ──────────────────────────────────────────────────
  if (ev["evidenceVersion"] !== "1") fail(`evidenceVersion MUST be "1"`);
  if (!isStr(ev["jobId"]) || ev["jobId"] === "") fail("jobId MUST be a non-empty string");
  if (!isPayment && !isDelivery) fail(`unknown phase "${String(phase)}"`);
  if (outcome !== "success" && outcome !== "failure") fail(`outcome MUST be "success"|"failure"`);
  if (!isNum(ev["observedAt"])) fail("observedAt MUST be a unix-ms number");
  if (!isSettlementEvidence(record)) {
    fail("evidence does not match an exact DACS-4 §9.7 SettlementEvidence variant");
  }

  // A failure-outcome record MUST carry a reason.
  if (outcome === "failure" && (!isStr(ev["reason"]) || ev["reason"] === "")) {
    fail("failure-outcome evidence MUST carry a `reason`");
  }

  // Phase-result envelope coherence (ok ⇔ no errorClass).
  if (ctx.result && ctx.result.ok !== undefined) {
    const hasErrorClass = isStr(ctx.result.errorClass) && ctx.result.errorClass !== "";
    if (ctx.result.ok === true && hasErrorClass) {
      fail("phase result is ok:true but carries an errorClass");
    }
    if (ctx.result.ok === false && !hasErrorClass) {
      fail("phase result is ok:false but carries no errorClass to classify the fault");
    }
  }

  const amount = isObj(ev["paymentAmount"]) ? (ev["paymentAmount"] as Record<string, unknown>) : null;
  const fee = isObj(ev["paymentFee"]) ? (ev["paymentFee"] as Record<string, unknown>) : null;
  const txRefs = Array.isArray(ev["paymentTxRefs"]) ? (ev["paymentTxRefs"] as unknown[]) : null;
  const finality = isObj(ev["settlementFinality"]) ? (ev["settlementFinality"] as Record<string, unknown>) : null;

  // ── Payment-evidence rules (§9.7, PC-5/PC-6) ────────────────────────────
  if (isPayment && outcome === "success") {
    if (!txRefs || txRefs.length === 0) fail("success payment evidence MUST carry paymentTxRefs");
    if (!amount) fail("success payment evidence MUST carry paymentAmount (AMEND-3 basis)");
    if (!finality) fail("success payment evidence MUST carry settlementFinality (PC-6)");
  }
  if (txRefs && txRefs.some((ref) => !isChainTxRef(ref))) {
    fail("paymentTxRefs MUST contain exact DACS-4 §9.3 ChainTxRef variants");
  }
  if (
    isPayment && ctx.result?.txRefs !== undefined &&
    Array.isArray(ctx.result.txRefs) &&
    ctx.result.txRefs.every((ref) => isChainTxRef(ref)) &&
    canonicalize(ctx.result.txRefs) !== canonicalize(txRefs ?? [])
  ) {
    fail(
      "signed evidence.paymentTxRefs do not equal the authenticated phase-handler result txRefs",
    );
  }
  if (txRefs) {
    for (const ref of txRefs) {
      if (!isObj(ref)) continue;
      const kind = ref["kind"];
      if (kind === "evm-event") {
        if (phase !== "pay-evm-erc20") {
          fail('evm-event is valid only for pay-evm-erc20 evidence');
        }
        if (outcome === "success" && finality?.["model"] !== "block-depth") {
          fail('evm-event success evidence MUST use block-depth finality');
        }
      } else if (kind === "solana-instruction") {
        if (phase !== "pay-solana-spl") {
          fail('solana-instruction is valid only for pay-solana-spl evidence');
        }
        if (outcome === "success" &&
            finality?.["model"] !== "commitment-level") {
          fail('solana-instruction success evidence MUST use commitment-level finality');
        }
      } else if (kind === "x402-event") {
        if (phase !== "pay-x402") {
          fail('x402-event is valid only for pay-x402 evidence');
        }
        if (outcome === "success" && finality?.["model"] !== "block-depth") {
          fail('x402-event success evidence MUST use block-depth finality');
        }
      }
    }
  }
  if (amount) {
    if (!isCanonicalDecimal(amount["amount"])) fail("paymentAmount.amount MUST be a canonical CD-1 decimal");
    else if (!decimalIsPositive(amount["amount"] as string)) fail("paymentAmount.amount MUST be strictly > 0");
    if (!isStr(amount["currency"]) || amount["currency"] === "") fail("paymentAmount.currency MUST be set");
  }
  if (fee) {
    if (!isCanonicalDecimal(fee["amount"])) fail("paymentFee.amount MUST be a canonical CD-1 decimal (non-negative)");
  }

  // ── settlementFinality closed-set + per-model params (PC-6, §9.7) ───────
  // A present finality record must name a model from the closed set and carry
  // the model's parameter shape; presence alone is insufficient.
  if (finality) {
    const model = finality["model"];
    if (!isStr(model) || !FINALITY_MODELS.has(model)) {
      fail(`settlementFinality.model "${String(model)}" is not a recognised §9.7 finality model (PC-6)`);
    } else {
      // block-depth echoes the blocks waited; commitment-level echoes the Solana
      // commitment. Both are OPTIONAL in §9.7 (self-describing echoes of
      // rail.parameters) — validate only when present, never require.
      if (model === "block-depth" && finality["finalityBlocks"] !== undefined) {
        const fb = finality["finalityBlocks"];
        if (!isNum(fb) || fb < 0 || !Number.isInteger(fb)) {
          fail("settlementFinality.finalityBlocks MUST be a non-negative integer");
        }
      }
      if (model === "commitment-level" && finality["finalityCommitmentLevel"] !== undefined) {
        if (!isStr(finality["finalityCommitmentLevel"]) || !SOLANA_COMMITMENTS.has(finality["finalityCommitmentLevel"])) {
          fail(`settlementFinality.finalityCommitmentLevel MUST be one of processed|confirmed|finalized`);
        }
      }
      // The depth/commitment params belong ONLY to their own model. bft-final in
      // particular is finality-by-inclusion (§9.5.9) — there is no block-depth or
      // commitment to wait on — and provider-receipt/htlc-reveal/liquidity-tank
      // likewise carry neither. A stray param signals a mis-modelled record.
      if (model !== "block-depth" && finality["finalityBlocks"] !== undefined) {
        fail(`settlementFinality.finalityBlocks is only valid for model "block-depth", not "${model}"`);
      }
      if (model !== "commitment-level" && finality["finalityCommitmentLevel"] !== undefined) {
        fail(`settlementFinality.finalityCommitmentLevel is only valid for model "commitment-level", not "${model}"`);
      }
    }
    // §9.7: finalityObservedAt is REQUIRED on a finality record.
    if (!isNum(finality["finalityObservedAt"])) {
      fail("settlementFinality.finalityObservedAt MUST be a unix-ms number");
    }
  }

  // ── Delivery-evidence rules (§9.7) ──────────────────────────────────────
  if (isDelivery) {
    // Delivery phases MUST omit settlementFinality (finality is payment-only).
    if (finality) fail("delivery evidence MUST NOT carry settlementFinality");
    if (!isStr(ev["deliverableContentHash"])) {
      fail("delivery evidence MUST carry deliverableContentHash");
    } else if (!is64Hex(ev["deliverableContentHash"])) {
      fail("deliverableContentHash MUST be a 64-char sha256 hex");
    }
    const anchor = isObj(ev["deliverableAnchor"]) ? (ev["deliverableAnchor"] as Record<string, unknown>) : null;
    if (!anchor || !isStr(anchor["kind"]) || !isStr(anchor["locator"])) {
      fail("delivery evidence MUST carry a deliverableAnchor {kind, locator}");
    } else {
      if (phase === "deliver-storage-program" && anchor["kind"] !== "storage-program") {
        // A storage-program delivery anchored under a non-storage kind (e.g. an
        // entitlement) is incoherent with its phase.
        fail(`deliver-storage-program anchor kind MUST be "storage-program", got "${String(anchor["kind"])}"`);
      }
      if (ctx.expectedAnchorLocator && anchor["locator"] !== ctx.expectedAnchorLocator) {
        fail(
          `deliverableAnchor.locator "${String(anchor["locator"])}" is not the expected SR-2 address "${ctx.expectedAnchorLocator}"`,
        );
      }
    }
    // Note: an extra payment-shaped field on a delivery record is tolerated (not a fail).
  }

  // ── Agreement / rail coherence (context-gated) ──────────────────────────
  if (amount && isStr(amount["currency"])) {
    const cur = amount["currency"];
    if (ctx.rail?.asset && ctx.rail.asset !== cur) {
      fail(`paymentAmount.currency "${cur}" does not resolve to rail asset "${ctx.rail.asset}" (PC-5)`);
    }
    if (ctx.agreement?.currency && ctx.agreement.currency !== cur) {
      fail(`paymentAmount.currency "${cur}" does not match agreement currency "${ctx.agreement.currency}"`);
    }
    if (
      ctx.agreement?.currency === cur &&
      isCanonicalDecimal(amount["amount"]) &&
      isCanonicalDecimal(ctx.agreement?.amount) &&
      cmpDecimal(amount["amount"] as string, ctx.agreement!.amount!) < 0
    ) {
      fail("settled amount is less than the agreed price (underpayment)");
    }
  }
  if (isPayment && ctx.rail?.railType && PHASE_RAIL_TYPE[phase as string] !== ctx.rail.railType) {
    fail(
      `phase "${String(phase)}" is incoherent with rail type "${ctx.rail.railType}" (expected ${PHASE_RAIL_TYPE[phase as string]})`,
    );
  }
  // Rail-internal coherence: the handler the rail names must map to its railType.
  if (ctx.rail?.railType && ctx.rail.handler && PHASE_RAIL_TYPE[ctx.rail.handler] !== ctx.rail.railType) {
    fail(
      `rail handler "${ctx.rail.handler}" is incoherent with rail type "${ctx.rail.railType}"`,
    );
  }
  const expectedSpecKinds = ctx.rail?.railType
    ? RAIL_SPEC_KINDS[ctx.rail.railType]
    : undefined;
  if (
    expectedSpecKinds && assetSpec && isObj(assetSpec) &&
    isStr(assetSpec.kind) && assetSpec.kind !== expectedSpecKinds.asset
  ) {
    fail(
      `rail type "${ctx.rail!.railType}" requires asset kind ` +
        `"${expectedSpecKinds.asset}", got "${assetSpec.kind}" (RD-5)`,
    );
  }
  if (
    expectedSpecKinds && networkSpec && isObj(networkSpec) &&
    isStr(networkSpec.kind) && networkSpec.kind !== expectedSpecKinds.network
  ) {
    fail(
      `rail type "${ctx.rail!.railType}" requires network kind ` +
        `"${expectedSpecKinds.network}", got "${networkSpec.kind}" (RD-5)`,
    );
  }
  if (
    assetSpec && networkSpec && isObj(assetSpec) && isObj(networkSpec) &&
    (assetSpec.kind === "erc20" || assetSpec.kind === "native-evm") &&
    networkSpec.kind === "evm" &&
    isPositiveSafeInteger(assetSpec.chainId) &&
    isPositiveSafeInteger(networkSpec.chainId) &&
    assetSpec.chainId !== networkSpec.chainId
  ) {
    fail(
      `rail asset chainId ${assetSpec.chainId} does not match network chainId ` +
        `${networkSpec.chainId} (RD-5)`,
    );
  }
  if (
    assetSpec && networkSpec && isObj(assetSpec) && isObj(networkSpec) &&
    (assetSpec.kind === "spl" || assetSpec.kind === "native-solana") &&
    networkSpec.kind === "solana" && isStr(assetSpec.cluster) &&
    isStr(networkSpec.cluster) && assetSpec.cluster !== networkSpec.cluster
  ) {
    fail(
      `rail asset cluster "${assetSpec.cluster}" does not match network cluster ` +
        `"${networkSpec.cluster}" (RD-5)`,
    );
  }
  if (ctx.rail?.network && networkSpec && isObj(networkSpec)) {
    const pinned = parsePinnedEvidenceNetwork(ctx.rail.network);
    if (
      pinned?.kind === "evm" && networkSpec.kind === "evm" &&
      isPositiveSafeInteger(networkSpec.chainId) &&
      pinned.chainId !== networkSpec.chainId
    ) {
      fail("canonical rail network contradicts networkSpec.chainId");
    } else if (
      pinned?.kind === "solana" && networkSpec.kind === "solana" &&
      isStr(networkSpec.cluster) && pinned.cluster !== networkSpec.cluster
    ) {
      fail("canonical rail network contradicts networkSpec.cluster");
    } else if (pinned?.kind === "demos" && networkSpec.kind !== "demos") {
      fail("canonical Demos rail network contradicts networkSpec.kind");
    }
  }
  // This layer validates the signed ChainTxRef and its pinned-rail tuple. The
  // independently authenticated ledger-event selection, complete PC-2 address
  // binding and SB-2 cross-session uniqueness check live in
  // resolveSettlementEventIdentity: shape-valid legacy refs are intentionally
  // still readable here, but they cannot mint an event identity by themselves.
  if (txRefs && ctx.rail) {
    const allowedKinds: Record<string, ReadonlySet<string>> = {
      "evm-erc20": new Set(["evm", "evm-event"]),
      "solana-spl": new Set(["solana", "solana-instruction"]),
      "cross-chain-htlc": new Set([
        "htlc-lock",
        "htlc-reveal",
        "htlc-claim",
        "htlc-refund",
      ]),
      "cross-chain-liquidity-tank": new Set(["liquidity-tank"]),
      ap2: new Set(["ap2"]),
      x402: new Set(["x402", "x402-event"]),
      "demos-native": new Set(["demos"]),
    };
    const pinnedNetwork = ctx.rail.network === undefined
      ? undefined
      : parsePinnedEvidenceNetwork(ctx.rail.network);
    if (ctx.rail.network !== undefined && !pinnedNetwork) {
      fail(
        `rail network "${ctx.rail.network}" is not a canonical pinned ` +
          `eip155, solana, or demos network`,
      );
    }
    for (const t of txRefs) {
      if (!isObj(t)) continue;
      const allowed = ctx.rail.railType ? allowedKinds[ctx.rail.railType] : undefined;
      if (allowed && (!isStr(t["kind"]) || !allowed.has(t["kind"]))) {
        fail(
          `paymentTxRef.kind "${String(t["kind"])}" is incoherent with rail type "${ctx.rail.railType}"`,
        );
      }
      if (
        pinnedNetwork &&
        (t["kind"] === "evm" || t["kind"] === "evm-event")
      ) {
        if (
          pinnedNetwork.kind !== "evm" ||
          t["chainId"] !== pinnedNetwork.chainId
        ) {
          fail(
            `paymentTxRef EVM chainId "${String(t["chainId"])}" does not ` +
              `match pinned rail network "${ctx.rail.network}"`,
          );
        }
      } else if (
        pinnedNetwork &&
        (t["kind"] === "solana" || t["kind"] === "solana-instruction")
      ) {
        if (
          pinnedNetwork.kind !== "solana" ||
          t["cluster"] !== pinnedNetwork.cluster
        ) {
          fail(
            `paymentTxRef Solana cluster "${String(t["cluster"])}" does not ` +
              `match pinned rail network "${ctx.rail.network}"`,
          );
        }
      } else if (pinnedNetwork && t["kind"] === "demos") {
        if (pinnedNetwork.kind !== "demos") {
          fail(
            `paymentTxRef Demos network does not match pinned rail network ` +
              `"${ctx.rail.network}"`,
          );
        }
      } else if (
        pinnedNetwork &&
        (t["kind"] === "x402" || t["kind"] === "x402-event") &&
        t["chainId"] !== undefined &&
        (pinnedNetwork.kind !== "evm" ||
          t["chainId"] !== pinnedNetwork.chainId)
      ) {
        fail(
          `paymentTxRef x402 chainId "${String(t["chainId"])}" does not ` +
            `match pinned rail network "${ctx.rail.network}"`,
        );
      }
    }
  }

  // ── HTLC route params (HTLC-7), only for a cross-chain-htlc phase ────────
  if (phase === "pay-cross-chain-htlc" && ctx.rail) {
    if (!isNum(ctx.rail.sourceFinalitySec)) fail("HTLC route MUST pin rail.sourceFinalitySec (HTLC-7)");
    if (!isNum(ctx.rail.safetyWindowSec)) fail("HTLC route MUST pin rail.safetyWindowSec (HTLC-7)");
    if (
      ctx.htlcExpiry &&
      isNum(ctx.rail.sourceFinalitySec) &&
      isNum(ctx.rail.safetyWindowSec) &&
      !(ctx.htlcExpiry.source > ctx.htlcExpiry.dest + ctx.rail.sourceFinalitySec + ctx.rail.safetyWindowSec)
    ) {
      fail("HTLC timelock margin insufficient: expiry_source ≤ expiry_dest + source_finality + safety (HTLC-7)");
    }
  }

  // ── Attestation ref (§7.5.2 content addressing) ─────────────────────────
  const scopeHash = contentHash(ev);
  if (
    ctx.paymentAddress && isObj(ctx.paymentAddress) &&
    isStr(ctx.paymentAddress.railId) && ctx.paymentAddress.railId.length > 0 &&
    isSafeUint(ctx.paymentAddress.phaseIndex) &&
    (ctx.paymentAddress.resolved === undefined ||
      typeof ctx.paymentAddress.resolved === "boolean")
  ) {
    if (!isPayment) {
      fail("paymentAddress context is valid only for payment evidence");
    }
    if (
      !isStr(ev["jobId"]) || ev["jobId"].normalize("NFC") !== ev["jobId"] ||
      /[:?&=%\s\u0000-\u001f\u007f]/.test(ev["jobId"])
    ) {
      fail("payment evidence jobId cannot form a canonical PC-2 address segment");
    }
    if (ctx.rail?.railId && ctx.rail.railId !== ctx.paymentAddress.railId) {
      fail("paymentAddress railId contradicts the authenticated pinned rail");
    }
    const isResolution = ev["supersedesEvidenceRef"] !== undefined;
    if ((ctx.paymentAddress.resolved === true) !== isResolution) {
      fail(
        "paymentAddress resolved discriminator contradicts SettlementEvidence supersession",
      );
    }
    if (!ctx.attestationRef) {
      sawIndeterminate = true;
      reasons.push("payment evidence attestationRef is unavailable for PC-2 address binding");
    } else if (
      isAttestationRef(ctx.attestationRef) &&
      isStr(ev["jobId"]) &&
      ctx.attestationRef.anchor.locator !== expectedPaymentEvidenceLocator(
        ev["jobId"],
        ctx.paymentAddress,
      )
    ) {
      fail(
        "attestationRef locator does not match the complete authenticated PC-2 payment address",
      );
    }
  }
  if (ctx.attestationRef) {
    if (!isAttestationRef(ctx.attestationRef)) {
      fail("attestationRef MUST use the exact DACS-2 §7.5.2 anchor shape");
    }
    if (ctx.attestationRef.contentHash !== scopeHash) {
      fail("attestationRef.contentHash does not match the evidence's signed-scope hash");
    }
  }

  // ── Signature (§9.7: signer is the phase orchestrator) ───────────────────
  const hasPluralSignatures = Object.prototype.hasOwnProperty.call(
    record,
    "signatures",
  );
  const sig = record["signature"];
  if (hasPluralSignatures) {
    fail("evidence MUST NOT carry ambiguous singular and plural signature fields");
  }
  if (!isComponentSignature(sig)) {
    fail(
      "evidence MUST carry a ComponentSignature {algorithm, signer, canonical base64url value}",
    );
  } else {
    const signer = sig.signer;
    if (ctx.orchestrator && signer !== ctx.orchestrator) {
      fail(`signer "${signer}" is not the phase orchestrator "${ctx.orchestrator}"`);
    }
    if (resolvePublicKey && verify) {
      if (sig.algorithm !== "ed25519") {
        sawError = true;
        reasons.push(
          `evidence verifier has no ${sig.algorithm} backend (only ed25519 is configured)`,
        );
      } else {
        let resolvedKey: Uint8Array | null;
        try {
          const candidate: unknown = await resolvePublicKey(signer);
          if (candidate === null) {
            resolvedKey = null;
          } else if (
            typeof candidate === "object" &&
            !nodeTypes.isProxy(candidate) &&
            nodeTypes.isUint8Array(candidate)
          ) {
            resolvedKey = new Uint8Array(candidate);
          } else {
            sawError = true;
            reasons.push(`signer key for "${signer}" is malformed`);
            resolvedKey = null;
          }
        } catch {
          sawIndeterminate = true;
          reasons.push(`signer key for "${signer}" could not be resolved`);
          resolvedKey = null;
        }
        if (!resolvedKey && !sawError && !sawIndeterminate) {
          sawIndeterminate = true;
          reasons.push(`signer key for "${signer}" is unresolvable`);
        } else if (resolvedKey && resolvedKey.length !== 32) {
          sawError = true;
          reasons.push(`signer key for "${signer}" is malformed`);
        } else if (resolvedKey) {
          const message = signedBytes(
            ARTIFACT_SEPARATORS.SettlementEvidence,
            scopeHash,
          );
          const sigBytes = Uint8Array.from(
            Buffer.from(sig.value, "base64url"),
          );
          try {
            const verified: unknown = await verify(
              Uint8Array.from(message),
              Uint8Array.from(sigBytes),
              Uint8Array.from(resolvedKey),
            );
            if (verified !== true && verified !== false) {
              sawError = true;
              reasons.push("evidence signature verifier returned a non-boolean result");
            } else if (!verified) {
              fail("evidence signature does not verify under the signer's key");
            }
          } catch {
            sawError = true;
            reasons.push("evidence signature verification could not be evaluated");
          }
        }
      }
    }
  }

  // ── Worst-wins verdict (error > indeterminate > fail > pass) ─────────────
  if (sawError) return { decision: "error", reasons };
  if (sawIndeterminate) return { decision: "indeterminate", reasons };
  if (failCount > 0) return { decision: "fail", reasons };
  return { decision: "pass", reasons };
}

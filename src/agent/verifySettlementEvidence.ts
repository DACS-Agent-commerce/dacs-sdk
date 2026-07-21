import { contentHash, stripSignature } from "../canonical/index.js";
import { canonicalizeDecimal } from "../canonical/decimal.js";
import { signedBytes } from "../crypto/index.js";
import { ARTIFACT_SEPARATORS } from "../artifacts/registry.js";
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

/** The pinned rail, for the phase/rail-coherence checks (§9.4/§9.5). */
export interface EvidenceRailContext {
  railId?: string;
  /** evm-erc20 | solana-spl | cross-chain-htlc | cross-chain-liquidity-tank | ap2 | x402 */
  railType?: string;
  /** The rail's settlement asset id/symbol the amount MUST resolve to (PC-5). */
  asset?: string;
  /** CAIP-2-ish network prefix the txRefs MUST live on (e.g. "polygon-amoy"). */
  network?: string;
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
  /**
   * The attestation ref the record is anchored under (from the phase result).
   * When present, its `kind` MUST be "dacs-4-evidence" and its `contentHash`
   * MUST equal the record's signed-scope hash.
   */
  attestationRef?: { kind?: string; contentHash?: string };
  /**
   * The phase-handler result envelope, when the caller has it. `ok`/`errorClass`
   * MUST be coherent: `ok: true` carries no `errorClass`; `ok: false` MUST carry
   * one (a fault the reader can classify). Skipped when absent.
   */
  result?: { ok?: boolean; errorClass?: string };
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
};

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
  // NOTE (SB scope): this verifier checks each txRef's structural coherence with
  // the pinned rail (below). It does NOT implement DACS-4 §9.5.8 session-binding
  // (SB-1 settlement-tx-id keying, SB-2 cross-session uniqueness, SB-3 handler
  // binding) — that layer is a consumer/aggregation concern (verifyBundle +
  // reputation reconciliation), normative only from spec v0.2, and the vendored
  // spec here is v0.1. Tracked as a distinct workstream in issue #33; a record
  // that passes here can still be a coincidental-citation or cross-session
  // double-count until SB lands. Do not read a `pass` as SB-clean.
  if (txRefs && ctx.rail) {
    for (const t of txRefs) {
      if (!isObj(t)) continue;
      if (ctx.rail.railId && isStr(t["rail"]) && t["rail"] !== ctx.rail.railId) {
        fail(`paymentTxRef.rail "${String(t["rail"])}" does not match pinned rail "${ctx.rail.railId}"`);
      }
      if (ctx.rail.network && isStr(t["txHash"]) && !t["txHash"].startsWith(ctx.rail.network)) {
        fail(`paymentTxRef txHash "${String(t["txHash"])}" is not on rail network "${ctx.rail.network}"`);
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
  if (ctx.attestationRef) {
    if (ctx.attestationRef.kind !== "dacs-4-evidence") {
      fail(`attestationRef.kind MUST be "dacs-4-evidence", got "${String(ctx.attestationRef.kind)}"`);
    }
    if (ctx.attestationRef.contentHash && ctx.attestationRef.contentHash !== scopeHash) {
      fail("attestationRef.contentHash does not match the evidence's signed-scope hash");
    }
  }

  // ── Signature (§9.7: signer is the phase orchestrator) ───────────────────
  const sig = isObj(record["signature"]) ? (record["signature"] as Record<string, unknown>) : null;
  if (!sig || !isStr(sig["signer"]) || !isStr(sig["value"])) {
    fail("evidence MUST carry a signature {signer, value}");
  } else {
    const signer = sig["signer"];
    if (ctx.orchestrator && signer !== ctx.orchestrator) {
      fail(`signer "${signer}" is not the phase orchestrator "${ctx.orchestrator}"`);
    }
    if (deps.resolvePublicKey && deps.verify) {
      const key = await deps.resolvePublicKey(signer);
      if (!key) {
        sawIndeterminate = true;
        reasons.push(`signer key for "${signer}" is unresolvable`);
      } else if (key.length !== 32) {
        sawError = true;
        reasons.push(`signer key for "${signer}" is malformed`);
      } else {
        const message = signedBytes(ARTIFACT_SEPARATORS.SettlementEvidence, scopeHash);
        const sigBytes = Uint8Array.from(Buffer.from(sig["value"], "base64url"));
        if (!(await deps.verify(message, sigBytes, key))) {
          fail("evidence signature does not verify under the signer's key");
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

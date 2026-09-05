import { hkdfSync, randomBytes } from "node:crypto";

import {
  assertPositiveAmount,
  baseUnits,
  canonicalize,
  sha256Hex,
} from "../canonical/index.js";
import { DacsError } from "../errors.js";

const HASH_RE = /^[0-9a-f]{64}$/;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_SAFETY_WINDOW_SEC = 600;

export type HtlcAction =
  | "source-lock"
  | "destination-lock"
  | "destination-claim"
  | "source-claim"
  | "source-refund"
  | "destination-refund";

export type HtlcActor = "payer" | "payee";

export interface CrossChainHtlcAuthority {
  jobId: string;
  phaseIndex: number;
  railId: string;
  railDescriptorHash: string;
  agreementHash: string;
  assetKind: "stablecoin-cross-chain";
  networkKind: "cross-chain";
  mechanism: "htlc";
  sourceChainId: number;
  destinationChainId: number;
  sourceAsset: string;
  destinationAsset: string;
  sourceTokenDecimals: number;
  destinationTokenDecimals: number;
  amount: string;
  currency: string;
  payerSourceAddress: string;
  payerDestinationAddress: string;
  payeeSourceAddress: string;
  payeeDestinationAddress: string;
  sourceContractAddress: string;
  destinationContractAddress: string;
  sourceFinalitySec: number;
  safetyWindowSec?: number;
  sourceTimelockSec: number;
  destinationTimelockSec: number;
}

export interface CrossChainHtlcSecrets {
  buyerSalt: Uint8Array;
  buyerSaltHash: string;
  preimage: Uint8Array;
  preimageHash: string;
  sourceHashlock: string;
  destinationHashlock: string;
}

export interface CrossChainHtlcIntent {
  intentVersion: "1";
  settlementKey: string;
  bindingHash: string;
  jobId: string;
  phaseIndex: number;
  railId: string;
  railDescriptorHash: string;
  agreementHash: string;
  assetKind: "stablecoin-cross-chain";
  networkKind: "cross-chain";
  mechanism: "htlc";
  sourceChainId: number;
  destinationChainId: number;
  sourceAsset: string;
  destinationAsset: string;
  sourceTokenDecimals: number;
  destinationTokenDecimals: number;
  sourceAmountBaseUnits: string;
  destinationAmountBaseUnits: string;
  amount: string;
  currency: string;
  payerSourceAddress: string;
  payerDestinationAddress: string;
  payeeSourceAddress: string;
  payeeDestinationAddress: string;
  sourceContractAddress: string;
  destinationContractAddress: string;
  sourceFinalitySec: number;
  safetyWindowSec: number;
  sourceTimelockSec: number;
  destinationTimelockSec: number;
  buyerSaltHash: string;
  preimageHash: string;
  sourceHashlock: string;
  destinationHashlock: string;
}

export interface HtlcHashlockDeriver {
  deriveHashlock(input: {
    chainId: number;
    preimage: Uint8Array;
  }): string;
}

export type HtlcTxRef =
  | {
      kind: "htlc-lock";
      chainId: number;
      contractAddress: string;
      lockTxHash: string;
    }
  | {
      kind: "htlc-reveal";
      chainId: number;
      contractAddress: string;
      revealTxHash: string;
    }
  | {
      kind: "htlc-claim";
      chainId: number;
      contractAddress: string;
      claimTxHash: string;
    }
  | {
      kind: "htlc-refund";
      chainId: number;
      contractAddress: string;
      refundTxHash: string;
    };

export interface HtlcPreparedAction {
  actionVersion: "1";
  action: HtlcAction;
  actor: HtlcActor;
  authorityHash: string;
  txRef: Readonly<HtlcTxRef>;
  signedPayloadBase64: string;
  preparedAt: number;
  effectHash: string;
}

export type HtlcObservedAction =
  | {
      state: "absent";
      authenticationHash: string;
    }
  | {
      state: "pending" | "failed";
      txRef: Readonly<HtlcTxRef>;
      reason?: string;
      authenticationHash: string;
    }
  | {
      /**
       * Authenticated and irreversible under the intent's selected chain
       * finality policy. The adapter owns confirmation-depth and reorg checks;
       * it must return `pending` while a reversal remains possible.
       */
      state: "final";
      txRef: Readonly<HtlcTxRef>;
      /** Unix milliseconds at which the named finality condition was observed. */
      finalityObservedAt: number;
      /** Unix milliseconds at which the transaction was included, when applicable. */
      includedAt?: number;
      /** Chain-contract expiry as Unix seconds for lock actions. */
      expiresAt?: number;
      revealedPreimageHex?: string;
      authenticationHash: string;
    };

export interface HtlcLedgerSnapshot {
  observedAt: number;
  authenticationHash: string;
  actions: Partial<Record<HtlcAction, Readonly<HtlcObservedAction>>>;
}

export interface HtlcEffectFence {
  settlementKey: string;
  bindingHash: string;
  owner: string;
  generation: number;
  assertCurrent(): Promise<void>;
}

/**
 * Chain boundary. The adapter may dispatch payer and payee effects to separate
 * role services; this coordinator never needs either role's private key.
 */
export interface CrossChainHtlcAdapter {
  observe(
    intent: Readonly<CrossChainHtlcIntent>,
    fence: Readonly<HtlcEffectFence>,
  ): Promise<Readonly<HtlcLedgerSnapshot>>;
  prepareAction(
    input: Readonly<{
      intent: Readonly<CrossChainHtlcIntent>;
      action: HtlcAction;
      actor: HtlcActor;
      preimage?: Uint8Array;
      sourceExpiry?: number;
      destinationExpiry?: number;
    }>,
    fence: Readonly<HtlcEffectFence>,
  ): Promise<Readonly<Omit<HtlcPreparedAction, "effectHash">>>;
  broadcastRetained(
    action: Readonly<HtlcPreparedAction>,
    fence: Readonly<HtlcEffectFence>,
  ): Promise<void>;
}

export interface HtlcLease {
  owner: string;
  generation: number;
  expiresAt: number;
}

export interface HtlcRevealCheckpoint {
  revealTxRef: Readonly<Extract<HtlcTxRef, { kind: "htlc-reveal" }>>;
  sourceExpiry: number;
  finalityObservedAt: number;
  authenticationHash: string;
}

export interface CrossChainHtlcSettlement {
  txRefs: readonly Readonly<HtlcTxRef>[];
  paymentAmount: Readonly<{ amount: string; currency: string }>;
  settlementFinality: Readonly<{
    model: "htlc-reveal";
    finalityObservedAt: number;
  }>;
  authenticationHash: string;
}

export type HtlcStoreClaim =
  | {
      status: "acquired";
      intent: Readonly<CrossChainHtlcIntent>;
      lease: Readonly<HtlcLease>;
      prepared: readonly Readonly<HtlcPreparedAction>[];
      revealCheckpoint?: Readonly<HtlcRevealCheckpoint>;
    }
  | {
      status: "waiting";
      intent: Readonly<CrossChainHtlcIntent>;
      lease: Readonly<HtlcLease>;
      prepared: readonly Readonly<HtlcPreparedAction>[];
      revealCheckpoint?: Readonly<HtlcRevealCheckpoint>;
    }
  | {
      status: "settled";
      intent: Readonly<CrossChainHtlcIntent>;
      settlement: Readonly<CrossChainHtlcSettlement>;
    }
  | { status: "conflict" | "corrupt"; reason: string };

export type HtlcStoreWrite =
  | { status: "recorded" | "existing" }
  | { status: "stale" | "conflict" | "corrupt"; reason: string };

/** Durable secret/action/checkpoint store; implementations must be atomic. */
export interface CrossChainHtlcStore {
  claim(input: {
    intent: Readonly<CrossChainHtlcIntent>;
    secrets: Readonly<CrossChainHtlcSecrets>;
    owner: string;
    now: number;
    leaseDurationMs: number;
  }): Promise<HtlcStoreClaim>;
  isCurrent(input: {
    settlementKey: string;
    bindingHash: string;
    owner: string;
    generation: number;
    now: number;
  }): Promise<boolean>;
  recordPrepared(input: {
    settlementKey: string;
    bindingHash: string;
    owner: string;
    generation: number;
    prepared: Readonly<HtlcPreparedAction>;
  }): Promise<HtlcStoreWrite>;
  recordRevealFinal(input: {
    settlementKey: string;
    bindingHash: string;
    owner: string;
    generation: number;
    checkpoint: Readonly<HtlcRevealCheckpoint>;
  }): Promise<HtlcStoreWrite>;
  recordSettlement(input: {
    settlementKey: string;
    bindingHash: string;
    owner: string;
    generation: number;
    settlement: Readonly<CrossChainHtlcSettlement>;
  }): Promise<HtlcStoreWrite>;
}

export type CrossChainHtlcProgress =
  | { status: "waiting" | "indeterminate"; reason: string }
  | {
      status: "failed";
      errorClass: "permanent" | "counterparty" | "settlement-atomicity";
      reason: string;
    }
  | {
      status: "settle-asymmetric";
      reason: "dest-revealed-source-unclaimed";
      recoveryDeadline: number;
      txRefs: readonly Readonly<HtlcTxRef>[];
      finalityObservedAt: number;
    }
  | {
      status: "refund-pending" | "refunded";
      reason: "destination-timeout" | "destination-lock-missing";
      txRefs: readonly Readonly<HtlcTxRef>[];
    }
  | { status: "settled"; settlement: Readonly<CrossChainHtlcSettlement> };

export interface AdvanceCrossChainHtlcInput {
  authority: Readonly<CrossChainHtlcAuthority>;
  buyerSalt: Uint8Array;
  hashlocks: HtlcHashlockDeriver;
  authorizeDestinationClaim: boolean;
  owner: string;
  store: CrossChainHtlcStore;
  adapter: CrossChainHtlcAdapter;
  now?: () => number;
  leaseDurationMs?: number;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new DacsError(`pay-cross-chain-htlc: ${label} must be a non-empty string`);
  }
  return value;
}

function requireUInt(value: unknown, label: string, positive = false): number {
  if (!Number.isSafeInteger(value) || (positive ? Number(value) <= 0 : Number(value) < 0)) {
    throw new DacsError(`pay-cross-chain-htlc: ${label} must be a ${positive ? "positive" : "non-negative"} safe integer`);
  }
  return Number(value);
}

function secretCopy(value: Uint8Array): Uint8Array {
  return Uint8Array.from(value);
}

export function generateHtlcBuyerSalt(bytes = 32): Uint8Array {
  if (!Number.isSafeInteger(bytes) || bytes < 16) {
    throw new DacsError("pay-cross-chain-htlc: buyerSalt requires at least 128 bits");
  }
  return Uint8Array.from(randomBytes(bytes));
}

export function deriveHtlcPreimage(input: {
  buyerSalt: Uint8Array;
  jobId: string;
  agreementHash: string;
}): Uint8Array {
  if (!(input.buyerSalt instanceof Uint8Array) || input.buyerSalt.byteLength < 16) {
    throw new DacsError("pay-cross-chain-htlc: buyerSalt requires at least 128 bits");
  }
  if (!HASH_RE.test(input.agreementHash)) {
    throw new DacsError("pay-cross-chain-htlc: agreementHash must be 32-byte lower-case hex");
  }
  const buyerSalt = secretCopy(input.buyerSalt);
  return new Uint8Array(hkdfSync(
    "sha256",
    buyerSalt,
    Buffer.from(requireString(input.jobId, "jobId").normalize("NFC"), "utf8"),
    Buffer.from(input.agreementHash, "utf8"),
    32,
  ));
}

export function crossChainHtlcSettlementKey(input: {
  jobId: string;
  railId: string;
  phaseIndex: number;
}): string {
  const phaseIndex = requireUInt(input.phaseIndex, "phaseIndex");
  return sha256Hex(`dacs-cross-chain-htlc:v1:${canonicalize({
    jobId: requireString(input.jobId, "jobId").normalize("NFC"),
    phaseIndex,
    railId: requireString(input.railId, "railId").normalize("NFC"),
  })}`);
}

export function createCrossChainHtlcIntent(
  inputAuthority: Readonly<CrossChainHtlcAuthority>,
  buyerSalt: Uint8Array,
  deriver: HtlcHashlockDeriver,
): Readonly<{ intent: Readonly<CrossChainHtlcIntent>; secrets: Readonly<CrossChainHtlcSecrets> }> {
  const authority = Object.freeze({ ...inputAuthority });
  if (!(buyerSalt instanceof Uint8Array)) {
    throw new DacsError("pay-cross-chain-htlc: buyerSalt must be bytes");
  }
  const capturedBuyerSalt = secretCopy(buyerSalt);
  const deriveHashlock = deriver.deriveHashlock.bind(deriver);
  if (authority.assetKind !== "stablecoin-cross-chain" ||
      authority.networkKind !== "cross-chain" || authority.mechanism !== "htlc") {
    throw new DacsError("pay-cross-chain-htlc: selected rail is not a cross-chain HTLC");
  }
  if (!HASH_RE.test(authority.railDescriptorHash) || !HASH_RE.test(authority.agreementHash)) {
    throw new DacsError("pay-cross-chain-htlc: authority hashes must be 32-byte lower-case hex");
  }
  const sourceChainId = requireUInt(authority.sourceChainId, "sourceChainId", true);
  const destinationChainId = requireUInt(authority.destinationChainId, "destinationChainId", true);
  if (sourceChainId === destinationChainId) {
    throw new DacsError("pay-cross-chain-htlc: source and destination chains must differ");
  }
  const sourceFinalitySec = requireUInt(authority.sourceFinalitySec, "sourceFinalitySec", true);
  const safetyWindowSec = authority.safetyWindowSec === undefined
    ? DEFAULT_SAFETY_WINDOW_SEC
    : requireUInt(authority.safetyWindowSec, "safetyWindowSec", true);
  const sourceTimelockSec = requireUInt(authority.sourceTimelockSec, "sourceTimelockSec", true);
  const destinationTimelockSec = requireUInt(
    authority.destinationTimelockSec,
    "destinationTimelockSec",
    true,
  );
  if (sourceTimelockSec <= destinationTimelockSec + sourceFinalitySec + safetyWindowSec) {
    throw new DacsError("pay-cross-chain-htlc: HTLC-7 timelock margin is insufficient");
  }
  const amount = assertPositiveAmount(authority.amount);
  if (authority.sourceAsset !== authority.currency || authority.destinationAsset !== authority.currency) {
    throw new DacsError("pay-cross-chain-htlc: route assets must match payment currency");
  }
  const sourceTokenDecimals = requireUInt(authority.sourceTokenDecimals, "sourceTokenDecimals");
  const destinationTokenDecimals = requireUInt(
    authority.destinationTokenDecimals,
    "destinationTokenDecimals",
  );
  if (sourceTokenDecimals > 255 || destinationTokenDecimals > 255) {
    throw new DacsError("pay-cross-chain-htlc: token decimals must be unsigned bytes");
  }
  const sourceAmountBaseUnits = baseUnits(amount, sourceTokenDecimals);
  const destinationAmountBaseUnits = baseUnits(amount, destinationTokenDecimals);
  const preimage = deriveHtlcPreimage({
    buyerSalt: capturedBuyerSalt,
    jobId: authority.jobId,
    agreementHash: authority.agreementHash,
  });
  const sourceHashlock = requireString(
    deriveHashlock({ chainId: sourceChainId, preimage: secretCopy(preimage) }),
    "sourceHashlock",
  );
  const destinationHashlock = requireString(
    deriveHashlock({ chainId: destinationChainId, preimage: secretCopy(preimage) }),
    "destinationHashlock",
  );
  const buyerSaltHash = sha256Hex(capturedBuyerSalt);
  const preimageHash = sha256Hex(preimage);
  const unsigned = {
    intentVersion: "1" as const,
    settlementKey: crossChainHtlcSettlementKey(authority),
    jobId: requireString(authority.jobId, "jobId").normalize("NFC"),
    phaseIndex: authority.phaseIndex,
    railId: requireString(authority.railId, "railId").normalize("NFC"),
    railDescriptorHash: authority.railDescriptorHash,
    agreementHash: authority.agreementHash,
    assetKind: authority.assetKind,
    networkKind: authority.networkKind,
    mechanism: authority.mechanism,
    sourceChainId,
    destinationChainId,
    sourceAsset: requireString(authority.sourceAsset, "sourceAsset"),
    destinationAsset: requireString(authority.destinationAsset, "destinationAsset"),
    sourceTokenDecimals,
    destinationTokenDecimals,
    sourceAmountBaseUnits,
    destinationAmountBaseUnits,
    amount,
    currency: requireString(authority.currency, "currency"),
    payerSourceAddress: requireString(authority.payerSourceAddress, "payerSourceAddress"),
    payerDestinationAddress: requireString(authority.payerDestinationAddress, "payerDestinationAddress"),
    payeeSourceAddress: requireString(authority.payeeSourceAddress, "payeeSourceAddress"),
    payeeDestinationAddress: requireString(authority.payeeDestinationAddress, "payeeDestinationAddress"),
    sourceContractAddress: requireString(authority.sourceContractAddress, "sourceContractAddress"),
    destinationContractAddress: requireString(authority.destinationContractAddress, "destinationContractAddress"),
    sourceFinalitySec,
    safetyWindowSec,
    sourceTimelockSec,
    destinationTimelockSec,
    buyerSaltHash,
    preimageHash,
    sourceHashlock,
    destinationHashlock,
  };
  const intent = Object.freeze({
    ...unsigned,
    bindingHash: sha256Hex(canonicalize(unsigned)),
  });
  return Object.freeze({
    intent,
    secrets: Object.freeze({
      buyerSalt: secretCopy(capturedBuyerSalt),
      buyerSaltHash,
      preimage: secretCopy(preimage),
      preimageHash,
      sourceHashlock,
      destinationHashlock,
    }),
  });
}

function actorFor(action: HtlcAction): HtlcActor {
  return action === "destination-lock" || action === "source-claim" ||
    action === "destination-refund" ? "payee" : "payer";
}

function expectedRef(input: {
  intent: Readonly<CrossChainHtlcIntent>;
  action: HtlcAction;
  txHash: string;
}): HtlcTxRef {
  const { intent, action, txHash } = input;
  if (action === "source-lock") return {
    kind: "htlc-lock",
    chainId: intent.sourceChainId,
    contractAddress: intent.sourceContractAddress,
    lockTxHash: txHash,
  };
  if (action === "destination-lock") return {
    kind: "htlc-lock",
    chainId: intent.destinationChainId,
    contractAddress: intent.destinationContractAddress,
    lockTxHash: txHash,
  };
  if (action === "destination-claim") return {
    kind: "htlc-reveal",
    chainId: intent.destinationChainId,
    contractAddress: intent.destinationContractAddress,
    revealTxHash: txHash,
  };
  if (action === "source-claim") return {
    kind: "htlc-claim",
    chainId: intent.sourceChainId,
    contractAddress: intent.sourceContractAddress,
    claimTxHash: txHash,
  };
  return {
    kind: "htlc-refund",
    chainId: action === "source-refund" ? intent.sourceChainId : intent.destinationChainId,
    contractAddress: action === "source-refund"
      ? intent.sourceContractAddress
      : intent.destinationContractAddress,
    refundTxHash: txHash,
  };
}

function txHashOf(ref: Readonly<HtlcTxRef>): string {
  if (ref.kind === "htlc-lock") return ref.lockTxHash;
  if (ref.kind === "htlc-reveal") return ref.revealTxHash;
  if (ref.kind === "htlc-claim") return ref.claimTxHash;
  return ref.refundTxHash;
}

function sameRef(a: Readonly<HtlcTxRef>, b: Readonly<HtlcTxRef>): boolean {
  return canonicalize(a) === canonicalize(b);
}

function validatePrepared(
  value: Readonly<Omit<HtlcPreparedAction, "effectHash">>,
  intent: Readonly<CrossChainHtlcIntent>,
  action: HtlcAction,
): Readonly<HtlcPreparedAction> {
  if (value.actionVersion !== "1" || value.action !== action ||
      value.actor !== actorFor(action) || value.authorityHash !== intent.bindingHash) {
    throw new DacsError("pay-cross-chain-htlc: prepared action authority mismatch");
  }
  const txHash = requireString(txHashOf(value.txRef), "txHash");
  if (!sameRef(value.txRef, expectedRef({ intent, action, txHash }))) {
    throw new DacsError("pay-cross-chain-htlc: prepared action transaction reference mismatch");
  }
  const encoded = requireString(value.signedPayloadBase64, "signedPayloadBase64");
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length === 0 ||
      decoded.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) {
    throw new DacsError("pay-cross-chain-htlc: signed payload must be canonical base64");
  }
  requireUInt(value.preparedAt, "preparedAt");
  const unsigned = { ...value, txRef: Object.freeze({ ...value.txRef }) };
  return Object.freeze({ ...unsigned, effectHash: sha256Hex(canonicalize(unsigned)) });
}

function final(
  snapshot: Readonly<HtlcLedgerSnapshot>,
  action: HtlcAction,
  prepared: Readonly<HtlcPreparedAction> | undefined,
): Extract<HtlcObservedAction, { state: "final" }> | undefined {
  const observed = snapshot.actions[action];
  if (!observed || observed.state !== "final") return undefined;
  if (!prepared || !sameRef(observed.txRef, prepared.txRef) ||
      !HASH_RE.test(observed.authenticationHash) ||
      !Number.isSafeInteger(observed.finalityObservedAt) || observed.finalityObservedAt < 0) {
    throw new DacsError(`pay-cross-chain-htlc: invalid authenticated ${action} finality`);
  }
  return observed;
}

function collectRefs(
  snapshot: Readonly<HtlcLedgerSnapshot>,
  prepared: ReadonlyMap<HtlcAction, Readonly<HtlcPreparedAction>>,
): readonly Readonly<HtlcTxRef>[] {
  const refs: HtlcTxRef[] = [];
  for (const action of [
    "source-lock",
    "destination-lock",
    "destination-claim",
    "source-claim",
    "source-refund",
    "destination-refund",
  ] as const) {
    const item = snapshot.actions[action];
    const retained = prepared.get(action);
    if (item && item.state !== "absent" && retained && sameRef(item.txRef, retained.txRef)) {
      refs.push(Object.freeze({ ...item.txRef }));
    }
  }
  return Object.freeze(refs);
}

function captureRevealCheckpoint(
  value: Readonly<HtlcRevealCheckpoint>,
  prepared: ReadonlyMap<HtlcAction, Readonly<HtlcPreparedAction>>,
): Readonly<HtlcRevealCheckpoint> {
  const destinationClaim = prepared.get("destination-claim");
  if (!destinationClaim || !sameRef(value.revealTxRef, destinationClaim.txRef) ||
      !HASH_RE.test(value.authenticationHash)) {
    throw new DacsError("pay-cross-chain-htlc: retained reveal checkpoint is invalid");
  }
  requireUInt(value.sourceExpiry, "retained reveal sourceExpiry", true);
  requireUInt(value.finalityObservedAt, "retained reveal finalityObservedAt");
  return Object.freeze({
    revealTxRef: Object.freeze({ ...value.revealTxRef }),
    sourceExpiry: value.sourceExpiry,
    finalityObservedAt: value.finalityObservedAt,
    authenticationHash: value.authenticationHash,
  });
}

function validateSnapshot(
  snapshot: Readonly<HtlcLedgerSnapshot>,
  prepared: ReadonlyMap<HtlcAction, Readonly<HtlcPreparedAction>>,
): void {
  requireUInt(snapshot.observedAt, "snapshot observedAt");
  if (!HASH_RE.test(snapshot.authenticationHash)) {
    throw new DacsError("pay-cross-chain-htlc: ledger snapshot is unauthenticated");
  }
  if (snapshot.actions === null || typeof snapshot.actions !== "object" ||
      Array.isArray(snapshot.actions)) {
    throw new DacsError("pay-cross-chain-htlc: ledger actions are invalid");
  }
  const knownActions = new Set<HtlcAction>([
    "source-lock",
    "destination-lock",
    "destination-claim",
    "source-claim",
    "source-refund",
    "destination-refund",
  ]);
  for (const [key, observed] of Object.entries(snapshot.actions)) {
    if (!knownActions.has(key as HtlcAction) || observed === null ||
        typeof observed !== "object" || !HASH_RE.test(observed.authenticationHash)) {
      throw new DacsError("pay-cross-chain-htlc: action observation is unauthenticated");
    }
    const action = key as HtlcAction;
    if (observed.state === "absent") continue;
    const retained = prepared.get(action);
    if (!retained || !sameRef(observed.txRef, retained.txRef)) {
      throw new DacsError(`pay-cross-chain-htlc: ${action} observation is not retained`);
    }
    if (observed.state === "pending" || observed.state === "failed") {
      if (observed.reason !== undefined && typeof observed.reason !== "string") {
        throw new DacsError(`pay-cross-chain-htlc: ${action} reason is invalid`);
      }
      continue;
    }
    if (observed.state !== "final") {
      throw new DacsError(`pay-cross-chain-htlc: ${action} state is invalid`);
    }
    requireUInt(observed.finalityObservedAt, `${action} finalityObservedAt`);
    if (action === "source-lock" || action === "destination-lock") {
      const includedAt = requireUInt(observed.includedAt, `${action} includedAt`);
      const expiresAt = requireUInt(observed.expiresAt, `${action} expiresAt`, true);
      if (expiresAt * 1_000 <= includedAt) {
        throw new DacsError(`pay-cross-chain-htlc: ${action} expiry is not after inclusion`);
      }
    }
    if (action === "destination-claim" &&
        typeof observed.revealedPreimageHex !== "string") {
      throw new DacsError("pay-cross-chain-htlc: final destination claim omits the preimage");
    }
  }
}

function storedSettlementMatchesIntent(
  settlement: Readonly<CrossChainHtlcSettlement>,
  intent: Readonly<CrossChainHtlcIntent>,
): boolean {
  try {
    if (!Array.isArray(settlement.txRefs) || settlement.txRefs.length !== 4) return false;
    const expected = [
      { kind: "htlc-lock", chainId: intent.sourceChainId, contract: intent.sourceContractAddress },
      { kind: "htlc-lock", chainId: intent.destinationChainId, contract: intent.destinationContractAddress },
      { kind: "htlc-reveal", chainId: intent.destinationChainId, contract: intent.destinationContractAddress },
      { kind: "htlc-claim", chainId: intent.sourceChainId, contract: intent.sourceContractAddress },
    ] as const;
    const refsMatch = settlement.txRefs.every((ref, index) =>
      ref.kind === expected[index]!.kind &&
      ref.chainId === expected[index]!.chainId &&
      ref.contractAddress === expected[index]!.contract &&
      requireString(txHashOf(ref), "stored settlement txHash").length > 0);
    return refsMatch && settlement.paymentAmount.amount === intent.amount &&
      settlement.paymentAmount.currency === intent.currency &&
      settlement.settlementFinality.model === "htlc-reveal" &&
      Number.isSafeInteger(settlement.settlementFinality.finalityObservedAt) &&
      settlement.settlementFinality.finalityObservedAt >= 0 &&
      HASH_RE.test(settlement.authenticationHash);
  } catch {
    return false;
  }
}

export async function advanceCrossChainHtlc(
  input: Readonly<AdvanceCrossChainHtlcInput>,
): Promise<CrossChainHtlcProgress> {
  const authorizeDestinationClaim = input.authorizeDestinationClaim === true;
  const store = input.store;
  const adapter = input.adapter;
  const claimSettlement = store.claim.bind(store);
  const isCurrentSettlement = store.isCurrent.bind(store);
  const recordPrepared = store.recordPrepared.bind(store);
  const recordRevealFinal = store.recordRevealFinal.bind(store);
  const recordSettlement = store.recordSettlement.bind(store);
  const observeLedger = adapter.observe.bind(adapter);
  const prepareAction = adapter.prepareAction.bind(adapter);
  const broadcastRetained = adapter.broadcastRetained.bind(adapter);
  const now = input.now ?? Date.now;
  let owner: string;
  let leaseDurationMs: number;
  try {
    owner = requireString(input.owner, "owner");
    leaseDurationMs = requireUInt(
      input.leaseDurationMs ?? DEFAULT_LEASE_MS,
      "leaseDurationMs",
      true,
    );
  } catch (error) {
    return { status: "failed", errorClass: "permanent", reason: String(error) };
  }
  const readNow = (): number => requireUInt(now(), "clock");
  let created: Readonly<{
    intent: Readonly<CrossChainHtlcIntent>;
    secrets: Readonly<CrossChainHtlcSecrets>;
  }>;
  try {
    created = createCrossChainHtlcIntent(input.authority, input.buyerSalt, input.hashlocks);
  } catch (error) {
    return {
      status: "failed",
      errorClass: "permanent",
      reason: error instanceof Error ? error.message : "htlc-authority-invalid",
    };
  }
  const { intent, secrets } = created;
  let claimed: HtlcStoreClaim;
  let claimNow: number;
  try {
    claimNow = readNow();
    claimed = await claimSettlement({
      intent,
      secrets: Object.freeze({
        ...secrets,
        buyerSalt: secretCopy(secrets.buyerSalt),
        preimage: secretCopy(secrets.preimage),
      }),
      owner,
      now: claimNow,
      leaseDurationMs,
    });
  } catch {
    return { status: "indeterminate", reason: "htlc-settlement-store-unavailable" };
  }
  if ("intent" in claimed) {
    try {
      if (canonicalize(claimed.intent) !== canonicalize(intent)) {
        return { status: "indeterminate", reason: "htlc-settlement-store-intent-mismatch" };
      }
    } catch {
      return { status: "indeterminate", reason: "htlc-settlement-store-intent-invalid" };
    }
  }
  if (claimed.status === "waiting") return { status: "waiting", reason: "htlc-settlement-held" };
  if (claimed.status === "settled") {
    return storedSettlementMatchesIntent(claimed.settlement, intent)
      ? { status: "settled", settlement: claimed.settlement }
      : { status: "indeterminate", reason: "htlc-stored-settlement-mismatch" };
  }
  if (claimed.status !== "acquired") {
    return { status: "failed", errorClass: "permanent", reason: claimed.reason };
  }
  if (claimed.lease.owner !== owner ||
      !Number.isSafeInteger(claimed.lease.generation) || claimed.lease.generation <= 0 ||
      !Number.isSafeInteger(claimed.lease.expiresAt) || claimed.lease.expiresAt <= claimNow) {
    return { status: "indeterminate", reason: "htlc-settlement-store-lease-invalid" };
  }
  const fence: Readonly<HtlcEffectFence> = Object.freeze({
    settlementKey: intent.settlementKey,
    bindingHash: intent.bindingHash,
    owner: claimed.lease.owner,
    generation: claimed.lease.generation,
    assertCurrent: async () => {
      if (!await isCurrentSettlement({
        settlementKey: intent.settlementKey,
        bindingHash: intent.bindingHash,
        owner: claimed.lease.owner,
        generation: claimed.lease.generation,
        now: readNow(),
      })) throw new DacsError("pay-cross-chain-htlc: stale effect fence");
    },
  });
  let retainedActions: readonly Readonly<HtlcPreparedAction>[];
  try {
    retainedActions = claimed.prepared.map((item) => {
      const { effectHash, ...unsigned } = item;
      const validated = validatePrepared(unsigned, intent, item.action);
      if (validated.effectHash !== effectHash) {
        throw new DacsError("pay-cross-chain-htlc: retained action integrity mismatch");
      }
      return validated;
    });
  } catch (error) {
    return {
      status: "failed",
      errorClass: "permanent",
      reason: error instanceof Error ? error.message : "htlc-retained-action-corrupt",
    };
  }
  const prepared = new Map(retainedActions.map((item) => [item.action, item] as const));
  if (prepared.size !== retainedActions.length) {
    return { status: "failed", errorClass: "permanent", reason: "htlc-retained-action-duplicate" };
  }
  let retainedCheckpoint: Readonly<HtlcRevealCheckpoint> | undefined;
  try {
    retainedCheckpoint = claimed.revealCheckpoint === undefined
      ? undefined
      : captureRevealCheckpoint(claimed.revealCheckpoint, prepared);
  } catch (error) {
    return {
      status: "failed",
      errorClass: "permanent",
      reason: error instanceof Error ? error.message : "htlc-reveal-checkpoint-corrupt",
    };
  }
  const observe = async (): Promise<Readonly<HtlcLedgerSnapshot> | null> => {
    try {
      await fence.assertCurrent();
      const snapshot = await observeLedger(intent, fence);
      await fence.assertCurrent();
      validateSnapshot(snapshot, prepared);
      return snapshot;
    } catch {
      return null;
    }
  };
  const execute = async (
    action: HtlcAction,
    expiries: { sourceExpiry?: number; destinationExpiry?: number } = {},
  ): Promise<Readonly<HtlcLedgerSnapshot> | null> => {
    let retained = prepared.get(action);
    if (!retained) {
      try {
        await fence.assertCurrent();
        retained = validatePrepared(await prepareAction({
          intent,
          action,
          actor: actorFor(action),
          preimage: action === "destination-claim" || action === "source-claim"
            ? secretCopy(secrets.preimage)
            : undefined,
          ...expiries,
        }, fence), intent, action);
        await fence.assertCurrent();
      } catch {
        return null;
      }
      let recorded: HtlcStoreWrite;
      try {
        recorded = await recordPrepared({
          settlementKey: intent.settlementKey,
          bindingHash: intent.bindingHash,
          owner: fence.owner,
          generation: fence.generation,
          prepared: retained,
        });
      } catch {
        return null;
      }
      if (recorded.status !== "recorded" && recorded.status !== "existing") return null;
      prepared.set(action, retained);
    }
    try {
      await fence.assertCurrent();
      await broadcastRetained(retained, fence);
      await fence.assertCurrent();
    } catch {
      return null;
    }
    return observe();
  };

  let snapshot = await observe();
  if (!snapshot) return { status: "indeterminate", reason: "htlc-ledger-observation-unavailable" };
  let sourceLock: Extract<HtlcObservedAction, { state: "final" }> | undefined;
  let destinationLock: Extract<HtlcObservedAction, { state: "final" }> | undefined;
  let destinationClaim: Extract<HtlcObservedAction, { state: "final" }> | undefined;
  let sourceClaim: Extract<HtlcObservedAction, { state: "final" }> | undefined;
  try {
    sourceLock = final(snapshot, "source-lock", prepared.get("source-lock"));
    destinationLock = final(snapshot, "destination-lock", prepared.get("destination-lock"));
    destinationClaim = final(snapshot, "destination-claim", prepared.get("destination-claim"));
    sourceClaim = final(snapshot, "source-claim", prepared.get("source-claim"));
  } catch (error) {
    return { status: "failed", errorClass: "permanent", reason: String(error) };
  }

  if (sourceClaim) {
    if (!sourceLock || !destinationLock || !destinationClaim) {
      return { status: "failed", errorClass: "permanent", reason: "htlc-final-claim-chain-incomplete" };
    }
    if (sourceLock.expiresAt === undefined ||
        destinationClaim.revealedPreimageHex !== Buffer.from(secrets.preimage).toString("hex")) {
      return { status: "failed", errorClass: "permanent", reason: "htlc-final-claim-chain-invalid" };
    }
    if (sourceClaim.finalityObservedAt > sourceLock.expiresAt * 1_000) {
      return {
        status: "failed",
        errorClass: "settlement-atomicity",
        reason: "dest-revealed-source-unclaimed-expired",
      };
    }
    if (!retainedCheckpoint) {
      const checkpoint: Readonly<HtlcRevealCheckpoint> = Object.freeze({
        revealTxRef: destinationClaim.txRef as Extract<HtlcTxRef, { kind: "htlc-reveal" }>,
        sourceExpiry: sourceLock.expiresAt,
        finalityObservedAt: destinationClaim.finalityObservedAt,
        authenticationHash: destinationClaim.authenticationHash,
      });
      let checkpointed: HtlcStoreWrite;
      try {
        checkpointed = await recordRevealFinal({
          settlementKey: intent.settlementKey,
          bindingHash: intent.bindingHash,
          owner: fence.owner,
          generation: fence.generation,
          checkpoint,
        });
      } catch {
        return { status: "indeterminate", reason: "htlc-reveal-checkpoint-persistence-uncertain" };
      }
      if (checkpointed.status !== "recorded" && checkpointed.status !== "existing") {
        return { status: "indeterminate", reason: "htlc-reveal-checkpoint-persistence-uncertain" };
      }
    }
    const settlement = Object.freeze({
      txRefs: Object.freeze([
        sourceLock.txRef,
        destinationLock.txRef,
        destinationClaim.txRef,
        sourceClaim.txRef,
      ]),
      paymentAmount: Object.freeze({ amount: intent.amount, currency: intent.currency }),
      settlementFinality: Object.freeze({
        model: "htlc-reveal" as const,
        finalityObservedAt: sourceClaim.finalityObservedAt,
      }),
      authenticationHash: snapshot.authenticationHash,
    });
    let stored: HtlcStoreWrite;
    try {
      stored = await recordSettlement({
        settlementKey: intent.settlementKey,
        bindingHash: intent.bindingHash,
        owner: fence.owner,
        generation: fence.generation,
        settlement,
      });
    } catch {
      return { status: "indeterminate", reason: "htlc-settlement-persistence-uncertain" };
    }
    return stored.status === "recorded" || stored.status === "existing"
      ? { status: "settled", settlement }
      : { status: "indeterminate", reason: "htlc-settlement-persistence-uncertain" };
  }

  let checkpoint = retainedCheckpoint;
  if (destinationClaim) {
    if (!sourceLock || !destinationLock || sourceLock.expiresAt === undefined ||
        destinationLock.expiresAt === undefined) {
      return { status: "failed", errorClass: "permanent", reason: "htlc-reveal-without-final-lock-chain" };
    }
    if (destinationClaim.revealedPreimageHex !== Buffer.from(secrets.preimage).toString("hex")) {
      return { status: "failed", errorClass: "permanent", reason: "htlc-revealed-preimage-mismatch" };
    }
    if (checkpoint && (checkpoint.sourceExpiry !== sourceLock.expiresAt ||
        checkpoint.finalityObservedAt !== destinationClaim.finalityObservedAt ||
        checkpoint.authenticationHash !== destinationClaim.authenticationHash ||
        !sameRef(checkpoint.revealTxRef, destinationClaim.txRef))) {
      return { status: "failed", errorClass: "permanent", reason: "htlc-reveal-checkpoint-conflict" };
    }
    if (!checkpoint) {
      checkpoint = Object.freeze({
        revealTxRef: destinationClaim.txRef as Extract<HtlcTxRef, { kind: "htlc-reveal" }>,
        sourceExpiry: sourceLock.expiresAt,
        finalityObservedAt: destinationClaim.finalityObservedAt,
        authenticationHash: destinationClaim.authenticationHash,
      });
      let stored: HtlcStoreWrite;
      try {
        stored = await recordRevealFinal({
          settlementKey: intent.settlementKey,
          bindingHash: intent.bindingHash,
          owner: fence.owner,
          generation: fence.generation,
          checkpoint,
        });
      } catch {
        return { status: "indeterminate", reason: "htlc-reveal-checkpoint-persistence-uncertain" };
      }
      if (stored.status !== "recorded" && stored.status !== "existing") {
        return { status: "indeterminate", reason: "htlc-reveal-checkpoint-persistence-uncertain" };
      }
    }
  }

  if (checkpoint) {
    if (readNow() >= checkpoint.sourceExpiry * 1_000) {
      return {
        status: "failed",
        errorClass: "settlement-atomicity",
        reason: "dest-revealed-source-unclaimed-expired",
      };
    }
    const sourceClaimState = snapshot.actions["source-claim"];
    if (!sourceClaimState || sourceClaimState.state === "absent") {
      const advanced = await execute("source-claim", { sourceExpiry: checkpoint.sourceExpiry });
      if (!advanced) return { status: "indeterminate", reason: "htlc-source-claim-effect-uncertain" };
      snapshot = advanced;
      try {
        sourceClaim = final(snapshot, "source-claim", prepared.get("source-claim"));
      } catch (error) {
        return { status: "failed", errorClass: "permanent", reason: String(error) };
      }
      if (sourceClaim && sourceLock && destinationLock && destinationClaim) {
        if (sourceClaim.finalityObservedAt > checkpoint.sourceExpiry * 1_000) {
          return {
            status: "failed",
            errorClass: "settlement-atomicity",
            reason: "dest-revealed-source-unclaimed-expired",
          };
        }
        const settlement = Object.freeze({
          txRefs: Object.freeze([sourceLock.txRef, destinationLock.txRef, destinationClaim.txRef, sourceClaim.txRef]),
          paymentAmount: Object.freeze({ amount: intent.amount, currency: intent.currency }),
          settlementFinality: Object.freeze({ model: "htlc-reveal" as const, finalityObservedAt: sourceClaim.finalityObservedAt }),
          authenticationHash: snapshot.authenticationHash,
        });
        let stored: HtlcStoreWrite;
        try {
          stored = await recordSettlement({
            settlementKey: intent.settlementKey,
            bindingHash: intent.bindingHash,
            owner: fence.owner,
            generation: fence.generation,
            settlement,
          });
        } catch {
          return { status: "indeterminate", reason: "htlc-settlement-persistence-uncertain" };
        }
        return stored.status === "recorded" || stored.status === "existing"
          ? { status: "settled", settlement }
          : { status: "indeterminate", reason: "htlc-settlement-persistence-uncertain" };
      }
    }
    return {
      status: "settle-asymmetric",
      reason: "dest-revealed-source-unclaimed",
      recoveryDeadline: checkpoint.sourceExpiry,
      txRefs: collectRefs(snapshot, prepared),
      finalityObservedAt: checkpoint.finalityObservedAt,
    };
  }

  if (!sourceLock) {
    const state = snapshot.actions["source-lock"];
    if (state?.state === "failed") {
      return { status: "failed", errorClass: "permanent", reason: state.reason ?? "htlc-source-lock-failed" };
    }
    if (!state || state.state === "absent") {
      const advanced = await execute("source-lock");
      return advanced
        ? { status: "waiting", reason: "htlc-source-lock-finality-pending" }
        : { status: "indeterminate", reason: "htlc-source-lock-effect-uncertain" };
    }
    return { status: "waiting", reason: "htlc-source-lock-finality-pending" };
  }
  if (sourceLock.expiresAt === undefined) {
    return { status: "failed", errorClass: "permanent", reason: "htlc-source-lock-expiry-missing" };
  }

  if (!destinationLock) {
    if (readNow() >= sourceLock.expiresAt * 1_000) {
      const refund = snapshot.actions["source-refund"];
      if (!refund || refund.state === "absent") {
        const advanced = await execute("source-refund", { sourceExpiry: sourceLock.expiresAt });
        return advanced
          ? { status: "refund-pending", reason: "destination-lock-missing", txRefs: collectRefs(advanced, prepared) }
          : { status: "indeterminate", reason: "htlc-source-refund-effect-uncertain" };
      }
      return {
        status: refund.state === "final" ? "refunded" : "refund-pending",
        reason: "destination-lock-missing",
        txRefs: collectRefs(snapshot, prepared),
      };
    }
    const destinationExpiry = Math.floor(snapshot.observedAt / 1_000) + intent.destinationTimelockSec;
    if (sourceLock.expiresAt <= destinationExpiry + intent.sourceFinalitySec + intent.safetyWindowSec) {
      return { status: "failed", errorClass: "permanent", reason: "htlc-absolute-expiry-margin-insufficient" };
    }
    const state = snapshot.actions["destination-lock"];
    if (state?.state === "failed") {
      return { status: "failed", errorClass: "counterparty", reason: state.reason ?? "htlc-destination-lock-failed" };
    }
    if (!state || state.state === "absent") {
      const advanced = await execute("destination-lock", {
        sourceExpiry: sourceLock.expiresAt,
        destinationExpiry,
      });
      return advanced
        ? { status: "waiting", reason: "htlc-destination-lock-finality-pending" }
        : { status: "indeterminate", reason: "htlc-destination-lock-effect-uncertain" };
    }
    return { status: "waiting", reason: "htlc-destination-lock-finality-pending" };
  }
  if (destinationLock.expiresAt === undefined) {
    return { status: "failed", errorClass: "permanent", reason: "htlc-destination-lock-expiry-missing" };
  }
  if (destinationLock.includedAt === undefined ||
      destinationLock.includedAt < sourceLock.finalityObservedAt) {
    return { status: "failed", errorClass: "permanent", reason: "htlc-destination-lock-precedes-source-finality" };
  }
  if (sourceLock.expiresAt <= destinationLock.expiresAt + intent.sourceFinalitySec + intent.safetyWindowSec) {
    return { status: "failed", errorClass: "permanent", reason: "htlc-absolute-expiry-margin-insufficient" };
  }

  if (readNow() >= destinationLock.expiresAt * 1_000) {
    const pendingClaim = snapshot.actions["destination-claim"];
    if (pendingClaim?.state === "pending") {
      return { status: "waiting", reason: "htlc-destination-claim-finality-pending" };
    }
    const destinationRefund = snapshot.actions["destination-refund"];
    const sourceRefund = snapshot.actions["source-refund"];
    if (!destinationRefund || destinationRefund.state === "absent") {
      const advanced = await execute("destination-refund", { destinationExpiry: destinationLock.expiresAt });
      return advanced
        ? { status: "refund-pending", reason: "destination-timeout", txRefs: collectRefs(advanced, prepared) }
        : { status: "indeterminate", reason: "htlc-destination-refund-effect-uncertain" };
    }
    if (readNow() >= sourceLock.expiresAt * 1_000 && (!sourceRefund || sourceRefund.state === "absent")) {
      const advanced = await execute("source-refund", { sourceExpiry: sourceLock.expiresAt });
      return advanced
        ? { status: "refund-pending", reason: "destination-timeout", txRefs: collectRefs(advanced, prepared) }
        : { status: "indeterminate", reason: "htlc-source-refund-effect-uncertain" };
    }
    const bothFinal = destinationRefund.state === "final" && sourceRefund?.state === "final";
    return {
      status: bothFinal ? "refunded" : "refund-pending",
      reason: "destination-timeout",
      txRefs: collectRefs(snapshot, prepared),
    };
  }

  if (!authorizeDestinationClaim) {
    return { status: "waiting", reason: "htlc-destination-claim-not-authorized" };
  }
  const claimState = snapshot.actions["destination-claim"];
  if (claimState?.state === "failed") {
    return { status: "failed", errorClass: "counterparty", reason: claimState.reason ?? "htlc-destination-claim-failed" };
  }
  if (!claimState || claimState.state === "absent") {
    const advanced = await execute("destination-claim", {
      sourceExpiry: sourceLock.expiresAt,
      destinationExpiry: destinationLock.expiresAt,
    });
    return advanced
      ? { status: "waiting", reason: "htlc-destination-claim-finality-pending" }
      : { status: "indeterminate", reason: "htlc-destination-claim-effect-uncertain" };
  }
  return { status: "waiting", reason: "htlc-destination-claim-finality-pending" };
}

interface MemoryHtlcRecord {
  intent: Readonly<CrossChainHtlcIntent>;
  secrets: Readonly<CrossChainHtlcSecrets>;
  lease: HtlcLease;
  prepared: Map<HtlcAction, Readonly<HtlcPreparedAction>>;
  revealCheckpoint?: Readonly<HtlcRevealCheckpoint>;
  settlement?: Readonly<CrossChainHtlcSettlement>;
}

/** Test/development store. Production callers must use encrypted durable state. */
export function createInMemoryCrossChainHtlcStore(): CrossChainHtlcStore {
  const records = new Map<string, MemoryHtlcRecord>();
  const saltOwners = new Map<string, string>();
  const effects = new Map<string, string>();
  const transactionOwners = new Map<string, string>();
  const current = (
    record: MemoryHtlcRecord | undefined,
    input: { bindingHash: string; owner: string; generation: number },
  ): record is MemoryHtlcRecord => record !== undefined &&
    record.intent.bindingHash === input.bindingHash && record.lease.owner === input.owner &&
    record.lease.generation === input.generation;
  return {
    async claim(input) {
      const existing = records.get(input.intent.settlementKey);
      if (existing) {
        if (existing.intent.bindingHash !== input.intent.bindingHash ||
            existing.secrets.buyerSaltHash !== input.secrets.buyerSaltHash ||
            existing.secrets.preimageHash !== input.secrets.preimageHash) {
          return { status: "conflict", reason: "htlc-settlement-binding-or-secret-conflict" };
        }
        if (existing.settlement) {
          return { status: "settled", intent: existing.intent, settlement: existing.settlement };
        }
        if (existing.lease.expiresAt > input.now) {
          return {
            status: "waiting",
            intent: existing.intent,
            lease: { ...existing.lease },
            prepared: [...existing.prepared.values()],
            revealCheckpoint: existing.revealCheckpoint,
          };
        }
        existing.lease = {
          owner: input.owner,
          generation: existing.lease.generation + 1,
          expiresAt: input.now + input.leaseDurationMs,
        };
        return {
          status: "acquired",
          intent: existing.intent,
          lease: { ...existing.lease },
          prepared: [...existing.prepared.values()],
          revealCheckpoint: existing.revealCheckpoint,
        };
      }
      const saltOwner = saltOwners.get(input.secrets.buyerSaltHash);
      if (saltOwner && saltOwner !== input.intent.settlementKey) {
        return { status: "conflict", reason: "htlc-buyer-salt-cross-session-reuse" };
      }
      const record: MemoryHtlcRecord = {
        intent: input.intent,
        secrets: Object.freeze({
          ...input.secrets,
          buyerSalt: secretCopy(input.secrets.buyerSalt),
          preimage: secretCopy(input.secrets.preimage),
        }),
        lease: { owner: input.owner, generation: 1, expiresAt: input.now + input.leaseDurationMs },
        prepared: new Map(),
      };
      records.set(input.intent.settlementKey, record);
      saltOwners.set(input.secrets.buyerSaltHash, input.intent.settlementKey);
      return {
        status: "acquired",
        intent: record.intent,
        lease: { ...record.lease },
        prepared: [],
      };
    },
    async isCurrent(input) {
      const record = records.get(input.settlementKey);
      return current(record, input) && record.lease.expiresAt > input.now && !record.settlement;
    },
    async recordPrepared(input) {
      const record = records.get(input.settlementKey);
      if (!current(record, input)) return { status: "stale", reason: "stale-lease" };
      if (record.revealCheckpoint && input.prepared.action === "source-refund") {
        return { status: "conflict", reason: "htlc-source-refund-blocked-after-reveal" };
      }
      const owner = effects.get(input.prepared.effectHash);
      if (owner && owner !== input.settlementKey) {
        return { status: "conflict", reason: "htlc-effect-cross-settlement-reuse" };
      }
      const transactionKey = canonicalize(input.prepared.txRef);
      const transactionOwner = transactionOwners.get(transactionKey);
      if (transactionOwner && transactionOwner !== input.settlementKey) {
        return { status: "conflict", reason: "htlc-transaction-cross-settlement-reuse" };
      }
      const prior = record.prepared.get(input.prepared.action);
      if (prior) {
        return prior.effectHash === input.prepared.effectHash
          ? { status: "existing" }
          : { status: "conflict", reason: "htlc-action-replacement-forbidden" };
      }
      record.prepared.set(input.prepared.action, Object.freeze({ ...input.prepared }));
      effects.set(input.prepared.effectHash, input.settlementKey);
      transactionOwners.set(transactionKey, input.settlementKey);
      return { status: "recorded" };
    },
    async recordRevealFinal(input) {
      const record = records.get(input.settlementKey);
      if (!current(record, input)) return { status: "stale", reason: "stale-lease" };
      if (!HASH_RE.test(input.checkpoint.authenticationHash)) {
        return { status: "corrupt", reason: "htlc-reveal-checkpoint-unauthenticated" };
      }
      if (record.revealCheckpoint) {
        return canonicalize(record.revealCheckpoint) === canonicalize(input.checkpoint)
          ? { status: "existing" }
          : { status: "conflict", reason: "htlc-reveal-checkpoint-conflict" };
      }
      record.revealCheckpoint = Object.freeze({
        ...input.checkpoint,
        revealTxRef: Object.freeze({ ...input.checkpoint.revealTxRef }),
      });
      return { status: "recorded" };
    },
    async recordSettlement(input) {
      const record = records.get(input.settlementKey);
      if (!current(record, input)) return { status: "stale", reason: "stale-lease" };
      if (!record.revealCheckpoint) {
        return { status: "conflict", reason: "htlc-settlement-without-reveal-checkpoint" };
      }
      if (record.settlement) {
        return canonicalize(record.settlement) === canonicalize(input.settlement)
          ? { status: "existing" }
          : { status: "conflict", reason: "htlc-settlement-conflict" };
      }
      record.settlement = Object.freeze({ ...input.settlement });
      return { status: "recorded" };
    },
  };
}

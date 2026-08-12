import type { KeyObject } from "node:crypto";

import { ed25519Sign, privateKeyFromSeed, signedBytes } from "../crypto/index.js";
import { canonicalize, contentHash, sha256Hex } from "../canonical/index.js";
import { DacsError, SubstrateError } from "../errors.js";
import {
  isCanonicalBase64Url,
  isAnchorReceipt,
  isBundleBinding,
  isFaultAttestationBundle,
  BUNDLE_BINDING_SEPARATOR,
  type BuildComponentSignatureOptions,
  type BundleBinding,
} from "../artifacts/index.js";
import {
  attestationBundleHash,
} from "../agent/twoSidedBundle.js";
import {
  FENCED_SESSION_STORE_VERSION,
  sessionRecordShapeViolation,
  sessionReceiptKey,
  type CheckpointValue,
  type FencedSessionStoreV2,
  type SessionCheckpoint,
  type SessionLeaseToken,
  type SessionPaymentAuthorizationBinding,
  type SessionRecord,
} from "../agent/fencedSessionStore.js";
import {
  projectDurableSellerAuditPending,
  type DurableSellerTerminalVerification,
} from "../agent/runDurableFulfilmentCore.js";
import type { SellerFulfilmentListing } from "../agent/runFulfilmentCore.js";
import {
  finalizeCompletedSellerBundleCore,
  prepareCompletedSellerBundleCounterSignatureRequest,
  verifyFinalizedSellerBundleReadOnly,
  type FinalizeCompletedSellerBundleInput,
  type FinalizedSellerBundle,
  type SellerBundleBindingPublication,
  type SellerBundleFinalizationProvider,
  type SellerBundleFinalizationReadProvider,
  type VerifyFinalizedSellerBundleInput,
} from "./bundleFinalization.js";

export type SellerBundleFinalizationRole = "buyer" | "seller" | "orchestrator";
export type SellerBundleSignaturePurpose = "bundle" | "bundle-binding";

const MAX_CAS_ATTEMPTS = 16;
const MAX_LEASE_RELEASE_ATTEMPTS = 8;

/** Monotonic authority supplied to every irreversible bundle-finalization adapter. */
export interface SellerBundleEffectFence extends SessionLeaseToken {
  /** Stable for the same logical effect across retries and lease generations. */
  idempotencyKey: string;
}

export type SellerBundleFencedSigner = (
  bytes: Uint8Array,
  fence: Readonly<SellerBundleEffectFence>,
) => Promise<Uint8Array> | Uint8Array;

export type SellerBundleDurableSigner = Uint8Array | KeyObject | SellerBundleFencedSigner;

export type SellerBundleFencedComponentSigner = (
  bytes: Uint8Array,
  context: Parameters<BuildComponentSignatureOptions["sign"]>[1],
  fence: Readonly<SellerBundleEffectFence>,
) => ReturnType<BuildComponentSignatureOptions["sign"]>;

/** #132 input with generation fencing added to the two live seller-side signers. */
export type FinalizeCompletedSellerBundleDurableInput = Omit<
  FinalizeCompletedSellerBundleInput,
  "seller" | "bindingSigner"
> & {
  /** Independently verified exact signed Listing view used for WAL projection. */
  verifiedListing: SellerFulfilmentListing;
  seller: Omit<FinalizeCompletedSellerBundleInput["seller"], "signer"> & {
    signer: SellerBundleDurableSigner;
  };
  bindingSigner?: Omit<BuildComponentSignatureOptions, "sign"> & {
    sign: SellerBundleFencedComponentSigner;
  };
};

/** #132 provider with a mandatory generation fence on every irreversible write. */
export type DurableSellerBundleFinalizationProvider = Omit<
  SellerBundleFinalizationProvider,
  "submitSellerBundle" | "publishBundleBinding"
> & {
  submitSellerBundle: (
    logicalAddress: string,
    bundle: Parameters<SellerBundleFinalizationProvider["submitSellerBundle"]>[1],
    fence: Readonly<SellerBundleEffectFence>,
  ) => ReturnType<SellerBundleFinalizationProvider["submitSellerBundle"]>;
  publishBundleBinding?: (
    binding: Readonly<BundleBinding>,
    fence: Readonly<SellerBundleEffectFence>,
  ) => Promise<SellerBundleBindingPublication> | SellerBundleBindingPublication;
};

export const sellerBundleFinalizationCheckpointKey = {
  input: "seller:bundle-finalization-input",
  signature: (role: SellerBundleFinalizationRole) =>
    `seller:bundle-signature:${role}`,
  anchor: "seller:bundle-anchor:seller",
  bindingSignature: "seller:bundle-binding-signature:seller",
  bindingPublication: "seller:bundle-binding-publication:seller",
  result: "seller:bundle-finalization-result",
} as const;

export type SellerBundleSignatureReconciliation =
  | { disposition: "signed"; value: Uint8Array | string }
  | { disposition: "authoritatively-absent"; reason: string }
  | { disposition: "indeterminate"; reason: string };

export type SellerBundleAnchorReconciliation =
  | { disposition: "present" }
  | { disposition: "authoritatively-absent"; reason: string }
  | { disposition: "rejected"; reason: string }
  | { disposition: "indeterminate"; reason: string };

export type SellerBundleBindingPublicationReconciliation =
  | SellerBundleBindingPublication
  | { disposition: "authoritatively-absent"; reason: string };

/**
 * Recovery-only callbacks are deliberately separate from ordinary sign/write
 * callbacks. They run only when a durable intent exists without its outcome.
 */
export interface SellerBundleFinalizationDurability {
  store: FencedSessionStoreV2;
  workerId: string;
  leaseTtlMs: number;
  /** Wall clock used only for lease acquisition/renewal and operational observations. */
  leaseNowMs?: () => number;
  /** Re-authenticate the complete #121 terminal fulfilment spine before bundle work. */
  terminalVerification: DurableSellerTerminalVerification;
  reconcileSignature: (input: {
    purpose: SellerBundleSignaturePurpose;
    role: SellerBundleFinalizationRole;
    signer: string;
    messageHash: string;
    signedBytes: Uint8Array;
    fence: Readonly<SellerBundleEffectFence>;
  }) =>
    | Promise<SellerBundleSignatureReconciliation>
    | SellerBundleSignatureReconciliation;
  reconcileBundleAnchor: (input: {
    logicalAddress: string;
    bundleContentHash: string;
    fence: Readonly<SellerBundleEffectFence>;
  }) =>
    | Promise<SellerBundleAnchorReconciliation>
    | SellerBundleAnchorReconciliation;
  reconcileBindingPublication: (
    binding: Readonly<BundleBinding>,
    fence: Readonly<SellerBundleEffectFence>,
  ) =>
    | Promise<SellerBundleBindingPublicationReconciliation>
    | SellerBundleBindingPublicationReconciliation;
}

export type SellerBundleCheckpointState = "not-started" | "intent" | "outcome";
export type SellerBundlePublicationCheckpointState =
  | SellerBundleCheckpointState
  | "not-applicable";

export type SellerBundleFinalizationStatusLoad =
  | { status: "missing" }
  | { status: "corrupt"; reason: string }
  | { status: "unsupported"; version: number }
  | {
      status: "ok";
      jobId: string;
      phase: string;
      revision: number;
      lease?: { owner: string; generation: number; expiresAt: number };
      signatures: Record<
        SellerBundleFinalizationRole | "binding",
        SellerBundleCheckpointState
      >;
      bundleAnchor: SellerBundleCheckpointState;
      bindingPublication: SellerBundlePublicationCheckpointState;
      bundleReceipt?: string;
      updatedAt: number;
    };

const isNonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isHash = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

const exact = (left: unknown, right: unknown): boolean => {
  try {
    return canonicalize(left) === canonicalize(right);
  } catch {
    return false;
  }
};

function latestCheckpoint(
  checkpoints: readonly SessionCheckpoint[],
  key: string,
): SessionCheckpoint | undefined {
  for (let index = checkpoints.length - 1; index >= 0; index--) {
    const checkpoint = checkpoints[index];
    if (checkpoint?.key === key) return checkpoint;
  }
  return undefined;
}

function checkpointState(
  checkpoints: readonly SessionCheckpoint[],
  key: string,
): SellerBundleCheckpointState {
  return latestCheckpoint(checkpoints, key)?.stage ?? "not-started";
}

function dataMatches(
  actual: Record<string, CheckpointValue> | undefined,
  expected: Record<string, CheckpointValue>,
): boolean {
  if (actual === undefined) return false;
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) =>
      key === expectedKeys[index] && actual[key] === expected[key]
    );
}

function normalizeSignature(value: Uint8Array | string): string {
  const encoded =
    typeof value === "string" ? value : Buffer.from(value).toString("base64url");
  if (
    !isCanonicalBase64Url(encoded) ||
    Buffer.from(encoded, "base64url").byteLength !== 64
  ) {
    throw new DacsError(
      "durable signer did not return one canonical Base64URL Ed25519 signature",
    );
  }
  return encoded;
}

async function invokeBundleSigner(
  signer: SellerBundleDurableSigner,
  bytes: Uint8Array,
  fence: Readonly<SellerBundleEffectFence>,
): Promise<Uint8Array> {
  const retainedBytes = new Uint8Array(bytes);
  if (typeof signer === "function") return await signer(retainedBytes, fence);
  return ed25519Sign(
    retainedBytes,
    signer instanceof Uint8Array ? privateKeyFromSeed(signer) : signer,
  );
}

const clone = <T>(value: T): T => structuredClone(value);

function exactRecordFromLoad(
  loaded: Awaited<ReturnType<FencedSessionStoreV2["load"]>>,
): SessionRecord {
  if (loaded.status !== "ok") {
    throw new SubstrateError(
      loaded.status === "unsupported"
        ? `seller bundle state uses unsupported store version ${loaded.version}`
        : loaded.status === "corrupt"
          ? `seller bundle state is corrupt: ${loaded.reason}`
          : "seller bundle finalization requires an existing durable fulfilment state",
    );
  }
  const record = clone(loaded.record);
  const violation = sessionRecordShapeViolation(record);
  if (violation) throw new SubstrateError(`seller bundle state is corrupt: ${violation}`);
  return record;
}

function exactOwnKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReasonDisposition(
  value: unknown,
  dispositions: readonly string[],
): value is { disposition: string; reason: string } {
  return isRecord(value) &&
    exactOwnKeys(value, ["disposition", "reason"]) &&
    dispositions.includes(String(value.disposition)) &&
    isNonEmpty(value.reason);
}

function validSignatureReconciliation(
  value: unknown,
): value is SellerBundleSignatureReconciliation {
  return isRecord(value) && (
    (value.disposition === "signed" &&
      exactOwnKeys(value, ["disposition", "value"]) &&
      (typeof value.value === "string" || value.value instanceof Uint8Array)) ||
    isReasonDisposition(value, ["authoritatively-absent", "indeterminate"])
  );
}

function validAnchorReconciliation(
  value: unknown,
): value is SellerBundleAnchorReconciliation {
  return isRecord(value) && (
    (value.disposition === "present" && exactOwnKeys(value, ["disposition"])) ||
    isReasonDisposition(value, [
      "authoritatively-absent",
      "rejected",
      "indeterminate",
    ])
  );
}

function validBindingReconciliation(
  value: unknown,
): value is SellerBundleBindingPublicationReconciliation {
  return isRecord(value) && (
    (value.disposition === "published" && exactOwnKeys(value, ["disposition"])) ||
    isReasonDisposition(value, [
      "authoritatively-absent",
      "rejected",
      "indeterminate",
    ])
  );
}

function encodeFinalizedResult(result: FinalizedSellerBundle): {
  encoded: string;
  hash: string;
} {
  const json = canonicalize(result);
  return {
    encoded: Buffer.from(json, "utf8").toString("base64url"),
    hash: sha256Hex(json),
  };
}

function decodeFinalizedResult(
  encoded: unknown,
  expectedHash: unknown,
  jobId: string,
): FinalizedSellerBundle {
  if (!isCanonicalBase64Url(encoded) || !isHash(expectedHash)) {
    throw new DacsError("terminal seller bundle result encoding is malformed");
  }
  let parsed: unknown;
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) throw new Error("non-canonical Base64URL");
    const json = bytes.toString("utf8");
    if (sha256Hex(json) !== expectedHash) throw new Error("result hash mismatch");
    parsed = JSON.parse(json) as unknown;
    if (canonicalize(parsed) !== json) throw new Error("result JSON is not canonical");
  } catch (error) {
    throw new DacsError("terminal seller bundle result cannot be decoded", { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new DacsError("terminal seller bundle result is not an object");
  }
  const value = parsed as Record<string, unknown>;
  const allowed = [
    "state",
    "logicalAddress",
    "nativeAddress",
    "bundleContentHash",
    "sellerBundle",
    "buyerBundle",
    ...(value.orchestratorBundle === undefined ? [] : ["orchestratorBundle"]),
    "anchorReceipt",
    ...(value.anchorTx === undefined ? [] : ["anchorTx"]),
    ...(value.binding === undefined ? [] : ["binding"]),
    "resumedBundle",
    "resumedBinding",
  ];
  if (
    !exactOwnKeys(value, allowed) ||
    value.state !== "finalised" ||
    typeof value.logicalAddress !== "string" ||
    typeof value.nativeAddress !== "string" ||
    !isHash(value.bundleContentHash) ||
    !isFaultAttestationBundle(value.sellerBundle) ||
    !isFaultAttestationBundle(value.buyerBundle) ||
    value.sellerBundle.jobId !== jobId ||
    value.buyerBundle.jobId !== jobId ||
    value.sellerBundle.anchoredByRole !== "seller" ||
    value.buyerBundle.anchoredByRole !== "buyer" ||
    attestationBundleHash(value.sellerBundle) !== value.bundleContentHash ||
    attestationBundleHash(value.buyerBundle) !== value.bundleContentHash ||
    !isAnchorReceipt(value.anchorReceipt) ||
    value.anchorReceipt.logicalAddress !== value.logicalAddress ||
    value.anchorReceipt.nativeAddress !== value.nativeAddress ||
    value.anchorReceipt.contentHash !== value.bundleContentHash ||
    value.anchorReceipt.observationDisposition !== "established" ||
    value.anchorReceipt.state !== "finalized" ||
    (value.anchorTx !== undefined && typeof value.anchorTx !== "string") ||
    typeof value.resumedBundle !== "boolean" ||
    typeof value.resumedBinding !== "boolean"
  ) {
    throw new DacsError("terminal seller bundle result is malformed or rebound");
  }
  if (value.orchestratorBundle !== undefined) {
    if (
      !isFaultAttestationBundle(value.orchestratorBundle) ||
      value.orchestratorBundle.jobId !== jobId ||
      value.orchestratorBundle.anchoredByRole !== "orchestrator" ||
      attestationBundleHash(value.orchestratorBundle) !== value.bundleContentHash
    ) {
      throw new DacsError("terminal orchestrator bundle is malformed or rebound");
    }
  }
  if (value.binding !== undefined) {
    if (
      !isBundleBinding(value.binding) ||
      value.binding.jobId !== jobId ||
      value.binding.logicalAddress !== value.logicalAddress ||
      value.binding.nativeAddress !== value.nativeAddress ||
      value.binding.bundleContentHash !== value.bundleContentHash
    ) {
      throw new DacsError("terminal BundleBinding is malformed or rebound");
    }
  }
  return clone(parsed as FinalizedSellerBundle);
}

/** Stable status projection over the public FencedSessionStoreV2. */
export async function getSellerBundleFinalizationStatus(
  store: FencedSessionStoreV2,
  jobId: string,
): Promise<SellerBundleFinalizationStatusLoad> {
  const loaded = await store.load(jobId);
  if (loaded.status !== "ok") return loaded;
  const checkpoints = loaded.record.checkpoints;
  const bindingPublication = latestCheckpoint(
    checkpoints,
    sellerBundleFinalizationCheckpointKey.bindingPublication,
  );
  const bundleReceipt = loaded.record.receipts.find(
    (receipt) => receipt.kind === "bundle",
  );
  return {
    status: "ok",
    jobId: loaded.record.jobId,
    phase: loaded.record.phase,
    revision: loaded.record.revision,
    ...(loaded.record.lease ? { lease: { ...loaded.record.lease } } : {}),
    signatures: {
      buyer: checkpointState(
        checkpoints,
        sellerBundleFinalizationCheckpointKey.signature("buyer"),
      ),
      seller: checkpointState(
        checkpoints,
        sellerBundleFinalizationCheckpointKey.signature("seller"),
      ),
      orchestrator: checkpointState(
        checkpoints,
        sellerBundleFinalizationCheckpointKey.signature("orchestrator"),
      ),
      binding: checkpointState(
        checkpoints,
        sellerBundleFinalizationCheckpointKey.bindingSignature,
      ),
    },
    bundleAnchor: checkpointState(
      checkpoints,
      sellerBundleFinalizationCheckpointKey.anchor,
    ),
    bindingPublication:
      bindingPublication?.stage === "outcome" &&
      bindingPublication.data?.applicable === false
        ? "not-applicable"
        : bindingPublication?.stage ?? "not-started",
    ...(bundleReceipt ? { bundleReceipt: bundleReceipt.ref } : {}),
    updatedAt: loaded.record.updatedAt,
  };
}

const BUNDLE_PHASE_RANK = new Map<string, number>([
  ["seller:bundle-signing", 0],
  ["seller:bundle-anchor-pending", 1],
  ["seller:bundle-binding-signing", 2],
  ["seller:bundle-binding-publication-pending", 3],
]);

type ClaimedBundleWal = {
  state: "fresh" | "intent" | "outcome";
  record: SessionRecord;
  data: Record<string, CheckpointValue>;
};

class DurableBundleCoordinator {
  readonly #input: FinalizeCompletedSellerBundleDurableInput;
  readonly #durability: SellerBundleFinalizationDurability;
  #authority?: SessionPaymentAuthorizationBinding;
  #leaseToken?: SessionLeaseToken;
  #terminalResult?: FinalizedSellerBundle;
  #inputData?: Record<string, CheckpointValue>;
  #bundleMessageHash?: string;
  readonly #counterSignatureData = new Map<
    "buyer" | "orchestrator",
    Record<string, CheckpointValue>
  >();

  constructor(
    input: FinalizeCompletedSellerBundleDurableInput,
    durability: SellerBundleFinalizationDurability,
  ) {
    this.#input = input;
    this.#durability = durability;
  }

  #now(): number {
    const now = this.#durability.leaseNowMs?.() ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0 || Object.is(now, -0)) {
      throw new DacsError("bundle durability clock returned an invalid time");
    }
    return now;
  }

  async #loadRecord(): Promise<SessionRecord> {
    return exactRecordFromLoad(
      await this.#durability.store.load(this.#input.agreement.jobId),
    );
  }

  async #verifyFulfilmentSpine(record: SessionRecord) {
    const projected = await projectDurableSellerAuditPending({
      record: clone(record),
      verifiedAgreement: clone(this.#input.agreement),
      verifiedListing: clone(this.#input.verifiedListing),
      expectedDeliveryWriter: {
        role: "seller",
        primaryClaim: this.#input.agreement.seller.primaryClaim,
      },
      ...this.#durability.terminalVerification,
    });
    const projectedArtifacts = {
      ...clone(projected.sessionArtifacts),
      vetRequirements: projected.sessionArtifacts.vetRequirements.map((invocation) => ({
        ...clone(invocation),
        freshness: invocation.freshness.map(({ sourceJobId: _sourceJobId, ...entry }) =>
          clone(entry)),
        dealSpecific: invocation.dealSpecific.map(({
          sourceJobId: _sourceJobId,
          ...entry
        }) => clone(entry)),
      })),
    };
    if (!exact(projected.terminal.result, this.#input.fulfilment) ||
        !exact(projected.session, this.#input.session) ||
        !exact(projectedArtifacts, this.#input.sessionArtifacts)) {
      throw new DacsError(
        "bundle finalization input is not the exact authenticated WAL projection",
      );
    }
    return projected.terminal;
  }

  verificationInput(): VerifyFinalizedSellerBundleInput {
    const {
      seller,
      bindingSigner: _bindingSigner,
      verifiedListing: _verifiedListing,
      ...data
    } = this.#input;
    return {
      ...clone(data),
      seller: {
        primaryClaim: seller.primaryClaim,
        bundleHash: seller.bundleHash,
      },
    };
  }

  #authorityFields(idempotencyKey?: string): Record<string, CheckpointValue> {
    if (!this.#authority) throw new DacsError("durable fulfilment authority is unavailable");
    return {
      fulfilmentId: this.#authority.fulfilmentId,
      authorizationHash: this.#authority.authorizationHash,
      handoffBindingHash: this.#authority.handoffBindingHash,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    };
  }

  #counterData(
    messageHash: string,
    requiredCounterSigners: readonly string[],
  ): void {
    this.#bundleMessageHash = messageHash;
    const supplied = this.#input.counterSignatures ?? [];
    if (
      !Array.isArray(supplied) ||
      supplied.length !== requiredCounterSigners.length ||
      new Set(requiredCounterSigners).size !== requiredCounterSigners.length ||
      new Set(supplied.map((signature) => signature?.party)).size !== supplied.length ||
      supplied.some(
        (signature) =>
          !isRecord(signature) ||
          !exactOwnKeys(signature, ["party", "algorithm", "value"]) ||
          !requiredCounterSigners.includes(String(signature.party)),
      )
    ) {
      throw new DacsError("detached bundle signatures do not form the exact counterparty set");
    }
    for (let index = 0; index < requiredCounterSigners.length; index += 1) {
      const signer = requiredCounterSigners[index]!;
      const signature = supplied.find((candidate) => candidate.party === signer);
      if (
        !signature ||
        signature.algorithm !== "ed25519" ||
        !isCanonicalBase64Url(signature.value) ||
        Buffer.from(signature.value, "base64url").byteLength !== 64
      ) {
        throw new DacsError(`missing canonical detached signature for ${signer}`);
      }
      const role = index === 0 ? "buyer" : "orchestrator";
      this.#counterSignatureData.set(role, {
        ...this.#authorityFields(),
        messageHash,
        signer,
        algorithm: signature.algorithm,
        signatureValue: signature.value,
      });
    }
  }

  async initialize(provider: SellerBundleFinalizationProvider): Promise<void> {
    if (
      this.#durability.store.apiVersion !== FENCED_SESSION_STORE_VERSION ||
      !isNonEmpty(this.#durability.workerId) ||
      !Number.isFinite(this.#durability.leaseTtlMs) ||
      this.#durability.leaseTtlMs <= 0
    ) {
      throw new DacsError(
        "bundle durability requires a v2 fenced store, non-empty workerId, and positive leaseTtlMs",
      );
    }
    const mapping = provider.mapping;
    if (
      mapping === "write-input" &&
      (!this.#input.bindingSigner ||
        this.#input.bindingSigner.algorithm !== "ed25519" ||
        this.#input.bindingSigner.signer !== this.#input.seller.primaryClaim ||
        typeof this.#input.bindingSigner.sign !== "function")
    ) {
      throw new DacsError(
        "write-input durability requires the agreement seller's Ed25519 binding signer",
      );
    }
    const { verifiedListing: _verifiedListing, ...coreInput } = this.#input;
    const request = prepareCompletedSellerBundleCounterSignatureRequest(
      coreInput as FinalizeCompletedSellerBundleInput,
    );
    const jobId = this.#input.agreement.jobId;
    const agreementHash = this.#input.agreement.contentHash;
    if (!isNonEmpty(jobId) || !isHash(agreementHash)) {
      throw new DacsError("bundle durability requires a valid jobId and agreement hash");
    }

    let record = await this.#loadRecord();
    const verified = await this.#verifyFulfilmentSpine(record);
    this.#authority = clone(verified.binding);
    this.#inputData = {
      ...this.#authorityFields(),
      agreementHash,
      bundleContentHash: request.bundleContentHash,
      finalisedAt: this.#input.finalisedAt,
      mapping,
    };
    this.#counterData(sha256Hex(request.signedBytes), request.requiredCounterSigners);

    if (record.phase === "seller:finalised") {
      if (record.lease) throw new DacsError("terminal seller bundle state retains a lease");
      const retainedResult = this.#decodeTerminalBundle(record, mapping);
      this.#terminalResult = await verifyFinalizedSellerBundleReadOnly(
        this.verificationInput(),
        retainedResult,
        readOnlyProvider(provider),
      );
      return;
    }

    const marker = await this.#durability.store.bindSessionAuthorization({
      jobId,
      binding: clone(this.#authority),
      now: this.#now(),
    });
    if (!marker.ok) {
      throw new DacsError(`durable consumed-authorization verification failed: ${marker.reason}`);
    }
    record = clone(marker.record);
    const markerVerified = await this.#verifyFulfilmentSpine(record);
    if (canonicalize(markerVerified.binding) !== canonicalize(this.#authority)) {
      throw new DacsError("durable consumed authorization changed during marker recovery");
    }

    const acquired = await this.#durability.store.acquireLease({
      jobId,
      owner: this.#durability.workerId,
      ttlMs: this.#durability.leaseTtlMs,
      now: this.#now(),
    });
    if (!acquired.ok) {
      throw new SubstrateError(`seller bundle session lease unavailable: ${acquired.reason}`);
    }
    this.#leaseToken = {
      owner: acquired.lease.owner,
      generation: acquired.lease.generation,
    };
    const acquiredVerified = await this.#verifyFulfilmentSpine(clone(acquired.record));
    if (canonicalize(acquiredVerified.binding) !== canonicalize(this.#authority)) {
      throw new DacsError("durable consumed authorization changed during lease acquisition");
    }

    await this.#ensureOutcome(
      sellerBundleFinalizationCheckpointKey.input,
      this.#inputData,
      this.#inputData,
      "seller:bundle-signing",
      false,
    );
    for (const [role, data] of this.#counterSignatureData) {
      const claimed = await this.#claim(
        sellerBundleFinalizationCheckpointKey.signature(role),
        data,
        "seller:bundle-signing",
      );
      if (claimed.state === "outcome" && !dataMatches(claimed.data, data)) {
        throw new DacsError(`durable detached ${role} signature changed across retries`);
      }
    }
  }

  terminalResult(): FinalizedSellerBundle | undefined {
    return this.#terminalResult ? clone(this.#terminalResult) : undefined;
  }

  async #renew(): Promise<void> {
    if (!this.#leaseToken) throw new SubstrateError("durable bundle lease is unavailable");
    const renewed = await this.#durability.store.renewLease({
      jobId: this.#input.agreement.jobId,
      leaseToken: this.#leaseToken,
      ttlMs: this.#durability.leaseTtlMs,
      now: this.#now(),
    });
    if (!renewed.ok) throw new SubstrateError(`durable bundle lease is stale: ${renewed.reason}`);
  }

  #fence(idempotencyKey: string): Readonly<SellerBundleEffectFence> {
    if (!this.#leaseToken) throw new SubstrateError("durable bundle lease is unavailable");
    return Object.freeze({ ...this.#leaseToken, idempotencyKey });
  }

  async #effect<T>(
    idempotencyKey: string,
    operation: (fence: Readonly<SellerBundleEffectFence>) => Promise<T> | T,
  ): Promise<T> {
    await this.#renew();
    const fence = this.#fence(idempotencyKey);
    let heartbeat = Promise.resolve();
    let heartbeatError: unknown;
    const interval = Math.max(
      1,
      Math.min(30_000, Math.floor(this.#durability.leaseTtlMs / 3)),
    );
    const timer = setInterval(() => {
      heartbeat = heartbeat
        .then(() => this.#renew())
        .catch((error: unknown) => {
          heartbeatError ??= error;
        });
    }, interval);
    timer.unref();
    try {
      const result = await operation(fence);
      clearInterval(timer);
      await heartbeat;
      if (heartbeatError) throw heartbeatError;
      await this.#renew();
      return clone(result);
    } finally {
      clearInterval(timer);
    }
  }

  #phaseFor(record: SessionRecord, requested: string): string | undefined {
    const currentRank = BUNDLE_PHASE_RANK.get(record.phase);
    const requestedRank = BUNDLE_PHASE_RANK.get(requested);
    return currentRank !== undefined && requestedRank !== undefined && currentRank > requestedRank
      ? undefined
      : requested;
  }

  async #claim(
    key: string,
    data: Record<string, CheckpointValue>,
    requestedPhase: string,
  ): Promise<ClaimedBundleWal> {
    if (!this.#leaseToken) {
      const record = await this.#loadRecord();
      if (record.phase !== "seller:finalised") {
        throw new SubstrateError("durable bundle lease is unavailable");
      }
      const checkpoint = latestCheckpoint(record.checkpoints, key);
      if (checkpoint?.stage !== "outcome" || !checkpoint.data) {
        throw new DacsError(`terminal seller bundle state lacks outcome ${key}`);
      }
      return { state: "outcome", record, data: checkpoint.data };
    }
    await this.#renew();
    const current = await this.#loadRecord();
    const phase = this.#phaseFor(current, requestedPhase);
    const claimed = await this.#durability.store.claimCheckpoint({
      jobId: this.#input.agreement.jobId,
      key,
      data: clone(data),
      ...(phase ? { phase } : {}),
      leaseToken: this.#leaseToken,
      now: this.#now(),
    });
    if (claimed.ok) return { state: "fresh", record: claimed.record, data: clone(data) };
    if ((claimed.reason !== "held" && claimed.reason !== "completed") || !claimed.record) {
      throw new SubstrateError(`durable bundle claim ${key} failed: ${claimed.reason}`);
    }
    const checkpoint = latestCheckpoint(claimed.record.checkpoints, key);
    if (!checkpoint?.data) throw new DacsError(`durable bundle checkpoint ${key} is malformed`);
    if (claimed.reason === "held" && !dataMatches(checkpoint.data, data)) {
      throw new DacsError(`durable bundle checkpoint ${key} binds different content`);
    }
    return {
      state: claimed.reason === "completed" ? "outcome" : "intent",
      record: claimed.record,
      data: checkpoint.data,
    };
  }

  async #appendOutcome(
    key: string,
    intent: Record<string, CheckpointValue>,
    outcome: Record<string, CheckpointValue>,
    requestedPhase?: string,
  ): Promise<void> {
    if (!this.#leaseToken) throw new DacsError("terminal seller bundle state is immutable");
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      await this.#renew();
      const record = await this.#loadRecord();
      const prior = latestCheckpoint(record.checkpoints, key);
      if (prior?.stage === "outcome") {
        if (!dataMatches(prior.data, outcome)) {
          throw new DacsError(`durable bundle outcome ${key} contradicts verified state`);
        }
        return;
      }
      if (prior?.stage !== "intent" || !dataMatches(prior.data, intent)) {
        throw new DacsError(`durable bundle intent ${key} is missing or rebound`);
      }
      const phase = requestedPhase ? this.#phaseFor(record, requestedPhase) : undefined;
      const transitioned = await this.#durability.store.transition({
        jobId: this.#input.agreement.jobId,
        expectedRevision: record.revision,
        leaseToken: this.#leaseToken,
        ...(phase ? { phase } : {}),
        checkpoint: { key, stage: "outcome", data: clone(outcome) },
        now: this.#now(),
      });
      if (transitioned.ok) return;
      if (transitioned.reason !== "revision-mismatch") {
        throw new SubstrateError(`durable bundle outcome ${key} failed: ${transitioned.reason}`);
      }
    }
    throw new SubstrateError(`durable bundle outcome ${key} exceeded CAS retry limit`);
  }

  async #ensureOutcome(
    key: string,
    intent: Record<string, CheckpointValue>,
    outcome: Record<string, CheckpointValue>,
    requestedPhase: string,
    append = true,
  ): Promise<void> {
    const claimed = await this.#claim(key, intent, requestedPhase);
    if (claimed.state === "outcome") {
      if (!dataMatches(claimed.data, outcome)) {
        throw new DacsError(`durable bundle outcome ${key} contradicts verified state`);
      }
      return;
    }
    if (!dataMatches(claimed.data, intent)) {
      throw new DacsError(`durable bundle checkpoint ${key} binds different content`);
    }
    if (append) await this.#appendOutcome(key, intent, outcome, requestedPhase);
  }

  async sign(
    purpose: SellerBundleSignaturePurpose,
    role: SellerBundleFinalizationRole,
    signer: string,
    bytes: Uint8Array,
    ordinarySign: (
      fence: Readonly<SellerBundleEffectFence>,
    ) => Promise<Uint8Array | string> | Uint8Array | string,
  ): Promise<string> {
    const key = purpose === "bundle-binding"
      ? sellerBundleFinalizationCheckpointKey.bindingSignature
      : sellerBundleFinalizationCheckpointKey.signature(role);
    const messageHash = sha256Hex(bytes);
    const idempotencyKey = purpose === "bundle-binding"
      ? `bundle-binding-signature:${this.#authority!.fulfilmentId}`
      : `bundle-signature:${this.#authority!.fulfilmentId}:${role}:${messageHash}`;
    const intent = {
      ...this.#authorityFields(idempotencyKey),
      messageHash,
      signer,
      algorithm: "ed25519",
    };
    const phase = purpose === "bundle-binding"
      ? "seller:bundle-binding-signing"
      : "seller:bundle-signing";
    const claimed = await this.#claim(key, intent, phase);
    if (claimed.state === "outcome") {
      const { signatureValue, ...retainedIntent } = claimed.data;
      if (!dataMatches(retainedIntent, intent) || !isCanonicalBase64Url(signatureValue)) {
        throw new DacsError(`durable signature checkpoint ${key} is malformed or rebound`);
      }
      return signatureValue;
    }

    let value: Uint8Array | string;
    if (claimed.state === "fresh") {
      value = await this.#effect(idempotencyKey, ordinarySign);
    } else {
      let reconciliation: SellerBundleSignatureReconciliation;
      try {
        reconciliation = await this.#effect(idempotencyKey, (fence) =>
          this.#durability.reconcileSignature({
            purpose,
            role,
            signer,
            messageHash,
            signedBytes: new Uint8Array(bytes),
            fence,
          }),
        );
      } catch (error) {
        throw new SubstrateError(`durable signature reconciliation ${key} errored`, {
          cause: error,
        });
      }
      if (!validSignatureReconciliation(reconciliation)) {
        throw new SubstrateError(`durable signature reconciliation ${key} is malformed`);
      }
      if (reconciliation.disposition === "indeterminate") {
        throw new SubstrateError(
          `durable signature reconciliation ${key} is indeterminate: ${reconciliation.reason}`,
        );
      }
      value = reconciliation.disposition === "signed"
        ? reconciliation.value
        : await this.#effect(idempotencyKey, ordinarySign);
    }
    const signatureValue = normalizeSignature(value);
    await this.#appendOutcome(
      key,
      intent,
      { ...intent, signatureValue },
      phase,
    );
    return signatureValue;
  }

  async submitBundle(
    logicalAddress: string,
    bundle: Readonly<FinalizedSellerBundle["sellerBundle"]>,
    ordinarySubmit: (fence: Readonly<SellerBundleEffectFence>) => Promise<void> | void,
  ): Promise<void> {
    const bundleContentHash = attestationBundleHash(bundle);
    const idempotencyKey = `bundle-anchor:${this.#authority!.fulfilmentId}`;
    const intent = {
      ...this.#authorityFields(idempotencyKey),
      logicalAddress,
      bundleContentHash,
    };
    const key = sellerBundleFinalizationCheckpointKey.anchor;
    const claimed = await this.#claim(key, intent, "seller:bundle-anchor-pending");
    if (claimed.state === "outcome") {
      const { nativeAddress: _nativeAddress, ...retainedIntent } = claimed.data;
      if (!dataMatches(retainedIntent, intent)) {
        throw new DacsError("durable seller bundle anchor outcome is rebound");
      }
      return;
    }
    if (claimed.state === "fresh") {
      await this.#effect(idempotencyKey, ordinarySubmit);
      return;
    }

    let reconciliation: SellerBundleAnchorReconciliation;
    try {
      reconciliation = await this.#effect(idempotencyKey, (fence) =>
        this.#durability.reconcileBundleAnchor({
          logicalAddress,
          bundleContentHash,
          fence,
        }),
      );
    } catch (error) {
      throw new SubstrateError("durable seller bundle anchor reconciliation errored", {
        cause: error,
      });
    }
    if (!validAnchorReconciliation(reconciliation)) {
      throw new SubstrateError("durable seller bundle anchor reconciliation is malformed");
    }
    if (reconciliation.disposition === "present") return;
    if (reconciliation.disposition === "authoritatively-absent") {
      await this.#effect(idempotencyKey, ordinarySubmit);
      return;
    }
    if (reconciliation.disposition === "rejected") {
      throw new DacsError(
        `durable seller bundle anchor reconciliation rejected: ${reconciliation.reason}`,
      );
    }
    throw new SubstrateError(
      `durable seller bundle anchor reconciliation is indeterminate: ${reconciliation.reason}`,
    );
  }

  #bindingIntent(binding: Readonly<BundleBinding>): Record<string, CheckpointValue> {
    const idempotencyKey = `bundle-binding:${this.#authority!.fulfilmentId}`;
    return {
      ...this.#authorityFields(idempotencyKey),
      mapping: "write-input",
      logicalAddress: binding.logicalAddress,
      bundleContentHash: binding.bundleContentHash,
      bindingEnvelopeHash: sha256Hex(canonicalize(binding)),
    };
  }

  #sellerSignatureIntent(): Record<string, CheckpointValue> {
    if (!this.#bundleMessageHash || !this.#authority) {
      throw new DacsError("durable seller signature scope is unavailable");
    }
    const idempotencyKey =
      `bundle-signature:${this.#authority.fulfilmentId}:seller:${this.#bundleMessageHash}`;
    return {
      ...this.#authorityFields(idempotencyKey),
      messageHash: this.#bundleMessageHash,
      signer: this.#input.seller.primaryClaim,
      algorithm: "ed25519",
    };
  }

  #bindingSignatureIntent(binding: Readonly<BundleBinding>): Record<string, CheckpointValue> {
    if (!this.#authority) throw new DacsError("durable binding authority is unavailable");
    const unsigned = { ...binding };
    delete (unsigned as Partial<BundleBinding>).signature;
    const message = signedBytes(
      BUNDLE_BINDING_SEPARATOR,
      contentHash(unsigned as unknown as Record<string, unknown>),
    );
    return {
      ...this.#authorityFields(
        `bundle-binding-signature:${this.#authority.fulfilmentId}`,
      ),
      messageHash: sha256Hex(message),
      signer: binding.signer,
      algorithm: "ed25519",
    };
  }

  async publishBinding(
    binding: Readonly<BundleBinding>,
    ordinaryPublish: (
      fence: Readonly<SellerBundleEffectFence>,
    ) => Promise<SellerBundleBindingPublication> | SellerBundleBindingPublication,
  ): Promise<SellerBundleBindingPublication> {
    const intent = this.#bindingIntent(binding);
    const idempotencyKey = String(intent.idempotencyKey);
    const key = sellerBundleFinalizationCheckpointKey.bindingPublication;
    const claimed = await this.#claim(
      key,
      intent,
      "seller:bundle-binding-publication-pending",
    );
    if (claimed.state === "outcome") {
      const { applicable, ...retainedIntent } = claimed.data;
      if (!dataMatches(retainedIntent, intent) || applicable !== true) {
        throw new DacsError("durable BundleBinding publication outcome is rebound");
      }
      return { disposition: "published" };
    }
    if (claimed.state === "fresh") return this.#effect(idempotencyKey, ordinaryPublish);

    let reconciliation: SellerBundleBindingPublicationReconciliation;
    try {
      reconciliation = await this.#effect(idempotencyKey, (fence) =>
        this.#durability.reconcileBindingPublication(clone(binding), fence),
      );
    } catch (error) {
      throw new SubstrateError("durable BundleBinding publication reconciliation errored", {
        cause: error,
      });
    }
    if (!validBindingReconciliation(reconciliation)) {
      throw new SubstrateError("durable BundleBinding reconciliation is malformed");
    }
    if (reconciliation.disposition === "authoritatively-absent") {
      return this.#effect(idempotencyKey, ordinaryPublish);
    }
    return reconciliation;
  }

  wrapInput(): FinalizeCompletedSellerBundleInput {
    const originalSellerSigner = this.#input.seller.signer;
    const seller = {
      ...this.#input.seller,
      signer: async (bytes: Uint8Array) =>
        Buffer.from(
          await this.sign(
            "bundle",
            "seller",
            this.#input.seller.primaryClaim,
            bytes,
            (fence) => invokeBundleSigner(originalSellerSigner, bytes, fence),
          ),
          "base64url",
        ),
    };
    const { verifiedListing: _verifiedListing, ...coreInput } = this.#input;
    return {
      ...coreInput,
      seller,
      ...(this.#input.bindingSigner
        ? {
            bindingSigner: {
              algorithm: this.#input.bindingSigner.algorithm,
              signer: this.#input.bindingSigner.signer,
              sign: (bytes, context) =>
                this.sign(
                  "bundle-binding",
                  "seller",
                  context.signer,
                  bytes,
                  (fence) => this.#input.bindingSigner!.sign(
                    new Uint8Array(bytes),
                    clone(context),
                    fence,
                  ),
                ),
            },
          }
        : {}),
    } as FinalizeCompletedSellerBundleInput;
  }

  wrapProvider(
    provider: DurableSellerBundleFinalizationProvider,
  ): SellerBundleFinalizationProvider {
    const {
      submitSellerBundle: _submitSellerBundle,
      publishBundleBinding,
      ...baseProvider
    } = provider;
    return {
      ...baseProvider,
      submitSellerBundle: (logicalAddress, bundle) =>
        this.submitBundle(logicalAddress, bundle, (fence) =>
          provider.submitSellerBundle(logicalAddress, clone(bundle), fence),
        ),
      ...(publishBundleBinding
        ? {
            publishBundleBinding: (binding: Readonly<BundleBinding>) =>
              this.publishBinding(binding, (fence) =>
                publishBundleBinding(clone(binding), fence),
              ),
          }
        : {}),
    };
  }

  #resultIntent(
    result: FinalizedSellerBundle,
    mapping: SellerBundleFinalizationProvider["mapping"],
  ): Record<string, CheckpointValue> {
    return {
      ...this.#authorityFields(),
      mapping,
      bundleContentHash: result.bundleContentHash,
      logicalAddress: result.logicalAddress,
      nativeAddress: result.nativeAddress,
    };
  }

  #resultData(
    result: FinalizedSellerBundle,
    mapping: SellerBundleFinalizationProvider["mapping"],
  ): Record<string, CheckpointValue> {
    const encoded = encodeFinalizedResult(result);
    return {
      ...this.#resultIntent(result, mapping),
      resultHash: encoded.hash,
      result: encoded.encoded,
    };
  }

  #decodeTerminalBundle(
    record: SessionRecord,
    mapping: SellerBundleFinalizationProvider["mapping"],
  ): FinalizedSellerBundle {
    if (!this.#inputData) throw new DacsError("terminal bundle input binding is unavailable");
    const requiredOutcomes: Array<[string, Record<string, CheckpointValue>]> = [
      [sellerBundleFinalizationCheckpointKey.input, this.#inputData],
      ...[...this.#counterSignatureData].map(([role, data]) => [
        sellerBundleFinalizationCheckpointKey.signature(role),
        data,
      ] as [string, Record<string, CheckpointValue>]),
    ];
    for (const [key, expected] of requiredOutcomes) {
      const checkpoint = latestCheckpoint(record.checkpoints, key);
      if (checkpoint?.stage !== "outcome" || !dataMatches(checkpoint.data, expected)) {
        throw new DacsError(`terminal seller bundle state has incomplete checkpoint ${key}`);
      }
    }
    const resultCheckpoint = latestCheckpoint(
      record.checkpoints,
      sellerBundleFinalizationCheckpointKey.result,
    );
    if (resultCheckpoint?.stage !== "outcome" || !resultCheckpoint.data) {
      throw new DacsError("terminal seller bundle state lacks its exact result outcome");
    }
    const result = decodeFinalizedResult(
      resultCheckpoint.data.result,
      resultCheckpoint.data.resultHash,
      this.#input.agreement.jobId,
    );
    const expectedResult = this.#resultData(result, mapping);
    if (!dataMatches(resultCheckpoint.data, expectedResult)) {
      throw new DacsError("terminal seller bundle result contradicts its durable authority");
    }
    if (result.bundleContentHash !== this.#inputData.bundleContentHash) {
      throw new DacsError("terminal seller bundle result contradicts the current reviewed scope");
    }
    const sellerSignature = result.sellerBundle.signatures.find(
      (signature) => signature.party === this.#input.seller.primaryClaim,
    );
    const sellerIntent = this.#sellerSignatureIntent();
    const sellerCheckpoint = latestCheckpoint(
      record.checkpoints,
      sellerBundleFinalizationCheckpointKey.signature("seller"),
    );
    if (
      !sellerSignature ||
      sellerSignature.algorithm !== "ed25519" ||
      sellerCheckpoint?.stage !== "outcome" ||
      !dataMatches(sellerCheckpoint.data, {
        ...sellerIntent,
        signatureValue: sellerSignature.value,
      })
    ) {
      throw new DacsError("terminal seller bundle result lacks its seller-signature outcome");
    }
    for (const [role, data] of this.#counterSignatureData) {
      const retained = result.sellerBundle.signatures.find(
        (signature) => signature.party === data.signer,
      );
      if (
        !retained ||
        retained.algorithm !== data.algorithm ||
        retained.value !== data.signatureValue
      ) {
        throw new DacsError(`terminal seller bundle changed the detached ${role} signature`);
      }
    }
    const bindingSignatureCheckpoint = latestCheckpoint(
      record.checkpoints,
      sellerBundleFinalizationCheckpointKey.bindingSignature,
    );
    if (result.binding) {
      const bindingIntent = this.#bindingSignatureIntent(result.binding);
      if (
        result.binding.signature.algorithm !== "ed25519" ||
        bindingSignatureCheckpoint?.stage !== "outcome" ||
        !dataMatches(bindingSignatureCheckpoint.data, {
          ...bindingIntent,
          signatureValue: result.binding.signature.value,
        })
      ) {
        throw new DacsError("terminal seller bundle lacks its BundleBinding signature outcome");
      }
    } else if (bindingSignatureCheckpoint !== undefined) {
      throw new DacsError("pure terminal seller bundle carries a BundleBinding signature");
    }
    const receipt = record.receipts.find(
      (item) => sessionReceiptKey(item) === "bundle",
    );
    if (receipt?.ref !== result.nativeAddress) {
      throw new DacsError("terminal seller bundle result lacks its immutable bundle receipt");
    }
    const anchor = latestCheckpoint(
      record.checkpoints,
      sellerBundleFinalizationCheckpointKey.anchor,
    );
    const anchorIntent = {
      ...this.#authorityFields(`bundle-anchor:${this.#authority!.fulfilmentId}`),
      logicalAddress: result.logicalAddress,
      bundleContentHash: result.bundleContentHash,
    };
    if (
      anchor?.stage !== "outcome" ||
      !dataMatches(anchor.data, { ...anchorIntent, nativeAddress: result.nativeAddress })
    ) {
      throw new DacsError("terminal seller bundle result lacks its exact anchor outcome");
    }
    const publication = latestCheckpoint(
      record.checkpoints,
      sellerBundleFinalizationCheckpointKey.bindingPublication,
    );
    const publicationIntent = result.binding
      ? this.#bindingIntent(result.binding)
      : {
          ...this.#authorityFields(),
          mapping,
          logicalAddress: result.logicalAddress,
          bundleContentHash: result.bundleContentHash,
        };
    if (
      publication?.stage !== "outcome" ||
      !dataMatches(publication.data, {
        ...publicationIntent,
        applicable: result.binding !== undefined,
      })
    ) {
      throw new DacsError("terminal seller bundle result lacks its publication outcome");
    }
    return result;
  }

  async finish(
    result: FinalizedSellerBundle,
    mapping: SellerBundleFinalizationProvider["mapping"],
  ): Promise<void> {
    if (!this.#inputData || !this.#authority) {
      throw new DacsError("durable seller bundle coordinator is not initialized");
    }
    if (result.bundleContentHash !== this.#inputData.bundleContentHash) {
      throw new DacsError("finalized seller bundle changed the durably reviewed scope");
    }
    const sellerSignature = result.sellerBundle.signatures.find(
      (signature) => signature.party === this.#input.seller.primaryClaim,
    );
    const sellerSignatureIntent = this.#sellerSignatureIntent();
    if (
      !sellerSignature ||
      sellerSignature.algorithm !== "ed25519" ||
      !isCanonicalBase64Url(sellerSignature.value)
    ) {
      throw new DacsError("finalized seller bundle lacks its canonical seller signature");
    }
    await this.#ensureOutcome(
      sellerBundleFinalizationCheckpointKey.signature("seller"),
      sellerSignatureIntent,
      { ...sellerSignatureIntent, signatureValue: sellerSignature.value },
      "seller:bundle-signing",
    );
    for (const [role, data] of this.#counterSignatureData) {
      const retained = result.sellerBundle.signatures.find(
        (signature) => signature.party === data.signer,
      );
      if (
        !retained ||
        retained.algorithm !== data.algorithm ||
        retained.value !== data.signatureValue
      ) {
        throw new DacsError(`finalized seller bundle changed the detached ${role} signature`);
      }
    }
    if (result.binding) {
      const bindingSignatureIntent = this.#bindingSignatureIntent(result.binding);
      if (
        result.binding.signature.signer !== result.binding.signer ||
        result.binding.signature.algorithm !== "ed25519" ||
        !isCanonicalBase64Url(result.binding.signature.value)
      ) {
        throw new DacsError("finalized BundleBinding changed its seller signature envelope");
      }
      await this.#ensureOutcome(
        sellerBundleFinalizationCheckpointKey.bindingSignature,
        bindingSignatureIntent,
        {
          ...bindingSignatureIntent,
          signatureValue: result.binding.signature.value,
        },
        "seller:bundle-binding-signing",
      );
    }
    const anchorIntent = {
      ...this.#authorityFields(`bundle-anchor:${this.#authority.fulfilmentId}`),
      logicalAddress: result.logicalAddress,
      bundleContentHash: result.bundleContentHash,
    };
    await this.#ensureOutcome(
      sellerBundleFinalizationCheckpointKey.anchor,
      anchorIntent,
      { ...anchorIntent, nativeAddress: result.nativeAddress },
      "seller:bundle-anchor-pending",
    );

    const publicationIntent: Record<string, CheckpointValue> = result.binding
      ? this.#bindingIntent(result.binding)
      : {
          ...this.#authorityFields(),
          mapping,
          logicalAddress: result.logicalAddress,
          bundleContentHash: result.bundleContentHash,
        };
    await this.#ensureOutcome(
      sellerBundleFinalizationCheckpointKey.bindingPublication,
      publicationIntent,
      { ...publicationIntent, applicable: result.binding !== undefined },
      result.binding
        ? "seller:bundle-binding-publication-pending"
        : "seller:bundle-anchor-pending",
    );
    for (const [role, data] of this.#counterSignatureData) {
      await this.#ensureOutcome(
        sellerBundleFinalizationCheckpointKey.signature(role),
        data,
        data,
        "seller:bundle-signing",
      );
    }
    await this.#ensureOutcome(
      sellerBundleFinalizationCheckpointKey.input,
      this.#inputData,
      this.#inputData,
      "seller:bundle-signing",
    );

    const resultIntent = this.#resultIntent(result, mapping);
    const resultData = this.#resultData(result, mapping);
    const resultClaim = await this.#claim(
      sellerBundleFinalizationCheckpointKey.result,
      resultIntent,
      result.binding
        ? "seller:bundle-binding-publication-pending"
        : "seller:bundle-anchor-pending",
    );
    if (resultClaim.state === "outcome") {
      throw new DacsError("non-terminal seller bundle state already carries a terminal result");
    }
    if (!dataMatches(resultClaim.data, resultIntent)) {
      throw new DacsError("durable terminal seller bundle intent is rebound");
    }

    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      await this.#renew();
      const record = await this.#loadRecord();
      const prior = latestCheckpoint(
        record.checkpoints,
        sellerBundleFinalizationCheckpointKey.result,
      );
      if (prior?.stage !== "intent" || !dataMatches(prior.data, resultIntent)) {
        throw new DacsError("durable terminal seller bundle intent disappeared or changed");
      }
      if (record.receipts.some((receipt) => sessionReceiptKey(receipt) === "bundle")) {
        throw new DacsError("non-terminal seller bundle state already carries a bundle receipt");
      }
      const transitioned = await this.#durability.store.transition({
        jobId: this.#input.agreement.jobId,
        expectedRevision: record.revision,
        leaseToken: this.#leaseToken,
        checkpoint: {
          key: sellerBundleFinalizationCheckpointKey.result,
          stage: "outcome",
          data: clone(resultData),
        },
        receipt: { kind: "bundle", ref: result.nativeAddress },
        phase: "seller:finalised",
        lease: null,
        now: this.#now(),
      });
      if (transitioned.ok) {
        this.#leaseToken = undefined;
        this.#terminalResult = clone(result);
        return;
      }
      if (transitioned.reason !== "revision-mismatch") {
        throw new SubstrateError(
          `durable seller bundle final status failed: ${transitioned.reason}`,
        );
      }
    }
    throw new SubstrateError("durable seller bundle final status exceeded CAS retry limit");
  }

  async releaseAfterFailure(): Promise<void> {
    const token = this.#leaseToken;
    if (!token) return;
    try {
      for (let attempt = 0; attempt < MAX_LEASE_RELEASE_ATTEMPTS; attempt += 1) {
        const record = await this.#loadRecord();
        if (
          record.phase === "seller:finalised" ||
          record.lease?.owner !== token.owner ||
          record.lease.generation !== token.generation
        ) {
          return;
        }
        const transitioned = await this.#durability.store.transition({
          jobId: this.#input.agreement.jobId,
          expectedRevision: record.revision,
          leaseToken: token,
          lease: null,
          now: this.#now(),
        });
        if (transitioned.ok) {
          this.#leaseToken = undefined;
          return;
        }
        if (transitioned.reason !== "revision-mismatch") return;
      }
    } catch {
      // Preserve the protocol error; a failed exact-token release expires by lease TTL.
    }
  }
}

function captureStore(store: FencedSessionStoreV2): FencedSessionStoreV2 {
  const apiVersion = store.apiVersion;
  const create = store.create;
  const load = store.load;
  const transition = store.transition;
  const claimCheckpoint = store.claimCheckpoint;
  const acquireLease = store.acquireLease;
  const renewLease = store.renewLease;
  const bindSessionAuthorization = store.bindSessionAuthorization;
  const bindHash = store.bindHash;
  const list = store.list;
  if (
    apiVersion !== FENCED_SESSION_STORE_VERSION ||
    [
      create,
      load,
      transition,
      claimCheckpoint,
      acquireLease,
      renewLease,
      bindSessionAuthorization,
      bindHash,
      list,
    ].some((candidate) => typeof candidate !== "function")
  ) {
    throw new TypeError("bundle durability requires a callable generation-fenced store v2");
  }
  const bind = <T extends Function>(callback: T): T =>
    Function.prototype.bind.call(callback, store) as T;
  const capturedCreate = bind(create);
  const capturedLoad = bind(load);
  const capturedTransition = bind(transition);
  const capturedClaim = bind(claimCheckpoint);
  const capturedAcquire = bind(acquireLease);
  const capturedRenew = bind(renewLease);
  const capturedAuthorization = bind(bindSessionAuthorization);
  const capturedHash = bind(bindHash);
  const capturedList = bind(list);
  const captured: FencedSessionStoreV2 = {
    apiVersion,
    create: async (input) => clone(await capturedCreate(clone(input))),
    load: async (jobId) => clone(await capturedLoad(jobId)),
    transition: async (input) => clone(await capturedTransition(clone(input))),
    claimCheckpoint: async (input) => clone(await capturedClaim(clone(input))),
    acquireLease: async (input) => clone(await capturedAcquire(clone(input))),
    renewLease: async (input) => clone(await capturedRenew(clone(input))),
    bindSessionAuthorization: async (input) =>
      clone(await capturedAuthorization(clone(input))),
    bindHash: async (input) => clone(await capturedHash(clone(input))),
    list: async (filter) =>
      clone(await capturedList(filter === undefined ? undefined : clone(filter))),
  };
  return Object.freeze(captured);
}

function captureDurability(
  durability: SellerBundleFinalizationDurability,
): SellerBundleFinalizationDurability {
  const leaseNowMs = durability.leaseNowMs;
  const terminalVerification = durability.terminalVerification;
  const verifyEvidenceSignature = terminalVerification?.verifyEvidenceSignature;
  const verifyAuditSourceCommitmentSignature =
    terminalVerification?.verifyAuditSourceCommitmentSignature;
  const verifyAnchorReceipt = terminalVerification?.verifyAnchorReceipt;
  const reconcileSignature = durability.reconcileSignature;
  const reconcileBundleAnchor = durability.reconcileBundleAnchor;
  const reconcileBindingPublication = durability.reconcileBindingPublication;
  if (
    (leaseNowMs !== undefined && typeof leaseNowMs !== "function") ||
    typeof verifyEvidenceSignature !== "function" ||
    typeof verifyAuditSourceCommitmentSignature !== "function" ||
    typeof verifyAnchorReceipt !== "function" ||
    typeof reconcileSignature !== "function" ||
    typeof reconcileBundleAnchor !== "function" ||
    typeof reconcileBindingPublication !== "function"
  ) {
    throw new TypeError("bundle durability has a non-callable verification or recovery adapter");
  }
  const bind = <T extends Function>(callback: T, owner: unknown): T =>
    Function.prototype.bind.call(callback, owner) as T;
  const captured: SellerBundleFinalizationDurability = {
    store: captureStore(durability.store),
    workerId: durability.workerId,
    leaseTtlMs: durability.leaseTtlMs,
    ...(leaseNowMs ? { leaseNowMs: bind(leaseNowMs, durability) } : {}),
    terminalVerification: Object.freeze({
      verifyEvidenceSignature: bind(verifyEvidenceSignature, terminalVerification),
      verifyAuditSourceCommitmentSignature: bind(
        verifyAuditSourceCommitmentSignature,
        terminalVerification,
      ),
      verifyAnchorReceipt: bind(verifyAnchorReceipt, terminalVerification),
    }),
    reconcileSignature: bind(reconcileSignature, durability),
    reconcileBundleAnchor: bind(reconcileBundleAnchor, durability),
    reconcileBindingPublication: bind(reconcileBindingPublication, durability),
  };
  return Object.freeze(captured);
}

function captureInput(
  input: FinalizeCompletedSellerBundleDurableInput,
): FinalizeCompletedSellerBundleDurableInput {
  const { seller, bindingSigner, ...data } = input;
  const { signer: sellerSigner, ...sellerIdentity } = seller;
  const capturedSellerSigner = sellerSigner instanceof Uint8Array
    ? new Uint8Array(sellerSigner)
    : sellerSigner;
  const captured: FinalizeCompletedSellerBundleDurableInput = {
    ...clone(data),
    seller: {
      ...clone(sellerIdentity),
      signer: capturedSellerSigner,
    },
    ...(bindingSigner
      ? {
          bindingSigner: {
            algorithm: bindingSigner.algorithm,
            signer: bindingSigner.signer,
            sign: bindingSigner.sign,
          },
        }
      : {}),
  };
  return Object.freeze(captured);
}

function captureProvider(
  provider: DurableSellerBundleFinalizationProvider,
): DurableSellerBundleFinalizationProvider {
  const mapping = provider.mapping;
  const bundleCopyVerifier = provider.bundleCopyVerifier;
  const compositeVerificationDeps = provider.compositeVerificationDeps;
  const resolveDependency = provider.resolveDependency;
  const verifyDependencyReceipt = provider.verifyDependencyReceipt;
  const verifyDependencyBinding = provider.verifyDependencyBinding;
  const verifyListingPublisherIdentityLinkage =
    provider.verifyListingPublisherIdentityLinkage;
  const verifyVetRequirementProvenance = provider.verifyVetRequirementProvenance;
  const verifyPayloadMethodProof = provider.verifyPayloadMethodProof;
  const verifyPayloadMethodTransaction = provider.verifyPayloadMethodTransaction;
  const resolvePaymentPhaseIndex = provider.resolvePaymentPhaseIndex;
  const resolveSellerBundle = provider.resolveSellerBundle;
  const submitSellerBundle = provider.submitSellerBundle;
  const verifyBundleAnchorReceipt = provider.verifyBundleAnchorReceipt;
  const resolveBundleBinding = provider.resolveBundleBinding;
  const publishBundleBinding = provider.publishBundleBinding;
  const verifyBundleBinding = provider.verifyBundleBinding;
  if (
    (mapping !== "pure" && mapping !== "write-input") ||
    [
      resolveDependency,
      verifyDependencyReceipt,
      verifyDependencyBinding,
      verifyListingPublisherIdentityLinkage,
      verifyVetRequirementProvenance,
      resolveSellerBundle,
      submitSellerBundle,
      verifyBundleAnchorReceipt,
    ].some((candidate) => typeof candidate !== "function") ||
    [
      verifyPayloadMethodProof,
      verifyPayloadMethodTransaction,
      resolvePaymentPhaseIndex,
      resolveBundleBinding,
      publishBundleBinding,
      verifyBundleBinding,
    ].some((candidate) => candidate !== undefined && typeof candidate !== "function") ||
    (mapping === "write-input" &&
      (typeof resolveBundleBinding !== "function" ||
        typeof publishBundleBinding !== "function")) ||
    !bundleCopyVerifier ||
    typeof bundleCopyVerifier.resolvePublicKey !== "function" ||
    typeof bundleCopyVerifier.verify !== "function" ||
    !isRecord(compositeVerificationDeps) ||
    typeof compositeVerificationDeps.resolveRecipe !== "function" ||
    typeof compositeVerificationDeps.isRecipeSignerAuthorized !== "function" ||
    typeof compositeVerificationDeps.isVerifyResultSignerAuthorized !== "function" ||
    typeof compositeVerificationDeps.resolvePublicKey !== "function" ||
    typeof compositeVerificationDeps.verify !== "function" ||
    typeof compositeVerificationDeps.verifyAuthorityAttestation !== "function" ||
    (compositeVerificationDeps.verifyRequirementParameters !== undefined &&
      typeof compositeVerificationDeps.verifyRequirementParameters !== "function")
  ) {
    throw new TypeError("bundle provider is incomplete or has a non-callable adapter");
  }
  const bind = <T extends Function>(callback: T, owner: unknown): T =>
    Function.prototype.bind.call(callback, owner) as T;
  const captured: DurableSellerBundleFinalizationProvider = {
    mapping,
    bundleCopyVerifier: Object.freeze({
      resolvePublicKey: bind(bundleCopyVerifier.resolvePublicKey, bundleCopyVerifier),
      verify: bind(bundleCopyVerifier.verify, bundleCopyVerifier),
    }),
    compositeVerificationDeps: Object.freeze({
      resolveRecipe: bind(
        compositeVerificationDeps.resolveRecipe,
        compositeVerificationDeps,
      ),
      isRecipeSignerAuthorized: bind(
        compositeVerificationDeps.isRecipeSignerAuthorized,
        compositeVerificationDeps,
      ),
      isVerifyResultSignerAuthorized: bind(
        compositeVerificationDeps.isVerifyResultSignerAuthorized,
        compositeVerificationDeps,
      ),
      resolvePublicKey: bind(
        compositeVerificationDeps.resolvePublicKey,
        compositeVerificationDeps,
      ),
      verify: bind(compositeVerificationDeps.verify, compositeVerificationDeps),
      verifyAuthorityAttestation: bind(
        compositeVerificationDeps.verifyAuthorityAttestation,
        compositeVerificationDeps,
      ),
      ...(compositeVerificationDeps.verifyRequirementParameters
        ? {
            verifyRequirementParameters: bind(
              compositeVerificationDeps.verifyRequirementParameters,
              compositeVerificationDeps,
            ),
          }
        : {}),
    }),
    resolveDependency: bind(resolveDependency, provider),
    verifyDependencyReceipt: bind(verifyDependencyReceipt, provider),
    verifyDependencyBinding: bind(verifyDependencyBinding, provider),
    verifyListingPublisherIdentityLinkage: bind(
      verifyListingPublisherIdentityLinkage,
      provider,
    ),
    verifyVetRequirementProvenance: bind(verifyVetRequirementProvenance, provider),
    ...(verifyPayloadMethodProof
      ? { verifyPayloadMethodProof: bind(verifyPayloadMethodProof, provider) }
      : {}),
    ...(verifyPayloadMethodTransaction
      ? {
          verifyPayloadMethodTransaction: bind(
            verifyPayloadMethodTransaction,
            provider,
          ),
        }
      : {}),
    ...(resolvePaymentPhaseIndex
      ? { resolvePaymentPhaseIndex: bind(resolvePaymentPhaseIndex, provider) }
      : {}),
    resolveSellerBundle: bind(resolveSellerBundle, provider),
    submitSellerBundle: bind(submitSellerBundle, provider),
    verifyBundleAnchorReceipt: bind(verifyBundleAnchorReceipt, provider),
    ...(resolveBundleBinding
      ? { resolveBundleBinding: bind(resolveBundleBinding, provider) }
      : {}),
    ...(publishBundleBinding
      ? { publishBundleBinding: bind(publishBundleBinding, provider) }
      : {}),
    ...(verifyBundleBinding
      ? { verifyBundleBinding: bind(verifyBundleBinding, provider) }
      : {}),
  };
  return Object.freeze(captured);
}

function readOnlyProvider(
  provider: SellerBundleFinalizationProvider,
): SellerBundleFinalizationReadProvider {
  const {
    submitSellerBundle: _submitSellerBundle,
    publishBundleBinding: _publishBundleBinding,
    ...readProvider
  } = provider;
  return Object.freeze(readProvider);
}

/**
 * Restart-safe wrapper for `finalizeCompletedSellerBundleCore` (#55). It requires
 * the exact completed #121 durable handoff and adds generation-fenced bundle WAL
 * entries without changing any normative DACS wire shape.
 */
export async function finalizeCompletedSellerBundleDurable(
  input: FinalizeCompletedSellerBundleDurableInput,
  provider: DurableSellerBundleFinalizationProvider,
  durability: SellerBundleFinalizationDurability,
): Promise<FinalizedSellerBundle> {
  const capturedProvider = captureProvider(provider);
  const coordinator = new DurableBundleCoordinator(
    captureInput(input),
    captureDurability(durability),
  );
  try {
    const wrappedProvider = coordinator.wrapProvider(capturedProvider);
    await coordinator.initialize(wrappedProvider);
    const terminal = coordinator.terminalResult();
    if (terminal) return terminal;
    const wrappedInput = coordinator.wrapInput();
    const result = await finalizeCompletedSellerBundleCore(
      wrappedInput,
      wrappedProvider,
    );
    const authenticatedResult = await verifyFinalizedSellerBundleReadOnly(
      coordinator.verificationInput(),
      result,
      readOnlyProvider(wrappedProvider),
    );
    await coordinator.finish(authenticatedResult, capturedProvider.mapping);
    return clone(authenticatedResult);
  } catch (error) {
    await coordinator.releaseAfterFailure();
    throw error;
  }
}

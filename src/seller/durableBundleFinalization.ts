import { ed25519Sign, privateKeyFromSeed } from "../crypto/index.js";
import { contentHash, sha256Hex } from "../canonical/index.js";
import { DacsError, SubstrateError } from "../errors.js";
import {
  isCanonicalBase64Url,
  type BundleBinding,
} from "../artifacts/index.js";
import {
  attestationBundleHash,
  type SessionParty,
} from "../agent/twoSidedBundle.js";
import type {
  CheckpointValue,
  SessionCheckpoint,
  SessionReceipt,
  SessionStore,
} from "../agent/sessionStore.js";
import {
  finalizeCompletedSellerBundleCore,
  type FinalizeCompletedSellerBundleInput,
  type FinalizedSellerBundle,
  type SellerBundleBindingPublication,
  type SellerBundleFinalizationProvider,
} from "./bundleFinalization.js";

type SessionSigner = NonNullable<SessionParty["signer"]>;
export type SellerBundleFinalizationRole = "buyer" | "seller" | "orchestrator";
export type SellerBundleSignaturePurpose = "bundle" | "bundle-binding";

export const sellerBundleFinalizationCheckpointKey = {
  signature: (role: SellerBundleFinalizationRole) =>
    `seller:bundle-signature:${role}`,
  anchor: "seller:bundle-anchor:seller",
  bindingSignature: "seller:bundle-binding-signature:seller",
  bindingPublication: "seller:bundle-binding-publication:seller",
} as const;

export type SellerBundleSignatureReconciliation =
  | { disposition: "signed"; value: Uint8Array | string }
  | { disposition: "safe-to-sign" }
  | { disposition: "indeterminate"; reason: string };

export type SellerBundleAnchorReconciliation =
  | { disposition: "present" }
  | { disposition: "safe-to-submit" }
  | { disposition: "rejected"; reason: string }
  | { disposition: "indeterminate"; reason: string };

export type SellerBundleBindingPublicationReconciliation =
  | SellerBundleBindingPublication
  | { disposition: "safe-to-publish" };

/**
 * Recovery-only callbacks are deliberately separate from ordinary sign/write
 * callbacks. They run only when a durable intent exists without its outcome.
 */
export interface SellerBundleFinalizationDurability {
  store: SessionStore;
  workerId: string;
  leaseTtlMs: number;
  reconcileSignature: (input: {
    purpose: SellerBundleSignaturePurpose;
    role: SellerBundleFinalizationRole;
    signer: string;
    messageHash: string;
    signedBytes: Uint8Array;
  }) =>
    | Promise<SellerBundleSignatureReconciliation>
    | SellerBundleSignatureReconciliation;
  reconcileBundleAnchor: (input: {
    logicalAddress: string;
    bundleContentHash: string;
  }) =>
    | Promise<SellerBundleAnchorReconciliation>
    | SellerBundleAnchorReconciliation;
  reconcileBindingPublication: (
    binding: Readonly<BundleBinding>,
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
      lease?: { owner: string; expiresAt: number };
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
  return (
    actual !== undefined &&
    Object.entries(expected).every(([key, value]) => actual[key] === value)
  );
}

function normalizeSignature(value: Uint8Array | string): string {
  const encoded =
    typeof value === "string" ? value : Buffer.from(value).toString("base64url");
  if (!isCanonicalBase64Url(encoded)) {
    throw new DacsError("durable signer returned a non-canonical Base64URL signature");
  }
  return encoded;
}

async function invokeBundleSigner(
  signer: SessionSigner,
  bytes: Uint8Array,
): Promise<Uint8Array> {
  if (typeof signer === "function") return await signer(bytes);
  return ed25519Sign(
    bytes,
    signer instanceof Uint8Array ? privateKeyFromSeed(signer) : signer,
  );
}

/** Stable status projection over the public SessionStore. */
export async function getSellerBundleFinalizationStatus(
  store: SessionStore,
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

class DurableBundleCoordinator {
  readonly #input: FinalizeCompletedSellerBundleInput;
  readonly #durability: SellerBundleFinalizationDurability;

  constructor(
    input: FinalizeCompletedSellerBundleInput,
    durability: SellerBundleFinalizationDurability,
  ) {
    this.#input = input;
    this.#durability = durability;
  }

  async initialize(): Promise<void> {
    if (
      !isNonEmpty(this.#durability.workerId) ||
      !Number.isFinite(this.#durability.leaseTtlMs) ||
      this.#durability.leaseTtlMs <= 0
    ) {
      throw new DacsError(
        "bundle durability requires a non-empty workerId and positive leaseTtlMs",
      );
    }
    const jobId = this.#input.agreement.jobId;
    const agreementHash = this.#input.agreement.contentHash;
    if (!isNonEmpty(jobId) || !isHash(agreementHash)) {
      throw new DacsError("bundle durability requires a valid jobId and agreement hash");
    }
    let loaded = await this.#durability.store.load(jobId);
    if (loaded.status === "missing") {
      try {
        await this.#durability.store.create({
          jobId,
          agreementHash,
          phase: "seller:audit-pending",
        });
      } catch {
        // A concurrent creator may have won; the load below authenticates its binding.
      }
      loaded = await this.#durability.store.load(jobId);
    }
    if (loaded.status !== "ok") {
      throw new SubstrateError(
        loaded.status === "unsupported"
          ? `seller bundle state uses unsupported store version ${loaded.version}`
          : loaded.status === "corrupt"
            ? `seller bundle state is corrupt: ${loaded.reason}`
            : "seller bundle state could not be created",
      );
    }
    if (
      loaded.record.agreementHash !== undefined &&
      loaded.record.agreementHash !== agreementHash
    ) {
      throw new DacsError("seller bundle state is bound to a different agreement hash");
    }
    const bound = await this.#durability.store.bindHash({
      hash: agreementHash,
      jobId,
      kind: "agreement",
    });
    if (!bound.ok) {
      throw new DacsError(`agreement hash is already bound to ${bound.boundTo}`);
    }
    const lease = await this.#durability.store.acquireLease({
      jobId,
      owner: this.#durability.workerId,
      ttlMs: this.#durability.leaseTtlMs,
    });
    if (!lease.ok) {
      throw new SubstrateError("seller bundle session lease is held by another worker");
    }
  }

  async #loadRecord() {
    const loaded = await this.#durability.store.load(this.#input.agreement.jobId);
    if (loaded.status !== "ok") {
      throw new SubstrateError(`durable seller bundle state became ${loaded.status}`);
    }
    return loaded.record;
  }

  async #claim(
    key: string,
    data: Record<string, CheckpointValue>,
    phase: string,
  ) {
    const claimed = await this.#durability.store.claimCheckpoint({
      jobId: this.#input.agreement.jobId,
      key,
      data,
      phase,
      owner: this.#durability.workerId,
    });
    if (claimed.ok) return { state: "fresh" as const, record: claimed.record };
    if (
      (claimed.reason === "held" || claimed.reason === "completed") &&
      claimed.record
    ) {
      return { state: claimed.reason, record: claimed.record } as const;
    }
    throw new SubstrateError(`durable bundle claim ${key} failed: ${claimed.reason}`);
  }

  async #appendCheckpoint(
    checkpoint: SessionCheckpoint,
    phase?: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const record = await this.#loadRecord();
      const transitioned = await this.#durability.store.transition({
        jobId: this.#input.agreement.jobId,
        expectedRevision: record.revision,
        owner: this.#durability.workerId,
        ...(phase ? { phase } : {}),
        checkpoint,
      });
      if (transitioned.ok) return;
      if (transitioned.reason !== "revision-mismatch") {
        throw new SubstrateError(
          `durable bundle checkpoint ${checkpoint.key} failed: ${transitioned.reason}`,
        );
      }
    }
    throw new SubstrateError(
      `durable bundle checkpoint ${checkpoint.key} exceeded CAS retry limit`,
    );
  }

  async #ensureOutcome(
    key: string,
    intent: Record<string, CheckpointValue>,
    outcome: Record<string, CheckpointValue>,
  ): Promise<void> {
    const claimed = await this.#claim(key, intent, "seller:audit-pending");
    const prior = latestCheckpoint(claimed.record.checkpoints, key);
    if (!dataMatches(prior?.data, intent)) {
      throw new DacsError(`durable bundle checkpoint ${key} binds different content`);
    }
    if (claimed.state === "completed") {
      if (!dataMatches(prior?.data, outcome)) {
        throw new DacsError(`durable bundle outcome ${key} contradicts verified state`);
      }
      return;
    }
    await this.#appendCheckpoint({ key, stage: "outcome", data: outcome });
  }

  async #recordReceipt(receipt: SessionReceipt): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const record = await this.#loadRecord();
      const existing = record.receipts.find((item) => item.kind === receipt.kind);
      if (existing) {
        if (existing.ref !== receipt.ref) {
          throw new DacsError(
            `durable ${receipt.kind} receipt conflicts with ${existing.ref}`,
          );
        }
        return;
      }
      const transitioned = await this.#durability.store.transition({
        jobId: this.#input.agreement.jobId,
        expectedRevision: record.revision,
        owner: this.#durability.workerId,
        receipt,
      });
      if (transitioned.ok) return;
      if (transitioned.reason !== "revision-mismatch") {
        throw new SubstrateError(
          `durable ${receipt.kind} receipt failed: ${transitioned.reason}`,
        );
      }
    }
    throw new SubstrateError(
      `durable ${receipt.kind} receipt exceeded CAS retry limit`,
    );
  }

  async sign(
    purpose: SellerBundleSignaturePurpose,
    role: SellerBundleFinalizationRole,
    signer: string,
    bytes: Uint8Array,
    ordinarySign: () => Promise<Uint8Array | string> | Uint8Array | string,
  ): Promise<string> {
    const key =
      purpose === "bundle-binding"
        ? sellerBundleFinalizationCheckpointKey.bindingSignature
        : sellerBundleFinalizationCheckpointKey.signature(role);
    const messageHash = sha256Hex(bytes);
    const intent = { messageHash, signer };
    const claimed = await this.#claim(key, intent, "seller:bundle-signing");
    const prior = latestCheckpoint(claimed.record.checkpoints, key);
    if (!dataMatches(prior?.data, intent)) {
      throw new DacsError(`durable signature checkpoint ${key} binds different bytes/signer`);
    }
    if (claimed.state === "completed") {
      const signatureValue = prior?.data?.signatureValue;
      if (!isCanonicalBase64Url(signatureValue)) {
        throw new DacsError(`durable signature checkpoint ${key} is malformed`);
      }
      return signatureValue;
    }

    let value: Uint8Array | string;
    if (claimed.state === "fresh") {
      value = await ordinarySign();
    } else {
      let reconciliation: SellerBundleSignatureReconciliation;
      try {
        reconciliation = await this.#durability.reconcileSignature({
          purpose,
          role,
          signer,
          messageHash,
          signedBytes: bytes,
        });
      } catch (error) {
        throw new SubstrateError(`durable signature reconciliation ${key} errored`, {
          cause: error,
        });
      }
      if (reconciliation.disposition === "indeterminate") {
        throw new SubstrateError(
          `durable signature reconciliation ${key} is indeterminate: ${reconciliation.reason}`,
        );
      }
      value =
        reconciliation.disposition === "signed"
          ? reconciliation.value
          : await ordinarySign();
    }
    const signatureValue = normalizeSignature(value);
    await this.#appendCheckpoint({
      key,
      stage: "outcome",
      data: { ...intent, signatureValue },
    });
    return signatureValue;
  }

  async submitBundle(
    logicalAddress: string,
    bundle: Readonly<FinalizedSellerBundle["sellerBundle"]>,
    ordinarySubmit: () => Promise<void> | void,
  ): Promise<void> {
    const bundleContentHash = attestationBundleHash(bundle);
    const intent = { logicalAddress, bundleContentHash };
    const key = sellerBundleFinalizationCheckpointKey.anchor;
    const claimed = await this.#claim(key, intent, "seller:bundle-anchor-pending");
    const prior = latestCheckpoint(claimed.record.checkpoints, key);
    if (!dataMatches(prior?.data, intent)) {
      throw new DacsError("durable seller bundle anchor binds different content");
    }
    if (claimed.state === "fresh") {
      await ordinarySubmit();
      return;
    }

    let reconciliation: SellerBundleAnchorReconciliation;
    try {
      reconciliation = await this.#durability.reconcileBundleAnchor(intent);
    } catch (error) {
      throw new SubstrateError("durable seller bundle anchor reconciliation errored", {
        cause: error,
      });
    }
    if (reconciliation.disposition === "present") return;
    if (reconciliation.disposition === "safe-to-submit") {
      await ordinarySubmit();
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

  async publishBinding(
    binding: Readonly<BundleBinding>,
    ordinaryPublish: () =>
      | Promise<SellerBundleBindingPublication>
      | SellerBundleBindingPublication,
  ): Promise<SellerBundleBindingPublication> {
    const bindingHash = contentHash(binding as unknown as Record<string, unknown>);
    const intent = {
      mapping: "write-input",
      logicalAddress: binding.logicalAddress,
      bundleContentHash: binding.bundleContentHash,
      bindingHash,
    };
    const key = sellerBundleFinalizationCheckpointKey.bindingPublication;
    const claimed = await this.#claim(
      key,
      intent,
      "seller:bundle-binding-publication-pending",
    );
    const prior = latestCheckpoint(claimed.record.checkpoints, key);
    if (!dataMatches(prior?.data, intent)) {
      throw new DacsError("durable BundleBinding publication binds different content");
    }
    if (claimed.state === "fresh") return ordinaryPublish();

    let reconciliation: SellerBundleBindingPublicationReconciliation;
    try {
      reconciliation = await this.#durability.reconcileBindingPublication(binding);
    } catch (error) {
      throw new SubstrateError("durable BundleBinding publication reconciliation errored", {
        cause: error,
      });
    }
    if (reconciliation.disposition === "safe-to-publish") return ordinaryPublish();
    return reconciliation;
  }

  wrapInput(): FinalizeCompletedSellerBundleInput {
    const wrapParty = (
      role: SellerBundleFinalizationRole,
      party: SessionParty,
    ): SessionParty => {
      if (!party.signer) return party;
      const original = party.signer;
      return {
        ...party,
        signer: async (bytes) =>
          Buffer.from(
            await this.sign(
              "bundle",
              role,
              party.primaryClaim,
              bytes,
              () => invokeBundleSigner(original, bytes),
            ),
            "base64url",
          ),
      };
    };
    return {
      ...this.#input,
      buyer: wrapParty("buyer", this.#input.buyer),
      seller: wrapParty("seller", this.#input.seller),
      ...(this.#input.orchestrator
        ? {
            orchestrator: wrapParty(
              "orchestrator",
              this.#input.orchestrator,
            ) as FinalizeCompletedSellerBundleInput["orchestrator"],
          }
        : {}),
      ...(this.#input.bindingSigner
        ? {
            bindingSigner: {
              ...this.#input.bindingSigner,
              sign: (bytes, context) =>
                this.sign(
                  "bundle-binding",
                  "seller",
                  context.signer,
                  bytes,
                  () => this.#input.bindingSigner!.sign(bytes, context),
                ),
            },
          }
        : {}),
    };
  }

  wrapProvider(
    provider: SellerBundleFinalizationProvider,
  ): SellerBundleFinalizationProvider {
    return {
      ...provider,
      submitSellerBundle: (logicalAddress, bundle) =>
        this.submitBundle(logicalAddress, bundle, () =>
          provider.submitSellerBundle(logicalAddress, bundle),
        ),
      ...(provider.publishBundleBinding
        ? {
            publishBundleBinding: (binding: Readonly<BundleBinding>) =>
              this.publishBinding(binding, () =>
                provider.publishBundleBinding!(binding),
              ),
          }
        : {}),
    };
  }

  async finish(
    result: FinalizedSellerBundle,
    mapping: SellerBundleFinalizationProvider["mapping"],
  ): Promise<void> {
    const anchorIntent = {
      logicalAddress: result.logicalAddress,
      bundleContentHash: result.bundleContentHash,
    };
    await this.#ensureOutcome(
      sellerBundleFinalizationCheckpointKey.anchor,
      anchorIntent,
      {
        ...anchorIntent,
        nativeAddress: result.nativeAddress,
        receiptHash: contentHash(
          result.anchorReceipt as unknown as Record<string, unknown>,
        ),
      },
    );

    const publicationIntent: Record<string, CheckpointValue> = result.binding
      ? {
          mapping,
          logicalAddress: result.binding.logicalAddress,
          bundleContentHash: result.binding.bundleContentHash,
          bindingHash: contentHash(
            result.binding as unknown as Record<string, unknown>,
          ),
        }
      : {
          mapping,
          logicalAddress: result.logicalAddress,
          bundleContentHash: result.bundleContentHash,
        };
    await this.#ensureOutcome(
      sellerBundleFinalizationCheckpointKey.bindingPublication,
      publicationIntent,
      {
        ...publicationIntent,
        applicable: result.binding !== undefined,
      },
    );
    await this.#recordReceipt({ kind: "bundle", ref: result.nativeAddress });
    for (let attempt = 0; attempt < 8; attempt++) {
      const record = await this.#loadRecord();
      const transitioned = await this.#durability.store.transition({
        jobId: this.#input.agreement.jobId,
        expectedRevision: record.revision,
        owner: this.#durability.workerId,
        phase: "seller:finalised",
        lease: null,
      });
      if (transitioned.ok) return;
      if (transitioned.reason !== "revision-mismatch") {
        throw new SubstrateError(
          `durable seller bundle final status failed: ${transitioned.reason}`,
        );
      }
    }
    throw new SubstrateError("durable seller bundle final status exceeded CAS retry limit");
  }

  async releaseAfterFailure(): Promise<void> {
    try {
      for (let attempt = 0; attempt < 8; attempt++) {
        const record = await this.#loadRecord();
        const transitioned = await this.#durability.store.transition({
          jobId: this.#input.agreement.jobId,
          expectedRevision: record.revision,
          owner: this.#durability.workerId,
          phase: "seller:audit-recovery",
          lease: null,
        });
        if (transitioned.ok) return;
        if (transitioned.reason !== "revision-mismatch") return;
      }
    } catch {
      // Preserve the protocol error; a failed release naturally expires by lease TTL.
    }
  }
}

/**
 * Restart-safe wrapper for `finalizeCompletedSellerBundleCore` (#55). It adds
 * durable intent/outcome checkpoints without changing any normative wire shape.
 */
export async function finalizeCompletedSellerBundleDurable(
  input: FinalizeCompletedSellerBundleInput,
  provider: SellerBundleFinalizationProvider,
  durability: SellerBundleFinalizationDurability,
): Promise<FinalizedSellerBundle> {
  const coordinator = new DurableBundleCoordinator(input, durability);
  await coordinator.initialize();
  try {
    const result = await finalizeCompletedSellerBundleCore(
      coordinator.wrapInput(),
      coordinator.wrapProvider(provider),
    );
    await coordinator.finish(result, provider.mapping);
    return result;
  } catch (error) {
    await coordinator.releaseAfterFailure();
    throw error;
  }
}

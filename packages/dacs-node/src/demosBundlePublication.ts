import {
  BUNDLE_BINDING_SEPARATOR,
  DacsError,
  SubstrateError,
  attestationBundleHash,
  bundleAddress,
  isBundleBindingNonObservation,
  resolveBundleBindingCandidates,
  authenticateSessionProfile,
  verifyBundleCopy,
  type BundleBinding,
  type FaultAttestationBundle,
} from "@kynesyslabs/dacs";
import {
  isBundleBinding,
  isCanonicalBase64Url,
  isFaultAttestationBundle,
  type AnchorReceipt,
} from "@kynesyslabs/dacs/artifacts";
import { canonicalize, contentHash, sha256Hex } from "@kynesyslabs/dacs/canonical";
import { ed25519Verify, publicKeyFromRaw, signedBytes } from
  "@kynesyslabs/dacs/crypto";
import { canonicalDemosAgentPublicKey, sameCanonicalClaimIdentity } from "@kynesyslabs/dacs/identity";

import type { DacsBundleBindingDiscoverySurfaceV1 } from "./bundleBindingDiscovery.js";
import { dacsFixedPricePurchaseAnchorOptionsV1 } from "./purchaseDemosBudget.js";
import type { DacsLiveRoleOperationContextV1 } from "./roleRuntime.js";

const DID_PREFIX = "did:demos:agent:";

export type DacsBundleRoleV1 = "buyer" | "seller";

export interface DacsDemosBundlePublicationOptionsV1 {
  context: Readonly<DacsLiveRoleOperationContextV1>;
  jobId: string;
  buyer: string;
  seller: string;
  /**
   * DACS-1 §6.3.5 well-known and §6.3.6 catalog surfaces consulted for signed
   * BundleBindings, in addition to the role's own Demos binding program.
   */
  discovery?: readonly Readonly<DacsBundleBindingDiscoverySurfaceV1>[];
}

export interface DacsDemosAnchoredBundleV1 {
  bundle: Readonly<FaultAttestationBundle>;
  nativeAddress: string;
  anchorReceipt: Readonly<AnchorReceipt>;
  anchorTx?: string;
}

export interface DacsDemosBundlePublicationV1 {
  readonly mapping: "write-input";
  readonly bundleCopyVerifier: Readonly<{
    resolvePublicKey(claim: string): Promise<Uint8Array | null>;
    verify(bytes: Uint8Array, signature: Uint8Array, key: Uint8Array): Promise<boolean>;
  }>;
  /**
   * This node's own role copy: at the native address its own write returned,
   * else through its own write-input name (a producer-side idempotency hint,
   * never a consumer resolution key). Another role's copy is refused.
   */
  resolveRoleBundle(role: DacsBundleRoleV1): Promise<Readonly<DacsDemosAnchoredBundleV1> | null>;
  /**
   * A role's copy through its discovered signed BundleBindings (DACS-5
   * BB-5..BB-7) and an exact native read. Non-discovery is `indeterminate`,
   * never absence (BB-8): `bundle-binding-undiscovered` when every surface
   * answered, `bundle-binding-unanswered` when one did not. `carried` are
   * signed bindings already held for the role, such as the one its copy
   * carries (BB-2); they join the candidates.
   */
  resolveBoundRoleBundle(
    role: DacsBundleRoleV1,
    carried?: readonly unknown[],
  ): Promise<Readonly<
    | { disposition: "present"; binding: Readonly<BundleBinding>;
        anchored: Readonly<DacsDemosAnchoredBundleV1> }
    | { disposition: "indeterminate"; reason: string }
  >>;
  /** The bundle at an exact native address, or null when none is readable there yet. */
  readBundleAt(nativeAddress: string): Promise<Readonly<FaultAttestationBundle> | null>;
  submitRoleBundle(
    role: DacsBundleRoleV1,
    logicalAddress: string,
    bundle: Readonly<FaultAttestationBundle>,
  ): Promise<void>;
  verifyBundleAnchorReceipt(
    anchored: Readonly<DacsDemosAnchoredBundleV1>,
  ): Promise<"valid" | "invalid" | "indeterminate" | "error">;
  resolveBundleBinding(
    logicalAddress: string,
    signer: string,
    carried?: Readonly<BundleBinding>,
  ): Promise<Readonly<
    | { disposition: "present"; binding: Readonly<BundleBinding> }
    | { disposition: "absent" }
    | { disposition: "indeterminate"; reason: string }
  >>;
  publishRoleBundleBinding(
    role: DacsBundleRoleV1,
    binding: Readonly<BundleBinding>,
  ): Promise<Readonly<
    | { disposition: "published" }
    | { disposition: "rejected" | "indeterminate"; reason: string }
  >>;
  verifyBundleBinding(
    binding: Readonly<BundleBinding>,
  ): Promise<"valid" | "invalid" | "indeterminate" | "error">;
}

export class DacsDemosBundlePublicationError extends Error {
  override readonly name = "DacsDemosBundlePublicationError";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

/**
 * True when a role-bundle read failed in a way retry cannot repair: the
 * resolved anchor holds invalid content or an invalid receipt, or the
 * publication authority is invalid. `bundle-resolution-indeterminate` and any
 * other thrown error are unanswered reads.
 */
function isPermanentDacsDemosBundleReadError(error: unknown): boolean {
  return error instanceof DacsDemosBundlePublicationError &&
    error.reasonCode !== "bundle-resolution-indeterminate";
}

function copy<T>(value: T): T {
  return JSON.parse(canonicalize(value)) as T;
}

function authority(input: Readonly<DacsDemosBundlePublicationOptionsV1>, role: DacsBundleRoleV1) {
  return role === "buyer" ? input.buyer : input.seller;
}

function owner(claim: string): string {
  if (!claim.startsWith(DID_PREFIX) || claim.length !== DID_PREFIX.length + 64) {
    throw new DacsDemosBundlePublicationError("bundle-publication-authority-invalid");
  }
  return claim.slice(DID_PREFIX.length);
}

function bindingAddress(jobId: string, role: DacsBundleRoleV1): string {
  return `dacs5:bundle-binding:${jobId}:${role}`;
}

// CORE B.1 CF-3: advisory parameters never make the role holder another party.
function roleFor(
  input: Readonly<DacsDemosBundlePublicationOptionsV1>,
  logicalAddress: string,
  signer: string,
): DacsBundleRoleV1 | null {
  return logicalAddress === bundleAddress(input.jobId, "seller") &&
      sameCanonicalClaimIdentity(signer, input.seller)
    ? "seller"
    : logicalAddress === bundleAddress(input.jobId, "buyer") &&
        sameCanonicalClaimIdentity(signer, input.buyer)
      ? "buyer" : null;
}

function verifyBindingSignature(
  binding: Readonly<Omit<BundleBinding, "jobId"> & { jobId: unknown }>,
): boolean {
  const rawKey = canonicalDemosAgentPublicKey(binding.signer);
  if (rawKey === null || binding.signature.algorithm !== "ed25519" ||
      binding.signature.signer !== binding.signer ||
      !isCanonicalBase64Url(binding.signature.value)) return false;
  const signature = Buffer.from(binding.signature.value, "base64url");
  if (signature.byteLength !== 64 ||
      signature.toString("base64url") !== binding.signature.value) return false;
  try {
    return ed25519Verify(
      signedBytes(
        BUNDLE_BINDING_SEPARATOR,
        contentHash(binding as unknown as Record<string, unknown>),
      ),
      Uint8Array.from(signature),
      publicKeyFromRaw(rawKey),
    );
  } catch {
    return false;
  }
}

/** Demos Storage Program bundle/binding publication shared by both role audits. */
export function createDacsDemosBundlePublicationV1(
  input: Readonly<DacsDemosBundlePublicationOptionsV1>,
): Readonly<DacsDemosBundlePublicationV1> {
  if (input.context.role !== "buyer" && input.context.role !== "seller") {
    throw new TypeError("Demos bundle publication options are invalid");
  }
  owner(input.buyer);
  owner(input.seller);
  const context = input.context;
  const discovery = [...(input.discovery ?? [])];
  if (discovery.some((surface) => surface === null || typeof surface !== "object" ||
      typeof surface.discover !== "function")) {
    throw new TypeError("Demos bundle publication discovery surfaces are invalid");
  }
  // The native addresses this node's own writes returned, and the bindings it
  // published: a lagging name index never hides either from this node.
  const ownCopies = new Map<DacsBundleRoleV1, string>();
  const ownBindings: BundleBinding[] = [];
  const bundleCopyVerifier = Object.freeze({
    async resolvePublicKey(claim: string) {
      const raw = canonicalDemosAgentPublicKey(claim);
      return raw === null ? null : Uint8Array.from(raw);
    },
    async verify(bytes: Uint8Array, signature: Uint8Array, key: Uint8Array) {
      try {
        return ed25519Verify(bytes, signature, publicKeyFromRaw(key));
      } catch {
        return false;
      }
    },
  });

  const readBundleAt: DacsDemosBundlePublicationV1["readBundleAt"] =
    async (nativeAddress) => {
      const bundle = await context.demos.adapter.readAnchor(nativeAddress);
      if (bundle === null) return null;
      if (!isFaultAttestationBundle(bundle)) {
        throw new DacsDemosBundlePublicationError("bundle-readback-invalid");
      }
      return copy(bundle);
    };

  // The role's copy and its authenticated receipt at an exact native address,
  // without the name index (DACS-5 BB-5 step 6); null when nothing is
  // readable there yet.
  const anchoredAt = async (
    role: DacsBundleRoleV1,
    nativeAddress: string,
  ): Promise<Readonly<DacsDemosAnchoredBundleV1> | null> => {
    const writer = authority(input, role);
    const logicalAddress = bundleAddress(input.jobId, role);
    const bundle = await readBundleAt(nativeAddress);
    if (bundle === null) return null;
    const hash = attestationBundleHash(bundle);
    const receipt = await context.demos.adapter.resolveDemosAnchorReceipt({
      logicalAddress,
      nativeAddress,
      contentHash: hash,
      writer,
    });
    // The bundle was just read at this address, so a node that now finds no
    // program there has not caught up; retry rather than reject.
    if (receipt === null) {
      throw new DacsDemosBundlePublicationError("bundle-resolution-indeterminate");
    }
    if (receipt.writer !== writer ||
        receipt.logicalAddress !== logicalAddress ||
        receipt.nativeAddress !== nativeAddress || receipt.contentHash !== hash ||
        receipt.observationDisposition !== "established" ||
        (receipt.state !== "included" && receipt.state !== "finalized") ||
        await context.demos.adapter.verifyDemosAnchorReceipt(receipt) !== true) {
      throw new DacsDemosBundlePublicationError("bundle-receipt-invalid");
    }
    return Object.freeze({ bundle, nativeAddress, anchorReceipt: copy(receipt) });
  };

  // A binding's optional `anchorTx` is the canonical pointer to the anchoring
  // transaction: the authenticated receipt's transaction reference (DACS-5
  // BB-1). Every Demos receipt is a `demos-storage-program` reference.
  const anchorTxMatches = (
    binding: Readonly<BundleBinding>,
    anchored: Readonly<DacsDemosAnchoredBundleV1>,
  ): boolean => binding.anchorTx === undefined ||
    binding.anchorTx === anchored.anchorReceipt.transactionRef.value;

  const resolveRoleBundle: DacsDemosBundlePublicationV1["resolveRoleBundle"] =
    async (role) => {
      // The storage-program name is this producer's own write input; no
      // consumer resolves another role's copy by it (DACS-5 BB-5).
      if (role !== context.role) {
        throw new DacsDemosBundlePublicationError("bundle-resolution-role-invalid");
      }
      const own = ownCopies.get(role);
      if (own !== undefined) {
        const anchored = await anchoredAt(role, own);
        if (anchored === null) {
          throw new DacsDemosBundlePublicationError("bundle-resolution-indeterminate");
        }
        return anchored;
      }
      const resolved = await context.demos.adapter.resolveAnchorByName(
        bundleAddress(input.jobId, role),
        owner(authority(input, role)),
      );
      if (resolved.status === "absent") return null;
      if (resolved.status !== "present") {
        throw new DacsDemosBundlePublicationError("bundle-resolution-indeterminate");
      }
      const anchored = await anchoredAt(role, resolved.address);
      // The name index shows a program there, so a node that cannot read it
      // yet has not caught up; retry rather than reject.
      if (anchored === null) {
        throw new DacsDemosBundlePublicationError("bundle-resolution-indeterminate");
      }
      return anchored;
    };

  const verifyBundleAnchorReceipt:
    DacsDemosBundlePublicationV1["verifyBundleAnchorReceipt"] = async (anchored) => {
      const role = anchored.anchorReceipt.logicalAddress ===
          bundleAddress(input.jobId, "seller") ? "seller" as const
        : anchored.anchorReceipt.logicalAddress === bundleAddress(input.jobId, "buyer")
          ? "buyer" as const : null;
      if (role === null || anchored.anchorReceipt.writer !== authority(input, role) ||
          anchored.anchorReceipt.nativeAddress !== anchored.nativeAddress ||
          anchored.anchorReceipt.contentHash !== attestationBundleHash(anchored.bundle)) {
        return "invalid";
      }
      try {
        return await context.demos.adapter.verifyDemosAnchorReceipt(
          anchored.anchorReceipt,
        ) === true ? "valid" : "invalid";
      } catch {
        return "error";
      }
    };

  const verifyBundleBinding: DacsDemosBundlePublicationV1["verifyBundleBinding"] =
    async (binding) => {
      const role = roleFor(input, binding.logicalAddress, binding.signer);
      if (role === null || !isBundleBinding(binding) || binding.jobId !== input.jobId ||
          binding.role !== role || !verifyBindingSignature(binding)) return "invalid";
      try {
        // BB-5 steps 6-8: fetch the binding's own native address.
        const anchored = await anchoredAt(role, binding.nativeAddress);
        if (anchored === null) return "indeterminate";
        return anchored.bundle.jobId === binding.jobId &&
            anchored.anchorReceipt.contentHash === binding.bundleContentHash &&
            attestationBundleHash(anchored.bundle) === binding.bundleContentHash &&
            anchorTxMatches(binding, anchored)
          ? "valid" : "invalid";
      } catch (error) {
        // An invalid anchored bundle or receipt can never authenticate a binding.
        return isPermanentDacsDemosBundleReadError(error) ? "invalid" : "indeterminate";
      }
    };

  // The role's own Demos binding program: one discovery surface among those
  // configured (BB-3). Its records are untrusted until the candidate set
  // authenticates them.
  const demosBindingProgram = async (role: DacsBundleRoleV1): Promise<unknown[]> => {
    const resolved = await context.demos.adapter.resolveAnchorByName(
      bindingAddress(input.jobId, role),
      owner(authority(input, role)),
    );
    if (resolved.status === "absent") return [];
    if (resolved.status !== "present") {
      throw new DacsDemosBundlePublicationError("bundle-binding-resolution-indeterminate");
    }
    const binding = await context.demos.adapter.readAnchor(resolved.address);
    return binding === null ? [] : [binding];
  };

  const resolveBoundRoleBundle: DacsDemosBundlePublicationV1["resolveBoundRoleBundle"] =
    async (role, carried = []) => {
      const admitted = await authenticateSessionProfile(
        context.authenticateSessionProfile === undefined ? undefined :
          () => context.authenticateSessionProfile!(input.jobId),
        { jobId: input.jobId, buyer: input.buyer, seller: input.seller },
      );
      const signer = admitted[role]!;
      const candidates: unknown[] = [...ownBindings, ...carried];
      const surfaces = [() => demosBindingProgram(role), ...discovery.map((surface) =>
        () => surface.discover({ jobId: input.jobId, role, signer }))];
      let unanswered = false;
      for (const discover of surfaces) {
        try {
          candidates.push(...await discover());
        } catch {
          // A surface that did not answer discovers nothing (BB-8).
          unanswered = true;
        }
      }
      const fetched = new Map<string, Readonly<DacsDemosAnchoredBundleV1>>();
      const resolved = await resolveBundleBindingCandidates({
        jobId: input.jobId,
        role,
        candidates,
        authenticateSessionProfile: () => context.authenticateSessionProfile!(input.jobId),
        // The session's authenticated role holder prunes before any fetch.
        roleHolder: signer,
        verifyBindingSignature,
        async fetchCopy(nativeAddress) {
          let anchored: Readonly<DacsDemosAnchoredBundleV1> | null;
          try {
            anchored = await anchoredAt(role, nativeAddress);
          } catch (error) {
            if (isPermanentDacsDemosBundleReadError(error)) {
              throw new DacsError(`bundle candidate is invalid: ${(error as Error).message}`);
            }
            throw error;
          }
          if (anchored === null) return null;
          fetched.set(nativeAddress, anchored);
          return anchored.bundle as unknown as Record<string, unknown>;
        },
        verifyBindingCopy: (binding) => {
          const anchored = fetched.get(binding.nativeAddress);
          return anchored !== undefined && anchorTxMatches(binding, anchored);
        },
        verifyCopy: (bundle, copyRole) =>
          verifyBundleCopy(bundle as Record<string, unknown>, copyRole, bundleCopyVerifier),
      });
      if (resolved.disposition !== "present") {
        // Nothing discovered while a surface did not answer is no evidence
        // either way, but it is not every surface answering without one.
        return unanswered && resolved.reason === "bundle-binding-undiscovered"
          ? { disposition: "indeterminate", reason: "bundle-binding-unanswered" }
          : resolved;
      }
      const anchored = fetched.get(resolved.binding.nativeAddress)!;
      return { disposition: "present", binding: resolved.binding, anchored };
    };

  const resolveBundleBinding: DacsDemosBundlePublicationV1["resolveBundleBinding"] =
    async (logicalAddress, signer, carried) => {
      const role = roleFor(input, logicalAddress, signer);
      if (role === null) return { disposition: "absent" };
      let resolved: Awaited<ReturnType<typeof resolveBoundRoleBundle>>;
      try {
        resolved = await resolveBoundRoleBundle(role,
          carried === undefined ? [] : [copy(carried)]);
      } catch (error) {
        // A validation answer must not become the BB-8 non-observation
        // exception: doing so could hide equivocation or budget exhaustion.
        if (error instanceof DacsError && !(error instanceof SubstrateError)) throw error;
        return { disposition: "indeterminate", reason: "bundle-binding-unanswered" };
      }
      if (resolved.disposition === "present") {
        return { disposition: "present", binding: copy(resolved.binding) };
      }
      // This producer publishes its own binding when it finds none; the write
      // is idempotent, so this is no claim that the substrate lacks it.
      return role === context.role && isBundleBindingNonObservation(resolved.reason)
        ? { disposition: "absent" } : resolved;
    };

  return Object.freeze({
    mapping: "write-input" as const,
    bundleCopyVerifier,
    resolveRoleBundle,
    resolveBoundRoleBundle,
    readBundleAt,
    async submitRoleBundle(
      role: DacsBundleRoleV1,
      logicalAddress: string,
      bundle: Readonly<FaultAttestationBundle>,
    ) {
      if (role !== context.role || logicalAddress !== bundleAddress(input.jobId, role) ||
          !isFaultAttestationBundle(bundle)) {
        throw new DacsDemosBundlePublicationError("bundle-submission-invalid");
      }
      const hash = attestationBundleHash(bundle);
      let written: string | undefined;
      try {
        const ref = await context.demos.adapter.anchorWriteOnce(
          logicalAddress,
          copy(bundle),
          dacsFixedPricePurchaseAnchorOptionsV1(context, input.jobId, {
            logicalAddress,
            contentHash: hash,
            envelopeHash: sha256Hex(canonicalize(bundle)),
          }),
        );
        if (typeof ref?.address === "string") written = ref.address;
      } catch {
        // An ambiguous write is resolved under the exact same role/name below.
      }
      // Read back at the native address the write returned: the name index
      // may lag finality (ST-11). Only an ambiguous write falls back to it.
      const readback = written === undefined
        ? await resolveRoleBundle(role) : await anchoredAt(role, written);
      if (readback === null ||
          canonicalize(readback.bundle) !== canonicalize(bundle)) {
        throw new DacsDemosBundlePublicationError("bundle-submission-ambiguous");
      }
      ownCopies.set(role, readback.nativeAddress);
    },
    verifyBundleAnchorReceipt,
    resolveBundleBinding,
    async publishRoleBundleBinding(
      role: DacsBundleRoleV1,
      binding: Readonly<BundleBinding>,
    ) {
      if (role !== context.role || binding.role !== role ||
          binding.signer !== authority(input, role) ||
          await verifyBundleBinding(binding) !== "valid") {
        return { disposition: "rejected" as const,
          reason: "bundle-binding-publication-invalid" };
      }
      const logicalAddress = bindingAddress(input.jobId, role);
      const hash = contentHash(binding as unknown as Record<string, unknown>);
      let written: string | undefined;
      try {
        const ref = await context.demos.adapter.anchorWriteOnce(
          logicalAddress,
          copy(binding),
          dacsFixedPricePurchaseAnchorOptionsV1(context, input.jobId, {
            logicalAddress,
            contentHash: hash,
            envelopeHash: sha256Hex(canonicalize(binding)),
          }),
        );
        if (typeof ref?.address === "string") written = ref.address;
      } catch {
        // Resolve the exact signed binding before reporting an ambiguous result.
      }
      // As for the bundle: read back where the write landed, and use the
      // binding program's name only after an ambiguous write.
      let readback: unknown[];
      try {
        readback = written === undefined ? await demosBindingProgram(role)
          : [await context.demos.adapter.readAnchor(written)];
      } catch {
        readback = [];
      }
      if (!readback.some((entry) => entry !== null &&
          canonicalize(entry) === canonicalize(binding))) {
        return { disposition: "indeterminate" as const,
          reason: "bundle-binding-publication-ambiguous" };
      }
      ownBindings.push(copy(binding));
      return { disposition: "published" as const };
    },
    verifyBundleBinding,
  });
}

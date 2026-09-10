import {
  BUNDLE_BINDING_SEPARATOR,
  attestationBundleHash,
  bundleAddress,
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
import { canonicalDemosAgentPublicKey } from "@kynesyslabs/dacs/identity";

import type { DacsLiveRoleOperationContextV1 } from "./roleRuntime.js";

const DID_PREFIX = "did:demos:agent:";

export type DacsBundleRoleV1 = "buyer" | "seller";

export interface DacsDemosBundlePublicationOptionsV1 {
  context: Readonly<DacsLiveRoleOperationContextV1>;
  jobId: string;
  buyer: string;
  seller: string;
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
  resolveRoleBundle(role: DacsBundleRoleV1): Promise<Readonly<DacsDemosAnchoredBundleV1> | null>;
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

function roleFor(
  input: Readonly<DacsDemosBundlePublicationOptionsV1>,
  logicalAddress: string,
  signer: string,
): DacsBundleRoleV1 | null {
  return logicalAddress === bundleAddress(input.jobId, "seller") &&
      signer === input.seller
    ? "seller"
    : logicalAddress === bundleAddress(input.jobId, "buyer") && signer === input.buyer
      ? "buyer" : null;
}

function verifyBindingSignature(binding: Readonly<BundleBinding>): boolean {
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

  const resolveRoleBundle: DacsDemosBundlePublicationV1["resolveRoleBundle"] =
    async (role) => {
      const writer = authority(input, role);
      const logicalAddress = bundleAddress(input.jobId, role);
      const resolved = await context.demos.adapter.resolveAnchorByName(
        logicalAddress,
        owner(writer),
      );
      if (resolved.status === "absent") return null;
      if (resolved.status !== "present") {
        throw new DacsDemosBundlePublicationError("bundle-resolution-indeterminate");
      }
      const bundle = await context.demos.adapter.readAnchor(resolved.address);
      if (bundle === null || !isFaultAttestationBundle(bundle)) {
        throw new DacsDemosBundlePublicationError("bundle-readback-invalid");
      }
      const hash = attestationBundleHash(bundle);
      const receipt = await context.demos.adapter.resolveDemosAnchorReceipt({
        logicalAddress,
        nativeAddress: resolved.address,
        contentHash: hash,
        writer,
      });
      if (receipt === null || receipt.writer !== writer ||
          receipt.logicalAddress !== logicalAddress ||
          receipt.nativeAddress !== resolved.address || receipt.contentHash !== hash ||
          receipt.observationDisposition !== "established" ||
          (receipt.state !== "included" && receipt.state !== "finalized") ||
          await context.demos.adapter.verifyDemosAnchorReceipt(receipt) !== true) {
        throw new DacsDemosBundlePublicationError("bundle-receipt-invalid");
      }
      return Object.freeze({
        bundle: copy(bundle),
        nativeAddress: resolved.address,
        anchorReceipt: copy(receipt),
        ...(receipt.transactionRef.kind === "demos"
          ? { anchorTx: receipt.transactionRef.value } : {}),
      });
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
        const anchored = await resolveRoleBundle(role);
        return anchored !== null && anchored.nativeAddress === binding.nativeAddress &&
            anchored.anchorReceipt.contentHash === binding.bundleContentHash &&
            attestationBundleHash(anchored.bundle) === binding.bundleContentHash &&
            (binding.anchorTx === undefined || anchored.anchorTx === binding.anchorTx)
          ? "valid" : "invalid";
      } catch {
        return "indeterminate";
      }
    };

  const resolveBundleBinding: DacsDemosBundlePublicationV1["resolveBundleBinding"] =
    async (logicalAddress, signer) => {
      const role = roleFor(input, logicalAddress, signer);
      if (role === null) return { disposition: "absent" };
      try {
        const name = bindingAddress(input.jobId, role);
        const resolved = await context.demos.adapter.resolveAnchorByName(name, owner(signer));
        if (resolved.status === "absent") return { disposition: "absent" };
        if (resolved.status !== "present") {
          return { disposition: "indeterminate",
            reason: "bundle-binding-resolution-indeterminate" };
        }
        const binding = await context.demos.adapter.readAnchor(resolved.address);
        if (binding === null || !isBundleBinding(binding)) {
          return { disposition: "indeterminate", reason: "bundle-binding-invalid" };
        }
        const hash = contentHash(binding as unknown as Record<string, unknown>);
        const receipt = await context.demos.adapter.resolveDemosAnchorReceipt({
          logicalAddress: name,
          nativeAddress: resolved.address,
          contentHash: hash,
          writer: signer,
        });
        if (receipt === null ||
            await context.demos.adapter.verifyDemosAnchorReceipt(receipt) !== true ||
            await verifyBundleBinding(binding) !== "valid") {
          return { disposition: "indeterminate",
            reason: "bundle-binding-authentication-failed" };
        }
        return { disposition: "present", binding: copy(binding) };
      } catch {
        return { disposition: "indeterminate",
          reason: "bundle-binding-resolution-unavailable" };
      }
    };

  return Object.freeze({
    mapping: "write-input" as const,
    bundleCopyVerifier: Object.freeze({
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
    }),
    resolveRoleBundle,
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
      try {
        await context.demos.adapter.anchorWriteOnce(logicalAddress, copy(bundle), {
          metadata: {
            logicalAddress,
            contentHash: hash,
            envelopeHash: sha256Hex(canonicalize(bundle)),
          },
        });
      } catch {
        // An ambiguous write is resolved under the exact same role/name below.
      }
      const readback = await resolveRoleBundle(role);
      if (readback === null ||
          canonicalize(readback.bundle) !== canonicalize(bundle)) {
        throw new DacsDemosBundlePublicationError("bundle-submission-ambiguous");
      }
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
      try {
        await context.demos.adapter.anchorWriteOnce(logicalAddress, copy(binding), {
          metadata: {
            logicalAddress,
            contentHash: hash,
            envelopeHash: sha256Hex(canonicalize(binding)),
          },
        });
      } catch {
        // Resolve the exact signed binding before reporting an ambiguous result.
      }
      const readback = await resolveBundleBinding(binding.logicalAddress, binding.signer);
      return readback.disposition === "present" &&
          canonicalize(readback.binding) === canonicalize(binding)
        ? { disposition: "published" as const }
        : { disposition: "indeterminate" as const,
            reason: "bundle-binding-publication-ambiguous" };
    },
    verifyBundleBinding,
  });
}

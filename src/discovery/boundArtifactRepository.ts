import {
  canonicalize,
  contentHash,
  logicalToStorageProgramName,
  sha256Hex,
} from "../canonical/index.js";
import type {
  AnchorRef,
  AnchorWriteOnceOptions,
} from "../substrate/SubstrateAdapter.js";
import type {
  AnchorBinding,
  BindingIndex,
  BindingPublication,
  BindingPublisher,
} from "./binding.js";
import {
  resolveAndRead,
  type VerifiedRead,
  type VerifiedReadDeps,
} from "./verifiedRead.js";
import { normalizedBindingOwner } from "./owner.js";
import {
  isAttestationBundle,
  isEvidenceBoundFaultAttestationBundle,
  isFaultAttestationBundle,
  isIdentityBundle,
  isListing,
} from "../artifacts/validators.js";
import { attestationBundleHash } from "../agent/twoSidedBundle.js";
import { identityBundleHash } from "../identity/bundle.js";

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The envelope members all four DACS-3 §8.5.1 Agreement versions carry. */
function hasAgreementEnvelope(artifact: Record<string, unknown>): boolean {
  return (
    typeof artifact.jobId === "string" && artifact.jobId.length > 0 &&
    isPlainRecord(artifact.listingRef) &&
    Array.isArray(artifact.parties) &&
    isPlainRecord(artifact.terms) &&
    typeof artifact.derivedFromPattern === "string" &&
    typeof artifact.generatedAt === "number" && Number.isSafeInteger(artifact.generatedAt) && artifact.generatedAt >= 0 &&
    Array.isArray(artifact.signatures)
  );
}

/** Select the artifact contract, never the mere presence of a signature field. */
function artifactContentHash(artifact: Record<string, unknown>): string {
  // A record that passes a complete artifact validator keeps that artifact's
  // contract. CORE SIG-5 makes every unknown member, including an
  // Agreement-named one, ordinary signed data of that artifact.
  if (isListing(artifact)) return contentHash(artifact);
  if (
    isAttestationBundle(artifact) ||
    isFaultAttestationBundle(artifact) ||
    isEvidenceBoundFaultAttestationBundle(artifact)
  ) {
    return attestationBundleHash(artifact);
  }
  if (isIdentityBundle(artifact)) return identityBundleHash(artifact);
  // DACS-3 §8.5.1 defines the same omission set for all four Agreement
  // versions, including the identity-bound types not yet executable by this
  // SDK. Select their hash contract from the exact, exclusive discriminator
  // on a complete Agreement envelope; full artifact/signature/authorization
  // validation remains the reader's job.
  const agreementVersions = [
    "agreementVersion",
    "payeeBoundAgreementVersion",
    "identityBoundAgreementVersion",
    "identityBoundPayeeAgreementVersion",
  ].filter((key) => Object.prototype.hasOwnProperty.call(artifact, key));
  if (agreementVersions.length > 0 && hasAgreementEnvelope(artifact)) {
    if (agreementVersions.length !== 1 || artifact[agreementVersions[0]!] !== "1") {
      throw new Error("Agreement requires exactly one supported version discriminator");
    }
    // Hash the original record: opposite-named signature extensions and all
    // other additive fields remain authenticated.
    return contentHash(artifact, "signatures");
  }
  // ChannelTranscript has no public SDK validator yet. Check its complete
  // envelope contract here; signature authentication remains the reader's job.
  if (
    artifact.transcriptVersion === "1" &&
    typeof artifact.channelId === "string" && artifact.channelId.length > 0 &&
    Array.isArray(artifact.members) && artifact.members.every((member) => typeof member === "string") &&
    Array.isArray(artifact.messages) &&
    typeof artifact.generatedAt === "number" && Number.isSafeInteger(artifact.generatedAt) && artifact.generatedAt >= 0 &&
    Array.isArray(artifact.signatures)
  ) {
    return contentHash(artifact, "signatures");
  }
  return contentHash(artifact);
}

/** Minimal substrate seam needed for binding-aware immutable artifacts. */
export interface BoundArtifactAdapter {
  getAddress(): string;
  anchorWriteOnce(
    name: string,
    value: object,
    opts?: AnchorWriteOnceOptions,
  ): Promise<AnchorRef>;
  readAnchor(address: string): Promise<Record<string, unknown> | null>;
}

export interface BoundArtifactRepositoryDeps {
  adapter: BoundArtifactAdapter;
  /** Consumer-facing published index. May be remote and read-only. */
  index: BindingIndex;
  /**
   * Writer-authorized publication target for that index/catalog. Successful
   * acknowledgement is checked against `index` before write returns success.
   */
  publisher: BindingPublisher;
}

export interface BoundArtifactWriteOptions {
  /**
   * Opaque substrate write input. Consumers never receive or resolve by it.
   * Defaults to this SDK's colon-free encoding of the logical address.
   */
  storageName?: string;
  /** Optional artifact version copied into the published binding. */
  version?: number;
  /** Immutable-anchor reconciliation budget. */
  anchor?: AnchorWriteOnceOptions;
}

interface BoundArtifactWriteBase {
  /** Physical write result; retain it when publication is indeterminate. */
  anchor: AnchorRef;
  /** Binding this write attempted to publish. */
  binding: AnchorBinding;
  /** Opaque writer-only input, exposed for diagnostics and safe retry only. */
  storageName: string;
}

export type BoundArtifactWriteResult =
  | (BoundArtifactWriteBase & { status: "published" })
  | (BoundArtifactWriteBase & { status: "already-published" })
  | (BoundArtifactWriteBase & {
      status: "conflict";
      reason: string;
      existing?: AnchorBinding;
    })
  | (BoundArtifactWriteBase & { status: "indeterminate"; reason: string });

export interface BoundArtifactRepository {
  /**
   * Anchor immutable bytes and publish the resulting logical→native binding.
   * A retry uses `anchorWriteOnce`, so a publication failure never creates a
   * second physical artifact with different content or a new nonce. A success
   * status means the exact tuple was also read back through the configured
   * consumer index.
   */
  write(
    logicalAddress: string,
    artifact: Record<string, unknown>,
    options?: BoundArtifactWriteOptions,
  ): Promise<BoundArtifactWriteResult>;

  /**
   * Resolve only through the published binding, then hash and verify the record.
   * The reader does not need the writer's nonce or opaque storage name.
   */
  read(
    logicalAddress: string,
    expectedOwner: string,
    verifySignature?: VerifiedReadDeps["verifySignature"],
  ): Promise<VerifiedRead>;
}

function anchorOptionsWithLogicalAddress(
  logicalAddress: string,
  options: AnchorWriteOnceOptions | undefined,
  artifactContentHash: string,
  envelopeHash: string,
): AnchorWriteOnceOptions {
  const supplied = options?.metadata;
  if (
    supplied !== undefined &&
    (typeof supplied !== "object" || supplied === null || Array.isArray(supplied))
  ) {
    throw new Error("anchor metadata must be an object");
  }
  const requiredMetadata = {
    logicalAddress,
    contentHash: artifactContentHash,
    envelopeHash,
  };
  for (const [key, expected] of Object.entries(requiredMetadata)) {
    if (
      supplied !== undefined &&
      Object.prototype.hasOwnProperty.call(supplied, key) &&
      supplied[key] !== expected
    ) {
      throw new Error(
        `anchor metadata ${key} conflicts with the repository ${
          key === "logicalAddress" ? "logical address" : "artifact binding"
        }`,
      );
    }
  }
  if (
    supplied !== undefined &&
    Object.prototype.hasOwnProperty.call(supplied, "logical_address") &&
    supplied.logical_address !== logicalAddress
  ) {
    throw new Error(
      "anchor metadata logical_address conflicts with the repository logical address",
    );
  }
  return {
    ...options,
    metadata: { ...supplied, ...requiredMetadata },
  };
}

function publicationMatches(
  expected: AnchorBinding,
  actual: AnchorBinding,
): boolean {
  return (
    expected.logicalAddress === actual.logicalAddress &&
    expected.nativeAddress === actual.nativeAddress &&
    normalizedBindingOwner(expected.owner) ===
      normalizedBindingOwner(actual.owner) &&
    expected.contentHash === actual.contentHash &&
    expected.version === actual.version &&
    (expected.revoked === true) === (actual.revoked === true)
  );
}

async function writeResult(
  base: BoundArtifactWriteBase,
  publication: BindingPublication,
  index: BindingIndex,
): Promise<BoundArtifactWriteResult> {
  if (
    publication.status === "published" ||
    publication.status === "already-published"
  ) {
    if (!publicationMatches(base.binding, publication.binding)) {
      return {
        ...base,
        status: "conflict",
        reason: "publisher reported success for a binding that does not match the anchored artifact",
        existing: publication.binding,
      };
    }
    let resolution;
    try {
      resolution = await index.resolve(
        base.binding.logicalAddress,
        base.binding.owner,
      );
    } catch (error) {
      return {
        ...base,
        status: "indeterminate",
        reason:
          "binding publication was acknowledged but index readback failed: " +
          (error instanceof Error ? error.message : String(error)),
      };
    }
    if (resolution.status === "indeterminate") {
      return {
        ...base,
        status: "indeterminate",
        reason:
          "binding publication was acknowledged but index readback was indeterminate: " +
          resolution.reason,
      };
    }
    if (resolution.status === "absent") {
      return {
        ...base,
        status: "indeterminate",
        reason:
          "binding publication was acknowledged but is not yet visible in the configured index",
      };
    }
    if (!publicationMatches(base.binding, resolution.binding)) {
      return {
        ...base,
        status: "conflict",
        reason:
          "configured index resolved a binding that does not match the anchored artifact",
        existing: resolution.binding,
      };
    }
    return { ...base, status: publication.status };
  }
  return { ...base, ...publication };
}

/**
 * Compose immutable anchoring, explicit binding publication, and independent
 * binding-based reads into one supported public seam (#58). This deliberately
 * requires a publisher: the SDK cannot infer authority to mutate a deployment's
 * well-known index or catalog.
 */
export function createBoundArtifactRepository(
  deps: BoundArtifactRepositoryDeps,
): BoundArtifactRepository {
  return {
    async write(logicalAddress, artifact, options) {
      const canonicalLogicalAddress = logicalAddress.trim().normalize("NFC");
      if (canonicalLogicalAddress.length === 0) {
        throw new Error("logicalAddress must not be empty");
      }
      if (logicalAddress !== canonicalLogicalAddress) {
        throw new Error("logicalAddress must be trimmed and NFC-normalized");
      }
      const owner = deps.adapter.getAddress();
      if (owner.trim().length === 0) {
        throw new Error("adapter returned an empty owner address");
      }
      const storageName =
        options?.storageName ?? logicalToStorageProgramName(logicalAddress);
      if (storageName.trim().length === 0) {
        throw new Error("storageName must not be empty");
      }

      // Deep-pin the exact JSON supplied by the caller before crossing an async
      // adapter boundary. Hash and anchor the same snapshot; caller mutation can
      // never turn the published hash into a pointer to different bytes.
      let pinnedArtifact: Record<string, unknown>;
      try {
        const pinned = structuredClone(artifact) as unknown;
        if (
          typeof pinned !== "object" ||
          pinned === null ||
          Array.isArray(pinned)
        ) {
          throw new Error("artifact is not a JSON object");
        }
        pinnedArtifact = pinned as Record<string, unknown>;
      } catch (error) {
        throw new Error("artifact must be a canonicalizable JSON object", {
          cause: error,
        });
      }
      const pinnedContentHash = artifactContentHash(pinnedArtifact);
      const envelopeHash = sha256Hex(canonicalize(pinnedArtifact));
      const anchor = await deps.adapter.anchorWriteOnce(
        storageName,
        pinnedArtifact,
        anchorOptionsWithLogicalAddress(
          logicalAddress,
          options?.anchor,
          pinnedContentHash,
          envelopeHash,
        ),
      );
      if (anchor.address.trim().length === 0) {
        throw new Error("anchorWriteOnce returned an empty native address");
      }

      const binding: AnchorBinding = {
        logicalAddress,
        nativeAddress: anchor.address,
        owner,
        contentHash: pinnedContentHash,
        ...(options?.version === undefined
          ? {}
          : { version: options.version }),
      };
      const base: BoundArtifactWriteBase = { anchor, binding, storageName };

      let publication: BindingPublication;
      try {
        publication = await deps.publisher.publish({ ...binding });
      } catch (e) {
        return {
          ...base,
          status: "indeterminate",
          reason: `binding publication failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
      return writeResult(base, publication, deps.index);
    },

    async read(logicalAddress, expectedOwner, verifySignature) {
      return resolveAndRead(deps.index, logicalAddress, expectedOwner, {
        read: (nativeAddress) => deps.adapter.readAnchor(nativeAddress),
        contentHashOf: artifactContentHash,
        ...(verifySignature === undefined ? {} : { verifySignature }),
      });
    },
  };
}

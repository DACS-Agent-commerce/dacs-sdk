import { isDeepStrictEqual, types as nodeTypes } from "node:util";

import { ed25519Verify, publicKeyFromRaw } from "../crypto/index.js";
import {
  canonicalizeNativeDomainHostname,
  isCanonicalDomainHostname,
} from "./domainHost.js";

const HEX_32 = /^[0-9a-f]{64}$/;
const HEX_64 = /^[0-9a-f]{128}$/;
const PROOF_PREFIX = "demos:dw2p:ed25519:";

export type DomainArtifactProfile =
  | "canonical-domain-v0.6"
  | "historical-domain-alias";

export interface DomainClaimArtifactLike {
  claims: Array<{
    ref: string;
    metadata?: Record<string, unknown>;
  }>;
  presentedBy?: string;
  [key: string]: unknown;
}

export type DomainArtifactAuthentication =
  | {
      status: "authenticated";
      /** Trusted release/profile classification, not a field read from the artifact. */
      profile: DomainArtifactProfile;
      signingPublicKey: string;
      contentHash: string;
    }
  | { status: "invalid" | "indeterminate" | "error"; reason: string };

export interface AuthenticatedDomainArtifactDeps {
  /**
   * Authenticate the exact captured artifact bytes, content hash and signature,
   * and classify its producer profile from trusted provenance.
   */
  authenticateArtifact: (
    artifact: Readonly<DomainClaimArtifactLike>,
  ) => Promise<DomainArtifactAuthentication> | DomainArtifactAuthentication;
}

export interface DomainClaimDiagnostic {
  code:
    | "authenticated"
    | "artifact-invalid"
    | "artifact-indeterminate"
    | "artifact-error"
    | "artifact-authentication-malformed"
    | "artifact-malformed"
    | "domain-reference-malformed"
    | "current-domain-noncanonical"
    | "legacy-alias-forbidden"
    | "source-unavailable"
    | "source-authentication-incomplete"
    | "source-malformed"
    | "source-record-mismatch"
    | "verification-method-mismatch"
    | "writer-authorization-unavailable"
    | "writer-authorization-malformed"
    | "writer-authorization-mismatch"
    | "validation-profile-unavailable"
    | "validation-profile-mismatch"
    | "registration-proof-invalid"
    | "persistent-evidence-expired"
    | "reported-result-malformed"
    | "reported-result-mismatch"
    | "presented-by-mismatch"
    | "presentation-control-mismatch"
    | "presentation-control-indeterminate";
  message: string;
}

export interface AuthenticatedDomainClaimRead {
  verdict: "pass" | "fail" | "indeterminate" | "error";
  diagnostic: DomainClaimDiagnostic;
  /** Original signed refs, retained byte-for-byte and never rewritten. */
  originalRefs: string[];
  /** Post-authentication DCR-5 semantic set, in first-occurrence order. */
  semanticClaims: string[];
  /** Original signed primary/presenter coordinate, retained without rewriting. */
  originalPresentedBy?: string;
  /** Post-authentication identity used for primary-claim/reputation semantics. */
  semanticPresentedBy?: string;
  authentication?: Readonly<{
    profile: DomainArtifactProfile;
    signingPublicKey: string;
    contentHash: string;
  }>;
}

export interface DemosGcrDomainMetadata {
  context: string;
  hostname: string;
  account: string;
  proofUrl: string;
  sourceTransaction: {
    txHash: string;
    blockNumber: number;
  };
  recordedAt: number;
}

export type DemosGcrResolution =
  | { status: "indeterminate"; reason: string }
  | {
      status: "authenticated";
      record: DemosGcrDomainMetadata;
      sourceAuthentication: {
        inclusionProofCoversTransaction: boolean;
        blockFinalized: boolean;
      };
      writerAuthorization?: {
        writer: string;
        authorizedAccount: string;
      };
      validationProfile?: {
        profile: string;
        proofPayload: string;
      };
    };

export interface ReportedDemosGcrResultTimes {
  verifiedAt: number;
  fetchedAt: number;
  validUntil: number;
}

export interface VerifyDemosGcrDomainDeps
  extends AuthenticatedDomainArtifactDeps {
  /** Exact method selected from authenticated recipe provenance. */
  requiredMethod: string;
  /** Authenticated recipe default; this verifier only narrows the window. */
  recipeDefaultMaxAgeSec: number;
  evaluatedAt: number;
  /**
   * Authenticate the native transaction, finalized block, record, writer and
   * consensus validation profile addressed by the bundle metadata.
   */
  resolveGcr: (
    sourceTransaction: Readonly<DemosGcrDomainMetadata["sourceTransaction"]>,
  ) => Promise<DemosGcrResolution> | DemosGcrResolution;
  /**
   * Resolve an authenticated SR-1 binding for a session-key presentation.
   * `null` means no controlling binding exists. The callback result is checked
   * against all three expected coordinates; no caller boolean is accepted.
   */
  resolvePresentationBinding?: (input: Readonly<{
    account: string;
    sessionPublicKey: string;
    presentationHash: string;
  }>) =>
    | Promise<{
        account?: unknown;
        sessionPublicKey?: unknown;
        boundPresentationHash?: unknown;
      } | null>
    | {
        account?: unknown;
        sessionPublicKey?: unknown;
        boundPresentationHash?: unknown;
      }
    | null;
  /** Optional already-reported result whose historical timestamps are checked. */
  reportedResult?: ReportedDemosGcrResultTimes;
  /** DCR-5-only callers stop after authenticated semantic-set derivation. */
  evaluationScope?: "semantic-claim-set" | "demos-gcr-domain";
}

export interface DemosGcrDomainVerification extends AuthenticatedDomainClaimRead {
  data?: Readonly<{ demosGcrDomain: DemosGcrDomainMetadata }>;
}

function diagnostic(
  code: DomainClaimDiagnostic["code"],
  message: string,
): DomainClaimDiagnostic {
  return Object.freeze({ code, message });
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value as object)) {
    return value;
  }
  seen.add(value as object);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

function freezeResult<T extends AuthenticatedDomainClaimRead>(value: T): T {
  return deepFreeze(value);
}

function result(
  verdict: AuthenticatedDomainClaimRead["verdict"],
  code: DomainClaimDiagnostic["code"],
  message: string,
  originalRefs: string[],
  semanticClaims: string[],
  authentication?: AuthenticatedDomainClaimRead["authentication"],
  presentation?: Pick<
    AuthenticatedDomainClaimRead,
    "originalPresentedBy" | "semanticPresentedBy"
  >,
): AuthenticatedDomainClaimRead {
  return freezeResult({
    verdict,
    diagnostic: diagnostic(code, message),
    originalRefs: [...originalRefs],
    semanticClaims: [...semanticClaims],
    ...(authentication ? { authentication: { ...authentication } } : {}),
    ...(presentation?.originalPresentedBy !== undefined
      ? { originalPresentedBy: presentation.originalPresentedBy }
      : {}),
    ...(presentation?.semanticPresentedBy !== undefined
      ? { semanticPresentedBy: presentation.semanticPresentedBy }
      : {}),
  });
}

function cloneArtifact(value: unknown): DomainClaimArtifactLike | null {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  ) {
    return null;
  }
  try {
    const cloned = structuredClone(value) as DomainClaimArtifactLike;
    if (
      cloned === null ||
      typeof cloned !== "object" ||
      Array.isArray(cloned) ||
      !Array.isArray(cloned.claims) ||
      cloned.claims.length === 0 ||
      cloned.claims.some(
        (claim) =>
          claim === null ||
          typeof claim !== "object" ||
          Array.isArray(claim) ||
          typeof claim.ref !== "string",
      )
    ) {
      return null;
    }
    return deepFreeze(cloned);
  } catch {
    return null;
  }
}

function authenticatedCoordinates(
  auth: DomainArtifactAuthentication,
): NonNullable<AuthenticatedDomainClaimRead["authentication"]> | null {
  if (
    auth.status !== "authenticated" ||
    (auth.profile !== "canonical-domain-v0.6" &&
      auth.profile !== "historical-domain-alias") ||
    !HEX_32.test(auth.signingPublicKey) ||
    !HEX_32.test(auth.contentHash)
  ) {
    return null;
  }
  return {
    profile: auth.profile,
    signingPublicKey: auth.signingPublicKey,
    contentHash: auth.contentHash,
  };
}

type SemanticDerivation =
  | { ok: true; semanticClaims: string[]; policyViolation?: DomainClaimDiagnostic }
  | { ok: false; diagnostic: DomainClaimDiagnostic };

function deriveSemanticDomainClaims(
  refs: readonly string[],
  profile: DomainArtifactProfile,
): SemanticDerivation {
  const semanticClaims: string[] = [];
  let policyViolation: DomainClaimDiagnostic | undefined;
  for (const ref of refs) {
    let hostname: string | null = null;
    let isLegacy = false;
    if (ref.startsWith("domain:")) {
      const originalHost = ref.slice("domain:".length);
      if (isCanonicalDomainHostname(originalHost)) {
        hostname = originalHost;
      } else {
        hostname = canonicalizeNativeDomainHostname(originalHost);
        if (hostname === null) {
          return {
            ok: false,
            diagnostic: diagnostic(
              "domain-reference-malformed",
              `domain reference is not a DCR-1 hostname: ${ref}`,
            ),
          };
        }
        policyViolation ??= diagnostic(
          "current-domain-noncanonical",
          "a current domain reference must already use exact lower-case ASCII A-label spelling",
        );
      }
    } else if (ref.startsWith("web2:domain:")) {
      isLegacy = true;
      hostname = canonicalizeNativeDomainHostname(
        ref.slice("web2:domain:".length),
      );
      if (hostname === null) {
        return {
          ok: false,
          diagnostic: diagnostic(
            "domain-reference-malformed",
            `historical domain alias is not a DCR-1 hostname: ${ref}`,
          ),
        };
      }
    } else if (/^(?:domain|web2:domain):/i.test(ref)) {
      const colon = ref.toLowerCase().startsWith("web2:domain:")
        ? "web2:domain:".length
        : "domain:".length;
      const repaired = canonicalizeNativeDomainHostname(ref.slice(colon));
      if (repaired === null) {
        return {
          ok: false,
          diagnostic: diagnostic(
            "domain-reference-malformed",
            `domain reference is not a DCR-1 hostname: ${ref}`,
          ),
        };
      }
      hostname = repaired;
      policyViolation ??= diagnostic(
        "current-domain-noncanonical",
        "domain ClaimReference scheme spelling is not canonical",
      );
    } else {
      continue;
    }

    const semantic = `domain:${hostname}`;
    if (!semanticClaims.includes(semantic)) semanticClaims.push(semantic);
    if (isLegacy && profile === "canonical-domain-v0.6") {
      policyViolation ??= diagnostic(
        "legacy-alias-forbidden",
        "the authenticated current producer profile cannot emit web2:domain aliases",
      );
    }
  }
  return { ok: true, semanticClaims, ...(policyViolation ? { policyViolation } : {}) };
}

/**
 * Verify the enclosing artifact first, then and only then fold historical
 * aliases and deduplicate its semantic domain set. Signature failure always
 * returns an empty semantic set.
 */
export async function readAuthenticatedDomainClaims(
  artifactSource: DomainClaimArtifactLike,
  deps: AuthenticatedDomainArtifactDeps,
): Promise<AuthenticatedDomainClaimRead> {
  const artifact = cloneArtifact(artifactSource);
  if (artifact === null) {
    return result(
      "error",
      "artifact-malformed",
      "domain claim artifact must be cloneable JSON with a non-empty claims array",
      [],
      [],
    );
  }
  const originalRefs = artifact.claims.map((claim) => claim.ref);
  const originalPresentedBy = typeof artifact.presentedBy === "string"
    ? artifact.presentedBy
    : undefined;
  const originalPresentation = originalPresentedBy === undefined
    ? undefined
    : { originalPresentedBy };
  let auth: DomainArtifactAuthentication;
  try {
    auth = structuredClone(await deps.authenticateArtifact(artifact));
  } catch {
    return result(
      "indeterminate",
      "artifact-indeterminate",
      "artifact authentication did not complete",
      originalRefs,
      [],
      undefined,
      originalPresentation,
    );
  }
  if (
    auth === null ||
    typeof auth !== "object" ||
    Array.isArray(auth) ||
    !("status" in auth)
  ) {
    return result(
      "error",
      "artifact-authentication-malformed",
      "artifact authenticator returned a malformed result",
      originalRefs,
      [],
      undefined,
      originalPresentation,
    );
  }
  if (auth.status !== "authenticated") {
    if (
      (auth.status !== "invalid" &&
        auth.status !== "indeterminate" &&
        auth.status !== "error") ||
      typeof auth.reason !== "string"
    ) {
      return result(
        "error",
        "artifact-authentication-malformed",
        "artifact authenticator returned a malformed result",
        originalRefs,
        [],
        undefined,
        originalPresentation,
      );
    }
    return result(
      auth.status === "invalid" ? "fail" : auth.status,
      auth.status === "invalid"
        ? "artifact-invalid"
        : auth.status === "indeterminate"
          ? "artifact-indeterminate"
          : "artifact-error",
      auth.reason,
      originalRefs,
      [],
      undefined,
      originalPresentation,
    );
  }
  const authentication = authenticatedCoordinates(auth);
  if (authentication === null) {
    return result(
      "error",
      "artifact-authentication-malformed",
      "authenticated artifact coordinates are malformed",
      originalRefs,
      [],
      undefined,
      originalPresentation,
    );
  }
  const derived = deriveSemanticDomainClaims(
    originalRefs,
    authentication.profile,
  );
  if (!derived.ok) {
    return result(
      "error",
      derived.diagnostic.code,
      derived.diagnostic.message,
      originalRefs,
      [],
      authentication,
      originalPresentation,
    );
  }
  let semanticPresentedBy = originalPresentedBy;
  let presentationPolicyViolation: DomainClaimDiagnostic | undefined;
  if (
    originalPresentedBy !== undefined &&
    /^(?:domain|web2:domain):/i.test(originalPresentedBy)
  ) {
    const presented = deriveSemanticDomainClaims(
      [originalPresentedBy],
      authentication.profile,
    );
    if (!presented.ok) {
      return result(
        "error",
        presented.diagnostic.code,
        presented.diagnostic.message,
        originalRefs,
        [],
        authentication,
        originalPresentation,
      );
    }
    semanticPresentedBy = presented.semanticClaims[0];
    presentationPolicyViolation = presented.policyViolation;
    if (
      semanticPresentedBy === undefined ||
      !derived.semanticClaims.includes(semanticPresentedBy)
    ) {
      return result(
        "fail",
        "presented-by-mismatch",
        "semantic presentedBy does not resolve to a carried domain claim",
        originalRefs,
        derived.semanticClaims,
        authentication,
        {
          originalPresentedBy,
          ...(semanticPresentedBy ? { semanticPresentedBy } : {}),
        },
      );
    }
  }
  const presentation = originalPresentedBy === undefined
    ? undefined
    : {
        originalPresentedBy,
        ...(semanticPresentedBy !== undefined ? { semanticPresentedBy } : {}),
      };
  const policyViolation = derived.policyViolation ?? presentationPolicyViolation;
  if (policyViolation) {
    return result(
      "fail",
      policyViolation.code,
      policyViolation.message,
      originalRefs,
      derived.semanticClaims,
      authentication,
      presentation,
    );
  }
  return result(
    "pass",
    "authenticated",
    "artifact authenticated before domain semantic derivation",
    originalRefs,
    derived.semanticClaims,
    authentication,
    presentation,
  );
}

function isSafeTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function parseMetadata(value: unknown): DemosGcrDomainMetadata | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const transaction = record.sourceTransaction;
  if (
    typeof record.context !== "string" ||
    typeof record.hostname !== "string" ||
    !isCanonicalDomainHostname(record.hostname) ||
    typeof record.account !== "string" ||
    !HEX_32.test(record.account) ||
    typeof record.proofUrl !== "string" ||
    !isSafeTimestamp(record.recordedAt) ||
    transaction === null ||
    typeof transaction !== "object" ||
    Array.isArray(transaction)
  ) {
    return null;
  }
  const tx = transaction as Record<string, unknown>;
  if (
    typeof tx.txHash !== "string" ||
    !HEX_32.test(tx.txHash) ||
    !Number.isSafeInteger(tx.blockNumber) ||
    (tx.blockNumber as number) < 0
  ) {
    return null;
  }
  return {
    context: record.context,
    hostname: record.hostname,
    account: record.account,
    proofUrl: record.proofUrl,
    sourceTransaction: {
      txHash: tx.txHash,
      blockNumber: tx.blockNumber as number,
    },
    recordedAt: record.recordedAt,
  };
}

function withData(
  base: AuthenticatedDomainClaimRead,
  metadata?: DemosGcrDomainMetadata,
): DemosGcrDomainVerification {
  return freezeResult({
    ...base,
    originalRefs: [...base.originalRefs],
    semanticClaims: [...base.semanticClaims],
    ...(metadata
      ? { data: { demosGcrDomain: structuredClone(metadata) } }
      : {}),
  });
}

function sourceResult(
  base: AuthenticatedDomainClaimRead,
  verdict: AuthenticatedDomainClaimRead["verdict"],
  code: DomainClaimDiagnostic["code"],
  message: string,
  metadata?: DemosGcrDomainMetadata,
): DemosGcrDomainVerification {
  return withData(
    result(
      verdict,
      code,
      message,
      base.originalRefs,
      base.semanticClaims,
      base.authentication,
      {
        ...(base.originalPresentedBy !== undefined
          ? { originalPresentedBy: base.originalPresentedBy }
          : {}),
        ...(base.semanticPresentedBy !== undefined
          ? { semanticPresentedBy: base.semanticPresentedBy }
          : {}),
      },
    ),
    metadata,
  );
}

function registrationProofValid(
  metadata: DemosGcrDomainMetadata,
  validation: { profile: string; proofPayload: string },
): boolean {
  if (
    validation.profile !== "demos-web2-domain-v1" ||
    !validation.proofPayload.startsWith(PROOF_PREFIX)
  ) {
    return false;
  }
  const signatureHex = validation.proofPayload.slice(PROOF_PREFIX.length);
  if (!HEX_64.test(signatureHex)) return false;
  const message = Buffer.from(
    `dacs-domain:v1:${metadata.hostname}:${metadata.account}`,
    "utf8",
  );
  try {
    return ed25519Verify(
      message,
      Buffer.from(signatureHex, "hex"),
      publicKeyFromRaw(Buffer.from(metadata.account, "hex")),
    );
  } catch {
    return false;
  }
}

/**
 * DACS-1 DCR-1..DCR-8 plus DACS-2 DGCR-1..DGCR-6 verifier. It composes an
 * enclosing-artifact authenticator with authenticated native GCR resolution;
 * neither untrusted metadata nor a caller-supplied boolean can cross either
 * authority boundary.
 */
export async function verifyDemosGcrDomainClaims(
  artifactSource: DomainClaimArtifactLike,
  deps: VerifyDemosGcrDomainDeps,
): Promise<DemosGcrDomainVerification> {
  const artifact = cloneArtifact(artifactSource);
  if (artifact === null) {
    return withData(
      result(
        "error",
        "artifact-malformed",
        "domain claim artifact must be cloneable JSON with a non-empty claims array",
        [],
        [],
      ),
    );
  }
  const base = await readAuthenticatedDomainClaims(artifact, deps);
  if (base.verdict !== "pass") return withData(base);
  if (deps.evaluationScope === "semantic-claim-set") return withData(base);
  if (base.semanticClaims.length !== 1) {
    return sourceResult(
      base,
      "error",
      "source-malformed",
      "demos-gcr-domain verification requires exactly one semantic domain claim",
    );
  }
  if (
    !isSafeTimestamp(deps.evaluatedAt) ||
    !Number.isSafeInteger(deps.recipeDefaultMaxAgeSec) ||
    deps.recipeDefaultMaxAgeSec < 0
  ) {
    return sourceResult(
      base,
      "error",
      "source-malformed",
      "authenticated recipe time inputs are malformed",
    );
  }
  if (deps.requiredMethod !== "demos-gcr-domain") {
    return sourceResult(
      base,
      "fail",
      "verification-method-mismatch",
      "persistent GCR evidence cannot satisfy a different verification method",
    );
  }

  const firstClaim = artifact.claims[0]!;
  const rawMetadata = firstClaim.metadata?.demosGcrDomain;
  const metadata = parseMetadata(rawMetadata);
  if (metadata === null) {
    return sourceResult(
      base,
      "error",
      "source-malformed",
      "bundle demosGcrDomain metadata is malformed",
    );
  }
  if (
    metadata.context !== "web2.domain" ||
    base.semanticClaims[0] !== `domain:${metadata.hostname}` ||
    metadata.proofUrl !==
      `https://${metadata.hostname}/.well-known/demos-cci.txt`
  ) {
    return sourceResult(
      base,
      "fail",
      "source-record-mismatch",
      "bundle domain claim does not exactly match its GCR metadata",
    );
  }

  let resolvedValue: unknown;
  try {
    resolvedValue = structuredClone(
      await deps.resolveGcr(
        deepFreeze(structuredClone(metadata.sourceTransaction)),
      ),
    );
  } catch {
    return sourceResult(
      base,
      "indeterminate",
      "source-unavailable",
      "authenticated GCR resolution did not complete",
    );
  }
  if (
    resolvedValue === null ||
    typeof resolvedValue !== "object" ||
    Array.isArray(resolvedValue) ||
    !("status" in resolvedValue)
  ) {
    return sourceResult(
      base,
      "error",
      "source-malformed",
      "authenticated GCR resolver returned a malformed result",
    );
  }
  const resolved = resolvedValue as DemosGcrResolution;
  if (resolved.status === "indeterminate") {
    if (typeof resolved.reason !== "string") {
      return sourceResult(
        base,
        "error",
        "source-malformed",
        "authenticated GCR resolver returned a malformed indeterminate result",
      );
    }
    return sourceResult(
      base,
      "indeterminate",
      "source-unavailable",
      resolved.reason,
    );
  }
  if (
    resolved.status !== "authenticated" ||
    resolved.sourceAuthentication?.inclusionProofCoversTransaction !== true ||
    resolved.sourceAuthentication?.blockFinalized !== true
  ) {
    return sourceResult(
      base,
      "indeterminate",
      "source-authentication-incomplete",
      "GCR transaction inclusion and finalized block are not both authenticated",
    );
  }
  const authoritative = parseMetadata(resolved.record);
  if (authoritative === null) {
    return sourceResult(
      base,
      "error",
      "source-malformed",
      "authenticated GCR record is malformed",
    );
  }
  if (!isDeepStrictEqual(rawMetadata, resolved.record)) {
    return sourceResult(
      base,
      "fail",
      "source-record-mismatch",
      "bundle metadata does not equal the authenticated native GCR record",
    );
  }

  const writer = resolved.writerAuthorization;
  if (writer === undefined) {
    return sourceResult(
      base,
      "indeterminate",
      "writer-authorization-unavailable",
      "authenticated GCR writer authorization is unavailable",
    );
  }
  if (
    writer === null ||
    typeof writer !== "object" ||
    !HEX_32.test(writer.writer) ||
    !HEX_32.test(writer.authorizedAccount)
  ) {
    return sourceResult(
      base,
      "error",
      "writer-authorization-malformed",
      "authenticated GCR writer authorization is malformed",
    );
  }
  if (writer.authorizedAccount !== authoritative.account) {
    return sourceResult(
      base,
      "fail",
      "writer-authorization-mismatch",
      "authenticated writer is not authorized for the GCR-bound account",
    );
  }

  const validation = resolved.validationProfile;
  if (validation === undefined) {
    return sourceResult(
      base,
      "indeterminate",
      "validation-profile-unavailable",
      "consensus validation-profile provenance is unavailable",
    );
  }
  if (
    validation === null ||
    typeof validation !== "object" ||
    typeof validation.profile !== "string" ||
    typeof validation.proofPayload !== "string"
  ) {
    return sourceResult(
      base,
      "error",
      "source-malformed",
      "authenticated validation-profile provenance is malformed",
    );
  }
  if (validation.profile !== "demos-web2-domain-v1") {
    return sourceResult(
      base,
      "fail",
      "validation-profile-mismatch",
      "authenticated transition used a different validation profile",
    );
  }
  if (!registrationProofValid(authoritative, validation)) {
    return sourceResult(
      base,
      "fail",
      "registration-proof-invalid",
      "authenticated domain registration proof is invalid",
    );
  }

  const maxAgeMs = deps.recipeDefaultMaxAgeSec * 1_000;
  const validUntil = authoritative.recordedAt + maxAgeMs;
  if (!Number.isSafeInteger(maxAgeMs) || !Number.isSafeInteger(validUntil)) {
    return sourceResult(
      base,
      "error",
      "source-malformed",
      "persistent GCR freshness window is outside the safe integer range",
    );
  }
  if (deps.evaluatedAt > validUntil) {
    return sourceResult(
      base,
      "fail",
      "persistent-evidence-expired",
      "persistent GCR evidence is outside its authenticated inclusion window",
    );
  }

  if (deps.reportedResult !== undefined) {
    const reported = deps.reportedResult;
    if (
      !isSafeTimestamp(reported.verifiedAt) ||
      !isSafeTimestamp(reported.fetchedAt) ||
      !isSafeTimestamp(reported.validUntil)
    ) {
      return sourceResult(
        base,
        "error",
        "reported-result-malformed",
        "reported demos-gcr-domain timestamps are malformed",
      );
    }
    if (
      reported.verifiedAt !== authoritative.recordedAt ||
      reported.fetchedAt !== deps.evaluatedAt ||
      reported.validUntil > validUntil
    ) {
      return sourceResult(
        base,
        "fail",
        "reported-result-mismatch",
        "reported demos-gcr-domain timestamps do not preserve the inclusion window",
      );
    }
  }

  const authentication = base.authentication!;
  if (authentication.signingPublicKey !== authoritative.account) {
    if (!deps.resolvePresentationBinding) {
      return sourceResult(
        base,
        "fail",
        "presentation-control-mismatch",
        "bundle presentation is not controlled by the GCR-bound account",
      );
    }
    let binding: Awaited<ReturnType<NonNullable<
      VerifyDemosGcrDomainDeps["resolvePresentationBinding"]
    >>>;
    try {
      binding = structuredClone(await deps.resolvePresentationBinding(
        deepFreeze({
          account: authoritative.account,
          sessionPublicKey: authentication.signingPublicKey,
          presentationHash: authentication.contentHash,
        }),
      ));
    } catch {
      return sourceResult(
        base,
        "indeterminate",
        "presentation-control-indeterminate",
        "authenticated SR-1 presentation binding could not be resolved",
      );
    }
    if (
      binding === null ||
      typeof binding !== "object" ||
      Array.isArray(binding) ||
      binding.account !== authoritative.account ||
      binding.sessionPublicKey !== authentication.signingPublicKey ||
      binding.boundPresentationHash !== authentication.contentHash
    ) {
      return sourceResult(
        base,
        "fail",
        "presentation-control-mismatch",
        "SR-1 binding does not control this exact presentation",
      );
    }
  }

  return withData(
    result(
      "pass",
      "authenticated",
      "domain claim, native GCR source and presentation control are authenticated",
      base.originalRefs,
      base.semanticClaims,
      base.authentication,
      {
        ...(base.originalPresentedBy !== undefined
          ? { originalPresentedBy: base.originalPresentedBy }
          : {}),
        ...(base.semanticPresentedBy !== undefined
          ? { semanticPresentedBy: base.semanticPresentedBy }
          : {}),
      },
    ),
    authoritative,
  );
}

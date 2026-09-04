/**
 * DACS-2 → DACS-5 bridge for an authenticated terminal Vet decision.
 *
 * This module does not perform Vet and does not own either party's signer. It accepts the exact
 * finalized `VetProduction`, asks a caller-supplied verifier to authenticate that production,
 * and converts only an objective `fail` decision into the data-only authority consumed by the
 * role-local terminal-bundle coordinator. `indeterminate` and `error` remain non-terminal.
 */
import { types as nodeTypes } from "node:util";

import type {
  AttestationRef,
  CompositeVerificationRecord,
  IdentityBundle,
  ListingRef,
  PhaseStep,
} from "../artifacts/types.js";
import {
  isAttestationRef,
  isCompositeVerificationRecord,
  isIdentityBundle,
  isPhaseStep,
} from "../artifacts/index.js";
import { canonicalize, contentHash, sha256Hex } from "../canonical/index.js";
import { DacsError } from "../errors.js";
import {
  identityBundleHash,
  sameCanonicalClaimIdentity,
} from "../identity/index.js";
import { requireCanonicalJobId } from "../negotiate/jobId.js";
import {
  compositeVerificationAddress,
  isFinalizedVetAnchorReceipt,
  type VetProduction,
} from "./vetCore.js";
import {
  createTerminalBundleAuthority,
  type TerminalBundleAuthority,
  type VerifiedTerminalBundleParty,
} from "./terminalBundleFinalization.js";

const HASH_RE = /^[0-9a-f]{64}$/;

export interface VetTerminalSessionParty {
  role: "buyer" | "seller";
  identityBundle: Readonly<IdentityBundle>;
}

export interface VetFailureTerminalSessionRecord {
  recordVersion: "1";
  jobId: string;
  state: "vet-failed";
  listingRef: Readonly<ListingRef>;
  parties: readonly Readonly<{
    role: "buyer" | "seller";
    bundleHash: string;
    primaryClaim: string;
    vetRecordRef?: Readonly<AttestationRef>;
  }>[];
  pipeline: readonly Readonly<PhaseStep>[];
  phaseResults: readonly Readonly<{
    index: number;
    step: Readonly<PhaseStep>;
    invokedAt: number;
    result: Readonly<{
      ok: false;
      reason: "authenticated-vet-failure";
      attestationRef: Readonly<AttestationRef>;
      errorClass: "counterparty";
    }>;
    contextDelta: Readonly<Record<string, never>>;
  }>[];
  startedAt: number;
  lastUpdatedAt: number;
  endedAt: number;
  recipeRegistryVersion: number;
  railRegistryVersion: number;
}

export interface PrepareVetTerminalBundleInput {
  jobId: string;
  listingRef: Readonly<ListingRef>;
  pipeline: readonly Readonly<PhaseStep>[];
  vetPhaseIndex: number;
  vetInvokedAt: number;
  startedAt: number;
  recipeRegistryVersion: number;
  railRegistryVersion: number;
  parties: readonly Readonly<VetTerminalSessionParty>[];
  evaluatedRole: "buyer" | "seller";
  production: Readonly<VetProduction>;
}

export type VetProductionAuthentication =
  | Readonly<{ status: "valid" }>
  | Readonly<{ status: "invalid"; reason: string }>
  | Readonly<{ status: "indeterminate"; reason: string }>;

export interface PrepareVetTerminalBundleDeps {
  /**
   * Authenticate the CVR signature, its complete VerifyResult/recipe/authority closure, and the
   * finalized CVR anchor/readback. Returning `valid` is a trust boundary, not an advisory hook.
   */
  authenticateProduction(input: Readonly<{
    production: Readonly<VetProduction>;
    evaluatedIdentity: Readonly<IdentityBundle>;
    verifierIdentity: Readonly<IdentityBundle>;
  }>): Promise<VetProductionAuthentication> | VetProductionAuthentication;
}

export type PreparedVetTerminalBundle =
  | Readonly<{
      status: "pass";
      record: Readonly<CompositeVerificationRecord>;
    }>
  | Readonly<{
      status: "retry";
      decision: "indeterminate" | "error";
      record: Readonly<CompositeVerificationRecord>;
    }>
  | Readonly<{
      status: "invalid" | "indeterminate";
      reason: string;
    }>
  | Readonly<{
      status: "terminal";
      state: "vet-failed";
      faultedParty: "buyer" | "seller";
      sessionRecord: Readonly<VetFailureTerminalSessionRecord>;
      authority: Readonly<TerminalBundleAuthority>;
    }>;

function isSafeUint(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 &&
    !Object.is(value, -0);
}

function isPositiveSafeInt(value: unknown): value is number {
  return isSafeUint(value) && value > 0;
}

function snapshotData(
  value: unknown,
  label: string,
  seen = new WeakSet<object>(),
): unknown {
  if (value === null || typeof value !== "object") {
    if (value === undefined || typeof value === "function" || typeof value === "symbol" ||
        typeof value === "bigint" ||
        (typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0)))) {
      throw new DacsError(`${label} must contain exact canonical JSON data`);
    }
    return value;
  }
  if (nodeTypes.isProxy(value) || seen.has(value)) {
    throw new DacsError(`${label} must contain acyclic, non-proxy JSON data`);
  }
  seen.add(value);
  try {
    const prototype = Object.getPrototypeOf(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      throw new DacsError(`${label} cannot contain symbol fields`);
    }
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) {
        throw new DacsError(`${label} arrays must use the intrinsic prototype`);
      }
      const keys = Object.keys(descriptors).filter((key) => key !== "length");
      if (keys.length !== value.length ||
          keys.some((key, index) => key !== String(index))) {
        throw new DacsError(`${label} arrays must be dense exact arrays`);
      }
      return keys.map((key) => {
        const descriptor = descriptors[key]!;
        if (!descriptor.enumerable || !("value" in descriptor)) {
          throw new DacsError(`${label} cannot contain accessors or hidden values`);
        }
        return snapshotData(descriptor.value, `${label}[${key}]`, seen);
      });
    }
    if (prototype !== Object.prototype && prototype !== null) {
      throw new DacsError(`${label} objects must use a plain prototype`);
    }
    const result: Record<string, unknown> = {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable || !("value" in descriptor) || descriptor.value === undefined) {
        throw new DacsError(`${label} cannot contain accessors, hidden, or undefined values`);
      }
      result[key] = snapshotData(descriptor.value, `${label}.${key}`, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function canonicalSnapshot<T>(value: T, label: string): T {
  try {
    return JSON.parse(canonicalize(snapshotData(value, label))) as T;
  } catch (error) {
    if (error instanceof DacsError) throw error;
    throw new DacsError(`${label} must contain exact canonical JSON data`, { cause: error });
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

function validListingRef(value: unknown): value is ListingRef {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === 3 &&
    typeof (value as ListingRef).listingId === "string" &&
    (value as ListingRef).listingId.length > 0 &&
    isPositiveSafeInt((value as ListingRef).version) &&
    typeof (value as ListingRef).contentHash === "string" &&
    HASH_RE.test((value as ListingRef).contentHash);
}

function captureInput(source: Readonly<PrepareVetTerminalBundleInput>): PrepareVetTerminalBundleInput {
  const input = canonicalSnapshot(source, "Vet terminal input");
  if (Object.keys(input).length !== 11 ||
      ![
        "jobId", "listingRef", "pipeline", "vetPhaseIndex", "vetInvokedAt", "startedAt",
        "recipeRegistryVersion", "railRegistryVersion", "parties", "evaluatedRole",
        "production",
      ].every((key) => Object.hasOwn(input, key)) ||
      typeof input.jobId !== "string" || input.jobId.length === 0 ||
      !validListingRef(input.listingRef) || !Array.isArray(input.pipeline) ||
      input.pipeline.length === 0 || !input.pipeline.every(isPhaseStep) ||
      !isSafeUint(input.vetPhaseIndex) || input.vetPhaseIndex >= input.pipeline.length ||
      input.pipeline[input.vetPhaseIndex]?.kind !== "vet-credentials" ||
      !isSafeUint(input.startedAt) || !isSafeUint(input.vetInvokedAt) ||
      input.vetInvokedAt < input.startedAt ||
      !isPositiveSafeInt(input.recipeRegistryVersion) ||
      !isPositiveSafeInt(input.railRegistryVersion) ||
      !Array.isArray(input.parties) || input.parties.length !== 2 ||
      (input.evaluatedRole !== "buyer" && input.evaluatedRole !== "seller") ||
      !isCompositeVerificationRecord(input.production?.record) ||
      !isAttestationRef(input.production?.recordRef) ||
      !isFinalizedVetAnchorReceipt(input.production?.anchorReceipt)) {
    throw new DacsError("Vet terminal input is malformed");
  }
  requireCanonicalJobId(input.jobId, "Vet terminal jobId");
  const roles = input.parties.map((party) => party.role);
  if (roles[0] !== "buyer" || roles[1] !== "seller" || new Set(roles).size !== 2 ||
      input.parties.some((party) => Object.keys(party).length !== 2 ||
        !Object.hasOwn(party, "role") || !Object.hasOwn(party, "identityBundle") ||
        !isIdentityBundle(party.identityBundle)) ||
      Object.keys(input.production).length !== 3 ||
      !["record", "recordRef", "anchorReceipt"].every((key) =>
        Object.hasOwn(input.production, key)) ||
      input.pipeline.some((step) => Object.keys(step).some((key) =>
        key !== "kind" && key !== "parameters"))) {
    throw new DacsError("Vet terminal input requires exact buyer and seller IdentityBundles");
  }
  const claims = input.parties.map((party) => party.identityBundle.presentedBy);
  if (sameCanonicalClaimIdentity(claims[0], claims[1])) {
    throw new DacsError("Vet terminal buyer and seller identities must be distinct");
  }
  return input;
}

function assertProductionBindings(
  input: Readonly<PrepareVetTerminalBundleInput>,
  evaluated: Readonly<VetTerminalSessionParty>,
  verifier: Readonly<VetTerminalSessionParty>,
): void {
  const { production } = input;
  const { record, recordRef, anchorReceipt } = production;
  const recordHash = contentHash(record as unknown as Record<string, unknown>);
  const logicalAddress = compositeVerificationAddress(
    input.jobId,
    evaluated.identityBundle.presentedBy,
  );
  if (record.jobId !== input.jobId ||
      !sameCanonicalClaimIdentity(record.evaluatedParty,
        evaluated.identityBundle.presentedBy) ||
      record.bundleHash !== identityBundleHash(evaluated.identityBundle) ||
      !sameCanonicalClaimIdentity(record.signature.signer,
        verifier.identityBundle.presentedBy) ||
      recordRef.anchor.kind !== "storage-program" ||
      recordRef.anchor.locator !== anchorReceipt.nativeAddress ||
      recordRef.contentHash !== recordHash ||
      !sameCanonicalClaimIdentity(recordRef.signer,
        verifier.identityBundle.presentedBy) ||
      anchorReceipt.logicalAddress !== logicalAddress ||
      anchorReceipt.contentHash !== recordHash ||
      !sameCanonicalClaimIdentity(anchorReceipt.writer,
        verifier.identityBundle.presentedBy) ||
      anchorReceipt.state !== "finalized" ||
      anchorReceipt.observationDisposition !== "established") {
    throw new DacsError("Vet production is not bound to the exact session roles and anchor");
  }
}

function captureAuthentication(value: unknown): VetProductionAuthentication {
  const result = canonicalSnapshot(value, "Vet production authentication") as
    VetProductionAuthentication;
  if (result.status === "valid" && Object.keys(result).length === 1) return result;
  if ((result.status === "invalid" || result.status === "indeterminate") &&
      Object.keys(result).length === 2 && typeof result.reason === "string" &&
      result.reason.length > 0) return result;
  throw new DacsError("Vet production authenticator returned a malformed result");
}

function captureAuthenticator(
  deps: Readonly<PrepareVetTerminalBundleDeps>,
): PrepareVetTerminalBundleDeps["authenticateProduction"] {
  if (deps === null || typeof deps !== "object" || nodeTypes.isProxy(deps) ||
      (Object.getPrototypeOf(deps) !== Object.prototype &&
        Object.getPrototypeOf(deps) !== null) ||
      Object.getOwnPropertySymbols(deps).length !== 0) {
    throw new DacsError("Vet terminal preparation requires a stable authenticator");
  }
  const descriptors = Object.getOwnPropertyDescriptors(deps);
  const descriptor = descriptors.authenticateProduction;
  if (Object.keys(descriptors).length !== 1 || descriptor === undefined ||
      !descriptor.enumerable || !("value" in descriptor) ||
      typeof descriptor.value !== "function") {
    throw new DacsError("Vet terminal preparation requires a stable authenticator");
  }
  return descriptor.value as PrepareVetTerminalBundleDeps["authenticateProduction"];
}

/**
 * Authenticate and classify one role-owned Vet production. Only a finalized, recursively
 * authenticated `fail` decision enters DACS-5 `vet-failed` and creates terminal authority.
 */
export async function prepareVetTerminalBundle(
  source: Readonly<PrepareVetTerminalBundleInput>,
  deps: Readonly<PrepareVetTerminalBundleDeps>,
): Promise<PreparedVetTerminalBundle> {
  const input = captureInput(source);
  const authenticateProduction = captureAuthenticator(deps);
  const evaluated = input.parties.find((party) => party.role === input.evaluatedRole)!;
  const verifier = input.parties.find((party) => party.role !== input.evaluatedRole)!;
  assertProductionBindings(input, evaluated, verifier);

  let rawAuthentication: unknown;
  try {
    rawAuthentication = await Reflect.apply(authenticateProduction, undefined, [deepFreeze({
      production: deepFreeze(canonicalSnapshot(input.production, "Vet production")),
      evaluatedIdentity: deepFreeze(canonicalSnapshot(
        evaluated.identityBundle,
        "evaluated IdentityBundle",
      )),
      verifierIdentity: deepFreeze(canonicalSnapshot(
        verifier.identityBundle,
        "verifier IdentityBundle",
      )),
    })]);
  } catch {
    return deepFreeze({
      status: "indeterminate",
      reason: "Vet production authentication failed",
    });
  }
  const authentication = captureAuthentication(rawAuthentication);
  if (authentication.status !== "valid") return deepFreeze(authentication);

  const record = deepFreeze(canonicalSnapshot(input.production.record, "Vet record"));
  if (record.overallDecision === "pass") return deepFreeze({ status: "pass", record });
  if (record.overallDecision === "indeterminate" || record.overallDecision === "error") {
    return deepFreeze({ status: "retry", decision: record.overallDecision, record });
  }
  if (record.overallDecision !== "fail") {
    throw new DacsError("authenticated Vet record carries an unsupported decision");
  }

  const endedAt = input.production.anchorReceipt.observedAt;
  if (!isSafeUint(endedAt) || endedAt < input.vetInvokedAt || endedAt < record.generatedAt) {
    throw new DacsError("Vet terminal time precedes the authenticated phase evidence");
  }
  const parties = input.parties.map((party) => ({
    role: party.role,
    bundleHash: identityBundleHash(party.identityBundle),
    primaryClaim: party.identityBundle.presentedBy,
    ...(party.role === input.evaluatedRole
      ? { vetRecordRef: input.production.recordRef }
      : {}),
  }));
  const sessionRecord: VetFailureTerminalSessionRecord = {
    recordVersion: "1",
    jobId: input.jobId,
    state: "vet-failed",
    listingRef: input.listingRef,
    parties,
    pipeline: input.pipeline,
    phaseResults: [{
      index: input.vetPhaseIndex,
      step: input.pipeline[input.vetPhaseIndex]!,
      invokedAt: input.vetInvokedAt,
      result: {
        ok: false,
        reason: "authenticated-vet-failure",
        attestationRef: input.production.recordRef,
        errorClass: "counterparty",
      },
      contextDelta: {},
    }],
    startedAt: input.startedAt,
    lastUpdatedAt: endedAt,
    endedAt,
    recipeRegistryVersion: input.recipeRegistryVersion,
    railRegistryVersion: input.railRegistryVersion,
  };
  const frozenSession = deepFreeze(canonicalSnapshot(sessionRecord, "Vet terminal SessionRecord"));
  const verifiedParties: VerifiedTerminalBundleParty[] = input.parties.map((party) => ({
    role: party.role,
    identityBundle: party.identityBundle,
  }));
  const productionEvidence = {
    record,
    recordRef: input.production.recordRef,
    anchorReceipt: input.production.anchorReceipt,
  };
  const authority = createTerminalBundleAuthority({
    jobId: input.jobId,
    terminalClass: "failure",
    faultedParty: input.evaluatedRole,
    terminalPhase: {
      index: input.vetPhaseIndex,
      kind: "vet-credentials",
      state: "failed",
      errorClass: "counterparty",
    },
    sessionRecordHash: sha256Hex(canonicalize(frozenSession)),
    terminalEvidenceHash: sha256Hex(canonicalize(productionEvidence)),
    dependencySetHash: sha256Hex(canonicalize({
      listingRef: input.listingRef,
      parties: parties.map(({ role, bundleHash, primaryClaim }) => ({
        role,
        bundleHash,
        primaryClaim,
      })),
      vetRecords: [input.production.recordRef],
      finalizedReceipts: [input.production.anchorReceipt],
    })),
    listingRef: input.listingRef,
    parties: verifiedParties,
    phaseSummary: [{
      index: input.vetPhaseIndex,
      kind: "vet-credentials",
      outcome: "fail",
      errorClass: "counterparty",
      attestationRef: input.production.recordRef,
    }],
    vetRecords: [input.production.recordRef],
    settlementEvidence: [],
    recipeRegistryVersion: input.recipeRegistryVersion,
    railRegistryVersion: input.railRegistryVersion,
    finalisedAt: endedAt,
  });
  return deepFreeze({
    status: "terminal",
    state: "vet-failed",
    faultedParty: input.evaluatedRole,
    sessionRecord: frozenSession,
    authority,
  });
}

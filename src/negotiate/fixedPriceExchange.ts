import { types as nodeTypes } from "node:util";

import type {
  AgreementArtifact,
  AgreementSignature,
  ComponentSignatureAlgorithm,
} from "../artifacts/types.js";
import {
  COMPONENT_SIGNATURE_ALGORITHMS,
  isCanonicalBase64Url,
} from "../artifacts/signatures.js";
import { isAgreementArtifact } from "../artifacts/validators.js";
import { ARTIFACT_SEPARATORS } from "../artifacts/registry.js";
import { canonicalize, contentHash, sha256Hex } from "../canonical/index.js";
import { signedBytes as domainSignedBytes } from "../crypto/index.js";
import { DacsError } from "../errors.js";
import type {
  AgreementSigner,
  UnsignedAgreementArtifact,
} from "./fixedPrice.js";

const ROLE_ORDER = Object.freeze(["buyer", "seller"] as const);
const ALGORITHMS: ReadonlySet<string> = new Set(COMPONENT_SIGNATURE_ALGORITHMS);

export type FixedPriceAgreementSigningRole = (typeof ROLE_ORDER)[number];

export interface FixedPriceAgreementRequiredSigner {
  role: FixedPriceAgreementSigningRole;
  party: string;
}

/**
 * Immutable, transport-neutral agreement signing plan. Each party can recreate
 * and authenticate this plan independently before signing the exact same bytes.
 */
export interface FixedPriceAgreementSigningPlan {
  planVersion: "1";
  draft: Readonly<UnsignedAgreementArtifact>;
  agreementHash: string;
  separator:
    | typeof ARTIFACT_SEPARATORS.AgreementDocument
    | typeof ARTIFACT_SEPARATORS.PayeeBoundAgreementDocument;
  signedBytes: readonly number[];
  requiredSigners: readonly Readonly<FixedPriceAgreementRequiredSigner>[];
  planHash: string;
}

/** One role-owned detached contribution; it contains no remote signer callback. */
export interface FixedPriceAgreementSignatureContribution {
  contributionVersion: "1";
  planHash: string;
  role: FixedPriceAgreementSigningRole;
  party: string;
  signature: Readonly<AgreementSignature>;
  contributionHash: string;
}

export type FixedPriceAgreementContributionVerificationDisposition =
  | "valid"
  | "invalid"
  | "indeterminate"
  | "error";

export interface FixedPriceAgreementContributionVerificationInput {
  role: FixedPriceAgreementSigningRole;
  party: string;
  algorithm: ComponentSignatureAlgorithm;
  value: string;
  signedBytes: Uint8Array;
}

export type FixedPriceAgreementContributionVerifier = (
  input: Readonly<FixedPriceAgreementContributionVerificationInput>,
) =>
  | Promise<FixedPriceAgreementContributionVerificationDisposition>
  | FixedPriceAgreementContributionVerificationDisposition;

type DataRecord = Record<string, unknown>;
type DescriptorMap = Record<PropertyKey, PropertyDescriptor>;

const isRecord = (value: unknown): value is DataRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isHash = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const isCanonicalString = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.trim() === value &&
  value.normalize("NFC") === value;

function exactKeys(
  value: DataRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key)) &&
    keys.every((key) => allowed.has(key)) &&
    optional.every((key) => !Object.prototype.hasOwnProperty.call(value, key) ||
      value[key] !== undefined);
}

function captureArray<T>(
  value: unknown,
  subject: string,
  captureEntry: (entry: unknown, index: number) => T,
): T[] {
  if (!Array.isArray(value) || nodeTypes.isProxy(value)) {
    throw new DacsError(`${subject} must be an intrinsic array`);
  }
  let prototype: object | null;
  let descriptors: DescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(value) as unknown as DescriptorMap;
  } catch (error) {
    throw new DacsError(`${subject} cannot be inspected safely`, { cause: error });
  }
  if (prototype !== Array.prototype) {
    throw new DacsError(`${subject} must use the intrinsic array prototype`);
  }
  const expected = new Set<PropertyKey>([
    "length",
    ...Array.from({ length: value.length }, (_, index) => String(index)),
  ]);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    throw new DacsError(`${subject} cannot be sparse or carry extra fields`);
  }
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
      throw new DacsError(`${subject}[${index}] must be an enumerable data property`);
    }
    return captureEntry(descriptor.value, index);
  });
}

function captureData(
  value: unknown,
  subject: string,
  ancestors: Set<object>,
): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new DacsError(`${subject} contains a non-canonical number`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new DacsError(`${subject} must contain JSON data values only`);
  }
  if (nodeTypes.isProxy(value)) throw new DacsError(`${subject} cannot contain proxies`);
  if (ancestors.has(value)) throw new DacsError(`${subject} must be acyclic`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return captureArray(value, subject, (entry, index) =>
        captureData(entry, `${subject}[${index}]`, ancestors),
      );
    }
    let prototype: object | null;
    let descriptors: DescriptorMap;
    try {
      prototype = Object.getPrototypeOf(value) as object | null;
      descriptors = Object.getOwnPropertyDescriptors(value) as unknown as DescriptorMap;
    } catch (error) {
      throw new DacsError(`${subject} cannot be inspected safely`, { cause: error });
    }
    if (prototype !== Object.prototype && prototype !== null) {
      throw new DacsError(`${subject} objects must use a plain prototype`);
    }
    const out: DataRecord = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw new DacsError(`${subject} cannot contain symbol fields`);
      }
      const descriptor = descriptors[key];
      if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
        throw new DacsError(`${subject}.${key} must be an enumerable data property`);
      }
      if (descriptor.value === undefined) {
        throw new DacsError(`${subject}.${key} cannot be undefined`);
      }
      out[key] = captureData(descriptor.value, `${subject}.${key}`, ancestors);
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as DataRecord)) deepFreeze(child);
  return Object.freeze(value);
}

function snapshot<T>(value: T, subject: string): T {
  return deepFreeze(captureData(value, subject, new Set<object>()) as T);
}

function planMaterial(
  plan: Omit<FixedPriceAgreementSigningPlan, "planHash">,
): Record<string, unknown> {
  return {
    planVersion: plan.planVersion,
    draft: plan.draft,
    agreementHash: plan.agreementHash,
    separator: plan.separator,
    signedBytes: plan.signedBytes,
    requiredSigners: plan.requiredSigners,
  };
}

function contributionMaterial(
  contribution: Omit<FixedPriceAgreementSignatureContribution, "contributionHash">,
): Record<string, unknown> {
  return {
    contributionVersion: contribution.contributionVersion,
    planHash: contribution.planHash,
    role: contribution.role,
    party: contribution.party,
    signature: contribution.signature,
  };
}

function separatorFor(
  draft: Readonly<UnsignedAgreementArtifact>,
): FixedPriceAgreementSigningPlan["separator"] {
  return "agreementVersion" in draft
    ? ARTIFACT_SEPARATORS.AgreementDocument
    : ARTIFACT_SEPARATORS.PayeeBoundAgreementDocument;
}

function requiredSignersFor(
  draft: Readonly<UnsignedAgreementArtifact>,
): FixedPriceAgreementRequiredSigner[] {
  const buyer = draft.parties.find((party) => party.role === "buyer")?.primaryClaim;
  const seller = draft.parties.find((party) => party.role === "seller")?.primaryClaim;
  if (!isCanonicalString(buyer) || !isCanonicalString(seller) || buyer === seller) {
    throw new DacsError("agreement draft must bind distinct buyer and seller claims");
  }
  return [
    { role: "buyer", party: buyer },
    { role: "seller", party: seller },
  ];
}

function placeholderAgreement(
  draft: Readonly<UnsignedAgreementArtifact>,
  requiredSigners: readonly Readonly<FixedPriceAgreementRequiredSigner>[],
): AgreementArtifact {
  const placeholder = Buffer.alloc(64).toString("base64url");
  return {
    ...draft,
    signatures: requiredSigners.map(({ party }) => ({
      party,
      algorithm: "ed25519" as const,
      value: placeholder,
    })),
  } as AgreementArtifact;
}

function capturePlan(value: unknown): Readonly<FixedPriceAgreementSigningPlan> {
  const captured = snapshot(value, "fixed-price agreement signing plan") as unknown;
  if (
    !isRecord(captured) ||
    !exactKeys(captured, [
      "planVersion",
      "draft",
      "agreementHash",
      "separator",
      "signedBytes",
      "requiredSigners",
      "planHash",
    ]) ||
    captured.planVersion !== "1" ||
    !isRecord(captured.draft) ||
    Object.prototype.hasOwnProperty.call(captured.draft, "signature") ||
    Object.prototype.hasOwnProperty.call(captured.draft, "signatures") ||
    !isHash(captured.agreementHash) ||
    !Array.isArray(captured.signedBytes) ||
    captured.signedBytes.some((byte) =>
      !Number.isInteger(byte) || (byte as number) < 0 || (byte as number) > 255
    ) ||
    !Array.isArray(captured.requiredSigners) ||
    !isHash(captured.planHash)
  ) {
    throw new DacsError("fixed-price agreement signing plan is malformed");
  }
  const draft = captured.draft as unknown as UnsignedAgreementArtifact;
  const requiredSigners = requiredSignersFor(draft);
  if (
    captured.requiredSigners.length !== requiredSigners.length ||
    canonicalize(captured.requiredSigners) !== canonicalize(requiredSigners) ||
    !isAgreementArtifact(placeholderAgreement(draft, requiredSigners))
  ) {
    throw new DacsError("fixed-price agreement signing plan has a substituted party roster");
  }
  const agreementHash = contentHash(draft as unknown as Record<string, unknown>);
  const separator = separatorFor(draft);
  const bytes = [...domainSignedBytes(separator, agreementHash)];
  if (
    captured.agreementHash !== agreementHash ||
    captured.separator !== separator ||
    canonicalize(captured.signedBytes) !== canonicalize(bytes)
  ) {
    throw new DacsError("fixed-price agreement signing plan does not bind its exact draft bytes");
  }
  const plan = captured as unknown as FixedPriceAgreementSigningPlan;
  if (sha256Hex(canonicalize(planMaterial(plan))) !== plan.planHash) {
    throw new DacsError("fixed-price agreement signing plan hash does not match");
  }
  return plan;
}

function captureContribution(
  value: unknown,
): Readonly<FixedPriceAgreementSignatureContribution> {
  const captured = snapshot(value, "fixed-price agreement contribution") as unknown;
  if (
    !isRecord(captured) ||
    !exactKeys(captured, [
      "contributionVersion",
      "planHash",
      "role",
      "party",
      "signature",
      "contributionHash",
    ]) ||
    captured.contributionVersion !== "1" ||
    !isHash(captured.planHash) ||
    (captured.role !== "buyer" && captured.role !== "seller") ||
    !isCanonicalString(captured.party) ||
    !isRecord(captured.signature) ||
    !exactKeys(captured.signature, ["party", "algorithm", "value"]) ||
    captured.signature.party !== captured.party ||
    !ALGORITHMS.has(String(captured.signature.algorithm)) ||
    !isCanonicalBase64Url(captured.signature.value) ||
    !isHash(captured.contributionHash)
  ) {
    throw new DacsError("fixed-price agreement contribution is malformed");
  }
  const contribution = captured as unknown as FixedPriceAgreementSignatureContribution;
  if (
    sha256Hex(canonicalize(contributionMaterial(contribution))) !==
      contribution.contributionHash
  ) {
    throw new DacsError("fixed-price agreement contribution hash does not match");
  }
  return contribution;
}

function captureSigner(value: AgreementSigner): AgreementSigner {
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value)) {
    throw new DacsError("agreement signer must be an owned object");
  }
  let descriptors: DescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value) as unknown as DescriptorMap;
  } catch (error) {
    throw new DacsError("agreement signer cannot be inspected safely", { cause: error });
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 3 ||
    keys.some((key) => typeof key !== "string" || !["party", "algorithm", "sign"].includes(key))
  ) {
    throw new DacsError("agreement signer must contain exactly party, algorithm, and sign");
  }
  for (const key of ["party", "algorithm", "sign"] as const) {
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
      throw new DacsError(`agreement signer.${key} must be an enumerable data property`);
    }
  }
  const party = descriptors.party!.value as unknown;
  const algorithm = descriptors.algorithm!.value as unknown;
  const sign = descriptors.sign!.value as unknown;
  if (!isCanonicalString(party) || !ALGORITHMS.has(String(algorithm)) || typeof sign !== "function") {
    throw new DacsError("agreement signer identity or algorithm is malformed");
  }
  return Object.freeze({
    party,
    algorithm: algorithm as ComponentSignatureAlgorithm,
    sign: (
      bytes: Uint8Array,
      context: Pick<AgreementSignature, "party" | "algorithm">,
    ) => Reflect.apply(sign, Object.freeze({}), [bytes, context]),
  });
}

/** Derive the one exact byte plan independently shared by buyer and seller. */
export function createFixedPriceAgreementSigningPlan(
  draft: Readonly<UnsignedAgreementArtifact>,
): Readonly<FixedPriceAgreementSigningPlan> {
  const capturedDraft = snapshot(draft, "fixed-price agreement draft");
  if (
    !isRecord(capturedDraft) ||
    Object.prototype.hasOwnProperty.call(capturedDraft, "signature") ||
    Object.prototype.hasOwnProperty.call(capturedDraft, "signatures")
  ) {
    throw new DacsError("agreement draft cannot carry signature fields");
  }
  const requiredSigners = requiredSignersFor(capturedDraft);
  if (!isAgreementArtifact(placeholderAgreement(capturedDraft, requiredSigners))) {
    throw new DacsError("agreement draft failed exact DACS-3 validation");
  }
  const agreementHash = contentHash(
    capturedDraft as unknown as Record<string, unknown>,
  );
  const separator = separatorFor(capturedDraft);
  const base = {
    planVersion: "1" as const,
    draft: capturedDraft,
    agreementHash,
    separator,
    signedBytes: Object.freeze([...domainSignedBytes(separator, agreementHash)]),
    requiredSigners: Object.freeze(requiredSigners.map((entry) => Object.freeze(entry))),
  };
  return capturePlan({
    ...base,
    planHash: sha256Hex(canonicalize(planMaterial(base))),
  });
}

/** Return a fresh byte array so one signer cannot mutate another role's plan. */
export function fixedPriceAgreementSignedBytes(
  plan: Readonly<FixedPriceAgreementSigningPlan>,
): Uint8Array {
  return Uint8Array.from(capturePlan(plan).signedBytes);
}

/** Sign only the caller's own role contribution. */
export async function createFixedPriceAgreementSignatureContribution(
  planValue: Readonly<FixedPriceAgreementSigningPlan>,
  role: FixedPriceAgreementSigningRole,
  signerValue: AgreementSigner,
): Promise<Readonly<FixedPriceAgreementSignatureContribution>> {
  const plan = capturePlan(planValue);
  const signer = captureSigner(signerValue);
  const expected = plan.requiredSigners.find((entry) => entry.role === role);
  if (!expected || signer.party !== expected.party) {
    throw new DacsError(`${role} agreement contribution signer does not own that role`);
  }
  const context = Object.freeze({
    party: signer.party,
    algorithm: signer.algorithm,
  });
  const raw = await signer.sign(fixedPriceAgreementSignedBytes(plan), context);
  const value = typeof raw === "string"
    ? raw
    : raw instanceof Uint8Array &&
        !nodeTypes.isProxy(raw) &&
        (Object.getPrototypeOf(raw) === Uint8Array.prototype || Buffer.isBuffer(raw))
      ? Buffer.from(Uint8Array.from(raw)).toString("base64url")
      : "";
  if (!isCanonicalBase64Url(value)) {
    throw new DacsError("agreement signer returned a non-canonical Base64URL signature");
  }
  const base = {
    contributionVersion: "1" as const,
    planHash: plan.planHash,
    role,
    party: signer.party,
    signature: Object.freeze({
      party: signer.party,
      algorithm: signer.algorithm,
      value,
    }),
  };
  return captureContribution({
    ...base,
    contributionHash: sha256Hex(canonicalize(contributionMaterial(base))),
  });
}

/**
 * Verify the exact two detached role contributions and assemble one normative
 * AgreementArtifact. Missing, duplicate, substituted, or unresolved signatures
 * never produce an agreement.
 */
export async function finalizeFixedPriceAgreementContributions(
  planValue: Readonly<FixedPriceAgreementSigningPlan>,
  contributionValues: readonly Readonly<FixedPriceAgreementSignatureContribution>[],
  verify: FixedPriceAgreementContributionVerifier,
): Promise<AgreementArtifact> {
  const plan = capturePlan(planValue);
  if (typeof verify !== "function" || nodeTypes.isProxy(verify)) {
    throw new DacsError("agreement contribution verifier must be callable");
  }
  const contributions = captureArray(
    contributionValues,
    "fixed-price agreement contributions",
    (value) => captureContribution(value),
  );
  if (contributions.length !== ROLE_ORDER.length) {
    throw new DacsError("agreement requires exactly one buyer and one seller contribution");
  }
  const byRole = new Map<FixedPriceAgreementSigningRole, FixedPriceAgreementSignatureContribution>();
  for (const contribution of contributions) {
    if (byRole.has(contribution.role)) {
      throw new DacsError(`agreement contribution role ${contribution.role} is duplicated`);
    }
    byRole.set(contribution.role, contribution);
  }
  const signatures: AgreementSignature[] = [];
  for (const expected of plan.requiredSigners) {
    const contribution = byRole.get(expected.role);
    if (
      !contribution ||
      contribution.planHash !== plan.planHash ||
      contribution.party !== expected.party ||
      contribution.signature.party !== expected.party
    ) {
      throw new DacsError(`${expected.role} agreement contribution is missing or substituted`);
    }
    let disposition: FixedPriceAgreementContributionVerificationDisposition;
    try {
      disposition = await Reflect.apply(verify, Object.freeze({}), [
        Object.freeze({
          role: expected.role,
          party: expected.party,
          algorithm: contribution.signature.algorithm,
          value: contribution.signature.value,
          signedBytes: fixedPriceAgreementSignedBytes(plan),
        }),
      ]);
    } catch {
      disposition = "error";
    }
    if (disposition !== "valid") {
      throw new DacsError(
        `${expected.role} agreement contribution is not cryptographically valid (${disposition})`,
      );
    }
    signatures.push({ ...contribution.signature });
  }
  const agreement = snapshot(
    { ...plan.draft, signatures },
    "finalized fixed-price agreement",
  ) as AgreementArtifact;
  if (
    !isAgreementArtifact(agreement) ||
    contentHash(plan.draft as unknown as Record<string, unknown>) !== plan.agreementHash
  ) {
    throw new DacsError("assembled agreement failed exact DACS-3 validation");
  }
  return agreement;
}

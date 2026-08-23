import {
  ARTIFACT_SEPARATORS,
  isBundleRequirement,
  isCompositeVerificationRecord,
  isIdentityBundle,
  isReadableAnchorReceipt,
  type AttestationRef,
  type BundleRequirement,
  type CompositeVerificationRecord,
  type IdentityBundle,
} from "@kynesyslabs/dacs/artifacts";
import {
  compositeVerificationAddress,
  demosWriteEvidenceToAnchorReceipt,
  type ProtocolAnchorReceipt,
} from "@kynesyslabs/dacs";
import { canonicalize, contentHash, sha256Hex } from "@kynesyslabs/dacs/canonical";
import type { FixedPriceX402TrackOperationInput } from "@kynesyslabs/dacs/commerce";
import { ed25519Verify, publicKeyFromRaw, signedBytes } from "@kynesyslabs/dacs/crypto";
import {
  canonicalDemosAgentPublicKey,
  identityBundleHash,
  sameCanonicalClaimIdentity,
} from "@kynesyslabs/dacs/identity";

import type { DacsLiveRoleOperationContextV1 } from "./roleRuntime.js";

const VET_BINDING_VERSION = "1" as const;
const VET_BINDING_DOMAIN = "dacs-live-session-vet-binding:v1:" as const;
const HASH_RE = /^[0-9a-f]{64}$/;

export interface DacsSessionVetProductionV1 {
  record: Readonly<CompositeVerificationRecord>;
  recordRef: Readonly<AttestationRef>;
  anchorReceipt: Readonly<ProtocolAnchorReceipt>;
}

export type DacsSessionVetProductionOutcomeV1 = Readonly<
  | { status: "ready"; production: Readonly<DacsSessionVetProductionV1> }
  | { status: "indeterminate"; reasonCode: string }
  | { status: "operator-action"; reasonCode: string }
>;

export type DacsSessionVetAuthenticationV1 =
  | "valid"
  | "invalid"
  | "indeterminate";

interface DacsSessionVetBindingV1 {
  bindingVersion: typeof VET_BINDING_VERSION;
  localBindingHash: string;
  evaluatedParty: string;
  verifier: string;
  identityHash: string;
  requirementHash: string;
  record: Readonly<CompositeVerificationRecord>;
}

export class DacsSessionIdentityVetRuntimeError extends Error {
  override readonly name = "DacsSessionIdentityVetRuntimeError";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

function plainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return (prototype === Object.prototype || prototype === null) &&
      Reflect.ownKeys(value).every((key) => {
        if (typeof key !== "string") return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
      });
  } catch {
    return false;
  }
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function signatureBytes(value: unknown): Uint8Array | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(value)) return undefined;
  try {
    const decoded = Uint8Array.from(Buffer.from(value, "base64url"));
    return decoded.byteLength === 64 && Buffer.from(decoded).toString("base64url") === value
      ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function emptyRequirement(value: unknown): value is Readonly<BundleRequirement> {
  return isBundleRequirement(value) && value.required.length === 0 &&
    (value.oneOf === undefined || value.oneOf.length === 0);
}

function operationBound(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  operation: Readonly<FixedPriceX402TrackOperationInput>,
): boolean {
  return operation.fence.role === context.role && operation.fence.track === "agreement" &&
    operation.order.role === context.role && operation.order.jobId === operation.fence.jobId &&
    operation.order.localBindingHash === operation.fence.localBindingHash &&
    operation.order.bindingHash === operation.fence.bindingHash &&
    context.authority === (context.role === "buyer"
      ? operation.order.buyer : operation.order.seller);
}

function recordSignatureValid(
  record: Readonly<CompositeVerificationRecord>,
  verifier: string,
): boolean {
  const key = canonicalDemosAgentPublicKey(verifier);
  const signature = signatureBytes(record.signature.value);
  if (key === null || signature === undefined || record.signature.algorithm !== "ed25519" ||
      !sameCanonicalClaimIdentity(record.signature.signer, verifier)) return false;
  const { signature: _signature, ...unsigned } = record;
  return ed25519Verify(
    signedBytes(ARTIFACT_SEPARATORS.CompositeVerificationRecord, contentHash(unsigned)),
    signature,
    publicKeyFromRaw(key),
  );
}

function bindingId(role: "buyer" | "seller", jobId: string, evaluatedParty: string): string {
  return sha256Hex(`${VET_BINDING_DOMAIN}${canonicalize({
    role,
    jobId,
    evaluatedParty,
  })}`);
}

function captureBinding(value: unknown): Readonly<DacsSessionVetBindingV1> {
  if (!plainObject(value) || !exactKeys(value, [
    "bindingVersion", "localBindingHash", "evaluatedParty", "verifier",
    "identityHash", "requirementHash", "record",
  ]) || value.bindingVersion !== VET_BINDING_VERSION ||
      typeof value.localBindingHash !== "string" || !HASH_RE.test(value.localBindingHash) ||
      typeof value.evaluatedParty !== "string" || typeof value.verifier !== "string" ||
      typeof value.identityHash !== "string" || !HASH_RE.test(value.identityHash) ||
      typeof value.requirementHash !== "string" || !HASH_RE.test(value.requirementHash) ||
      !isCompositeVerificationRecord(value.record)) {
    throw new DacsSessionIdentityVetRuntimeError("session-vet-binding-corrupt");
  }
  return value as unknown as Readonly<DacsSessionVetBindingV1>;
}

async function retainedRecord(input: Readonly<{
  context: Readonly<DacsLiveRoleOperationContextV1>;
  operation: Readonly<FixedPriceX402TrackOperationInput>;
  identity: Readonly<IdentityBundle>;
  requirement: Readonly<BundleRequirement>;
}>): Promise<Readonly<CompositeVerificationRecord>> {
  const { context, operation } = input;
  const evaluatedParty = input.identity.presentedBy;
  const verifier = context.authority;
  const identityHash = identityBundleHash(input.identity);
  const requirementHash = sha256Hex(canonicalize(input.requirement));
  const id = bindingId(context.role, operation.order.jobId, evaluatedParty);
  const existing = context.database.loadEffectInput("session", id);
  if (existing !== undefined) {
    const binding = captureBinding(existing);
    if (binding.localBindingHash !== operation.order.localBindingHash ||
        !sameCanonicalClaimIdentity(binding.evaluatedParty, evaluatedParty) ||
        !sameCanonicalClaimIdentity(binding.verifier, verifier) ||
        binding.identityHash !== identityHash || binding.requirementHash !== requirementHash ||
        binding.record.jobId !== operation.order.jobId ||
        binding.record.bundleHash !== identityHash ||
        binding.record.requirementHash !== requirementHash ||
        !recordSignatureValid(binding.record, verifier)) {
      throw new DacsSessionIdentityVetRuntimeError("session-vet-binding-conflict");
    }
    return Object.freeze(structuredClone(binding.record));
  }
  const unsigned = {
    recordVersion: "1" as const,
    jobId: operation.order.jobId,
    evaluatedParty,
    bundleHash: identityHash,
    requirementHash,
    freshness: [],
    supplementary: [],
    dealSpecific: [],
    overallDecision: "pass" as const,
    generatedAt: context.database.readTime(),
  };
  const signed = await context.demos.signComponent(
    signedBytes(ARTIFACT_SEPARATORS.CompositeVerificationRecord, contentHash(unsigned)),
    { algorithm: "ed25519", signer: verifier },
  );
  const signature = signed instanceof Uint8Array
    ? Buffer.from(signed).toString("base64url") : String(signed);
  const record: CompositeVerificationRecord = {
    ...unsigned,
    signature: { algorithm: "ed25519", signer: verifier, value: signature },
  };
  if (!isCompositeVerificationRecord(record) || !recordSignatureValid(record, verifier)) {
    throw new DacsSessionIdentityVetRuntimeError("session-vet-signature-invalid");
  }
  const binding: DacsSessionVetBindingV1 = {
    bindingVersion: VET_BINDING_VERSION,
    localBindingHash: operation.order.localBindingHash,
    evaluatedParty,
    verifier,
    identityHash,
    requirementHash,
    record,
  };
  const put = context.database.putEffectIntent({
    kind: "session",
    effectId: id,
    bindingHash: operation.order.localBindingHash,
    input: binding,
    idempotencyKey: id,
    jobId: operation.order.jobId,
  });
  if (put.status === "conflict") {
    throw new DacsSessionIdentityVetRuntimeError("session-vet-binding-conflict");
  }
  return Object.freeze(structuredClone(captureBinding(
    context.database.loadEffectInput("session", id),
  ).record));
}

export async function createDacsSingleClaimSessionIdentityV1(input: Readonly<{
  context: Readonly<DacsLiveRoleOperationContextV1>;
  challenge: string;
}>): Promise<Readonly<IdentityBundle>> {
  if (!plainObject(input) || !plainObject(input.context) ||
      (input.context.role !== "buyer" && input.context.role !== "seller") ||
      typeof input.challenge !== "string" || !HASH_RE.test(input.challenge)) {
    throw new TypeError("session identity input is invalid");
  }
  const authority = input.context.authority;
  if (canonicalDemosAgentPublicKey(authority) === null) {
    throw new DacsSessionIdentityVetRuntimeError("session-identity-authority-invalid");
  }
  const bundle: IdentityBundle = {
    bundleVersion: "1",
    presentedBy: authority,
    presentedAt: input.context.database.readTime(),
    sessionNonce: input.challenge,
    claims: [{ ref: authority }],
    presentation: {
      kind: "per-claim",
      signatures: [{ ref: authority, signature: "pending" }],
    },
  };
  const signature = await input.context.demos.signComponent(
    signedBytes("dacs-bundle-presentation:v1:", identityBundleHash(bundle)),
    { algorithm: "ed25519", signer: authority },
  );
  if (bundle.presentation.kind !== "per-claim") throw new Error();
  bundle.presentation.signatures[0]!.signature = signature instanceof Uint8Array
    ? Buffer.from(signature).toString("base64url") : String(signature);
  if (!isIdentityBundle(bundle)) {
    throw new DacsSessionIdentityVetRuntimeError("session-identity-signature-invalid");
  }
  return Object.freeze(structuredClone(bundle));
}

/**
 * Create the role-owned live x402 identity presentation. The paying EVM key is
 * a DACS-4 action-bearing claim, so buyer sessions carry and independently
 * sign it; seller sessions deliberately remain single-claim and rely on the
 * co-signed payee-bound Agreement's tier-3 destination assertion.
 */
export async function createDacsX402SessionIdentityV1(input: Readonly<{
  context: Readonly<DacsLiveRoleOperationContextV1>;
  challenge: string;
}>): Promise<Readonly<IdentityBundle>> {
  if (!plainObject(input) || !plainObject(input.context) ||
      (input.context.role !== "buyer" && input.context.role !== "seller") ||
      typeof input.challenge !== "string" || !HASH_RE.test(input.challenge)) {
    throw new TypeError("x402 session identity input is invalid");
  }
  if (input.context.role === "seller") {
    return createDacsSingleClaimSessionIdentityV1(input);
  }
  const evm = input.context.evm;
  if (evm?.role !== "buyer" ||
      evm.runtime.network !== input.context.config.rail.requestedNetwork ||
      evm.runtime.payerAddress.toLowerCase() !== evm.address.toLowerCase()) {
    throw new DacsSessionIdentityVetRuntimeError("session-identity-evm-authority-invalid");
  }
  const authority = input.context.authority;
  if (canonicalDemosAgentPublicKey(authority) === null) {
    throw new DacsSessionIdentityVetRuntimeError("session-identity-authority-invalid");
  }
  const evmClaim = `cci-xm:evm:${evm.runtime.chainId}:` + evm.address;
  const bundle: IdentityBundle = {
    bundleVersion: "1",
    presentedBy: authority,
    presentedAt: input.context.database.readTime(),
    sessionNonce: input.challenge,
    claims: [{ ref: authority }, { ref: evmClaim }],
    presentation: {
      kind: "per-claim",
      signatures: [
        { ref: authority, signature: "pending" },
        { ref: evmClaim, signature: "pending" },
      ],
    },
  };
  const bundleHash = identityBundleHash(bundle);
  const [demosSignature, evmSignature] = await Promise.all([
    input.context.demos.signComponent(
      signedBytes("dacs-bundle-presentation:v1:", bundleHash),
      { algorithm: "ed25519", signer: authority },
    ),
    evm.runtime.signIdentityPresentation(bundleHash),
  ]);
  if (bundle.presentation.kind !== "per-claim") throw new Error();
  bundle.presentation.signatures[0]!.signature = demosSignature instanceof Uint8Array
    ? Buffer.from(demosSignature).toString("base64url") : String(demosSignature);
  bundle.presentation.signatures[1]!.signature = evmSignature;
  if (!isIdentityBundle(bundle) || !/^0x[0-9a-fA-F]{130}$/.test(evmSignature)) {
    throw new DacsSessionIdentityVetRuntimeError("session-identity-signature-invalid");
  }
  return Object.freeze(structuredClone(bundle));
}

export async function authenticateDacsSessionVetProductionV1(input: Readonly<{
  context: Readonly<DacsLiveRoleOperationContextV1>;
  jobId: string;
  evaluatedIdentity: Readonly<IdentityBundle>;
  requirement: Readonly<BundleRequirement>;
  verifier: string;
  production: Readonly<DacsSessionVetProductionV1>;
}>): Promise<DacsSessionVetAuthenticationV1> {
  try {
    if (!plainObject(input) || !plainObject(input.context) ||
        !isIdentityBundle(input.evaluatedIdentity) ||
        !emptyRequirement(input.requirement) ||
        !plainObject(input.production) ||
        !isCompositeVerificationRecord(input.production.record) ||
        !isReadableAnchorReceipt(input.production.anchorReceipt)) return "invalid";
    const record = input.production.record;
    const ref = input.production.recordRef;
    const receipt = input.production.anchorReceipt;
    const expectedAddress = compositeVerificationAddress(
      input.jobId,
      input.evaluatedIdentity.presentedBy,
    );
    const expectedHash = contentHash(record as unknown as Record<string, unknown>);
    if (record.jobId !== input.jobId ||
        !sameCanonicalClaimIdentity(record.evaluatedParty,
          input.evaluatedIdentity.presentedBy) ||
        record.bundleHash !== identityBundleHash(input.evaluatedIdentity) ||
        record.requirementHash !== sha256Hex(canonicalize(input.requirement)) ||
        record.overallDecision !== "pass" ||
        !recordSignatureValid(record, input.verifier) ||
        ref.anchor.kind !== "storage-program" || ref.anchor.locator !== expectedAddress ||
        ref.contentHash !== expectedHash ||
        !sameCanonicalClaimIdentity(ref.signer, input.verifier) ||
        receipt.substrate !== "demos" || receipt.logicalAddress !== expectedAddress ||
        receipt.contentHash !== expectedHash ||
        !sameCanonicalClaimIdentity(receipt.writer, input.verifier)) return "invalid";
    if (await input.context.demos.adapter.verifyDemosAnchorReceipt(receipt) !== true) {
      return "invalid";
    }
    const readback = await input.context.demos.adapter.readAnchor(receipt.nativeAddress);
    if (readback === null || !isCompositeVerificationRecord(readback) ||
        canonicalize(readback) !== canonicalize(record)) return "indeterminate";
    return "valid";
  } catch {
    return "indeterminate";
  }
}

export async function produceDacsEmptyRequirementSessionVetV1(input: Readonly<{
  context: Readonly<DacsLiveRoleOperationContextV1>;
  operation: Readonly<FixedPriceX402TrackOperationInput>;
  evaluatedIdentity: Readonly<IdentityBundle>;
  requirement: Readonly<BundleRequirement>;
}>): Promise<DacsSessionVetProductionOutcomeV1> {
  if (!plainObject(input) || !plainObject(input.context) ||
      !operationBound(input.context, input.operation) ||
      !isIdentityBundle(input.evaluatedIdentity) ||
      !emptyRequirement(input.requirement)) {
    return Object.freeze({ status: "operator-action",
      reasonCode: "session-vet-input-invalid" });
  }
  const evaluatedParty = input.evaluatedIdentity.presentedBy;
  const expectedParty = input.context.role === "buyer"
    ? input.operation.order.seller : input.operation.order.buyer;
  if (!sameCanonicalClaimIdentity(evaluatedParty, expectedParty) ||
      sameCanonicalClaimIdentity(evaluatedParty, input.context.authority)) {
    return Object.freeze({ status: "operator-action",
      reasonCode: "session-vet-party-mismatch" });
  }
  let record: Readonly<CompositeVerificationRecord>;
  try {
    record = await retainedRecord({
      context: input.context,
      operation: input.operation,
      identity: input.evaluatedIdentity,
      requirement: input.requirement,
    });
  } catch {
    return Object.freeze({ status: "operator-action",
      reasonCode: "session-vet-record-invalid" });
  }
  const logicalAddress = compositeVerificationAddress(
    input.operation.order.jobId,
    evaluatedParty,
  );
  const recordHash = contentHash(record as unknown as Record<string, unknown>);
  let receipt: Readonly<ProtocolAnchorReceipt> | null;
  try {
    await input.operation.fence.assertCurrent();
    const anchored = await input.context.demos.adapter.anchorWriteOnce(
      logicalAddress,
      record as unknown as Record<string, unknown>,
      { metadata: {
        logicalAddress,
        contentHash: recordHash,
        envelopeHash: sha256Hex(canonicalize(record)),
      } },
    );
    receipt = anchored.demosEvidence === undefined
      ? await input.context.demos.adapter.resolveDemosAnchorReceipt({
          logicalAddress,
          nativeAddress: anchored.address,
          contentHash: recordHash,
          writer: input.context.authority,
        })
      : demosWriteEvidenceToAnchorReceipt({
          logicalAddress,
          contentHash: recordHash,
          writer: input.context.authority,
          evidence: anchored.demosEvidence,
        });
  } catch {
    return Object.freeze({ status: "indeterminate",
      reasonCode: "session-vet-publication-ambiguous" });
  }
  if (receipt === null) {
    return Object.freeze({ status: "indeterminate",
      reasonCode: "session-vet-receipt-pending" });
  }
  const production: DacsSessionVetProductionV1 = {
    record,
    recordRef: {
      anchor: { kind: "storage-program", locator: logicalAddress },
      contentHash: recordHash,
      signer: input.context.authority,
    },
    anchorReceipt: receipt,
  };
  const authenticated = await authenticateDacsSessionVetProductionV1({
    context: input.context,
    jobId: input.operation.order.jobId,
    evaluatedIdentity: input.evaluatedIdentity,
    requirement: input.requirement,
    verifier: input.context.authority,
    production,
  });
  if (authenticated === "invalid") {
    return Object.freeze({ status: "operator-action",
      reasonCode: "session-vet-publication-invalid" });
  }
  if (authenticated === "indeterminate") {
    return Object.freeze({ status: "indeterminate",
      reasonCode: "session-vet-readback-pending" });
  }
  try {
    await input.operation.fence.assertCurrent();
  } catch {
    return Object.freeze({ status: "indeterminate",
      reasonCode: "session-vet-fence-stale" });
  }
  return Object.freeze({ status: "ready", production: Object.freeze(
    structuredClone(production),
  ) });
}

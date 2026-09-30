import { randomBytes, randomUUID, type KeyObject } from "node:crypto";

import {
  WALLET_SPEND_STATE_VERSION,
  createWalletSpendAuthorityV1,
  validateWalletSpendStateV1,
  type WalletSpendAuthorityDependenciesV1,
  type WalletSpendAuthorityV1,
  type WalletSpendPolicyV1,
  type WalletSpendStateStore,
  type WalletSpendStateV1,
} from "@kynesyslabs/dacs";
import { canonicalize, sha256Hex } from "@kynesyslabs/dacs/canonical";
import {
  ed25519Sign,
  ed25519Verify,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
} from "@kynesyslabs/dacs/crypto";

import type { DacsWalletSpendRemoteOperationStoreV1 } from "./walletSpendRemote.js";

export interface DacsPostgresQueryResultV1<Row = Record<string, unknown>> {
  rows: Row[];
  rowCount: number | null;
}

export interface DacsPostgresClientV1 {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<DacsPostgresQueryResultV1<Row>>;
  release(): void;
}

export interface DacsPostgresPoolV1 {
  connect(): Promise<DacsPostgresClientV1>;
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<DacsPostgresQueryResultV1<Row>>;
}

export interface DacsWalletSpendPostgresOperationV1 {
  /** Authenticated service role that owns this operation and its candidates. */
  roleId: string;
  operationId: string;
  requestHash: string;
  /** Logical mutation ordinal within one remote operation (normally omitted). */
  mutationIndex?: number;
}

const HASH_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL_RE = /^(?:[A-Za-z0-9_-]{43}|[A-Za-z0-9_-]{86})$/;

export interface DacsWalletSpendContinuityHeadV1 {
  revision: number;
  stateHash: string;
}

export interface DacsWalletSpendContinuityTransitionV1 {
  authorityId: string;
  epoch: string;
  lineageKey: string;
  predecessor: Readonly<DacsWalletSpendContinuityHeadV1> | null;
  next: Readonly<DacsWalletSpendContinuityHeadV1>;
  candidateId: string;
  roleId: string;
  operationId: string;
  requestHash: string;
  mutationIndex: number;
  clientNonce: string;
}

export interface DacsWalletSpendContinuityReceiptV1 {
  receiptVersion: "1";
  kind: "current" | "advance";
  authorityId: string;
  epoch: string;
  lineageKey: string;
  revision: number;
  stateHash: string;
  operationId: string;
  requestHash: string;
  clientNonce: string;
  candidateId: string | null;
  mutationIndex: number | null;
  priorRevision: number | null;
  priorStateHash: string | null;
  signature: Readonly<{ algorithm: "ed25519"; value: string }>;
}

export interface DacsWalletSpendContinuityWitnessV1 {
  /** Linearizable, authenticated read. Null means this lineage has never existed. */
  readCurrent(input: Readonly<{
    authorityId: string;
    epoch: string;
    lineageKey: string;
    operationId: string;
    requestHash: string;
    clientNonce: string;
  }>): Promise<Readonly<DacsWalletSpendContinuityReceiptV1> | null>;
  /** Linearizable exact-predecessor CAS. A mismatch must reject, never overwrite. */
  compareAndSet(
    input: Readonly<DacsWalletSpendContinuityTransitionV1>,
  ): Promise<Readonly<DacsWalletSpendContinuityReceiptV1>>;
  /** Resolve an ambiguous CAS only by the exact immutable candidate identity. */
  lookupAdvance(input: Readonly<{
    authorityId: string;
    epoch: string;
    lineageKey: string;
    candidateId: string;
    roleId: string;
    operationId: string;
    requestHash: string;
    mutationIndex: number;
  }>): Promise<Readonly<DacsWalletSpendContinuityReceiptV1> | null>;
}

export interface DacsWalletSpendContinuityPinV1 {
  authorityId: string;
  epoch: string;
  /** Canonical unpadded base64url raw Ed25519 public key. */
  verificationKey: string;
  witness: DacsWalletSpendContinuityWitnessV1;
}

export interface DacsWalletSpendContinuityAttestationRequestV1 {
  operationId: string;
  requestHash: string;
  clientNonce: string;
}

export interface DacsPostgresWalletSpendStateStoreV1 extends WalletSpendStateStore {
  attestCurrent(
    input: Readonly<DacsWalletSpendContinuityAttestationRequestV1>,
  ): Promise<Readonly<DacsWalletSpendContinuityReceiptV1>>;
}

const continuityAuthorityBindings = new WeakSet<object>();

/**
 * Cohesive V2 service binding. Instances can only be created by the factory
 * below, which constructs the authority and attester over the same state store.
 */
export interface DacsWalletSpendContinuityAuthorityV2 {
  authority: Readonly<WalletSpendAuthorityV1>;
  attestCurrent(
    input: Readonly<DacsWalletSpendContinuityAttestationRequestV1>,
  ): Promise<Readonly<DacsWalletSpendContinuityReceiptV1>>;
}

export function createDacsWalletSpendContinuityAuthorityV2(input: Readonly<{
  policy: Readonly<WalletSpendPolicyV1>;
  store: DacsPostgresWalletSpendStateStoreV1;
  dependencies: Readonly<Omit<WalletSpendAuthorityDependenciesV1, "store">>;
}>): Readonly<DacsWalletSpendContinuityAuthorityV2> {
  // Capture both the object and the exact method before constructing either
  // side of the binding. TypeScript readonly does not freeze a caller-owned
  // configuration object; dereferencing input.store later would let a caller
  // swap in an unrelated same-revision attester after branding the pair.
  const store = input.store;
  const attestCurrent = store.attestCurrent;
  if (typeof attestCurrent !== "function") {
    throw new Error("wallet-spend-continuity-store-invalid");
  }
  const authority = createWalletSpendAuthorityV1(input.policy, {
    store,
    readBalance: input.dependencies.readBalance,
    authenticateRecovery: input.dependencies.authenticateRecovery,
    ...(input.dependencies.verifyOperatorApproval === undefined ? {} : {
      verifyOperatorApproval: input.dependencies.verifyOperatorApproval,
    }),
    ...(input.dependencies.now === undefined ? {} : { now: input.dependencies.now }),
    ...(input.dependencies.leaseDurationMs === undefined ? {} : {
      leaseDurationMs: input.dependencies.leaseDurationMs,
    }),
    ...(input.dependencies.owner === undefined ? {} : { owner: input.dependencies.owner }),
  });
  const binding: DacsWalletSpendContinuityAuthorityV2 = Object.freeze({
    authority,
    attestCurrent: (request: Readonly<DacsWalletSpendContinuityAttestationRequestV1>) =>
      Reflect.apply(attestCurrent, store, [request]),
  });
  continuityAuthorityBindings.add(binding);
  return binding;
}

export function isDacsWalletSpendContinuityAuthorityV2(
  value: unknown,
): value is Readonly<DacsWalletSpendContinuityAuthorityV2> {
  return value !== null && typeof value === "object" &&
    continuityAuthorityBindings.has(value as object);
}

type ContinuityStatement = Omit<DacsWalletSpendContinuityReceiptV1, "signature">;

function continuitySignedBytes(statement: Readonly<ContinuityStatement>): Uint8Array {
  return new TextEncoder().encode(
    `dacs-wallet-spend-continuity-receipt:v1:${canonicalize(statement)}`,
  );
}

function canonicalBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function rawPublicKey(key: KeyObject): Uint8Array {
  const der = key.export({ format: "der", type: "spki" });
  return Uint8Array.from(der.subarray(der.length - 32));
}

function continuityIdentity(value: string, label: string): string {
  if (value.length === 0 || value.trim() !== value || value.normalize("NFC") !== value) {
    throw new Error(`wallet-spend-continuity-${label}-invalid`);
  }
  return value;
}

function continuityHead(
  revision: unknown,
  stateHash: unknown,
): Readonly<DacsWalletSpendContinuityHeadV1> {
  if (!Number.isSafeInteger(revision) || (revision as number) < 0 ||
      typeof stateHash !== "string" || !HASH_RE.test(stateHash)) {
    throw new Error("wallet-spend-continuity-head-invalid");
  }
  return Object.freeze({ revision: revision as number, stateHash });
}

function receiptStatement(value: unknown): Readonly<ContinuityStatement> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("wallet-spend-continuity-receipt-invalid");
  }
  const receipt = value as Record<string, unknown>;
  const fields = [
    "receiptVersion", "kind", "authorityId", "epoch", "lineageKey", "revision",
    "stateHash", "operationId", "requestHash", "clientNonce", "candidateId",
    "mutationIndex", "priorRevision", "priorStateHash", "signature",
  ];
  const signature = receipt.signature;
  if (Object.keys(receipt).length !== fields.length ||
      fields.some((field) => !Object.hasOwn(receipt, field)) ||
      receipt.receiptVersion !== "1" ||
      (receipt.kind !== "current" && receipt.kind !== "advance") ||
      typeof receipt.authorityId !== "string" || typeof receipt.epoch !== "string" ||
      typeof receipt.lineageKey !== "string" || typeof receipt.operationId !== "string" ||
      !UUID_RE.test(receipt.operationId) || typeof receipt.requestHash !== "string" ||
      !HASH_RE.test(receipt.requestHash) || typeof receipt.clientNonce !== "string" ||
      !HASH_RE.test(receipt.clientNonce) || signature === null ||
      typeof signature !== "object" || Array.isArray(signature) ||
      Object.keys(signature).length !== 2 ||
      (signature as Record<string, unknown>).algorithm !== "ed25519" ||
      typeof (signature as Record<string, unknown>).value !== "string" ||
      !BASE64URL_RE.test((signature as Record<string, unknown>).value as string)) {
    throw new Error("wallet-spend-continuity-receipt-invalid");
  }
  continuityIdentity(receipt.authorityId, "authority-id");
  continuityIdentity(receipt.epoch, "epoch");
  continuityIdentity(receipt.lineageKey, "lineage");
  continuityHead(receipt.revision, receipt.stateHash);
  if (receipt.kind === "current") {
    if (receipt.candidateId !== null || receipt.mutationIndex !== null ||
        receipt.priorRevision !== null || receipt.priorStateHash !== null) {
      throw new Error("wallet-spend-continuity-receipt-invalid");
    }
  } else if (typeof receipt.candidateId !== "string" ||
      !UUID_RE.test(receipt.candidateId) || !Number.isSafeInteger(receipt.mutationIndex) ||
      (receipt.mutationIndex as number) < 0 ||
      (receipt.priorRevision !== null && (!Number.isSafeInteger(receipt.priorRevision) ||
        (receipt.priorRevision as number) < 0)) ||
      (receipt.priorStateHash !== null && (typeof receipt.priorStateHash !== "string" ||
        !HASH_RE.test(receipt.priorStateHash))) ||
      ((receipt.priorRevision === null) !== (receipt.priorStateHash === null))) {
    throw new Error("wallet-spend-continuity-receipt-invalid");
  }
  const { signature: _signature, ...statement } = receipt;
  return Object.freeze(statement as unknown as ContinuityStatement);
}

export function verifyDacsWalletSpendContinuityReceiptV1(
  value: unknown,
  pin: Readonly<Omit<DacsWalletSpendContinuityPinV1, "witness">>,
): value is Readonly<DacsWalletSpendContinuityReceiptV1> {
  try {
    const statement = receiptStatement(value);
    const receipt = value as DacsWalletSpendContinuityReceiptV1;
    if (statement.authorityId !== pin.authorityId || statement.epoch !== pin.epoch ||
        !BASE64URL_RE.test(pin.verificationKey)) return false;
    const publicKey = Buffer.from(pin.verificationKey, "base64url");
    const signature = Buffer.from(receipt.signature.value, "base64url");
    return publicKey.length === 32 && signature.length === 64 &&
      ed25519Verify(continuitySignedBytes(statement), signature, publicKeyFromRaw(publicKey));
  } catch {
    return false;
  }
}

function nonce(): string {
  return randomBytes(32).toString("hex");
}

function advanceNonce(input: Readonly<{
  authorityId: string;
  epoch: string;
  lineageKey: string;
  candidateId: string;
  roleId: string;
  operationId: string;
  requestHash: string;
  mutationIndex: number;
}>): string {
  // Advance receipts are durable candidate records, not freshness proofs. A
  // deterministic binding lets the exact operation resolve an ambiguous CAS
  // after restart while current-head attestations continue to use fresh nonces.
  return sha256Hex(`dacs-wallet-spend-continuity-advance-nonce:v1:${canonicalize(input)}`);
}

export const DACS_WALLET_SPEND_POSTGRES_SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS dacs_wallet_spend_lineages (
  lineage_key text PRIMARY KEY,
  writer_contract_version smallint NOT NULL CHECK (writer_contract_version = 2),
  authority_id text NOT NULL CHECK (length(authority_id) > 0),
  continuity_epoch text NOT NULL CHECK (length(continuity_epoch) > 0),
  continuity_verification_key text NOT NULL
    CHECK (continuity_verification_key ~ '^[A-Za-z0-9_-]{43}$'),
  continuity_status text NOT NULL CHECK (continuity_status IN ('pending', 'active')),
  continuity_receipt jsonb,
  wallet text NOT NULL,
  chain_id text NOT NULL,
  policy_hash text NOT NULL,
  revision bigint NOT NULL CHECK (revision >= 0),
  state_hash text NOT NULL,
  state jsonb NOT NULL,
  provisioning_kind text NOT NULL CHECK (provisioning_kind IN ('fresh', 'legacy-import')),
  source_identity text NOT NULL CHECK (length(source_identity) > 0),
  source_evidence_hash text NOT NULL
    CHECK (source_evidence_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (wallet, chain_id)
);
CREATE TABLE IF NOT EXISTS dacs_wallet_spend_candidates (
  candidate_id uuid PRIMARY KEY,
  lineage_key text NOT NULL REFERENCES dacs_wallet_spend_lineages(lineage_key),
  writer_contract_version smallint NOT NULL CHECK (writer_contract_version = 2),
  authority_id text NOT NULL,
  continuity_epoch text NOT NULL,
  role_id text NOT NULL,
  operation_id uuid NOT NULL,
  request_hash text NOT NULL,
  mutation_index integer NOT NULL CHECK (mutation_index >= 0),
  prior_revision bigint,
  prior_state_hash text,
  next_revision bigint NOT NULL,
  next_state_hash text NOT NULL,
  candidate_state jsonb NOT NULL,
  candidate_value jsonb NOT NULL,
  continuity_receipt jsonb,
  status text NOT NULL CHECK (status IN ('prepared', 'applied', 'superseded')),
  prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  applied_at timestamptz,
  UNIQUE (lineage_key, operation_id, mutation_index)
);
CREATE INDEX IF NOT EXISTS dacs_wallet_spend_candidates_operation
  ON dacs_wallet_spend_candidates(lineage_key, operation_id);
CREATE TABLE IF NOT EXISTS dacs_wallet_spend_operations (
  writer_contract_version smallint NOT NULL CHECK (writer_contract_version = 2),
  role_id text NOT NULL,
  operation_id uuid NOT NULL,
  request_hash text NOT NULL,
  request jsonb NOT NULL,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (role_id, operation_id)
);
CREATE OR REPLACE FUNCTION dacs_wallet_spend_require_writer_v2()
RETURNS trigger LANGUAGE plpgsql AS $dacs_wallet_spend_writer_fence$
BEGIN
  IF current_setting('dacs.wallet_spend_writer_contract', true) IS DISTINCT FROM '2' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'wallet-spend-writer-contract-v2-required';
  END IF;
  RETURN NEW;
END
$dacs_wallet_spend_writer_fence$;
DROP TRIGGER IF EXISTS dacs_wallet_spend_lineage_writer_fence
  ON dacs_wallet_spend_lineages;
CREATE TRIGGER dacs_wallet_spend_lineage_writer_fence
BEFORE INSERT OR UPDATE ON dacs_wallet_spend_lineages
FOR EACH ROW EXECUTE FUNCTION dacs_wallet_spend_require_writer_v2();
DO $dacs_wallet_spend_role_migration$
BEGIN
  -- This is a quiesced migration. The exclusive lock fences any old writer
  -- until role_id has become mandatory; an old insert released afterward then
  -- fails the NOT NULL constraint instead of creating an unusable candidate.
  LOCK TABLE dacs_wallet_spend_operations IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE dacs_wallet_spend_candidates IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE dacs_wallet_spend_lineages IN ACCESS EXCLUSIVE MODE;
  ALTER TABLE dacs_wallet_spend_lineages
    ADD COLUMN IF NOT EXISTS writer_contract_version smallint,
    ADD COLUMN IF NOT EXISTS authority_id text,
    ADD COLUMN IF NOT EXISTS continuity_epoch text,
    ADD COLUMN IF NOT EXISTS continuity_verification_key text,
    ADD COLUMN IF NOT EXISTS continuity_status text,
    ADD COLUMN IF NOT EXISTS continuity_receipt jsonb;
  ALTER TABLE dacs_wallet_spend_candidates
    ADD COLUMN IF NOT EXISTS writer_contract_version smallint,
    ADD COLUMN IF NOT EXISTS authority_id text,
    ADD COLUMN IF NOT EXISTS continuity_epoch text,
    ADD COLUMN IF NOT EXISTS continuity_receipt jsonb;
  ALTER TABLE dacs_wallet_spend_operations
    ADD COLUMN IF NOT EXISTS writer_contract_version smallint;
  ALTER TABLE dacs_wallet_spend_candidates
    ADD COLUMN IF NOT EXISTS role_id text;
  WITH unambiguous_candidate_roles AS (
    SELECT operation_id, request_hash, min(role_id) AS role_id
      FROM dacs_wallet_spend_operations
     GROUP BY operation_id, request_hash
    HAVING count(*) = 1
  )
  UPDATE dacs_wallet_spend_candidates AS candidate
     SET role_id = binding.role_id
    FROM unambiguous_candidate_roles AS binding
   WHERE candidate.role_id IS NULL
     AND candidate.operation_id = binding.operation_id
     AND candidate.request_hash = binding.request_hash;
  IF EXISTS (
    SELECT 1 FROM dacs_wallet_spend_candidates WHERE role_id IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23502',
      MESSAGE = 'wallet-spend-candidate-role-migration-ambiguous';
  END IF;
  ALTER TABLE dacs_wallet_spend_candidates
    ALTER COLUMN role_id SET NOT NULL;
  IF EXISTS (
    SELECT 1 FROM dacs_wallet_spend_lineages
     WHERE writer_contract_version <> 2
        OR authority_id IS NULL OR continuity_epoch IS NULL
        OR continuity_verification_key IS NULL
        OR continuity_status <> 'active' OR continuity_receipt IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'wallet-spend-continuity-migration-required';
  END IF;
  IF EXISTS (
    SELECT 1 FROM dacs_wallet_spend_candidates
     WHERE writer_contract_version IS DISTINCT FROM 2 OR authority_id IS NULL OR continuity_epoch IS NULL
  ) OR EXISTS (
    SELECT 1 FROM dacs_wallet_spend_operations
     WHERE writer_contract_version IS DISTINCT FROM 2
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'wallet-spend-continuity-migration-required';
  END IF;
  ALTER TABLE dacs_wallet_spend_lineages
    ALTER COLUMN writer_contract_version SET NOT NULL,
    ALTER COLUMN authority_id SET NOT NULL,
    ALTER COLUMN continuity_epoch SET NOT NULL,
    ALTER COLUMN continuity_verification_key SET NOT NULL,
    ALTER COLUMN continuity_status SET NOT NULL;
  ALTER TABLE dacs_wallet_spend_candidates
    ALTER COLUMN writer_contract_version SET NOT NULL,
    ALTER COLUMN authority_id SET NOT NULL,
    ALTER COLUMN continuity_epoch SET NOT NULL;
  ALTER TABLE dacs_wallet_spend_operations
    ALTER COLUMN writer_contract_version SET NOT NULL;
END
$dacs_wallet_spend_role_migration$;
CREATE INDEX IF NOT EXISTS dacs_wallet_spend_candidates_role_operation
  ON dacs_wallet_spend_candidates(lineage_key, role_id, operation_id);
`;

/**
 * Quiesced first stage for databases created by the initial PR head. Apply
 * this, run the authenticated adoption operation below, then apply the main
 * schema. It deliberately leaves columns nullable until adoption succeeds.
 */
export const DACS_WALLET_SPEND_POSTGRES_CONTINUITY_ADOPTION_SCHEMA_V1 = `
BEGIN;
LOCK TABLE dacs_wallet_spend_operations IN ACCESS EXCLUSIVE MODE;
LOCK TABLE dacs_wallet_spend_candidates IN ACCESS EXCLUSIVE MODE;
LOCK TABLE dacs_wallet_spend_lineages IN ACCESS EXCLUSIVE MODE;
ALTER TABLE dacs_wallet_spend_lineages
  ADD COLUMN IF NOT EXISTS writer_contract_version smallint,
  ADD COLUMN IF NOT EXISTS authority_id text,
  ADD COLUMN IF NOT EXISTS continuity_epoch text,
  ADD COLUMN IF NOT EXISTS continuity_verification_key text,
  ADD COLUMN IF NOT EXISTS continuity_status text,
  ADD COLUMN IF NOT EXISTS continuity_receipt jsonb;
ALTER TABLE dacs_wallet_spend_candidates
  ADD COLUMN IF NOT EXISTS writer_contract_version smallint,
  ADD COLUMN IF NOT EXISTS authority_id text,
  ADD COLUMN IF NOT EXISTS continuity_epoch text,
  ADD COLUMN IF NOT EXISTS continuity_receipt jsonb,
  ALTER COLUMN prior_revision DROP NOT NULL,
  ALTER COLUMN prior_state_hash DROP NOT NULL;
ALTER TABLE dacs_wallet_spend_operations
  ADD COLUMN IF NOT EXISTS writer_contract_version smallint;
CREATE OR REPLACE FUNCTION dacs_wallet_spend_require_writer_v2()
RETURNS trigger LANGUAGE plpgsql AS $dacs_wallet_spend_writer_fence$
BEGIN
  IF current_setting('dacs.wallet_spend_writer_contract', true) IS DISTINCT FROM '2' THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'wallet-spend-writer-contract-v2-required';
  END IF;
  RETURN NEW;
END
$dacs_wallet_spend_writer_fence$;
DROP TRIGGER IF EXISTS dacs_wallet_spend_lineage_writer_fence
  ON dacs_wallet_spend_lineages;
CREATE TRIGGER dacs_wallet_spend_lineage_writer_fence
BEFORE INSERT OR UPDATE ON dacs_wallet_spend_lineages
FOR EACH ROW EXECUTE FUNCTION dacs_wallet_spend_require_writer_v2();
COMMIT;
`;

export function dacsWalletSpendLineageKeyV1(wallet: string, chainId: string): string {
  if (wallet.length === 0 || chainId.length === 0 ||
      wallet.trim() !== wallet || chainId.trim() !== chainId) {
    throw new TypeError("wallet spend lineage is invalid");
  }
  return sha256Hex(`dacs-wallet-spend-scope:v1:${canonicalize({ wallet, chainId })}`);
}

export function dacsWalletSpendPolicyHashV1(
  policy: Readonly<WalletSpendPolicyV1>,
): string {
  return sha256Hex(`dacs-wallet-spend-policy:v1:${canonicalize(policy)}`);
}

export interface DacsWalletSpendProvisioningEvidenceV1 {
  sourceIdentity: string;
  evidenceHash: string;
}

type AuthenticateProvisioningEvidence = (
  evidence: Readonly<DacsWalletSpendProvisioningEvidenceV1>,
  state: Readonly<WalletSpendStateV1>,
) => Promise<boolean> | boolean;

function provisioningEvidence(
  value: Readonly<DacsWalletSpendProvisioningEvidenceV1>,
): Readonly<DacsWalletSpendProvisioningEvidenceV1> {
  if (value.sourceIdentity.length === 0 || value.sourceIdentity.trim() !== value.sourceIdentity ||
      !/^[0-9a-f]{64}$/.test(value.evidenceHash)) {
    throw new Error("wallet-spend-provisioning-evidence-invalid");
  }
  return Object.freeze({ ...value });
}

function emptyState(policyHash: string): WalletSpendStateV1 {
  return {
    stateVersion: WALLET_SPEND_STATE_VERSION,
    policyHash,
    generation: 0,
    reservations: [],
    totals: [],
    rollingEvents: [],
  };
}

function stateHash(state: Readonly<WalletSpendStateV1>): string {
  return sha256Hex(`dacs-wallet-spend-state:v1:${canonicalize(state)}`);
}

function continuityPin(
  input: Readonly<DacsWalletSpendContinuityPinV1>,
): Readonly<DacsWalletSpendContinuityPinV1> {
  continuityIdentity(input.authorityId, "authority-id");
  continuityIdentity(input.epoch, "epoch");
  if (!BASE64URL_RE.test(input.verificationKey) ||
      Buffer.from(input.verificationKey, "base64url").length !== 32 ||
      input.witness === null || typeof input.witness !== "object" ||
      typeof input.witness.readCurrent !== "function" ||
      typeof input.witness.compareAndSet !== "function" ||
      typeof input.witness.lookupAdvance !== "function") {
    throw new Error("wallet-spend-continuity-pin-invalid");
  }
  return Object.freeze({ ...input });
}

function requireCurrentReceipt(
  value: unknown,
  pin: Readonly<DacsWalletSpendContinuityPinV1>,
  expected: Readonly<{
    lineageKey: string;
    head: Readonly<DacsWalletSpendContinuityHeadV1>;
    operationId: string;
    requestHash: string;
    clientNonce: string;
  }>,
): Readonly<DacsWalletSpendContinuityReceiptV1> {
  if (!verifyDacsWalletSpendContinuityReceiptV1(value, pin) || value.kind !== "current" ||
      value.lineageKey !== expected.lineageKey || value.revision !== expected.head.revision ||
      value.stateHash !== expected.head.stateHash ||
      value.operationId !== expected.operationId || value.requestHash !== expected.requestHash ||
      value.clientNonce !== expected.clientNonce) {
    throw new Error("wallet-spend-continuity-head-mismatch");
  }
  return value;
}

function requireAdvanceReceipt(
  value: unknown,
  pin: Readonly<DacsWalletSpendContinuityPinV1>,
  transition: Readonly<DacsWalletSpendContinuityTransitionV1>,
): Readonly<DacsWalletSpendContinuityReceiptV1> {
  const priorRevision = transition.predecessor?.revision ?? null;
  const priorStateHash = transition.predecessor?.stateHash ?? null;
  if (!verifyDacsWalletSpendContinuityReceiptV1(value, pin) || value.kind !== "advance" ||
      value.lineageKey !== transition.lineageKey ||
      value.revision !== transition.next.revision ||
      value.stateHash !== transition.next.stateHash ||
      value.operationId !== transition.operationId ||
      value.requestHash !== transition.requestHash ||
      value.clientNonce !== transition.clientNonce ||
      value.candidateId !== transition.candidateId ||
      value.mutationIndex !== transition.mutationIndex ||
      value.priorRevision !== priorRevision || value.priorStateHash !== priorStateHash) {
    throw new Error("wallet-spend-continuity-advance-invalid");
  }
  return value;
}

async function compareAndSetContinuity(
  pin: Readonly<DacsWalletSpendContinuityPinV1>,
  transition: Readonly<DacsWalletSpendContinuityTransitionV1>,
): Promise<Readonly<DacsWalletSpendContinuityReceiptV1>> {
  try {
    return requireAdvanceReceipt(
      await pin.witness.compareAndSet(transition),
      pin,
      transition,
    );
  } catch (error) {
    let resolved: Readonly<DacsWalletSpendContinuityReceiptV1> | null;
    try {
      resolved = await pin.witness.lookupAdvance({
        authorityId: transition.authorityId,
        epoch: transition.epoch,
        lineageKey: transition.lineageKey,
        candidateId: transition.candidateId,
        roleId: transition.roleId,
        operationId: transition.operationId,
        requestHash: transition.requestHash,
        mutationIndex: transition.mutationIndex,
      });
    } catch {
      throw new Error("wallet-spend-continuity-outcome-unresolved");
    }
    if (resolved === null) {
      throw error instanceof Error && error.message === "wallet-spend-continuity-conflict"
        ? error : new Error("wallet-spend-continuity-outcome-unresolved");
    }
    return requireAdvanceReceipt(resolved, pin, transition);
  }
}

/**
 * Deterministic offline reference witness. It models the contract for tests;
 * it is process-local and is not production durability or topology evidence.
 */
export function createInMemoryDacsWalletSpendContinuityWitnessV1(input: Readonly<{
  authorityId: string;
  epoch: string;
  seed: Uint8Array;
}>): Readonly<{
  witness: DacsWalletSpendContinuityWitnessV1;
  verificationKey: string;
}> {
  const authorityId = continuityIdentity(input.authorityId, "authority-id");
  const epoch = continuityIdentity(input.epoch, "epoch");
  if (!(input.seed instanceof Uint8Array) || input.seed.length !== 32) {
    throw new Error("wallet-spend-continuity-seed-invalid");
  }
  const privateKey = privateKeyFromSeed(Uint8Array.from(input.seed));
  const verificationKey = canonicalBase64Url(rawPublicKey(publicKeyFromSeed(input.seed)));
  const heads = new Map<string, DacsWalletSpendContinuityHeadV1>();
  const advances = new Map<string, DacsWalletSpendContinuityReceiptV1>();
  const key = (transition: Readonly<{
    lineageKey: string; candidateId: string; roleId: string; operationId: string;
    requestHash: string; mutationIndex: number;
  }>) => canonicalize({
    lineageKey: transition.lineageKey,
    candidateId: transition.candidateId,
    roleId: transition.roleId,
    operationId: transition.operationId,
    requestHash: transition.requestHash,
    mutationIndex: transition.mutationIndex,
  });
  const sign = (statement: Readonly<ContinuityStatement>):
    Readonly<DacsWalletSpendContinuityReceiptV1> => Object.freeze({
      ...statement,
      signature: Object.freeze({
        algorithm: "ed25519" as const,
        value: canonicalBase64Url(ed25519Sign(continuitySignedBytes(statement), privateKey)),
      }),
    });
  const witness: DacsWalletSpendContinuityWitnessV1 = {
    async readCurrent(request) {
      if (request.authorityId !== authorityId || request.epoch !== epoch) {
        throw new Error("wallet-spend-continuity-identity-mismatch");
      }
      const head = heads.get(request.lineageKey);
      if (head === undefined) return null;
      return sign({
        receiptVersion: "1", kind: "current", authorityId, epoch,
        lineageKey: request.lineageKey, revision: head.revision, stateHash: head.stateHash,
        operationId: request.operationId, requestHash: request.requestHash,
        clientNonce: request.clientNonce, candidateId: null, mutationIndex: null,
        priorRevision: null, priorStateHash: null,
      });
    },
    async compareAndSet(transition) {
      if (transition.authorityId !== authorityId || transition.epoch !== epoch) {
        throw new Error("wallet-spend-continuity-identity-mismatch");
      }
      const identity = key(transition);
      const existing = advances.get(identity);
      if (existing !== undefined) return existing;
      const head = heads.get(transition.lineageKey);
      const matches = transition.predecessor === null
        ? head === undefined
        : head !== undefined && head.revision === transition.predecessor.revision &&
          head.stateHash === transition.predecessor.stateHash;
      if (!matches || (transition.predecessor !== null &&
          transition.next.revision !== transition.predecessor.revision + 1)) {
        throw new Error("wallet-spend-continuity-conflict");
      }
      const receipt = sign({
        receiptVersion: "1", kind: "advance", authorityId, epoch,
        lineageKey: transition.lineageKey, revision: transition.next.revision,
        stateHash: transition.next.stateHash, operationId: transition.operationId,
        requestHash: transition.requestHash, clientNonce: transition.clientNonce,
        candidateId: transition.candidateId, mutationIndex: transition.mutationIndex,
        priorRevision: transition.predecessor?.revision ?? null,
        priorStateHash: transition.predecessor?.stateHash ?? null,
      });
      heads.set(transition.lineageKey, { ...transition.next });
      advances.set(identity, receipt);
      return receipt;
    },
    async lookupAdvance(request) {
      if (request.authorityId !== authorityId || request.epoch !== epoch) {
        throw new Error("wallet-spend-continuity-identity-mismatch");
      }
      return advances.get(key(request)) ?? null;
    },
  };
  return Object.freeze({ witness: Object.freeze(witness), verificationKey });
}

function safeRevision(value: unknown): number {
  const revision = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(revision) || (revision as number) < 0) {
    throw new Error("wallet-spend-postgres-revision-invalid");
  }
  return revision as number;
}

interface LineageRow {
  writer_contract_version: string | number;
  authority_id: string;
  continuity_epoch: string;
  continuity_verification_key: string;
  continuity_status: "pending" | "active";
  continuity_receipt: DacsWalletSpendContinuityReceiptV1 | null;
  policy_hash: string;
  revision: string | number;
  state_hash: string;
  state: WalletSpendStateV1;
}

interface CandidateRow {
  candidate_id: string;
  authority_id: string;
  continuity_epoch: string;
  role_id: string | null;
  request_hash: string;
  mutation_index: string | number;
  prior_revision: string | number;
  prior_state_hash: string;
  next_revision: string | number;
  next_state_hash: string;
  candidate_state: WalletSpendStateV1;
  candidate_value: unknown;
  continuity_receipt: DacsWalletSpendContinuityReceiptV1 | null;
  status: "prepared" | "applied" | "superseded";
}

async function confirmContinuityHead(
  pool: DacsPostgresPoolV1,
  pin: Readonly<DacsWalletSpendContinuityPinV1>,
  input: Readonly<{
    lineageKey: string;
    head: Readonly<DacsWalletSpendContinuityHeadV1>;
    operationId: string;
    requestHash: string;
  }>,
): Promise<void> {
  const selected = await pool.query<LineageRow>(
    `SELECT writer_contract_version, authority_id, continuity_epoch,
            continuity_verification_key, continuity_status, continuity_receipt,
            policy_hash, revision, state_hash, state
       FROM dacs_wallet_spend_lineages WHERE lineage_key = $1`,
    [input.lineageKey],
  );
  const row = selected.rows[0];
  if (!row || safeRevision(row.writer_contract_version) !== 2 ||
      row.authority_id !== pin.authorityId || row.continuity_epoch !== pin.epoch ||
      row.continuity_verification_key !== pin.verificationKey ||
      row.continuity_status !== "active" || row.continuity_receipt === null ||
      safeRevision(row.revision) !== input.head.revision ||
      row.state_hash !== input.head.stateHash || row.state_hash !== stateHash(row.state)) {
    throw new Error("wallet-spend-continuity-readback-mismatch");
  }
  const clientNonce = nonce();
  const receipt = await pin.witness.readCurrent({
    authorityId: pin.authorityId, epoch: pin.epoch, lineageKey: input.lineageKey,
    operationId: input.operationId, requestHash: input.requestHash, clientNonce,
  });
  if (receipt === null) throw new Error("wallet-spend-continuity-readback-mismatch");
  requireCurrentReceipt(receipt, pin, {
    lineageKey: input.lineageKey, head: input.head, operationId: input.operationId,
    requestHash: input.requestHash, clientNonce,
  });
}

interface CandidateValueV1 {
  valueVersion: "1";
  defined: boolean;
  value: unknown;
}

function encodeCandidateValue(value: unknown): Readonly<CandidateValueV1> {
  return Object.freeze({
    valueVersion: "1",
    defined: value !== undefined,
    value: value === undefined ? null : value,
  });
}

function decodedCandidateValue(value: unknown): Readonly<{
  defined: boolean;
  value: unknown;
}> {
  // d0e26c candidates stored result.value directly and represented undefined
  // as JSON null. Preserve that exact legacy meaning after the quiesced upgrade.
  if (value === null) return Object.freeze({ defined: false, value: undefined });
  if (typeof value === "object" && !Array.isArray(value)) {
    const candidate = value as Record<string, unknown>;
    if (Object.hasOwn(candidate, "valueVersion")) {
      if (Object.keys(candidate).length !== 3 || candidate.valueVersion !== "1" ||
          typeof candidate.defined !== "boolean" || !Object.hasOwn(candidate, "value") ||
          (!candidate.defined && candidate.value !== null)) {
        throw new Error("wallet-spend-postgres-candidate-value-invalid");
      }
      return Object.freeze({
        defined: candidate.defined,
        value: candidate.defined ? candidate.value : undefined,
      });
    }
  }
  return Object.freeze({ defined: true, value });
}

function decodeCandidateValue<T>(value: unknown): T {
  return decodedCandidateValue(value).value as T;
}

function candidateValueMatches(value: unknown, expected: unknown): boolean {
  const decoded = decodedCandidateValue(value);
  if (!decoded.defined) return expected === undefined;
  return expected !== undefined && canonicalize(decoded.value) === canonicalize(expected);
}

function postgresErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

async function transaction<T>(
  pool: DacsPostgresPoolV1,
  operation: (client: DacsPostgresClientV1) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await client.query("SELECT set_config('dacs.wallet_spend_writer_contract', '2', true)");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve the original failure */ }
      const code = postgresErrorCode(error);
      if ((code !== "40001" && code !== "40P01") || attempt === 7) throw error;
    } finally {
      client.release();
    }
  }
  throw new Error("wallet-spend-postgres-serialization-exhausted");
}

/** Explicit operator-only lineage provisioning; the agent HTTP API never calls this. */
export async function provisionDacsWalletSpendPostgresLineageV1(
  pool: DacsPostgresPoolV1,
  input: Readonly<{
    policy: Readonly<WalletSpendPolicyV1>;
    operationId: string;
    continuity: Readonly<DacsWalletSpendContinuityPinV1>;
    newLineageEvidence: Readonly<DacsWalletSpendProvisioningEvidenceV1>;
    authenticateEvidence: AuthenticateProvisioningEvidence;
  }>,
): Promise<void> {
  const policy = input.policy;
  const policyHash = dacsWalletSpendPolicyHashV1(policy);
  const lineage = dacsWalletSpendLineageKeyV1(policy.wallet, policy.chainId);
  const state = validateWalletSpendStateV1(emptyState(policyHash), policy);
  const evidence = provisioningEvidence(input.newLineageEvidence);
  if (!await input.authenticateEvidence(evidence, state)) {
    throw new Error("wallet-spend-new-lineage-evidence-rejected");
  }
  await initializeLineage(pool, {
    policy, state, evidence, provisioningKind: "fresh", operationId: input.operationId,
    continuity: input.continuity,
  });
}

/**
 * Explicit operator-only import of an authenticated legacy filesystem/custom
 * state. The agent HTTP API never exposes this operation.
 */
export async function importDacsWalletSpendPostgresLegacyStateV1(
  pool: DacsPostgresPoolV1,
  input: Readonly<{
    policy: Readonly<WalletSpendPolicyV1>;
    state: Readonly<WalletSpendStateV1>;
    operationId: string;
    continuity: Readonly<DacsWalletSpendContinuityPinV1>;
    sourceEvidence: Readonly<DacsWalletSpendProvisioningEvidenceV1>;
    authenticateEvidence: AuthenticateProvisioningEvidence;
  }>,
): Promise<void> {
  const state = validateWalletSpendStateV1(input.state, input.policy);
  const evidence = provisioningEvidence(input.sourceEvidence);
  if (!await input.authenticateEvidence(evidence, state)) {
    throw new Error("wallet-spend-legacy-state-evidence-rejected");
  }
  await initializeLineage(pool, {
    policy: input.policy, state, evidence, provisioningKind: "legacy-import",
    operationId: input.operationId, continuity: input.continuity,
  });
}

/**
 * Authenticated, quiesced adoption of a database created by the initial PR
 * head. Run only after the adoption schema above and before the final schema.
 */
export async function adoptDacsWalletSpendPostgresContinuityV1(
  pool: DacsPostgresPoolV1,
  input: Readonly<{
    policy: Readonly<WalletSpendPolicyV1>;
    operationId: string;
    continuity: Readonly<DacsWalletSpendContinuityPinV1>;
    sourceEvidence: Readonly<DacsWalletSpendProvisioningEvidenceV1>;
    authenticateEvidence: AuthenticateProvisioningEvidence;
  }>,
): Promise<void> {
  if (!UUID_RE.test(input.operationId)) {
    throw new Error("wallet-spend-continuity-operation-id-invalid");
  }
  const pin = continuityPin(input.continuity);
  const evidence = provisioningEvidence(input.sourceEvidence);
  const lineage = dacsWalletSpendLineageKeyV1(input.policy.wallet, input.policy.chainId);
  const policyHash = dacsWalletSpendPolicyHashV1(input.policy);
  const selected = await pool.query<LineageRow>(
    `SELECT writer_contract_version, authority_id, continuity_epoch,
            continuity_verification_key, continuity_status, continuity_receipt,
            policy_hash, revision, state_hash, state
       FROM dacs_wallet_spend_lineages WHERE lineage_key = $1`,
    [lineage],
  );
  const row = selected.rows[0];
  if (!row) throw new Error("wallet-spend-lineage-missing");
  const state = validateWalletSpendStateV1(row.state, input.policy);
  if (row.policy_hash !== policyHash || safeRevision(row.revision) !== state.generation ||
      row.state_hash !== stateHash(state)) {
    throw new Error("wallet-spend-authoritative-head-invalid");
  }
  if (row.authority_id !== null && row.authority_id !== undefined ||
      row.continuity_epoch !== null && row.continuity_epoch !== undefined ||
      row.continuity_verification_key !== null &&
        row.continuity_verification_key !== undefined ||
      row.continuity_receipt !== null && row.continuity_receipt !== undefined) {
    throw new Error("wallet-spend-continuity-already-adopted");
  }
  if (!await input.authenticateEvidence(evidence, state)) {
    throw new Error("wallet-spend-continuity-adoption-evidence-rejected");
  }
  const requestHash = sha256Hex(canonicalize({
    operation: "adopt-continuity", lineage, policyHash, revision: state.generation,
    stateHash: row.state_hash, evidence, authorityId: pin.authorityId, epoch: pin.epoch,
  }));
  const clientNonce = nonce();
  const existing = await pin.witness.readCurrent({
    authorityId: pin.authorityId, epoch: pin.epoch, lineageKey: lineage,
    operationId: input.operationId, requestHash, clientNonce,
  });
  if (existing !== null) throw new Error("wallet-spend-continuity-lineage-already-exists");
  const candidateId = randomUUID();
  await pool.query(
    `INSERT INTO dacs_wallet_spend_candidates
      (candidate_id, lineage_key, writer_contract_version, authority_id, continuity_epoch,
       role_id, operation_id, request_hash, mutation_index, prior_revision,
       prior_state_hash, next_revision, next_state_hash, candidate_state,
       candidate_value, continuity_receipt, status)
     VALUES ($1::uuid, $2, 2, $3, $4, 'operator:continuity-adoption', $5::uuid,
             $6, 0, NULL, NULL, $7, $8, $9::jsonb, $10::jsonb, NULL, 'prepared')`,
    [candidateId, lineage, pin.authorityId, pin.epoch, input.operationId, requestHash,
      state.generation, row.state_hash, canonicalize(state),
      canonicalize(encodeCandidateValue(undefined))],
  );
  const transitionIdentity = {
    authorityId: pin.authorityId, epoch: pin.epoch, lineageKey: lineage,
    candidateId, roleId: "operator:continuity-adoption",
    operationId: input.operationId, requestHash, mutationIndex: 0,
  };
  const receipt = await compareAndSetContinuity(pin, {
    ...transitionIdentity,
    predecessor: null, next: { revision: state.generation, stateHash: row.state_hash },
    clientNonce: advanceNonce(transitionIdentity),
  });
  await transaction(pool, async (client) => {
    const head = (await client.query<LineageRow>(
      `SELECT writer_contract_version, authority_id, continuity_epoch,
              continuity_verification_key, continuity_status, continuity_receipt,
              policy_hash, revision, state_hash, state
         FROM dacs_wallet_spend_lineages WHERE lineage_key = $1 FOR UPDATE`,
      [lineage],
    )).rows[0];
    if (!head || safeRevision(head.revision) !== state.generation ||
        head.state_hash !== row.state_hash || head.policy_hash !== policyHash ||
        head.authority_id !== null && head.authority_id !== undefined) {
      throw new Error("wallet-spend-continuity-adoption-head-moved");
    }
    const updated = await client.query(
      `UPDATE dacs_wallet_spend_lineages
          SET writer_contract_version = 2, authority_id = $2, continuity_epoch = $3,
              continuity_verification_key = $4, continuity_status = 'active',
              continuity_receipt = $5::jsonb, updated_at = clock_timestamp()
        WHERE lineage_key = $1 AND revision = $6 AND state_hash = $7
          AND authority_id IS NULL AND continuity_receipt IS NULL`,
      [lineage, pin.authorityId, pin.epoch, pin.verificationKey, canonicalize(receipt),
        state.generation, row.state_hash],
    );
    if (updated.rowCount !== 1) {
      throw new Error("wallet-spend-continuity-adoption-head-moved");
    }
    await client.query(
      `UPDATE dacs_wallet_spend_candidates
          SET writer_contract_version = 2, authority_id = $2, continuity_epoch = $3
        WHERE lineage_key = $1`,
      [lineage, pin.authorityId, pin.epoch],
    );
    await client.query(
      `UPDATE dacs_wallet_spend_candidates
          SET status = 'applied', continuity_receipt = $2::jsonb,
              applied_at = clock_timestamp()
        WHERE candidate_id = $1::uuid AND status = 'prepared'`,
      [candidateId, canonicalize(receipt)],
    );
    await client.query(
      `UPDATE dacs_wallet_spend_operations SET writer_contract_version = 2
        WHERE writer_contract_version IS NULL`,
    );
  });
  await confirmContinuityHead(pool, pin, {
    lineageKey: lineage, head: { revision: state.generation, stateHash: row.state_hash },
    operationId: input.operationId, requestHash,
  });
}

async function initializeLineage(
  pool: DacsPostgresPoolV1,
  input: Readonly<{
    policy: Readonly<WalletSpendPolicyV1>;
    state: Readonly<WalletSpendStateV1>;
    evidence: Readonly<DacsWalletSpendProvisioningEvidenceV1>;
    provisioningKind: "fresh" | "legacy-import";
    operationId: string;
    continuity: Readonly<DacsWalletSpendContinuityPinV1>;
  }>,
): Promise<void> {
  if (!UUID_RE.test(input.operationId)) {
    throw new Error("wallet-spend-continuity-operation-id-invalid");
  }
  const pin = continuityPin(input.continuity);
  const lineage = dacsWalletSpendLineageKeyV1(input.policy.wallet, input.policy.chainId);
  const policyHash = dacsWalletSpendPolicyHashV1(input.policy);
  const nextHash = stateHash(input.state);
  const requestHash = sha256Hex(canonicalize({
    operation: "initialize-lineage", lineage, provisioningKind: input.provisioningKind,
    policyHash, stateHash: nextHash, evidence: input.evidence,
    authorityId: pin.authorityId, epoch: pin.epoch,
  }));
  const roleId = `operator:${input.provisioningKind}`;
  let candidateId: string | undefined;
  const existing = await pool.query<LineageRow>(
    `SELECT writer_contract_version, authority_id, continuity_epoch,
            continuity_verification_key, continuity_status, continuity_receipt,
            policy_hash, revision, state_hash, state
       FROM dacs_wallet_spend_lineages WHERE lineage_key = $1`,
    [lineage],
  );
  const priorLineage = existing.rows[0];
  if (priorLineage !== undefined) {
    if (priorLineage.continuity_status !== "pending" ||
        priorLineage.authority_id !== pin.authorityId ||
        priorLineage.continuity_epoch !== pin.epoch ||
        priorLineage.continuity_verification_key !== pin.verificationKey ||
        priorLineage.policy_hash !== policyHash ||
        safeRevision(priorLineage.revision) !== input.state.generation ||
        priorLineage.state_hash !== nextHash ||
        canonicalize(priorLineage.state) !== canonicalize(input.state)) {
      throw new Error("wallet-spend-lineage-already-exists");
    }
    const retained = await pool.query<CandidateRow>(
      `SELECT candidate_id, authority_id, continuity_epoch, role_id, request_hash, mutation_index,
              prior_revision, prior_state_hash, next_revision, next_state_hash,
              candidate_state, candidate_value, continuity_receipt, status
         FROM dacs_wallet_spend_candidates
        WHERE lineage_key = $1 AND role_id = $2 AND operation_id = $3::uuid
          AND mutation_index = 0`,
      [lineage, roleId, input.operationId],
    );
    const row = retained.rows[0];
    if (!row || row.request_hash !== requestHash || row.authority_id !== pin.authorityId ||
        row.continuity_epoch !== pin.epoch || row.next_state_hash !== nextHash ||
        canonicalize(row.candidate_state) !== canonicalize(input.state)) {
      throw new Error("wallet-spend-continuity-initialization-conflict");
    }
    candidateId = row.candidate_id;
  } else {
    candidateId = randomUUID();
    await transaction(pool, async (client) => {
      const inserted = await client.query(
        `INSERT INTO dacs_wallet_spend_lineages
          (lineage_key, writer_contract_version, authority_id, continuity_epoch,
           continuity_verification_key, continuity_status, continuity_receipt,
           wallet, chain_id, policy_hash, revision, state_hash, state,
           provisioning_kind, source_identity, source_evidence_hash)
         VALUES ($1, 2, $2, $3, $4, 'pending', NULL, $5, $6, $7, $8, $9,
                 $10::jsonb, $11, $12, $13)
         ON CONFLICT DO NOTHING`,
        [lineage, pin.authorityId, pin.epoch, pin.verificationKey,
          input.policy.wallet, input.policy.chainId, policyHash, input.state.generation,
          nextHash, canonicalize(input.state), input.provisioningKind,
          input.evidence.sourceIdentity, input.evidence.evidenceHash],
      );
      if (inserted.rowCount !== 1) throw new Error("wallet-spend-lineage-already-exists");
      await client.query(
        `INSERT INTO dacs_wallet_spend_candidates
          (candidate_id, lineage_key, writer_contract_version, authority_id,
           continuity_epoch, role_id, operation_id, request_hash, mutation_index,
           prior_revision, prior_state_hash, next_revision, next_state_hash,
           candidate_state, candidate_value, continuity_receipt, status)
         VALUES ($1::uuid, $2, 2, $3, $4, $5, $6::uuid, $7, 0,
                 NULL, NULL, $8, $9, $10::jsonb, $11::jsonb, NULL, 'prepared')`,
        [candidateId, lineage, pin.authorityId, pin.epoch, roleId, input.operationId,
          requestHash, input.state.generation, nextHash, canonicalize(input.state),
          canonicalize(encodeCandidateValue(undefined))],
      );
    });
  }
  const transitionIdentity = {
    authorityId: pin.authorityId, epoch: pin.epoch, lineageKey: lineage,
    candidateId, roleId, operationId: input.operationId, requestHash,
    mutationIndex: 0,
  };
  const transition: DacsWalletSpendContinuityTransitionV1 = {
    ...transitionIdentity,
    predecessor: null, next: { revision: input.state.generation, stateHash: nextHash },
    clientNonce: advanceNonce(transitionIdentity),
  };
  const receipt = await compareAndSetContinuity(pin, transition);
  await transaction(pool, async (client) => {
    const row = (await client.query<LineageRow>(
      `SELECT writer_contract_version, authority_id, continuity_epoch,
              continuity_verification_key, continuity_status, continuity_receipt,
              policy_hash, revision, state_hash, state
         FROM dacs_wallet_spend_lineages WHERE lineage_key = $1 FOR UPDATE`,
      [lineage],
    )).rows[0];
    if (!row || row.continuity_status !== "pending" || row.authority_id !== pin.authorityId ||
        row.continuity_epoch !== pin.epoch || safeRevision(row.revision) !== input.state.generation ||
        row.state_hash !== nextHash) {
      throw new Error("wallet-spend-continuity-initialization-conflict");
    }
    const updated = await client.query(
      `UPDATE dacs_wallet_spend_lineages
          SET continuity_status = 'active', continuity_receipt = $2::jsonb,
              updated_at = clock_timestamp()
        WHERE lineage_key = $1 AND continuity_status = 'pending'`,
      [lineage, canonicalize(receipt)],
    );
    if (updated.rowCount !== 1) throw new Error("wallet-spend-continuity-initialization-conflict");
    await client.query(
      `UPDATE dacs_wallet_spend_candidates
          SET status = 'applied', continuity_receipt = $2::jsonb,
              applied_at = clock_timestamp()
        WHERE candidate_id = $1::uuid AND status = 'prepared'`,
      [candidateId, canonicalize(receipt)],
    );
  });
  await confirmContinuityHead(pool, pin, {
    lineageKey: lineage,
    head: { revision: input.state.generation, stateHash: nextHash },
    operationId: input.operationId, requestHash,
  });
}

/**
 * Explicit operator-only policy migration. Accounting and unresolved
 * reservations are retained; removing an asset they reference is refused.
 */
export async function migrateDacsWalletSpendPostgresPolicyV1(
  pool: DacsPostgresPoolV1,
  input: Readonly<{
    previousPolicyHash: string;
    policy: Readonly<WalletSpendPolicyV1>;
    operationId: string;
    continuity: Readonly<DacsWalletSpendContinuityPinV1>;
  }>,
): Promise<void> {
  if (!UUID_RE.test(input.operationId)) {
    throw new Error("wallet-spend-continuity-operation-id-invalid");
  }
  const pin = continuityPin(input.continuity);
  const lineage = dacsWalletSpendLineageKeyV1(input.policy.wallet, input.policy.chainId);
  const nextPolicyHash = dacsWalletSpendPolicyHashV1(input.policy);
  const loaded = await pool.query<LineageRow>(
    `SELECT writer_contract_version, authority_id, continuity_epoch,
            continuity_verification_key, continuity_status, continuity_receipt,
            policy_hash, revision, state_hash, state
       FROM dacs_wallet_spend_lineages WHERE lineage_key = $1`,
    [lineage],
  );
  const row = loaded.rows[0];
  if (!row) throw new Error("wallet-spend-lineage-missing");
  if (safeRevision(row.writer_contract_version) !== 2 ||
      row.authority_id !== pin.authorityId || row.continuity_epoch !== pin.epoch ||
      row.continuity_verification_key !== pin.verificationKey ||
      row.continuity_status !== "active" || row.continuity_receipt === null ||
      safeRevision(row.revision) !== row.state.generation ||
      row.state_hash !== stateHash(row.state) || row.policy_hash !== row.state.policyHash) {
    throw new Error("wallet-spend-authoritative-head-invalid");
  }
  if (row.policy_hash !== input.previousPolicyHash ||
      row.state.policyHash !== input.previousPolicyHash) {
    throw new Error("wallet-spend-policy-head-mismatch");
  }
  const allowedAssets = new Set(input.policy.assets.map(({ asset }) => asset));
  if (row.state.totals.some(({ asset }) => !allowedAssets.has(asset)) ||
      row.state.reservations.some(({ reservation }) =>
        reservation.debits.some(({ asset }) => !allowedAssets.has(asset)))) {
    throw new Error("wallet-spend-policy-removes-accounted-asset");
  }
  const priorRevision = safeRevision(row.revision);
  const revision = priorRevision + 1;
  if (!Number.isSafeInteger(revision)) {
    throw new Error("wallet-spend-postgres-revision-exhausted");
  }
  const nextState = validateWalletSpendStateV1({
    ...row.state,
    policyHash: nextPolicyHash,
    generation: revision,
  }, input.policy);
  const candidateId = randomUUID();
  const requestHash = sha256Hex(canonicalize({
    operation: "migrate-policy",
    lineage,
    previousPolicyHash: input.previousPolicyHash,
    policy: input.policy,
  }));
  const readNonce = nonce();
  const current = await pin.witness.readCurrent({
    authorityId: pin.authorityId, epoch: pin.epoch, lineageKey: lineage,
    operationId: input.operationId, requestHash, clientNonce: readNonce,
  });
  if (current === null) throw new Error("wallet-spend-continuity-head-missing");
  requireCurrentReceipt(current, pin, {
    lineageKey: lineage, head: { revision: priorRevision, stateHash: row.state_hash },
    operationId: input.operationId, requestHash, clientNonce: readNonce,
  });
  const nextHash = stateHash(nextState);
  await pool.query(
    `INSERT INTO dacs_wallet_spend_candidates
      (candidate_id, lineage_key, writer_contract_version, authority_id, continuity_epoch,
       role_id, operation_id, request_hash, mutation_index,
       prior_revision, prior_state_hash, next_revision, next_state_hash,
       candidate_state, candidate_value, continuity_receipt, status)
     VALUES ($1::uuid, $2, 2, $3, $4, 'operator:policy-migration', $5::uuid, $6, 0,
             $7, $8, $9, $10, $11::jsonb, $12::jsonb, NULL, 'prepared')`,
    [candidateId, lineage, pin.authorityId, pin.epoch, input.operationId, requestHash,
      priorRevision, row.state_hash,
      revision, nextHash, canonicalize(nextState), canonicalize(encodeCandidateValue(undefined))],
  );
  const transitionIdentity = {
    authorityId: pin.authorityId, epoch: pin.epoch, lineageKey: lineage,
    candidateId,
    roleId: "operator:policy-migration", operationId: input.operationId, requestHash,
    mutationIndex: 0,
  };
  const transition: DacsWalletSpendContinuityTransitionV1 = {
    ...transitionIdentity,
    predecessor: { revision: priorRevision, stateHash: row.state_hash },
    next: { revision, stateHash: nextHash },
    clientNonce: advanceNonce(transitionIdentity),
  };
  const receipt = await compareAndSetContinuity(pin, transition);
  await transaction(pool, async (client) => {
    const head = (await client.query<LineageRow>(
      `SELECT writer_contract_version, authority_id, continuity_epoch,
              continuity_verification_key, continuity_status, continuity_receipt,
              policy_hash, revision, state_hash, state
         FROM dacs_wallet_spend_lineages WHERE lineage_key = $1 FOR UPDATE`,
      [lineage],
    )).rows[0];
    if (!head || safeRevision(head.revision) !== priorRevision ||
        head.state_hash !== row.state_hash || head.policy_hash !== input.previousPolicyHash) {
      throw new Error("wallet-spend-policy-head-moved");
    }
    const updated = await client.query(
      `UPDATE dacs_wallet_spend_lineages
          SET policy_hash = $2, revision = $3, state_hash = $4,
              state = $5::jsonb, continuity_receipt = $6::jsonb,
              updated_at = clock_timestamp()
        WHERE lineage_key = $1 AND revision = $7 AND state_hash = $8`,
      [lineage, nextPolicyHash, revision, nextHash, canonicalize(nextState),
        canonicalize(receipt), priorRevision, row.state_hash],
    );
    if (updated.rowCount !== 1) throw new Error("wallet-spend-policy-head-moved");
    await client.query(
      `UPDATE dacs_wallet_spend_candidates
          SET status = 'applied', continuity_receipt = $2::jsonb,
              applied_at = clock_timestamp()
        WHERE candidate_id = $1::uuid AND status = 'prepared'`,
      [candidateId, canonicalize(receipt)],
    );
  });
  await confirmContinuityHead(pool, pin, {
    lineageKey: lineage, head: { revision, stateHash: nextHash },
    operationId: input.operationId, requestHash,
  });
}

/**
 * PostgreSQL authority state store. Missing lineage is always nonauthorizing.
 * Each changed state is first committed as an immutable candidate, then a
 * separate SERIALIZABLE/row-locked transaction advances the exact prior head.
 */
export function createDacsPostgresWalletSpendStateStoreV1(input: Readonly<{
  pool: DacsPostgresPoolV1;
  wallet: string;
  chainId: string;
  continuity: Readonly<DacsWalletSpendContinuityPinV1>;
  operation?: () => Readonly<DacsWalletSpendPostgresOperationV1> | undefined;
}>): DacsPostgresWalletSpendStateStoreV1 {
  const lineage = dacsWalletSpendLineageKeyV1(input.wallet, input.chainId);
  const pin = continuityPin(input.continuity);
  let mutationIndex = 0;
  let contextualMutationIndex = 0;

  const operationContext = () => {
    const context = input.operation?.();
    if (context === undefined) return undefined;
    if (typeof context.roleId !== "string" || context.roleId.length === 0 ||
        context.roleId.trim() !== context.roleId || context.roleId.normalize("NFC") !== context.roleId ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
          .test(context.operationId) || !/^[0-9a-f]{64}$/.test(context.requestHash) ||
        (context.mutationIndex !== undefined &&
          (!Number.isSafeInteger(context.mutationIndex) || context.mutationIndex < 0))) {
      throw new Error("wallet-spend-postgres-operation-identity-invalid");
    }
    return Object.freeze({
      roleId: context.roleId,
      operationId: context.operationId,
      requestHash: context.requestHash,
      mutationIndex: context.mutationIndex ?? contextualMutationIndex++,
    });
  };

  const loadDatabase = async (): Promise<LineageRow> => {
    const result = await input.pool.query<LineageRow>(
      `SELECT writer_contract_version, authority_id, continuity_epoch,
              continuity_verification_key, continuity_status, continuity_receipt,
              policy_hash, revision, state_hash, state
         FROM dacs_wallet_spend_lineages WHERE lineage_key = $1`,
      [lineage],
    );
    const row = result.rows[0];
    if (!row) throw new Error("wallet-spend-lineage-missing");
    if (safeRevision(row.writer_contract_version) !== 2 ||
        row.authority_id !== pin.authorityId || row.continuity_epoch !== pin.epoch ||
        row.continuity_verification_key !== pin.verificationKey ||
        row.continuity_status !== "active" || row.continuity_receipt === null ||
        !verifyDacsWalletSpendContinuityReceiptV1(row.continuity_receipt, pin) ||
        row.continuity_receipt.kind !== "advance" ||
        row.continuity_receipt.lineageKey !== lineage ||
        row.continuity_receipt.revision !== safeRevision(row.revision) ||
        row.continuity_receipt.stateHash !== row.state_hash ||
        safeRevision(row.revision) !== row.state.generation ||
        row.state_hash !== stateHash(row.state) || row.policy_hash !== row.state.policyHash) {
      throw new Error("wallet-spend-authoritative-head-invalid");
    }
    return row;
  };

  const readWitness = async (
    binding: Readonly<DacsWalletSpendContinuityAttestationRequestV1>,
  ): Promise<Readonly<DacsWalletSpendContinuityReceiptV1>> => {
    const receipt = await pin.witness.readCurrent({
      authorityId: pin.authorityId, epoch: pin.epoch, lineageKey: lineage,
      ...binding,
    });
    if (receipt === null || !verifyDacsWalletSpendContinuityReceiptV1(receipt, pin) ||
        receipt.kind !== "current" || receipt.lineageKey !== lineage ||
        receipt.operationId !== binding.operationId ||
        receipt.requestHash !== binding.requestHash ||
        receipt.clientNonce !== binding.clientNonce) {
      throw new Error("wallet-spend-continuity-head-missing");
    }
    return receipt;
  };

  const internalBinding = (purpose: string): DacsWalletSpendContinuityAttestationRequestV1 => {
    const clientNonce = nonce();
    const operationId = randomUUID();
    return {
      operationId,
      clientNonce,
      requestHash: sha256Hex(canonicalize({ purpose, lineage, operationId, clientNonce })),
    };
  };

  const attestDatabaseHead = async (
    row: Readonly<LineageRow>,
    binding: Readonly<DacsWalletSpendContinuityAttestationRequestV1>,
  ): Promise<Readonly<DacsWalletSpendContinuityReceiptV1>> => requireCurrentReceipt(
    await readWitness(binding),
    pin,
    {
      lineageKey: lineage,
      head: { revision: safeRevision(row.revision), stateHash: row.state_hash },
      ...binding,
    },
  );

  const recoverWitnessedCandidate = async <T>(
    row: Readonly<LineageRow>,
    witnessHead: Readonly<DacsWalletSpendContinuityReceiptV1>,
    context: ReturnType<typeof operationContext>,
  ): Promise<T | undefined> => {
    if (context === undefined) throw new Error("wallet-spend-continuity-head-mismatch");
    const candidates = await input.pool.query<CandidateRow>(
      `SELECT candidate_id, authority_id, continuity_epoch, role_id, request_hash,
              mutation_index,
              prior_revision, prior_state_hash, next_revision, next_state_hash,
              candidate_state, candidate_value, continuity_receipt, status
         FROM dacs_wallet_spend_candidates
        WHERE lineage_key = $1 AND role_id = $2 AND operation_id = $3::uuid
          AND request_hash = $4
        ORDER BY mutation_index`,
      [lineage, context.roleId, context.operationId, context.requestHash],
    );
    const matches = candidates.rows.filter((candidate) =>
      candidate.authority_id === pin.authorityId && candidate.continuity_epoch === pin.epoch &&
      candidate.role_id === context.roleId && candidate.request_hash === context.requestHash &&
      safeRevision(candidate.prior_revision) === safeRevision(row.revision) &&
      candidate.prior_state_hash === row.state_hash &&
      safeRevision(candidate.next_revision) === witnessHead.revision &&
      candidate.next_state_hash === witnessHead.stateHash &&
      candidate.candidate_state.generation === witnessHead.revision &&
      stateHash(candidate.candidate_state) === witnessHead.stateHash &&
      candidate.status === "prepared");
    if (matches.length !== 1) throw new Error("wallet-spend-continuity-recovery-unavailable");
    const candidate = matches[0]!;
    const mutationIndex = safeRevision(candidate.mutation_index);
    const advance = await pin.witness.lookupAdvance({
      authorityId: pin.authorityId, epoch: pin.epoch, lineageKey: lineage,
      candidateId: candidate.candidate_id, roleId: context.roleId,
      operationId: context.operationId, requestHash: context.requestHash,
      mutationIndex,
    });
    if (advance === null) throw new Error("wallet-spend-continuity-recovery-unavailable");
    requireAdvanceReceipt(advance, pin, {
      authorityId: pin.authorityId, epoch: pin.epoch, lineageKey: lineage,
      predecessor: { revision: safeRevision(row.revision), stateHash: row.state_hash },
      next: { revision: witnessHead.revision, stateHash: witnessHead.stateHash },
      candidateId: candidate.candidate_id, roleId: context.roleId,
      operationId: context.operationId, requestHash: context.requestHash,
      mutationIndex, clientNonce: advance.clientNonce,
    });
    await transaction(input.pool, async (client) => {
      const head = (await client.query<LineageRow>(
        `SELECT writer_contract_version, authority_id, continuity_epoch,
                continuity_verification_key, continuity_status, continuity_receipt,
                policy_hash, revision, state_hash, state
           FROM dacs_wallet_spend_lineages WHERE lineage_key = $1 FOR UPDATE`,
        [lineage],
      )).rows[0];
      if (!head || safeRevision(head.revision) !== safeRevision(row.revision) ||
          head.state_hash !== row.state_hash) {
        throw new Error("wallet-spend-continuity-recovery-head-moved");
      }
      const updated = await client.query(
        `UPDATE dacs_wallet_spend_lineages
            SET revision = $2, state_hash = $3, state = $4::jsonb,
                continuity_receipt = $5::jsonb, updated_at = clock_timestamp()
          WHERE lineage_key = $1 AND revision = $6 AND state_hash = $7`,
        [lineage, witnessHead.revision, witnessHead.stateHash,
          canonicalize(candidate.candidate_state), canonicalize(advance),
          safeRevision(row.revision), row.state_hash],
      );
      if (updated.rowCount !== 1) throw new Error("wallet-spend-continuity-recovery-head-moved");
      const retained = await client.query(
        `UPDATE dacs_wallet_spend_candidates
            SET status = 'applied', continuity_receipt = $2::jsonb,
                applied_at = clock_timestamp()
          WHERE candidate_id = $1::uuid AND status = 'prepared'`,
        [candidate.candidate_id, canonicalize(advance)],
      );
      if (retained.rowCount !== 1) {
        throw new Error("wallet-spend-continuity-recovery-candidate-moved");
      }
    });
    const recovered = await loadDatabase();
    await attestDatabaseHead(recovered, internalBinding("recovery-readback"));
    return decodeCandidateValue<T>(candidate.candidate_value);
  };

  const load = async <T>(
    context?: ReturnType<typeof operationContext>,
  ): Promise<Readonly<{ row: LineageRow; recovered?: T }>> => {
    const row = await loadDatabase();
    const binding = internalBinding("authority-read");
    const witnessHead = await readWitness(binding);
    if (witnessHead.revision === safeRevision(row.revision) &&
        witnessHead.stateHash === row.state_hash) {
      return { row };
    }
    const recovered = await recoverWitnessedCandidate<T>(row, witnessHead, context);
    return { row: await loadDatabase(), recovered };
  };

  const store: DacsPostgresWalletSpendStateStoreV1 = {
    lineageScope(selectedPolicy): string {
      if (selectedPolicy.wallet !== input.wallet || selectedPolicy.chainId !== input.chainId) {
        throw new Error("wallet-spend-lineage-policy-mismatch");
      }
      return lineage;
    },
    async serverNow(): Promise<number> {
      const result = await input.pool.query<{ now_ms: string }>(
        "SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS now_ms",
      );
      return safeRevision(result.rows[0]?.now_ms);
    },
    async read(scope): Promise<Readonly<WalletSpendStateV1>> {
      if (scope !== lineage) throw new Error("wallet-spend-lineage-scope-mismatch");
      return structuredClone((await load()).row.state);
    },
    async attestCurrent(binding) {
      if (!UUID_RE.test(binding.operationId) || !HASH_RE.test(binding.requestHash) ||
          !HASH_RE.test(binding.clientNonce)) {
        throw new Error("wallet-spend-continuity-attestation-request-invalid");
      }
      const row = await loadDatabase();
      return attestDatabaseHead(row, binding);
    },
    async transact<T>(
      scope: string,
      operation: (
        current: Readonly<WalletSpendStateV1> | null,
      ) => Readonly<{ state: Readonly<WalletSpendStateV1>; value: T }>,
    ): Promise<T> {
      if (scope !== lineage) throw new Error("wallet-spend-lineage-scope-mismatch");
      const context = operationContext();
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const loaded = await load<T>(context);
        if (Object.hasOwn(loaded, "recovered")) return loaded.recovered as T;
        const prior = loaded.row;
        const priorRevision = safeRevision(prior.revision);
        if (priorRevision === Number.MAX_SAFE_INTEGER) {
          throw new Error("wallet-spend-postgres-revision-exhausted");
        }
        const result = operation(structuredClone(prior.state));
        if (canonicalize(result.state) === canonicalize(prior.state)) return result.value;
        if (!Number.isSafeInteger(result.state.generation) ||
            result.state.generation !== priorRevision + 1) {
          throw new Error("wallet-spend-postgres-revision-not-monotonic");
        }
        const operationId = context?.operationId ?? randomUUID();
        const requestHash = context?.requestHash ?? sha256Hex(canonicalize({
          lineage, priorRevision, state: result.state,
        }));
        // Reserve a bounded retry range for each logical mutation. One remote
        // request can legitimately prune rolling events and then reserve, so
        // separate transitions must not collide on the same candidate key.
        const index = context === undefined ? mutationIndex++ :
          context.mutationIndex * 8 + attempt;
        if (!Number.isSafeInteger(index) || index < 0 || index > 2_147_483_647) {
          throw new Error("wallet-spend-postgres-mutation-index-invalid");
        }
        const candidateId = randomUUID();
        const nextHash = stateHash(result.state);
        const storedValue = encodeCandidateValue(result.value);
        await input.pool.query(
          `INSERT INTO dacs_wallet_spend_candidates
            (candidate_id, lineage_key, writer_contract_version, authority_id,
             continuity_epoch, role_id, operation_id, request_hash, mutation_index,
             prior_revision, prior_state_hash, next_revision, next_state_hash,
             candidate_state, candidate_value, continuity_receipt, status)
           VALUES ($1::uuid, $2, 2, $3, $4, $5, $6::uuid, $7, $8, $9, $10, $11, $12,
                   $13::jsonb, $14::jsonb, NULL, 'prepared')
           ON CONFLICT (lineage_key, operation_id, mutation_index) DO NOTHING`,
          [candidateId, lineage, pin.authorityId, pin.epoch,
            context?.roleId ?? "internal:unscoped", operationId, requestHash, index, priorRevision,
            prior.state_hash, result.state.generation, nextHash,
            canonicalize(result.state), canonicalize(storedValue)],
        );
        const retained = (await input.pool.query<CandidateRow>(
          `SELECT candidate_id, authority_id, continuity_epoch, role_id, request_hash,
                  mutation_index, prior_revision, prior_state_hash, next_revision,
                  next_state_hash, candidate_state, candidate_value, continuity_receipt, status
             FROM dacs_wallet_spend_candidates
            WHERE lineage_key = $1 AND role_id = $2
              AND operation_id = $3::uuid AND mutation_index = $4`,
          [lineage, context?.roleId ?? "internal:unscoped", operationId, index],
        )).rows[0];
        if (!retained || retained.authority_id !== pin.authorityId ||
            retained.continuity_epoch !== pin.epoch ||
            retained.role_id !== (context?.roleId ?? "internal:unscoped") ||
            retained.request_hash !== requestHash) {
          throw new Error("wallet-spend-postgres-operation-conflict");
        }
        if (retained.status === "superseded") continue;
        if (
            safeRevision(retained.prior_revision) !== priorRevision ||
            retained.prior_state_hash !== prior.state_hash ||
            safeRevision(retained.next_revision) !== result.state.generation ||
            retained.next_state_hash !== nextHash ||
            canonicalize(retained.candidate_state) !== canonicalize(result.state) ||
            !candidateValueMatches(retained.candidate_value, result.value)) {
          throw new Error("wallet-spend-postgres-operation-conflict");
        }

        const transitionIdentity = {
          authorityId: pin.authorityId, epoch: pin.epoch, lineageKey: lineage,
          candidateId: retained.candidate_id,
          roleId: context?.roleId ?? "internal:unscoped", operationId, requestHash,
          mutationIndex: index,
        };
        const transition: DacsWalletSpendContinuityTransitionV1 = {
          ...transitionIdentity,
          predecessor: { revision: priorRevision, stateHash: prior.state_hash },
          next: { revision: result.state.generation, stateHash: nextHash },
          clientNonce: advanceNonce(transitionIdentity),
        };
        const receipt = await compareAndSetContinuity(pin, transition);
        const applied = await transaction(input.pool, async (client) => {
          const headResult = await client.query<LineageRow>(
            `SELECT writer_contract_version, authority_id, continuity_epoch,
                    continuity_verification_key, continuity_status, continuity_receipt,
                    policy_hash, revision, state_hash, state
               FROM dacs_wallet_spend_lineages WHERE lineage_key = $1 FOR UPDATE`,
            [lineage],
          );
          const head = headResult.rows[0];
          if (!head) throw new Error("wallet-spend-lineage-missing");
          if (safeRevision(head.revision) !== priorRevision ||
              head.state_hash !== prior.state_hash) {
            throw new Error("wallet-spend-continuity-witness-ahead");
          }
          const update = await client.query(
            `UPDATE dacs_wallet_spend_lineages
                SET revision = $2, state_hash = $3, state = $4::jsonb,
                    continuity_receipt = $5::jsonb, updated_at = clock_timestamp()
              WHERE lineage_key = $1 AND revision = $6 AND state_hash = $7`,
            [lineage, result.state.generation, nextHash, canonicalize(result.state),
              canonicalize(receipt), priorRevision, prior.state_hash],
          );
          if (update.rowCount !== 1) throw new Error("wallet-spend-head-advance-failed");
          await client.query(
            `UPDATE dacs_wallet_spend_candidates
                SET status = 'applied', continuity_receipt = $2::jsonb,
                    applied_at = clock_timestamp()
              WHERE candidate_id = $1::uuid AND status = 'prepared'`,
            [retained.candidate_id, canonicalize(receipt)],
          );
          return true;
        });
        if (applied) {
          const confirmed = await loadDatabase();
          await attestDatabaseHead(confirmed, internalBinding("mutation-readback"));
          return result.value;
        }
      }
      throw new Error("wallet-spend-postgres-concurrency-exhausted");
    },
  };
  return Object.freeze(store);
}

/** Durable request identity/result log used by the narrow authority service. */
export function createDacsPostgresWalletSpendRemoteOperationStoreV1(
  pool: DacsPostgresPoolV1,
): DacsWalletSpendRemoteOperationStoreV1 {
  const recoverReservedResponse = async (
    roleId: string,
    operationId: string,
    requestHash: string,
    request: unknown,
  ): Promise<unknown | undefined> => {
    if (request === null || typeof request !== "object" || Array.isArray(request)) {
      throw new Error("wallet-spend-authority-stored-request-invalid");
    }
    const retainedRequest = request as Record<string, unknown>;
    if (retainedRequest.operation !== "reserve" ||
        retainedRequest.operationId !== operationId ||
        sha256Hex(canonicalize(retainedRequest)) !== requestHash ||
        typeof retainedRequest.wallet !== "string" ||
        typeof retainedRequest.chainId !== "string" ||
        typeof retainedRequest.policyHash !== "string" ||
        retainedRequest.payload === null || typeof retainedRequest.payload !== "object" ||
        Array.isArray(retainedRequest.payload)) {
      return undefined;
    }
    const payload = retainedRequest.payload as Record<string, unknown>;
    if (payload.reservation === null || typeof payload.reservation !== "object" ||
        Array.isArray(payload.reservation)) {
      throw new Error("wallet-spend-authority-stored-request-invalid");
    }
    const reservation = payload.reservation as Record<string, unknown>;
    const lineage = dacsWalletSpendLineageKeyV1(
      retainedRequest.wallet,
      retainedRequest.chainId,
    );
    const candidates = await pool.query<CandidateRow & { lineage_key: string }>(
      `SELECT candidate_id, lineage_key, role_id, request_hash, prior_revision,
              prior_state_hash, next_revision, next_state_hash, candidate_state,
              candidate_value, status
         FROM dacs_wallet_spend_candidates
        WHERE lineage_key = $1 AND role_id = $2 AND operation_id = $3::uuid
          AND request_hash = $4 AND status = 'applied'
        ORDER BY next_revision`,
      [lineage, roleId, operationId, requestHash],
    );
    const recoverable = candidates.rows.flatMap((candidate) => {
      const priorRevision = safeRevision(candidate.prior_revision);
      const nextRevision = safeRevision(candidate.next_revision);
      if (candidate.lineage_key !== lineage || candidate.role_id !== roleId ||
          nextRevision !== priorRevision + 1 ||
          candidate.candidate_state.generation !== nextRevision ||
          candidate.candidate_state.policyHash !== retainedRequest.policyHash ||
          candidate.next_state_hash !== stateHash(candidate.candidate_state)) {
        throw new Error("wallet-spend-postgres-candidate-invalid");
      }
      const value = decodeCandidateValue<unknown>(candidate.candidate_value);
      if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
      const claim = value as Record<string, unknown>;
      if (Object.keys(claim).length !== 2 || claim.status !== "reserved" ||
          !Number.isSafeInteger(claim.generation) || claim.generation !== nextRevision) {
        return [];
      }
      const stored = candidate.candidate_state.reservations.find(({ reservationId }) =>
        reservationId === reservation.reservationId);
      if (!stored || stored.stage !== "reserved" || stored.generation !== nextRevision ||
          canonicalize(stored.reservation) !== canonicalize(reservation) ||
          typeof stored.owner !== "string") {
        throw new Error("wallet-spend-postgres-reserved-candidate-invalid");
      }
      return [{ candidate, stored, nextRevision }];
    });
    if (recoverable.length === 0) return undefined;
    if (recoverable.length !== 1) {
      throw new Error("wallet-spend-postgres-operation-conflict");
    }
    const recovered = recoverable[0]!;
    const headResult = await pool.query<LineageRow>(
      `SELECT policy_hash, revision, state_hash, state
         FROM dacs_wallet_spend_lineages WHERE lineage_key = $1`,
      [lineage],
    );
    const head = headResult.rows[0];
    if (!head || head.policy_hash !== retainedRequest.policyHash ||
        safeRevision(head.revision) !== head.state.generation ||
        head.state_hash !== stateHash(head.state) ||
        safeRevision(head.revision) < recovered.nextRevision ||
        (safeRevision(head.revision) === recovered.nextRevision &&
          head.state_hash !== recovered.candidate.next_state_hash)) {
      throw new Error("wallet-spend-postgres-applied-candidate-missing");
    }
    return {
      protocolVersion: "1",
      operationId,
      requestHash,
      revision: recovered.nextRevision,
      status: "ok",
      result: {
        status: "reserved",
        permit: {
          reservationId: recovered.stored.reservationId,
          bindingHash: recovered.stored.bindingHash,
          settlementBindingHash: recovered.stored.reservation.settlementBindingHash,
          owner: recovered.stored.owner,
          generation: recovered.stored.generation,
          reservation: recovered.stored.reservation,
        },
      },
    };
  };

  const load: DacsWalletSpendRemoteOperationStoreV1["load"] = async (input) => {
    const result = await pool.query<{
      request_hash: string;
      request: unknown;
      response: unknown | null;
    }>(
      `SELECT request_hash, request, response FROM dacs_wallet_spend_operations
        WHERE role_id = $1 AND operation_id = $2::uuid`,
      [input.roleId, input.operationId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const recovered = row.response === null
      ? await recoverReservedResponse(
          input.roleId,
          input.operationId,
          row.request_hash,
          row.request,
        )
      : undefined;
    return row.response === null && recovered === undefined
      ? { requestHash: row.request_hash, request: row.request as never }
      : {
          requestHash: row.request_hash,
          request: row.request as never,
          response: (row.response ?? recovered) as never,
        };
  };
  const store: DacsWalletSpendRemoteOperationStoreV1 = {
    load,
    async claim(input) {
      const inserted = await pool.query(
        `INSERT INTO dacs_wallet_spend_operations
          (writer_contract_version, role_id, operation_id, request_hash, request)
         VALUES (2, $1, $2::uuid, $3, $4::jsonb) ON CONFLICT DO NOTHING`,
        [input.roleId, input.operationId, input.requestHash,
          canonicalize(input.request)],
      );
      if (inserted.rowCount === 1) return "new";
      const prior = await load({
        roleId: input.roleId,
        operationId: input.operationId,
      });
      if (prior?.requestHash !== input.requestHash) {
        throw new Error("wallet-spend-authority-operation-conflict");
      }
      return "existing";
    },
    async complete(input) {
      const result = await pool.query(
        `UPDATE dacs_wallet_spend_operations
            SET response = $4::jsonb, completed_at = clock_timestamp()
          WHERE role_id = $1 AND operation_id = $2::uuid AND request_hash = $3
            AND (response IS NULL OR response = $4::jsonb)`,
        [input.roleId, input.operationId, input.requestHash,
          canonicalize(input.response)],
      );
      if (result.rowCount !== 1) {
        throw new Error("wallet-spend-authority-operation-conflict");
      }
    },
  };
  return Object.freeze(store);
}

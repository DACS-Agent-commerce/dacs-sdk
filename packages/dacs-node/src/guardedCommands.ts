import { canonicalize, canonicalizeDecimal, sha256Hex } from "@kynesyslabs/dacs/canonical";
import {
  parseCanonicalClaimReference,
  sameCanonicalClaimIdentity,
} from "@kynesyslabs/dacs/identity";
import { isCanonicalJobId } from "@kynesyslabs/dacs/negotiate";

import {
  DACS_LIVE_DOCTOR_REPORT_SCHEMA,
  type DacsLiveDoctorReportV1,
} from "./doctor.js";
import type {
  DacsNodeSqliteDatabase,
  DacsNodeSqliteEffectKind,
  DacsNodeSqliteEffectLease,
} from "./sqlite.js";

const HASH_RE = /^[0-9a-f]{64}$/;
const CODE_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const DEMOS_ADDRESS_RE = /^[0-9a-f]{64}$/;
const DEFAULT_DOCTOR_MAX_AGE_MS = 60_000;
const DEFAULT_EFFECT_LEASE_MS = 30_000;

export const DACS_SETUP_PLAN_SCHEMA = "dacs-guarded-setup-plan/v1" as const;
export const DACS_PURCHASE_PLAN_SCHEMA = "dacs-guarded-purchase-plan/v1" as const;
export const DACS_PAY_DEM_PURCHASE_PLAN_SCHEMA =
  "dacs-guarded-pay-dem-purchase-plan/v1" as const;
export const DACS_FUNDED_DOCTOR_PLAN_SCHEMA = "dacs-funded-doctor-plan/v1" as const;
export const DACS_SETUP_CONSENT_DOMAIN = "dacs-setup-consent:v1" as const;
export const DACS_PURCHASE_CONSENT_DOMAIN = "dacs-purchase-consent:v1" as const;
export const DACS_FUNDED_DOCTOR_CONSENT_DOMAIN = "dacs-funded-doctor-consent:v1" as const;

export interface DacsGuardedSetupActionV1 {
  actionId: string;
  effectId: string;
  maximumSpendDem: string;
}

export interface DacsGuardedSetupPlanV1 {
  schema: typeof DACS_SETUP_PLAN_SCHEMA;
  kind: "setup";
  effectId: string;
  buyerAuthority: string;
  sellerAuthority: string;
  demosNetwork: string;
  listingContentHash: string;
  actions: readonly Readonly<DacsGuardedSetupActionV1>[];
  actionSpendDem: string;
  safetyMarginDem: string;
  maximumSpendDem: string;
  paymentPossible: false;
  planHash: string;
}

export interface DacsGuardedPurchasePlanV1 {
  schema: typeof DACS_PURCHASE_PLAN_SCHEMA;
  kind: "purchase";
  effectId: string;
  jobId: string;
  resume: boolean;
  listingRef: string;
  requestHash: string;
  buyerAuthority: string;
  sellerAuthority: string;
  payer: string;
  payee: string;
  railId: string;
  network: string;
  asset: string;
  serviceAmount: string;
  maximumServiceAmount: string;
  estimatedNetworkFeeEth: string;
  maximumNetworkFeeEth: string;
  paymentPossible: true;
  planHash: string;
}

export interface DacsGuardedPayDemPurchasePlanV1 {
  schema: typeof DACS_PAY_DEM_PURCHASE_PLAN_SCHEMA;
  kind: "purchase-pay-dem";
  effectId: string;
  jobId: string;
  resume: boolean;
  listingRef: string;
  requestHash: string;
  buyerAuthority: string;
  sellerAuthority: string;
  payer: string;
  payee: string;
  railId: string;
  network: "demos";
  asset: "DEM";
  serviceAmount: string;
  maximumServiceAmount: string;
  /** Transfer plus Demos transaction fees; enforced again by the rail. */
  maximumTotalDebitDem: string;
  paymentPossible: true;
  planHash: string;
}

export interface DacsFundedDoctorDebitV1 {
  actionId: string;
  asset: string;
  maximumDebit: string;
}

export interface DacsFundedDoctorCeilingV1 {
  asset: string;
  maximumTotalDebit: string;
}

export interface DacsFundedDoctorPlanV1 {
  schema: typeof DACS_FUNDED_DOCTOR_PLAN_SCHEMA;
  kind: "funded-doctor";
  effectId: string;
  runId: string;
  disposableWallet: string;
  walletAuthority: string;
  network: string;
  debits: readonly Readonly<DacsFundedDoctorDebitV1>[];
  ceilings: readonly Readonly<DacsFundedDoctorCeilingV1>[];
  paymentPossible: true;
  planHash: string;
}

export type DacsGuardedPlanV1 = DacsGuardedSetupPlanV1 | DacsGuardedPurchasePlanV1 |
  DacsGuardedPayDemPurchasePlanV1 | DacsFundedDoctorPlanV1;

export interface DacsGuardedConsentV1 {
  domain: typeof DACS_SETUP_CONSENT_DOMAIN | typeof DACS_PURCHASE_CONSENT_DOMAIN |
    typeof DACS_FUNDED_DOCTOR_CONSENT_DOMAIN;
  planHash: string;
  confirmedAt: number;
  mechanism: "environment-and-interactive" | "environment-and-non-interactive";
  consentHash: string;
}

export type DacsGuardedExecutorResultV1 = Readonly<
  | { status: "completed"; result: unknown }
  | { status: "ambiguous"; reasonCode: string; retryAt?: number }
  | { status: "operator-action"; reasonCode: string }
  | { status: "reconciled-performed"; result: unknown }
  | { status: "reconciled-absent"; absenceProofHash: string }
  | { status: "reconciled-indeterminate"; reasonCode: string; retryAt?: number }
>;

export interface DacsGuardedEffectFenceV1 {
  mode: "perform" | "reconcile";
  effectId: string;
  planHash: string;
  generation: number;
  idempotencyKey: string;
  assertCurrent(): Promise<void>;
}

export type DacsGuardedExecutorV1 = (input: Readonly<{
  plan: Readonly<DacsGuardedPlanV1>;
  consent: Readonly<DacsGuardedConsentV1>;
  fence: Readonly<DacsGuardedEffectFenceV1>;
}>) => Promise<Readonly<DacsGuardedExecutorResultV1>> |
  Readonly<DacsGuardedExecutorResultV1>;

export type DacsGuardedCommandResultV1 = Readonly<
  | { status: "plan-only"; plan: Readonly<DacsGuardedPlanV1> }
  | { status: "completed" | "existing-completion"; planHash: string; result: unknown }
  | {
      status: "waiting" | "reconciliation-required" | "operator-action";
      planHash: string;
      reasonCode: string;
    }
  | { status: "reconciliation-cleared"; planHash: string; absenceProofHash: string }
>;

export interface DacsGuardedCommandOptionsV1 {
  plan: Readonly<DacsGuardedPlanV1>;
  execute?: boolean;
  database: DacsNodeSqliteDatabase;
  workerId: string;
  doctorReports: readonly Readonly<DacsLiveDoctorReportV1>[];
  confirmation?: string;
  nonInteractive?: boolean;
  confirm?: (summary: Readonly<{
    kind: "setup" | "purchase" | "purchase-pay-dem" | "funded-doctor";
    planHash: string;
    actionCount: number;
    network: string;
    maximumAssetSpend: string;
    maximumNetworkFee: string;
    paymentPossible: boolean;
  }>) => Promise<boolean> | boolean;
  executor: DacsGuardedExecutorV1;
  now?: () => number;
  doctorMaxAgeMs?: number;
  leaseDurationMs?: number;
}

export class DacsGuardedCommandError extends Error {
  override readonly name = "DacsGuardedCommandError";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

interface DecimalValue {
  units: bigint;
  scale: number;
}

function text(value: unknown, maximum = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    value.trim() === value && !value.includes("\0");
}

function exactDataKeys(
  value: unknown,
  keys: readonly string[],
): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const ownKeys = Reflect.ownKeys(value);
    return ownKeys.length === keys.length && keys.every((key) => ownKeys.includes(key)) &&
      ownKeys.every((key) => {
        if (typeof key !== "string" || !keys.includes(key)) return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
      });
  } catch {
    return false;
  }
}

function captureClosedDataObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("guarded command options must be a closed data object");
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
    const allowed = new Set([...required, ...optional]);
    const ownKeys = Reflect.ownKeys(value);
    if (required.some((key) => !ownKeys.includes(key)) ||
        ownKeys.some((key) => typeof key !== "string" || !allowed.has(key))) {
      throw new TypeError();
    }
    const captured: Record<string, unknown> = {};
    for (const key of ownKeys) {
      if (typeof key !== "string") throw new TypeError();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError();
      }
      captured[key] = descriptor.value;
    }
    return Object.freeze(captured);
  } catch {
    throw new TypeError("guarded command options must be a closed data object");
  }
}

function positiveInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 &&
    value <= maximum;
}

function decimal(value: unknown): value is string {
  if (!text(value, 128)) return false;
  try {
    return canonicalizeDecimal(value) === value && !value.startsWith("-");
  } catch {
    return false;
  }
}

function demosAuthority(value: unknown): value is string {
  const parsed = parseCanonicalClaimReference(value);
  return parsed !== null && parsed.identity.scheme === "did" &&
    /^demos:agent:[0-9a-f]{64}$/.test(parsed.identity.identifier);
}

function decimalValue(value: string): DecimalValue {
  const [whole, fraction = ""] = value.split(".");
  return { units: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

function align(value: DecimalValue, scale: number): bigint {
  return value.units * (10n ** BigInt(scale - value.scale));
}

function addDecimals(values: readonly string[]): string {
  const parsed = values.map(decimalValue);
  const scale = Math.max(0, ...parsed.map((item) => item.scale));
  const units = parsed.reduce((sum, item) => sum + align(item, scale), 0n);
  if (scale === 0) return units.toString();
  const digits = units.toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, -scale);
  const fraction = digits.slice(-scale).replace(/0+$/, "");
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}

function lessThanOrEqual(left: string, right: string): boolean {
  const a = decimalValue(left);
  const b = decimalValue(right);
  const scale = Math.max(a.scale, b.scale);
  return align(a, scale) <= align(b, scale);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function withPlanHash<T extends object>(domain: string, value: T): Readonly<T & { planHash: string }> {
  const captured = deepFreeze(structuredClone(value));
  const planHash = sha256Hex(`${domain}${canonicalize(captured)}`);
  return deepFreeze({ ...captured, planHash });
}

export function createDacsGuardedSetupPlanV1(input: Readonly<{
  effectId: string;
  buyerAuthority: string;
  sellerAuthority: string;
  demosNetwork: string;
  listingContentHash: string;
  actions: readonly Readonly<DacsGuardedSetupActionV1>[];
  safetyMarginDem: string;
  maximumSpendDem: string;
}>): Readonly<DacsGuardedSetupPlanV1> {
  if (input === null || typeof input !== "object" || !text(input.effectId, 256) ||
      !demosAuthority(input.buyerAuthority) || !demosAuthority(input.sellerAuthority) ||
      sameCanonicalClaimIdentity(input.buyerAuthority, input.sellerAuthority) ||
      !text(input.demosNetwork, 128) || !HASH_RE.test(input.listingContentHash) ||
      !Array.isArray(input.actions) || input.actions.length === 0 || input.actions.length > 64 ||
      !decimal(input.safetyMarginDem) || !decimal(input.maximumSpendDem)) {
    throw new TypeError("guarded setup plan is invalid");
  }
  const seenActions = new Set<string>();
  const seenEffects = new Set<string>();
  const actions = input.actions.map((action) => {
    if (action === null || typeof action !== "object" || !CODE_RE.test(action.actionId) ||
        !text(action.effectId, 256) || !decimal(action.maximumSpendDem) ||
        seenActions.has(action.actionId) || seenEffects.has(action.effectId)) {
      throw new TypeError("guarded setup action is invalid");
    }
    seenActions.add(action.actionId);
    seenEffects.add(action.effectId);
    return Object.freeze({ ...action });
  });
  const actionSpendDem = addDecimals(actions.map((action) => action.maximumSpendDem));
  const required = addDecimals([actionSpendDem, input.safetyMarginDem]);
  if (!lessThanOrEqual(required, input.maximumSpendDem)) {
    throw new DacsGuardedCommandError("setup-spend-ceiling-insufficient");
  }
  return withPlanHash("dacs-guarded-setup-plan:v1:", {
    schema: DACS_SETUP_PLAN_SCHEMA,
    kind: "setup" as const,
    effectId: input.effectId,
    buyerAuthority: input.buyerAuthority,
    sellerAuthority: input.sellerAuthority,
    demosNetwork: input.demosNetwork,
    listingContentHash: input.listingContentHash,
    actions: Object.freeze(actions),
    actionSpendDem,
    safetyMarginDem: input.safetyMarginDem,
    maximumSpendDem: input.maximumSpendDem,
    paymentPossible: false as const,
  });
}

export function createDacsGuardedPurchasePlanV1(input: Readonly<{
  effectId: string;
  jobId: string;
  resume?: boolean;
  listingRef: string;
  requestHash: string;
  buyerAuthority: string;
  sellerAuthority: string;
  payer: string;
  payee: string;
  railId: string;
  network: string;
  asset: string;
  serviceAmount: string;
  maximumServiceAmount: string;
  estimatedNetworkFeeEth: string;
  maximumNetworkFeeEth: string;
}>): Readonly<DacsGuardedPurchasePlanV1> {
  if (input === null || typeof input !== "object" || !text(input.effectId, 256) ||
      !isCanonicalJobId(input.jobId) || !text(input.listingRef) ||
      !HASH_RE.test(input.requestHash) || !demosAuthority(input.buyerAuthority) ||
      !demosAuthority(input.sellerAuthority) ||
      sameCanonicalClaimIdentity(input.buyerAuthority, input.sellerAuthority) ||
      !EVM_ADDRESS_RE.test(input.payer) || !EVM_ADDRESS_RE.test(input.payee) ||
      input.payer.toLowerCase() === input.payee.toLowerCase() ||
      !text(input.railId, 128) || !input.railId.startsWith("x402:") ||
      input.network !== "eip155:84532" ||
      !text(input.asset, 64) || !decimal(input.serviceAmount) ||
      !decimal(input.maximumServiceAmount) || !decimal(input.estimatedNetworkFeeEth) ||
      !decimal(input.maximumNetworkFeeEth) ||
      !lessThanOrEqual(input.serviceAmount, input.maximumServiceAmount) ||
      !lessThanOrEqual(input.estimatedNetworkFeeEth, input.maximumNetworkFeeEth)) {
    throw new TypeError("guarded purchase plan is invalid or exceeds a ceiling");
  }
  return withPlanHash("dacs-guarded-purchase-plan:v1:", {
    schema: DACS_PURCHASE_PLAN_SCHEMA,
    kind: "purchase" as const,
    effectId: input.effectId,
    jobId: input.jobId,
    resume: input.resume ?? false,
    listingRef: input.listingRef,
    requestHash: input.requestHash,
    buyerAuthority: input.buyerAuthority,
    sellerAuthority: input.sellerAuthority,
    payer: input.payer.toLowerCase(),
    payee: input.payee.toLowerCase(),
    railId: input.railId,
    network: input.network,
    asset: input.asset,
    serviceAmount: input.serviceAmount,
    maximumServiceAmount: input.maximumServiceAmount,
    estimatedNetworkFeeEth: input.estimatedNetworkFeeEth,
    maximumNetworkFeeEth: input.maximumNetworkFeeEth,
    paymentPossible: true as const,
  });
}

export function createDacsGuardedPayDemPurchasePlanV1(input: Readonly<{
  effectId: string;
  jobId: string;
  resume?: boolean;
  listingRef: string;
  requestHash: string;
  buyerAuthority: string;
  sellerAuthority: string;
  payer: string;
  payee: string;
  railId: string;
  serviceAmount: string;
  maximumServiceAmount: string;
  maximumTotalDebitDem: string;
}>): Readonly<DacsGuardedPayDemPurchasePlanV1> {
  if (input === null || typeof input !== "object" || !text(input.effectId, 256) ||
      !isCanonicalJobId(input.jobId) || !text(input.listingRef) ||
      !HASH_RE.test(input.requestHash) || !demosAuthority(input.buyerAuthority) ||
      !demosAuthority(input.sellerAuthority) ||
      sameCanonicalClaimIdentity(input.buyerAuthority, input.sellerAuthority) ||
      !DEMOS_ADDRESS_RE.test(input.payer) || !DEMOS_ADDRESS_RE.test(input.payee) ||
      input.payer === input.payee || !text(input.railId, 128) ||
      input.railId !== "demos-native:DEM" || !decimal(input.serviceAmount) ||
      !decimal(input.maximumServiceAmount) || !decimal(input.maximumTotalDebitDem) ||
      !lessThanOrEqual(input.serviceAmount, input.maximumServiceAmount) ||
      !lessThanOrEqual(input.serviceAmount, input.maximumTotalDebitDem)) {
    throw new TypeError("guarded pay-dem purchase plan is invalid or exceeds a ceiling");
  }
  return withPlanHash("dacs-guarded-pay-dem-purchase-plan:v1:", {
    schema: DACS_PAY_DEM_PURCHASE_PLAN_SCHEMA,
    kind: "purchase-pay-dem" as const,
    effectId: input.effectId,
    jobId: input.jobId,
    resume: input.resume ?? false,
    listingRef: input.listingRef,
    requestHash: input.requestHash,
    buyerAuthority: input.buyerAuthority,
    sellerAuthority: input.sellerAuthority,
    payer: input.payer,
    payee: input.payee,
    railId: input.railId,
    network: "demos" as const,
    asset: "DEM" as const,
    serviceAmount: input.serviceAmount,
    maximumServiceAmount: input.maximumServiceAmount,
    maximumTotalDebitDem: input.maximumTotalDebitDem,
    paymentPossible: true as const,
  });
}

export function createDacsFundedDoctorPlanV1(input: Readonly<{
  effectId: string;
  runId: string;
  disposableWallet: string;
  walletAuthority: string;
  network: string;
  debits: readonly Readonly<DacsFundedDoctorDebitV1>[];
  ceilings: readonly Readonly<DacsFundedDoctorCeilingV1>[];
}>): Readonly<DacsFundedDoctorPlanV1> {
  if (input === null || typeof input !== "object" || !text(input.effectId, 256) ||
      !isCanonicalJobId(input.runId) || !CODE_RE.test(input.disposableWallet) ||
      !text(input.walletAuthority) || !text(input.network, 128) ||
      input.network === "eip155:1" || input.network === "eip155:8453" ||
      !Array.isArray(input.debits) || input.debits.length === 0 || input.debits.length > 32 ||
      !Array.isArray(input.ceilings) || input.ceilings.length === 0 || input.ceilings.length > 8) {
    throw new TypeError("funded doctor plan is invalid");
  }
  const actionIds = new Set<string>();
  const debits = input.debits.map((debit) => {
    if (debit === null || typeof debit !== "object" || !CODE_RE.test(debit.actionId) ||
        actionIds.has(debit.actionId) || !text(debit.asset, 64) ||
        !decimal(debit.maximumDebit)) {
      throw new TypeError("funded doctor debit is invalid");
    }
    actionIds.add(debit.actionId);
    return Object.freeze({ ...debit });
  });
  const ceilingAssets = new Set<string>();
  const ceilings = input.ceilings.map((ceiling) => {
    if (ceiling === null || typeof ceiling !== "object" || !text(ceiling.asset, 64) ||
        ceilingAssets.has(ceiling.asset) || !decimal(ceiling.maximumTotalDebit)) {
      throw new TypeError("funded doctor ceiling is invalid");
    }
    ceilingAssets.add(ceiling.asset);
    return Object.freeze({ ...ceiling });
  }).sort((left, right) => left.asset.localeCompare(right.asset));
  for (const asset of new Set(debits.map((debit) => debit.asset))) {
    const ceiling = ceilings.find((item) => item.asset === asset);
    if (ceiling === undefined || !lessThanOrEqual(
      addDecimals(debits.filter((debit) => debit.asset === asset)
        .map((debit) => debit.maximumDebit)),
      ceiling.maximumTotalDebit,
    )) throw new DacsGuardedCommandError("funded-doctor-debit-ceiling-insufficient");
  }
  if (ceilings.some((ceiling) => !debits.some((debit) => debit.asset === ceiling.asset))) {
    throw new TypeError("funded doctor ceiling has no bound debit");
  }
  return withPlanHash("dacs-funded-doctor-plan:v1:", {
    schema: DACS_FUNDED_DOCTOR_PLAN_SCHEMA,
    kind: "funded-doctor" as const,
    effectId: input.effectId,
    runId: input.runId,
    disposableWallet: input.disposableWallet,
    walletAuthority: input.walletAuthority,
    network: input.network,
    debits: Object.freeze(debits),
    ceilings: Object.freeze(ceilings),
    paymentPossible: true as const,
  });
}

function captureGuardedPlan(plan: unknown): Readonly<DacsGuardedPlanV1> | undefined {
  try {
    if (plan === null || typeof plan !== "object") return undefined;
    const kindDescriptor = Object.getOwnPropertyDescriptor(plan, "kind");
    if (kindDescriptor === undefined || !("value" in kindDescriptor)) return undefined;
    const candidate = plan as Readonly<DacsGuardedPlanV1>;
    if (kindDescriptor.value === "setup") {
      if (!exactDataKeys(candidate, [
        "schema", "kind", "effectId", "buyerAuthority", "sellerAuthority",
        "demosNetwork", "listingContentHash", "actions", "actionSpendDem",
        "safetyMarginDem", "maximumSpendDem", "paymentPossible", "planHash",
      ]) || candidate.schema !== DACS_SETUP_PLAN_SCHEMA ||
          candidate.paymentPossible !== false || !Array.isArray(candidate.actions) ||
          candidate.actions.some((action) => !exactDataKeys(action, [
            "actionId", "effectId", "maximumSpendDem",
          ]))) return undefined;
      const reconstructed = createDacsGuardedSetupPlanV1({
        effectId: candidate.effectId,
        buyerAuthority: candidate.buyerAuthority,
        sellerAuthority: candidate.sellerAuthority,
        demosNetwork: candidate.demosNetwork,
        listingContentHash: candidate.listingContentHash,
        actions: candidate.actions,
        safetyMarginDem: candidate.safetyMarginDem,
        maximumSpendDem: candidate.maximumSpendDem,
      });
      return canonicalize(reconstructed) === canonicalize(candidate) ? reconstructed : undefined;
    }
    if (kindDescriptor.value === "purchase") {
      if (!exactDataKeys(candidate, [
        "schema", "kind", "effectId", "jobId", "resume", "listingRef",
        "requestHash", "buyerAuthority", "sellerAuthority", "payer", "payee",
        "railId", "network", "asset", "serviceAmount", "maximumServiceAmount",
        "estimatedNetworkFeeEth", "maximumNetworkFeeEth", "paymentPossible", "planHash",
      ]) || candidate.schema !== DACS_PURCHASE_PLAN_SCHEMA ||
          candidate.paymentPossible !== true) return undefined;
      const reconstructed = createDacsGuardedPurchasePlanV1({
        effectId: candidate.effectId,
        jobId: candidate.jobId,
        resume: candidate.resume,
        listingRef: candidate.listingRef,
        requestHash: candidate.requestHash,
        buyerAuthority: candidate.buyerAuthority,
        sellerAuthority: candidate.sellerAuthority,
        payer: candidate.payer,
        payee: candidate.payee,
        railId: candidate.railId,
        network: candidate.network,
        asset: candidate.asset,
        serviceAmount: candidate.serviceAmount,
        maximumServiceAmount: candidate.maximumServiceAmount,
        estimatedNetworkFeeEth: candidate.estimatedNetworkFeeEth,
        maximumNetworkFeeEth: candidate.maximumNetworkFeeEth,
      });
      return canonicalize(reconstructed) === canonicalize(candidate) ? reconstructed : undefined;
    }
    if (kindDescriptor.value === "purchase-pay-dem") {
      if (!exactDataKeys(candidate, [
        "schema", "kind", "effectId", "jobId", "resume", "listingRef",
        "requestHash", "buyerAuthority", "sellerAuthority", "payer", "payee",
        "railId", "network", "asset", "serviceAmount", "maximumServiceAmount",
        "maximumTotalDebitDem", "paymentPossible", "planHash",
      ]) || candidate.schema !== DACS_PAY_DEM_PURCHASE_PLAN_SCHEMA ||
          candidate.paymentPossible !== true) return undefined;
      const payDem = candidate as Readonly<DacsGuardedPayDemPurchasePlanV1>;
      const reconstructed = createDacsGuardedPayDemPurchasePlanV1({
        effectId: payDem.effectId,
        jobId: payDem.jobId,
        resume: payDem.resume,
        listingRef: payDem.listingRef,
        requestHash: payDem.requestHash,
        buyerAuthority: payDem.buyerAuthority,
        sellerAuthority: payDem.sellerAuthority,
        payer: payDem.payer,
        payee: payDem.payee,
        railId: payDem.railId,
        serviceAmount: payDem.serviceAmount,
        maximumServiceAmount: payDem.maximumServiceAmount,
        maximumTotalDebitDem: payDem.maximumTotalDebitDem,
      });
      return canonicalize(reconstructed) === canonicalize(candidate) ? reconstructed : undefined;
    }
    if (kindDescriptor.value === "funded-doctor") {
      if (!exactDataKeys(candidate, [
        "schema", "kind", "effectId", "runId", "disposableWallet",
        "walletAuthority", "network", "debits", "ceilings", "paymentPossible", "planHash",
      ]) || candidate.schema !== DACS_FUNDED_DOCTOR_PLAN_SCHEMA ||
          candidate.paymentPossible !== true || !Array.isArray(candidate.debits) ||
          !Array.isArray(candidate.ceilings) ||
          candidate.debits.some((debit) => !exactDataKeys(debit, [
            "actionId", "asset", "maximumDebit",
          ])) || candidate.ceilings.some((ceiling) => !exactDataKeys(ceiling, [
            "asset", "maximumTotalDebit",
          ]))) return undefined;
      const reconstructed = createDacsFundedDoctorPlanV1({
        effectId: candidate.effectId,
        runId: candidate.runId,
        disposableWallet: candidate.disposableWallet,
        walletAuthority: candidate.walletAuthority,
        network: candidate.network,
        debits: candidate.debits,
        ceilings: candidate.ceilings,
      });
      return canonicalize(reconstructed) === canonicalize(candidate) ? reconstructed : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function doctorBody(report: Readonly<DacsLiveDoctorReportV1>): object {
  return {
    schema: report.schema,
    phase: report.phase,
    scope: report.scope,
    generatedAt: report.generatedAt,
    sdkVersion: report.sdkVersion,
    standardRevision: report.standardRevision,
    profile: report.profile,
    safety: report.safety,
    checks: report.checks,
    gate: report.gate,
    exitCode: report.exitCode,
  };
}

function requireDoctor(
  report: Readonly<DacsLiveDoctorReportV1> | undefined,
  phase: "pre-start" | "post-start",
  scope: "start" | "setup" | "buy",
  now: number,
  maximumAgeMs: number,
): void {
  if (report === undefined || report.schema !== DACS_LIVE_DOCTOR_REPORT_SCHEMA ||
      report.phase !== phase || report.scope !== scope || report.gate.status !== "pass" ||
      report.exitCode !== 0 || report.safety.readOnly !== true || report.safety.funded !== false ||
      !HASH_RE.test(report.reportHash) ||
      sha256Hex(canonicalize(doctorBody(report))) !== report.reportHash ||
      !Number.isSafeInteger(report.generatedAt) || report.generatedAt > now ||
      now - report.generatedAt > maximumAgeMs) {
    throw new DacsGuardedCommandError("doctor-prerequisite-invalid-or-stale");
  }
}

function consentFor(
  plan: Readonly<DacsGuardedPlanV1>,
  confirmedAt: number,
  mechanism: DacsGuardedConsentV1["mechanism"],
): Readonly<DacsGuardedConsentV1> {
  const domain = plan.kind === "setup"
    ? DACS_SETUP_CONSENT_DOMAIN
    : plan.kind === "purchase" || plan.kind === "purchase-pay-dem"
      ? DACS_PURCHASE_CONSENT_DOMAIN
    : DACS_FUNDED_DOCTOR_CONSENT_DOMAIN;
  const body = Object.freeze({ domain, planHash: plan.planHash, confirmedAt, mechanism });
  return Object.freeze({
    ...body,
    consentHash: sha256Hex(`${domain}:${canonicalize(body)}`),
  });
}

function summaryFor(plan: Readonly<DacsGuardedPlanV1>) {
  return Object.freeze({
    kind: plan.kind,
    planHash: plan.planHash,
    actionCount: plan.kind === "setup" ? plan.actions.length
      : plan.kind === "funded-doctor" ? plan.debits.length : 1,
    network: plan.kind === "setup" ? plan.demosNetwork : plan.network,
    maximumAssetSpend: plan.kind === "setup"
      ? `${plan.maximumSpendDem} DEM`
      : plan.kind === "purchase" || plan.kind === "purchase-pay-dem"
        ? `${plan.maximumServiceAmount} ${plan.asset}`
      : plan.ceilings.map((item) => `${item.maximumTotalDebit} ${item.asset}`).join(", "),
    maximumNetworkFee: plan.kind === "setup"
      ? `${plan.maximumSpendDem} DEM total`
      : plan.kind === "purchase" ? `${plan.maximumNetworkFeeEth} ETH`
      : plan.kind === "purchase-pay-dem"
        ? `included in ${plan.maximumTotalDebitDem} DEM total debit`
      : "included in per-asset total debit caps",
    paymentPossible: plan.paymentPossible,
  });
}

function planEffectKind(plan: Readonly<DacsGuardedPlanV1>): DacsNodeSqliteEffectKind {
  return plan.kind === "setup" ? "setup-write" : "payment";
}

function idempotencyKey(plan: Readonly<DacsGuardedPlanV1>): string {
  return `${plan.kind}:guarded-command:v1:${plan.planHash}`;
}

function captureExecutorResult(value: unknown): DacsGuardedExecutorResultV1 | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result = value as Record<string, unknown>;
  if (result.status === "completed" || result.status === "reconciled-performed") {
    return Object.hasOwn(result, "result") && Object.keys(result).length === 2
      ? result as unknown as DacsGuardedExecutorResultV1 : undefined;
  }
  if (result.status === "reconciled-absent") {
    return Object.keys(result).length === 2 && typeof result.absenceProofHash === "string" &&
      HASH_RE.test(result.absenceProofHash)
      ? result as unknown as DacsGuardedExecutorResultV1 : undefined;
  }
  if (result.status === "ambiguous" || result.status === "reconciled-indeterminate") {
    return Object.keys(result).every((key) =>
      key === "status" || key === "reasonCode" || key === "retryAt") &&
      typeof result.reasonCode === "string" && CODE_RE.test(result.reasonCode) &&
      (result.retryAt === undefined ||
        (Number.isSafeInteger(result.retryAt) && (result.retryAt as number) >= 0))
      ? result as unknown as DacsGuardedExecutorResultV1 : undefined;
  }
  if (result.status === "operator-action") {
    return Object.keys(result).length === 2 && typeof result.reasonCode === "string" &&
      CODE_RE.test(result.reasonCode)
      ? result as unknown as DacsGuardedExecutorResultV1 : undefined;
  }
  return undefined;
}

async function recordResult(
  database: DacsNodeSqliteDatabase,
  kind: DacsNodeSqliteEffectKind,
  plan: Readonly<DacsGuardedPlanV1>,
  lease: Readonly<DacsNodeSqliteEffectLease>,
  result: Readonly<DacsGuardedExecutorResultV1>,
): Promise<Readonly<DacsGuardedCommandResultV1>> {
  if (lease.mode === "perform") {
    if (result.status === "completed") {
      const write = database.recordEffectCompleted({
        kind,
        effectId: plan.effectId,
        bindingHash: plan.planHash,
        lease,
        result: result.result,
      });
      if (write.status !== "recorded" && write.status !== "existing") {
        throw new DacsGuardedCommandError("effect-completion-conflict");
      }
      return Object.freeze({ status: "completed", planHash: plan.planHash, result: result.result });
    }
    if (result.status === "ambiguous") {
      database.recordEffectAmbiguous({
        kind,
        effectId: plan.effectId,
        bindingHash: plan.planHash,
        lease,
        reasonCode: result.reasonCode,
        ...(result.retryAt === undefined ? {} : { retryAt: result.retryAt }),
      });
      return Object.freeze({
        status: "reconciliation-required",
        planHash: plan.planHash,
        reasonCode: result.reasonCode,
      });
    }
    if (result.status === "operator-action") {
      database.requireEffectOperatorAction({
        kind,
        effectId: plan.effectId,
        bindingHash: plan.planHash,
        lease,
        reasonCode: result.reasonCode,
      });
      return Object.freeze({ status: "operator-action", planHash: plan.planHash,
        reasonCode: result.reasonCode });
    }
    throw new DacsGuardedCommandError("executor-result-mode-incompatible");
  }

  if (result.status === "reconciled-performed") {
    const write = database.recordEffectReconciliation({
      kind,
      effectId: plan.effectId,
      bindingHash: plan.planHash,
      lease: lease as Readonly<DacsNodeSqliteEffectLease & { mode: "reconcile" }>,
      result: { disposition: "performed", result: result.result },
    });
    if (write.status !== "recorded" && write.status !== "existing") {
      throw new DacsGuardedCommandError("effect-reconciliation-conflict");
    }
    return Object.freeze({ status: "completed", planHash: plan.planHash, result: result.result });
  }
  if (result.status === "reconciled-absent") {
    database.recordEffectReconciliation({
      kind,
      effectId: plan.effectId,
      bindingHash: plan.planHash,
      lease: lease as Readonly<DacsNodeSqliteEffectLease & { mode: "reconcile" }>,
      result: { disposition: "absent", absenceProofHash: result.absenceProofHash },
    });
    return Object.freeze({
      status: "reconciliation-cleared",
      planHash: plan.planHash,
      absenceProofHash: result.absenceProofHash,
    });
  }
  if (result.status === "reconciled-indeterminate") {
    database.recordEffectReconciliation({
      kind,
      effectId: plan.effectId,
      bindingHash: plan.planHash,
      lease: lease as Readonly<DacsNodeSqliteEffectLease & { mode: "reconcile" }>,
      result: {
        disposition: "indeterminate",
        reasonCode: result.reasonCode,
        ...(result.retryAt === undefined ? {} : { retryAt: result.retryAt }),
      },
    });
    return Object.freeze({ status: "reconciliation-required", planHash: plan.planHash,
      reasonCode: result.reasonCode });
  }
  if (result.status === "operator-action") {
    database.requireEffectOperatorAction({
      kind,
      effectId: plan.effectId,
      bindingHash: plan.planHash,
      lease,
      reasonCode: result.reasonCode,
    });
    return Object.freeze({ status: "operator-action", planHash: plan.planHash,
      reasonCode: result.reasonCode });
  }
  throw new DacsGuardedCommandError("executor-result-mode-incompatible");
}

export async function runDacsGuardedCommandV1(
  rawOptions: Readonly<DacsGuardedCommandOptionsV1>,
): Promise<Readonly<DacsGuardedCommandResultV1>> {
  const source = captureClosedDataObject(rawOptions, [
    "plan", "database", "workerId", "doctorReports", "executor",
  ], [
    "execute", "confirmation", "nonInteractive", "confirm", "now",
    "doctorMaxAgeMs", "leaseDurationMs",
  ]);
  const plan = captureGuardedPlan(source.plan);
  const doctorReports = Array.isArray(source.doctorReports)
    ? Object.freeze([...source.doctorReports])
    : undefined;
  if (plan === undefined || !text(source.workerId, 128) || doctorReports === undefined ||
      typeof source.executor !== "function" ||
      (source.confirm !== undefined && typeof source.confirm !== "function") ||
      (source.now !== undefined && typeof source.now !== "function") ||
      source.database === null || typeof source.database !== "object") {
    throw new TypeError("guarded command options are invalid");
  }
  const options = Object.freeze({
    ...source,
    plan,
    doctorReports,
  }) as unknown as Readonly<DacsGuardedCommandOptionsV1>;
  if (options.execute !== true && options.plan.kind !== "purchase" &&
      options.plan.kind !== "purchase-pay-dem") {
    return Object.freeze({ status: "plan-only", plan: options.plan });
  }
  const now = options.now ?? Date.now;
  const observedAt = now();
  const doctorMaxAgeMs = options.doctorMaxAgeMs ?? DEFAULT_DOCTOR_MAX_AGE_MS;
  const leaseDurationMs = options.leaseDurationMs ?? DEFAULT_EFFECT_LEASE_MS;
  if (!Number.isSafeInteger(observedAt) || observedAt < 0 ||
      !positiveInteger(doctorMaxAgeMs, 300_000) ||
      !positiveInteger(leaseDurationMs, 300_000)) {
    throw new TypeError("guarded command time options are invalid");
  }
  if (options.plan.kind === "setup") {
    requireDoctor(options.doctorReports.find((report) =>
      report.phase === "post-start" && report.scope === "start"),
    "post-start", "start", observedAt, doctorMaxAgeMs);
    requireDoctor(options.doctorReports.find((report) =>
      report.phase === "pre-start" && report.scope === "setup"),
    "pre-start", "setup", observedAt, doctorMaxAgeMs);
  } else if (options.plan.kind === "purchase" ||
      options.plan.kind === "purchase-pay-dem") {
    requireDoctor(options.doctorReports.find((report) =>
      report.phase === "post-start" && report.scope === "buy"),
    "post-start", "buy", observedAt, doctorMaxAgeMs);
  } else {
    requireDoctor(options.doctorReports.find((report) =>
      report.phase === "post-start" && report.scope === "start"),
    "post-start", "start", observedAt, doctorMaxAgeMs);
  }
  if (options.execute !== true) {
    return Object.freeze({ status: "plan-only", plan: options.plan });
  }
  if (options.confirmation !== "1") {
    throw new DacsGuardedCommandError(
      options.plan.kind === "setup" ? "setup-confirmation-missing"
        : options.plan.kind === "purchase" || options.plan.kind === "purchase-pay-dem"
          ? "purchase-confirmation-missing"
        : "funded-doctor-confirmation-missing",
    );
  }
  let mechanism: DacsGuardedConsentV1["mechanism"];
  if (options.nonInteractive === true) {
    mechanism = "environment-and-non-interactive";
  } else {
    if (options.confirm === undefined || !await options.confirm(summaryFor(options.plan))) {
      throw new DacsGuardedCommandError("interactive-confirmation-declined");
    }
    mechanism = "environment-and-interactive";
  }
  const consent = consentFor(options.plan, observedAt, mechanism);
  const kind = planEffectKind(options.plan);
  const intent = options.database.putEffectIntent({
    kind,
    effectId: options.plan.effectId,
    bindingHash: options.plan.planHash,
    input: options.plan,
    idempotencyKey: idempotencyKey(options.plan),
    ...(options.plan.kind === "purchase" || options.plan.kind === "purchase-pay-dem"
      ? { jobId: options.plan.jobId }
      : options.plan.kind === "funded-doctor" ? { jobId: options.plan.runId } : {}),
  });
  if (intent.status === "conflict") throw new DacsGuardedCommandError("effect-plan-conflict");
  const claim = options.database.claimEffect({
    kind,
    effectId: options.plan.effectId,
    bindingHash: options.plan.planHash,
    owner: options.workerId,
    leaseDurationMs,
  });
  if (claim.status === "completed") {
    return Object.freeze({
      status: "existing-completion",
      planHash: options.plan.planHash,
      result: claim.record.result,
    });
  }
  if (claim.status === "waiting") {
    return Object.freeze({ status: "waiting", planHash: options.plan.planHash,
      reasonCode: "effect-lease-held" });
  }
  if (claim.status === "not-runnable") {
    return Object.freeze({
      status: claim.record.state === "operator-action" ? "operator-action" : "waiting",
      planHash: options.plan.planHash,
      reasonCode: claim.record.reasonCode ?? "effect-not-runnable",
    });
  }
  if (claim.status !== "acquired") throw new DacsGuardedCommandError("effect-claim-failed");
  let fenceAsserted = false;
  const fence: Readonly<DacsGuardedEffectFenceV1> = Object.freeze({
    mode: claim.mode,
    effectId: options.plan.effectId,
    planHash: options.plan.planHash,
    generation: claim.lease.generation,
    idempotencyKey: idempotencyKey(options.plan),
    async assertCurrent() {
      if (!options.database.isCurrentEffect({
        kind,
        effectId: options.plan.effectId,
        bindingHash: options.plan.planHash,
        lease: claim.lease,
      })) throw new DacsGuardedCommandError("effect-fence-stale");
      fenceAsserted = true;
    },
  });
  let result: DacsGuardedExecutorResultV1 | undefined;
  try {
    result = captureExecutorResult(await options.executor({
      plan: options.plan,
      consent,
      fence,
    }));
  } catch {
    if (options.database.isCurrentEffect({
      kind,
      effectId: options.plan.effectId,
      bindingHash: options.plan.planHash,
      lease: claim.lease,
    })) {
      options.database.recordEffectAmbiguous({
        kind,
        effectId: options.plan.effectId,
        bindingHash: options.plan.planHash,
        lease: claim.lease,
        reasonCode: "guarded-executor-threw",
      });
    }
    return Object.freeze({
      status: "reconciliation-required",
      planHash: options.plan.planHash,
      reasonCode: "guarded-executor-threw",
    });
  }
  if (!fenceAsserted) {
    if (options.database.isCurrentEffect({
      kind,
      effectId: options.plan.effectId,
      bindingHash: options.plan.planHash,
      lease: claim.lease,
    })) {
      options.database.recordEffectAmbiguous({
        kind,
        effectId: options.plan.effectId,
        bindingHash: options.plan.planHash,
        lease: claim.lease,
        reasonCode: "effect-fence-not-asserted",
      });
    }
    return Object.freeze({
      status: "reconciliation-required",
      planHash: options.plan.planHash,
      reasonCode: "effect-fence-not-asserted",
    });
  }
  if (result === undefined) {
    options.database.requireEffectOperatorAction({
      kind,
      effectId: options.plan.effectId,
      bindingHash: options.plan.planHash,
      lease: claim.lease,
      reasonCode: "executor-result-invalid",
    });
    return Object.freeze({ status: "operator-action", planHash: options.plan.planHash,
      reasonCode: "executor-result-invalid" });
  }
  return recordResult(options.database, kind, options.plan, claim.lease, result);
}

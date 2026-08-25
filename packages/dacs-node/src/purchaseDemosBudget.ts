import { baseUnits } from "@kynesyslabs/dacs";
import {
  canonicalize,
  canonicalizeDecimal,
  sha256Hex,
} from "@kynesyslabs/dacs/canonical";
import { isCanonicalJobId } from "@kynesyslabs/dacs/negotiate";
import type { AnchorWriteOnceOptions } from "@kynesyslabs/dacs/substrate";

import { DACS_FIXED_PRICE_PURCHASE_DEMOS_WRITE_BUDGET_V1 } from "./fundingDoctor.js";
import type { DacsLiveRoleOperationContextV1 } from "./roleRuntime.js";
import type { DacsNodeSqliteDatabase } from "./sqlite.js";

const GRANT_VERSION = "1" as const;
const GRANT_ID_DOMAIN = "dacs-fixed-price-purchase-demos-budget-grant:v1:" as const;
const HASH_RE = /^[0-9a-f]{64}$/;

export interface DacsFixedPricePurchaseDemosBudgetGrantV1 {
  budgetGrantVersion: typeof GRANT_VERSION;
  jobId: string;
  role: "buyer" | "seller";
  authority: string;
  maximumPerWriteFeeOs: string;
  maximumTotalFeeOs: string;
  budgetId: string;
  grantHash: string;
}

function writesFor(role: "buyer" | "seller"): number {
  return DACS_FIXED_PRICE_PURCHASE_DEMOS_WRITE_BUDGET_V1[role] +
    DACS_FIXED_PRICE_PURCHASE_DEMOS_WRITE_BUDGET_V1.safetyMarginPerRole;
}

function effectId(jobId: string, role: "buyer" | "seller"): string {
  return sha256Hex(`${GRANT_ID_DOMAIN}${jobId}:${role}`);
}

function feeOs(value: string): bigint {
  try {
    if (canonicalizeDecimal(value) !== value || (value.split(".")[1]?.length ?? 0) > 9) {
      throw new Error();
    }
    const parsed = BigInt(baseUnits(value, 9));
    if (parsed < 0n) throw new Error();
    return parsed;
  } catch {
    throw new TypeError("fixed-price Demos fee budget is invalid");
  }
}

function captureGrant(value: unknown): Readonly<DacsFixedPricePurchaseDemosBudgetGrantV1> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("fixed-price Demos fee budget grant is corrupt");
  }
  const source = value as Readonly<Record<string, unknown>>;
  const keys = [
    "budgetGrantVersion", "jobId", "role", "authority", "maximumPerWriteFeeOs",
    "maximumTotalFeeOs", "budgetId", "grantHash",
  ];
  if (Reflect.ownKeys(source).length !== keys.length ||
      !keys.every((key) => Object.hasOwn(source, key)) ||
      source.budgetGrantVersion !== GRANT_VERSION ||
      typeof source.jobId !== "string" || !isCanonicalJobId(source.jobId) ||
      (source.role !== "buyer" && source.role !== "seller") ||
      typeof source.authority !== "string" || source.authority.length === 0 ||
      typeof source.maximumPerWriteFeeOs !== "string" ||
      !/^(?:0|[1-9][0-9]*)$/.test(source.maximumPerWriteFeeOs) ||
      typeof source.maximumTotalFeeOs !== "string" ||
      !/^(?:0|[1-9][0-9]*)$/.test(source.maximumTotalFeeOs) ||
      typeof source.budgetId !== "string" || source.budgetId !==
        `dacs-fixed-price-purchase:v1:${source.jobId}:${source.role}` ||
      typeof source.grantHash !== "string" || !HASH_RE.test(source.grantHash)) {
    throw new TypeError("fixed-price Demos fee budget grant is corrupt");
  }
  const role = source.role as "buyer" | "seller";
  const body = {
    budgetGrantVersion: GRANT_VERSION,
    jobId: source.jobId,
    role,
    authority: source.authority,
    maximumPerWriteFeeOs: source.maximumPerWriteFeeOs,
    maximumTotalFeeOs: source.maximumTotalFeeOs,
    budgetId: source.budgetId,
  };
  if (BigInt(body.maximumTotalFeeOs) !==
        BigInt(body.maximumPerWriteFeeOs) * BigInt(writesFor(body.role)) ||
      sha256Hex(`${GRANT_ID_DOMAIN}${canonicalize(body)}`) !== source.grantHash) {
    throw new TypeError("fixed-price Demos fee budget grant is corrupt");
  }
  return Object.freeze({ ...body, grantHash: source.grantHash });
}

/**
 * Retain the immutable order-local fee grant before that role's coordinator
 * starts. An increased process configuration after restart cannot enlarge it.
 */
export function retainDacsFixedPricePurchaseDemosBudgetGrantV1(input: Readonly<{
  database: DacsNodeSqliteDatabase;
  jobId: string;
  role: "buyer" | "seller";
  authority: string;
  maximumPerWriteFeeDem: string;
  maximumAllowedPerWriteFeeDem?: string;
}>): Readonly<DacsFixedPricePurchaseDemosBudgetGrantV1> {
  if (input === null || typeof input !== "object" ||
      !isCanonicalJobId(input.jobId) ||
      (input.role !== "buyer" && input.role !== "seller") ||
      typeof input.authority !== "string" || input.authority.length === 0 ||
      input.database?.metadata.mode !== "live-demos" ||
      input.database.metadata.role !== input.role ||
      input.database.metadata.authority !== input.authority) {
    throw new TypeError("fixed-price Demos fee budget input is invalid");
  }
  const maximumPerWriteFeeOs = feeOs(input.maximumPerWriteFeeDem);
  if (input.maximumAllowedPerWriteFeeDem !== undefined && maximumPerWriteFeeOs >
      feeOs(input.maximumAllowedPerWriteFeeDem)) {
    throw new TypeError("fixed-price Demos fee budget exceeds local policy");
  }
  const body = {
    budgetGrantVersion: GRANT_VERSION,
    jobId: input.jobId,
    role: input.role,
    authority: input.authority,
    maximumPerWriteFeeOs: maximumPerWriteFeeOs.toString(),
    maximumTotalFeeOs: (maximumPerWriteFeeOs * BigInt(writesFor(input.role))).toString(),
    budgetId: `dacs-fixed-price-purchase:v1:${input.jobId}:${input.role}`,
  };
  const record = Object.freeze({
    ...body,
    grantHash: sha256Hex(`${GRANT_ID_DOMAIN}${canonicalize(body)}`),
  });
  const id = effectId(input.jobId, input.role);
  const existing = input.database.loadEffectInput("session", id);
  if (existing !== undefined) {
    const captured = captureGrant(existing);
    if (canonicalize(captured) !== canonicalize(record)) {
      throw new TypeError("fixed-price Demos fee budget grant conflicts");
    }
    return captured;
  }
  const stored = input.database.putEffectIntent({
    kind: "session",
    effectId: id,
    bindingHash: record.grantHash,
    input: record,
    idempotencyKey: id,
    jobId: input.jobId,
  });
  if (stored.status === "conflict") {
    throw new TypeError("fixed-price Demos fee budget grant conflicts");
  }
  return captureGrant(input.database.loadEffectInput("session", id));
}

function loadGrant(
  database: DacsNodeSqliteDatabase,
  jobId: string,
  role: "buyer" | "seller",
): Readonly<DacsFixedPricePurchaseDemosBudgetGrantV1> {
  const value = database.loadEffectInput("session", effectId(jobId, role));
  if (value === undefined) {
    throw new TypeError("fixed-price Demos fee budget grant is missing");
  }
  return captureGrant(value);
}

/**
 * Bind one fixed-price artifact publication to its role-local durable fee
 * budget. The Demos wallet journal reserves the authenticated confirmed fee
 * before broadcast, including attempts that later become definitively failed.
 */
export function dacsFixedPricePurchaseAnchorOptionsV1(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  jobId: string,
  metadata: Readonly<Record<string, unknown>>,
): Readonly<AnchorWriteOnceOptions> {
  if ((context.role !== "buyer" && context.role !== "seller") ||
      context.config.role !== context.role || !isCanonicalJobId(jobId) ||
      metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new TypeError("fixed-price Demos fee budget input is invalid");
  }
  const grant = loadGrant(context.database, jobId, context.role);
  if (grant.authority !== context.authority ||
      grant.role !== context.role || grant.jobId !== jobId) {
    throw new TypeError("fixed-price Demos fee budget grant is unbound");
  }
  return Object.freeze({
    metadata: { ...metadata },
    feeBudget: Object.freeze({
      budgetId: grant.budgetId,
      maximumTotalFeeOs: BigInt(grant.maximumTotalFeeOs),
    }),
  });
}

import {
  createX402BuyerEvmAuthorizationProvider,
  createX402BuyerPaidRequestTransport,
  prepareX402BuyerSettlement,
  type FixedPriceX402TrackOperation,
  type FixedPriceX402TrackOperationInput,
  type X402BuyerEvmDisclosureRecovery,
  type X402BuyerEvmIntentAuthority,
  type X402BuyerEvmUnusedConfirmer,
  type X402BuyerPaymentRequirements,
  type X402BuyerPreparationAuthority,
  type X402BuyerSettlementIntent,
} from "@kynesyslabs/dacs";

import {
  DacsLiveEffectInputControlError,
} from "./liveEffects.js";
import {
  loadDacsLiveOrderInputForTrackV1,
  type DacsLiveOrderInputV1,
} from "./orderInput.js";
import type { DacsLiveRoleOperationContextV1 } from "./roleRuntime.js";
import { createDacsX402BuyerPaymentTrackV1 } from "./x402Payment.js";

const HASH_RE = /^[0-9a-f]{64}$/;

export interface DacsX402BuyerRuntimePreparationV1 {
  authority: Readonly<X402BuyerPreparationAuthority>;
  expectedRequirements: Readonly<X402BuyerPaymentRequirements>;
  challengeHeaders?: Headers | Record<string, string> | Array<[string, string]>;
}

export interface DacsX402BuyerRuntimePaymentTrackOptionsV1 {
  context: Readonly<DacsLiveRoleOperationContextV1>;
  workerId: string;
  minimumConfirmations: number;
  authorizationSearchFromBlock: number;
  resolvePreparation(input: Readonly<{
    operation: Readonly<FixedPriceX402TrackOperationInput>;
    retained: Readonly<DacsLiveOrderInputV1>;
  }>): Promise<Readonly<DacsX402BuyerRuntimePreparationV1>> |
    Readonly<DacsX402BuyerRuntimePreparationV1>;
  authorizeIntent: X402BuyerEvmIntentAuthority;
  authorizePreparedIntent(input: Readonly<{
    operation: Readonly<FixedPriceX402TrackOperationInput>;
    retained: Readonly<DacsLiveOrderInputV1>;
    intent: Readonly<X402BuyerSettlementIntent>;
  }>): Promise<boolean> | boolean;
  confirmUnused?: X402BuyerEvmUnusedConfirmer;
  recoverDisclosure?: X402BuyerEvmDisclosureRecovery;
  fetchImpl?: typeof fetch;
  effectLeaseDurationMs?: number;
  settlementLeaseDurationMs?: number;
  retryDelayMs?: number;
}

export class DacsX402BuyerRuntimePaymentError extends Error {
  override readonly name = "DacsX402BuyerRuntimePaymentError";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
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

function safeReason(value: unknown): string {
  const normalized = String(value ?? "unavailable").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64)
    .replace(/-+$/g, "");
  return normalized || "unavailable";
}

function preparationBindingsMatch(
  input: Readonly<FixedPriceX402TrackOperationInput>,
  context: Readonly<DacsLiveRoleOperationContextV1>,
  value: Readonly<DacsX402BuyerRuntimePreparationV1>,
): boolean {
  const authority = value.authority;
  const requirements = value.expectedRequirements;
  return plainObject(value) && plainObject(authority) && plainObject(requirements) &&
    authority.jobId === input.order.jobId &&
    authority.railId === input.order.protocol.rail.railId &&
    authority.railVersion === String(input.order.protocol.rail.railVersion) &&
    authority.railDescriptorHash === input.order.protocol.rail.railDefinitionHash &&
    authority.network === input.order.protocol.rail.network &&
    authority.payer.toLowerCase() === context.evm.address.toLowerCase() &&
    requirements.network === authority.network &&
    requirements.payTo.toLowerCase() === authority.payee.toLowerCase() &&
    requirements.asset.toLowerCase() === authority.asset.toLowerCase() &&
    requirements.amount === authority.amount &&
    HASH_RE.test(authority.agreementHash) && HASH_RE.test(authority.termsHash) &&
    HASH_RE.test(authority.sessionBindingHash);
}

/**
 * Compose the role-owned EVM signer/read client, immutable order input,
 * chain-authenticated authorization provider and retained paid HTTP request
 * into the coordinator's buyer payment track.
 */
export function createDacsX402BuyerRuntimePaymentTrackV1(
  options: Readonly<DacsX402BuyerRuntimePaymentTrackOptionsV1>,
): FixedPriceX402TrackOperation {
  if (!plainObject(options) || !plainObject(options.context) ||
      options.context.role !== "buyer" || options.context.evm.role !== "buyer" ||
      options.context.commerceStores.role !== "buyer" ||
      typeof options.workerId !== "string" || options.workerId.length === 0 ||
      !Number.isSafeInteger(options.minimumConfirmations) ||
      options.minimumConfirmations <= 0 ||
      !Number.isSafeInteger(options.authorizationSearchFromBlock) ||
      options.authorizationSearchFromBlock < 0 ||
      typeof options.resolvePreparation !== "function" ||
      typeof options.authorizeIntent !== "function" ||
      typeof options.authorizePreparedIntent !== "function") {
    throw new TypeError("x402 buyer runtime payment track options are invalid");
  }
  const context = options.context;
  const evm = context.evm;
  const commerceStores = context.commerceStores;
  if (evm.role !== "buyer" || commerceStores.role !== "buyer") {
    throw new TypeError("x402 buyer runtime payment track options are invalid");
  }
  const authorizationProvider = createX402BuyerEvmAuthorizationProvider({
    chainId: evm.runtime.chainId,
    minimumConfirmations: options.minimumConfirmations,
    authorizationSearchFromBlock: options.authorizationSearchFromBlock,
    client: evm.runtime.readClient,
    authorizeIntent: options.authorizeIntent,
    ...(options.confirmUnused === undefined ? {} : { confirmUnused: options.confirmUnused }),
    ...(options.recoverDisclosure === undefined
      ? {} : { recoverDisclosure: options.recoverDisclosure }),
  });
  const transport = createX402BuyerPaidRequestTransport(
    options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl },
  );

  return createDacsX402BuyerPaymentTrackV1({
    database: context.database,
    workerId: options.workerId,
    settlementStore: commerceStores.x402Settlement,
    authorizationProvider,
    transport,
    async prepareIntent(operation) {
      const retained = loadDacsLiveOrderInputForTrackV1(operation, context.database);
      let preparation: Readonly<DacsX402BuyerRuntimePreparationV1>;
      try {
        preparation = await options.resolvePreparation({ operation, retained });
      } catch (error) {
        if (error instanceof DacsLiveEffectInputControlError) throw error;
        throw new DacsLiveEffectInputControlError(
          "pending-retry",
          "x402-preparation-authority-unavailable",
        );
      }
      if (!preparationBindingsMatch(operation, context, preparation)) {
        throw new DacsLiveEffectInputControlError(
          "operator-action",
          "x402-preparation-authority-mismatch",
        );
      }
      let client;
      try {
        client = await evm.runtime.createChallengeClient({
          authority: preparation.authority,
          expectedRequirements: preparation.expectedRequirements,
        });
      } catch {
        throw new DacsLiveEffectInputControlError(
          "operator-action",
          "x402-challenge-signer-unavailable",
        );
      }
      const result = await prepareX402BuyerSettlement({
        authority: preparation.authority,
        ...(preparation.challengeHeaders === undefined
          ? {} : { challengeHeaders: preparation.challengeHeaders }),
      }, {
        client,
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      });
      if (result.disposition === "prepared") return result.intent;
      throw new DacsLiveEffectInputControlError(
        result.disposition === "indeterminate" ? "pending-retry" : "operator-action",
        `x402-prepare-${safeReason(result.reason)}`,
      );
    },
    async authorizePreparedIntent({ order, intent }) {
      const operation = {
        order,
        fence: {
          role: order.role,
          jobId: order.jobId,
          bindingHash: order.bindingHash,
          localBindingHash: order.localBindingHash,
          track: "payment" as const,
          owner: options.workerId,
          generation: 0,
          idempotencyKey: "authorization-read-only",
          assertCurrent: async () => undefined,
        },
      } satisfies FixedPriceX402TrackOperationInput;
      const retained = loadDacsLiveOrderInputForTrackV1(operation, context.database);
      return options.authorizePreparedIntent({ operation, retained, intent });
    },
    ...(options.effectLeaseDurationMs === undefined
      ? {} : { effectLeaseDurationMs: options.effectLeaseDurationMs }),
    ...(options.settlementLeaseDurationMs === undefined
      ? {} : { settlementLeaseDurationMs: options.settlementLeaseDurationMs }),
    ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
  });
}

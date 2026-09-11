import type {
  FixedPricePayDemOperations,
  FixedPricePayDemTrackOperation,
  FixedPriceX402CoordinatorRole,
  FixedPriceX402Operations,
  FixedPriceX402Track,
  FixedPriceX402TrackOperation,
} from "@kynesyslabs/dacs/commerce";

const ROLE_TRACKS = Object.freeze({
  buyer: Object.freeze([
    "agreement",
    "payment",
    "payment-evidence",
    "buyer-received",
    "audit",
  ] as const),
  seller: Object.freeze([
    "agreement",
    "payment",
    "payment-evidence",
    "delivery",
    "delivery-evidence",
    "audit",
  ] as const),
});

export type DacsFixedPriceX402BuyerOperationsV1 = Readonly<
  Record<(typeof ROLE_TRACKS.buyer)[number], FixedPriceX402TrackOperation>
>;

export type DacsFixedPriceX402SellerOperationsV1 = Readonly<
  Record<(typeof ROLE_TRACKS.seller)[number], FixedPriceX402TrackOperation>
>;

export type DacsFixedPriceX402CompleteOperationsV1 =
  | DacsFixedPriceX402BuyerOperationsV1
  | DacsFixedPriceX402SellerOperationsV1;

export type DacsFixedPricePayDemBuyerOperationsV1 = Readonly<
  Record<(typeof ROLE_TRACKS.buyer)[number], FixedPricePayDemTrackOperation>
>;

export type DacsFixedPricePayDemSellerOperationsV1 = Readonly<
  Record<(typeof ROLE_TRACKS.seller)[number], FixedPricePayDemTrackOperation>
>;

export type DacsFixedPricePayDemCompleteOperationsV1 =
  | DacsFixedPricePayDemBuyerOperationsV1
  | DacsFixedPricePayDemSellerOperationsV1;

export interface DacsFixedPriceX402OperationSetOptionsV1 {
  role: FixedPriceX402CoordinatorRole;
  operations: Readonly<Record<string, unknown>>;
}

export class DacsFixedPriceX402OperationSetError extends Error {
  override readonly name = "DacsFixedPriceX402OperationSetError";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

function closedDataObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Reflect.ownKeys(value).every((key) => {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
    });
  } catch {
    return false;
  }
}

/**
 * Admit a complete role-owned production operation graph. Core coordinators
 * intentionally allow partial maps for recovery and focused composition; a
 * live service must not turn that flexibility into a silently half-configured
 * agent. Each operation remains responsible for its SDK validation and
 * irreversible-effect reconciliation contract.
 */
export function createDacsFixedPriceX402OperationSetV1(
  rawOptions: Readonly<DacsFixedPriceX402OperationSetOptionsV1>,
): Readonly<FixedPriceX402Operations> {
  if (!closedDataObject(rawOptions) ||
      Reflect.ownKeys(rawOptions).length !== 2 ||
      !Object.hasOwn(rawOptions, "role") || !Object.hasOwn(rawOptions, "operations") ||
      (rawOptions.role !== "buyer" && rawOptions.role !== "seller") ||
      !closedDataObject(rawOptions.operations)) {
    throw new TypeError("fixed-price x402 operation set options are invalid");
  }
  const required = ROLE_TRACKS[rawOptions.role] as readonly FixedPriceX402Track[];
  const keys = Reflect.ownKeys(rawOptions.operations);
  if (keys.length !== required.length ||
      keys.some((key) => typeof key !== "string" || !required.includes(
        key as FixedPriceX402Track,
      ))) {
    throw new DacsFixedPriceX402OperationSetError(
      "commerce-operation-set-role-incompatible",
    );
  }
  const captured: Partial<Record<FixedPriceX402Track, FixedPriceX402TrackOperation>> = {};
  for (const track of required) {
    const operation = rawOptions.operations[track];
    if (typeof operation !== "function") {
      throw new DacsFixedPriceX402OperationSetError(
        "commerce-operation-set-incomplete",
      );
    }
    captured[track] = operation as FixedPriceX402TrackOperation;
  }
  return Object.freeze(captured);
}

/** Native DEM uses the same role track closure with a distinct protocol type. */
export function createDacsFixedPricePayDemOperationSetV1(
  rawOptions: Readonly<DacsFixedPriceX402OperationSetOptionsV1>,
): Readonly<FixedPricePayDemOperations> {
  return createDacsFixedPriceX402OperationSetV1(rawOptions) as unknown as
    Readonly<FixedPricePayDemOperations>;
}

export function dacsFixedPriceX402RequiredTracksV1(
  role: FixedPriceX402CoordinatorRole,
): readonly FixedPriceX402Track[] {
  if (role !== "buyer" && role !== "seller") {
    throw new TypeError("fixed-price x402 operation role is invalid");
  }
  return ROLE_TRACKS[role];
}

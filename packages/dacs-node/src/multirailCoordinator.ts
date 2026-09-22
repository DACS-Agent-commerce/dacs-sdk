import type {
  FixedPricePayDemCommerceCoordinator,
  FixedPricePayDemOrderInput,
  FixedPricePayDemOrderStatus,
  FixedPricePayDemWorkReport,
  FixedPriceX402CommerceCoordinator,
  FixedPriceX402CoordinatorRole,
  FixedPriceX402OrderInput,
  FixedPriceX402OrderStatus,
  FixedPriceX402Page,
  FixedPriceX402Track,
  FixedPriceX402WorkReport,
} from "@kynesyslabs/dacs/commerce";

export type DacsLiveCommerceOrderInputV1 =
  | FixedPriceX402OrderInput
  | FixedPricePayDemOrderInput;
export type DacsLiveCommerceOrderStatusV1 =
  | FixedPriceX402OrderStatus
  | FixedPricePayDemOrderStatus;
export type DacsLiveCommerceWorkReportV1 =
  | FixedPriceX402WorkReport
  | FixedPricePayDemWorkReport;
export type DacsLiveCommerceRailProfileV1 = "x402" | "pay-dem";

export interface DacsLiveMultirailCoordinatorV1 {
  readonly role: FixedPriceX402CoordinatorRole;
  readonly profiles: readonly DacsLiveCommerceRailProfileV1[];
  startOrder(
    order: Readonly<DacsLiveCommerceOrderInputV1>,
  ): Promise<DacsLiveCommerceOrderStatusV1>;
  getOrderStatus(jobId: string): Promise<DacsLiveCommerceOrderStatusV1 | null>;
  runPending(options?: Readonly<{
    cursor?: string;
    limit?: number;
    signal?: AbortSignal;
  }>): Promise<FixedPriceX402Page<DacsLiveCommerceWorkReportV1>>;
  resumePendingOrders(options?: Readonly<{
    cursor?: string;
    limit?: number;
    signal?: AbortSignal;
  }>): Promise<FixedPriceX402Page<DacsLiveCommerceWorkReportV1>>;
  repairTrack(input: Readonly<{
    jobId: string;
    track: FixedPriceX402Track;
    operatorReasonCode: string;
    retryAt?: number;
  }>): Promise<DacsLiveCommerceOrderStatusV1>;
}

export type DacsLiveMultirailCoordinatorOptionsV1 = Readonly<{
  role: FixedPriceX402CoordinatorRole;
  x402?: Readonly<FixedPriceX402CommerceCoordinator>;
  payDem?: Readonly<FixedPricePayDemCommerceCoordinator>;
}>;

export class DacsLiveMultirailCoordinatorError extends Error {
  override readonly name = "DacsLiveMultirailCoordinatorError";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

interface CursorV1 {
  version: 1;
  x402: string | null;
  payDem: string | null;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1_000;

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

function coordinator(value: unknown, role: FixedPriceX402CoordinatorRole): boolean {
  return plainObject(value) && value.role === role &&
    typeof value.startOrder === "function" &&
    typeof value.getOrderStatus === "function" &&
    typeof value.runPending === "function" &&
    typeof value.resumePendingOrders === "function" &&
    typeof value.repairTrack === "function";
}

function profile(order: Readonly<DacsLiveCommerceOrderInputV1>):
  DacsLiveCommerceRailProfileV1 | undefined {
  if (!plainObject(order) || !plainObject(order.protocol)) return undefined;
  return order.protocol.phase === "pay-x402"
    ? "x402"
    : order.protocol.phase === "pay-dem"
      ? "pay-dem"
      : undefined;
}

function encodeCursor(value: Readonly<CursorV1>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined, profiles: readonly string[]): CursorV1 {
  if (value === undefined) {
    return {
      version: 1,
      x402: profiles.includes("x402") ? "" : null,
      payDem: profiles.includes("pay-dem") ? "" : null,
    };
  }
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) throw new Error();
    const parsed: unknown = JSON.parse(decoded.toString("utf8"));
    if (!plainObject(parsed) || Reflect.ownKeys(parsed).length !== 3 ||
        parsed.version !== 1 ||
        (parsed.x402 !== null && typeof parsed.x402 !== "string") ||
        (parsed.payDem !== null && typeof parsed.payDem !== "string") ||
        (!profiles.includes("x402") && parsed.x402 !== null) ||
        (!profiles.includes("pay-dem") && parsed.payDem !== null)) throw new Error();
    return parsed as unknown as CursorV1;
  } catch {
    throw new DacsLiveMultirailCoordinatorError("multirail-cursor-invalid");
  }
}

function limit(value: number | undefined): number {
  const selected = value ?? DEFAULT_LIMIT;
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > MAX_LIMIT) {
    throw new DacsLiveMultirailCoordinatorError("multirail-limit-invalid");
  }
  return selected;
}

/**
 * One actor-local facade over independent x402 and native DEM coordinators.
 * A job is admitted to exactly one profile before Agreement; the facade never
 * falls back to another rail after payment authority or ambiguity exists.
 */
export function createDacsLiveMultirailCoordinatorV1(
  options: DacsLiveMultirailCoordinatorOptionsV1,
): Readonly<DacsLiveMultirailCoordinatorV1> {
  if (!plainObject(options) || Reflect.ownKeys(options).some((key) =>
    key !== "role" && key !== "x402" && key !== "payDem") ||
      (options.role !== "buyer" && options.role !== "seller") ||
      (options.x402 !== undefined && !coordinator(options.x402, options.role)) ||
      (options.payDem !== undefined && !coordinator(options.payDem, options.role)) ||
      (options.x402 === undefined && options.payDem === undefined)) {
    throw new TypeError("live multirail coordinator options are invalid");
  }
  const role = options.role;
  const x402 = options.x402;
  const payDem = options.payDem;
  const profiles = Object.freeze([
    ...(x402 === undefined ? [] : ["x402" as const]),
    ...(payDem === undefined ? [] : ["pay-dem" as const]),
  ]);
  let preferPayDem = false;

  const resolveExisting = async (jobId: string) => {
    const [x402Status, payDemStatus] = await Promise.all([
      x402?.getOrderStatus(jobId) ?? null,
      payDem?.getOrderStatus(jobId) ?? null,
    ]);
    if (x402Status !== null && payDemStatus !== null) {
      throw new DacsLiveMultirailCoordinatorError("multirail-job-identity-conflict");
    }
    return x402Status === null
      ? payDemStatus === null
        ? null
        : { profile: "pay-dem" as const, status: payDemStatus }
      : { profile: "x402" as const, status: x402Status };
  };

  const run = async (
    method: "runPending" | "resumePendingOrders",
    raw: Readonly<{ cursor?: string; limit?: number; signal?: AbortSignal }> = {},
  ): Promise<FixedPriceX402Page<DacsLiveCommerceWorkReportV1>> => {
    const maximum = limit(raw.limit);
    const cursor = decodeCursor(raw.cursor, profiles);
    const allRunnable = [
      ...(cursor.x402 === null || x402 === undefined ? [] : ["x402" as const]),
      ...(cursor.payDem === null || payDem === undefined ? [] : ["pay-dem" as const]),
    ];
    const runnable = allRunnable.length > maximum
      ? [raw.cursor === undefined && preferPayDem
          ? allRunnable[allRunnable.length - 1]!
          : allRunnable[0]!]
      : allRunnable;
    if (raw.cursor === undefined && allRunnable.length > maximum) {
      preferPayDem = !preferPayDem;
    }
    if (runnable.length === 0) return Object.freeze({ items: Object.freeze([]) });
    const firstLimit = runnable.length === 1 ? maximum : Math.ceil(maximum / 2);
    const secondLimit = maximum - firstLimit;
    const pages = await Promise.all(runnable.map((selected, index) => {
      const coordinator = selected === "x402" ? x402! : payDem!;
      const selectedCursor = selected === "x402" ? cursor.x402! : cursor.payDem!;
      return coordinator[method]({
        ...(selectedCursor === "" ? {} : { cursor: selectedCursor }),
        limit: index === 0 ? firstLimit : secondLimit,
        ...(raw.signal === undefined ? {} : { signal: raw.signal }),
      });
    }));
    const next: CursorV1 = { ...cursor };
    const items: DacsLiveCommerceWorkReportV1[] = [];
    for (let index = 0; index < runnable.length; index += 1) {
      const selected = runnable[index]!;
      const page = pages[index]!;
      items.push(...page.items);
      if (selected === "x402") next.x402 = page.nextCursor ?? null;
      else next.payDem = page.nextCursor ?? null;
    }
    return Object.freeze({
      items: Object.freeze(items),
      ...(next.x402 === null && next.payDem === null
        ? {}
        : { nextCursor: encodeCursor(next) }),
    });
  };

  const facade: DacsLiveMultirailCoordinatorV1 = {
    role,
    profiles,
    async startOrder(order) {
      const selected = profile(order);
      if (selected === undefined) {
        throw new DacsLiveMultirailCoordinatorError("multirail-order-profile-invalid");
      }
      const existing = await resolveExisting(order.jobId);
      if (existing !== null && existing.profile !== selected) {
        throw new DacsLiveMultirailCoordinatorError("multirail-job-profile-conflict");
      }
      if (selected === "x402") {
        if (x402 === undefined) {
          throw new DacsLiveMultirailCoordinatorError("multirail-profile-disabled");
        }
        return x402.startOrder(order as FixedPriceX402OrderInput);
      }
      if (payDem === undefined) {
        throw new DacsLiveMultirailCoordinatorError("multirail-profile-disabled");
      }
      return payDem.startOrder(order as FixedPricePayDemOrderInput);
    },
    async getOrderStatus(jobId) {
      return (await resolveExisting(jobId))?.status ?? null;
    },
    runPending: (raw) => run("runPending", raw),
    resumePendingOrders: (raw) => run("resumePendingOrders", raw),
    async repairTrack(input) {
      const existing = await resolveExisting(input.jobId);
      if (existing === null) {
        throw new DacsLiveMultirailCoordinatorError("multirail-job-missing");
      }
      return existing.profile === "x402"
        ? x402!.repairTrack(input)
        : payDem!.repairTrack(input);
    },
  };
  return Object.freeze(facade);
}

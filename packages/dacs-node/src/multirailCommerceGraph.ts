import type { FixedPricePayDemOperations,
  FixedPriceX402Operations } from "@kynesyslabs/dacs/commerce";

import type {
  DacsBuyerLiveCommerceGraphV1,
  DacsLiveCommerceAvailabilityV1,
  DacsSellerLiveCommerceGraphV1,
} from "./liveCommerceGraph.js";
import type {
  DacsBuyerPayDemLiveCommerceGraphV1,
  DacsSellerPayDemLiveCommerceGraphV1,
} from "./livePayDemCommerceGraph.js";
import type { DacsLiveRoleInboundOperationContextV1 } from "./roleRuntime.js";
import type { DacsLiveRoleApplicationRequestHandlerV1 } from "./service.js";
import type {
  DacsHttpAuthenticatedEnvelopeV1,
  DacsHttpPayloadValidationV1,
  DacsHttpPayloadValidatorV1,
} from "./transport/envelope.js";
import type { DacsHttpInboundDispositionV1 } from "./transport/http.js";

type BuyerGraph = Readonly<DacsBuyerLiveCommerceGraphV1>;
type SellerGraph = Readonly<DacsSellerLiveCommerceGraphV1>;
type BuyerPayDemGraph = Readonly<DacsBuyerPayDemLiveCommerceGraphV1>;
type SellerPayDemGraph = Readonly<DacsSellerPayDemLiveCommerceGraphV1>;
type PayloadValidationInput = Parameters<DacsHttpPayloadValidatorV1>[0];
type InvalidPayloadValidation = Exclude<
  DacsHttpPayloadValidationV1,
  Readonly<{ status: "valid" }>
>;

export type DacsMultirailLiveCommerceGraphOptionsV1 = Readonly<
  | { role: "buyer"; x402: BuyerGraph; payDem: BuyerPayDemGraph }
  | { role: "seller"; x402: SellerGraph; payDem: SellerPayDemGraph }
>;

export interface DacsMultirailLiveCommerceGraphV1 {
  readonly role: "buyer" | "seller";
  readonly availability: Readonly<DacsLiveCommerceAvailabilityV1>;
  readonly operations: Readonly<FixedPriceX402Operations>;
  readonly payDemOperations: Readonly<FixedPricePayDemOperations>;
  readonly validatePayload: DacsHttpPayloadValidatorV1;
  readonly handleApplicationRequest?: DacsLiveRoleApplicationRequestHandlerV1;
  handleMessage(
    authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
    context: Readonly<DacsLiveRoleInboundOperationContextV1>,
  ): Promise<DacsHttpInboundDispositionV1>;
}

export class DacsMultirailCommerceGraphError extends Error {
  override readonly name = "DacsMultirailCommerceGraphError";

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

function graph(value: unknown, role: "buyer" | "seller", profile: "x402" | "pay-dem") {
  return plainObject(value) && value.role === role &&
    plainObject(value.availability) && typeof value.validatePayload === "function" &&
    typeof value.handleMessage === "function" &&
    (profile === "x402" ? plainObject(value.operations) : plainObject(value.payDemOperations));
}

function availability(
  x402: BuyerGraph | SellerGraph,
  payDem: BuyerPayDemGraph | SellerPayDemGraph,
): Readonly<DacsLiveCommerceAvailabilityV1> {
  if (x402.availability.status === "configured" &&
      payDem.availability.status === "configured") {
    return Object.freeze({ status: "configured" as const });
  }
  return Object.freeze({
    status: "blocked" as const,
    reasonCode: "multirail-commerce-capability-blocked",
  });
}

async function select(
  input: Readonly<PayloadValidationInput>,
  x402: BuyerGraph | SellerGraph,
  payDem: BuyerPayDemGraph | SellerPayDemGraph,
): Promise<Readonly<
  | { status: "selected"; profile: "x402" | "pay-dem" }
  | { status: "invalid"; validation: InvalidPayloadValidation }
>> {
  const [x402Result, payDemResult] = await Promise.all([
    x402.validatePayload(input),
    payDem.validatePayload(input),
  ]);
  const x402Valid = x402Result.status === "valid";
  const payDemValid = payDemResult.status === "valid";
  if (x402Valid !== payDemValid) {
    return Object.freeze({
      status: "selected" as const,
      profile: x402Valid ? "x402" as const : "pay-dem" as const,
    });
  }
  if (x402Valid) {
    return Object.freeze({
      status: "invalid" as const,
      validation: Object.freeze({
        status: "authentication-failure" as const,
        reasonCode: "multirail-message-profile-ambiguous",
      }),
    });
  }
  const unavailable = x402Result.status === "authentication-failure" ||
    payDemResult.status === "authentication-failure";
  return Object.freeze({
    status: "invalid" as const,
    validation: Object.freeze({
      status: unavailable ? "authentication-failure" as const : "invalid" as const,
      reasonCode: unavailable
        ? "multirail-message-validation-unavailable"
        : "multirail-message-profile-incompatible",
    }),
  });
}

function validationInput(
  authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
): Readonly<PayloadValidationInput> {
  const envelope = authenticated.envelope;
  if (envelope.type === "acknowledgement") {
    throw new DacsMultirailCommerceGraphError(
      "multirail-message-type-incompatible",
    );
  }
  return Object.freeze({
    type: envelope.type,
    payload: envelope.payload,
    jobId: envelope.jobId,
    sender: envelope.sender,
    audience: envelope.audience,
  }) as Readonly<PayloadValidationInput>;
}

/**
 * Join two independently closed rail graphs without introducing fallback.
 * Every authenticated message must select exactly one graph from its payload
 * and retained binding; zero or two matches fail closed before a handler runs.
 */
export function createDacsMultirailLiveCommerceGraphV1(
  options: DacsMultirailLiveCommerceGraphOptionsV1,
): Readonly<DacsMultirailLiveCommerceGraphV1> {
  if (!plainObject(options) || Reflect.ownKeys(options).length !== 3 ||
      (options.role !== "buyer" && options.role !== "seller") ||
      !graph(options.x402, options.role, "x402") ||
      !graph(options.payDem, options.role, "pay-dem") ||
      (options.role === "seller" &&
        typeof options.x402.handleApplicationRequest !== "function")) {
    throw new TypeError("multirail live commerce graph options are invalid");
  }
  const role = options.role;
  const x402 = options.x402;
  const payDem = options.payDem;
  const validatePayload: DacsHttpPayloadValidatorV1 = async (input) => {
    try {
      const selected = await select(input, x402, payDem);
      return selected.status === "selected"
        ? Object.freeze({ status: "valid" as const })
        : selected.validation;
    } catch {
      return Object.freeze({
        status: "authentication-failure" as const,
        reasonCode: "multirail-message-validation-unavailable",
      });
    }
  };
  const handleMessage = async (
    authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
    context: Readonly<DacsLiveRoleInboundOperationContextV1>,
  ): Promise<DacsHttpInboundDispositionV1> => {
    if (context.role !== role) {
      return Object.freeze({
        disposition: "rejected" as const,
        reasonCode: "multirail-message-context-role-mismatch",
      });
    }
    let selected: Awaited<ReturnType<typeof select>>;
    try {
      selected = await select(validationInput(authenticated), x402, payDem);
    } catch {
      throw new DacsMultirailCommerceGraphError(
        "multirail-message-validation-unavailable",
      );
    }
    if (selected.status !== "selected") {
      return Object.freeze({
        disposition: "rejected" as const,
        reasonCode: selected.validation.reasonCode,
      });
    }
    return selected.profile === "x402"
      ? x402.handleMessage(authenticated, context)
      : payDem.handleMessage(authenticated, context);
  };
  return Object.freeze({
    role,
    availability: availability(x402, payDem),
    operations: x402.operations,
    payDemOperations: payDem.payDemOperations,
    validatePayload,
    handleMessage,
    ...(role === "seller"
      ? { handleApplicationRequest: (x402 as SellerGraph).handleApplicationRequest }
      : {}),
  });
}

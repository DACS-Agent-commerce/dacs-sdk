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
type Rail = "x402" | "pay-dem";

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

/**
 * Admit a message when either rail can parse it. Shared handshake messages
 * deliberately validate under both profiles, so this transport-level gate
 * cannot choose their rail. The retained coordinator identity does that in
 * `handleMessage` before any rail handler runs.
 */
async function admit(
  input: Readonly<PayloadValidationInput>,
  x402: BuyerGraph | SellerGraph,
  payDem: BuyerPayDemGraph | SellerPayDemGraph,
): Promise<DacsHttpPayloadValidationV1> {
  const [x402Result, payDemResult] = await Promise.all([
    x402.validatePayload(input),
    payDem.validatePayload(input),
  ]);
  if (x402Result.status === "valid" || payDemResult.status === "valid") {
    return Object.freeze({ status: "valid" as const });
  }
  const unavailable = x402Result.status === "authentication-failure" ||
    payDemResult.status === "authentication-failure";
  return Object.freeze({
    status: unavailable ? "authentication-failure" as const : "invalid" as const,
    reasonCode: unavailable
      ? "multirail-message-validation-unavailable"
      : "multirail-message-profile-incompatible",
  });
}

/** Resolve the one retained rail identity without payload-based fallback. */
async function retainedRail(
  role: "buyer" | "seller",
  jobId: string,
  database: Readonly<DacsLiveRoleInboundOperationContextV1>["database"],
): Promise<Rail | undefined> {
  const [x402, payDem] = await Promise.all([
    database.createLiveCoordinatorStore(role).load(role, jobId),
    database.createPayDemCoordinatorStore(role).load(role, jobId),
  ]);
  const x402Owned = x402.status === "ok";
  const payDemOwned = payDem.status === "ok";
  if ((x402.status !== "ok" && x402.status !== "missing") ||
      (payDem.status !== "ok" && payDem.status !== "missing") ||
      (x402Owned && payDemOwned)) {
    throw new DacsMultirailCommerceGraphError("multirail-job-identity-conflict");
  }
  return x402Owned ? "x402" : payDemOwned ? "pay-dem" : undefined;
}

/** A first session-init declares the profile that its durable order will own. */
function initPayloadRail(input: Readonly<PayloadValidationInput>): Rail | undefined {
  const payload = input.payload as
    { order?: { protocol?: { phase?: unknown } } } | null | undefined;
  const phase = payload?.order?.protocol?.phase;
  return phase === "pay-x402" ? "x402" : phase === "pay-dem" ? "pay-dem" : undefined;
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
 * Existing jobs route by their durable coordinator profile. Only session-init,
 * before a coordinator exists, routes from the order's declared phase. The
 * selected rail revalidates the payload and no sibling rail is ever used as a
 * fallback.
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
      return await admit(input, x402, payDem);
    } catch {
      return Object.freeze({
        status: "authentication-failure" as const,
        reasonCode: "multirail-message-validation-unavailable",
      });
    }
  };
  const rejected = (reasonCode: string): DacsHttpInboundDispositionV1 =>
    Object.freeze({ disposition: "rejected" as const, reasonCode });
  const handleMessage = async (
    authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
    context: Readonly<DacsLiveRoleInboundOperationContextV1>,
  ): Promise<DacsHttpInboundDispositionV1> => {
    if (context.role !== role) {
      return rejected("multirail-message-context-role-mismatch");
    }
    let input: Readonly<PayloadValidationInput>;
    try {
      input = validationInput(authenticated);
    } catch (error) {
      return rejected(error instanceof DacsMultirailCommerceGraphError
        ? error.reasonCode
        : "multirail-message-type-incompatible");
    }
    let profile: Rail | undefined;
    try {
      profile = await retainedRail(role, input.jobId, context.database);
    } catch (error) {
      if (error instanceof DacsMultirailCommerceGraphError) {
        return rejected(error.reasonCode);
      }
      throw new DacsMultirailCommerceGraphError(
        "multirail-message-validation-unavailable",
      );
    }
    if (profile === undefined) {
      if (input.type !== "session-init") {
        return rejected("multirail-message-profile-unresolved");
      }
      profile = initPayloadRail(input);
      if (profile === undefined) {
        return rejected("multirail-message-profile-incompatible");
      }
    }
    const chosen = profile === "x402" ? x402 : payDem;
    let validation: DacsHttpPayloadValidationV1;
    try {
      validation = await chosen.validatePayload(input);
    } catch {
      throw new DacsMultirailCommerceGraphError(
        "multirail-message-validation-unavailable",
      );
    }
    if (validation.status === "authentication-failure") {
      // The HTTP inbox converts thrown handler failures into retained pending
      // work. Never durably reject a valid message for a temporary verifier or
      // store outage on the rail that owns it.
      throw new DacsMultirailCommerceGraphError(
        "multirail-message-validation-unavailable",
      );
    }
    if (validation.status !== "valid") {
      return rejected(validation.reasonCode ?? "multirail-message-profile-incompatible");
    }
    return chosen.handleMessage(authenticated, context);
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


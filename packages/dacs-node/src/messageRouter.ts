import type { DacsLiveRoleInboundOperationContextV1 } from "./roleRuntime.js";
import type {
  DacsHttpAuthenticatedEnvelopeV1,
  DacsHttpMessageType,
  DacsHttpPayloadValidationV1,
  DacsHttpPayloadValidatorV1,
} from "./transport/envelope.js";
import type { DacsHttpInboundDispositionV1 } from "./transport/http.js";

const INBOUND_TYPES = Object.freeze({
  buyer: Object.freeze([
    "agreement-response",
    "payment-evidence-request",
    "bundle-signature-request",
  ] as const),
  seller: Object.freeze([
    "agreement-proposal",
    "payment-evidence-completion",
    "bundle-signature-response",
  ] as const),
});

export type DacsLiveBuyerInboundMessageTypeV1 =
  (typeof INBOUND_TYPES.buyer)[number];
export type DacsLiveSellerInboundMessageTypeV1 =
  (typeof INBOUND_TYPES.seller)[number];
export type DacsLiveCommerceInboundMessageTypeV1 =
  | DacsLiveBuyerInboundMessageTypeV1
  | DacsLiveSellerInboundMessageTypeV1;

export interface DacsLiveMessageRouteV1 {
  validate: DacsHttpPayloadValidatorV1;
  handle(
    authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
    context: Readonly<DacsLiveRoleInboundOperationContextV1>,
  ): Promise<DacsHttpInboundDispositionV1> | DacsHttpInboundDispositionV1;
}

export type DacsLiveBuyerMessageRoutesV1 = Readonly<
  Record<DacsLiveBuyerInboundMessageTypeV1, Readonly<DacsLiveMessageRouteV1>>
>;
export type DacsLiveSellerMessageRoutesV1 = Readonly<
  Record<DacsLiveSellerInboundMessageTypeV1, Readonly<DacsLiveMessageRouteV1>>
>;

export type DacsLiveRoleMessageRouterOptionsV1 = Readonly<
  | { role: "buyer"; routes: DacsLiveBuyerMessageRoutesV1 }
  | { role: "seller"; routes: DacsLiveSellerMessageRoutesV1 }
>;

export interface DacsLiveRoleMessageRouterV1 {
  readonly role: "buyer" | "seller";
  readonly validatePayload: DacsHttpPayloadValidatorV1;
  handleMessage(
    authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
    context: Readonly<DacsLiveRoleInboundOperationContextV1>,
  ): Promise<DacsHttpInboundDispositionV1>;
}

export class DacsLiveMessageRouterError extends Error {
  override readonly name = "DacsLiveMessageRouterError";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

function closedDataObject(value: unknown): value is Readonly<Record<string, unknown>> {
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

function rejected(reasonCode: string): DacsHttpInboundDispositionV1 {
  return Object.freeze({ disposition: "rejected", reasonCode });
}

/**
 * Close the role's authenticated commerce dispatch table. A production role
 * cannot silently omit one protocol message or accept the peer's direction.
 * Reserved diagnostics are handled by the lower service before this router.
 */
export function createDacsLiveRoleMessageRouterV1(
  options: DacsLiveRoleMessageRouterOptionsV1,
): Readonly<DacsLiveRoleMessageRouterV1> {
  if (!closedDataObject(options) || Reflect.ownKeys(options).length !== 2 ||
      (options.role !== "buyer" && options.role !== "seller") ||
      !closedDataObject(options.routes)) {
    throw new TypeError("live role message router options are invalid");
  }
  const role = options.role;
  const required = INBOUND_TYPES[role] as readonly DacsLiveCommerceInboundMessageTypeV1[];
  const routeKeys = Reflect.ownKeys(options.routes);
  if (routeKeys.length !== required.length || routeKeys.some((key) =>
    typeof key !== "string" || !required.includes(
      key as DacsLiveCommerceInboundMessageTypeV1,
    ))) {
    throw new DacsLiveMessageRouterError("message-route-set-role-incompatible");
  }
  const routes = new Map<DacsLiveCommerceInboundMessageTypeV1, DacsLiveMessageRouteV1>();
  const rawRoutes = options.routes as unknown as Readonly<Record<string, unknown>>;
  for (const type of required) {
    const route = rawRoutes[type];
    if (!closedDataObject(route) || Reflect.ownKeys(route).length !== 2 ||
        typeof route.validate !== "function" || typeof route.handle !== "function") {
      throw new DacsLiveMessageRouterError("message-route-set-incomplete");
    }
    const captured = route as unknown as DacsLiveMessageRouteV1;
    routes.set(type, Object.freeze({
      validate: captured.validate,
      handle: captured.handle,
    }));
  }

  const validatePayload: DacsHttpPayloadValidatorV1 = async (input) => {
    const route = routes.get(input.type as DacsLiveCommerceInboundMessageTypeV1);
    if (route === undefined) {
      return Object.freeze({
        status: "invalid" as const,
        reasonCode: "message-type-role-incompatible",
      });
    }
    let result: DacsHttpPayloadValidationV1;
    try {
      result = await Reflect.apply(route.validate, Object.freeze(Object.create(null)), [input]);
    } catch {
      return Object.freeze({
        status: "authentication-failure" as const,
        reasonCode: "message-route-validation-unavailable",
      });
    }
    return result;
  };

  const router: DacsLiveRoleMessageRouterV1 = {
    role,
    validatePayload,
    async handleMessage(authenticated, context) {
      if (context.role !== role) return rejected("message-router-context-role-mismatch");
      const route = routes.get(
        authenticated.envelope.type as DacsLiveCommerceInboundMessageTypeV1,
      );
      if (route === undefined) return rejected("message-type-role-incompatible");
      try {
        return await Reflect.apply(route.handle, Object.freeze(Object.create(null)), [
          authenticated,
          context,
        ]);
      } catch {
        throw new DacsLiveMessageRouterError("message-route-handler-indeterminate");
      }
    },
  };
  return Object.freeze(router);
}

export function dacsLiveRoleInboundMessageTypesV1(
  role: "buyer" | "seller",
): readonly DacsLiveCommerceInboundMessageTypeV1[] {
  if (role !== "buyer" && role !== "seller") {
    throw new TypeError("live role message router role is invalid");
  }
  return INBOUND_TYPES[role];
}

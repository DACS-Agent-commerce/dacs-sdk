import type {
  FixedPriceOfflineCommerceCoordinator,
  FixedPriceOfflineCoordinatorOptions,
  FixedPriceOfflineCoordinatorRole,
  FixedPriceOfflineCoordinatorStore,
  FixedPriceX402CommerceCoordinator,
  FixedPriceX402CoordinatorOptions,
  FixedPriceX402CoordinatorRole,
  FixedPriceX402CoordinatorStore,
  PaymentEvidenceHandshakeStore,
} from "@kynesyslabs/dacs/commerce";

import type { DacsAgentConfig } from "./config.js";
import type {
  DacsNodeEventSink,
  DacsNodeHealthStatus,
  DacsNodeReadinessStatus,
} from "./events.js";
import type {
  DacsHttpAuthenticatedEnvelopeV1,
  DacsHttpEnvelopeV1,
} from "./transport/envelope.js";

/** Stable boundary implemented by the later SQLite adapter package unit. */
export interface DacsNodeStoreFactory {
  createOfflineCoordinatorStore(
    role: FixedPriceOfflineCoordinatorRole,
  ): Promise<FixedPriceOfflineCoordinatorStore>;
  createLiveCoordinatorStore(
    role: FixedPriceX402CoordinatorRole,
  ): Promise<FixedPriceX402CoordinatorStore>;
  createPaymentEvidenceHandshakeStore(): Promise<PaymentEvidenceHandshakeStore>;
  migrate(): Promise<void>;
  close(): Promise<void>;
}

export interface DacsNodeEffectAdapter<Input, Result> {
  /** Reconcile before any repeat when a prior irreversible attempt is ambiguous. */
  reconcile(input: Readonly<Input>): Promise<
    | { status: "completed"; result: Readonly<Result> }
    | { status: "absent" }
    | { status: "indeterminate"; reasonCode: string }
  >;
  execute(input: Readonly<Input>): Promise<Readonly<Result>>;
}

export interface DacsNodeMessageTransport {
  send(
    envelope: Readonly<DacsHttpEnvelopeV1>,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<Readonly<DacsHttpAuthenticatedEnvelopeV1>>;
}

export interface DacsNodeRoleService {
  readonly role: "demo-all" | "buyer" | "seller" | "verifier";
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<Readonly<DacsNodeHealthStatus>>;
  readiness(): Promise<Readonly<DacsNodeReadinessStatus>>;
}

export interface DacsNodeRoleServiceContext {
  config: Readonly<DacsAgentConfig>;
  stores: DacsNodeStoreFactory;
  events: DacsNodeEventSink;
  transport?: DacsNodeMessageTransport;
}

export interface DacsNodeCoordinatorFactory {
  createOfflineBuyer(
    options: Readonly<FixedPriceOfflineCoordinatorOptions>,
  ): FixedPriceOfflineCommerceCoordinator;
  createOfflineSeller(
    options: Readonly<FixedPriceOfflineCoordinatorOptions>,
  ): FixedPriceOfflineCommerceCoordinator;
  createLiveBuyer(
    options: Readonly<FixedPriceX402CoordinatorOptions>,
  ): FixedPriceX402CommerceCoordinator;
  createLiveSeller(
    options: Readonly<FixedPriceX402CoordinatorOptions>,
  ): FixedPriceX402CommerceCoordinator;
}

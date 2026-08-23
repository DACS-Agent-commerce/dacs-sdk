import { resolve } from "node:path";

import {
  createFsFencedSessionStore,
  createFsSellerReceiptStore,
  createFsX402BuyerSettlementStore,
  createFsX402PaywallSettlementStore,
  type FencedSessionStoreV2,
  type SellerReceiptStore,
  type X402BuyerSettlementStore,
  type X402PaywallSettlementStore,
} from "@kynesyslabs/dacs";
import type {
  FixedPricePayDemOperations,
  FixedPriceX402Operations,
} from "@kynesyslabs/dacs/commerce";

import { createDacsFixedPriceX402OperationSetV1 } from "./commerceRuntime.js";
import {
  DACS_NODE_LIVE_PROFILE,
  dacsLiveRailProfiles,
  validateDacsAgentConfig,
  type DacsLiveAgentConfig,
} from "./config.js";
import {
  createDacsDemosActorRuntimeV1,
  createDacsDemosIdentityResolverV1,
  type DacsDemosActorRuntimeV1,
  type DacsDemosAdapterV1,
} from "./demosRuntime.js";
import {
  createDacsX402BuyerEvmRuntimeV1,
  deriveDacsEvmRoleIdentityV1,
  type DacsEvmRoleIdentityV1,
  type DacsX402BuyerEvmRuntimeV1,
} from "./evmRuntime.js";
import {
  createDacsRoleReadinessLatchV1,
  type DacsRoleReadinessLatchV1,
} from "./readiness.js";
import { loadDacsSecretV1 } from "./secrets.js";
import {
  createDacsBuyerServiceV1,
  createDacsSellerServiceV1,
  type DacsLiveRoleApplicationRequestHandlerV1,
  type DacsLiveRolePublicRequestHandlerV1,
  type DacsLiveRoleInboundContextV1,
  type DacsLiveRoleRuntimeContextV1,
  type DacsLiveRoleServiceOptionsV1,
  type DacsLiveRoleServiceV1,
} from "./service.js";
import {
  openDacsNodeSqliteDatabase,
  type DacsNodeSqliteDatabase,
} from "./sqlite.js";
import type { DacsHttpInboundDispositionV1 } from "./transport/http.js";
import type {
  DacsBuyerLiveCommerceGraphV1,
  DacsSellerLiveCommerceGraphV1,
} from "./liveCommerceGraph.js";
import type {
  DacsHttpAuthenticatedEnvelopeV1,
  DacsHttpMessageType,
  DacsHttpPayloadValidatorV1,
} from "./transport/envelope.js";

export interface DacsLiveRoleRuntimeOptionsV1 {
  config: unknown;
  role: "buyer" | "seller";
  authority: string;
  peerAuthority: string;
  peerEndpoint: string;
  workerId: string;
  demosIdentityFilePath: string;
  evmPrivateKeyFilePath?: string;
  evmRpcUrl?: string;
  /**
   * Buyer chain head used by authorization reconciliation. `finalized` is the
   * default; hosts selecting `safe` or `latest` must pair it with the
   * authenticated rail's confirmation policy in their commerce graph.
   */
  evmFinalityTag?: "finalized" | "safe" | "latest";
  databasePath?: string;
  authorizeJob?: (input: Readonly<{
    jobId: string;
    sender: string;
    role: "buyer" | "seller";
    messageType: DacsHttpMessageType;
  }>) => Promise<boolean> | boolean;
  /**
   * Preferred production boundary. It may asynchronously assemble the x402
   * paywall and returns one role-closed operation/message/application graph.
   */
  createCommerceGraph?(
    context: Readonly<DacsLiveRoleOperationContextV1>,
  ): Promise<Readonly<DacsLiveRoleCommerceGraphV1>> |
    Readonly<DacsLiveRoleCommerceGraphV1>;
  /** Legacy/custom-host seam; supply all three callbacks or none of them. */
  createOperations?(
    context: Readonly<DacsLiveRoleOperationContextV1>,
  ): Readonly<FixedPriceX402Operations>;
  createPayDemOperations?(
    context: Readonly<DacsLiveRoleOperationContextV1>,
  ): Readonly<FixedPricePayDemOperations>;
  validatePayload?: DacsLiveRoleRuntimePayloadValidatorV1;
  handleMessage?(
    authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
    context: Readonly<DacsLiveRoleInboundOperationContextV1>,
  ): Promise<DacsHttpInboundDispositionV1> | DacsHttpInboundDispositionV1;
  handleApplicationRequest?: DacsLiveRoleRuntimeApplicationRequestHandlerV1;
  handlePublicRequest?: DacsLiveRolePublicRequestHandlerV1;
  events?: DacsLiveRoleServiceOptionsV1["events"];
  workerIntervalMs?: number;
  workerBatchSize?: number;
  coordinatorLeaseDurationMs?: number;
  readinessMaxAgeMs?: number;
  server?: DacsLiveRoleServiceOptionsV1["server"];
  transport?: DacsLiveRoleServiceOptionsV1["transport"];
  /** Deterministic test/custom-host seam. Production omits this callback. */
  createDemosAdapter?: Parameters<
    typeof createDacsDemosActorRuntimeV1
  >[0]["createAdapter"];
  /** Deterministic test/custom-host seam. Production omits this callback. */
  openDatabase?: (
    input: Parameters<typeof openDacsNodeSqliteDatabase>[0],
  ) => Promise<DacsNodeSqliteDatabase>;
}

export type DacsLiveRoleCommerceGraphV1 =
  | DacsBuyerLiveCommerceGraphV1
  | DacsSellerLiveCommerceGraphV1;

/**
 * Complete actor-local authority available while composing production tracks.
 * The lower HTTP service deliberately exposes neither storage nor a Demos
 * signer; the role runtime adds those capabilities only inside this actor's
 * process after their profile/role/authority bindings have been checked.
 */
export interface DacsLiveRoleOperationContextV1
  extends DacsLiveRoleRuntimeContextV1 {
  readonly config: Readonly<DacsLiveAgentConfig>;
  readonly database: DacsNodeSqliteDatabase;
  readonly demos: Readonly<DacsDemosActorRuntimeV1>;
  readonly sessionStore: FencedSessionStoreV2;
  readonly commerceStores: Readonly<DacsLiveRoleCommerceStoresV1>;
  readonly evm?: Readonly<DacsLiveRoleEvmRuntimeV1>;
}

export type DacsLiveRoleCommerceStoresV1 =
  | Readonly<{
      role: "buyer";
      x402Settlement?: X402BuyerSettlementStore;
    }>
  | Readonly<{
      role: "seller";
      x402Settlement?: X402PaywallSettlementStore;
      sellerReceipts: SellerReceiptStore;
    }>;

export type DacsLiveRoleEvmRuntimeV1 =
  | Readonly<{
      role: "buyer";
      runtime: Readonly<DacsX402BuyerEvmRuntimeV1>;
      address: string;
    }>
  | Readonly<{
      role: "seller";
      identity: Readonly<DacsEvmRoleIdentityV1>;
      address: string;
    }>;

export interface DacsLiveRoleInboundOperationContextV1
  extends DacsLiveRoleInboundContextV1, DacsLiveRoleOperationContextV1 {}

export type DacsLiveRoleRuntimeApplicationRequestHandlerV1 = (
  request: Parameters<DacsLiveRoleApplicationRequestHandlerV1>[0],
  response: Parameters<DacsLiveRoleApplicationRequestHandlerV1>[1],
  context: Readonly<DacsLiveRoleInboundOperationContextV1>,
) => ReturnType<DacsLiveRoleApplicationRequestHandlerV1>;

export type DacsLiveRoleRuntimePayloadValidatorV1 = (
  input: Parameters<DacsHttpPayloadValidatorV1>[0],
  context: Readonly<DacsLiveRoleOperationContextV1>,
) => ReturnType<DacsHttpPayloadValidatorV1>;

export interface DacsLiveRoleRuntimeV1 {
  readonly role: "buyer" | "seller";
  readonly config: Readonly<DacsLiveAgentConfig>;
  readonly database: DacsNodeSqliteDatabase;
  readonly demos: Readonly<DacsDemosActorRuntimeV1>;
  readonly sessionStore: FencedSessionStoreV2;
  readonly commerceStores: Readonly<DacsLiveRoleCommerceStoresV1>;
  readonly evm?: Readonly<DacsLiveRoleEvmRuntimeV1>;
  readonly readinessLatch: Readonly<DacsRoleReadinessLatchV1>;
  readonly service: Readonly<DacsLiveRoleServiceV1>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export class DacsLiveRoleRuntimeError extends Error {
  override readonly name = "DacsLiveRoleRuntimeError";

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

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096 &&
    value.trim() === value && !value.includes("\0");
}

/**
 * Open one complete role-owned host runtime. This factory owns local secret
 * loading/destruction, keyed SQLite admission, the Demos write journal and
 * identity resolver, the authenticated readiness latch, and HTTP lifecycle.
 * Protocol operations and application fulfilment remain explicit injections.
 */
export async function createDacsLiveRoleRuntimeV1(
  rawOptions: Readonly<DacsLiveRoleRuntimeOptionsV1>,
): Promise<Readonly<DacsLiveRoleRuntimeV1>> {
  if (!plainObject(rawOptions)) {
    throw new TypeError("live role runtime options are invalid");
  }
  const graphMode = typeof rawOptions.createCommerceGraph === "function";
  const anyLegacyCommerce = rawOptions.createOperations !== undefined ||
    rawOptions.createPayDemOperations !== undefined ||
    rawOptions.validatePayload !== undefined || rawOptions.handleMessage !== undefined ||
    rawOptions.handleApplicationRequest !== undefined;
  const completeLegacyCommerce = (typeof rawOptions.createOperations === "function" ||
    typeof rawOptions.createPayDemOperations === "function") &&
    typeof rawOptions.validatePayload === "function" &&
    typeof rawOptions.handleMessage === "function";
  if ((rawOptions.role !== "buyer" && rawOptions.role !== "seller") ||
      !nonEmpty(rawOptions.authority) || !nonEmpty(rawOptions.peerAuthority) ||
      !nonEmpty(rawOptions.peerEndpoint) || !nonEmpty(rawOptions.workerId) ||
      !nonEmpty(rawOptions.demosIdentityFilePath) ||
      (rawOptions.evmPrivateKeyFilePath !== undefined &&
        !nonEmpty(rawOptions.evmPrivateKeyFilePath)) ||
      (rawOptions.evmRpcUrl !== undefined && !nonEmpty(rawOptions.evmRpcUrl)) ||
      (rawOptions.evmFinalityTag !== undefined &&
        !["finalized", "safe", "latest"].includes(rawOptions.evmFinalityTag)) ||
      (rawOptions.databasePath !== undefined && !nonEmpty(rawOptions.databasePath)) ||
      (rawOptions.createOperations !== undefined &&
        typeof rawOptions.createOperations !== "function") ||
      (rawOptions.createPayDemOperations !== undefined &&
        typeof rawOptions.createPayDemOperations !== "function") ||
      (graphMode ? anyLegacyCommerce : !completeLegacyCommerce) ||
      (rawOptions.createCommerceGraph !== undefined && !graphMode) ||
      (rawOptions.handleApplicationRequest !== undefined &&
        typeof rawOptions.handleApplicationRequest !== "function") ||
      (rawOptions.handlePublicRequest !== undefined &&
        typeof rawOptions.handlePublicRequest !== "function") ||
      (rawOptions.authorizeJob !== undefined && typeof rawOptions.authorizeJob !== "function") ||
      (rawOptions.createDemosAdapter !== undefined &&
        typeof rawOptions.createDemosAdapter !== "function") ||
      (rawOptions.openDatabase !== undefined && typeof rawOptions.openDatabase !== "function")) {
    throw new TypeError("live role runtime options are invalid");
  }
  const config = validateDacsAgentConfig(rawOptions.config);
  if (config.mode !== "live-demos" || config.profile !== DACS_NODE_LIVE_PROFILE ||
      config.role !== rawOptions.role) {
    throw new TypeError("live role runtime configuration is incompatible");
  }
  const railProfiles = dacsLiveRailProfiles(config);
  const x402Enabled = railProfiles.includes("x402");
  const payDemEnabled = railProfiles.includes("pay-dem");
  if ((x402Enabled && (!nonEmpty(rawOptions.evmPrivateKeyFilePath) ||
        !nonEmpty(rawOptions.evmRpcUrl))) ||
      (graphMode && (!x402Enabled || payDemEnabled)) ||
      (rawOptions.createOperations !== undefined && !x402Enabled) ||
      (rawOptions.createPayDemOperations !== undefined && !payDemEnabled) ||
      (x402Enabled && !graphMode && rawOptions.createOperations === undefined) ||
      (payDemEnabled && !graphMode && rawOptions.createPayDemOperations === undefined)) {
    throw new TypeError("live role runtime rail capabilities are incompatible");
  }
  const role = rawOptions.role;
  const demosIdentity = await loadDacsSecretV1({
    name: `${role}-demos-identity`,
    mode: "live-demos",
    filePath: resolve(rawOptions.demosIdentityFilePath),
  });
  let database: DacsNodeSqliteDatabase | undefined;
  try {
    const openDatabase = rawOptions.openDatabase ?? openDacsNodeSqliteDatabase;
    database = await openDatabase({
      databasePath: resolve(
        rawOptions.databasePath ?? resolve(config.dataDirectory, "actor.sqlite"),
      ),
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role,
      authority: rawOptions.authority,
    });
  } catch {
    demosIdentity.destroy();
    throw new DacsLiveRoleRuntimeError("role-database-open-failed");
  }

  let demos: Readonly<DacsDemosActorRuntimeV1>;
  try {
    demos = await createDacsDemosActorRuntimeV1({
      config,
      role,
      authority: rawOptions.authority,
      demosIdentity,
      ...(rawOptions.createDemosAdapter === undefined
        ? {} : { createAdapter: rawOptions.createDemosAdapter }),
    });
  } catch {
    database.close();
    throw new DacsLiveRoleRuntimeError("role-demos-runtime-open-failed");
  }

  let readinessLatch: Readonly<DacsRoleReadinessLatchV1>;
  try {
    readinessLatch = createDacsRoleReadinessLatchV1({
      config,
      authority: rawOptions.authority,
    });
  } catch {
    database.close();
    throw new DacsLiveRoleRuntimeError("role-readiness-create-failed");
  }
  let sessionStore: FencedSessionStoreV2;
  try {
    sessionStore = await createFsFencedSessionStore({
      dir: resolve(config.dataDirectory, "sessions"),
    });
  } catch {
    database.close();
    throw new DacsLiveRoleRuntimeError("role-session-store-open-failed");
  }
  let commerceStores: Readonly<DacsLiveRoleCommerceStoresV1>;
  try {
    commerceStores = role === "buyer"
      ? Object.freeze({
          role,
          ...(x402Enabled
            ? {
                x402Settlement: await createFsX402BuyerSettlementStore({
                  dir: resolve(config.dataDirectory, "x402-buyer-settlements"),
                }),
              }
            : {}),
        })
      : Object.freeze({
          role,
          ...(x402Enabled
            ? {
                x402Settlement: await createFsX402PaywallSettlementStore({
                  dir: resolve(config.dataDirectory, "x402-seller-settlements"),
                }),
              }
            : {}),
          sellerReceipts: await createFsSellerReceiptStore({
            dir: resolve(config.dataDirectory, "seller-receipts"),
          }),
        });
  } catch {
    database.close();
    throw new DacsLiveRoleRuntimeError("role-commerce-stores-open-failed");
  }
  let evm: Readonly<DacsLiveRoleEvmRuntimeV1> | undefined;
  try {
    if (x402Enabled) {
      const evmPrivateKey = await loadDacsSecretV1({
        name: `${role}-evm-private-key`,
        mode: "live-demos",
        filePath: resolve(rawOptions.evmPrivateKeyFilePath!),
      });
      if (role === "buyer") {
        const runtime = await createDacsX402BuyerEvmRuntimeV1({
          config,
          evmPrivateKey,
          rpcUrl: rawOptions.evmRpcUrl!,
          finalityTag: rawOptions.evmFinalityTag ?? "finalized",
        });
        evm = Object.freeze({ role, runtime, address: runtime.payerAddress });
      } else {
        const identity = await deriveDacsEvmRoleIdentityV1({
          config,
          role,
          evmPrivateKey,
        });
        evm = Object.freeze({ role, identity, address: identity.address });
      }
    }
  } catch {
    database.close();
    throw new DacsLiveRoleRuntimeError("role-evm-runtime-open-failed");
  }
  let service: Readonly<DacsLiveRoleServiceV1>;
  try {
    const resolveIdentity = createDacsDemosIdentityResolverV1({
      runtime: demos,
      peerAuthority: rawOptions.peerAuthority,
      peerRole: role === "buyer" ? "seller" : "buyer",
      ...(rawOptions.authorizeJob === undefined
        ? {} : { authorizeJob: rawOptions.authorizeJob }),
    });
    const operationContext = (
      context: Readonly<DacsLiveRoleRuntimeContextV1>,
    ): Readonly<DacsLiveRoleOperationContextV1> => Object.freeze({
      ...context,
      config,
      database: database!,
      demos,
      sessionStore,
      commerceStores,
      ...(evm === undefined ? {} : { evm }),
    });
    const inboundOperationContext = (
      context: Readonly<DacsLiveRoleInboundContextV1>,
    ): Readonly<DacsLiveRoleInboundOperationContextV1> => Object.freeze({
      ...context,
      config,
      database: database!,
      demos,
      sessionStore,
      commerceStores,
      ...(evm === undefined ? {} : { evm }),
    });
    let establishedOperationContext: Readonly<DacsLiveRoleOperationContextV1> | undefined;
    let commerceGraph: Readonly<DacsLiveRoleCommerceGraphV1> | undefined;
    let commerceOperations: Readonly<FixedPriceX402Operations> | undefined;
    if (graphMode) {
      const deferredQueueMessage: DacsLiveRoleRuntimeContextV1["queueMessage"] =
        (input) => {
          if (service === undefined) {
            return Promise.reject(new DacsLiveRoleRuntimeError(
              "role-service-send-before-initialization",
            ));
          }
          return service.queueMessage(input);
        };
      const deferredSendMessage: DacsLiveRoleRuntimeContextV1["sendMessage"] =
        (input, sendOptions) => {
          if (service === undefined) {
            return Promise.reject(new DacsLiveRoleRuntimeError(
              "role-service-send-before-initialization",
            ));
          }
          return service.sendMessage(input, sendOptions);
        };
      establishedOperationContext = operationContext(Object.freeze({
        role,
        authority: rawOptions.authority,
        peerAuthority: rawOptions.peerAuthority,
        queueMessage: deferredQueueMessage,
        sendMessage: deferredSendMessage,
      }));
      const created = await rawOptions.createCommerceGraph!(establishedOperationContext);
      if (!plainObject(created) || created.role !== role ||
          !plainObject(created.operations) ||
          typeof created.validatePayload !== "function" ||
          typeof created.handleMessage !== "function" ||
          (role === "seller" &&
            (created.role !== "seller" ||
              typeof created.handleApplicationRequest !== "function"))) {
        throw new DacsLiveRoleRuntimeError("role-commerce-graph-invalid");
      }
      try {
        commerceOperations = createDacsFixedPriceX402OperationSetV1({
          role,
          operations: created.operations as Readonly<Record<string, unknown>>,
        });
      } catch {
        throw new DacsLiveRoleRuntimeError("role-commerce-graph-invalid");
      }
      if (!plainObject(created.availability) ||
          (created.availability.status !== "configured" &&
            (created.availability.status !== "blocked" ||
              !nonEmpty(created.availability.reasonCode)))) {
        throw new DacsLiveRoleRuntimeError("role-commerce-graph-invalid");
      }
      commerceGraph = created;
    }
    const serviceOptions: DacsLiveRoleServiceOptionsV1 = {
      config,
      database,
      workerId: rawOptions.workerId,
      peerAuthority: rawOptions.peerAuthority,
      peerEndpoint: rawOptions.peerEndpoint,
      resolveIdentity,
      validatePayload: (input) => {
        if (establishedOperationContext === undefined) {
          return Object.freeze({
            status: "authentication-failure" as const,
            reasonCode: "role-operation-context-unavailable",
          });
        }
        return commerceGraph === undefined
          ? rawOptions.validatePayload!(input, establishedOperationContext)
          : commerceGraph.validatePayload(input);
      },
      signTransportEnvelope: demos.signTransportEnvelope,
      ...((commerceOperations === undefined && rawOptions.createOperations === undefined)
        ? {}
        : {
            createOperations: (context: Readonly<DacsLiveRoleRuntimeContextV1>) => {
              if (commerceOperations !== undefined) return commerceOperations;
              establishedOperationContext = operationContext(context);
              return rawOptions.createOperations!(establishedOperationContext);
            },
          }),
      ...(rawOptions.createPayDemOperations === undefined
        ? {}
        : {
            createPayDemOperations: (
              context: Readonly<DacsLiveRoleRuntimeContextV1>,
            ) => {
              establishedOperationContext = operationContext(context);
              return rawOptions.createPayDemOperations!(establishedOperationContext);
            },
          }),
      handleMessage: (authenticated, context) => {
        const inbound = inboundOperationContext(context);
        return commerceGraph === undefined
          ? rawOptions.handleMessage!(authenticated, inbound)
          : commerceGraph.handleMessage(authenticated, inbound);
      },
      commerceAvailability: commerceGraph?.availability ?? Object.freeze({
        status: "blocked" as const,
        reasonCode: "legacy-commerce-capability-unreported",
      }),
      readiness: readinessLatch.readiness,
      ...(rawOptions.handlePublicRequest === undefined ? {} : {
        handlePublicRequest: rawOptions.handlePublicRequest,
      }),
      ...((rawOptions.handleApplicationRequest === undefined &&
          !(commerceGraph?.role === "seller"))
        ? {} : {
            handleApplicationRequest: (request, response, context) => {
              const inbound = inboundOperationContext(context);
              return commerceGraph?.role === "seller"
                ? commerceGraph.handleApplicationRequest(request, response, inbound)
                : rawOptions.handleApplicationRequest!(request, response, inbound);
            },
          }),
      ...(rawOptions.events === undefined ? {} : { events: rawOptions.events }),
      ...(rawOptions.workerIntervalMs === undefined
        ? {} : { workerIntervalMs: rawOptions.workerIntervalMs }),
      ...(rawOptions.workerBatchSize === undefined
        ? {} : { workerBatchSize: rawOptions.workerBatchSize }),
      ...(rawOptions.coordinatorLeaseDurationMs === undefined
        ? {} : { coordinatorLeaseDurationMs: rawOptions.coordinatorLeaseDurationMs }),
      ...(rawOptions.readinessMaxAgeMs === undefined
        ? {} : { readinessMaxAgeMs: rawOptions.readinessMaxAgeMs }),
      ...(rawOptions.server === undefined ? {} : { server: rawOptions.server }),
      ...(rawOptions.transport === undefined ? {} : { transport: rawOptions.transport }),
    };
    service = role === "buyer"
      ? createDacsBuyerServiceV1(serviceOptions)
      : createDacsSellerServiceV1(serviceOptions);
  } catch (error) {
    if (evm?.role === "buyer") evm.runtime.destroy();
    database.close();
    if (error instanceof DacsLiveRoleRuntimeError) throw error;
    throw new DacsLiveRoleRuntimeError("role-service-create-failed");
  }

  let closed = false;
  let stopTask: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (stopTask !== undefined) return stopTask;
    if (closed) return Promise.resolve();
    stopTask = (async () => {
      let failed = false;
      try {
        await service.stop();
      } catch {
        failed = true;
      } finally {
        closed = true;
        if (evm?.role === "buyer") evm.runtime.destroy();
        try {
          database!.close();
        } catch {
          failed = true;
        }
      }
      if (failed) throw new DacsLiveRoleRuntimeError("role-runtime-stop-failed");
    })().finally(() => {
      stopTask = undefined;
    });
    return stopTask;
  };

  return Object.freeze({
    role,
    config,
    database,
    demos,
    sessionStore,
    commerceStores,
    ...(evm === undefined ? {} : { evm }),
    readinessLatch,
    service,
    async start() {
      if (closed) throw new DacsLiveRoleRuntimeError("role-runtime-closed");
      try {
        // Every process incarnation must be diagnosed before it becomes ready;
        // a still-fresh latch from the previous process is not reused blindly.
        await readinessLatch.revoke();
        await service.start();
      } catch {
        await stop().catch(() => undefined);
        throw new DacsLiveRoleRuntimeError("role-service-start-failed");
      }
    },
    stop,
  });
}

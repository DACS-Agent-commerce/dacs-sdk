import { resolve } from "node:path";

import type { FixedPriceX402Operations } from "@kynesyslabs/dacs/commerce";

import {
  DACS_NODE_LIVE_PROFILE,
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
  createDacsRoleReadinessLatchV1,
  type DacsRoleReadinessLatchV1,
} from "./readiness.js";
import { loadDacsSecretV1 } from "./secrets.js";
import {
  createDacsBuyerServiceV1,
  createDacsSellerServiceV1,
  type DacsLiveRoleApplicationRequestHandlerV1,
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
  databasePath?: string;
  authorizeJob?: (input: Readonly<{
    jobId: string;
    sender: string;
    role: "buyer" | "seller";
    messageType: DacsHttpMessageType;
  }>) => Promise<boolean> | boolean;
  createOperations(
    context: Readonly<DacsLiveRoleOperationContextV1>,
  ): Readonly<FixedPriceX402Operations>;
  validatePayload: DacsLiveRoleRuntimePayloadValidatorV1;
  handleMessage(
    authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
    context: Readonly<DacsLiveRoleInboundOperationContextV1>,
  ): Promise<DacsHttpInboundDispositionV1> | DacsHttpInboundDispositionV1;
  handleApplicationRequest?: DacsLiveRoleRuntimeApplicationRequestHandlerV1;
  events?: DacsLiveRoleServiceOptionsV1["events"];
  workerIntervalMs?: number;
  workerBatchSize?: number;
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

/**
 * Complete actor-local authority available while composing production tracks.
 * The lower HTTP service deliberately exposes neither storage nor a Demos
 * signer; the role runtime adds those capabilities only inside this actor's
 * process after their profile/role/authority bindings have been checked.
 */
export interface DacsLiveRoleOperationContextV1
  extends DacsLiveRoleRuntimeContextV1 {
  readonly database: DacsNodeSqliteDatabase;
  readonly demos: Readonly<DacsDemosActorRuntimeV1>;
}

export interface DacsLiveRoleInboundOperationContextV1
  extends DacsLiveRoleInboundContextV1 {
  readonly database: DacsNodeSqliteDatabase;
  readonly demos: Readonly<DacsDemosActorRuntimeV1>;
}

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
  if (!plainObject(rawOptions) ||
      (rawOptions.role !== "buyer" && rawOptions.role !== "seller") ||
      !nonEmpty(rawOptions.authority) || !nonEmpty(rawOptions.peerAuthority) ||
      !nonEmpty(rawOptions.peerEndpoint) || !nonEmpty(rawOptions.workerId) ||
      !nonEmpty(rawOptions.demosIdentityFilePath) ||
      (rawOptions.databasePath !== undefined && !nonEmpty(rawOptions.databasePath)) ||
      typeof rawOptions.createOperations !== "function" ||
      typeof rawOptions.validatePayload !== "function" ||
      typeof rawOptions.handleMessage !== "function" ||
      (rawOptions.handleApplicationRequest !== undefined &&
        typeof rawOptions.handleApplicationRequest !== "function") ||
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
      database: database!,
      demos,
    });
    const inboundOperationContext = (
      context: Readonly<DacsLiveRoleInboundContextV1>,
    ): Readonly<DacsLiveRoleInboundOperationContextV1> => Object.freeze({
      ...context,
      database: database!,
      demos,
    });
    let establishedOperationContext: Readonly<DacsLiveRoleOperationContextV1> | undefined;
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
        return rawOptions.validatePayload(input, establishedOperationContext);
      },
      signTransportEnvelope: demos.signTransportEnvelope,
      createOperations: (context) => {
        establishedOperationContext = operationContext(context);
        return rawOptions.createOperations(establishedOperationContext);
      },
      handleMessage: (authenticated, context) =>
        rawOptions.handleMessage(authenticated, inboundOperationContext(context)),
      readiness: readinessLatch.readiness,
      ...(rawOptions.handleApplicationRequest === undefined
        ? {} : {
            handleApplicationRequest: (request, response, context) =>
              rawOptions.handleApplicationRequest!(
                request,
                response,
                inboundOperationContext(context),
              ),
          }),
      ...(rawOptions.events === undefined ? {} : { events: rawOptions.events }),
      ...(rawOptions.workerIntervalMs === undefined
        ? {} : { workerIntervalMs: rawOptions.workerIntervalMs }),
      ...(rawOptions.workerBatchSize === undefined
        ? {} : { workerBatchSize: rawOptions.workerBatchSize }),
      ...(rawOptions.readinessMaxAgeMs === undefined
        ? {} : { readinessMaxAgeMs: rawOptions.readinessMaxAgeMs }),
      ...(rawOptions.server === undefined ? {} : { server: rawOptions.server }),
      ...(rawOptions.transport === undefined ? {} : { transport: rawOptions.transport }),
    };
    service = role === "buyer"
      ? createDacsBuyerServiceV1(serviceOptions)
      : createDacsSellerServiceV1(serviceOptions);
  } catch {
    database.close();
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

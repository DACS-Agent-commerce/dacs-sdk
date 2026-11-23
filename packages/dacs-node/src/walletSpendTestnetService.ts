import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";

import {
  canonicalWalletSpendWalletV1,
  type WalletSpendAuthorityDependenciesV1,
  type WalletSpendPolicyV1,
  type WalletSpendStateV1,
} from "@kynesyslabs/dacs";

import { createDacsWalletSpendDemosReaderV1, type DacsWalletSpendDemosReaderV1 } from "./walletSpendDemosReader.js";
import { createDacsWalletSpendEvmReaderV1, type DacsWalletSpendEvmReaderV1 } from "./walletSpendEvmReader.js";
import {
  openDacsWalletSpendFileAuthorityStoresV1,
  type DacsWalletSpendFileAuthorityStoresV1,
} from "./walletSpendFileAuthorityStores.js";
import { createDacsWalletSpendContinuityAuthorityV2 } from "./walletSpendPostgres.js";
import { createDacsWalletSpendAuthorityServiceV2 } from "./walletSpendRemote.js";
import {
  createDacsWalletSpendTestnetDemRecoveryV1,
  openDacsWalletSpendDemEvidenceStoreV1,
} from "./walletSpendTestnetDemRecovery.js";
import { createRetainingDacsWalletSpendOperationLogV1 } from "./walletSpendTestnetOperationLog.js";
import { createDacsWalletSpendTestnetRecoveryV1 } from "./walletSpendTestnetRecovery.js";
import {
  DacsWalletSpendTestnetAuthorityError,
  loadDacsWalletSpendTestnetAuthoritySettingsV1,
  type DacsWalletSpendTestnetAuthoritySettingsV1,
} from "./walletSpendTestnetSettings.js";

/** A running testnet wallet-spend authority on its loopback address. */
export interface DacsWalletSpendTestnetAuthorityV1 {
  /** `http://<loopback>:<port>/`, the address the buyer's remote client uses. */
  readonly url: string;
  readonly authorityId: string;
  readonly epoch: string;
  readonly witnessVerificationKey: string;
  /** The x402 lane's lineage, present when that lane is configured. */
  readonly lineageKey?: string;
  /** The x402 lane's policy hash, present when that lane is configured. */
  readonly policyHash?: string;
  /** The DEM lane's lineage and policy hash, present when that lane is configured. */
  readonly payDem?: Readonly<{ lineageKey: string; policyHash: string }>;
  /** Stops accepting, waits up to 5 s for running requests, then closes every lane's stores. */
  stop(): Promise<void>;
}

type Handler = (request: Request) => Promise<Response>;
type Settings = Readonly<DacsWalletSpendTestnetAuthoritySettingsV1>;

const BUYER_ROLE = "buyer";
const OWNER = "dacs-wallet-spend-testnet-authority";
/** Operations the log keeps; once full, the oldest completed one is dropped for a new claim. */
const RETAINED_OPERATIONS = 50_000;
const HEADERS_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;
const STOP_GRACE_MS = 5_000;
const REASON_CODE_RE = /^wallet-spend-[a-z0-9-]+$/;

/** Every start refusal as one named error; an unnamed failure keeps its cause but not its message. */
function startRefusal(error: unknown): DacsWalletSpendTestnetAuthorityError {
  if (error instanceof DacsWalletSpendTestnetAuthorityError) return error;
  const reasonCode = error instanceof Error && REASON_CODE_RE.test(error.message)
    ? error.message
    : "wallet-spend-testnet-authority-start-failed";
  return new DacsWalletSpendTestnetAuthorityError(reasonCode, undefined, { cause: error });
}

/**
 * The request body as a stream read one chunk at a time. A cancelled body is
 * drained, not destroyed, so the handler's refusal still reaches the client.
 */
function bodyStream(incoming: IncomingMessage): ReadableStream<Uint8Array> {
  let detach = (): void => undefined;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const onData = (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
        if ((controller.desiredSize ?? 0) <= 0) incoming.pause();
      };
      const onEnd = () => {
        detach();
        controller.close();
      };
      const onError = (error: Error) => {
        detach();
        controller.error(error);
      };
      detach = () => {
        incoming.off("data", onData);
        incoming.off("end", onEnd);
        incoming.off("error", onError);
      };
      incoming.on("data", onData);
      incoming.once("end", onEnd);
      incoming.once("error", onError);
    },
    pull() {
      incoming.resume();
    },
    cancel() {
      detach();
      incoming.resume();
    },
  }, { highWaterMark: 1 });
}

/** The incoming request as a web `Request`, with the body still a stream so the handler's byte limit applies. */
function toRequest(incoming: IncomingMessage, origin: string): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(name, item);
  }
  const method = incoming.method ?? "GET";
  const url = new URL(incoming.url ?? "/", origin);
  if (method === "GET" || method === "HEAD") return new Request(url, { method, headers });
  // Node needs `duplex` for a streamed request body; the bundled RequestInit type does not list it.
  const init: RequestInit & { duplex: "half" } = { method, headers, body: bodyStream(incoming), duplex: "half" };
  return new Request(url, init);
}

async function sendResponse(outgoing: ServerResponse, response: Response): Promise<void> {
  const body = Buffer.from(await response.arrayBuffer());
  response.headers.forEach((value, name) => outgoing.setHeader(name, value));
  outgoing.setHeader("content-length", body.byteLength);
  outgoing.writeHead(response.status);
  outgoing.end(body);
}

function listen(server: Server, address: Settings["listen"]): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(address.port, address.hostname, () => {
      server.off("error", reject);
      const bound = server.address();
      if (bound !== null && typeof bound !== "string") return resolve(bound.port);
      server.close();
      reject(new Error("listening address is not a TCP port"));
    });
  });
}

/**
 * Binds the loopback port before anything else is opened. Requests wait until
 * `serve` passes the handler; passing an error closes their connections.
 */
async function bindPort(address: Settings["listen"]): Promise<Readonly<{
  server: Server;
  origin: string;
  serve(handler: Handler | Error): void;
}>> {
  let serve: (handler: Handler | Error) => void = () => undefined;
  const handlerReady = new Promise<Handler>((resolve, reject) => {
    serve = (handler) => (handler instanceof Error ? reject(handler) : resolve(handler));
  });
  handlerReady.catch(() => undefined);
  let origin = "";
  const server = createServer((incoming, outgoing) => {
    handlerReady
      .then((handler) => handler(toRequest(incoming, origin)))
      .then((response) => sendResponse(outgoing, response))
      .catch(() => outgoing.destroy());
  });
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  let port: number;
  try {
    port = await listen(server, address);
  } catch (cause) {
    throw new DacsWalletSpendTestnetAuthorityError(
      "wallet-spend-testnet-authority-listen-failed", "DACS_WALLET_AUTHORITY_URL", { cause },
    );
  }
  const host = address.hostname.includes(":") ? `[${address.hostname}]` : address.hostname;
  origin = `http://${host}:${port}`;
  return { server, origin, serve };
}

function closeServer(server: Server, graceMs: number): Promise<void> {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();
  const grace = setTimeout(() => server.closeAllConnections(), graceMs);
  return closed.finally(() => clearTimeout(grace));
}

/** One lineage the service serves: its open stores, its policy and its chain rule. */
interface Lane {
  stores: Readonly<DacsWalletSpendFileAuthorityStoresV1>;
  policy: Readonly<WalletSpendPolicyV1>;
  dependencies: Readonly<Pick<WalletSpendAuthorityDependenciesV1,
    "readBalance" | "authenticateRecovery" | "bindAuthorizationValidBefore">>;
}

/** The lane's head state; its stores are provisioned at open, so a missing head is an error. */
function headStateReader(stores: Readonly<DacsWalletSpendFileAuthorityStoresV1>) {
  return async (): Promise<Readonly<WalletSpendStateV1>> => {
    const state = await stores.stateStore().read?.(stores.lineageKey);
    if (state === undefined || state === null) throw new Error("wallet-spend-continuity-state-missing");
    return state;
  };
}

const reportLine = (line: Readonly<Record<string, string>>): void => {
  process.stderr.write(`${JSON.stringify(line)}\n`);
};

/** The x402 lane: Base Sepolia reads and its chain rule, which binds each hold's validBefore. */
function x402Lane(stores: Lane["stores"], policy: Lane["policy"], reader: Readonly<DacsWalletSpendEvmReaderV1>): Lane {
  const recovery = createDacsWalletSpendTestnetRecoveryV1({ policy, reader, report: reportLine });
  return {
    stores,
    policy,
    dependencies: {
      readBalance: reader.readBalance,
      authenticateRecovery: recovery.authenticateRecovery,
      bindAuthorizationValidBefore: recovery.bindAuthorizationValidBefore,
    },
  };
}

/**
 * The DEM lane: Demos testnet reads and its chain rule. It binds no validBefore: a signed DEM
 * transfer carries no expiry, so a DEM hold ends only when the chain shows its transfer.
 */
function payDemLane(
  stores: Lane["stores"],
  policy: Lane["policy"],
  reader: Readonly<DacsWalletSpendDemosReaderV1>,
  evidenceStore: Parameters<typeof createDacsWalletSpendTestnetDemRecoveryV1>[0]["evidenceStore"],
): Lane {
  const recovery = createDacsWalletSpendTestnetDemRecoveryV1({
    policy, reader, readState: headStateReader(stores), evidenceStore, report: reportLine,
  });
  return {
    stores,
    policy,
    dependencies: { readBalance: reader.readBalance, authenticateRecovery: recovery.authenticateRecovery },
  };
}

/** Builds the per-request handler over the open lanes; a request reaches only the lane of its lineage. */
function composeHandler({ settings, tokenDigest, lanes }: Readonly<{
  settings: Settings;
  tokenDigest: Uint8Array;
  lanes: readonly Lane[];
}>): Handler {
  return createDacsWalletSpendAuthorityServiceV2({
    authenticate(token) {
      const presented = createHash("sha256").update(token, "utf8").digest();
      return timingSafeEqual(presented, tokenDigest) ? BUYER_ROLE : null;
    },
    resolveAuthority(scope) {
      const lane = lanes.find(({ stores }) => stores.lineageKey === scope.lineageKey);
      if (lane === undefined || scope.roleId !== BUYER_ROLE || scope.authorityId !== settings.authorityId ||
          scope.epoch !== settings.epoch || scope.policyHash !== lane.stores.policyHash ||
          scope.chainId !== lane.policy.chainId || canonicalWalletSpendWalletV1(scope.wallet) !== lane.policy.wallet) {
        return null;
      }
      const { roleId, operationId, requestHash } = scope;
      return createDacsWalletSpendContinuityAuthorityV2({
        policy: lane.policy,
        store: lane.stores.stateStore({ roleId, operationId, requestHash }),
        dependencies: { ...lane.dependencies, owner: OWNER },
      });
    },
    operations: createRetainingDacsWalletSpendOperationLogV1(RETAINED_OPERATIONS),
  });
}

/**
 * Starts the testnet wallet-spend authority: it checks the settings, the Base
 * Sepolia RPC's chain for the x402 lane and the Demos node's identity for the
 * DEM lane, binds the loopback port before it opens any data directory, and
 * serves only the V2 operation routes, each lane under its own lineage.
 * Requests that arrive before the stores are open wait for them.
 *
 * @param input.environment The settings source; `process.env` when omitted.
 * @returns The running authority and its public identity.
 * @throws DacsWalletSpendTestnetAuthorityError naming the refusal, for example
 *   `wallet-spend-testnet-authority-listen-failed` when the port is taken, or
 *   `wallet-spend-testnet-authority-demos-network-mismatch` when the Demos node
 *   is not the approved testnet.
 */
export async function startDacsWalletSpendTestnetAuthorityV1(input: Readonly<{
  environment?: Readonly<Record<string, string | undefined>>;
}> = {}): Promise<Readonly<DacsWalletSpendTestnetAuthorityV1>> {
  let loaded: Awaited<ReturnType<typeof loadDacsWalletSpendTestnetAuthoritySettingsV1>> | undefined;
  try {
    loaded = await loadDacsWalletSpendTestnetAuthoritySettingsV1(input.environment ?? process.env);
    const { settings, tokenDigest, witnessSeed } = loaded;
    // Each configured lane's chain is checked before the port is bound or a directory is opened.
    const x402 = settings.x402 === undefined ? undefined : {
      settings: settings.x402,
      reader: createDacsWalletSpendEvmReaderV1({
        rpcUrl: settings.x402.evmRpcUrl, policy: settings.x402.policy,
        authorizationSearchFromBlock: settings.x402.authorizationSearchFromBlock,
      }),
    };
    await x402?.reader.assertChain();
    const payDem = settings.payDem === undefined ? undefined : {
      settings: settings.payDem,
      reader: createDacsWalletSpendDemosReaderV1({ rpcUrl: settings.payDem.demosRpcUrl, policy: settings.payDem.policy }),
    };
    await payDem?.reader.assertNetwork();

    const { server, origin, serve } = await bindPort(settings.listen);
    const openStores = (lane: Readonly<{ dataDirectory: string; policy: Lane["policy"] }>) =>
      openDacsWalletSpendFileAuthorityStoresV1({
        directory: lane.dataDirectory, policy: lane.policy,
        authorityId: settings.authorityId, epoch: settings.epoch, seed: witnessSeed,
      });
    let x402Open: Lane | undefined;
    let payDemOpen: Lane | undefined;
    const closeStores = () => Promise.all([x402Open?.stores.close(), payDemOpen?.stores.close()]);
    try {
      if (x402 !== undefined) x402Open = x402Lane(await openStores(x402.settings), x402.settings.policy, x402.reader);
      if (payDem !== undefined) {
        const stores = await openStores(payDem.settings);
        // Opened inside the lane's data directory, beside `witness/` and `states/`; it outlives restarts.
        const evidenceStore = await openDacsWalletSpendDemEvidenceStoreV1(join(payDem.settings.dataDirectory, "transfers"))
          .catch(async (error: unknown) => { await stores.close(); throw error; });
        payDemOpen = payDemLane(stores, payDem.settings.policy, payDem.reader, evidenceStore);
      }
    } catch (error) {
      serve(new Error("wallet-spend-testnet-authority-stores-unavailable"));
      await closeServer(server, 0);
      await closeStores();
      throw error;
    }
    serve(composeHandler({
      settings, tokenDigest, lanes: [x402Open, payDemOpen].filter((lane) => lane !== undefined),
    }));

    let stopped: Promise<void> | undefined;
    const stop = async (): Promise<void> => {
      await closeServer(server, STOP_GRACE_MS);
      await closeStores();
    };
    return Object.freeze({
      url: `${origin}/`,
      authorityId: settings.authorityId,
      epoch: settings.epoch,
      // The settings check that the seed derives this key, and every lane's stores sign with that seed.
      witnessVerificationKey: settings.witnessVerificationKey,
      ...(x402Open === undefined ? {} : {
        lineageKey: x402Open.stores.lineageKey, policyHash: x402Open.stores.policyHash,
      }),
      ...(payDemOpen === undefined ? {} : {
        payDem: Object.freeze({ lineageKey: payDemOpen.stores.lineageKey, policyHash: payDemOpen.stores.policyHash }),
      }),
      stop: () => (stopped ??= stop()),
    });
  } catch (error) {
    throw startRefusal(error);
  } finally {
    loaded?.witnessSeed.fill(0);
  }
}

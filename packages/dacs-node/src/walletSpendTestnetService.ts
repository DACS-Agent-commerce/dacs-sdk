import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { canonicalWalletSpendWalletV1 } from "@kynesyslabs/dacs";

import { createDacsWalletSpendEvmReaderV1, type DacsWalletSpendEvmReaderV1 } from "./walletSpendEvmReader.js";
import {
  openDacsWalletSpendFileAuthorityStoresV1,
  type DacsWalletSpendFileAuthorityStoresV1,
} from "./walletSpendFileAuthorityStores.js";
import { createDacsWalletSpendContinuityAuthorityV2 } from "./walletSpendPostgres.js";
import {
  createDacsWalletSpendAuthorityServiceV2,
  createInMemoryDacsWalletSpendRemoteOperationStoreV1,
} from "./walletSpendRemote.js";
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
  readonly lineageKey: string;
  readonly policyHash: string;
  /** Stops accepting, waits up to 5 s for running requests, then closes the stores. */
  stop(): Promise<void>;
}

type Handler = (request: Request) => Promise<Response>;
type Settings = Readonly<DacsWalletSpendTestnetAuthoritySettingsV1>;

const BUYER_ROLE = "buyer";
const OWNER = "dacs-wallet-spend-testnet-authority";
/** One stuck hold retried every 5 s until its bound validBefore (at most a day) passes fits with room. */
const MAXIMUM_OPERATIONS_PER_ROLE = 50_000;
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

/** Builds the per-request handler over the open stores. */
function composeHandler({ settings, tokenDigest, stores, reader }: Readonly<{
  settings: Settings;
  tokenDigest: Uint8Array;
  stores: Readonly<DacsWalletSpendFileAuthorityStoresV1>;
  reader: Readonly<DacsWalletSpendEvmReaderV1>;
}>): Handler {
  const { policy } = settings;
  const recovery = createDacsWalletSpendTestnetRecoveryV1({
    policy,
    reader,
    report: (line) => process.stderr.write(`${JSON.stringify(line)}\n`),
  });
  return createDacsWalletSpendAuthorityServiceV2({
    authenticate(token) {
      const presented = createHash("sha256").update(token, "utf8").digest();
      return timingSafeEqual(presented, tokenDigest) ? BUYER_ROLE : null;
    },
    resolveAuthority(scope) {
      if (scope.roleId !== BUYER_ROLE || scope.authorityId !== settings.authorityId ||
          scope.epoch !== settings.epoch || scope.lineageKey !== stores.lineageKey ||
          scope.policyHash !== settings.policyHash || scope.chainId !== policy.chainId ||
          canonicalWalletSpendWalletV1(scope.wallet) !== policy.wallet) {
        return null;
      }
      const { roleId, operationId, requestHash } = scope;
      return createDacsWalletSpendContinuityAuthorityV2({
        policy,
        store: stores.stateStore({ roleId, operationId, requestHash }),
        dependencies: {
          readBalance: reader.readBalance,
          authenticateRecovery: recovery.authenticateRecovery,
          bindAuthorizationValidBefore: recovery.bindAuthorizationValidBefore,
          owner: OWNER,
        },
      });
    },
    operations: createInMemoryDacsWalletSpendRemoteOperationStoreV1({
      maximumOperationsPerRole: MAXIMUM_OPERATIONS_PER_ROLE,
      maximumOperations: MAXIMUM_OPERATIONS_PER_ROLE + 1,
    }),
  });
}

/**
 * Starts the testnet wallet-spend authority: it checks the settings and the RPC's
 * chain, binds the loopback port before it opens the data directory, and serves
 * only the V2 operation routes. Requests that arrive before the stores are open
 * wait for them.
 *
 * @param input.environment The settings source; `process.env` when omitted.
 * @returns The running authority and its public identity.
 * @throws DacsWalletSpendTestnetAuthorityError naming the refusal, for example
 *   `wallet-spend-testnet-authority-listen-failed` when the port is taken.
 */
export async function startDacsWalletSpendTestnetAuthorityV1(input: Readonly<{
  environment?: Readonly<Record<string, string | undefined>>;
}> = {}): Promise<Readonly<DacsWalletSpendTestnetAuthorityV1>> {
  let loaded: Awaited<ReturnType<typeof loadDacsWalletSpendTestnetAuthoritySettingsV1>> | undefined;
  try {
    loaded = await loadDacsWalletSpendTestnetAuthoritySettingsV1(input.environment ?? process.env);
    const { settings, tokenDigest, witnessSeed } = loaded;
    const reader = createDacsWalletSpendEvmReaderV1({
      rpcUrl: settings.evmRpcUrl, policy: settings.policy,
      authorizationSearchFromBlock: settings.authorizationSearchFromBlock,
    });
    await reader.assertChain();

    const { server, origin, serve } = await bindPort(settings.listen);
    let stores: Readonly<DacsWalletSpendFileAuthorityStoresV1>;
    try {
      stores = await openDacsWalletSpendFileAuthorityStoresV1({
        directory: settings.dataDirectory, policy: settings.policy,
        authorityId: settings.authorityId, epoch: settings.epoch, seed: witnessSeed,
      });
    } catch (error) {
      serve(new Error("wallet-spend-testnet-authority-stores-unavailable"));
      await closeServer(server, 0);
      throw error;
    }
    serve(composeHandler({ settings, tokenDigest, stores, reader }));

    let stopped: Promise<void> | undefined;
    const stop = async (): Promise<void> => {
      await closeServer(server, STOP_GRACE_MS);
      await stores.close();
    };
    return Object.freeze({
      url: `${origin}/`,
      authorityId: settings.authorityId,
      epoch: settings.epoch,
      witnessVerificationKey: stores.verificationKey,
      lineageKey: stores.lineageKey,
      policyHash: stores.policyHash,
      stop: () => (stopped ??= stop()),
    });
  } catch (error) {
    throw startRefusal(error);
  } finally {
    loaded?.witnessSeed.fill(0);
  }
}

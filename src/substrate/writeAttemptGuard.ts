/**
 * A per-attempt write guard for one connected demosdk wallet.
 *
 * `installWriteAttemptGuard(demos, guard)` makes that `Demos` instance call `guard()` immediately before each
 * signature and before each POST attempt of a write, after every preparation await of the demosdk call that
 * makes it, retries included. A stop marker that appears while a call waits therefore stops its next attempt.
 *
 * The signature boundary is the wallet's own `crypto.sign`. The POST boundary is the Axios adapter call: a
 * request interceptor on demosdk's own Axios copy replaces the adapter of a guarded write request with a
 * closure that checks the guard and then calls the adapter Axios selected, in the same synchronous stack.
 * An `AsyncLocalStorage` context ties each request to the guarded instance that made it, so other instances
 * and unsigned reads are not touched.
 *
 * Only ed25519 wallets are supported: demosdk's ed25519 signer signs synchronously, while its Falcon and
 * ML-DSA signers await internally after the boundary, where no check can follow.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Demos } from "@kynesyslabs/demosdk/websdk";

/** The demosdk and Axios versions whose call paths this guard was reviewed against. */
const REVIEWED_DEMOSDK_VERSION = "4.0.17";
const REVIEWED_AXIOS_VERSION = "1.17.0";
const SUPPORTED_ALGORITHM = "ed25519";
/** Axios 1.17.0's stock adapter selection; any other non-function selection is refused at install. */
const STOCK_ADAPTER_SELECTION = ["xhr", "http", "fetch"];
/** The only `call`/`_doPost` request method demosdk sends unsigned; every other method is a write here. */
const UNSIGNED_READ_METHOD = "nodeCall";
/** Instance methods that sign, send or retry a write; each is wrapped to carry the attempt context. */
const CONTEXT_METHODS = ["sign", "signMessage", "call", "rpcCall", "confirm", "broadcast", "broadcastAndWait"];
/** Deprecated raw-key signers that never reach the instance's signer, so no late check can cover them. */
const RAW_KEY_SIGNERS = ["sign", "signWithAlgorithm"];
const RAW_KEY_ALIAS_FACADES = ["transactions", "DemosTransactions"];

/** The stable codes of {@link WriteAttemptInstallError}. */
export type WriteAttemptInstallCode = "write_attempt_install_invalid" | "write_attempt_already_installed" | "write_attempt_surface_missing";
/** The stable codes of {@link WriteAttemptRefusedError}. */
export type WriteAttemptRefusalCode = "write_attempt_refused" | "write_attempt_unsupported_signer";

/** Thrown at an attempt when the guard returned something other than `undefined`, or the attempt cannot be guarded. */
export class WriteAttemptRefusedError extends Error {
  override readonly name = "WriteAttemptRefusedError";
  readonly code: WriteAttemptRefusalCode = "write_attempt_refused";

  /** Builds a refusal with code `write_attempt_refused`; `cause` is kept as the standard Error cause. */
  constructor(options: { cause?: unknown } = {}) {
    super("the write attempt was refused by the installed guard", "cause" in options ? { cause: options.cause } : undefined);
  }
}

/** The refusal of a signer this guard cannot cover: another algorithm, or a deprecated raw-key alias. */
class UnsupportedSignerError extends WriteAttemptRefusedError {
  override readonly code = "write_attempt_unsupported_signer";

  constructor() {
    super();
    this.message = "only the connected ed25519 signer of a guarded instance may sign";
  }
}

/** Thrown by {@link installWriteAttemptGuard} before it changes anything. */
export class WriteAttemptInstallError extends Error {
  override readonly name = "WriteAttemptInstallError";

  constructor(readonly code: WriteAttemptInstallCode, message: string) {
    super(message);
  }
}

/** Raised into Axios and demosdk instead of the guard's own value: it has no `code` or `response`, so no retry follows. */
class AttemptRefusalSignal extends Error {}

type Method = (...args: unknown[]) => unknown;
interface AxiosConfig { adapter?: unknown }
type Adapter = (config: AxiosConfig) => unknown;
interface DemosAxios {
  defaults: { adapter?: unknown; transitional?: { legacyInterceptorReqResOrdering?: unknown } };
  interceptors: { request: { handlers?: unknown; use(fulfilled: (config: AxiosConfig) => AxiosConfig, rejected: undefined, options: { synchronous: boolean }): number } };
  getAdapter(selection: unknown, config: AxiosConfig): Adapter;
}
interface GuardedWallet { readonly instance: object; readonly guard: Method }
interface AttemptScope { readonly wallet: GuardedWallet; refusal?: { readonly value: unknown } }
interface AttemptContext { readonly scope: AttemptScope; readonly writePost: boolean }

const attemptContext = new AsyncLocalStorage<AttemptContext>();
const installedInstances = new WeakSet<object>();
const readManifest = (path: string): { name?: unknown; version?: unknown } => JSON.parse(readFileSync(path, "utf8"));
const demosAxios = await loadDemosAxios();

/** Loads the Axios ESM module demosdk itself imports, or says why the installed versions are not the reviewed ones. */
async function loadDemosAxios(): Promise<{ axios: DemosAxios } | { problem: string }> {
  try {
    const websdkEntry = createRequire(import.meta.url).resolve("@kynesyslabs/demosdk/websdk");
    const demosdk = readManifest(join(dirname(websdkEntry), "..", "..", "package.json"));
    if (demosdk.name !== "@kynesyslabs/demosdk" || demosdk.version !== REVIEWED_DEMOSDK_VERSION) {
      return { problem: `demosdk ${String(demosdk.version)} is installed; the guard supports ${REVIEWED_DEMOSDK_VERSION}` };
    }
    const axiosManifestPath = createRequire(websdkEntry).resolve("axios/package.json");
    const axiosVersion = readManifest(axiosManifestPath).version;
    if (axiosVersion !== REVIEWED_AXIOS_VERSION) {
      return { problem: `demosdk resolves Axios ${String(axiosVersion)}; the guard supports ${REVIEWED_AXIOS_VERSION}` };
    }
    // Axios 1.17.0 maps both its `node` and default ESM conditions to index.js, the module demosdk imports.
    const module: { default: DemosAxios } = await import(pathToFileURL(join(dirname(axiosManifestPath), "index.js")).href);
    return { axios: module.default };
  } catch (error) {
    return { problem: `demosdk or its Axios copy cannot be read: ${String(error)}` };
  }
}

const invalid = (message: string) => new WriteAttemptInstallError("write_attempt_install_invalid", message);

/** The scope of the current call on this wallet, or a new one: nested calls share one refusal. */
function scopeFor(wallet: GuardedWallet): AttemptScope {
  const current = attemptContext.getStore();
  return current?.scope.wallet === wallet ? current.scope : { wallet };
}

/** Runs `run` in the wallet's scope and, once it settles, rethrows a refusal any attempt inside it recorded. */
function runInScope(wallet: GuardedWallet, writePost: boolean, run: (scope: AttemptScope) => unknown): Promise<unknown> {
  const scope = scopeFor(wallet);
  return attemptContext.run({ scope, writePost }, async () => {
    let result: unknown;
    try {
      result = await run(scope);
    } catch (error) {
      if (scope.refusal) throw scope.refusal.value;
      throw error;
    }
    if (scope.refusal) throw scope.refusal.value;
    return result;
  });
}

function refuse(scope: AttemptScope, value: unknown): unknown {
  scope.refusal = { value };
  return value;
}

/** Calls the guard for one attempt. Throws the stored refusal without calling the guard again once one is recorded. */
function checkAttempt(scope: AttemptScope, signerAlgorithm: unknown = SUPPORTED_ALGORITHM): void {
  if (scope.refusal) throw scope.refusal.value;
  if (signerAlgorithm !== SUPPORTED_ALGORITHM || Reflect.get(scope.wallet.instance, "algorithm") !== SUPPORTED_ALGORITHM) {
    throw refuse(scope, new UnsupportedSignerError());
  }
  let verdict: unknown;
  try {
    verdict = scope.wallet.guard();
  } catch (thrown) {
    throw refuse(scope, thrown);
  }
  if (verdict !== undefined) throw refuse(scope, new WriteAttemptRefusedError());
}

/** The adapter boundary: a refusal becomes a signal with nothing demosdk's retry loop would retry on. */
function checkBeforeAdapter(scope: AttemptScope): void {
  try {
    checkAttempt(scope);
  } catch {
    throw new AttemptRefusalSignal("write attempt refused");
  }
}

/** Swaps a guarded write request's adapter for one that checks the guard first; other requests pass unchanged. */
function guardWritePost(axios: DemosAxios, config: AxiosConfig): AxiosConfig {
  const context = attemptContext.getStore();
  if (!context?.writePost) return config;
  const selection = config.adapter || axios.defaults.adapter;
  const { scope } = context;
  config.adapter = (requestConfig: AxiosConfig) => {
    checkBeforeAdapter(scope);
    return axios.getAdapter(selection, requestConfig)(requestConfig);
  };
  return config;
}

/** The one process-wide interceptor, registered by the first successful install and never removed. */
let registeredInterceptor: ((config: AxiosConfig) => AxiosConfig) | undefined;

const isRegisteredInterceptor = (entry: unknown) => typeof entry === "object" && entry !== null && Reflect.get(entry, "fulfilled") === registeredInterceptor;

/** Refuses an Axios whose request ordering or adapter layout would let the guarded adapter be replaced or skipped. */
function assertAxiosLayout(axios: DemosAxios): void {
  const handlers = axios.interceptors.request.handlers;
  const adapter = axios.defaults.adapter;
  const stockAdapter = Array.isArray(adapter) && adapter.length === STOCK_ADAPTER_SELECTION.length && adapter.every((name, index) => name === STOCK_ADAPTER_SELECTION[index]);
  if (axios.defaults.transitional?.legacyInterceptorReqResOrdering !== true || !Array.isArray(handlers) || typeof axios.getAdapter !== "function") {
    throw invalid("demosdk's Axios does not run request interceptors in the reviewed order");
  }
  if (typeof adapter !== "function" && !stockAdapter) throw invalid("demosdk's Axios adapter is not the stock selection or a function");
  // Axios runs earlier-registered request interceptors after later ones, so one registered before the guard's
  // interceptor would run after it and could replace the guarded adapter.
  const guardIndex = registeredInterceptor ? handlers.findIndex(isRegisteredInterceptor) : handlers.length;
  if (guardIndex < 0 || handlers.slice(0, guardIndex).some((entry: unknown) => entry !== null)) {
    throw invalid("a request interceptor registered before the guard's could replace its adapter");
  }
}

function registerInterceptor(axios: DemosAxios): void {
  if (registeredInterceptor) return;
  registeredInterceptor = (config) => guardWritePost(axios, config);
  axios.interceptors.request.use(registeredInterceptor, undefined, { synchronous: true });
}

interface SlotPatch { readonly target: object; readonly key: string; readonly value: unknown }

/** The method `key` of `target`, bound to `target`. */
function boundMethod(target: object, key: string): Method {
  const value = Reflect.get(target, key);
  if (typeof value !== "function") throw new WriteAttemptInstallError("write_attempt_surface_missing", `demosdk method ${key} was not found on the instance`);
  return (...args: unknown[]) => Reflect.apply(value, target, args);
}

function objectAt(target: object, key: string): object {
  const value = Reflect.get(target, key);
  if (typeof value !== "object" || value === null) throw new WriteAttemptInstallError("write_attempt_surface_missing", `demosdk ${key} was not found on the instance`);
  return value;
}

const refuseRawKeySigner = () => Promise.reject(new UnsupportedSignerError());

/** Every property the guard defines, built only after the whole surface is found. Originals stay in closures. */
function plannedPatches(instance: object, wallet: GuardedWallet): SlotPatch[] {
  const patches: SlotPatch[] = CONTEXT_METHODS.map((key) => {
    const original = boundMethod(instance, key);
    return { target: instance, key, value: (...args: unknown[]) => runInScope(wallet, false, () => original(...args)) };
  });
  const doPost = boundMethod(instance, "_doPost");
  patches.push({
    target: instance,
    key: "_doPost",
    value: (...args: unknown[]) => {
      const request = args[1];
      const method = typeof request === "object" && request !== null ? Reflect.get(request, "method") : undefined;
      return runInScope(wallet, method !== UNSIGNED_READ_METHOD, (scope) => {
        if (typeof method !== "string" || method === "") throw refuse(scope, new WriteAttemptRefusedError());
        return doPost(...args);
      });
    },
  });
  const crypto = objectAt(instance, "crypto");
  const cryptoSign = boundMethod(crypto, "sign");
  patches.push({
    target: crypto,
    key: "sign",
    value: (algorithm: unknown, data: unknown) =>
      runInScope(wallet, false, (scope) => {
        checkAttempt(scope, algorithm);
        return cryptoSign(algorithm, data);
      }),
  });
  // `tx.sign` delegates to the wrapped `instance.sign`; `tx` is the instance's own copy of the shared object.
  const tx = objectAt(instance, "tx");
  boundMethod(tx, "sign");
  boundMethod(tx, "signWithAlgorithm");
  patches.push({ target: tx, key: "signWithAlgorithm", value: refuseRawKeySigner });
  // These aliases point at demosdk's shared object, so the instance gets its own copy instead.
  for (const key of RAW_KEY_ALIAS_FACADES) {
    const shared = objectAt(instance, key);
    for (const signer of RAW_KEY_SIGNERS) boundMethod(shared, signer);
    patches.push({ target: instance, key, value: { ...shared, sign: refuseRawKeySigner, signWithAlgorithm: refuseRawKeySigner } });
  }
  return patches;
}

function definedOrFalse(patch: SlotPatch, previous: PropertyDescriptor | undefined): boolean {
  try {
    return Reflect.defineProperty(patch.target, patch.key, { value: patch.value, writable: true, enumerable: previous?.enumerable ?? false, configurable: true });
  } catch {
    return false;
  }
}

/** Defines every patch, or restores each changed property's exact descriptor and throws. */
function applyPatches(patches: SlotPatch[]): void {
  const applied: Array<{ patch: SlotPatch; previous: PropertyDescriptor | undefined }> = [];
  for (const patch of patches) {
    const previous = Reflect.getOwnPropertyDescriptor(patch.target, patch.key);
    if (!definedOrFalse(patch, previous)) {
      for (const done of applied.reverse()) {
        if (done.previous) Reflect.defineProperty(done.patch.target, done.patch.key, done.previous);
        else Reflect.deleteProperty(done.patch.target, done.patch.key);
      }
      throw invalid(`demosdk property ${patch.key} cannot be replaced`);
    }
    applied.push({ patch, previous });
  }
}

/**
 * Installs `guard` on one connected ed25519 `Demos` instance. From then on the instance calls `guard()` right
 * before each signature and each POST attempt of a write, retries included. Only an `undefined` return passes.
 * A thrown value stops the attempt and reaches the caller of the demosdk method unchanged, even through
 * demosdk's `{ result: 500 }` envelopes; any other return value stops it with {@link WriteAttemptRefusedError}.
 * After a refusal the same call makes no further attempt and does not call the guard again. Unsigned reads
 * (`nodeCall`) and other instances are untouched. The deprecated raw-key signers `tx.signWithAlgorithm`,
 * `transactions.sign`/`signWithAlgorithm` and `DemosTransactions.sign`/`signWithAlgorithm` refuse with code
 * `write_attempt_unsupported_signer`. There is no uninstall.
 *
 * @throws {WriteAttemptInstallError} before changing anything: `write_attempt_already_installed` for a second
 *   install on the instance; `write_attempt_surface_missing` when a demosdk method or object is not found;
 *   `write_attempt_install_invalid` for a non-`Demos` value, a disconnected or non-ed25519 wallet, a guard that is
 *   not a function, a demosdk other than 4.0.17 or a demosdk-resolved Axios other than 1.17.0, an Axios layout
 *   the guard cannot hold, or a property that cannot be replaced.
 */
export function installWriteAttemptGuard(instance: Demos, guard: () => void): void {
  if (!(instance instanceof Demos)) throw invalid("the guard installs only on a demosdk Demos instance");
  if (installedInstances.has(instance)) throw new WriteAttemptInstallError("write_attempt_already_installed", "a guard is already installed on this instance");
  if (instance.walletConnected !== true) throw invalid("the instance has no connected wallet");
  if (instance.algorithm !== SUPPORTED_ALGORITHM) throw invalid(`the guard supports only ${SUPPORTED_ALGORITHM} wallets`);
  if (typeof guard !== "function") throw invalid("the guard must be a function");
  if ("problem" in demosAxios) throw invalid(demosAxios.problem);
  assertAxiosLayout(demosAxios.axios);
  applyPatches(plannedPatches(instance, { instance, guard }));
  registerInterceptor(demosAxios.axios);
  installedInstances.add(instance);
}

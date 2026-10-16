import { VERSION } from "../version.js";
import { PAY_D402_AVAILABILITY } from "../rails/index.js";
import { readFileSync } from "node:fs";
import type { DoctorSecretFile } from "./secretFile.js";
import { demosHttpClient, type DemosHttpClient } from "./demosHttp.js";

export type DoctorStatus = "pass" | "warn" | "fail" | "skip" | "blocked";
export type DoctorMode = "offline" | "read-only";

export interface DoctorCheck {
  id: string;
  status: DoctorStatus;
  summary: string;
  detail?: string;
  remediation?: string;
  data?: Record<string, unknown>;
}

export interface DoctorReport {
  tool: "dacs-doctor";
  sdkVersion: string;
  generatedAt: string;
  mode: DoctorMode;
  checks: DoctorCheck[];
  exitCode: number;
}

/**
 * Doctor gives each RPC call `RPC_CALL_TIMEOUT_MS` and aborts its `signal` when
 * that passes; an adapter should cancel the request then, or its socket outlives
 * the report.
 */
export interface DoctorAdapter {
  connect(signal?: AbortSignal): Promise<void>;
  getAddress(): string;
  /**
   * Read-only Demos node call. Without it doctor cannot tell a Demos RPC from
   * any endpoint that answers HTTP GET, so `rpc.reachable` reports `warn`.
   */
  getLastBlockNumber?(signal?: AbortSignal): Promise<unknown>;
  /**
   * Read-only Demos `getNetworkInfo` node call. Its `nodeVersion` build
   * revision is compared with the node revision this SDK was verified against.
   */
  getNetworkInfo?(signal?: AbortSignal): Promise<unknown>;
}

export interface DoctorOptions {
  json?: boolean;
  offline?: boolean;
  rpc?: string;
  walletSecret?: string;
  rail?: string;
  now?: () => Date;
  nodeVersion?: string;
  adapterFactory?: (config: { rpc: string; secret?: string }) => DoctorAdapter;
}

const RUNTIME_NODE = "runtime.node";
const RPC_REACHABLE = "rpc.reachable";
const RPC_NODE_REVISION = "rpc.node-revision";
const SUBSTRATE_ADAPTER_LOAD = "substrate.adapter-load";
const SUPPORTED_NODE_RANGE_FALLBACK = "^20.19.0 || >=22.12.0";
/**
 * kynesyslabs/node commit whose getLastBlockNumber handler the RPC check was
 * verified against; node2 reported this build in getNetworkInfo on 2026-10-15.
 * Update it only after re-verifying that handler at the new commit.
 */
export const VERIFIED_DEMOS_NODE_REVISION = "61b8e75aa8db5e408c49e1c3a89db4d673f45578";
/**
 * `name` and `version` of kynesyslabs/node's package.json at that revision. The
 * node reports them independently of the commit, so both must match too.
 */
export const VERIFIED_DEMOS_NODE_PACKAGE = { name: "demos-node-software", version: "0.9.8" } as const;

function check(
  id: string,
  status: DoctorStatus,
  summary: string,
  extra: Omit<DoctorCheck, "id" | "status" | "summary"> = {},
): DoctorCheck {
  return { id, status, summary, ...extra };
}

function parseNodeVersion(version: string): { major: number; minor: number; patch: number } | null {
  const match = version.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return match
    ? {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
      }
    : null;
}

function supportsNode(version: string): boolean {
  const parsed = parseNodeVersion(version);
  if (!parsed) return false;
  if (parsed.major === 20) {
    return parsed.minor > 19 || (parsed.minor === 19 && parsed.patch >= 0);
  }
  if (parsed.major === 22) {
    return parsed.minor > 12 || (parsed.minor === 12 && parsed.patch >= 0);
  }
  return parsed.major > 22;
}

interface PackageMetadata {
  engines?: {
    node?: unknown;
  };
  type?: unknown;
  version?: unknown;
}

function packageMetadata(): PackageMetadata | null {
  try {
    const raw = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    return JSON.parse(raw) as PackageMetadata;
  } catch {
    return null;
  }
}

function packageType(pkg: PackageMetadata | null): string | null {
  return typeof pkg?.type === "string" ? pkg.type : null;
}

function supportedNodeRange(pkg: PackageMetadata | null): string {
  return typeof pkg?.engines?.node === "string" ? pkg.engines.node : SUPPORTED_NODE_RANGE_FALLBACK;
}

export function redactSecret(secret: string): string {
  return secret ? "[redacted]" : "";
}

export function redactRpcUrl(rpc: string): string {
  try {
    const url = new URL(rpc);
    const pathname = url.pathname && url.pathname !== "/" ? "/[redacted]" : url.pathname;
    return `${url.protocol}//${url.host}${pathname}${url.search ? "?[redacted]" : ""}${
      url.hash ? "#[redacted]" : ""
    }`;
  } catch {
    return "[redacted-invalid-rpc-url]";
  }
}

export function sanitizeText(raw: string, secrets: Array<string | undefined> = []): string {
  let out = raw;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[redacted]");
  }
  return out;
}

export function rpcSensitiveNeedles(rpc?: string): string[] {
  if (!rpc) return [];
  const decoded = (value: string): string[] => {
    try {
      const out = decodeURIComponent(value);
      return out === value ? [value] : [value, out];
    } catch {
      return [value];
    }
  };
  try {
    const url = new URL(rpc);
    const searchParts = [...url.searchParams.entries()].flatMap(([key, value]) => [
      ...decoded(key),
      ...decoded(value),
    ]);
    return [
      rpc,
      url.username,
      url.password,
      ...url.pathname.split("/").filter((part) => part.length > 0).flatMap(decoded),
      url.search.startsWith("?") ? url.search.slice(1) : url.search,
      ...searchParts,
      url.hash.startsWith("#") ? url.hash.slice(1) : url.hash,
    ].flatMap(decoded).filter((part) => part.length > 0);
  } catch {
    return [rpc];
  }
}

function sanitizeError(err: unknown, secrets: Array<string | undefined> = []): string {
  const raw = err instanceof Error ? err.message : String(err);
  return sanitizeText(raw, secrets);
}

function exitCodeFor(checks: DoctorCheck[]): number {
  if (checks.some((c) => c.status === "fail" && c.id !== RPC_REACHABLE)) return 1;
  if (checks.some((c) => c.id === RPC_REACHABLE && c.status === "fail")) return 3;
  if (checks.some((c) => c.status === "blocked")) return 5;
  return 0;
}

/**
 * Send the unauthenticated request demosdk's `nodeCall` sends and resolve with
 * the node's `response` field, as it does, but cancellable.
 */
async function readOnlyNodeCall(
  http: DemosHttpClient, rpc: string, message: string, signal?: AbortSignal,
): Promise<unknown> {
  const { data } = await http.post(rpc, {
    method: "nodeCall",
    params: [{ type: "nodeCall", message, sender: null, receiver: null, timestamp: null, data: {}, extra: "" }],
  }, { headers: { "Content-Type": "application/json" }, signal });
  return typeof data === "object" && data !== null ? (data as { response?: unknown }).response : undefined;
}

async function defaultAdapterFactory(config: {
  rpc: string;
  secret?: string;
}): Promise<DoctorAdapter> {
  const { DemosAdapter } = await import("../substrate/index.js");
  // Doctor sends nothing through the adapter, so it derives the wallet locally
  // on the raw client and the adapter never holds the secret.
  const raw = new DemosAdapter({ rpc: config.rpc }).raw;
  // demosdk's connect() and nodeCall() set no timeout and take no signal, so
  // doctor sends the same read-only requests itself; a timed-out probe is then
  // aborted instead of holding a socket open after runDoctor() returns.
  const http = demosHttpClient();
  return {
    connect: async (signal) => {
      // demosdk's connect() is this GET, which must answer 2xx.
      await http.get(config.rpc, { signal });
      if (config.secret !== undefined) await raw.connectWallet(config.secret);
    },
    getAddress: () => raw.getAddress(),
    getLastBlockNumber: (signal) => readOnlyNodeCall(http, config.rpc, "getLastBlockNumber", signal),
    getNetworkInfo: (signal) => readOnlyNodeCall(http, config.rpc, "getNetworkInfo", signal),
  };
}

function isBlockHeight(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

// Demos nodes answer getLastBlockNumber with this while their state is loading.
const STATE_NOT_READY = "STATE_NOT_READY";

interface ReportedNodeBuild {
  name: string | null;
  commit: string | null;
  version: string | null;
  dirty: boolean | null;
}

/** Keep only well-formed build fields; the rest of the untrusted answer is dropped. */
function reportedNodeBuild(info: unknown): ReportedNodeBuild | null {
  const build = typeof info === "object" && info !== null
    ? (info as { nodeVersion?: unknown }).nodeVersion : undefined;
  if (typeof build !== "object" || build === null) return null;
  const { name, commit, version, dirty } = build as Record<string, unknown>;
  return {
    name: typeof name === "string" && /^[0-9a-z._-]{1,64}$/.test(name) ? name : null,
    commit: typeof commit === "string" && /^[0-9a-f]{40}$/.test(commit) ? commit : null,
    version: typeof version === "string" && /^[0-9A-Za-z.+-]{1,64}$/.test(version) ? version : null,
    dirty: typeof dirty === "boolean" ? dirty : null,
  };
}

/**
 * Stop waiting for any one RPC call after a bounded time rather than let a node
 * that is up but stalls a request hold the whole report.
 */
export const RPC_CALL_TIMEOUT_MS = 5_000;
const RPC_CALL_TIMED_OUT = Symbol("RPC call timed out");

/** Race `call` against the deadline, then abort its signal so a stalled request is cancelled. */
async function withDeadline<T>(call: (signal: AbortSignal) => Promise<T>): Promise<T | typeof RPC_CALL_TIMED_OUT> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      call(controller.signal),
      new Promise<typeof RPC_CALL_TIMED_OUT>((resolve) => {
        timer = setTimeout(resolve, RPC_CALL_TIMEOUT_MS, RPC_CALL_TIMED_OUT);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function timedOutDetail(call: string): string {
  return `${call} did not answer within ${RPC_CALL_TIMEOUT_MS} ms`;
}

async function nodeRevisionCheck(adapter: DoctorAdapter, pinned: string | null): Promise<DoctorCheck> {
  const remediation = "Compare the node's Demos build with the verified revision before relying on this doctor's RPC verdict.";
  const getNetworkInfo = adapter.getNetworkInfo?.bind(adapter);
  if (!getNetworkInfo) {
    return check(RPC_NODE_REVISION, "skip", "The adapter cannot read the node build revision");
  }
  let reported: ReportedNodeBuild | null = null;
  let timedOut = false;
  try {
    const answer = await withDeadline((signal) => getNetworkInfo(signal));
    if (answer === RPC_CALL_TIMED_OUT) timedOut = true;
    else reported = reportedNodeBuild(answer);
  } catch {
    // Untrusted transport failures are reported as an unknown build.
  }
  const data = { verified: pinned, reported };
  if (timedOut) {
    return check(RPC_NODE_REVISION, "warn", "Node did not report its build revision in time", {
      data, detail: timedOutDetail("getNetworkInfo"), remediation,
    });
  }
  if (!pinned || !reported?.commit) {
    return check(RPC_NODE_REVISION, "warn", "Node build revision could not be compared with the verified revision", {
      data, remediation,
    });
  }
  if (reported.commit !== pinned) {
    return check(RPC_NODE_REVISION, "warn", "Node reports a different build than the verified revision", {
      data, remediation,
    });
  }
  const { name, version } = VERIFIED_DEMOS_NODE_PACKAGE;
  if (reported.name !== name || reported.version !== version) {
    return check(RPC_NODE_REVISION, "warn", "Node reports the verified revision under another package name or version", {
      data, detail: `the verified build is ${name} ${version}`, remediation,
    });
  }
  if (reported.dirty === false) {
    return check(RPC_NODE_REVISION, "pass", "Node reports the verified build revision", { data });
  }
  return check(RPC_NODE_REVISION, "warn", reported.dirty
    ? "Node reports the verified revision with uncommitted changes"
    : "Node reports the verified revision but not whether its build is clean", { data, remediation });
}

const WINDOWS_CREDENTIAL_FILE_REMEDIATION =
  "Node reports Windows file modes as 0666 or 0444, so the Node host refuses live credential files there; " +
  "pass the credential through stdin (-) or an environment variable instead.";

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  return runDoctorForCli(options, []);
}

/** Internal CLI entry point; intentionally absent from public barrels. */
export async function runDoctorForCli(
  options: DoctorOptions,
  secretFiles: readonly DoctorSecretFile[],
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const generatedAt = (options.now?.() ?? new Date()).toISOString();
  const nodeVersion = options.nodeVersion ?? process.version;
  const nodeSupported = supportsNode(nodeVersion);
  const pkg = packageMetadata();
  const packageModuleType = packageType(pkg);
  const nodeRange = supportedNodeRange(pkg);

  checks.push(
    check(
      RUNTIME_NODE,
      nodeSupported ? "pass" : "fail",
      nodeSupported ? "Node runtime is supported" : "Node runtime is unsupported",
      {
        data: { version: nodeVersion, required: nodeRange },
        remediation:
          nodeSupported ? undefined : `Use Node ${nodeRange}.`,
      },
    ),
  );

  checks.push(
    packageModuleType === "module"
      ? check("runtime.module", "pass", "Package is configured for ESM", {
          data: { type: packageModuleType },
        })
      : check("runtime.module", "fail", "Package module configuration could not be verified", {
          data: { type: packageModuleType },
          remediation: "Install from a package that preserves package.json with type=module.",
        }),
  );

  const packageVersion = typeof pkg?.version === "string" ? pkg.version : null;
  checks.push(
    packageVersion === VERSION
      ? check("package.version", "pass", "SDK version matches the installed package", {
          data: { version: VERSION },
        })
      : check("package.version", "fail", "SDK version differs from the installed package", {
          data: { version: VERSION, packageVersion },
          remediation: "Reinstall the package so the compiled SDK and package.json versions agree.",
        }),
  );

  checks.push(
    options.walletSecret
      ? check("config.secrets", "pass", "Wallet secret was provided and redacted", {
          data: { walletSecret: redactSecret(options.walletSecret) },
        })
      : check("config.secrets", "skip", "No wallet secret provided"),
  );

  for (const file of secretFiles) {
    const prefix = `config.${file.source}-file`;
    checks.push(check(`${prefix}.symlink`, file.symlink ? "fail" : "pass",
      file.symlink ? "Credential file is a symbolic link" : "Credential file is not a symbolic link", {
        remediation: file.symlink ? "Use a regular credential file directly." : undefined,
      }));
    // Match the Node host's live secret-file policy on every platform, as the
    // host has no platform gate: exactly 0600, and the current UID where Node
    // reports one. Windows ACLs are not checked.
    const inspected = !file.symlink && file.mode !== undefined;
    const mode = (file.mode ?? 0) & 0o777;
    checks.push(inspected
      ? check(`${prefix}.mode`, mode === 0o600 ? "pass" : "fail",
          mode === 0o600 ? "Credential file mode is 0600" : "Credential file mode is unsafe", {
            data: { mode: mode.toString(8).padStart(4, "0") },
            remediation: mode === 0o600 ? undefined : file.platform === "win32"
              ? WINDOWS_CREDENTIAL_FILE_REMEDIATION
              : "Set the credential file mode to 0600.",
          })
      : check(`${prefix}.mode`, "skip", "Credential file mode check is unavailable because the file was not opened"));
    const ownerAvailable = !file.symlink && file.currentUid !== undefined && file.ownerUid !== undefined;
    const ownerMatches = file.ownerUid === file.currentUid;
    checks.push(ownerAvailable
      ? check(`${prefix}.owner`, ownerMatches ? "pass" : "fail",
          ownerMatches ? "Credential file belongs to the current user" : "Credential file owner differs from the current user", {
            data: { ownerUid: file.ownerUid, currentUid: file.currentUid },
            remediation: ownerMatches ? undefined : "Use a credential file owned by the current user.",
          })
      : check(`${prefix}.owner`, "skip", "Credential file owner check is unavailable"));
  }

  let adapter: DoctorAdapter | null = null;
  if (checks.some((c) => c.id.startsWith("config.") && c.status === "fail")) {
    checks.push(check(RPC_REACHABLE, "skip", "Credential file admission failed; RPC connection skipped"));
  } else if (options.offline) {
    checks.push(check(RPC_REACHABLE, "skip", "Offline mode skips RPC reachability"));
  } else if (!options.rpc) {
    checks.push(check(RPC_REACHABLE, "skip", "No RPC URL provided"));
  } else {
    let made: DoctorAdapter | null = null;
    try {
      made = options.adapterFactory
        ? options.adapterFactory({
            rpc: options.rpc,
            secret: options.walletSecret,
          })
        : await defaultAdapterFactory({
            rpc: options.rpc,
            secret: options.walletSecret,
          });
      checks.push(check(SUBSTRATE_ADAPTER_LOAD, "pass", "Demos adapter loaded"));
    } catch (err) {
      checks.push(
        check(SUBSTRATE_ADAPTER_LOAD, "fail", "Demos adapter could not be loaded", {
          detail: sanitizeError(err, [options.walletSecret, ...rpcSensitiveNeedles(options.rpc)]),
          remediation: "Check the installed demosdk package and ESM compatibility.",
        }),
      );
    }

    if (made) {
      const connectable = made;
      const needles = [options.walletSecret, ...rpcSensitiveNeedles(options.rpc)];
      const data = { rpc: redactRpcUrl(options.rpc) };
      let connected = false;
      let connectFailure: string | undefined;
      try {
        connected = await withDeadline((signal) => connectable.connect(signal)) !== RPC_CALL_TIMED_OUT;
        if (!connected) connectFailure = timedOutDetail("RPC endpoint");
      } catch (err) {
        connectFailure = sanitizeError(err, needles);
      }
      if (connectFailure !== undefined) {
        checks.push(
          check(RPC_REACHABLE, "fail", "Demos RPC check failed", {
            data,
            detail: connectFailure,
            remediation: "Check the RPC URL and network reachability.",
          }),
        );
      }
      // connect() only proves an HTTP GET succeeded; any web server passes that.
      const getLastBlockNumber = made.getLastBlockNumber?.bind(made);
      if (connected && !getLastBlockNumber) {
        adapter = made;
        checks.push(
          check(RPC_REACHABLE, "warn", "RPC endpoint answered; the adapter cannot confirm it is a Demos node", {
            data,
          }),
        );
      } else if (connected && getLastBlockNumber) {
        let height: unknown;
        let failure: string | undefined;
        try {
          height = await withDeadline((signal) => getLastBlockNumber(signal));
          if (height === RPC_CALL_TIMED_OUT) failure = timedOutDetail("getLastBlockNumber");
        } catch (err) {
          failure = sanitizeError(err, needles);
        }
        if (isBlockHeight(height)) {
          adapter = made;
          checks.push(
            check(RPC_REACHABLE, "pass", "Demos RPC is reachable and reports a block height", {
              data: { ...data, lastBlockNumber: height },
            }),
          );
          checks.push(await nodeRevisionCheck(made, VERIFIED_DEMOS_NODE_REVISION));
        } else if (height === STATE_NOT_READY) {
          checks.push(
            check(RPC_REACHABLE, "fail", "Demos node is not ready", {
              data,
              detail: "getLastBlockNumber answered STATE_NOT_READY",
              remediation: "Wait for the Demos node to finish loading its state, then retry.",
            }),
          );
        } else {
          // Never echo the response: it is untrusted and may carry the RPC URL.
          checks.push(
            check(RPC_REACHABLE, "fail", "RPC endpoint did not answer the Demos block-height call", {
              data,
              detail: failure ?? "getLastBlockNumber did not return a non-negative integer",
              remediation: "Check that the RPC URL points at a reachable Demos node.",
            }),
          );
        }
      }
    }
  }

  if (!options.walletSecret) {
    checks.push(check("wallet.identity", "skip", "No wallet secret provided"));
  } else if (options.offline) {
    checks.push(check("wallet.identity", "skip", "Offline mode skips wallet connection"));
  } else if (!adapter) {
    checks.push(
      check("wallet.identity", "skip", "Wallet identity skipped because the Demos RPC check did not pass"),
    );
  } else {
    checks.push(
      check("wallet.identity", "pass", "Wallet address derived from connected adapter", {
        data: { address: adapter.getAddress() },
      }),
    );
  }

  checks.push(
    check("wallet.balance", "blocked", "Wallet balance check is not wired yet", {
      remediation: "Add a stable demosdk balance API before making funding claims.",
    }),
  );
  checks.push(
    check("wallet.nonce", "blocked", "Wallet nonce check is not wired yet", {
      remediation: "Track dacs-sdk #58 and #57 for nonce-safe anchoring.",
    }),
  );
  checks.push(
    check(
      "storage.binding-resolution",
      "blocked",
      "Binding-aware StorageProgram resolution is not implemented yet",
      {
        remediation: "Track dacs-sdk #58 and DACS-Standard #242/#248.",
      },
    ),
  );
  checks.push(
    check("anchor.completion", "blocked", "Read-visible anchor completion is not implemented yet", {
      remediation: "Track dacs-sdk #57.",
    }),
  );

  if (!options.rail) {
    checks.push(check("rail.availability", "skip", "No rail selected"));
  } else if (options.rail === "pay-dem") {
    checks.push(
      check("rail.availability", "warn", "Native DEM rail is known; availability and funding were not checked", {
        data: { rail: options.rail, known: true },
      }),
    );
  } else if (options.rail === "pay-d402") {
    checks.push(
      check("rail.availability", "warn", "pay-d402 is experimental, not a supported live rail", {
        data: { availability: PAY_D402_AVAILABILITY },
        detail: "demosdk 4.0.17 and later sign and broadcast real d402_payment transactions, so a preview settlement can move real DEM.",
      }),
    );
  } else if (options.rail === "x402" || options.rail === "evm-erc20") {
    checks.push(
      check("rail.availability", "warn", "Rail requires external config to validate", {
        data: { rail: options.rail },
      }),
    );
  } else {
    checks.push(
      check("rail.availability", "fail", "Unknown rail selected", {
        data: { rail: options.rail },
        remediation: "Use pay-dem, x402, evm-erc20, or pay-d402.",
      }),
    );
  }

  checks.push(
    check("cost.estimate", "blocked", "Cost estimate needs fee and funding APIs", {
      remediation: "Track dacs-sdk #60 follow-up after #57/#58 land.",
    }),
  );

  return {
    tool: "dacs-doctor",
    sdkVersion: VERSION,
    generatedAt,
    mode: options.offline ? "offline" : "read-only",
    checks,
    exitCode: exitCodeFor(checks),
  };
}

export function formatDoctorText(report: DoctorReport): string {
  const lines = [
    "dacs doctor",
    `mode: ${report.mode}`,
    `sdk: ${report.sdkVersion}`,
    ...report.checks.flatMap((c) => [
      `${c.id}: ${c.status} - ${c.summary}`,
      ...(c.detail ? [`  detail: ${c.detail}`] : []),
      ...(c.remediation ? [`  remediation: ${c.remediation}`] : []),
    ]),
    `exit: ${report.exitCode}`,
  ];
  return `${lines.join("\n")}\n`;
}

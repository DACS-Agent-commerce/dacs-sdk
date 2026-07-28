import { VERSION } from "../version.js";
import { PAY_D402_AVAILABILITY } from "../rails/index.js";
import { readFileSync } from "node:fs";

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

export interface DoctorAdapter {
  connect(): Promise<void>;
  getAddress(): string;
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
const SUBSTRATE_ADAPTER_LOAD = "substrate.adapter-load";
const SUPPORTED_NODE_RANGE_FALLBACK = "^20.19.0 || >=22.12.0";

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

async function defaultAdapterFactory(config: {
  rpc: string;
  secret?: string;
}): Promise<DoctorAdapter> {
  const { DemosAdapter } = await import("../substrate/index.js");
  return new DemosAdapter(config);
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
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

  checks.push(
    check("package.version", "pass", "SDK version detected", {
      data: { version: VERSION },
    }),
  );

  checks.push(
    options.walletSecret
      ? check("config.secrets", "pass", "Wallet secret was provided and redacted", {
          data: { walletSecret: redactSecret(options.walletSecret) },
        })
      : check("config.secrets", "skip", "No wallet secret provided"),
  );

  let adapter: DoctorAdapter | null = null;
  if (options.offline) {
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
      try {
        await made.connect();
        adapter = made;
        checks.push(
          check(RPC_REACHABLE, "pass", "Demos RPC is reachable", {
            data: { rpc: redactRpcUrl(options.rpc) },
          }),
        );
      } catch (err) {
        checks.push(
          check(RPC_REACHABLE, "fail", "Demos RPC check failed", {
            detail: sanitizeError(err, [options.walletSecret, ...rpcSensitiveNeedles(options.rpc)]),
            remediation: "Check the RPC URL and network reachability.",
          }),
        );
      }
    }
  }

  if (!options.walletSecret) {
    checks.push(check("wallet.identity", "skip", "No wallet secret provided"));
  } else if (options.offline) {
    checks.push(check("wallet.identity", "skip", "Offline mode skips wallet connection"));
  } else if (!adapter) {
    checks.push(
      check("wallet.identity", "skip", "Wallet identity skipped because RPC did not connect"),
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
  } else if (options.rail === "pay-d402") {
    checks.push(
      check("rail.availability", "warn", "pay-d402 is experimental, not live", {
        data: { availability: PAY_D402_AVAILABILITY },
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
        remediation: "Use x402, evm-erc20, or pay-d402.",
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

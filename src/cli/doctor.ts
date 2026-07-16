import { VERSION } from "../version.js";
import { PAY_D402_AVAILABILITY } from "../rails/index.js";

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

function check(
  id: string,
  status: DoctorStatus,
  summary: string,
  extra: Omit<DoctorCheck, "id" | "status" | "summary"> = {},
): DoctorCheck {
  return { id, status, summary, ...extra };
}

function parseNodeMajor(version: string): number | null {
  const match = version.match(/^v?(\d+)\./);
  return match ? Number(match[1]) : null;
}

export function redactSecret(secret: string): string {
  if (secret.length <= 8) return "[redacted]";
  return `${secret.slice(0, 4)}...[redacted]...${secret.slice(-4)}`;
}

function sanitizeError(err: unknown, secret?: string): string {
  const raw = err instanceof Error ? err.message : String(err);
  return secret ? raw.split(secret).join("[redacted]") : raw;
}

function exitCodeFor(checks: DoctorCheck[]): number {
  if (checks.some((c) => c.id === RPC_REACHABLE && c.status === "fail")) {
    return 3;
  }
  if (checks.some((c) => c.status === "fail")) return 1;
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
  const nodeMajor = parseNodeMajor(nodeVersion);

  checks.push(
    check(
      RUNTIME_NODE,
      nodeMajor != null && nodeMajor >= 20 ? "pass" : "fail",
      nodeMajor != null && nodeMajor >= 20
        ? "Node runtime is supported"
        : "Node runtime is unsupported",
      {
        data: { version: nodeVersion, required: ">=20" },
        remediation:
          nodeMajor != null && nodeMajor >= 20
            ? undefined
            : "Use Node 20 or newer.",
      },
    ),
  );

  checks.push(
    check("runtime.module", "pass", "Package is configured for ESM", {
      data: { type: "module" },
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
    try {
      const made = options.adapterFactory
        ? options.adapterFactory({
            rpc: options.rpc,
            secret: options.walletSecret,
          })
        : await defaultAdapterFactory({
            rpc: options.rpc,
            secret: options.walletSecret,
          });
      adapter = made;
      await adapter.connect();
      checks.push(
        check(RPC_REACHABLE, "pass", "Demos RPC is reachable", {
          data: { rpc: options.rpc },
        }),
      );
    } catch (err) {
      checks.push(
        check(RPC_REACHABLE, "fail", "Demos RPC check failed", {
          detail: sanitizeError(err, options.walletSecret),
          remediation: "Check the RPC URL and network reachability.",
        }),
      );
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
    ...report.checks.map((c) => `${c.id}: ${c.status} - ${c.summary}`),
    `exit: ${report.exitCode}`,
  ];
  return `${lines.join("\n")}\n`;
}

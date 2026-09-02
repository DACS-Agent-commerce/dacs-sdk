import {
  runDacsLiveDoctorV1,
  type DacsLiveDoctorOptionsV1,
  type DacsLiveDoctorReportV1,
} from "./doctor.js";
import type {
  DacsRoleReadinessLatchSignerV1,
  DacsRoleReadinessLatchV1,
} from "./readiness.js";
import type { DacsLiveRoleServiceV1 } from "./service.js";

export type DacsRoleServiceShutdownReasonV1 = "SIGINT" | "SIGTERM" | "manual";

export interface DacsRoleServiceShutdownResultV1 {
  reason: DacsRoleServiceShutdownReasonV1;
  status: "stopped" | "failed";
  reasonCode?: "service-stop-failed";
}

export interface DacsProcessSignalTargetV1 {
  on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface DacsRoleServiceProcessHooksV1 {
  shutdown(
    reason?: DacsRoleServiceShutdownReasonV1,
  ): Promise<Readonly<DacsRoleServiceShutdownResultV1>>;
  waitForShutdown(): Promise<Readonly<DacsRoleServiceShutdownResultV1>>;
  dispose(): void;
}

export interface DacsRoleReadinessSupervisorActorV1 {
  role: "buyer" | "seller";
  latch: Readonly<DacsRoleReadinessLatchV1>;
  sign: DacsRoleReadinessLatchSignerV1;
}

export type DacsRoleReadinessEstablishmentResultV1 = Readonly<
  | {
      status: "ready";
      prerequisiteReport: Readonly<DacsLiveDoctorReportV1>;
      report: Readonly<DacsLiveDoctorReportV1>;
    }
  | {
      status: "not-ready";
      reasonCode:
        | "readiness-prerequisites-not-passed"
        | "readiness-latch-commit-failed"
        | "readiness-verification-failed";
      prerequisiteReport: Readonly<DacsLiveDoctorReportV1>;
      report: Readonly<DacsLiveDoctorReportV1>;
    }
>;

export class DacsRoleReadinessSupervisorError extends Error {
  override readonly name = "DacsRoleReadinessSupervisorError";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

function readinessActors(
  input: readonly Readonly<DacsRoleReadinessSupervisorActorV1>[],
): Readonly<Record<"buyer" | "seller", Readonly<DacsRoleReadinessSupervisorActorV1>>> {
  if (!Array.isArray(input) || input.length !== 2) {
    throw new TypeError("readiness supervisor requires one buyer and one seller");
  }
  const buyer = input.find((actor) => actor?.role === "buyer");
  const seller = input.find((actor) => actor?.role === "seller");
  if (buyer === undefined || seller === undefined || buyer === seller ||
      buyer.latch?.role !== "buyer" || seller.latch?.role !== "seller" ||
      typeof buyer.latch.commit !== "function" || typeof buyer.latch.revoke !== "function" ||
      typeof seller.latch.commit !== "function" || typeof seller.latch.revoke !== "function" ||
      typeof buyer.sign !== "function" || typeof seller.sign !== "function") {
    throw new TypeError("readiness supervisor actors are invalid");
  }
  return Object.freeze({ buyer, seller });
}

async function revokeReadiness(
  actors: Readonly<Record<"buyer" | "seller", Readonly<DacsRoleReadinessSupervisorActorV1>>>,
): Promise<void> {
  const settled = await Promise.allSettled([
    actors.buyer.latch.revoke(),
    actors.seller.latch.revoke(),
  ]);
  if (settled.some((result) => result.status === "rejected")) {
    throw new DacsRoleReadinessSupervisorError("readiness-latch-revoke-failed");
  }
}

/**
 * Run the complete post-start/start gate around the readiness latch boundary.
 * The first report is the exact prerequisite evidence signed by both roles.
 * Every required check except the necessarily circular readiness check must
 * pass before either latch is committed; the complete gate is then rerun and
 * both latches are revoked if final verification does not pass.
 */
export async function establishDacsRoleServiceReadinessV1(
  options: Readonly<{
    actors: readonly Readonly<DacsRoleReadinessSupervisorActorV1>[];
    doctor: Omit<DacsLiveDoctorOptionsV1, "phase" | "scope">;
  }>,
): Promise<Readonly<DacsRoleReadinessEstablishmentResultV1>> {
  if (options === null || typeof options !== "object" ||
      options.doctor === null || typeof options.doctor !== "object") {
    throw new TypeError("readiness supervisor options are invalid");
  }
  const actors = readinessActors(options.actors);
  const run = (): Promise<Readonly<DacsLiveDoctorReportV1>> =>
    runDacsLiveDoctorV1({
      ...options.doctor,
      phase: "post-start",
      scope: "start",
    });
  const prerequisiteReport = await run();
  const prerequisitesPassed = prerequisiteReport.checks.every((check) =>
    !check.required || check.id === "service.readiness" || check.status === "pass"
  );
  if (!prerequisitesPassed) {
    await revokeReadiness(actors);
    return Object.freeze({
      status: "not-ready",
      reasonCode: "readiness-prerequisites-not-passed",
      prerequisiteReport,
      report: prerequisiteReport,
    });
  }

  const commits = await Promise.allSettled([
    actors.buyer.latch.commit(prerequisiteReport.reportHash, actors.buyer.sign),
    actors.seller.latch.commit(prerequisiteReport.reportHash, actors.seller.sign),
  ]);
  if (commits.some((result) => result.status === "rejected")) {
    await revokeReadiness(actors);
    return Object.freeze({
      status: "not-ready",
      reasonCode: "readiness-latch-commit-failed",
      prerequisiteReport,
      report: prerequisiteReport,
    });
  }

  let report: Readonly<DacsLiveDoctorReportV1>;
  try {
    report = await run();
  } catch {
    await revokeReadiness(actors);
    throw new DacsRoleReadinessSupervisorError("readiness-verification-unavailable");
  }
  if (report.exitCode !== 0 || report.gate.status !== "pass") {
    await revokeReadiness(actors);
    return Object.freeze({
      status: "not-ready",
      reasonCode: "readiness-verification-failed",
      prerequisiteReport,
      report,
    });
  }
  return Object.freeze({ status: "ready", prerequisiteReport, report });
}

/**
 * Install bounded SIGINT/SIGTERM handling without taking ownership of process
 * exit. The first shutdown request wins, listeners are removed immediately,
 * and repeated requests await the same service stop operation.
 */
export function installDacsRoleServiceProcessHooksV1(
  service: Readonly<Pick<DacsLiveRoleServiceV1, "stop">>,
  options: Readonly<{
    signalTarget?: DacsProcessSignalTargetV1;
    onShutdown?: (
      result: Readonly<DacsRoleServiceShutdownResultV1>,
    ) => Promise<void> | void;
  }> = {},
): Readonly<DacsRoleServiceProcessHooksV1> {
  if (service === null || typeof service !== "object" || typeof service.stop !== "function" ||
      (options.signalTarget !== undefined &&
        (options.signalTarget === null || typeof options.signalTarget.on !== "function" ||
          typeof options.signalTarget.off !== "function")) ||
      (options.onShutdown !== undefined && typeof options.onShutdown !== "function")) {
    throw new TypeError("role service process hook options are invalid");
  }
  const target = options.signalTarget ?? process;
  const stop = Function.prototype.bind.call(service.stop, service) as () => Promise<void>;
  const notify = options.onShutdown === undefined
    ? undefined
    : Function.prototype.bind.call(options.onShutdown, options) as (
      result: Readonly<DacsRoleServiceShutdownResultV1>,
    ) => Promise<void> | void;
  let disposed = false;
  let task: Promise<Readonly<DacsRoleServiceShutdownResultV1>> | undefined;
  let resolveWait!: (result: Readonly<DacsRoleServiceShutdownResultV1>) => void;
  const waited = new Promise<Readonly<DacsRoleServiceShutdownResultV1>>((resolve) => {
    resolveWait = resolve;
  });

  const onSigint = (): void => {
    void shutdown("SIGINT");
  };
  const onSigterm = (): void => {
    void shutdown("SIGTERM");
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    target.off("SIGINT", onSigint);
    target.off("SIGTERM", onSigterm);
  };
  const shutdown = (
    reason: DacsRoleServiceShutdownReasonV1 = "manual",
  ): Promise<Readonly<DacsRoleServiceShutdownResultV1>> => {
    if (reason !== "manual" && reason !== "SIGINT" && reason !== "SIGTERM") {
      return Promise.reject(new TypeError("shutdown reason is invalid"));
    }
    if (task !== undefined) return task;
    dispose();
    task = (async () => {
      let result: Readonly<DacsRoleServiceShutdownResultV1>;
      try {
        await stop();
        result = Object.freeze({ reason, status: "stopped" });
      } catch {
        result = Object.freeze({
          reason,
          status: "failed",
          reasonCode: "service-stop-failed",
        });
      }
      if (notify !== undefined) {
        try {
          await notify(result);
        } catch {
          // Shutdown result remains bounded; an observer cannot undo the stop.
        }
      }
      resolveWait(result);
      return result;
    })();
    return task;
  };

  target.on("SIGINT", onSigint);
  target.on("SIGTERM", onSigterm);
  return Object.freeze({
    shutdown,
    waitForShutdown: () => waited,
    dispose,
  });
}

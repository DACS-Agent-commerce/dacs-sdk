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

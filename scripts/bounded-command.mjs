#!/usr/bin/env node
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export const COMMAND_TIMEOUT_SECONDS = 900;
export const DOCKER_PULL_TIMEOUT_SECONDS = 180;
export const COMMAND_MAX_ATTEMPTS = 3;
const COMMAND_KILL_GRACE_MS = 250;
// Signals whose default action ends the wrapper; each must reap the detached
// command group first, including SIGHUP from a disconnected session.
const TERMINATION_SIGNALS = { SIGHUP: 129, SIGINT: 130, SIGQUIT: 131, SIGTERM: 143 };

/** Runs attempts within one total deadline, kills the process group on timeout or
 * termination, and returns its exit code. Injectable process/timer/signal operations
 * support deterministic stalled-command and cancellation tests. */
export function runBoundedCommand(command, args, { seconds = COMMAND_TIMEOUT_SECONDS, attempts = 1,
  start = spawn, schedule = setTimeout, cancel = clearTimeout, now = () => performance.now(),
  onSignal = (signal, handler) => process.on(signal, handler),
  offSignal = (signal, handler) => process.removeListener(signal, handler),
  kill = (pid, signal) => { try { process.kill(-pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; } },
  diagnostic = message => process.stderr.write(message + "\n") } = {}) {
  if (!Number.isInteger(seconds) || seconds <= 0 || !Number.isInteger(attempts) || attempts < 1 || attempts > COMMAND_MAX_ATTEMPTS) {
    throw new Error("invalid command deadline or retry budget");
  }
  return new Promise(resolve => {
    let child, attempt = 0, expired = false, finished = false;
    const signalHandlers = new Map();
    const removeSignalHandlers = () => {
      for (const [signal, handler] of signalHandlers) offSignal(signal, handler);
      signalHandlers.clear();
    };
    const finish = code => { if (!finished) { finished = true; cancel(deadline); removeSignalHandlers(); resolve(code); } };
    const terminate = (code, message) => {
      if (expired || finished) return;
      expired = true;
      if (message) diagnostic(message);
      if (child?.pid) kill(child.pid, "SIGTERM");
      // Retain the grace window so descendants that ignore SIGTERM are killed too.
      schedule(() => { if (child?.pid) kill(child.pid, "SIGKILL"); finish(code); }, COMMAND_KILL_GRACE_MS);
    };
    const deadlineAt = now() + seconds * 1000;
    const deadline = schedule(() => terminate(124, "ETIMEDOUT command deadline: " + command), seconds * 1000);
    for (const [signal, code] of Object.entries(TERMINATION_SIGNALS)) {
      const handler = () => terminate(code, "received " + signal + ": " + command);
      signalHandlers.set(signal, handler);
      onSignal(signal, handler);
    }
    const next = () => {
      attempt++;
      const current = child = start(command, args, { stdio: "inherit", detached: true });
      const cleanGroup = () => { if (current.pid) kill(current.pid, "SIGKILL"); };
      current.once("error", error => {
        if (expired || finished) return;
        cleanGroup(); diagnostic(String(error)); finish(1);
      });
      current.once("exit", code => {
        if (expired || finished) return;
        // A leader's exit does not imply its descendants have stopped. Reap
        // this attempt's group before returning or replacing the active child.
        cleanGroup();
        // An exit observed at or after the absolute deadline is a timeout even
        // when the deadline callback has not run yet; never report a command
        // status that was produced past its total budget.
        if (now() >= deadlineAt) {
          // The group was already reaped above, so only the grace timer remains.
          child = undefined;
          terminate(124, "ETIMEDOUT command deadline: " + command);
        } else if (code === 0 || attempt >= attempts) finish(code ?? 1);
        else next();
      });
    };
    next();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [seconds, attempts, command, ...args] = process.argv.slice(2);
  if (!command) throw new Error("usage: bounded-command.mjs <total-seconds> <attempts> <command> [args...]");
  process.exitCode = await runBoundedCommand(command, args, { seconds: Number(seconds), attempts: Number(attempts) });
}

#!/usr/bin/env node
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export const COMMAND_TIMEOUT_SECONDS = 900;
export const DOCKER_PULL_TIMEOUT_SECONDS = 180;
export const COMMAND_MAX_ATTEMPTS = 3;
const COMMAND_KILL_GRACE_MS = 250;

/** Runs attempts within one total deadline, kills the process group on timeout, and returns its exit code.
 * Injectable process/timer operations support deterministic stalled-command tests. */
export function runBoundedCommand(command, args, { seconds = COMMAND_TIMEOUT_SECONDS, attempts = 1,
  start = spawn, schedule = setTimeout, cancel = clearTimeout,
  kill = (pid, signal) => { try { process.kill(-pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; } },
  diagnostic = message => process.stderr.write(message + "\n") } = {}) {
  if (!Number.isInteger(seconds) || seconds <= 0 || !Number.isInteger(attempts) || attempts < 1 || attempts > COMMAND_MAX_ATTEMPTS) {
    throw new Error("invalid command deadline or retry budget");
  }
  return new Promise(resolve => {
    let child, attempt = 0, expired = false, finished = false;
    const finish = code => { if (!finished) { finished = true; cancel(deadline); resolve(code); } };
    const deadline = schedule(() => {
      expired = true;
      diagnostic("ETIMEDOUT command deadline: " + command);
      if (child?.pid) kill(child.pid, "SIGTERM");
      schedule(() => { if (child?.pid) kill(child.pid, "SIGKILL"); finish(124); }, COMMAND_KILL_GRACE_MS);
    }, seconds * 1000);
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
        if (code === 0 || attempt >= attempts) finish(code ?? 1);
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

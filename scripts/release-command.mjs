import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runBoundedCommand } from "./bounded-command.mjs";

const RELEASE_COMMAND_OUTPUT_MAX_BYTES = 32 * 1024 * 1024;
const BOUNDED_TRANSPORT = join(dirname(fileURLToPath(import.meta.url)), "bounded-npm-http.cjs");
// The fetch timeouts bounded-transport.sh exports, so npm gives up on a stalled registry itself.
const NPM_FETCH_LIMITS = {
  npm_config_fetch_timeout: "15000", npm_config_fetch_retry_mintimeout: "1000", npm_config_fetch_retry_maxtimeout: "2000",
};
const CREDENTIAL_VARIABLE = /token|auth|password|^npm_config_userconfig$/i;

const killProcessGroup = (pid, signal) => {
  try { process.kill(-pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
};

// Keeps what a stream produces up to `maxBytes`; `onOverflow` runs when it produces more.
function collectOutput(stream, maxBytes, onOverflow) {
  const chunks = [];
  let length = 0;
  stream.on("data", (chunk) => {
    if (length + chunk.length > maxBytes) { onOverflow(); return; }
    chunks.push(chunk);
    length += chunk.length;
  });
  return () => Buffer.concat(chunks, length).toString("utf8");
}

/**
 * Runs `command` through runBoundedCommand in `cwd` with exactly `env`, capturing stdout and stderr (each up to
 * `maxOutputBytes`). Resolves to `{ exitCode, signal, timedOut, stdout, stderr, cause }`: `cause` is the spawn error, or
 * an error coded `output_oversized` once a stream passed the limit and the group was killed. Rejects on invalid `seconds`.
 */
export async function runReleaseCommand(command, args, {
  cwd, env, seconds, maxOutputBytes = RELEASE_COMMAND_OUTPUT_MAX_BYTES, start = spawn, schedule = setTimeout, cancel = clearTimeout,
  kill = killProcessGroup,
}) {
  let signal = null;
  let timedOut = false;
  let cause;
  let closed;
  let readStdout;
  let readStderr;
  const exitCode = await runBoundedCommand(command, args, {
    seconds, schedule, cancel, kill,
    diagnostic: (message) => { if (message.startsWith("ETIMEDOUT")) timedOut = true; },
    start: (file, fileArguments, options) => {
      const child = start(file, fileArguments, { ...options, cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      closed = new Promise((resolve) => child.once("close", resolve));
      const overflow = () => {
        cause ??= Object.assign(new Error(`command output exceeded ${maxOutputBytes} bytes`), { code: "output_oversized" });
        kill(child.pid, "SIGKILL");
      };
      readStdout = collectOutput(child.stdout, maxOutputBytes, overflow);
      readStderr = collectOutput(child.stderr, maxOutputBytes, overflow);
      child.once("error", (error) => { cause ??= error; });
      child.once("exit", (code, exitSignal) => { signal = exitSignal; });
      return child;
    },
  });
  // The runner ends at the child's exit, which can precede its last output; it has killed the group, so the pipes close.
  await closed;
  return { exitCode, signal, timedOut, stdout: readStdout(), stderr: readStderr(), cause };
}

/**
 * Returns a copy of `parentEnv` without token, auth or password variables (the OIDC request variables included) and
 * every case variant of npm_config_userconfig, with NO_COLOR, an empty NODE_PATH and npm_config_userconfig=/dev/null.
 */
export function withoutCredentials(parentEnv) {
  const kept = Object.entries(parentEnv).filter(([name]) => !CREDENTIAL_VARIABLE.test(name));
  return { ...Object.fromEntries(kept), NO_COLOR: "1", NODE_PATH: "", npm_config_userconfig: "/dev/null" };
}

// Admits registry replies through bounded-npm-http.cjs in npm and its children, replacing any inherited NODE_OPTIONS.
function withBoundedTransport(env) {
  return { ...env, ...NPM_FETCH_LIMITS, DACS_BOUNDED_NPM_HTTP: "1", NODE_OPTIONS: `--require="${BOUNDED_TRANSPORT}"` };
}

/** The environment for every release npm command except publication: no credentials, the bounded transport. */
export function credentialFreeNpmEnvironment(parentEnv) {
  return withBoundedTransport(withoutCredentials(parentEnv));
}

/** The environment for `npm publish` alone: the job environment (user configuration, token, OIDC) plus provenance and the transport; npm retries nothing. */
export function publishNpmEnvironment(parentEnv) {
  return { ...withBoundedTransport({ ...parentEnv, NPM_CONFIG_PROVENANCE: "true" }), npm_config_fetch_retries: "0" };
}

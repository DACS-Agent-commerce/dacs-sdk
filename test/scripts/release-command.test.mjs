import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  credentialFreeNpmEnvironment, publishNpmEnvironment, runReleaseCommand, withoutCredentials,
} from "../../scripts/release-command.mjs";
import { startLoopbackNpmRegistry } from "./fixtures/loopback-npm-registry.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE_BEARER_VALUE = "release-fixture-not-a-token";
const scratch = [];
after(() => { for (const directory of scratch) rmSync(directory, { recursive: true, force: true }); });
function tempDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "dacs-release-command-"));
  scratch.push(directory);
  return directory;
}
const node = (script) => [process.execPath, ["-e", script]];

test("runReleaseCommand runs in the given cwd and env, captures stdout and stderr, and keeps the exit code, signal, timeout and spawn cause", async () => {
  const cwd = tempDirectory();
  const [command, args] = node("console.log(process.cwd(), process.env.RELEASE_PROBE); console.error('to stderr'); process.exit(3)");
  const ran = await runReleaseCommand(command, args, { cwd, env: { RELEASE_PROBE: "probe-value" }, seconds: 30 });
  assert.equal(ran.exitCode, 3);
  assert.equal(ran.timedOut, false);
  assert.equal(ran.stdout.trim(), `${realpathSync(cwd)} probe-value`);
  assert.equal(ran.stderr.trim(), "to stderr");

  const missing = await runReleaseCommand(join(cwd, "absent-command"), [], { cwd, env: {}, seconds: 30 });
  assert.equal(missing.exitCode, 1);
  assert.equal(missing.cause.code, "ENOENT");

  // A child that never exits: the injected timers expire the deadline, then the kill grace.
  const timers = [];
  const kills = [];
  const child = Object.assign(new EventEmitter(), { pid: 4242, stdout: new PassThrough(), stderr: new PassThrough() });
  const stalled = runReleaseCommand("npm", ["publish"], {
    cwd, env: {}, seconds: 5, start: () => child, kill: (pid, signal) => kills.push([pid, signal]),
    schedule: (callback) => { timers.push(callback); return timers.length; }, cancel: () => {},
  });
  timers[0]();
  timers[1]();
  child.emit("close");
  const expired = await stalled;
  assert.equal(expired.timedOut, true);
  assert.equal(expired.exitCode, 124);
  assert.deepEqual(kills.map(([, signal]) => signal), ["SIGTERM", "SIGKILL"]);

  const killed = Object.assign(new EventEmitter(), { pid: 4343, stdout: new PassThrough(), stderr: new PassThrough() });
  const signalled = runReleaseCommand("npm", [], { cwd, env: {}, seconds: 5, start: () => killed, kill: () => {} });
  killed.emit("exit", null, "SIGKILL");
  killed.emit("close");
  assert.equal((await signalled).signal, "SIGKILL");
});

test("output above the limit kills the process group and returns output_oversized", async () => {
  const [command, args] = node("process.stdout.write('x'.repeat(100000)); setInterval(() => {}, 1000)");
  const ran = await runReleaseCommand(command, args, { cwd: tempDirectory(), env: {}, seconds: 30, maxOutputBytes: 1000 });
  assert.equal(ran.cause.code, "output_oversized");
  assert.notEqual(ran.exitCode, 0);
  assert.ok(ran.stdout.length <= 1000, `kept ${ran.stdout.length} bytes`);
});

const parentEnvironment = {
  PATH: "/usr/bin", HOME: "/home/runner", NODE_OPTIONS: "--inspect", NODE_AUTH_TOKEN: "x", GH_TOKEN: "x", NPM_PASSWORD: "x",
  NPM_CONFIG_USERCONFIG: "/runner/.npmrc", npm_config_userconfig: "/runner/.npmrc", Npm_Config_UserConfig: "/runner/.npmrc",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://actions.invalid/", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "x", NODE_PATH: "/somewhere",
};
const TRANSPORT = join(repoRoot, "scripts/bounded-npm-http.cjs");

test("publishNpmEnvironment keeps the job's user configuration, NODE_AUTH_TOKEN and the OIDC request variables and adds the bounded transport; credentialFreeNpmEnvironment removes every case variant of the user configuration, every token, auth or password variable and the OIDC request URL, then sets /dev/null; only the publisher's npm publish call uses the first", () => {
  const before = JSON.stringify(parentEnvironment);
  const publishing = publishNpmEnvironment(parentEnvironment);
  for (const key of Object.keys(parentEnvironment)) if (key !== "NODE_OPTIONS") assert.equal(publishing[key], parentEnvironment[key], key);
  assert.equal(publishing.NPM_CONFIG_PROVENANCE, "true");
  assert.equal(publishing.DACS_BOUNDED_NPM_HTTP, "1");
  assert.equal(publishing.NODE_OPTIONS, `--require="${TRANSPORT}"`);

  const credentialFree = credentialFreeNpmEnvironment(parentEnvironment);
  assert.deepEqual(Object.keys(credentialFree).filter((key) => /token|auth|password/i.test(key)), []);
  assert.deepEqual(Object.keys(credentialFree).filter((key) => /^npm_config_userconfig$/i.test(key)), ["npm_config_userconfig"]);
  assert.equal(credentialFree.npm_config_userconfig, "/dev/null");
  assert.equal(credentialFree.NODE_PATH, "");
  assert.equal(credentialFree.NO_COLOR, "1");
  assert.equal(credentialFree.PATH, "/usr/bin");
  assert.equal(credentialFree.DACS_BOUNDED_NPM_HTTP, "1");
  assert.equal(credentialFree.NODE_OPTIONS, `--require="${TRANSPORT}"`);
  assert.equal(withoutCredentials(parentEnvironment).DACS_BOUNDED_NPM_HTTP, undefined);
  assert.equal(JSON.stringify(parentEnvironment), before);

  const users = [];
  for (const file of readdirSync(join(repoRoot, "scripts")).filter((name) => /\.(mjs|cjs)$/.test(name))) {
    if (readFileSync(join(repoRoot, "scripts", file), "utf8").includes("publishNpmEnvironment(")) users.push(file);
  }
  assert.deepEqual(users, ["publish-release-set.mjs", "release-command.mjs"]);
  const publisher = readFileSync(join(repoRoot, "scripts/publish-release-set.mjs"), "utf8");
  assert.equal(publisher.match(/publishNpmEnvironment\(/g).length, 1);
});

// A setup-node-shaped user configuration: it names the token only through NODE_AUTH_TOKEN.
async function publishToLoopback(buildEnvironment) {
  const registry = await startLoopbackNpmRegistry({ requiredToken: FIXTURE_BEARER_VALUE });
  const directory = tempDirectory();
  const project = join(directory, "project");
  mkdirSync(project);
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "loopback-fixture", version: "1.0.0" }));
  const userConfig = join(directory, "user.npmrc");
  const host = new URL(registry.url).host;
  writeFileSync(userConfig, `registry=${registry.url}\n//${host}/:_authToken=\${NODE_AUTH_TOKEN}\n`);
  const environment = buildEnvironment({
    PATH: process.env.PATH, NPM_CONFIG_USERCONFIG: userConfig, NODE_AUTH_TOKEN: FIXTURE_BEARER_VALUE,
    npm_config_cache: join(directory, "cache"), npm_config_update_notifier: "false", HOME: directory,
  });
  try {
    // Provenance needs a CI identity provider, which a loopback run does not have; authentication is what is under test.
    const ran = await runReleaseCommand("npm", ["publish", project, "--registry", registry.url], {
      cwd: directory, env: { ...environment, NPM_CONFIG_PROVENANCE: "false" }, seconds: 60,
    });
    return { ran, requests: registry.requests };
  } finally {
    await registry.close();
  }
}

test("with a setup-node-shaped user configuration that refers to NODE_AUTH_TOKEN, an npm publish run with publishNpmEnvironment authenticates to the loopback registry; the same configuration under credentialFreeNpmEnvironment sends no authorization header and npm stops with its authentication error; no captured output contains the fixture value", async () => {
  const published = await publishToLoopback(publishNpmEnvironment);
  assert.equal(published.ran.exitCode, 0, published.ran.stderr);
  assert.ok(published.requests.some(({ method, headers }) => method === "PUT" && headers.authorization === `Bearer ${FIXTURE_BEARER_VALUE}`));

  const refused = await publishToLoopback(credentialFreeNpmEnvironment);
  assert.notEqual(refused.ran.exitCode, 0);
  assert.match(refused.ran.stderr, /ENEEDAUTH|E401/);
  assert.equal(refused.requests.filter(({ headers }) => headers.authorization !== undefined).length, 0);
  for (const { ran } of [published, refused]) assert.equal((ran.stdout + ran.stderr).includes(FIXTURE_BEARER_VALUE), false);
});

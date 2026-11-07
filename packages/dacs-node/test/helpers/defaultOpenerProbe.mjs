import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Child-process probe for rootImport.test.ts. Run it with the recording
 * resolve hook. It imports the built root, opens a live role runtime through
 * its default database opener (the driver is refused by the hook) and prints
 * one JSON line: the resolve and load log before the first open, each open's
 * outcome, and whether every loaded identity secret was destroyed.
 *
 * Argument: `single`, or `concurrent` for two simultaneous opens then one more.
 */
const loadedSecrets = [];
const freeze = Object.freeze;
// The loaded secret is created and frozen inside secrets.ts; record it there.
Object.freeze = (value) => {
  if (typeof value?.destroy === "function" && "warningCodes" in value) {
    loadedSecrets.push(value);
  }
  return freeze(value);
};

const { DACS_NODE_LIVE_PROFILE, createDacsLiveRoleRuntimeV1 } = await import(
  "@kynesyslabs/dacs-node"
);

const directory = mkdtempSync(join(tmpdir(), "dacs-root-import-"));
const identityPath = join(directory, "demos.secret");
writeFileSync(identityPath, "test-only-secret\n", { mode: 0o600 });
const publicKeyHex = "11".repeat(32);

function openRuntime() {
  return createDacsLiveRoleRuntimeV1({
    config: {
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role: "buyer",
      dataDirectory: directory,
      demos: { rpcUrl: "http://127.0.0.1:5350" },
      rail: {
        registryIndexRef: "dacs4:registry:v0.1",
        requestedNetwork: "demos",
        enabledProfiles: ["pay-dem"],
      },
      limits: {
        maxServiceAmount: { asset: "DEM", amount: "1" },
        maxSetupSpendDem: "10",
        maxDemosNetworkFeeDem: "2",
        maxEvmNetworkFeeEth: "0",
      },
    },
    role: "buyer",
    authority: `claim:probe:${publicKeyHex}`,
    peerAuthority: `claim:probe-peer:${publicKeyHex}`,
    peerEndpoint: "http://127.0.0.1:39999/dacs-transport/v1/messages",
    workerId: "root-import-probe-worker",
    demosIdentityFilePath: identityPath,
    createDemosAdapter: async () => ({}),
    createPayDemRail: async () => ({ address: publicKeyHex, settle: () => {} }),
    createPayDemOperations: () => Object.freeze({}),
    validatePayload: () => Object.freeze({ status: "valid" }),
    handleMessage: () => Object.freeze({ disposition: "accepted" }),
    server: { hostname: "127.0.0.1", port: 0 },
  });
}

function describeOutcome(settled) {
  if (settled.status === "fulfilled") return { opened: true };
  const error = settled.reason;
  return {
    opened: false,
    name: error?.name,
    reasonCode: error?.reasonCode,
    causeCode: error?.cause?.code,
    causeMessage: error?.cause?.message,
  };
}

const logBefore = readFileSync(process.env.DACS_RESOLVE_LOG, "utf8");
const settled = process.argv[2] === "concurrent"
  ? [
      ...(await Promise.allSettled([openRuntime(), openRuntime()])),
      ...(await Promise.allSettled([openRuntime()])),
    ]
  : await Promise.allSettled([openRuntime()]);
const outcomes = settled.map(describeOutcome);
const secretsDestroyed = loadedSecrets.map((secret) => secret.destroyed);
rmSync(directory, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify({ logBefore, outcomes, secretsDestroyed })}\n`);

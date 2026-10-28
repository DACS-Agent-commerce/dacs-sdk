import { types as nodeTypes } from "node:util";

/** Source-reviewed RPC contract. A matching version string alone is insufficient. */
export const DACS_NODE_DEMOS_RPC_COMPATIBILITY_V1 = Object.freeze({
  contractVersion: "dacs-demos-rpc/v1",
  nodeRepository: "https://github.com/kynesyslabs/node",
  nodeSourceRevision: "61b8e75aa8db5e408c49e1c3a89db4d673f45578",
  nodeVersion: "0.9.8",
  requireCleanBuild: true,
  sdkVersion: "4.0.16",
  sdkSourceRevision: "d3620ae24f657ae7442e63e7adaefef7094b22e2",
  osPerDem: "1000000000",
  inclusionState: "included",
  finalityModel: "bft-final",
} as const);

function field(value: unknown, name: string): unknown {
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value) ||
      Array.isArray(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/**
 * Read-only build compatibility report for SDK-unwrapped network info. The node
 * self-reports this metadata, so callers report it and must not treat it as
 * authentication of the node.
 */
export function inspectDacsDemosNodeCompatibilityV1(networkInfo: unknown): Readonly<{
  compatible: boolean;
  reasonCode: "demos-node-compatible" | "demos-node-build-unidentified" |
    "demos-node-build-dirty" | "demos-node-revision-unsupported";
}> {
  const version = field(networkInfo, "nodeVersion");
  const dirty = field(version, "dirty");
  if (dirty === true) {
    return Object.freeze({ compatible: false, reasonCode: "demos-node-build-dirty" });
  }
  if (dirty !== false || typeof field(version, "commit") !== "string" ||
      typeof field(version, "version") !== "string" ||
      field(version, "name") !== "demos-node-software") {
    return Object.freeze({ compatible: false, reasonCode: "demos-node-build-unidentified" });
  }
  if (field(version, "commit") !== DACS_NODE_DEMOS_RPC_COMPATIBILITY_V1.nodeSourceRevision ||
      field(version, "version") !== DACS_NODE_DEMOS_RPC_COMPATIBILITY_V1.nodeVersion) {
    return Object.freeze({ compatible: false, reasonCode: "demos-node-revision-unsupported" });
  }
  return Object.freeze({ compatible: true, reasonCode: "demos-node-compatible" });
}

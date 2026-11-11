import { configDefaults, defineConfig } from "vitest/config";

// The client package stores its state in node:sqlite, which Node ships without
// a flag from 22.13 and 23.4. On an older Node, test/client cannot load at all.
const [nodeMajor = 0, nodeMinor = 0] = process.versions.node.split(".").map(Number);
const hasNodeSqlite = nodeMajor >= 24 || (nodeMajor === 23 && nodeMinor >= 4) || (nodeMajor === 22 && nodeMinor >= 13);

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: hasNodeSqlite ? configDefaults.exclude : [...configDefaults.exclude, "test/client/**"],
    environment: "node",
    // Several recovery suites intentionally spawn nested Vitest controllers
    // and hard-kill child processes at durable boundaries. Letting the outer
    // runner fan out across every host CPU can starve those children past
    // their safety deadlines, producing false worker crashes. The hardened
    // filesystem stores intentionally fsync each durable boundary; running two
    // of their stress suites together can exhaust short test-only lock
    // deadlines, so keep the complete default suite on one deterministic
    // worker in CI and on high-core developer machines.
    maxWorkers: 1,
    // demosdk's published build (and its transitive deps) use directory /
    // extensionless imports that Node's strict ESM resolver rejects — left
    // externalized, importing DemosAdapter crashes at collection time
    // (rpc-websockets -> uuid). Inlining lets Vite's resolver handle them so
    // the substrate/connectivity suites can actually load.
    server: {
      deps: {
        inline: [/@kynesyslabs\/demosdk/, /rpc-websockets/, /uuid/],
      },
    },
  },
});

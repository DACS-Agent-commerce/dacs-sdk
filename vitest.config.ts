import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import { compilerOptions } from "./tsconfig.json";

export default defineConfig({
  resolve: {
    // Root integration tests also import host sources. Resolve their core
    // imports just as tsc does, without requiring a previous build's dist/.
    alias: Object.entries(compilerOptions.paths).map(([specifier, [source]]) => ({
      find: new RegExp(`^${specifier}$`),
      replacement: fileURLToPath(new URL(source!, import.meta.url)),
    })),
  },
  test: {
    include: ["test/**/*.test.ts"],
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

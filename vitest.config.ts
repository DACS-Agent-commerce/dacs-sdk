import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Several recovery suites intentionally spawn nested Vitest controllers
    // and hard-kill child processes at durable boundaries. Letting the outer
    // runner fan out across every host CPU can starve those children past
    // their safety deadlines, producing false worker crashes. Two workers keep
    // the default `npm test` command representative and deterministic in CI
    // and on high-core developer machines.
    maxWorkers: 2,
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

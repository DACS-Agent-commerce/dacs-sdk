import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
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

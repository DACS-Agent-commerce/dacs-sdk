import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // demosdk's published build uses directory imports that Node's strict ESM
    // resolver rejects; inlining lets Vite's resolver handle them.
    server: {
      deps: {
        inline: [/@kynesyslabs\/demosdk/],
      },
    },
  },
});

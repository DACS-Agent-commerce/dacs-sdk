import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "./vitest.config.js";

const config = mergeConfig(baseConfig, defineConfig({
  test: {
    fileParallelism: false,
    maxWorkers: 1,
    passWithNoTests: false,
    retry: 0,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    sequence: { concurrent: false },
  },
}));

// mergeConfig concatenates array-valued options, but this suite must never
// discover the ordinary unit tests. Replace the base include after merging.
config.test = {
  ...config.test,
  include: ["test-postgres/**/*.test.ts"],
};

export default config;

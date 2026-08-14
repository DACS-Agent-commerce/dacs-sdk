import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

function coreSource(path: string): string {
  return fileURLToPath(new URL(`../../src/${path}/index.ts`, import.meta.url));
}

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@kynesyslabs\/dacs$/,
        replacement: fileURLToPath(new URL("../../src/index.ts", import.meta.url)),
      },
      { find: "@kynesyslabs/dacs/artifacts", replacement: coreSource("artifacts") },
      { find: "@kynesyslabs/dacs/canonical", replacement: coreSource("canonical") },
      { find: "@kynesyslabs/dacs/commerce", replacement: coreSource("commerce") },
      { find: "@kynesyslabs/dacs/crypto", replacement: coreSource("crypto") },
      { find: "@kynesyslabs/dacs/negotiate", replacement: coreSource("negotiate") },
      { find: "@kynesyslabs/dacs/seller", replacement: coreSource("seller") },
    ],
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});

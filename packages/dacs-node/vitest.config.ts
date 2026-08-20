import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

function coreSource(path: string): string {
  return fileURLToPath(new URL(`../../src/${path}/index.ts`, import.meta.url));
}

export default defineConfig({
  resolve: {
    alias: {
      "@kynesyslabs/dacs/artifacts": coreSource("artifacts"),
      "@kynesyslabs/dacs/canonical": coreSource("canonical"),
      "@kynesyslabs/dacs/commerce": coreSource("commerce"),
      "@kynesyslabs/dacs/crypto": coreSource("crypto"),
      "@kynesyslabs/dacs/negotiate": coreSource("negotiate"),
      "@kynesyslabs/dacs/seller": coreSource("seller"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});

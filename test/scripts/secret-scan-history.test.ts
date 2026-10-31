import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("retains the reviewed historical portal capability fixture fingerprint", () => {
  const fingerprints = readFileSync(new URL("../../.gitleaksignore", import.meta.url), "utf8")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("#"));

  expect(fingerprints).toContain(
    "3a414b312ce5312eb605e7cbe44c21e750445361:packages/dacs-client/test/portal-capability.test.mjs:generic-api-key:204",
  );
});

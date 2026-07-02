import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const MANIFEST = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../vendor/DACS-Standard/conformance/MANIFEST.json",
);
const haveVectors = existsSync(MANIFEST);

describe("DACS-Standard §14 conformance vectors", () => {
  if (!haveVectors) {
    it.skip("vectors not synced — run `npm run conformance:sync`", () => {});
    return;
  }

  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
    dacsVersion: string;
    cases: Array<{ area: string }>;
  };
  const byArea = new Map<string, number>();
  for (const c of manifest.cases) {
    byArea.set(c.area, (byArea.get(c.area) ?? 0) + 1);
  }

  it("loads the pinned manifest", () => {
    expect(manifest.dacsVersion).toBe("0.1");
    expect(manifest.cases.length).toBeGreaterThan(0);
  });

  // Areas with a real implementation are exercised by dedicated vector suites
  // (test/canonical/*, test/crypto/*). The rest remain visible todos so the
  // harness shows exactly what's left to implement (T3 artifacts onward).
  const IMPLEMENTED = new Set([
    "canonicalize",
    "decimal",
    "signing",
    "addressing",
    "bundle",
  ]);

  for (const area of [...byArea.keys()].sort()) {
    const n = byArea.get(area)!;
    if (IMPLEMENTED.has(area)) {
      it(`${area} — ${n} vectors (covered by dedicated suite)`, () => {
        expect(n).toBeGreaterThan(0);
      });
    } else {
      it.todo(`${area} — ${n} vectors (pending implementation)`);
    }
  }
});

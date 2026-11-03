import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  name: string;
  exports: Record<string, { types: string }>;
};
const configPath = join(root, "tsconfig.json");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
if (parsed.errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(parsed.errors, {
  getCanonicalFileName: (file) => file,
  getCurrentDirectory: () => root,
  getNewLine: () => "\n",
}));

// Use a host importer: the root seller-closure regression follows the host's
// imports under the root compiler options, not the host's own tsconfig.
const importer = join(root, "packages/dacs-node/src/demosSellerBundleReads.ts");
it.each(Object.entries(manifest.exports))(
  "resolves public entrypoint %s to source without build artifacts",
  (subpath, entrypoint) => {
    const specifier = subpath === "." ? manifest.name : `${manifest.name}${subpath.slice(1)}`;
    const resolved = ts.resolveModuleName(specifier, importer, parsed.options, ts.sys);
    const source = entrypoint.types.replace(/^\.\/dist\//, "src/").replace(/\.d\.ts$/, ".ts");
    // Assert the actual resolved file so a pre-existing dist/ cannot hide a
    // missing source mapping in a developer's checkout.
    expect(resolved.resolvedModule?.resolvedFileName).toBe(join(root, source));
  },
);

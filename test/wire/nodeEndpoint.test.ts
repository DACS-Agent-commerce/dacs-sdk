// The node endpoint rule lives in a leaf with no imports, so a caller that only
// judges an endpoint loads nothing else. These tests read the built package.
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const leafFile = `${root}dist/wire/node-endpoint.js`;
const sourceFile = `${root}src/wire/node-endpoint.ts`;

const fromDist = await import(pathToFileURL(leafFile).href);
const fromLeafExport = await import("@kynesyslabs/dacs/wire/node-endpoint");
const fromWireExport = await import("@kynesyslabs/dacs/wire");

const approved = { chainIdentity: fromWireExport.TP1_APPROVED_IDENTITY_RECORD.chainIdentity };

describe("the node endpoint leaf", () => {
  it("is the same function from the built file, the leaf export and the wire export", () => {
    expect(typeof fromDist.canonicalNodeEndpoint).toBe("function");
    expect(fromLeafExport.canonicalNodeEndpoint).toBe(fromDist.canonicalNodeEndpoint);
    expect(fromWireExport.canonicalNodeEndpoint).toBe(fromDist.canonicalNodeEndpoint);
  });

  it("keeps the approved chain identity it compares with equal to the approved record's", () => {
    expect(fromDist.TP1_APPROVED_CHAIN_IDENTITY).toBe(approved.chainIdentity);
  });

  it("has no import statement in its source or its built file", () => {
    for (const file of [sourceFile, leafFile]) {
      const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code, file).not.toMatch(/\bimport\b|\brequire\s*\(|\bfrom\s+["']/);
    }
  });

  for (const [name, canonicalNodeEndpoint] of [["the built file", fromDist.canonicalNodeEndpoint], ["the leaf export", fromLeafExport.canonicalNodeEndpoint]] as const) {
    describe(`through ${name}`, () => {
      it("accepts plain http only under the approved chain identity", () => {
        expect(canonicalNodeEndpoint("http://h/", approved)).toBe("http://h/");
        expect(canonicalNodeEndpoint("http://203.0.113.7:53550/", approved)).toBe("http://203.0.113.7:53550/");
        for (const chainIdentity of ["d".repeat(64), `0x${approved.chainIdentity}`, approved.chainIdentity.toUpperCase(), "demos-testnet", null, undefined]) {
          expect(canonicalNodeEndpoint("http://h/", { chainIdentity })).toBeNull();
        }
        expect(canonicalNodeEndpoint("http://h/")).toBeNull();
        expect(canonicalNodeEndpoint("http://localhost:53550/")).toBeNull();
      });

      it("accepts an https root with or without a chain identity", () => {
        for (const options of [undefined, {}, approved, { chainIdentity: "d".repeat(64) }]) expect(canonicalNodeEndpoint("https://h/", options)).toBe("https://h/");
      });

      it("refuses a path, credentials, query or fragment over either scheme, even with the approved identity", () => {
        for (const scheme of ["http", "https"]) {
          for (const endpoint of [`${scheme}://h/rpc`, `${scheme}://u:p@h/`, `${scheme}://u@h/`, `${scheme}://h/?x=1`, `${scheme}://h/#f`, `${scheme}://h`, `${scheme}://H/`, `${scheme}://h/?`, `${scheme}://h/#`, `${scheme}://h:/`]) {
            expect(canonicalNodeEndpoint(endpoint, approved), endpoint).toBeNull();
          }
        }
        for (const endpoint of ["ws://h/", "file:///", "h", "", 443, null, undefined, new URL("https://h/")]) expect(canonicalNodeEndpoint(endpoint, approved)).toBeNull();
      });
    });
  }
});

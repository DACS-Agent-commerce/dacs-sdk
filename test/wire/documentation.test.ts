import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const docs = resolve("docs");
const names = readdirSync(docs).filter(name => ["testnet-profile-tp1.md", "about-the-testnet-release.md", "dacs-seller-http-v1.md"].includes(name));
describe("TP-1 documentation available on this stack prefix", () => {
  it.each(names)("links only to available local evidence in %s", name => {
    const file = resolve(docs, name), text = readFileSync(file, "utf8");
    for (const [, href] of text.matchAll(/\]\(([^)]+)\)/g)) {
      if (!href || /^(?:https?:|#)/.test(href)) continue;
      const target = href.split("#")[0];
      if (target) expect(existsSync(resolve(dirname(file), target)), `${name}: ${href}`).toBe(true);
    }
  });
  it("names the internal profile record until the wire package export exists", () => {
    const pkg: { exports: Record<string, unknown> } = JSON.parse(readFileSync("package.json", "utf8"));
    if (!pkg.exports["./wire"]) {
      for (const name of names) expect(readFileSync(resolve(docs, name), "utf8")).not.toContain("`@kynesyslabs/dacs/wire`");
    }
  });
  it("promises user labels only for the gaps which have them", () => {
    expect(readFileSync(resolve(docs, "testnet-profile-tp1.md"), "utf8")).not.toContain("Every gap below carries a label wherever a user meets it");
  });
});

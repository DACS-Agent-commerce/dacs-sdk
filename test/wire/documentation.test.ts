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
  it.each(names)("cites existing local source and tests in %s", name => {
    const text = readFileSync(resolve(docs, name), "utf8");
    for (const [, path] of text.matchAll(/`((?:src|test)\/[A-Za-z0-9_./-]+\.(?:ts|json|mjs))`/g)) {
      if (path) expect(existsSync(path), `${name}: ${path}`).toBe(true);
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

it("scopes the discovery and CA-7 contract to its actual keys and routes", () => {
  const text = readFileSync(resolve(docs, "dacs-seller-http-v1.md"), "utf8");
  expect(text).toContain("key of the seller claim named by `payload.seller`");
  expect(text).not.toMatch(/(?:on|On|every) every seller route|on\s+every seller route/);
  expect(text).toContain("before Agreement or commitment signature interpretation");
  expect(text).toContain("Read routes enforce retained request scope");
});

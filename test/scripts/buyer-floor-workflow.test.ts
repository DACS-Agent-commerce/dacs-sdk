import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { parse } from "yaml";

type Step = { name?: string; run?: string };
type Job = { strategy?: { "fail-fast"?: boolean; matrix?: Record<string, unknown> }; steps: Step[] };

const ci = parse(readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8")) as { jobs: { "build-test": Job; "buyer-minimum-runtime": Job } };
const floor = ci.jobs["buyer-minimum-runtime"];
const buyerRoot = ci.jobs["build-test"].steps.find(step => step.name?.startsWith("Package smoke (buyer root"));
const runLines = (steps: Step[]) => steps.flatMap(step => step.run?.split("\n") ?? []).map(line => line.trim());

test("the buyer floor job runs both declared engine floors to completion", () => {
  assert.ok(floor);
  assert.deepEqual(floor.strategy?.matrix?.["node-version"], ["22.13.0", "23.4.0"]);
  assert.equal(floor.strategy?.["fail-fast"], false);
});

test("every packed buyer consumer installs without running package scripts", () => {
  assert.ok(buyerRoot);
  const installs = runLines([buyerRoot, ...floor.steps]).filter(line => line.startsWith("npm install"));
  assert.equal(installs.length, 2);
  for (const line of installs) assert.match(line, / --ignore-scripts /);
});

test("the buyer floor job runs only the public API source test", () => {
  const targets = runLines(floor.steps).filter(line => line.startsWith("node --test")).map(line => line.split(" ").at(-1));
  assert.deepEqual(targets, ["packages/dacs-client/test/public-api.test.mjs"]);
});

test("the Node 20 buyer smoke imports only the package root", () => {
  assert.ok(buyerRoot?.run);
  assert.deepEqual([...buyerRoot.run.matchAll(/import\('([^']+)'\)/g)].map(match => match[1]), ["@kynesyslabs/dacs-client"]);
});

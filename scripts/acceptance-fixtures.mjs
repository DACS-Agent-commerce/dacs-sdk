#!/usr/bin/env node
import { existsSync, mkdirSync } from "node:fs";
import { POLICY_SOURCES } from "./registry-container-disposition.mjs";
import { collectEvidence } from "./acceptance-seal.mjs";

const [evidence, destination] = process.argv.slice(2);
if (!evidence || !destination) throw new Error("usage: acceptance-fixtures.mjs <evidence-directory> <fixture-directory>");
mkdirSync(destination, { recursive: true });
if (existsSync(evidence)) {
  const sources = ["acceptance-summary.json", ...POLICY_SOURCES]
    .map(name => name === "engine-strict.log" ? [name, "engine-strict.log.txt"] : name);
  collectEvidence(evidence, destination, sources, { optional: true });
}

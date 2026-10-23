import { release } from "./release-checks.mjs";
if (process.argv.length !== 2) throw new Error("usage: node scripts/check-release-packages.mjs");
await release("check");

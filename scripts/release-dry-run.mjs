import { release } from "./release-checks.mjs";
if (process.argv.length !== 2) throw new Error("usage: node scripts/release-dry-run.mjs");
await release("dry-run");

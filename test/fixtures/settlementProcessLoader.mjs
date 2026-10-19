import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Run the source fixtures in plain Node 20/22 without a test runner, sockets,
// generated dist files, or a second installation of the SDK.
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
    const source = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
    if (existsSync(fileURLToPath(source))) return { url: source.href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

// Transpiling the SDK graph is most of a child's start-up. The harness gives each
// scenario a cache keyed by URL and source, so only its first child pays for it
// (and for loading TypeScript). Entries are published by rename.
const cache = process.env.DACS_TEST_TRANSPILE_CACHE;
let typescript;

async function transpile(url, source) {
  const entry = cache && join(cache, `${createHash("sha256").update(`${url}\0${source}`).digest("hex")}.js`);
  if (entry) {
    try { return await readFile(entry, "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  typescript ??= (await import("typescript")).default;
  const output = typescript.transpileModule(source, {
    compilerOptions: { module: typescript.ModuleKind.ESNext, target: typescript.ScriptTarget.ES2022 },
    fileName: fileURLToPath(url),
  }).outputText;
  if (entry) {
    await mkdir(cache, { recursive: true, mode: 0o700 });
    const temporary = `${entry}.${process.pid}.tmp`;
    await writeFile(temporary, output, { mode: 0o600 });
    await rename(temporary, entry);
  }
  return output;
}

export async function load(url, context, nextLoad) {
  if (url.startsWith("file:") && url.endsWith(".ts")) {
    const source = await readFile(fileURLToPath(url), "utf8");
    return { format: "module", source: await transpile(url, source), shortCircuit: true };
  }
  return nextLoad(url, context);
}

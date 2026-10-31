// Lightweight Node workers share source modules without starting more Vitest controllers.
import { existsSync, readFileSync } from "node:fs";
import ts from "typescript";

export async function resolve(specifier, context, nextResolve) {
  try { return await nextResolve(specifier, context); }
  catch (error) {
    if (error.code === "ERR_MODULE_NOT_FOUND" && specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
      const target = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
      if (existsSync(target)) return { url: target.href, shortCircuit: true };
    }
    throw error;
  }
}

export async function load(url, context, nextLoad) {
  if (!url.endsWith(".ts")) return nextLoad(url, context);
  const source = ts.transpileModule(readFileSync(new URL(url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }, fileName: new URL(url).pathname,
  }).outputText;
  return { format: "module", source, shortCircuit: true };
}

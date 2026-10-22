import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('.js') && specifier.startsWith('.') && context.parentURL?.endsWith('.ts')) {
    const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
    if (existsSync(url)) return { url: url.href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  // Boundary-only session probes do not evaluate parser recipes. Missing
  // optional parser packages may be replaced by a seam that throws on use;
  // it can never manufacture a successful verification.
  if (process.env.DACS_SWEEP_NO_PARSER === '1' && url.endsWith('/conformantParserEngine.ts')) {
    return { format: 'module', source: `
      export const defaultParserEngineCapabilities = Object.freeze({});
      export const defaultParserEngine = Object.freeze({
        evalPredicate() { throw new Error('parser unavailable in session admission probe'); },
        extract() { throw new Error('parser unavailable in session admission probe'); },
      });`, shortCircuit: true };
  }
  if (url.endsWith('.ts')) return { format: 'module', source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8'), { mode: 'transform' }), shortCircuit: true };
  return nextLoad(url, context);
}

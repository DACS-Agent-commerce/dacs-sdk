import { readFile } from 'node:fs/promises';
// This slice exports no store yet. Exercise its kernel lease implementation
// without adding a production API solely for tests.
export async function leaseInternals() {
  const url = new URL('../../src/dacs/seller-durable-state.mjs', import.meta.url);
  let source = await readFile(url, 'utf8');
  source = source.replaceAll("'@kynesyslabs/dacs'", JSON.stringify(import.meta.resolve('@kynesyslabs/dacs')))
    .replaceAll("'better-sqlite3'", JSON.stringify(import.meta.resolve('better-sqlite3')))
    .replaceAll("'./fixture-anchors.mjs'", JSON.stringify(new URL('fixture-anchors.mjs', url).href));
  return import(`data:text/javascript;base64,${Buffer.from(source + '\nexport { takeLease, leaseState, holderState, holderRunsHere, lockHolder, NAMESPACE, PROCESS };').toString('base64')}`);
}

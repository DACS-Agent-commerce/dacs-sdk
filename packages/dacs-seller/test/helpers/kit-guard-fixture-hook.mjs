// Module-customization hook behind kit-guard-fixture.mjs. It serves the guard
// module's own source with the switch set to 'testnet-tp1' and a test-only
// setter, so the substitute can never drift from the real guard's functions
// and error class. It lives outside `files` and `src`: the package ships no
// way to admit.
const OFF_DECLARATION = "export const KIT_OPERATION_GUARD = 'off';";
const ADMITTED_DECLARATION = "export let KIT_OPERATION_GUARD = 'testnet-tp1';\nexport function setKitOperationGuardForTest(value) { KIT_OPERATION_GUARD = value; }";
const substituted = new Set();

/** Receives the guard URLs a `register(..., { data })` call asks this hook to serve. */
export async function initialize({ guardUrls }) {
  for (const url of guardUrls) substituted.add(url);
}

/** Serves an admitted copy of a listed guard module; every other module loads unchanged. Throws if the guard's switch line changed shape. */
export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (!substituted.has(url)) return loaded;
  const source = String(loaded.source);
  if (source.includes(ADMITTED_DECLARATION)) return loaded;
  if (!source.includes(OFF_DECLARATION)) throw new Error(`the guard fixture cannot find the switch declaration in ${url}`);
  return { ...loaded, source: source.replace(OFF_DECLARATION, ADMITTED_DECLARATION) };
}

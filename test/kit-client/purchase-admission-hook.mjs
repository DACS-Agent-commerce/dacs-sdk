// Module-customization hook behind test-loader.mjs. It serves the client's admission-state module from its own source with
// the one constant set to 'testnet-tp1', so the real admission wrapper and the original actions run in the harness process.
// It lives outside every package: the shipped client stays held.
export const HELD_DECLARATION = "export const PURCHASE_ADMISSION = 'held';";
export const ADMITTED_DECLARATION = "export const PURCHASE_ADMISSION = 'testnet-tp1';";
let admissionStateUrl;

/** Receives the URL of the one admission-state module this hook serves. */
export async function initialize({ url }) {
  admissionStateUrl = url;
}

/** Returns `source` with the held declaration replaced by the admitted one. Throws if the held declaration is not there exactly once. */
export function admitPurchases(source, url) {
  if (source.split(HELD_DECLARATION).length !== 2) throw new Error(`the harness loader cannot find the one hold declaration in ${url}`);
  return source.replace(HELD_DECLARATION, ADMITTED_DECLARATION);
}

/** Serves the admitted copy of the admission-state module; every other module loads unchanged. */
export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  return url === admissionStateUrl ? { ...loaded, source: admitPurchases(String(loaded.source), url) } : loaded;
}

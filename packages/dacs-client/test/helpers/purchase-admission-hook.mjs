// Test-only resolve hook (DC-CW1): maps the hold constant's module to the double.
// registerHooks exists from Node 22.15; module.register works at the 22.13 floor.
import * as moduleApi from 'node:module';

const STATE_MODULE = /\/purchase-admission-state\.mjs$/;
const DOUBLE_URL = new URL('./purchase-admission-double.mjs', import.meta.url).href;

export function resolve(specifier, context, next) {
  return STATE_MODULE.test(specifier) ? { url: DOUBLE_URL, shortCircuit: true } : next(specifier, context);
}

/** Install before the first dynamic import of any module under src/. */
export function installPurchaseAdmissionHook() {
  if (moduleApi.registerHooks) moduleApi.registerHooks({ resolve });
  else moduleApi.register(import.meta.url);
}

export async function loadAdmissionDouble() {
  return import(DOUBLE_URL);
}

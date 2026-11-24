// Registers the stored-flow loader before any client source loads. Its hook lets a test answer the seller requests of a
// public protocol service from a fetch stand-in, through the seller HTTPS client the service really uses.
import * as moduleApi from 'node:module';
import { resolve } from './stored-request-flow-loader.mjs';
if (moduleApi.registerHooks) moduleApi.registerHooks({ resolve });
else moduleApi.register(new URL('./stored-request-flow-loader.mjs', import.meta.url));
const SELLER = Symbol.for('TEST-seller-stand-in');
/** Runs `build`, a protocol service construction, so that the service's seller requests are answered by `seller(url, init)`. */
export function withSeller(seller, build) {
  globalThis[SELLER] = seller;
  try { return build(); } finally { delete globalThis[SELLER]; }
}

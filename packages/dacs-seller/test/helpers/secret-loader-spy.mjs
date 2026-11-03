// A pass-through spy for @kynesyslabs/dacs-node/secrets, served by
// secret-loader-spy-hook.mjs in place of the package subpath. It runs the real
// loader and records what the caller passed and did: the exact options, every
// bytes() copy, and the order of redact and destroy calls.
import { DacsSecretLoadError, loadDacsSecretV1 as loadWithRealLoader } from '../../../dacs-node/dist/secrets.js';

export { DacsSecretLoadError };

/** One entry per loader call: { options, copies, events, error }. */
export const calls = [];
/**
 * While `loaderUserId` is set, the real loader sees this user id, so a file owned by this process reads as owned by another user.
 * While `source` is set, the loaded secret reports it as its source.
 */
export const controls = { loaderUserId: null, source: null };

/** Forgets every recorded call. */
export function reset() {
  calls.length = 0;
  controls.loaderUserId = null;
  controls.source = null;
}

async function loadAsOtherUser(options) {
  if (controls.loaderUserId === null) return loadWithRealLoader(options);
  const original = process.getuid;
  process.getuid = () => controls.loaderUserId;
  try { return await loadWithRealLoader(options); } finally { process.getuid = original; }
}

/** The real loader's answer, wrapped so each use is recorded. */
export async function loadDacsSecretV1(options) {
  const call = { options: structuredClone(options), copies: [], events: [], error: null };
  calls.push(call);
  let secret;
  try { secret = await loadAsOtherUser(options); } catch (error) { call.error = error; throw error; }
  return Object.freeze({
    get source() { return controls.source ?? secret.source; },
    get warningCodes() { return secret.warningCodes; },
    get destroyed() { return secret.destroyed; },
    bytes() { call.events.push('bytes'); const copy = secret.bytes(); call.copies.push(copy); return copy; },
    text: () => secret.text(),
    redact(value) { call.events.push('redact'); return secret.redact(value); },
    destroy() { call.events.push('destroy'); secret.destroy(); },
    toJSON: () => secret.toJSON(),
  });
}

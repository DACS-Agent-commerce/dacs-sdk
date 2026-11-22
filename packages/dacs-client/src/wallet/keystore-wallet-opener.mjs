// The buyer's keystore wallet entry: checks its options, the runtime floor and the host's stop, reads the plugin's keystore once and
// composes the wallet session with the phrase. Internal: no package entry exports this module; `node-wallet-session.mjs` binds it.
import { isAbsolute } from 'node:path';
import { OperationError } from '../client-errors.mjs';
import { assertPurchaseRuntime } from '../public-admission.mjs';
import { normalizeDemosAddress } from '../signatures.mjs';
import { readKeystorePhrase } from './keystore-file.mjs';

/** What the native transport and the effect history call on the journal. */
export const JOURNAL_METHODS = Object.freeze(['get', 'put', 'entries', 'withWalletLock', 'appendUnderLock', 'withOwnedOrAcquiredLane']);
// The entry's pass rule is fixed; an option naming it is refused, never read.
const REFUSED_OPTIONS = ['key', 'passRequired', 'jobContextRequired', 'requirePass'];
const KEYSTORE_OPTIONS = ['keystorePath', 'passphrase', 'expectedAddress'];
const POSITIVE_OS_AMOUNT = /^[1-9][0-9]*$/;

const fail = (code, cause) => { throw new OperationError(code, code, undefined, cause === undefined ? undefined : { cause }); };

function checkOptions(options) {
  if (options === null || typeof options !== 'object') throw new TypeError('options must be an object');
  for (const name of REFUSED_OPTIONS) if (name in options) throw new TypeError(`${name} is not an option of the keystore entry`);
  const { keystorePath, passphrase, expectedAddress, stopped, approve, feeCeilingOs, journal } = options;
  if (typeof keystorePath !== 'string' || !isAbsolute(keystorePath)) throw new TypeError('keystorePath must be an absolute path');
  if (typeof passphrase !== 'string' || passphrase.length === 0) throw new TypeError('passphrase must be a non-empty string');
  let expected;
  try { expected = normalizeDemosAddress(expectedAddress); } catch { throw new TypeError('expectedAddress must be a Demos address'); }
  if (typeof stopped !== 'function') throw new TypeError('stopped must be a function');
  if (typeof approve !== 'function') throw new TypeError('approve must be a function');
  if (typeof feeCeilingOs !== 'string' || !POSITIVE_OS_AMOUNT.test(feeCeilingOs)) throw new TypeError('feeCeilingOs must be a positive decimal OS amount');
  if (!JOURNAL_METHODS.every(name => typeof journal?.[name] === 'function')) throw new TypeError(`the journal needs ${JOURNAL_METHODS.join(', ')}`);
  return expected;
}

// The host's stop, asked once before the file is opened: it must answer a boolean synchronously.
function checkStop(stopped) {
  let isStopped;
  try { isStopped = stopped(); } catch (cause) { fail('stop_check_failed', cause); }
  // A promise is refused; its later rejection must not become an unhandled one.
  if (isStopped instanceof Promise) isStopped.catch(() => {});
  if (typeof isStopped !== 'boolean') fail('stop_check_invalid');
  if (isStopped) fail('writes_stopped');
}

/**
 * createKeystoreWalletOpener({compose}) returns `open(options)`, which resolves to what `compose` resolves to. Throws TypeError(compose_required)
 * unless `compose` is a function. `open` runs, in order: the option checks (TypeError naming the option, including for `key` or any pass-rule option),
 * the purchase runtime floor (runtime_unsupported), one synchronous `stopped()` (writes_stopped | stop_check_failed | stop_check_invalid), one read of
 * the keystore through `readKeystorePhrase`, `compose({...options without keystorePath, passphrase and expectedAddress, key})`, and the composed wallet's
 * address against `expectedAddress` (keystore_address_mismatch, after the composition is closed). The phrase array is zero-filled on every outcome.
 */
export function createKeystoreWalletOpener({ compose } = {}) {
  if (typeof compose !== 'function') throw new TypeError('compose_required');
  return async function openKeystoreWallet(options) {
    const expected = checkOptions(options);
    assertPurchaseRuntime(process.version);
    checkStop(options.stopped);
    // The composition's options: everything but the three keystore options, so compose never sees the passphrase.
    const session = Object.fromEntries(Object.entries(options).filter(([name]) => !KEYSTORE_OPTIONS.includes(name)));
    const key = readKeystorePhrase({ path: options.keystorePath, passphrase: options.passphrase });
    try {
      const composition = await compose({ ...session, key });
      let address;
      try { address = normalizeDemosAddress(composition.wallet.getPublicAccount().address); } catch { address = null; }
      if (address !== expected) {
        try { await composition.close(); } catch (cause) { fail('keystore_address_mismatch', cause); }
        fail('keystore_address_mismatch');
      }
      return composition;
    } finally {
      key.fill(0);
    }
  };
}

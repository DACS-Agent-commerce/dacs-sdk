// Test-only signing composition for a seller agent built outside the host: the given signer as the effect role, a
// journal-only integrity role and a read-only answer role over it, and an effect boundary of its own over a fresh history
// directory, bound with the wire fixture's authority reader; and an issued runCreate over such a boundary for the Vet provider
// and the Listing publisher. Never in `files`, never under `src/`.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TP1_APPROVED_IDENTITY_RECORD, bindTp1Profile } from '@kynesyslabs/dacs/wire';
import { WRITE_FEE_CEILING_OS, createEffectBoundary } from '../../src/dacs/effect-boundary.mjs';
import { createEffectHistory } from '../../src/dacs/effect-history.mjs';
import { SELLER_STATE_SIGNING_DOMAIN } from '../../src/dacs/seller-durable-state.mjs';
import { createSellerCreatePass } from '../../src/devnet-demo/create-pass.mjs';
import { TEST_CONNECTION, authorityReader } from './wire-authority-fixture.mjs';

const JOURNAL_DOMAIN = Buffer.from(SELLER_STATE_SIGNING_DOMAIN);
const histories = [];
process.on('exit', () => { for (const directory of histories) rmSync(directory, { recursive: true, force: true }); });

/** The effect boundary's clock: a monotonic source and a cancellable timer, as the host composes it. */
export const MONOTONIC_CLOCK = Object.freeze({
  now: () => performance.now(),
  after: (ms, callback) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); },
});

/** The binding every test boundary is built over: the approved TP-1 record, the test connection and an admitting reader. */
export const TEST_BINDING = await bindTp1Profile({ record: TP1_APPROVED_IDENTITY_RECORD, local: { ...TEST_CONNECTION }, readAuthority: authorityReader() });

const READ_ONLY_PURPOSES = Object.freeze(['discovery', 'read-answer', 'refusal']);

/**
 * A read-only answer role over `signer`, in the shape of the key's `readOnlyAnswerSigner`: `({ purpose })` resolves a signer that
 * signs once. It refuses a purpose other than discovery, read-answer or refusal with a TypeError; it checks no binding.
 */
export function readOnlyRoleOf(signer) {
  return async ({ purpose }) => {
    if (!READ_ONLY_PURPOSES.includes(purpose)) throw new TypeError(`TEST read-only role: purpose ${purpose}`);
    let used = false;
    return Object.freeze({ claim: signer.claim, async sign(bytes) {
      if (used) throw new TypeError('TEST read-only role: single use');
      used = true;
      return signer.sign(bytes);
    } });
  };
}

/** A journal-only role over `signer`, as the key's integrity role: it refuses any bytes outside the seller-state domain. */
export function integrityRoleOf(signer) {
  return Object.freeze({
    claim: signer.claim,
    sign(bytes) {
      if (!Buffer.from(bytes).subarray(0, JOURNAL_DOMAIN.length).equals(JOURNAL_DOMAIN)) throw new TypeError('TEST integrity role: not seller-state journal bytes');
      return signer.sign(bytes);
    },
  });
}

/**
 * A new effect boundary, `{ effectBoundary, dataDirectory }`, over the history in `dataDirectory` (given, as for a restart
 * over the same directory, or a new temporary one removed when the process exits). `stopped()` defaults to never
 * stopped; `binding` to TEST_BINDING, `currentLocal()` to the test connection and `clock` to MONOTONIC_CLOCK.
 */
export function testEffectBoundary({ stopped = () => false, dataDirectory = null, binding = TEST_BINDING, currentLocal = () => ({ ...TEST_CONNECTION }), clock = MONOTONIC_CLOCK } = {}) {
  if (dataDirectory === null) {
    dataDirectory = mkdtempSync(join(tmpdir(), 'TEST-agent-effects-'));
    histories.push(dataDirectory);
  }
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const effectBoundary = createEffectBoundary({ stopped, binding, currentLocal, feeCeilingOs: String(WRITE_FEE_CEILING_OS), history: createEffectHistory({ dataDirectory }), clock });
  return { effectBoundary, dataDirectory };
}

/**
 * An in-memory wallet session for createSellerCreatePass: a connection fence whose release does nothing, a pass that is its
 * input, and a pass run that awaits the pass's refresh and final stop, runs its synchronous checks, then runs the work.
 */
export const TEST_PASS_SESSION = Object.freeze({
  acquireConnectionFence: async () => Object.freeze({ release() {} }),
  effectPass: (input) => input,
  async runInEffectPass(handle, work) {
    await handle.refreshAuthority();
    await handle.finalStop();
    for (const check of handle.synchronousChecks) check();
    return work();
  },
});

/** An issued runCreate over `effectBoundary` (a new test boundary over `stopped` by default) and TEST_PASS_SESSION: `{ runCreate }`. */
export const testRunCreate = ({ stopped = () => false, effectBoundary = testEffectBoundary({ stopped }).effectBoundary } = {}) =>
  createSellerCreatePass({ effectBoundary, session: TEST_PASS_SESSION, stopped, feeCeilingOs: String(WRITE_FEE_CEILING_OS), clock: MONOTONIC_CLOCK });

/**
 * The signing options of createSellerAgent for `signer`: `{ effectSigner, integritySigner, readOnlyAnswerSigner, effectBoundary }`,
 * the boundary new, over `historyDirectory` when one is given.
 */
export const agentSigning = (signer, { historyDirectory = null } = {}) => ({ effectSigner: signer, integritySigner: integrityRoleOf(signer),
  readOnlyAnswerSigner: readOnlyRoleOf(signer), effectBoundary: testEffectBoundary({ dataDirectory: historyDirectory }).effectBoundary });

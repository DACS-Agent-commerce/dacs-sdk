// Test-only signing composition for a seller agent built outside the host: the given signer as the effect role, a
// journal-only integrity role over it, and an effect boundary of its own over a fresh history directory, bound with
// the wire fixture's authority reader. Never in `files`, never under `src/`.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TP1_APPROVED_IDENTITY_RECORD, bindTp1Profile } from '@kynesyslabs/dacs/wire';
import { WRITE_FEE_CEILING_OS, createEffectBoundary } from '../../src/dacs/effect-boundary.mjs';
import { createEffectHistory } from '../../src/dacs/effect-history.mjs';
import { SELLER_STATE_SIGNING_DOMAIN } from '../../src/dacs/seller-durable-state.mjs';
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
 * stopped; the connection is the test connection.
 */
export function testEffectBoundary({ stopped = () => false, dataDirectory = null } = {}) {
  if (dataDirectory === null) {
    dataDirectory = mkdtempSync(join(tmpdir(), 'TEST-agent-effects-'));
    histories.push(dataDirectory);
  }
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const effectBoundary = createEffectBoundary({ stopped, binding: TEST_BINDING, currentLocal: () => ({ ...TEST_CONNECTION }),
    feeCeilingOs: String(WRITE_FEE_CEILING_OS), history: createEffectHistory({ dataDirectory }), clock: MONOTONIC_CLOCK });
  return { effectBoundary, dataDirectory };
}

/**
 * The signing options of createSellerAgent for `signer`: `{ effectSigner, integritySigner, effectBoundary }`, the boundary
 * new, over `historyDirectory` when one is given.
 */
export const agentSigning = (signer, { historyDirectory = null } = {}) => ({ effectSigner: signer, integritySigner: integrityRoleOf(signer),
  effectBoundary: testEffectBoundary({ dataDirectory: historyDirectory }).effectBoundary });

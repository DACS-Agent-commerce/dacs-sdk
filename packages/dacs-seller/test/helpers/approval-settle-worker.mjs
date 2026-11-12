// A second process that settles a retained authorization, paused while it holds the policy lock.
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';
import { address, seller, sourceBinding, artifactAuthority, pin, deliveredHashFor, T0 } from './d5-policy-fixtures.mjs';
import { installNoNetworkTrap } from './no-network-trap.mjs';

// A network call here throws inside the worker, which then exits non-zero and fails the parent test.
installNoNetworkTrap();

const [input] = await once(process, 'message');
const readFile = fs.readFile; let paused = false;
fs.readFile = async (path, ...args) => {
  if (path !== input.evidencePath || paused) return readFile(path, ...args);
  paused = true;
  let value, failure;
  try { value = await readFile(path, ...args); } catch (error) { failure = error; }
  const continued = once(process, 'message'); process.send({ type: 'reading' }); await continued;
  if (failure) throw failure;
  return value;
};
syncBuiltinESMExports();
try {
  const { composeSellerApproval, createExactOperatorApproval } = await import('../../src/devnet-demo/operator-approval.mjs');
  const policy = createExactOperatorApproval({
    maxTotalOs: input.maxTotalOs, evidencePath: input.evidencePath, now: () => T0, sellerApproval: { mode: 'policy' },
    policy: {
      address, seller, sourceBinding, artifactAuthority, listingPin: () => pin, paymentPhaseIndex: () => 2, deliveryPhaseIndex: () => 3, deliveredPayloadHash: deliveredHashFor,
      resolvePurchase: async () => { throw new Error('settle does not read the purchase'); },
    },
  });
  const approval = composeSellerApproval({ mode: 'policy', policy, manual: async () => false });
  await approval.retained.settle({ ledgerId: input.ledgerId, requestText: input.requestText }, 'spent');
  await policy.stop();
  process.send({ type: 'result' });
} catch (error) {
  process.send({ type: 'error', code: error.code, message: error.message });
  process.exitCode = 1;
} finally { process.disconnect(); }

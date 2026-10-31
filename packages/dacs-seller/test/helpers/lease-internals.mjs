import { privateModule } from './private-module.mjs';
// Exercise the kernel lease without adding a production API solely for tests.
export async function leaseInternals() {
  return privateModule(new URL('../../src/dacs/seller-durable-state.mjs', import.meta.url),
    ['takeLease', 'leaseState', 'holderState', 'holderRunsHere', 'lockHolder', 'NAMESPACE', 'PROCESS']);
}

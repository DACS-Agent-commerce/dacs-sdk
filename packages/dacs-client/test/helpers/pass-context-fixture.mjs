// Test-only trusted composition: runs a transport call inside a private per-pass context,
// as the Node wallet session's composition does for a seller job pass. Never shipped.
import { passContext, runInPassContext } from '../../src/wallet/pass-context.mjs';

/** Runs `work()` with the pass context `options` describe (`operationClass`, `operationId`, `currentAuthorization`). */
export const inPass = (options, work) => runInPassContext(passContext(options), work);

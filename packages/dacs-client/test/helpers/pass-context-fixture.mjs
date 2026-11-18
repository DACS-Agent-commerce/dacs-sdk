// Test-only: runs a transport call inside a per-pass context made by `passContext`, with no effect gate in front,
// as the transport sees it when a job pass is open. Never shipped.
import { passContext, runInPassContext } from '../../src/wallet/pass-context.mjs';

/** Runs `work()` with the pass context `options` describe (`operationClass`, `operationId`, `currentAuthorization`). */
export const inPass = (options, work) => runInPassContext(passContext(options), work);

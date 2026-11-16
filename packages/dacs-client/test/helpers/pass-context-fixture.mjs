// Test-only trusted composition: installs a private pass context around a real transport
// call, the way the session's composition does for a pass it classified. `spec` is
// `{ operationClass, operationId?, currentAuthorization? }`; the context is built by the
// module's own factory, so it is branded, and nothing a request carries can stand in for it.
import { passContext, runInPassContext } from '../../src/wallet/pass-context.mjs';

export const underPass = (spec, work) => runInPassContext(passContext(spec), work);

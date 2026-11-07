// Run as a child by off-state.test.mjs: reports whether the client's real purchase hold admits in this process.
import { purchaseActionsAdmitted } from '../../packages/dacs-client/src/public-admission.mjs';

process.stdout.write(JSON.stringify({ admitted: purchaseActionsAdmitted() }));

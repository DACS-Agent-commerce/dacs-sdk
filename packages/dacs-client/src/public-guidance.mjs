import { purchaseNext as admittedPurchaseNext, PURCHASE_STATUS_HELP as ADMITTED_STATUS_HELP, diagnosticPurchaseNext, DIAGNOSTIC_PURCHASE_STATUS_HELP } from './purchases.mjs';
import { protocolView as admittedProtocolView, diagnosticProtocolView } from './dacs/protocol-purchases.mjs';
import { purchaseActionsAdmitted } from './public-admission.mjs';

// The guidance names the root exports follow the one hold constant (DC-CW13):
// each call and each read chooses held or admitted text at that moment.

/** purchaseNext(operation, chainMode) returns the next-step text for a purchase: the historical held text while the hold constant is held, the full text once admitted. Pure; held text never throws, and once admitted a missing operation throws TypeError. */
export const purchaseNext = (operation, chainMode) => (purchaseActionsAdmitted() ? admittedPurchaseNext(operation, chainMode) : diagnosticPurchaseNext(operation));

/** protocolView(operation, options) returns the protocol projection of a purchase, or null without protocol state: the redacted historical view while held, the full view once admitted. Pure; invalid seams throw. */
export const protocolView = (operation, options) => (purchaseActionsAdmitted() ? admittedProtocolView : diagnosticProtocolView)(operation, options);

const statusHelpEntry = (status) => [status, { enumerable: true, get: () => (purchaseActionsAdmitted() ? ADMITTED_STATUS_HELP : DIAGNOSTIC_PURCHASE_STATUS_HELP)[status] }];

/** PURCHASE_STATUS_HELP is a frozen status-to-text map with one enumerable getter per status; each read returns the held or the admitted text at that moment. */
export const PURCHASE_STATUS_HELP = Object.freeze(Object.defineProperties({}, Object.fromEntries(Object.keys(ADMITTED_STATUS_HELP).map(statusHelpEntry))));

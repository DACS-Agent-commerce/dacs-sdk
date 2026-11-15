// Changes one source of a completed payment at a time. Each function returns what restores the source, so one completed payment serves
// every cell. The fixture functions act on `fixturePaymentWorld`, the native ones on `nativePaymentWorld`.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The fixture seller's receipt state file. */
export const fixtureReceiptsFile = (w) => join(w.f.config.durableDirectory, 'sdk-receipts', 'seller-receipts.json');

/** The fixture node answers a read of the transfer with `answer(txHash)`. */
export const arrangeTransfer = (w, answer) => { w.script.observe = answer; return () => { w.script.observe = null; }; };

/** The fixture anchor answers a read of the record at `address` with `change(row)`; a throw is an unreadable record. */
export const arrangeRecord = (w, address, change) => {
  w.f.anchors.controls.read = (row, at) => (at === address ? change(row) : row);
  return () => { w.f.anchors.controls.read = (row) => row; };
};

/** Edits the receipt state in `file` with `change(state)`. */
export const arrangeReceipts = (file, change) => {
  const saved = readFileSync(file, 'utf8'), state = JSON.parse(saved);
  change(state);
  writeFileSync(file, JSON.stringify(state));
  return () => writeFileSync(file, saved);
};

/** The native node serves a storage program whose logical address starts with `prefix` as `change(record)`; a throw is an unreachable node. */
export const nativeRecord = (w, prefix, change) => {
  w.node.script.programRead = (record) => (record?.metadata.logicalAddress.startsWith(prefix) ? change(record) : record);
  return () => { w.node.script.programRead = null; };
};

/** The native node answers a read of the transaction `txHash` with `answer(record)`; a null is not found and a throw an unreachable node. */
export const nativeTransfer = (w, txHash, answer) => {
  w.node.script.transferRead = (hash, record) => (hash === txHash ? answer(record) : record);
  return () => { w.node.script.transferRead = null; };
};

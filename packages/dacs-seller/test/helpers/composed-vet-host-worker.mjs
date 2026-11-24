// Unshipped: the child process of `composedVetHostProcess` (composed-vet-host.mjs). It starts the composed Vet host on the parent's data
// directory and party Vet store, with the parent's anchor answering every Vet record call, pauses the named final await, tells the parent
// when a call is held there and when the wallet makes a Vet component signature, and waits until the parent kills it.
import { once } from 'node:events';
import { KIT_TP1_VET_MODE } from '../../src/host.mjs';
import { composedVetHost, pauseGate } from './composed-vet-host.mjs';
import { seller } from './protocol-fixture.mjs';

const [{ dataDirectory, vetPath, kind, at }] = await once(process, 'message');
const calls = new Map();
let next = 0;
process.on('message', (message) => {
  if (message.type !== 'anchor') return;
  const { resolve, reject } = calls.get(message.id);
  calls.delete(message.id);
  if (message.error) reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
  else resolve(message.value);
});
const call = (method) => (input) => new Promise((resolve, reject) => {
  const id = ++next;
  calls.set(id, { resolve, reject });
  process.send({ type: 'anchor', id, method, input });
});
const anchor = { writer: seller.claim, vetMode: KIT_TP1_VET_MODE, ...Object.fromEntries(['hasIntent', 'read', 'readRetained', 'verifyReceipt', 'publish'].map((method) => [method, call(method)])) };
const gate = pauseGate();
gate.onHeld = () => process.send({ type: 'held' });
// The fixture's cleanup never runs: the parent kills this process and removes its temporary directory.
const world = await composedVetHost({ after() {} }, { gate, dataDirectory, vetPath, anchor });
world.hooks.onSign = () => process.send({ type: 'signed' });
const { host } = await world.start();
gate.pause(kind, at);
process.send({ type: 'started', url: host.url, listingPin: host.listingPin });

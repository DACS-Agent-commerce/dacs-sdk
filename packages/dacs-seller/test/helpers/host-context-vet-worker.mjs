// Unshipped: the child process of `vetHostProcess` (host-context-vet-fixture.mjs). It starts the seller host the Vet evidence tests start,
// on the parent's data directory, with the parent's anchor answering every artifact anchor call, and holds its provider's work after the
// Vet writes until the parent kills it. Nothing here ever closes the host.
import { once } from 'node:events';
import { contextHostFixture } from './host-context-client.mjs';
import { vetProvider } from './host-context-vet-fixture.mjs';

const [{ dataDirectory, writes }] = await once(process, 'message');
const calls = new Map();
let next = 0;
process.on('message', (message) => {
  if (message.type !== 'anchor') return;
  const { resolve, reject } = calls.get(message.id);
  calls.delete(message.id);
  if (message.error) reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
  else resolve(message.value);
});
// The call's options (the host's shutdown signal and limits) stay here: the parent's stand-in anchor reads none of them.
const call = (method) => (input) => new Promise((resolve, reject) => {
  const id = ++next;
  calls.set(id, { resolve, reject });
  process.send({ type: 'anchor', id, method, input });
});
// The fixture's cleanup never runs: the parent kills this process and removes its temporary directory.
const f = await contextHostFixture({ after() {} });
const anchor = { writer: f.native.writer, source: f.native.source, readRetained: call('readRetained'), publish: call('publish'), verifyReceipt: call('verifyReceipt') };
const provider = vetProvider(anchor, writes, { stall: true });
const host = await f.start({ dataDirectory, artifactAnchor: anchor, demDeliveryContext: provider.capability });
process.send({ type: 'started', url: host.url, listingPin: host.listingPin });
await provider.entered.promise;
process.send({ type: 'entered', seen: { ...provider.seen } });

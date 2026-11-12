// The real Agreement source transport, pinned to the SDK-approved TP-1 record, over a
// real durable journal on a temporary file, a queued owner and the scripted TP-1 node.
// `signals` records the AbortSignal of every request the node received. Tests only.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TP1_APPROVED_IDENTITY_RECORD as record } from '@kynesyslabs/dacs/wire';
import { createDevnetAgreementTransport } from '../../src/wallet/devnet-native-transport.mjs';
import { scriptedNode } from './tp1-node-fixture.mjs';
import { queuedOwner } from './queued-owner.mjs';
const { openDurableWalletJournal } = await import('../../src/wallet/durable-journal.mjs');

export const MIB = 1024 * 1024;
export const ok = response => ({ result: 200, response, require_reply: false, extra: null });
export const jsonResponse = (text, headers = {}) => new Response(text, { headers: { 'content-type': 'application/json', ...headers } });

const STREAM_CHUNK_BYTES = 64 * 1024;
const SOURCE_FALLBACK = Object.freeze({ blockZeroUnavailable: 'literal-error', documentation: record.provenance.documentation });

/** A JSON reply of exactly `bytes` bytes, streamed in chunks; `declared` adds the content-length header. */
export function sizedReply(bytes, { declared }) {
  const frame = pad => JSON.stringify(ok({ pad: 'a'.repeat(pad) }));
  const body = Buffer.from(frame(bytes - frame(0).length));
  let at = 0;
  const stream = new ReadableStream({ pull(controller) { if (at >= body.length) controller.close(); else controller.enqueue(body.subarray(at, at += STREAM_CHUNK_BYTES)); } });
  return new Response(stream, { headers: { 'content-type': 'application/json', ...(declared ? { 'content-length': String(body.length) } : {}) } });
}

/** A promise a test settles later, with the settle functions beside it. */
export function deferred() {
  const gate = {};
  gate.promise = new Promise((resolve, reject) => { gate.resolve = resolve; gate.reject = reject; });
  return gate;
}

/** Builds the source transport over `journal` and `owner`; extra options (a reviewed layout, say) pass through. No node is reached unless the owner's fetchImpl reaches one. */
export function sourceReadTransport({ journal, owner, ...options }) {
  const { endpoint, transportAuthority } = owner.local;
  return createDevnetAgreementTransport({
    expected: { network: record.network, chainIdentity: record.chainIdentity, pinVersion: record.pinVersion, endpoint, transportAuthority },
    transportOwner: owner, journal, fetchImpl: (...args) => owner.fetchImpl(...args), fallback: SOURCE_FALLBACK, ...options,
  });
}

/** Returns `{node, owner, journal, transport, path, lockKey, signals}`; everything is closed when the test ends. */
export function sourceReadWorld(t, transportOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'source-read-')), path = join(directory, 'journal.sqlite');
  const node = scriptedNode(), signals = [];
  const owner = queuedOwner({ fetchImpl: (url, init) => { signals.push(init.signal); return node.fetch(url, init); } });
  const journal = openDurableWalletJournal({ path, mode: 'create' });
  const transport = sourceReadTransport({ journal, owner, ...transportOptions });
  t.after(async () => { await transport.close(); journal.close(); rmSync(directory, { recursive: true, force: true }); });
  const lockKey = `devnet/source-read/${transport.profile('https://node-wallet.invalid').transportBinding.bindingId}`;
  return { node, owner, journal, transport, path, lockKey, signals };
}

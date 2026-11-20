// The seller kit keeps no signing code for the transport's two old domains: its sources and packed files do not contain them,
// no removed name is exported, and a request signed under the old domain is refused where the wire opens it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DACS_SELLER_HTTP_HEADER, DACS_SELLER_HTTP_LIMITS } from '@kynesyslabs/dacs/wire';
import { sellerPackFiles } from '../../../scripts/prepare-seller-consumer.mjs';
import { contextWireWorld } from './helpers/context-wire-world.mjs';
import { oldDomainHeader } from './helpers/old-domain-request.mjs';
import { PATHS, identityBody, proposeJob, world } from './helpers/wire-routes-world.mjs';

const packageDirectory = new URL('../', import.meta.url).pathname;
const OLD_DOMAINS = [['dacs-chatgpt-plugin', 'loopback-seller-peer', 'v1', ''].join(':'), ['dacs-chatgpt-plugin', 'seller-session-delegation', 'v1', ''].join(':')];
// Labels that name other things than the transport's signing domains; they stay as they are.
const KEPT_LABELS = [
  ['src/dacs/fixture-anchors.mjs', 'dacs-chatgpt-plugin:loopback-sr2-fixture'],
  ['src/dacs/listing.mjs', 'urn:dacs-chatgpt-plugin:v0.1:seller-defined-delivery'],
  ['src/dacs/seller-durable-state.mjs', 'dacs-chatgpt-plugin:offline-seller-state:v1:'],
  ['src/dacs/agreement-context-consumer.mjs', 'dacs-chatgpt-plugin/operator-agreement-context/v1'],
];
const REMOVED_NAMES = ['createSellerContextClient', 'createSellerTransportClientAuth', 'SELLER_TRANSPORT_HEADER', 'SELLER_TRANSPORT_MAX_RESPONSE', 'SELLER_CONTEXT_PATH',
  'SELLER_CONTEXT_CHALLENGE_PATH', 'sellerTransportSigningBytes', 'sellerSessionDelegationSigningBytes', 'verifySellerSessionDelegation', 'sellerTransportEffect',
  'SELLER_CONTEXT_FRESH_REFUSALS', 'sellerContextRequestUnknown', 'sellerContextReason'];
const MAX_RESPONSE_BYTES = DACS_SELLER_HTTP_LIMITS.maxResponseBodyBytes;

const sourceFiles = (dir = 'src') => readdirSync(join(packageDirectory, dir), { withFileTypes: true })
  .flatMap((entry) => entry.isDirectory() ? sourceFiles(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`]);
const textOf = (file) => readFileSync(join(packageDirectory, file), 'utf8');
const packedModules = () => sellerPackFiles().filter((file) => file.startsWith('src/') && file.endsWith('.mjs')).sort();

test('no kit source or packed file contains either old transport domain', () => {
  const packed = sellerPackFiles();
  assert.ok(packed.length > 0 && sourceFiles().length > 0);
  for (const file of new Set([...sourceFiles(), ...packed])) {
    for (const domain of OLD_DOMAINS) assert.equal(textOf(file).includes(domain), false, `${file} contains an old transport domain`);
  }
});

test('the labels outside the old transport domains are unchanged', () => {
  for (const [file, label] of KEPT_LABELS) assert.ok(textOf(file).includes(label), `${file} keeps ${label}`);
});

test('an old-domain-signed request to the composed host is refused at envelope opening and runs no handler', async (t) => {
  const c = await contextWireWorld(t), context = await c.startContext({ signOptions: { delegated: false } });
  const counters = () => {
    const agentCalls = { ...c.calls };
    delete agentCalls.connection; // the wire's own connection check, made while it opens each request
    return { rows: c.rows(), files: c.journalFiles(), reserved: c.reserved.calls, holds: c.counts.holds.length, validations: c.counts.validations, agentCalls };
  };
  const before = counters();
  const challenge = await c.sign({ delegated: false });
  for (const [name, request] of [['challenge', challenge], ['context', context]]) {
    const answer = await c.post({ url: request.url, header: await oldDomainHeader(request.payload, c.buyer.signBytes), text: request.text });
    assert.deepEqual({ status: answer.status, error: answer.body.error, signed: answer.signature !== undefined }, { status: 401, error: 'peer_signature_invalid', signed: false }, name);
  }
  assert.deepEqual(counters(), before, 'no row, journal file, policy read or agent call');
});

test('no removed name is exported, and every ./src/* file of the packed archive imports', async () => {
  const modules = [await import('../src/index.mjs')];
  for (const file of packedModules()) modules.push(await import(pathToFileURL(join(packageDirectory, file)).href));
  assert.ok(modules.length > 10);
  for (const exported of modules) {
    for (const name of REMOVED_NAMES) assert.equal(Object.hasOwn(exported, name), false, `${name} is still exported`);
  }
});

test('the packed archive has no seller-session-limits module and every files entry exists', () => {
  const packed = sellerPackFiles();
  assert.equal(packed.some((file) => file.includes('seller-session-limits')), false);
  assert.equal(existsSync(join(packageDirectory, 'src/public/portal/seller-session-limits.mjs')), false);
  const { files } = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'));
  for (const entry of files) assert.ok(existsSync(join(packageDirectory, entry.replace(/^!/, ''))), `${entry} is listed in files and exists`);
  for (const file of packed) assert.ok(existsSync(join(packageDirectory, file)), `${file} is packed and exists`);
});

test('the handler signs under the wire header name and refuses an answer over 512 KiB', async (t) => {
  assert.equal(DACS_SELLER_HTTP_HEADER, 'x-dacs-seller-peer');
  const w = await world(t), job = await proposeJob(w, 'oversize-read');
  assert.equal((await job.post()).status, 200, 'the proposal makes the job known');
  const stateOf = (bytes) => { const answer = { pad: '' }; answer.pad = 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(answer))); return answer; };
  const read = () => w.post(PATHS.state, identityBody(job.jobId, job.agreementHash), { jobId: job.jobId, agreementHash: job.agreementHash });
  w.agent.agreementState = () => stateOf(MAX_RESPONSE_BYTES);
  const atLimit = await read();
  assert.equal(atLimit.status, 200);
  assert.equal(Buffer.byteLength(atLimit.text), MAX_RESPONSE_BYTES);
  assert.equal(atLimit.signed, true, `the answer carries the ${DACS_SELLER_HTTP_HEADER} header`);
  await w.verified(atLimit);
  w.agent.agreementState = () => stateOf(MAX_RESPONSE_BYTES + 1);
  const overLimit = await read();
  assert.equal(Buffer.byteLength(JSON.stringify(stateOf(MAX_RESPONSE_BYTES + 1))), 524289);
  assert.deepEqual({ status: overLimit.status, error: overLimit.body.error, signed: overLimit.signed }, { status: 503, error: 'seller_response_too_large', signed: true }, 'the refusal itself is a small signed answer');
  await w.verified(overLimit);
});

// The one Agreement CREATE under a Start (DACS_INTENT_APPROVAL=on), on the
// source-pinned devnet path with the real embedded SDK wallet, the hooked
// session module and the existing broker client: every step of the CREATE
// request is held to the Start until the wallet records it as issued. A Start
// replaced, locked or expired before then starts no new node or source
// request (only the lease release; an in-flight request and its SDK retries
// cannot be recalled) and is never issued; once issued, the
// CREATE is broadcast once and read back whatever happens to the Start. Also:
// the operator RPC auth signatures the CREATE really makes, on the wire.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { startDevnetAgreementTransportHarness } from './helpers/devnet-agreement-transport-harness.mjs';
import { startDevnetAgreementTransportSeller } from './helpers/devnet-agreement-transport-seller.mjs';
import { linkPackagedWallet } from './helpers/offline-agreement-fixture.mjs';
import { tool, tokenFrom } from './helpers/flows.mjs';
import { gatedWallet, CountingDemos, DAY } from './helpers/start-intent.mjs';
import { runStart } from '../public/portal-intent/start-flow.mjs';
import { START_ANNOUNCEMENT } from '../public/portal-intent/gate.mjs';
import { OPERATOR_AUTH_SIGNATURES, OPERATOR_AUTH_TOTAL, operatorAuthLine } from '../public/portal-intent/intent.mjs';
import { createDevnetAgreementWalletTransport } from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { createOfflineAgreementBrokerClient } from '../public/portal/offline-agreement-broker.mjs';

let counter = 0;
// Node2's declared CREATE debit: the 4 DEM ceiling per write (start-intent-devnet).
const NODE2_FEES = { networkFee: 1, rpcFee: 1 };
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
// An operator RPC auth signature: ed25519 by the wallet over sha256("<identity>:<timestamp>").
function authVerifies({ identity, timestamp, signature }) {
  const key = /^ed25519:0x([0-9a-f]{64})$/.exec(identity ?? '')?.[1];
  if (!key || !/^[0-9]+$/.test(timestamp ?? '') || typeof signature !== 'string') return false;
  return verify(null, Buffer.from(sha256(`${identity}:${timestamp}`)), createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(key, 'hex').toString('base64url') }, format: 'jwk' }), Buffer.from(signature.replace(/^0x/, ''), 'hex'));
}

// events: one timeline of what the wallet sends for the CREATE (node requests
// to the same-origin RPC route, source phases to the binding route), the
// journal's issuance records, and the injected drop.
// drop(kind): 'peer' (a peer Start), 'lock' or 'expire' (the gate clock passes the Start's expiry).
// holdBinding: { phase, at } runs `at` while that source response is held.
// afterIssue: runs right after the journal records the CREATE as issued.
async function world(t, { DemosCtor, around, holdBinding = null, afterIssue = null, wireForm = null } = {}) {
  const h = await startDevnetAgreementTransportHarness({ env: { DACS_INTENT_APPROVAL: 'on' }, nativeFees: NODE2_FEES });
  t.after(() => h.close());
  globalThis.location = new URL(h.origin);
  const profile = await h.profile();
  const bindingUrl = new URL(profile.bindingUrl, h.origin).href;
  const rpcUrl = new URL(profile.rpcUrl, h.origin).href;
  const events = [];
  const realFetch = globalThis.fetch;
  const recordWire = async (url, init) => {
    assert.ok(typeof url === 'string' || url instanceof URL || url instanceof Request, 'unrecognised fetch request');
    const request = url instanceof Request ? new Request(url.clone(), init) : new Request(new URL(url, h.origin), init);
    if (request.url === rpcUrl) {
      const event = { to: 'node', what: request.method === 'GET' ? 'connect' : null, identity: request.headers.get('identity'), timestamp: request.headers.get('timestamp'), signature: request.headers.get('signature') };
      events.push(event);
      if (request.method !== 'GET') {
        const body = await request.clone().json();
        event.what = body.method === 'nodeCall' ? body.params?.[0]?.message : body.params?.[0]?.extra;
        assert.equal(typeof event.what, 'string', 'unrecognised node request');
      }
    }
    if (request.url === bindingUrl) {
      const { phase } = await request.clone().json();
      assert.ok(['bind', 'signature', 'broadcast', 'release', 'readback'].includes(phase), 'unrecognised source request');
      events.push({ to: 'source', what: phase, identity: request.headers.get('identity'), timestamp: request.headers.get('timestamp'), signature: request.headers.get('signature') });
      if (holdBinding?.phase === phase) return realFetch(url, init).then(async (response) => { return await holdBinding.at(response) ?? response; });
    }
    return realFetch(url, init);
  };
  globalThis.fetch = async (url, init) => {
    // Exercise fetch's three accepted input forms at both wallet origins.
    const href = url instanceof Request ? url.url : new URL(url, h.origin).href;
    if (wireForm && [rpcUrl, bindingUrl].includes(href)) {
      const request = new Request(url, init);
      if (wireForm === 'Request') return recordWire(request);
      const options = { method: request.method, headers: request.headers, ...(request.method === 'GET' ? {} : { body: await request.clone().text() }) };
      return recordWire(wireForm === 'URL' ? new URL(request.url) : request.url, options);
    }
    return recordWire(url, init);
  };
  t.after(() => { globalThis.fetch = realFetch; });
  let skew = 0;
  let client;
  let w;
  const drop = (kind) => {
    events.push({ to: 'drop', what: kind });
    if (kind === 'peer') w.gate.peerStarted({ type: START_ANNOUNCEMENT, wallet: w.address });
    else if (kind === 'lock') w.session.lock();
    else if (kind === 'expire') skew = DAY;
    else throw new Error(kind);
  };
  const sourceChecks = [];
  w = await gatedWallet({ transactionTransport: createDevnetAgreementWalletTransport(profile), DemosCtor, around: (Fenced) => {
    const Wrapped = around ? around(Fenced) : Fenced;
    return class extends Wrapped {
      holdSourcePhase(phase) { sourceChecks.push({ phase, dropped: events.some((e) => e.to === 'drop') }); return super.holdSourcePhase(phase); }
    };
  }, now: () => Date.now() + skew,
    anchorJournal: {
      get: (k) => client.anchorJournal.get(k),
      put: async (k, v) => {
        events.push({ to: 'journal', what: v?.stage });
        const recorded = await client.anchorJournal.put(k, v);
        if (v?.stage === 'broadcast-started') afterIssue?.(drop);
        return recorded;
      },
      withWalletLock: (k, work) => client.anchorJournal.withWalletLock(k, work),
    } });
  t.after(() => w.session.lock());
  const buyer = await linkPackagedWallet(h, w.session);
  const seller = await startDevnetAgreementTransportSeller(h, { listingId: `intent-fence-${++counter}`, durable: true });
  const prepared = await tool(h, buyer, 'prepare_purchase', { listingId: seller.listing.listingId, version: 1, seller: seller.wallet.claim, idempotencyKey: `intent-fence-${counter}-${Date.now()}`, protocol: 'dacs-sr2-wallet-agreement' });
  assert.equal(prepared.status, 'agreement_pending', JSON.stringify(prepared));
  const id = prepared.operationId, token = tokenFrom(prepared.approvalUrl);
  const api = async (path, body) => {
    const r = await realFetch(`${h.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: h.origin }, body: JSON.stringify(body ?? {}) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.message || `request failed (${r.status})`), { code: data.error });
    return data;
  };
  client = createOfflineAgreementBrokerClient({ id, token, api });
  const recheck = async () => {
    for (let i = 0; i < 120; i++) {
      const view = await api(`/portal/api/purchase/${id}/protocol/recheck`, { token });
      if (!view.poll?.pending) return view;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('recheck did not settle');
  };
  const run = (options = {}) => runStart({ id, token, address: w.address, gate: w.gate, api, origin: h.origin, broker: client, provider: w.session, recheck, ...options });
  const account = h.app.services.accounts.walletOwner(w.address);
  return { h, w, events, drop, run, recheck, recordWire, rpcUrl, bindingUrl, sourceChecks, op: () => h.app.services.ops.get(account, id) };
}
const label = (e) => `${e.to}:${e.what}`;
const afterDrop = (events) => {
  const at = events.findIndex((e) => e.to === 'drop');
  assert.ok(at >= 0, 'the drop was injected');
  return events.slice(at + 1).map(label);
};

for (const wireForm of [null, 'string', 'URL', 'Request']) test(`devnet, switch on (${wireForm ?? 'SDK forms'}): the CREATE makes exactly the operator RPC auth signatures the gate allows and the dialog lists, each verifiable on the wire`, async (t) => {
  const x = await world(t, { wireForm });
  await assert.rejects(x.recordWire({ url: x.rpcUrl }), /unrecognised fetch request/);
  await assert.rejects(x.recordWire({ url: x.bindingUrl }), /unrecognised fetch request/);
  const next = await x.run();
  assert.equal(next.status, 'awaiting_approval', JSON.stringify(next.evidence?.protocol?.lastAttempt));
  const signedRequests = x.events.filter((e) => e.signature);
  assert.deepEqual(signedRequests.map(label), ['source:bind', 'source:signature', 'node:confirmTx', 'node:broadcastTx'], 'in this order, and no other request carries one');
  for (const e of signedRequests) {
    assert.equal(e.identity, `ed25519:${x.w.address}`, label(e));
    assert.ok(authVerifies(e), `${label(e)}: the wallet's signature over sha256("<identity>:<timestamp>")`);
  }
  const count = (to, what) => signedRequests.filter((e) => e.to === to && what.includes(e.what)).length;
  assert.deepEqual({ source: count('source', ['bind', 'signature']), confirmTx: count('node', ['confirmTx']), broadcastTx: count('node', ['broadcastTx']) }, { ...OPERATOR_AUTH_SIGNATURES }, 'the gate\'s bound');
  assert.equal(signedRequests.length, OPERATOR_AUTH_TOTAL);
  const dialog = x.w.dialogs.find((d) => d.method === 'approvePurchaseIntent').message.split('\n');
  assert.ok(dialog.includes(operatorAuthLine(x.w.address)), 'the dialog lists them');
  assert.match(operatorAuthLine(x.w.address), new RegExp(`makes ${signedRequests.length} operator RPC auth signatures`));
  assert.ok(x.events.some((e) => e.to === 'node' && e.what === 'getNetworkInfo'), 'node reads were seen too, with no signature');
  assert.equal(x.h.chain.wire.record.accepted.length, 1, 'written once');
});

test('devnet, switch on: a peer Start before connect sends no node or source request and never issues the CREATE', async (t) => {
  let dropNow;
  const x = await world(t, { around: (Fenced) => class extends Fenced {
    async connect(...args) { dropNow(); return super.connect(...args); }
  } });
  dropNow = () => x.drop('peer');
  const error = await x.run().then(() => null, (e) => e);
  assert.equal(error?.code, 'intent_mismatch');
  assert.equal(error?.field, 'superseded');
  assert.deepEqual(afterDrop(x.events), [], 'connect is fenced before any wire request');
  assert.equal(x.events.filter((e) => e.to === 'journal').length, 0, 'never issued');
  assert.equal(x.h.chain.wire.record.accepted.length, 0, 'nothing written');
  assert.equal((await x.recheck()).status, 'agreement_rejected');
});

// Where the Start is dropped, relative to the CREATE's late steps. around:
// outside the gate's fence (the step was not started); DemosCtor: inside it
// (the step was sent and its answer arrives after the drop).
const confirmTxCall = (args) => args[0] === 'execute' && args[3] === 'confirmTx';
const points = [
  { at: 'before confirmTx', options: (drop) => ({ around: (Fenced) => class extends Fenced { async call(...args) { if (confirmTxCall(args)) drop(); return super.call(...args); } } }) },
  { at: 'while confirmTx is answered', sent: 'confirmTx', options: (drop) => ({ DemosCtor: class extends CountingDemos { async call(...args) { const answer = await super.call(...args); if (confirmTxCall(args)) drop(); return answer; } } }) },
  { at: 'after confirmTx, before the node read', sent: 'confirmTx', options: (drop) => ({ around: (Fenced) => class extends Fenced { async call(...args) { const answer = await super.call(...args); if (confirmTxCall(args)) drop(); return answer; } } }) },
  // a review probe: after every check of the last node read, just before the source broadcast.
  { at: 'after the last node read, before the source broadcast', sent: 'getNetworkInfo', options: (drop) => {
    let confirmed = false;
    return { around: (Fenced) => class extends Fenced {
      async call(...args) { const answer = await super.call(...args); if (confirmTxCall(args)) confirmed = true; return answer; }
      async nodeCall(message, data) { const answer = await super.nodeCall(message, data); if (confirmed && message === 'getNetworkInfo') drop(); return answer; }
    } };
  } },
];
for (const { at, sent, options } of points) {
  for (const kind of at.startsWith('after the last') ? ['peer', 'lock'] : ['peer']) {
    test(`devnet, switch on: a ${kind === 'peer' ? 'peer Start' : 'wallet lock'} ${at} stops the CREATE: no further node or source request but the lease release, never issued, the purchase closes`, async (t) => {
      let dropNow;
      const x = await world(t, options((...args) => dropNow(...args)));
      dropNow = () => x.drop(kind);
      const outcome = await x.run().then((view) => view, (e) => e);
      // A lock is also caught by the session's own check (main's `locked`), first.
      const field = kind === 'peer' ? 'superseded' : 'locked';
      if (kind === 'peer') assert.ok(outcome?.code === 'intent_mismatch' && outcome.field === field && /^Nothing was sent: .*this purchase is closed and nothing was paid/.test(outcome.message), String(outcome?.message ?? outcome));
      else assert.equal(outcome?.status, 'agreement_rejected', String(outcome?.message ?? JSON.stringify(outcome)));
      assert.deepEqual(afterDrop(x.events), ['source:release'], 'after the drop only the lease release');
      const before = x.events.slice(0, x.events.findIndex((e) => e.to === 'drop')).map(label);
      if (sent) assert.equal(before.at(-1), `node:${sent}`, 'the step the drop interrupted had been sent');
      assert.ok(before.includes('source:signature') && !before.includes('source:broadcast'), 'the lease was taken; no source broadcast');
      assert.equal(x.events.filter((e) => e.to === 'journal').length, 0, 'never recorded as issued');
      assert.equal(x.h.chain.wire.record.accepted.length, 0, 'nothing written');
      const after = await x.recheck();
      assert.equal(after.status, 'agreement_rejected');
      assert.equal(after.evidence?.protocol?.lastAttempt?.reason, `agreement-anchor: ${field}`);
    });
  }
}

test('devnet, switch on: an approved CREATE whose Start expires before issuance is refused with field expiry; it is never issued or broadcast', async (t) => {
  // The Start expires while the source broadcast response is on its way: the
  // only check left before the wallet records the CREATE is the one at issuance.
  let expire;
  const x = await world(t, { holdBinding: { phase: 'broadcast', at: () => expire() } });
  expire = () => x.drop('expire');
  const error = await x.run().then(() => null, (e) => e);
  assert.ok(error?.code === 'intent_mismatch' && error.field === 'expiry' && /^Nothing was sent: the approved purchase start expired; start again\. The wallet declined the write, so this purchase is closed and nothing was paid/.test(error.message), String(error?.message ?? error));
  assert.deepEqual(afterDrop(x.events), ['source:release']);
  assert.deepEqual(x.events.filter((e) => e.to === 'journal'), [], 'never issued');
  assert.ok(!x.events.some((e) => e.what === 'broadcastTx'), 'never broadcast');
  assert.equal(x.h.chain.wire.record.accepted.length, 0);
  const after = await x.recheck();
  assert.equal(after.status, 'agreement_rejected');
  assert.equal(after.evidence?.protocol?.lastAttempt?.reason, 'agreement-anchor: expiry');
});

test('devnet, switch on: a peer Start after the CREATE is issued changes nothing: it is broadcast once, never resent, and read back', async (t) => {
  const x = await world(t, { afterIssue: (drop) => drop('peer') });
  const next = await x.run();
  assert.deepEqual(afterDrop(x.events), ['node:broadcastTx', 'journal:broadcast-accepted', 'source:release'], 'the one broadcast, then nothing more');
  assert.equal(x.events.filter((e) => e.what === 'broadcastTx').length, 1, 'never resent');
  assert.equal(x.w.gate.lastRefusal, null);
  assert.equal(x.h.chain.wire.record.accepted.length, 1);
  assert.equal(next.status, 'awaiting_approval', 'read back by the server');
  assert.equal(x.op().state.protocol.agreement.anchorReceipt.writer, `did:demos:agent:${x.w.address.slice(2)}`);
});

// Late source errors must report the Start's refusal, rather than the source
// failure. The post-await check only inspects gate state: no extra signature,
// request or issuance is allowed, and lease release still runs.
for (const phase of ['bind', 'signature', 'broadcast']) for (const kind of ['peer', 'expire']) for (const answer of ['ok', 'http-error', 'network-error']) {
  test(`devnet source ${phase}: ${answer} after ${kind} is rechecked as ${kind === 'peer' ? 'superseded' : 'expiry'}, with no later work`, async (t) => {
    let drop;
    const x = await world(t, { holdBinding: { phase, at: () => {
      drop();
      if (answer === 'network-error') throw new Error('TEST late source connection failure');
      if (answer === 'http-error') return new Response(JSON.stringify({ error: 'network_binding_required' }), { status: 503 });
    } } });
    drop = () => x.drop(kind);
    const signedBefore = () => x.events.filter((e) => e.signature).length;
    const error = await x.run({ recheck: undefined }).then(() => null, (e) => e);
    assert.equal(error?.code, 'intent_mismatch', String(error?.message ?? error));
    assert.equal(error?.field, kind === 'peer' ? 'superseded' : 'expiry');
    assert.ok(x.sourceChecks.some((c) => c.phase === phase && c.dropped), 'the source phase itself rechecks the late answer or error');
    assert.deepEqual(afterDrop(x.events), phase === 'broadcast' || (phase === 'signature' && answer === 'ok') ? ['source:release'] : [], 'only lease release after the late answer');
    assert.equal(x.events.filter((e) => e.to === 'journal').length, 0, 'never issued');
    assert.equal(x.h.chain.wire.record.accepted.length, 0, 'nothing written');
    // No auth signature goes unobserved: bind uses one, signature uses two,
    // broadcast also follows confirmTx; release has no auth signature.
    assert.equal(signedBefore(), phase === 'bind' ? 1 : phase === 'signature' ? 2 : 3);
  });
}

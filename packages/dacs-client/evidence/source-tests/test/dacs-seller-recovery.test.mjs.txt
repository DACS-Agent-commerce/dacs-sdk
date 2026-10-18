// Offline recovery contract. Seller runs in a separate Node22 process; its
// ephemeral test key is configuration owned by the fixture controller. The
// external buyer key is never sent to that process or persisted seller state.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { bundleAddress, canonicalize, contentHash, createPayDemSellerObserver, finalityCommitmentAddress, generateCanonicalJobId, paymentEvidenceAddress, sha256Hex } from '@kynesyslabs/dacs';
import { createSellerAgent } from '../src/dacs/seller-agent.mjs';
import { createSellerDurableState } from '../src/dacs/seller-durable-state.mjs';
import { createSellerHttpHandler, createSellerAgentClient, SellerUnavailableError } from '../src/dacs/seller-http.mjs';
import { createSellerTransportStore, createSellerTransportServerAuth, createSellerTransportClientAuth, sellerTransportSigningBytes, SELLER_TRANSPORT_HEADER } from '../src/dacs/seller-transport-auth.mjs';
import { createFixtureAnchorClient, anchorWriteMessage } from '../src/dacs/fixture-anchors.mjs';
import { createDemosChainReader } from '../src/dacs/chain.mjs';
import { buildNativeTransferPayload } from '../src/dacs/wallet-transactions.mjs';
import { buildUnsignedIdentityBundle, attachIdentityPresentation } from '../src/dacs/listing.mjs';
import { listingPin, planAgreement, exchangeAgreement, agreementTerms, readCommitment, bundleSession, bundleSigningPlan, assembleBundleCopies, verifyPaymentEvidence, verifyDelivery, deliverableAddress, deliveryEvidenceAddress } from '../src/dacs/purchase-protocol.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { fixtureListing } from './fixtures/listings.mjs';
import { startChainFixture } from './fixtures/chain-server.mjs';
import { startAnchorFixture } from './dacs-loopback-fixture.test.mjs';

const CHILD = process.argv.includes('--seller-recovery-child');
const filename = fileURLToPath(import.meta.url);
const quietClose = (server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });

async function childMain() {
  let agent, transport, server, fault;
  process.on('message', async (message) => {
    const respond = (result) => process.send({ type: 'reply', id: message.id, result });
    try {
      if (message.type === 'init') {
        const c = message.config;
        if (![c.anchorUrl, c.chainUrl].every((url) => new URL(url).hostname === '127.0.0.1')) throw new Error('loopback fixtures required');
        const privateKey = createPrivateKey({ key: Buffer.from(c.sellerPkcs8, 'base64'), format: 'der', type: 'pkcs8' });
        // Protocol signatures (not the store's or transport's envelopes, nor
        // a fixture anchor write's authorization) are reported; `sign-exit`
        // exits before making one.
        const signer = { claim: c.sellerClaim, sign: (bytes) => {
          const protocol = !Buffer.from(bytes).toString('latin1').startsWith('dacs-chatgpt-plugin');
          if (protocol && fault?.mode === 'sign-exit') process.exit(19);
          const signature = sign(null, Buffer.from(bytes), privateKey);
          if (protocol) process.send({ type: 'protocol-sign', hash: sha256Hex(Buffer.from(bytes)) });
          return signature;
        } };
        const base = createFixtureAnchorClient({ url: c.anchorUrl });
        const anchors = {
          read: base.read,
          write: async (input) => {
            process.send({ type: 'anchor-write', address: input.logicalAddress });
            if (fault?.address === input.logicalAddress && fault.mode === 'before-exit') process.exit(19);
            const receipt = await base.write(input);
            if (fault?.address === input.logicalAddress && fault.mode === 'after-exit') process.exit(19);
            return receipt;
          },
        };
        const observer = createPayDemSellerObserver({ rpc: c.chainUrl, timeoutMs: 1000 });
        agent = await createSellerAgent({ signer, listing: c.listing, anchors, observeDemosTransfer: observer.observeDemosTransfer, durableDirectory: c.durableDirectory, now: () => c.clock });
        transport = createSellerTransportStore({ path: c.transportPath });
        const finish = transport.finish;
        transport.finish = (...args) => {
          if (fault?.mode === 'finish-exit') process.exit(19);
          if (fault?.mode === 'finish-throw') { fault = null; throw new Error('offline lost journal acknowledgement'); }
          return finish(...args);
        };
        const authentication = createSellerTransportServerAuth({ sellerSigner: signer, listingPin: agent.listingPin, store: transport });
        server = http.createServer(createSellerHttpHandler(agent, { authentication }));
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        respond({ url: `http://127.0.0.1:${server.address().port}`, pid: process.pid });
      } else if (message.type === 'fault') { fault = message.fault; respond({ configured: true }); }
      else if (message.type === 'reconcile') respond(await agent.reconcile({ jobId: message.jobId }));
      else if (message.type === 'resume') respond(await agent.resume({ jobId: message.jobId }));
      else if (message.type === 'claim') respond(await agent.submitPayment(message.claim));
      else if (message.type === 'stage') respond({ stage: agent.stageOf(message.jobId) });
      else if (message.type === 'stop') { await quietClose(server); agent.close(); transport.close(); respond({ stopped: true }); process.exit(0); }
    } catch (error) { process.send({ type: 'reply', id: message.id, error: error.code ?? 'seller_init_failed' }); }
  });
  process.send({ type: 'ready' });
  await new Promise(() => {});
}

function sellerWallet() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
  return { claim: `did:demos:agent:${raw}`, address: `0x${raw}`, pkcs8: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), signBytes: (bytes) => sign(null, Buffer.from(bytes), privateKey), signHex: (bytes) => `0x${sign(null, Buffer.from(bytes), privateKey).toString('hex')}` };
}

async function world(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'dacs-seller-recovery-')));
  const seller = sellerWallet();
  const buyer = createEphemeralWallet();
  const clock = Date.now();
  const chain = await startChainFixture();
  const anchors = await startAnchorFixture({ clock: () => clock });
  const listing = fixtureListing(seller, { listingId: 'durable-offline-report', price: '2.5', now: clock });
  const jobs = new Map();
  const attempts = [];
  const w = { directory, seller, buyer, chain, anchors, listing, jobs, attempts, signatures: [], clock, anchorClient: createFixtureAnchorClient({ url: anchors.url }), lastPids: [] };
  let nextId = 0;
  w.call = (type, extra = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const message = (m) => {
      if (m.type !== 'reply' || m.id !== id) return;
      w.child.off('message', message); w.child.off('exit', exited);
      if (m.error) { const error = new Error(m.error); error.code = m.error; reject(error); } else resolve(m.result);
    };
    const exited = () => { w.child.off('message', message); reject(new Error('seller process exited')); };
    w.child.on('message', message); w.child.once('exit', exited); w.child.send({ type, id, ...extra });
  });
  w.start = async (changes = {}) => {
    w.child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', filename, '--seller-recovery-child'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, npm_config_offline: 'true' } });
    let output = '';
    w.child.stdout.on('data', (v) => { output += v; }); w.child.stderr.on('data', (v) => { output += v; });
    w.child.on('message', (m) => { if (m.type === 'anchor-write') attempts.push(m.address); else if (m.type === 'protocol-sign') w.signatures.push(m.hash); });
    w.exited = new Promise((resolve) => w.child.once('exit', resolve));
    await new Promise((resolve, reject) => {
      w.child.on('message', (m) => { if (m.type === 'ready') resolve(); });
      w.child.once('error', reject); w.child.once('exit', () => reject(new Error(`child initialization failed: ${output.slice(0, 200)}`)));
    });
    const config = { sellerPkcs8: seller.pkcs8, sellerClaim: seller.claim, listing, clock, anchorUrl: anchors.url, chainUrl: chain.url, durableDirectory: join(directory, 'seller-state'), transportPath: join(directory, 'transport.sqlite'), ...changes };
    assert.equal(Object.hasOwn(config, 'buyerPrivateKey'), false);
    const ready = await w.call('init', { config });
    w.lastPids.push(ready.pid); w.url = ready.url;
    const authentication = createSellerTransportClientAuth({ buyerSigner: { claim: buyer.claim, sign: buyer.signBytes }, seller: seller.claim, resolveJob: (jobId) => jobs.get(jobId) });
    w.auth = authentication;
    w.client = createSellerAgentClient({ url: w.url, authentication, timeoutMs: 3000 });
    const propose = w.client.propose;
    w.client.propose = (body) => { w.lastProposal = structuredClone(body); return propose(body); };
  };
  w.stop = async () => { if (w.child.exitCode === null) { await w.call('stop'); await w.exited; } };
  w.restart = async () => { await w.stop(); await w.start(); };
  t.after(async () => { if (w.child?.exitCode === null) { try { await w.stop(); } catch { w.child.kill('SIGKILL'); await w.exited; } } await anchors.close(); await chain.close(); rmSync(directory, { recursive: true }); });
  await w.start();
  return w;
}

async function rawRetry(w, path, body, { payload, signer = w.buyer, signed } = {}) {
  const text = JSON.stringify(body);
  const expected = signed ?? await w.auth.request(path, body, text);
  const header = payload ? Buffer.from(canonicalize({ payload, signature: Buffer.from(signer.signBytes(sellerTransportSigningBytes(payload))).toString('base64url') })).toString('base64url') : expected.header;
  const response = await fetch(`${w.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', [SELLER_TRANSPORT_HEADER]: header }, body: text });
  const answerText = await response.text();
  const result = { status: response.status, text: answerText, header: response.headers.get(SELLER_TRANSPORT_HEADER), body: JSON.parse(answerText) };
  if (!payload) w.auth.verifyResponse(expected.payload, result);
  return result;
}

async function agree(w, { allowIndeterminate = false } = {}) {
  const jobId = generateCanonicalJobId();
  const unsigned = buildUnsignedIdentityBundle({ address: w.buyer.address, presentedAt: w.clock, sessionSeed: 'durable-buyer' });
  const buyerBundle = attachIdentityPresentation(unsigned, w.buyer.signHex(unsigned.message));
  const planned = planAgreement({ jobId, listing: w.listing, buyerBundle, generatedAt: w.clock });
  w.jobs.set(jobId, { listingPin: listingPin(w.listing), agreementHash: planned.plan.agreementHash });
  const progress = await exchangeAgreement({ plan: planned.plan, draft: planned.draft, buyerClaim: w.buyer.claim, buyerBundle, agreementSignature: w.buyer.signHex(planned.agreementMessage), anchorSignature: w.buyer.signHex(planned.anchorMessage), seller: w.client, anchors: w.anchorClient });
  if (allowIndeterminate && progress.disposition === 'indeterminate') return { jobId, planned, buyerBundle, progress, proposalBody: w.lastProposal };
  assert.equal(progress.disposition, 'anchored', JSON.stringify(progress));
  return { jobId, agreement: progress.result.agreement, agreementRef: progress.result.agreementRef };
}

async function pay(w, j) {
  const terms = agreementTerms(j.agreement);
  const payload = buildNativeTransferPayload({ from: w.buyer.address, to: terms.payee, amountOs: terms.price.amountOs, nonce: w.chain.nonceOf(w.buyer.address) + 1, timestamp: Date.now(), encoding: 'os-string' });
  const txHash = w.chain.walletBroadcast(payload); // in-process SIMULATED fixture
  const reader = createDemosChainReader({ rpcUrl: w.chain.url, network: 'testnet' });
  const observed = await reader.observeTransfer(txHash);
  assert.equal(observed.status, 'included');
  return { txHash, observed: { txHash, blockNumber: observed.blockNumber }, claim: { jobId: j.jobId, txHash, payerPayingKey: w.buyer.claim } };
}

if (CHILD) await childMain();
else {
  test('accepting process-restart control: external buyer advances each next authenticated HTTP phase from persisted seller context', async (t) => {
    const w = await world(t);
    const j = await agree(w);
    await w.restart();
    assert.equal((await w.call('stage', { jobId: j.jobId })).stage, 'proposed');
    assert.equal((await w.client.commit(j.jobId)).status, 'committed');
    await w.restart();
    const payment = await pay(w, j);
    assert.equal((await w.client.submitPayment(payment.claim)).status, 'delivered');
    await w.restart();
    const terms = agreementTerms(j.agreement);
    const commitment = await readCommitment({ agreement: j.agreement, listing: w.listing, anchors: w.anchorClient });
    const verifiedPayment = await verifyPaymentEvidence({ agreement: j.agreement, observed: payment.observed, record: await w.anchorClient.read(paymentEvidenceAddress(j.jobId, terms.rail, terms.paymentPhaseIndex)) });
    const delivery = await verifyDelivery({ agreement: j.agreement, deliverable: await w.anchorClient.read(deliverableAddress(j.jobId)), evidenceRecord: await w.anchorClient.read(deliveryEvidenceAddress(j.jobId)) });
    assert.equal(commitment.status, 'verified'); assert.equal(verifiedPayment.status, 'verified'); assert.equal(delivery.status, 'verified');
    const request = await w.client.bundleRequest(j.jobId);
    await w.restart();
    const facts = bundleSession({ agreement: j.agreement, agreementRef: j.agreementRef, commitmentRef: commitment.ref, payment: verifiedPayment.ref, delivery: delivery.evidenceRef, observed: payment.observed, finalisedAt: request.finalisedAt });
    const plan = await bundleSigningPlan(facts);
    assert.equal(plan.bundleHash, request.bundleHash);
    const buyerSignature = w.buyer.signHex(plan.message);
    const { copies, problems } = await assembleBundleCopies(facts, { buyer: buyerSignature, seller: request.sellerSignature });
    assert.deepEqual(problems, []);
    const address = bundleAddress(j.jobId, 'buyer');
    await w.anchorClient.write({ logicalAddress: address, artifact: copies.buyerCopy, writer: w.buyer.claim, writerSignature: w.buyer.signHex(anchorWriteMessage(address, contentHash(copies.buyerCopy))) });
    assert.equal((await w.client.countersign(j.jobId, buyerSignature)).status, 'seller-copy-anchored');
    await w.restart();
    assert.equal((await w.client.confirmBuyerCopy(j.jobId)).status, 'verified');
    assert.equal(new Set(w.lastPids).size, 6, 'six independently launched seller processes');
    assert.equal(w.attempts.length, 5, 'one commitment, payment evidence, report, delivery evidence and seller copy');
    assert.equal(new Set(w.attempts).size, 5, 'no duplicate seller anchor invocation');
    assert.equal(w.chain.nonceOf(w.buyer.address), 1);
    const receipts = JSON.parse(readFileSync(join(w.directory, 'seller-state/sdk-receipts/seller-receipts.json')));
    assert.equal(Object.keys(receipts.records).length, 1, 'actual pinned SDK receipt store persisted the claim');
  });

  test('hard process exit after an anchor is authenticated and resumed without another anchor or payment effect', async (t) => {
    const w = await world(t);
    const j = await agree(w); await w.client.commit(j.jobId);
    const payment = await pay(w, j);
    const address = paymentEvidenceAddress(j.jobId, agreementTerms(j.agreement).rail, 2);
    await w.call('fault', { fault: { address, mode: 'after-exit' } });
    await assert.rejects(w.client.submitPayment(payment.claim), SellerUnavailableError);
    await w.exited;
    assert.equal(w.anchors.records.has(address), true);
    await w.start();
    const partialWrites = w.attempts.length;
    await assert.rejects(w.client.submitPayment(payment.claim), SellerUnavailableError, 'partial native evidence cannot fabricate completed delivery');
    assert.equal(w.attempts.length, partialWrites, 'HTTP reconciliation does not execute the remaining delivery steps');
    assert.equal((await w.call('reconcile', { jobId: j.jobId })).status, 'reconciled');
    assert.equal((await w.call('resume', { jobId: j.jobId })).status, 'delivered');
    assert.equal(w.attempts.filter((v) => v === address).length, 1);
    assert.equal(w.chain.nonceOf(w.buyer.address), 1);
    assert.ok((await w.client.bundleRequest(j.jobId)).bundleHash, 'next authenticated HTTP phase uses recovered agent state');
    // The HTTP reducer independently re-verifies the now-complete retained
    // work; it never uses the old uncertain transport reply as evidence.
    assert.equal((await w.client.submitPayment(payment.claim)).status, 'delivered');
    assert.equal(w.attempts.filter((v) => v === address).length, 1);
  });

  test('hard process exit before an anchor: authenticated absence never grants resubmission permission', async (t) => {
    const w = await world(t);
    const j = await agree(w); await w.client.commit(j.jobId);
    const payment = await pay(w, j);
    const address = paymentEvidenceAddress(j.jobId, agreementTerms(j.agreement).rail, 2);
    await w.call('fault', { fault: { address, mode: 'before-exit' } });
    await assert.rejects(w.client.submitPayment(payment.claim), SellerUnavailableError);
    await w.exited; await w.start();
    const result = await w.call('reconcile', { jobId: j.jobId });
    assert.equal(result.status, 'held');
    assert.equal(result.outcomes[0].reason, 'seller_anchor_reconciliation_required');
    await assert.rejects(w.call('resume', { jobId: j.jobId }), (error) => error.code === 'seller_reconciliation_required');
    assert.equal(w.anchors.records.has(address), false);
    assert.equal(w.attempts.filter((v) => v === address).length, 1);
    await assert.rejects(w.client.submitPayment(payment.claim), SellerUnavailableError, 'retained pre-effect HTTP intent stays fenced');
    await assert.rejects(w.client.bundleRequest(j.jobId), (error) => error.code === 'not_delivered');
  });

  test('wrong anchor contents, wrong writer and unavailable readback hold the exact retained intent', async (t) => {
    const w = await world(t);
    const j = await agree(w); await w.client.commit(j.jobId);
    const payment = await pay(w, j);
    const address = paymentEvidenceAddress(j.jobId, agreementTerms(j.agreement).rail, 2);
    await w.call('fault', { fault: { address, mode: 'after-exit' } });
    await assert.rejects(w.client.submitPayment(payment.claim), SellerUnavailableError);
    await w.exited; await w.start();
    w.anchors.faults.alter.set(address, (artifact) => ({ ...artifact, jobId: generateCanonicalJobId() }));
    assert.equal((await w.call('reconcile', { jobId: j.jobId })).outcomes[0].reason, 'seller_anchor_reconciliation_invalid');
    w.anchors.faults.alter.clear();
    const receipt = w.anchors.records.get(address).receipt;
    const writer = receipt.writer; receipt.writer = w.buyer.claim;
    assert.equal((await w.call('reconcile', { jobId: j.jobId })).outcomes[0].reason, 'seller_anchor_reconciliation_invalid');
    receipt.writer = writer; w.anchors.faults.unavailable = true;
    assert.equal((await w.call('reconcile', { jobId: j.jobId })).outcomes[0].reason, 'seller_anchor_reconciliation_required');
    w.anchors.faults.unavailable = false;
    assert.equal((await w.call('resume', { jobId: j.jobId })).status, 'delivered', 'exact authenticated accepting record resumes retained work');
    assert.equal(w.attempts.filter((v) => v === address).length, 1);
  });

  test('persisted buyer/Listing state tampering fails closed instead of minting a recovered session', async (t) => {
    const w = await world(t); const j = await agree(w); await w.stop();
    const path = join(w.directory, 'seller-state/seller-state.sqlite');
    const db = new DatabaseSync(path);
    const original = db.prepare('SELECT value FROM seller_jobs WHERE job=?').get(j.jobId).value;
    const altered = JSON.parse(original); altered.payload.body.session.buyerBundleHash = 'f'.repeat(64);
    db.prepare('UPDATE seller_jobs SET value=? WHERE job=?').run(JSON.stringify(altered), j.jobId); db.close();
    await assert.rejects(w.start(), (error) => error.code === 'seller_state_corrupt');
    w.child.kill('SIGKILL'); await w.exited;
    const restore = new DatabaseSync(path); restore.prepare('UPDATE seller_jobs SET value=? WHERE job=?').run(original, j.jobId); restore.close();
    const otherListing = fixtureListing(w.seller, { listingId: 'another-listing', price: '2.5' });
    await assert.rejects(w.start({ listing: otherListing }), (error) => error.code === 'seller_state_corrupt');
    w.child.kill('SIGKILL'); await w.exited;
    await w.start();
    assert.equal((await w.client.commit(j.jobId)).status, 'committed', 'unmodified authenticated context is a valid control');
  });

  test('SDK receipt winner selection cannot give a restarted seller a second fulfilment for another job', async (t) => {
    const w = await world(t);
    const a = await agree(w); await w.client.commit(a.jobId);
    const payment = await pay(w, a);
    assert.equal((await w.client.submitPayment(payment.claim)).status, 'delivered');
    await w.restart();
    const b = await agree(w); await w.client.commit(b.jobId);
    const before = w.attempts.length;
    // Invoke the seller-owned seam to exercise its own durable guard, without
    // letting the transport's separate transaction reservation mask it.
    const replay = await w.call('claim', { claim: { ...payment.claim, jobId: b.jobId } });
    assert.equal(replay.status, 'rejected', JSON.stringify(replay));
    assert.ok(['settlement-bound-to-another-job', 'settlement-identity-replay', 'settlement-authorization-scope-conflict'].includes(replay.reason), replay.reason);
    assert.equal(w.attempts.length, before);
    assert.equal((await w.anchorClient.read(paymentEvidenceAddress(b.jobId, agreementTerms(b.agreement).rail, 2))).status, 'absent');
    assert.equal((await w.call('claim', { claim: payment.claim })).status, 'delivered', 'original job retains its verified result');
    assert.equal(w.chain.nonceOf(w.buyer.address), 1);
  });

  test('missing state database, live job ownership and capacity do not reset history or admit a new session', async (t) => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'dacs-seller-boundaries-')));
    const wallet = sellerWallet(); const pin = listingPin(fixtureListing(wallet));
    const options = { dir: directory, signer: { claim: wallet.claim, sign: wallet.signBytes }, listingPin: pin, maxJobs: 1 };
    const state = await createSellerDurableState(options);
    state.retainContext({ admittedAt: Date.now(), validation: { disposition: 'verified' } });
    const a = generateCanonicalJobId(), b = generateCanonicalJobId();
    let release;
    const first = state.withJob(a, async () => {
      state.saveSession({ jobId: a });
      await new Promise((resolve) => { release = resolve; });
    });
    assert.ok(release);
    await assert.rejects(state.withJob(a, async () => {}), (error) => error.code === 'seller_state_busy');
    release(); await first;
    await assert.rejects(state.withJob(b, async () => state.saveSession({ jobId: b })), (error) => error.code === 'seller_state_capacity');
    state.close();
    const databasePath = join(directory, 'seller-state.sqlite');
    const bytes = readFileSync(databasePath);
    // Task-owned disposable test state only, never an existing user directory.
    rmSync(databasePath);
    await assert.rejects(createSellerDurableState(options), (error) => error.code === 'seller_state_missing_database');
    assert.ok(bytes.byteLength > 0);
    t.after(() => rmSync(directory, { recursive: true }));
  });

  test('durable signing intents hold unknown signer outcomes, reuse complete bytes and reject changed bytes', async (t) => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'dacs-seller-signing-')));
    const wallet = sellerWallet();
    const pin = listingPin(fixtureListing(wallet));
    let throwSigning = false;
    const signer = { claim: wallet.claim, sign: (bytes) => { if (throwSigning && bytes.toString() === 'unknown-protocol-signature') throw new Error('unknown signer result'); return wallet.signBytes(bytes); } };
    let store = await createSellerDurableState({ dir: directory, signer, listingPin: pin });
    store.retainContext({ admittedAt: Date.now(), validation: { disposition: 'verified' } });
    t.after(() => { store.close(); rmSync(directory, { recursive: true }); });
    const bytes = Buffer.from('exact-protocol-signature');
    // Signing is job-scoped: it runs inside the job's acquisition.
    const job = generateCanonicalJobId();
    const signature = await store.withJob(job, async () => store.signOnce('stable-sign', bytes));
    await store.withJob(job, async () => {
      assert.deepEqual(store.signOnce('stable-sign', bytes), signature);
      assert.throws(() => store.signOnce('stable-sign', Buffer.from('different')), (error) => error.code === 'seller_effect_conflict');
      throwSigning = true;
      assert.throws(() => store.signOnce('unknown-sign', Buffer.from('unknown-protocol-signature')));
    });
    store.close(); throwSigning = false;
    store = await createSellerDurableState({ dir: directory, signer, listingPin: pin });
    await store.withJob(job, async () => {
      assert.deepEqual(store.signOnce('stable-sign', bytes), signature);
      assert.throws(() => store.signOnce('unknown-sign', Buffer.from('unknown-protocol-signature')), (error) => error.code === 'seller_signature_reconciliation_required');
    });
  });

  test('HTTP restart reconciliation recovers last-effect and lost acknowledgements without executing any route again', async (t) => {
    const w = await world(t); const j = await agree(w);
    await w.call('fault', { fault: { mode: 'finish-throw' } });
    await assert.rejects(w.client.commit(j.jobId), SellerUnavailableError);
    await w.restart();
    assert.equal((await w.client.commit(j.jobId)).status, 'committed');
    const payment = await pay(w, j);
    const last = deliveryEvidenceAddress(j.jobId);
    await w.call('fault', { fault: { address: last, mode: 'after-exit' } });
    await assert.rejects(w.client.submitPayment(payment.claim), SellerUnavailableError);
    await w.exited; await w.start();
    assert.equal((await w.call('stage', { jobId: j.jobId })).stage, 'committed', 'no complete delivery snapshot survived the hard exit');
    const before = w.attempts.length;
    const signed = await w.auth.request('/dacs/v1/payments', payment.claim, JSON.stringify(payment.claim));
    const first = await rawRetry(w, '/dacs/v1/payments', payment.claim, { signed });
    assert.equal(first.status, 200); assert.equal(first.body.status, 'delivered');
    assert.deepEqual((await rawRetry(w, '/dacs/v1/payments', payment.claim, { signed })).body, first.body, 'exact nonce replay');
    assert.equal(w.attempts.length, before, 'reconciliation made zero substrate writes');
    assert.equal((await w.call('stage', { jobId: j.jobId })).stage, 'delivered');
    await w.call('fault', { fault: { mode: 'finish-exit' } });
    await assert.rejects(w.client.bundleRequest(j.jobId), SellerUnavailableError);
    await w.exited; await w.start();
    const request = await w.client.bundleRequest(j.jobId);
    const commitment = await readCommitment({ agreement: j.agreement, listing: w.listing, anchors: w.anchorClient });
    const terms = agreementTerms(j.agreement);
    const evidence = await verifyPaymentEvidence({ agreement: j.agreement, observed: payment.observed, record: await w.anchorClient.read(paymentEvidenceAddress(j.jobId, terms.rail, terms.paymentPhaseIndex)) });
    const delivery = await verifyDelivery({ agreement: j.agreement, deliverable: await w.anchorClient.read(deliverableAddress(j.jobId)), evidenceRecord: await w.anchorClient.read(last) });
    assert.equal(commitment.status, 'verified'); assert.equal(evidence.status, 'verified'); assert.equal(delivery.status, 'verified');
    const facts = bundleSession({ agreement: j.agreement, agreementRef: j.agreementRef, commitmentRef: commitment.ref, payment: evidence.ref, delivery: delivery.evidenceRef, observed: payment.observed, finalisedAt: request.finalisedAt });
    const plan = await bundleSigningPlan(facts);
    assert.equal(request.bundleHash, plan.bundleHash);
    const buyerSignature = w.buyer.signHex(plan.message);
    const { copies, problems } = await assembleBundleCopies(facts, { buyer: buyerSignature, seller: request.sellerSignature });
    assert.deepEqual(problems, []);
    const buyerAddress = bundleAddress(j.jobId, 'buyer');
    await w.anchorClient.write({ logicalAddress: buyerAddress, artifact: copies.buyerCopy, writer: w.buyer.claim, writerSignature: w.buyer.signHex(anchorWriteMessage(buyerAddress, contentHash(copies.buyerCopy))) });
    await w.call('fault', { fault: { address: bundleAddress(j.jobId, 'seller'), mode: 'after-exit' } });
    await assert.rejects(w.client.countersign(j.jobId, buyerSignature), SellerUnavailableError);
    await w.exited; await w.start();
    assert.equal((await w.client.countersign(j.jobId, buyerSignature)).status, 'seller-copy-anchored');
    await w.call('fault', { fault: { mode: 'finish-throw' } });
    await assert.rejects(w.client.confirmBuyerCopy(j.jobId), SellerUnavailableError);
    await w.restart();
    assert.equal((await w.client.confirmBuyerCopy(j.jobId)).status, 'verified');
    assert.equal(new Set(w.lastPids).size, 6);
    assert.equal(w.attempts.length, 5); assert.equal(new Set(w.attempts).size, 5);
    assert.equal(w.chain.nonceOf(w.buyer.address), 1);
  });

  test('HTTP reconciliation keeps absent, indeterminate, unauthenticated and partial effects fenced', async (t) => {
    const w = await world(t); const j = await agree(w); await w.client.commit(j.jobId);
    const payment = await pay(w, j); const address = deliveryEvidenceAddress(j.jobId);
    await w.call('fault', { fault: { address, mode: 'after-exit' } });
    await assert.rejects(w.client.submitPayment(payment.claim), SellerUnavailableError);
    await w.exited; await w.start();
    const native = w.anchors.records.get(address); const before = w.attempts.length;
    w.anchors.records.delete(address);
    assert.equal((await rawRetry(w, '/dacs/v1/payments', payment.claim)).status, 503, 'authenticated absence is held');
    w.anchors.records.set(address, native); w.anchors.faults.unavailable = true;
    assert.equal((await rawRetry(w, '/dacs/v1/payments', payment.claim)).status, 503, 'indeterminate readback is held');
    w.anchors.faults.unavailable = false; w.anchors.faults.unmarked = true;
    assert.equal((await rawRetry(w, '/dacs/v1/payments', payment.claim)).status, 503, 'unmarked readback is not substrate proof');
    w.anchors.faults.unmarked = false;
    const writer = native.receipt.writer; native.receipt.writer = w.buyer.claim;
    assert.equal((await rawRetry(w, '/dacs/v1/payments', payment.claim)).status, 503, 'wrong native writer is held');
    native.receipt.writer = writer;
    w.anchors.faults.alter.set(address, (artifact) => ({ ...artifact, jobId: generateCanonicalJobId() }));
    assert.equal((await rawRetry(w, '/dacs/v1/payments', payment.claim)).status, 503, 'wrong native job is held');
    w.anchors.faults.alter.clear();
    const receiptPath = join(w.directory, 'seller-state/sdk-receipts/seller-receipts.json');
    const receiptBytes = readFileSync(receiptPath);
    const receiptState = JSON.parse(receiptBytes);
    const selected = Object.values(receiptState.records)[0].selected;
    selected.evidenceHash = 'f'.repeat(64);
    writeFileSync(receiptPath, JSON.stringify(receiptState)); // disposable, task-owned test state only
    assert.equal((await rawRetry(w, '/dacs/v1/payments', payment.claim)).status, 503, 'changed native SDK receipt authority is held');
    writeFileSync(receiptPath, receiptBytes);
    assert.equal((await w.call('stage', { jobId: j.jobId })).stage, 'committed');
    assert.equal((await w.client.submitPayment(payment.claim)).status, 'delivered', 'exact authenticated present control resolves');
    assert.equal(w.attempts.length, before); assert.equal(w.chain.nonceOf(w.buyer.address), 1);
  });

  test('uncertain HTTP command still requires exact peer, job, Listing, Agreement, live envelope and transaction reservation', async (t) => {
    const w = await world(t); const j = await agree(w); await w.client.commit(j.jobId);
    const payment = await pay(w, j);
    await w.call('fault', { fault: { address: deliveryEvidenceAddress(j.jobId), mode: 'after-exit' } });
    await assert.rejects(w.client.submitPayment(payment.claim), SellerUnavailableError);
    await w.exited; await w.start();
    const path = '/dacs/v1/payments'; const signed = await w.auth.request(path, payment.claim, JSON.stringify(payment.claim));
    const stranger = createEphemeralWallet();
    for (const [name, changes, key, expected] of [
      ['wrong signer', {}, stranger, 401],
      ['wrong job', { jobId: generateCanonicalJobId() }, w.buyer, 409],
      ['wrong peer', { buyer: stranger.claim }, stranger, 409],
      ['wrong Listing', { listingPin: { ...signed.payload.listingPin, contentHash: 'b'.repeat(64) } }, w.buyer, 409],
      ['wrong Agreement', { agreementHash: 'c'.repeat(64) }, w.buyer, 409],
      ['expired intent retry', { expiresAt: Date.now() - 1 }, w.buyer, 408],
    ]) assert.equal((await rawRetry(w, path, payment.claim, { payload: { ...signed.payload, ...changes }, signer: key })).status, expected, name);
    assert.equal((await rawRetry(w, '/dacs/v1/commitments', payment.claim, { signed })).status, 401, 'original signed path cannot reconcile a different route');
    assert.equal((await rawRetry(w, path, { ...payment.claim, txHash: 'd'.repeat(64) }, { signed })).status, 401, 'raw original signed body must match');
    const other = await agree(w); await w.client.commit(other.jobId);
    const replay = await rawRetry(w, path, { ...payment.claim, jobId: other.jobId });
    assert.equal(replay.status, 409); assert.equal(replay.body.error, 'peer_payment_conflict');
    const before = w.attempts.length;
    const result = await rawRetry(w, path, payment.claim, { signed });
    assert.equal(result.status, 200); assert.equal(result.body.status, 'delivered');
    assert.equal(w.attempts.length, before);
    const db = new DatabaseSync(join(w.directory, 'transport.sqlite'));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM peer_transactions WHERE job=?').get(j.jobId).n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM peer_slots WHERE slot=?').get(`${j.jobId}:${path}`).n, 1);
    db.close();
  });

  test('durable contribution and read-only state responses reconcile lost HTTP acknowledgement without another Agreement signature', async (t) => {
    const w = await world(t);
    await w.call('fault', { fault: { mode: 'finish-exit' } });
    const j = await agree(w, { allowIndeterminate: true });
    assert.equal(j.progress.disposition, 'indeterminate');
    await w.exited; await w.start();
    const before = w.attempts.length;
    const recovered = await w.client.propose(j.proposalBody);
    assert.equal(recovered.disposition, 'complete');
    const signed = await w.auth.request('/dacs/v1/agreements/proposals', j.proposalBody, JSON.stringify(j.proposalBody));
    assert.deepEqual((await rawRetry(w, '/dacs/v1/agreements/proposals', j.proposalBody, { signed })).body, recovered);
    assert.equal(w.attempts.length, before, 'contribution reconciliation claims no Agreement anchor');
    await w.call('fault', { fault: { mode: 'finish-exit' } });
    await assert.rejects(w.client.agreementState(j.proposalBody.transportIdentity), SellerUnavailableError);
    await w.exited; await w.start();
    const state = await w.client.agreementState(j.proposalBody.transportIdentity);
    assert.deepEqual(state.contribution, recovered.contribution);
    assert.deepEqual(state.proposal, j.proposalBody.proposal);
    const progress = await exchangeAgreement({ plan: j.planned.plan, draft: j.planned.draft, buyerClaim: w.buyer.claim, buyerBundle: j.buyerBundle,
      agreementSignature: w.buyer.signHex(j.planned.agreementMessage), anchorSignature: w.buyer.signHex(j.planned.anchorMessage), seller: w.client, anchors: w.anchorClient });
    assert.equal(progress.disposition, 'anchored');
    assert.equal(w.attempts.length, before, 'only the buyer performed its own Agreement anchor');
    assert.equal((await w.client.commit(j.jobId)).status, 'committed');
  });

  test('transport reconciliation binding guard witness: exact original accepts; another body cannot resolve the retained effect', async (t) => {
    const source = readFileSync(new URL('../src/dacs/seller-transport-auth.mjs', import.meta.url), 'utf8');
    const guard = 'reservation.effectKey !== effectIdentity(request) ||';
    assert.ok(source.includes(guard));
    const absolute = source.replace("from '../wallet/demos-signature.mjs'", `from '${new URL('../src/wallet/demos-signature.mjs', import.meta.url).href}'`).replace("from '../../public/portal/seller-session-limits.mjs'", `from '${new URL('../public/portal/seller-session-limits.mjs', import.meta.url).href}'`);
    const mutant = await import(`data:text/javascript;base64,${Buffer.from(absolute.replace(guard, '')).toString('base64')}`);
    const w = await world(t); const j = await agree(w);
    const p = (await w.auth.request('/dacs/v1/payments', { jobId: j.jobId, txHash: 'a'.repeat(64), payerPayingKey: w.buyer.claim }, '{}')).payload;
    async function oracle(factory) {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dacs-transport-reconcile-guard-')));
      const store = factory({ path: join(dir, 'peer.sqlite') });
      store.bind({ seller: w.seller.claim, listingPin: listingPin(w.listing) });
      t.after(() => { store.close(); rmSync(dir, { recursive: true }); });
      const admission = { ...p, path: '/dacs/v1/agreements/proposals', nonce: Buffer.from('independent-proposal-0001').toString('base64url') };
      const admitted = store.reserve(admission, {}); store.finish(admitted, 200, '{"disposition":"complete"}');
      const reservation = store.reserve(p, { txHash: 'a'.repeat(64) });
      store.finish(reservation, 503, '{"error":"operation_uncertain"}');
      const unknown = store.reserve(p, { txHash: 'a'.repeat(64) });
      let blocked = false;
      try { store.reconcile(unknown, { ...p, bodyHash: sha256Hex('different originally authenticated body') }, 200, '{"status":"delivered"}'); }
      catch (error) { blocked = error.code === 'peer_reconciliation_conflict'; }
      if (blocked) {
        store.reconcile(unknown, p, 200, '{"status":"delivered"}');
        assert.equal(store.reserve(p, { txHash: 'a'.repeat(64) }).disposition, 'cached', 'otherwise-valid exact operation control');
      } else assert.equal(store.reserve(p, { txHash: 'a'.repeat(64) }).disposition, 'cached', 'mutant acceptance is observed');
      return blocked;
    }
    assert.equal(await oracle(createSellerTransportStore), true);
    assert.equal(await oracle(mutant.createSellerTransportStore), false, 'named wrong implementation violates original-operation-only oracle');
  });

  test('durable settlement guard witness: valid owner replay accepts; removing the cross-job guard violates the independent oracle', async (t) => {
    const sourcePath = fileURLToPath(new URL('../src/dacs/seller-durable-state.mjs', import.meta.url));
    const source = readFileSync(sourcePath, 'utf8');
    const guard = 'if (previous && previous.job !== jobId) return false;';
    assert.ok(source.includes(guard));
    const absolute = source.replace("from './fixture-anchors.mjs'", `from '${new URL('../src/dacs/fixture-anchors.mjs', import.meta.url).href}'`);
    const mutant = await import(`data:text/javascript;base64,${Buffer.from(absolute.replace(guard, 'if (previous && previous.job !== jobId) return true;')).toString('base64')}`);
    const wallet = sellerWallet(); const pin = listingPin(fixtureListing(wallet));
    const a = generateCanonicalJobId(), b = generateCanonicalJobId();
    async function oracle(factory) {
      const directory = realpathSync(mkdtempSync(join(tmpdir(), 'dacs-seller-guard-')));
      const state = await factory({ dir: directory, signer: { claim: wallet.claim, sign: wallet.signBytes }, listingPin: pin });
      state.retainContext({ admittedAt: Date.now(), validation: { disposition: 'verified' } });
      t.after(() => { state.close(); rmSync(directory, { recursive: true }); });
      // Binding is job-scoped: each runs inside its job's acquisition.
      const bind = (job) => state.withJob(job, async () => state.bindSettlement('offline-settlement-witness', job));
      assert.equal(await bind(a), true);
      assert.equal(await bind(a), true, 'otherwise-valid owner replay control');
      return await bind(b) === false;
    }
    assert.equal(await oracle(createSellerDurableState), true, 'shipped guard enforces one settlement / one job');
    assert.equal(await oracle(mutant.createSellerDurableState), false, 'named wrong implementation is detected');
  });

  // Crash windows around each seller effect, across a real process exit. The
  // intent journal is the authority on what was started: "before the intent"
  // is the state a process killed after the step's checkpoint and before the
  // effect's intent leaves (checkpoint saved, no intent, no effect), made by
  // exiting just before the effect and removing that one intent row. Resuming
  // it makes the effect once in total. "After the intent" keeps the row:
  // resuming reads back or holds, with no new effect.
  const crashTally = (w) => ({ signatures: w.signatures.length, writes: w.anchors.faults.writes.length });
  const crashDelta = (w, from) => { const now = crashTally(w); return { signatures: now.signatures - from.signatures, writes: now.writes - from.writes }; };
  const none = { signatures: 0, writes: 0 };
  const reconciliationRequired = (error) => /reconciliation_required|commitment_failed/.test(error.code);
  async function crash(w, fault, step) {
    await w.call('fault', { fault });
    await assert.rejects(step(), SellerUnavailableError);
    await w.exited;
  }
  function dropIntent(w, match) {
    const db = new DatabaseSync(join(w.directory, 'seller-state/seller-state.sqlite'));
    try {
      const rows = db.prepare('SELECT id,value FROM seller_effects').all().filter(({ value }) => { const body = JSON.parse(value).payload.body; return body.state === 'intent' && match(body); });
      assert.equal(rows.length, 1, 'exactly one retained intent to remove');
      db.prepare('DELETE FROM seller_effects WHERE id=?').run(rows[0].id);
    } finally { db.close(); }
  }
  function noEffectTwice(w) {
    assert.equal(new Set(w.signatures).size, w.signatures.length, 'no bytes signed twice');
    const written = w.anchors.faults.writes.map((write) => write.logicalAddress);
    assert.equal(new Set(written).size, written.length, 'no address written twice');
  }
  async function delivered(w) {
    const j = await agree(w); await w.client.commit(j.jobId);
    const payment = await pay(w, j);
    assert.equal((await w.client.submitPayment(payment.claim)).status, 'delivered');
    return { ...j, payment };
  }

  test('commitment crash windows: before the signing or anchor intent, resume makes each effect once in total; after it, resume holds with no new effect', async (t) => {
    const w = await world(t);
    const control = await agree(w), beforeSign = await agree(w), afterSign = await agree(w), beforeAnchor = await agree(w), afterAnchor = await agree(w);
    let from = crashTally(w);
    assert.equal((await w.client.commit(control.jobId)).status, 'committed');
    const once = crashDelta(w, from);
    assert.deepEqual(once, { signatures: 1, writes: 1 }, 'control: one commitment signature and one anchor');

    from = crashTally(w);
    await crash(w, { mode: 'sign-exit' }, () => w.client.commit(beforeSign.jobId));
    assert.deepEqual(crashDelta(w, from), none);
    dropIntent(w, (body) => body.kind === 'signature');
    await w.start();
    assert.equal((await w.call('resume', { jobId: beforeSign.jobId })).status, 'committed');
    assert.deepEqual(crashDelta(w, from), once);

    from = crashTally(w);
    await crash(w, { mode: 'sign-exit' }, () => w.client.commit(afterSign.jobId));
    await w.start();
    await assert.rejects(w.call('resume', { jobId: afterSign.jobId }), reconciliationRequired);
    await assert.rejects(w.client.commit(afterSign.jobId));
    assert.deepEqual(crashDelta(w, from), none, 'the retained signing intent is never signed again');

    const anchorAt = (j) => finalityCommitmentAddress(j.jobId);
    from = crashTally(w);
    await crash(w, { address: anchorAt(beforeAnchor), mode: 'before-exit' }, () => w.client.commit(beforeAnchor.jobId));
    assert.deepEqual(crashDelta(w, from), { signatures: 1, writes: 0 });
    dropIntent(w, (body) => body.kind === 'anchor' && body.logicalAddress === anchorAt(beforeAnchor));
    await w.start();
    assert.equal((await w.call('resume', { jobId: beforeAnchor.jobId })).status, 'committed');
    assert.deepEqual(crashDelta(w, from), once, 'the completed signature is reused, the anchor written once');

    from = crashTally(w);
    await crash(w, { address: anchorAt(afterAnchor), mode: 'before-exit' }, () => w.client.commit(afterAnchor.jobId));
    await w.start();
    await assert.rejects(w.call('resume', { jobId: afterAnchor.jobId }), reconciliationRequired);
    await assert.rejects(w.client.commit(afterAnchor.jobId));
    assert.deepEqual(crashDelta(w, from), { signatures: 1, writes: 0 }, 'the retained anchor intent is only read back');
    noEffectTwice(w);
  });

  test('payment evidence crash windows: before the evidence signing or anchor intent, resume makes each effect once in total; after it, resume holds with no new effect', async (t) => {
    const w = await world(t);
    const committed = async () => { const j = await agree(w); await w.client.commit(j.jobId); return { ...j, payment: await pay(w, j) }; };
    const control = await committed(), beforeSign = await committed(), afterSign = await committed(), beforeAnchor = await committed();
    let from = crashTally(w);
    assert.equal((await w.client.submitPayment(control.payment.claim)).status, 'delivered');
    const once = crashDelta(w, from);
    assert.deepEqual(once, { signatures: 2, writes: 3 }, 'control: payment and delivery evidence signatures; three anchors');

    from = crashTally(w);
    await crash(w, { mode: 'sign-exit' }, () => w.client.submitPayment(beforeSign.payment.claim));
    assert.deepEqual(crashDelta(w, from), none);
    dropIntent(w, (body) => body.kind === 'signature');
    await w.start();
    assert.equal((await w.call('resume', { jobId: beforeSign.jobId })).status, 'delivered');
    assert.deepEqual(crashDelta(w, from), once);

    from = crashTally(w);
    await crash(w, { mode: 'sign-exit' }, () => w.client.submitPayment(afterSign.payment.claim));
    await w.start();
    await assert.rejects(w.call('resume', { jobId: afterSign.jobId }), reconciliationRequired);
    await assert.rejects(w.client.submitPayment(afterSign.payment.claim));
    assert.deepEqual(crashDelta(w, from), none, 'the retained signing intent is never signed again');

    const address = paymentEvidenceAddress(beforeAnchor.jobId, agreementTerms(beforeAnchor.agreement).rail, 2);
    from = crashTally(w);
    await crash(w, { address, mode: 'before-exit' }, () => w.client.submitPayment(beforeAnchor.payment.claim));
    assert.deepEqual(crashDelta(w, from), { signatures: 1, writes: 0 });
    dropIntent(w, (body) => body.kind === 'anchor' && body.logicalAddress === address);
    await w.start();
    assert.equal((await w.call('resume', { jobId: beforeAnchor.jobId })).status, 'delivered');
    assert.deepEqual(crashDelta(w, from), once, 'the completed evidence signature is reused, each anchor written once');
    // After the anchor intent: 'hard process exit before an anchor' above.
    noEffectTwice(w);
  });

  // The buyer's retry of the same bundle request is the same transport effect,
  // so it is answered only by readback; resume has no bundle step. Either way
  // a bundle signature whose request crashed is never made by recovery.
  test('bundle signing crash windows: before or after the signing intent, the retried request is only read back and nothing is signed', async (t) => {
    const w = await world(t);
    const control = await delivered(w), beforeSign = await delivered(w), afterSign = await delivered(w);
    let from = crashTally(w);
    assert.ok((await w.client.bundleRequest(control.jobId)).sellerSignature);
    assert.deepEqual(crashDelta(w, from), { signatures: 1, writes: 0 }, 'control: one bundle signature');

    from = crashTally(w);
    await crash(w, { mode: 'sign-exit' }, () => w.client.bundleRequest(beforeSign.jobId));
    assert.deepEqual(crashDelta(w, from), none);
    dropIntent(w, (body) => body.kind === 'signature');
    await w.start();
    await assert.rejects(w.client.bundleRequest(beforeSign.jobId), SellerUnavailableError);
    assert.equal((await w.call('resume', { jobId: beforeSign.jobId })).status, 'retained', 'resume starts no bundle signing');
    assert.deepEqual(crashDelta(w, from), none);

    from = crashTally(w);
    await crash(w, { mode: 'sign-exit' }, () => w.client.bundleRequest(afterSign.jobId));
    await w.start();
    await assert.rejects(w.client.bundleRequest(afterSign.jobId));
    assert.equal((await w.call('resume', { jobId: afterSign.jobId })).status, 'retained', 'resume starts no bundle signing');
    assert.deepEqual(crashDelta(w, from), none, 'the retained signing intent is never signed again');
    noEffectTwice(w);
  });

  test('countersigning crash windows: before the seller-copy anchor intent, resume anchors once in total; after it, resume holds with no new effect', async (t) => {
    const w = await world(t);
    async function ready() {
      const j = await delivered(w);
      const request = await w.client.bundleRequest(j.jobId);
      const terms = agreementTerms(j.agreement);
      const commitment = await readCommitment({ agreement: j.agreement, listing: w.listing, anchors: w.anchorClient });
      const verifiedPayment = await verifyPaymentEvidence({ agreement: j.agreement, observed: j.payment.observed, record: await w.anchorClient.read(paymentEvidenceAddress(j.jobId, terms.rail, terms.paymentPhaseIndex)) });
      const delivery = await verifyDelivery({ agreement: j.agreement, deliverable: await w.anchorClient.read(deliverableAddress(j.jobId)), evidenceRecord: await w.anchorClient.read(deliveryEvidenceAddress(j.jobId)) });
      const facts = bundleSession({ agreement: j.agreement, agreementRef: j.agreementRef, commitmentRef: commitment.ref, payment: verifiedPayment.ref, delivery: delivery.evidenceRef, observed: j.payment.observed, finalisedAt: request.finalisedAt });
      const buyerSignature = w.buyer.signHex((await bundleSigningPlan(facts)).message);
      const { copies } = await assembleBundleCopies(facts, { buyer: buyerSignature, seller: request.sellerSignature });
      const address = bundleAddress(j.jobId, 'buyer');
      await w.anchorClient.write({ logicalAddress: address, artifact: copies.buyerCopy, writer: w.buyer.claim, writerSignature: w.buyer.signHex(anchorWriteMessage(address, contentHash(copies.buyerCopy))) });
      return { ...j, buyerSignature };
    }
    const control = await ready(), beforeAnchor = await ready(), afterAnchor = await ready();
    let from = crashTally(w);
    assert.equal((await w.client.countersign(control.jobId, control.buyerSignature)).status, 'seller-copy-anchored');
    const once = crashDelta(w, from);
    assert.deepEqual(once, { signatures: 0, writes: 1 }, 'control: one seller-copy anchor');

    const sellerCopy = (j) => bundleAddress(j.jobId, 'seller');
    from = crashTally(w);
    await crash(w, { address: sellerCopy(beforeAnchor), mode: 'before-exit' }, () => w.client.countersign(beforeAnchor.jobId, beforeAnchor.buyerSignature));
    dropIntent(w, (body) => body.kind === 'anchor' && body.logicalAddress === sellerCopy(beforeAnchor));
    await w.start();
    assert.equal((await w.call('resume', { jobId: beforeAnchor.jobId })).status, 'seller-copy-anchored');
    assert.deepEqual(crashDelta(w, from), once);

    from = crashTally(w);
    await crash(w, { address: sellerCopy(afterAnchor), mode: 'before-exit' }, () => w.client.countersign(afterAnchor.jobId, afterAnchor.buyerSignature));
    await w.start();
    await assert.rejects(w.call('resume', { jobId: afterAnchor.jobId }), reconciliationRequired);
    await assert.rejects(w.client.countersign(afterAnchor.jobId, afterAnchor.buyerSignature));
    assert.deepEqual(crashDelta(w, from), none, 'the retained anchor intent is only read back');
    noEffectTwice(w);
  });
}

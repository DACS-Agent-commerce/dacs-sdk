import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARTIFACT_SEPARATORS, canonicalize, compositeVerificationAddress, contentHash, identityBundleHash, signComponentArtifact } from '@kynesyslabs/dacs';
import { BUYER, SELLER, T0, JOB, buyerBundle, k4Listing } from '../../../../test/kit-client/fixtures.mjs';
import { testWallet } from './protocol-fixture.mjs';
import { createDevnetDemoAgreementContextProvider } from '../../src/devnet-demo/agreement-context.mjs';
import { createInMemoryPartyVetStore, openPartyVetStore } from '../../src/devnet-demo/party-vet-store.mjs';
import { provenUnsignedAbsence } from '../../src/dacs/native-dem-delivery-consumer.mjs';
import { listingPin } from '../../src/dacs/purchase-protocol.mjs';
import { purchaseSupport } from '../../src/dacs/listing.mjs';
import { anchorFixture, signSdkCreate } from './anchor-isolated-fixture.mjs';
import { createOperatorBuyerAccess } from '../../src/devnet-demo/buyer-access.mjs';
export { BUYER, SELLER, T0, JOB };
export const W = 'tp1-g3-orchestrator', OTHER = testWallet(4), copy = structuredClone;
export const address = party => compositeVerificationAddress(JOB, party.claim);
export const deferred = () => { let resolve; const promise = new Promise(done => resolve = done); return { promise, resolve }; };
export async function signedRecord(record, signer = SELLER) { const { signature, ...unsigned } = record; return signComponentArtifact(unsigned, ARTIFACT_SEPARATORS.CompositeVerificationRecord, { signer: signer.claim, algorithm: 'ed25519', sign: signer.signBytes }); }
export async function orchestratorFixture(t, { real = false, disk = false, vetMode = W } = {}) {
    const listing = await k4Listing(), records = new Map(), controls = { signatures: [], creates: [], reads: [], counterpartyCalls: 0 };
    let base = createInMemoryPartyVetStore(), path;
    const handles = [];
    if (disk) {
        const dir = await mkdtemp(join(tmpdir(), 'TEST-W-vet-'));
        path = join(dir, 'party.sqlite');
        base = openPartyVetStore({ path, mode: 'create' });
        handles.push(base);
        t.after(async () => { for (const handle of handles)
            handle.close(); await rm(dir, { recursive: true, force: true }); });
    }
    const wrapped = handle => ({ read: handle.read, entries: handle.entries, update: async (key, change) => {
            let before, next;
            const out = await handle.update(key, (old, rows) => { before = copy(old); next = change(old, rows); return next; });
            if (next !== undefined)
                await controls.afterUpdate?.(before, copy(out));
            return out;
        } });
    const store = wrapped(base), input = { scope: { jobId: JOB, buyer: BUYER.claim, seller: SELLER.claim, generatedAt: T0, payee: SELLER.address, listingPin: listingPin(listing), price: purchaseSupport(listing).price }, buyerIdentityBundle: buyerBundle() };
    const receipt = (logicalAddress, artifact, hash = contentHash(artifact)) => ({ receiptVersion: '1', substrate: 'TEST-landing-reader', finalityProfile: 'TEST-finalized', logicalAddress, nativeAddress: logicalAddress, contentHash: contentHash(artifact), writer: SELLER.claim, transactionRef: { kind: 'storage-program', value: hash }, state: 'finalized', observationDisposition: 'established', observedAt: T0, blockRef: { id: 'TEST-block', height: '1' }, evidence: { kind: 'TEST-finalized-observation', value: hash } });
    const read = async ({ logicalAddress, proofOfNoIntent = false }) => {
        controls.reads.push(logicalAddress);
        await controls.onRead?.(logicalAddress);
        const kept = records.get(logicalAddress);
        if (!kept)
            return proofOfNoIntent ? provenUnsignedAbsence('TEST authoritative no-intent proof') : { status: 'absent' };
        if (controls.fault?.party === logicalAddress) {
            if (controls.fault.state === 'throws')
                throw new Error('TEST read outage');
            if (controls.fault.state === 'absent')
                return { ...copy(kept), receipt: null };
            return { ...copy(kept), receipt: { ...kept.receipt, state: controls.fault.state } };
        }
        return copy(kept);
    };
    let native;
    if (real) {
        native = await anchorFixture({ writer: { claim: SELLER.claim, sign: SELLER.signBytes }, vetMode, now: () => T0 });
        native.source.observeBinding = async () => ({});
        native.source.binding = async () => ({ disposition: 'included' });
        native.controls.reader.read = async (logicalAddress) => ({ ...await read({ logicalAddress }), demosEvidence: {} });
        native.controls.reader.verifyReceipt = async ({ logicalAddress, artifact, receipt: given, signedProjection }) => given?.state === 'finalized' && given.observationDisposition === 'established' && given.contentHash === contentHash(artifact) && given.transactionRef.value === signedProjection?.hash && canonicalize(records.get(logicalAddress)?.artifact) === canonicalize(artifact) ? 'valid' : 'invalid';
        native.controls.request = async (request) => { const signed = await signSdkCreate(request.transaction, { writer: SELLER }); await native.sourceJournal.put('TEST/' + signed.hash, { hash: signed.hash, signedTransaction: signed, stage: 'broadcasted' }); native.controls.nonce++; records.set(request.logicalAddress, { status: 'present', artifact: copy(request.transaction.content.data[1].data), receipt: receipt(request.logicalAddress, request.transaction.content.data[1].data, signed.hash) }); return { success: true, data: { hash: signed.hash } }; };
    }
    const memory = { writer: SELLER.claim, vetMode, hasIntent: async (logicalAddress) => records.has(logicalAddress), readRetained: read, read,
        verifyReceipt: async ({ logicalAddress, artifact, receipt: given }) => controls.receiptVerdict ?? (given?.state === 'finalized' && given.observationDisposition === 'established' && given.contentHash === contentHash(artifact) && records.has(logicalAddress) ? 'valid' : 'invalid'),
        publish: async ({ logicalAddress, artifact }) => { records.set(logicalAddress, { status: 'present', artifact: copy(artifact), receipt: receipt(logicalAddress, artifact) }); return read({ logicalAddress }); } };
    const openAnchor = () => {
        const inner = native ? native.open() : memory;
        return { ...inner, publish: async (request) => { await controls.beforePublish?.(request); const result = await inner.publish(request); controls.creates.push(request.logicalAddress); await controls.afterPublish?.(request, result); return result; } };
    };
    const config = { anchor: openAnchor(), vetMode, listing, store, buyerAccess: createOperatorBuyerAccess({ openBuyerAccess: false, custodyBuyer: BUYER.claim, buyerForJob: () => BUYER.address }), now: () => T0, log: () => { }, wallet: { claim: SELLER.claim, signBytes: async (bytes) => { await controls.beforeSign?.(bytes); controls.signatures.push(Buffer.from(bytes).toString()); return SELLER.signBytes(bytes); } }, counterparty: Object.fromEntries(['issueChallenge', 'evaluate', 'readRecord'].map(key => [key, () => { controls.counterpartyCalls++; throw new Error('TEST W counterparty ' + key); }])) };
    const provider = (extra = {}) => createDevnetDemoAgreementContextProvider({ ...config, ...extra });
    const fresh = () => { const handle = path ? openPartyVetStore({ path, mode: 'open' }) : base; if (path)
        handles.push(handle); return provider({ store: wrapped(handle), anchor: openAnchor() }); };
    const run = (p = provider(), value = input) => p.resolveBuyer(value, { writable: () => true });
    const sellerRequest = () => ({ jobId: JOB, listingPin: listingPin(listing), buyerIdentityBundle: input.buyerIdentityBundle, generatedAt: input.scope.generatedAt });
    const row = async () => (await base.entries())[0]?.[1];
    const cut = async (role, phase, { lostAck = false } = {}) => {
        const reached = deferred(), resume = deferred();
        let hit = false;
        controls.afterUpdate = async (before, next) => {
            const ops = next?.ops?.[role], old = before?.ops?.[role];
            if (hit || !ops)
                return;
            const key = Object.keys(ops.steps).find(key => JSON.parse(key).step === 'composite');
            if (!key)
                return;
            const entry = ops.signing[key], prior = old?.signing[key];
            const match = phase === 'reserved' ? !entry : phase === 'prepared' ? entry && !entry.signedBytes : phase === 'bytes' ? entry?.signedBytes && !entry.signature : phase === 'signature' ? entry?.signature && !prior?.signature : phase === 'complete' ? ops.steps[key].state === 'complete' : false;
            if (!match)
                return;
            hit = true;
            reached.resolve();
            if (lostAck)
                throw new Error('TEST signature save acknowledgement lost');
            await resume.promise;
        };
        const pending = run();
        void pending.catch(() => { });
        await reached.promise;
        controls.afterUpdate = null;
        return { pending, resume, entry: copy((await row()).ops[role]) };
    };
    return { listing, records, controls, base, store, config, input, native, openAnchor, provider, fresh, run, sellerRequest, row, cut, receipt };
}
export function assertPresent(answer) { assert.equal(answer?.disposition, 'present', JSON.stringify(answer)); return answer.value; }
export async function blocked(work) { let out; try {
    out = await work();
}
catch (error) {
    assert.ok(error instanceof Error);
    return error;
} assert.notEqual(out?.disposition, 'present'); return out; }

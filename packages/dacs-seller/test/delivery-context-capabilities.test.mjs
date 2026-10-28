import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemDeliveryContext, resolveDemDeliverySellerContext, demDeliveryContextConfig, releaseDemDeliveryContext } from '../src/dacs/dem-delivery-context-consumer.mjs';
import { createNativeDemDeliveryCapability, nativeDemDeliveryConfig, submitNativeDemDelivery, readNativeDemDelivery, verifyNativeDemDeliveryReceipt, provenUnsignedAbsence, isProvenUnsignedAbsence } from '../src/dacs/native-dem-delivery-consumer.mjs';
import { buyer, seller, protocolFixture, NOW, JOB } from './helpers/protocol-fixture.mjs';

test('invalid context and release job IDs reach no provider callback', async () => {
  const f = await protocolFixture(); let calls = 0;
  const capability = createDemDeliveryContext({ authority: 'TEST-context', resolveBuyer: async () => null,
    resolveSeller: async () => { calls++; return { disposition: 'absent' }; }, release: () => { calls++; } });
  for (const jobId of ['bad:job', JOB.toLowerCase(), undefined]) {
    await assert.rejects(resolveDemDeliverySellerContext(capability, { ...f, jobId, generatedAt: NOW }));
    assert.throws(() => releaseDemDeliveryContext(capability, { jobId }));
  }
  assert.equal(calls, 0);
});

function preparedInput(f) {
  const input = structuredClone(f.input);
  input.buyer.vetRecordRef.signer = seller.claim; input.seller.vetRecordRef.signer = buyer.claim;
  return input;
}

test('present context replies bind exact input and reject copied capabilities or substitutions', async () => {
  const f = await protocolFixture(); let input = preparedInput(f);
  const capability = createDemDeliveryContext({ authority: 'TEST-context', resolveBuyer: async () => null,
    resolveSeller: async () => ({ disposition: 'present', value: { input, vetRequirements: [] } }) });
  assert.throws(() => demDeliveryContextConfig({ ...capability }));
  const request = { ...f, jobId: JOB, generatedAt: NOW };
  assert.equal((await resolveDemDeliverySellerContext(capability, request)).disposition, 'present');
  input = structuredClone(input); input.payoutBindings[0].payeeAddress = buyer.address;
  assert.equal((await resolveDemDeliverySellerContext(capability, request)).disposition, 'rejected');
});

for (const member of ['input', 'vetRequirements']) test(`malformed present ${member} stays held without throwing`, async () => {
  const f = await protocolFixture(), value = { input: preparedInput(f), vetRequirements: [] };
  if (member === 'input') value.input.cycle = value.input; else value.vetRequirements.push(value.vetRequirements);
  const capability = createDemDeliveryContext({ authority: 'TEST-context', resolveBuyer: async () => null, resolveSeller: async () => ({ disposition: 'present', value }) });
  const result = await resolveDemDeliverySellerContext(capability, { ...f, jobId: JOB, generatedAt: NOW });
  assert.notEqual(result.disposition, 'present');
});

test('native capabilities and unsigned-absence proofs cannot be copied or forged', async () => {
  const capability = createNativeDemDeliveryCapability({ authority: 'TEST-native', submit: async () => ({ status: 'accepted' }), reconcile: async () => ({ status: 'complete' }), read: async () => ({ status: 'present' }), verifyReceipt: async () => 'valid' });
  assert.throws(() => nativeDemDeliveryConfig({ ...capability }));
  await assert.rejects(submitNativeDemDelivery({ ...capability }, {}));
  const absent = provenUnsignedAbsence('TEST no signature'); assert.equal(isProvenUnsignedAbsence(absent), true); assert.equal(isProvenUnsignedAbsence({ ...absent }), false);
  assert.equal((await readNativeDemDelivery(capability, {})).status, 'present'); assert.equal(await verifyNativeDemDeliveryReceipt(capability, {}), 'valid');
});

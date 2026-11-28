// The pure deployment-record verifier, given its bytes, digest, key, clock and age bound explicitly: records signed by a key the
// test makes itself stand in for the deployer's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';
import { EVIDENCE_MAX_AGE_MS, signedDeploymentRecord, testDeployerKey } from './helpers/qualification-inputs.mjs';
import { shippedBuildEvidence } from './helpers/shipped-build-evidence.mjs';

const { verifyDeploymentRecord } = await import('../src/devnet-demo/deployment-record-verifier.mjs');

const OBSERVED_AT = 1_800_000_000_000;
const ENDPOINT = 'https://node.example.invalid/';
const payload = shippedBuildEvidence({ endpoint: ENDPOINT, observedAt: OBSERVED_AT });

test('the pure verifier refuses changed bytes, signature, key, endpoint, extra fields and age through its explicit test inputs', () => {
  const deployer = testDeployerKey(), other = testDeployerKey();
  const clock = { now: () => OBSERVED_AT + 1 };
  const verify = ({ bytes, digest }, changes = {}) => verifyDeploymentRecord(bytes, { digest, publicKey: deployer.publicKey, clock, maxAgeMs: EVIDENCE_MAX_AGE_MS, testnetOnly: true, ...changes });
  const good = signedDeploymentRecord(payload, deployer.privateKey);
  assert.deepEqual(verify(good), payload, 'the control record verifies and answers its payload');
  const refused = (label, call) => assert.throws(call, { code: 'deployment_unqualified', details: 'node_build_unverified' }, label);
  const rehashed = (bytes) => ({ bytes, digest: sha256Hex(bytes) });

  const changedByte = Buffer.from(good.bytes);
  changedByte[changedByte.indexOf('"dirty":true') + 9] = 'f'.charCodeAt(0);
  refused('a changed byte under the pinned digest', () => verify({ bytes: changedByte, digest: good.digest }));
  const otherPayload = JSON.parse(good.bytes.toString('utf8'));
  otherPayload.payload.reportedVersion = '1.0.0';
  refused('a changed payload, rehashed', () => verify(rehashed(Buffer.from(canonicalize(otherPayload)))));
  const otherSignature = signedDeploymentRecord({ ...payload, reportedVersion: '1.0.0' }, deployer.privateKey);
  refused('another record\'s signature', () => verify(rehashed(Buffer.from(canonicalize({ ...JSON.parse(good.bytes), signature: JSON.parse(otherSignature.bytes).signature })))));
  refused('a padded signature', () => verify(signedDeploymentRecord(payload, deployer.privateKey, (envelope) => ({ ...envelope, signature: { ...envelope.signature, value: `${envelope.signature.value}==` } }))));
  refused('another key', () => verify(good, { publicKey: other.publicKey }));
  refused('a record another key signed', () => verify(signedDeploymentRecord(payload, other.privateKey)));
  for (const endpoint of ['https://node.example.invalid/path', 'https://node.example.invalid', 'http://node.example.invalid/']) {
    refused(`the endpoint ${endpoint}`, () => verify(signedDeploymentRecord({ ...payload, endpoint, chainIdentity: 'e'.repeat(64) }, deployer.privateKey), { testnetOnly: false }));
  }
  refused('an extra envelope member', () => verify(signedDeploymentRecord(payload, deployer.privateKey, (envelope) => ({ ...envelope, note: 'TEST' }))));
  refused('an extra payload member', () => verify(signedDeploymentRecord({ ...payload, note: 'TEST' }, deployer.privateKey)));
  refused('another schema', () => verify(signedDeploymentRecord(payload, deployer.privateKey, (envelope) => ({ ...envelope, schema: 'dacs-testnet-deployment/v2' }))));
  refused('noncanonical bytes', () => verify(rehashed(Buffer.from(JSON.stringify(JSON.parse(good.bytes), null, 1)))));
  refused('a trailing newline', () => verify(rehashed(Buffer.concat([good.bytes, Buffer.from('\n')]))));
  refused('older than the age bound', () => verify(good, { clock: { now: () => OBSERVED_AT + EVIDENCE_MAX_AGE_MS + 1 } }));
  refused('from the future', () => verify(good, { clock: { now: () => OBSERVED_AT - 1 } }));
  assert.deepEqual(verify(good, { clock: { now: () => OBSERVED_AT + EVIDENCE_MAX_AGE_MS } }), payload, 'exactly at the age bound it verifies');
  for (const testnetOnly of [undefined, 'true', 1]) assert.throws(() => verify(good, { testnetOnly }), TypeError, String(testnetOnly));
});

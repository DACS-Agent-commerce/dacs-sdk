import './d5-isolated-dependencies.mjs';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes,sign} from 'node:crypto';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';
import {DatabaseSync} from 'node:sqlite';
import {canonicalize,identityBundleHash,sha256Hex} from '@kynesyslabs/dacs';
const JOBS=['01ARZ3NDEKTSV4RRFFQ69G5FAW','01ARZ3NDEKTSV4RRFFQ69G5FAX','01ARZ3NDEKTSV4RRFFQ69G5FAY','01ARZ3NDEKTSV4RRFFQ69G5FAZ'];
const T=1800000000000;
const key=()=>{const pair=generateKeyPairSync('ed25519'),raw=pair.publicKey.export({format:'der',type:'spki'}).subarray(12).toString('hex');return {claim:'did:demos:agent:'+raw,sign:bytes=>sign(null,bytes,pair.privateKey)}};
function bundleFor(buyer){const b={bundleVersion:'1',presentedBy:buyer.claim,presentedAt:T,sessionNonce:'a'.repeat(64),claims:[{ref:buyer.claim}]};return {...b,presentation:{kind:'per-claim',signatures:[{ref:buyer.claim,signature:buyer.sign(Buffer.from('dacs-bundle-presentation:v1:'+identityBundleHash(b))).toString('base64url')}]}};}
export { key };

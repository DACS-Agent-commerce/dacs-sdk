// Ephemeral TLS material for owned loopback tests only. Node's Linux child
// stdio "pipe" can be a socket that cannot be reopened as /dev/stdout.
// Use a fresh private directory and unlink its files before returning material.
import {spawnSync} from 'node:child_process';
import {mkdtempSync,openSync,closeSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

export function createLoopbackTestTlsMaterial({temporaryRoot=tmpdir(),run=spawnSync,san='IP:127.0.0.1',subject='/CN=TEST-loopback-native',extendedKeyUsage,keyUsage}={}) {
  const directory=mkdtempSync(join(temporaryRoot,'loopback-test-tls-'));
  const keyPath=join(directory,'key.pem'),certPath=join(directory,'cert.pem');
  try {
    // Precreate only these task-owned files with private modes. Do not change
    // process umask, global TLS trust, host permissions or any existing key.
    for(const file of [keyPath,certPath])closeSync(openSync(file,'wx',0o600));
    const result=run('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj',subject,...(san?['-addext',`subjectAltName=${san}`]:[]),...(keyUsage?['-addext',`keyUsage=${keyUsage}`]:[]),...(extendedKeyUsage?['-addext',`extendedKeyUsage=${extendedKeyUsage}`]:[]),'-keyout',keyPath,'-out',certPath],{encoding:'utf8',stdio:['ignore','ignore','pipe'],timeout:15000});
    if(result.error||result.status!==0||result.signal) {
      const stderr=String(result.stderr??'').replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g,'[ephemeral PEM redacted]').slice(-4000);
      throw Error(`TEST TLS certificate generation failed: exit=${result.status} signal=${result.signal??'none'} ${result.error?.message??''} ${stderr}`);
    }
    const key=readFileSync(keyPath,'utf8'),cert=readFileSync(certPath,'utf8');
    if(!/^-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(key)||!/^-----BEGIN CERTIFICATE-----/.test(cert))throw Error('TEST TLS certificate generation returned incomplete material');
    return {key,cert};
  } finally {
    // The exact fresh mkdtemp result is the only deletion target.
    rmSync(directory,{recursive:true,force:true});
  }
}

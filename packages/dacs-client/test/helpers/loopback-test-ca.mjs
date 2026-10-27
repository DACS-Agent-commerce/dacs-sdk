// Ephemeral test CA with explicitly dated leaves, so restart tests use real
// clocks and swap the seller leaf without changing the client's trust.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const stamp = ms => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
export function createLoopbackTestCa(root) {
  const directory = join(root, 'ca'); mkdirSync(join(directory, 'db'), { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, 'db/index.txt'), '', { mode: 0o600 });
  writeFileSync(join(directory, 'db/serial'), '1000', { mode: 0o600 });
  writeFileSync(join(directory, 'ca.cnf'), `[ ca ]
default_ca = d
[ d ]
database = db/index.txt
serial = db/serial
new_certs_dir = db
default_md = sha256
policy = p
copy_extensions = copy
unique_subject = no
[ p ]
commonName = supplied
`, { mode: 0o600 });
  const run = args => {
    const result = spawnSync('/usr/bin/openssl', args, { cwd: directory, encoding: 'utf8', timeout: 15000 });
    if (result.error || result.status !== 0) throw new Error('TEST CA generation failed');
  };
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=TEST-restart-ca', '-keyout', 'ca-key.pem', '-out', 'ca.pem']);
  const read = file => readFileSync(join(directory, file), 'utf8');
  const ca = read('ca.pem'); let serial = 0;
  return { ca, issue(endMs) {
    const name = `leaf${++serial}`;
    run(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=TEST-${name}`, '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', `${name}-key.pem`, '-out', `${name}.csr`]);
    run(['ca', '-batch', '-config', 'ca.cnf', '-cert', 'ca.pem', '-keyfile', 'ca-key.pem', '-in', `${name}.csr`, '-startdate', stamp(Date.now() - 3 * 3600000), '-enddate', stamp(endMs), '-out', `${name}.pem`]);
    return { key: read(`${name}-key.pem`), cert: read(`${name}.pem`).replace(/^[\s\S]*?(?=-----BEGIN CERTIFICATE-----)/, '') + ca };
  } };
}

// Records and refuses every socket connection and DNS lookup made by this process, so a
// test can assert that nothing tried to leave it (D27). `restore()` puts both functions back.
import dns from 'node:dns';
import net from 'node:net';

export function installNoEgress() {
  const attempts = [];
  const { connect } = net.Socket.prototype;
  const { lookup } = dns;
  net.Socket.prototype.connect = function refuseConnect(...args) {
    attempts.push({ kind: 'connect', target: args[0] });
    throw new Error('TEST-no-egress: socket connection refused');
  };
  dns.lookup = function refuseLookup(hostname) {
    attempts.push({ kind: 'lookup', target: hostname });
    throw new Error('TEST-no-egress: DNS lookup refused');
  };
  return {
    attempts,
    restore() {
      net.Socket.prototype.connect = connect;
      dns.lookup = lookup;
    },
  };
}

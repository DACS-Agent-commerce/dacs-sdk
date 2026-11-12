import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import dgram from 'node:dgram';
import { installNoNetworkTrap } from './helpers/no-network-trap.mjs';

test('the no-network trap refuses and records fetch, a socket connect and a datagram socket, and restore puts them back', async t => {
  const { fetch, createSocket } = { fetch: globalThis.fetch, createSocket: dgram.createSocket };
  const connect = net.Socket.prototype.connect;
  const trap = installNoNetworkTrap();
  t.after(trap.restore);
  await assert.rejects(globalThis.fetch('http://127.0.0.1:1/'), /no-network trap: fetch/);
  assert.throws(() => net.connect(1, '127.0.0.1'), /no-network trap: net\.Socket\.connect/);
  assert.throws(() => dgram.createSocket('udp4'), /no-network trap: dgram\.createSocket/);
  assert.deepEqual(trap.calls, ['fetch', 'net.Socket.connect', 'dgram.createSocket']);
  trap.restore();
  assert.equal(globalThis.fetch, fetch);
  assert.equal(net.Socket.prototype.connect, connect);
  assert.equal(dgram.createSocket, createSocket);
});

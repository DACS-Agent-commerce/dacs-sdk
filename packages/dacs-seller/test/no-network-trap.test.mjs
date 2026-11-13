import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import dgram from 'node:dgram';
import { installNoNetworkTrap } from './helpers/no-network-trap.mjs';

test('the no-network trap refuses and records fetch, a socket connect and a datagram socket, and restore puts them back', async t => {
  const { fetch, createSocket } = { fetch: globalThis.fetch, createSocket: dgram.createSocket };
  const connect = net.Socket.prototype.connect;
  const { send, connect: datagramConnect } = dgram.Socket.prototype;
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
  assert.equal(dgram.Socket.prototype.send, send);
  assert.equal(dgram.Socket.prototype.connect, datagramConnect);
});

test('the no-network trap refuses and records a send or connect on a datagram socket built without createSocket', t => {
  const socket = new dgram.Socket({ type: 'udp4' });
  t.after(() => socket.close());
  const trap = installNoNetworkTrap();
  t.after(trap.restore);
  assert.throws(() => socket.send(Buffer.from('x'), 9, '127.0.0.1'), /no-network trap: dgram\.Socket\.send/);
  assert.throws(() => socket.connect(9, '127.0.0.1'), /no-network trap: dgram\.Socket\.connect/);
  assert.deepEqual(trap.calls, ['dgram.Socket.send', 'dgram.Socket.connect']);
});

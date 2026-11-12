// Makes any outbound network call from this process fail and be recorded: fetch, a socket connecting (net, tls and http
// all go through it) and a datagram socket being created. Returns the recorded calls and a restore function.
import net from 'node:net';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';

export function installNoNetworkTrap() {
  const calls = [];
  const original = { fetch: globalThis.fetch, connect: net.Socket.prototype.connect, createSocket: dgram.createSocket };
  const refuse = (name) => {
    calls.push(name);
    throw new Error(`no-network trap: ${name} was called`);
  };
  globalThis.fetch = async () => refuse('fetch');
  net.Socket.prototype.connect = function connect() { return refuse('net.Socket.connect'); };
  dgram.createSocket = function createSocket() { return refuse('dgram.createSocket'); };
  syncBuiltinESMExports();
  const restore = () => {
    globalThis.fetch = original.fetch;
    net.Socket.prototype.connect = original.connect;
    dgram.createSocket = original.createSocket;
    syncBuiltinESMExports();
  };
  return { calls, restore };
}

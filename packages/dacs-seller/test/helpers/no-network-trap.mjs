// Makes any outbound network call from this process fail and be recorded: fetch, a socket connecting (net, tls and http
// all go through it), a datagram socket being created, and a datagram socket sending or connecting however it was made.
// Returns the recorded calls and a restore function.
import net from 'node:net';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';

export function installNoNetworkTrap() {
  const calls = [];
  const datagram = dgram.Socket.prototype;
  const original = {
    fetch: globalThis.fetch,
    connect: net.Socket.prototype.connect,
    createSocket: dgram.createSocket,
    send: datagram.send,
    datagramConnect: datagram.connect,
  };
  const refuse = (name) => {
    calls.push(name);
    throw new Error(`no-network trap: ${name} was called`);
  };
  globalThis.fetch = async () => refuse('fetch');
  net.Socket.prototype.connect = function connect() { return refuse('net.Socket.connect'); };
  dgram.createSocket = function createSocket() { return refuse('dgram.createSocket'); };
  datagram.send = function send() { return refuse('dgram.Socket.send'); };
  datagram.connect = function connect() { return refuse('dgram.Socket.connect'); };
  syncBuiltinESMExports();
  const restore = () => {
    globalThis.fetch = original.fetch;
    net.Socket.prototype.connect = original.connect;
    dgram.createSocket = original.createSocket;
    datagram.send = original.send;
    datagram.connect = original.datagramConnect;
    syncBuiltinESMExports();
  };
  return { calls, restore };
}

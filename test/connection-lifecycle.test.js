import './support/session.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { UnityInspectorClient, defaultPort, DEFAULT_PORT } from '../lib/unity-client.js';
import { startStubServer, reply } from './support/stub-server.js';

const echoStub = (request, socket) => reply(socket, request.id, { from: request.method });

test('a null-id response is delivered when exactly one command is in flight', { timeout: 10000 }, async (t) => {
  // The mod answers unparseable requests and internal errors with "id": null
  const stub = await startStubServer((request, socket) => {
    socket.write(JSON.stringify({ id: null, success: false, error: 'Internal error: boom' }) + '\n');
  });
  const client = new UnityInspectorClient({ host: '127.0.0.1', port: stub.port });
  t.after(async () => { client.disconnect(); await stub.close(); });

  await assert.rejects(client.sendCommand('anything', {}, 2000), /Internal error: boom/);
});

test('a null-id response is dropped when several commands are in flight', { timeout: 10000 }, async (t) => {
  let seen = 0;
  const stub = await startStubServer((request, socket) => {
    seen++;
    if (seen === 2) {
      socket.write(JSON.stringify({ id: null, success: true, result: { whose: 'unknowable' } }) + '\n');
    }
  });
  const client = new UnityInspectorClient({ host: '127.0.0.1', port: stub.port });
  t.after(async () => { client.disconnect(); await stub.close(); });

  const results = await Promise.allSettled([
    client.sendCommand('one', {}, 400),
    client.sendCommand('two', {}, 400),
  ]);

  assert.deepEqual(results.map((r) => r.status), ['rejected', 'rejected']);
  for (const r of results) {
    assert.match(r.reason.message, /Command timeout/, 'an ambiguous reply must not satisfy either command');
  }
});

test('disconnect() during connect() abandons the attempt and leaves no zombie', { timeout: 10000 }, async (t) => {
  const stub = await startStubServer(echoStub);
  const client = new UnityInspectorClient({ host: '127.0.0.1', port: stub.port, connectTimeoutMs: 2000 });
  t.after(async () => { client.disconnect(); await stub.close(); });

  const attempt = client.connect();
  client.disconnect();

  await assert.rejects(attempt, /abandoned|closed/);
  assert.equal(client.connected, false);
  assert.equal(client.socket, null, 'the abandoned socket must not be retained');
});

test('disconnect() during host detection abandons the attempt', { timeout: 10000 }, async (t) => {
  const stub = await startStubServer(echoStub);
  const client = new UnityInspectorClient({ port: stub.port, connectTimeoutMs: 2000 });
  t.after(async () => { client.disconnect(); await stub.close(); });

  const attempt = client.connect();
  client.disconnect();

  await assert.rejects(attempt, /abandoned|closed/);
  assert.equal(client.connected, false);
  assert.equal(client.socket, null);
  assert.equal(stub.connectionCount, 0, 'no connection should have been established after disconnect()');
});

test('connect() after disconnect() starts a fresh attempt', { timeout: 10000 }, async (t) => {
  const stub = await startStubServer(echoStub);
  const client = new UnityInspectorClient({ host: '127.0.0.1', port: stub.port, connectTimeoutMs: 2000 });
  t.after(async () => { client.disconnect(); await stub.close(); });

  const abandoned = client.connect();
  client.disconnect();
  const fresh = client.connect();

  assert.notEqual(abandoned, fresh, 'a stale connect promise must not be handed to the next caller');
  await assert.rejects(abandoned);
  await fresh;

  assert.equal(client.connected, true);
  assert.deepEqual(await client.sendCommand('ping', {}, 3000), { from: 'ping' });
});

test('sendCommand after disconnect reconnects rather than writing to a dead socket', { timeout: 10000 }, async (t) => {
  const stub = await startStubServer(echoStub);
  const client = new UnityInspectorClient({ host: '127.0.0.1', port: stub.port, connectTimeoutMs: 2000 });
  t.after(async () => { client.disconnect(); await stub.close(); });

  await client.connect();
  await client.sendCommand('first', {}, 3000);
  client.disconnect();

  assert.deepEqual(await client.sendCommand('second', {}, 3000), { from: 'second' });
  assert.equal(stub.connectionCount, 2);
});

test('UNITY_INSPECTOR_PORT overrides the default port', () => {
  assert.equal(defaultPort({}), DEFAULT_PORT);
  assert.equal(defaultPort({ UNITY_INSPECTOR_PORT: '  ' }), DEFAULT_PORT);
  assert.equal(defaultPort({ UNITY_INSPECTOR_PORT: '12345' }), 12345);
  assert.equal(defaultPort({ UNITY_INSPECTOR_PORT: 'nonsense' }), DEFAULT_PORT);
  assert.equal(defaultPort({ UNITY_INSPECTOR_PORT: '99999' }), DEFAULT_PORT);
});

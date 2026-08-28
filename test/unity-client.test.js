import test from 'node:test';
import assert from 'node:assert/strict';

import {
  UnityInspectorClient,
  commandTimeout,
  DEFAULT_COMMAND_TIMEOUT_MS,
  SCENE_COMMAND_TIMEOUT_MS,
} from '../lib/unity-client.js';
import { startStubServer, reply } from '../test-support/stub-server.js';

function connectedClient(port) {
  return new UnityInspectorClient({ host: '127.0.0.1', port, connectTimeoutMs: 2000 });
}

test('a response that arrives after its command timed out does not resolve the next command', { timeout: 10000 }, async (t) => {
  const stub = await startStubServer((request, socket) => {
    // "slow" answers after its caller has already given up; "ping" answers later still
    const delay = request.method === 'slow' ? 150 : 400;
    setTimeout(() => reply(socket, request.id, { from: request.method }), delay);
  });
  const client = connectedClient(stub.port);
  t.after(async () => { client.disconnect(); await stub.close(); });

  await client.connect();

  await assert.rejects(
    client.sendCommand('slow', {}, 50),
    /Command timeout/,
  );

  const result = await client.sendCommand('ping', {}, 3000);
  assert.deepEqual(result, { from: 'ping' }, 'ping must not be resolved by the stale slow response');
});

test('two responses delivered in a single chunk are both dispatched', { timeout: 10000 }, async (t) => {
  const collected = [];
  const stub = await startStubServer((request, socket) => {
    collected.push(request);
    if (collected.length < 2) return;
    // Both frames in one write, exercising the shared line buffer
    const frames = collected
      .map((r) => JSON.stringify({ id: r.id, success: true, result: { from: r.method } }) + '\n')
      .join('');
    socket.write(frames);
  });
  const client = connectedClient(stub.port);
  t.after(async () => { client.disconnect(); await stub.close(); });

  const [first, second] = await Promise.all([
    client.sendCommand('one', {}, 3000),
    client.sendCommand('two', {}, 3000),
  ]);

  assert.deepEqual(first, { from: 'one' });
  assert.deepEqual(second, { from: 'two' });
});

test('errors are routed to the request that caused them', { timeout: 10000 }, async (t) => {
  const stub = await startStubServer((request, socket) => {
    if (request.method === 'boom') {
      socket.write(JSON.stringify({ id: request.id, success: false, error: 'kaboom' }) + '\n');
    } else {
      reply(socket, request.id, { from: request.method });
    }
  });
  const client = connectedClient(stub.port);
  t.after(async () => { client.disconnect(); await stub.close(); });

  await assert.rejects(client.sendCommand('boom', {}, 3000), /kaboom/);
  assert.deepEqual(await client.sendCommand('ok', {}, 3000), { from: 'ok' });
});

test('two concurrent connect() calls both settle', { timeout: 10000 }, async (t) => {
  const stub = await startStubServer((request, socket) => reply(socket, request.id, { from: request.method }));
  const client = connectedClient(stub.port);
  t.after(async () => { client.disconnect(); await stub.close(); });

  const settled = await Promise.allSettled([client.connect(), client.connect(), client.connect()]);
  assert.deepEqual(settled.map((s) => s.status), ['fulfilled', 'fulfilled', 'fulfilled']);

  // The surviving socket is still usable
  assert.deepEqual(await client.sendCommand('ping', {}, 3000), { from: 'ping' });
});

test('concurrent sendCommand calls on a cold client all settle', { timeout: 10000 }, async (t) => {
  const stub = await startStubServer((request, socket) => reply(socket, request.id, { from: request.method }));
  const client = connectedClient(stub.port);
  t.after(async () => { client.disconnect(); await stub.close(); });

  const results = await Promise.all([
    client.sendCommand('a', {}, 3000),
    client.sendCommand('b', {}, 3000),
    client.sendCommand('c', {}, 3000),
  ]);
  assert.deepEqual(results.map((r) => r.from), ['a', 'b', 'c']);
});

test('connect() rejects instead of hanging when the host is unreachable', { timeout: 10000 }, async () => {
  const client = new UnityInspectorClient({ host: '10.255.255.1', port: 9999, connectTimeoutMs: 300 });
  const started = Date.now();
  await assert.rejects(client.connect());
  assert.ok(Date.now() - started < 5000, 'connect must fail fast, not wait for the OS TCP timeout');
  client.disconnect();
});

test('a closed connection rejects in-flight commands', { timeout: 10000 }, async (t) => {
  const stub = await startStubServer((request, socket) => {
    if (request.method === 'drop') socket.destroy();
  });
  const client = connectedClient(stub.port);
  t.after(async () => { client.disconnect(); await stub.close(); });

  await client.connect();
  await assert.rejects(client.sendCommand('drop', {}, 5000), /Connection (closed|lost)/);
});

test('command timeout budgets cover the game-side dispatcher budget', () => {
  assert.equal(commandTimeout('ping'), DEFAULT_COMMAND_TIMEOUT_MS);
  assert.ok(DEFAULT_COMMAND_TIMEOUT_MS > 5000, 'default must exceed the 5s MainThreadDispatcher budget');

  for (const method of ['list_bros', 'game_state', 'inspect_player']) {
    assert.ok(commandTimeout(method) >= 6000, `${method} needs at least 6s`);
  }
  for (const method of ['go_to_level', 'restart_level', 'swap_bro', 'set_bro', 'take_screenshot']) {
    assert.equal(commandTimeout(method), SCENE_COMMAND_TIMEOUT_MS);
  }

  assert.equal(commandTimeout('execute_script'), 30000);
  assert.equal(commandTimeout('compile_script'), 30000);
  assert.equal(commandTimeout('unload_script'), 10000);
  assert.equal(commandTimeout('execute_code'), 10000);
  assert.equal(commandTimeout('simulate_input', { count: 40, interval: 200 }), 39 * 200 + 1000);
});

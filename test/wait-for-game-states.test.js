import './support/session.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { startStubServer, reply } from './support/stub-server.js';
import { isGameRunning } from '../lib/game-process.js';

// The port must be set before index.js is imported: the module-level client reads it at construction
let onPing = () => {};
const stub = await startStubServer((request, socket) => onPing(request, socket));
process.env.UNITY_INSPECTOR_PORT = String(stub.port);

const { handleToolCall } = await import('../index.js');

test.after(() => stub.close());

function textOf(response) {
  return response.content.map((c) => c.text).join('\n');
}

async function waitForGame(args) {
  const started = Date.now();
  const response = await handleToolCall({ params: { name: 'wait_for_game', arguments: args } });
  return { payload: JSON.parse(textOf(response)), elapsed: Date.now() - started };
}

test('a port that accepts but never answers is connected-unresponsive', { timeout: 30000 }, async () => {
  onPing = () => {};
  const budget = 1000;
  const { payload, elapsed } = await waitForGame({ timeout: budget / 1000, interval: 0.05 });

  assert.equal(payload.success, false);
  assert.equal(payload.state, 'connected-unresponsive', payload.message);
  assert.equal(payload.attempts, 1);
  assert.match(payload.lastError, /Command timeout after \d+ms/);
  assert.match(payload.message, new RegExp(`Port ${stub.port} accepts connections but ping got no reply`));
  assert.match(payload.message, /after \d+(\.\d+)?s \(1 attempts\)/);
  assert.ok(elapsed < budget + 6000, `overran the budget: ${elapsed}ms for a ${budget}ms wait`);
  assert.ok(stub.connectionCount >= 1);
});

test('a port that closes the connection is connection-dropped', { timeout: 30000 }, async () => {
  onPing = (_request, socket) => socket.destroy();
  const expected = (await isGameRunning()) === false ? 'no-process' : 'connection-dropped';

  const { payload } = await waitForGame({ timeout: 0.3, interval: 0.05 });

  assert.equal(payload.success, false);
  assert.equal(payload.state, expected, payload.message);
  assert.ok(payload.attempts >= 1);
  assert.doesNotMatch(payload.lastError, /Command timeout/, 'a dropped socket is not a silent one');
  assert.match(
    payload.message,
    expected === 'no-process' ? /connection dropped and no Broforce process/ : /accepted a connection that was then closed/,
  );
});

test('a connected client keeps its socket through wait_for_game', { timeout: 30000 }, async () => {
  onPing = (request, socket) => reply(socket, request.id, { message: 'pong' });

  const ping = await handleToolCall({ params: { name: 'ping', arguments: {} } });
  assert.match(textOf(ping), /pong/);
  const connectionsBefore = stub.connectionCount;

  const { payload } = await waitForGame({ timeout: 5, interval: 0.05 });

  assert.equal(payload.success, true, payload.message);
  assert.match(payload.message, /Game is ready \(1 attempts/);
  assert.equal(stub.connectionCount, connectionsBefore, 'wait_for_game reconnected instead of reusing the live socket');
});

test('launch_game finding the game already running keeps the live socket', { timeout: 30000 }, async () => {
  onPing = (request, socket) => reply(socket, request.id, { message: 'pong' });

  const ping = await handleToolCall({ params: { name: 'ping', arguments: {} } });
  assert.match(textOf(ping), /pong/);
  const connectionsBefore = stub.connectionCount;

  const response = await handleToolCall({ params: { name: 'launch_game', arguments: {} } });
  const payload = JSON.parse(textOf(response));

  assert.equal(payload.alreadyRunning, true, payload.message);
  assert.equal(stub.connectionCount, connectionsBefore, 'launch_game reconnected instead of pinging over the live socket');
});

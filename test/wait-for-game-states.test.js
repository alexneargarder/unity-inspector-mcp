import './support/session.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { startStubServer, reply } from './support/stub-server.js';
import { fakeProcReader } from './support/fake-proc.js';
import { LINUX_GAME_COMM, isGameRunning, setProcReader } from '../lib/game-process.js';

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

test('a port that closes the connection is connection-dropped', { timeout: 30000 }, async (t) => {
  onPing = (_request, socket) => socket.destroy();
  const tables = process.platform === 'linux'
    ? [{ 900: { comm: LINUX_GAME_COMM, cwd: '/tmp' } }, {}]
    : [null];
  t.after(() => setProcReader(null));

  for (const table of tables) {
    if (table) setProcReader(fakeProcReader(table));
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
  }
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

test('a game whose main thread does not answer is main-thread-hung, not ready', { timeout: 30000 }, async () => {
  onPing = (request, socket) => reply(socket, request.id, { message: 'pong', mainThreadAnswered: false, frame: 120 });

  const { payload } = await waitForGame({ timeout: 0.3, interval: 0.05 });

  assert.equal(payload.success, false);
  assert.equal(payload.state, 'main-thread-hung', payload.message);
  assert.match(payload.message, /main thread is not running frames/);
  assert.match(payload.lastError, /main thread did not answer/);

  let pings = 0;
  onPing = (request, socket) => reply(socket, request.id, { message: 'pong', mainThreadAnswered: ++pings > 2, frame: 121 });
  const recovered = (await waitForGame({ timeout: 30, interval: 0.05 })).payload;
  assert.equal(recovered.success, true, recovered.message);
  assert.equal(pings, 3, 'a hung main thread is polled again');
});

test('a cancelled wait_for_game stops polling and frees the connection for the next call', { timeout: 30000 }, async () => {
  onPing = () => {};
  const controller = new AbortController();
  const started = Date.now();
  const waiting = handleToolCall({ params: { name: 'wait_for_game', arguments: { timeout: 30, interval: 0.05 } } }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 300);

  const response = await waiting;
  assert.equal(response.isError, true);
  assert.match(textOf(response), /wait for the game was cancelled/);
  assert.ok(Date.now() - started < 3000, 'the wait ran on after its cancellation');

  onPing = (request, socket) => reply(socket, request.id, { message: 'pong' });
  const ping = await handleToolCall({ params: { name: 'ping', arguments: {} } });
  assert.match(textOf(ping), /pong/, 'the cancelled ping no longer holds the connection');
});

import './support/session.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { startStubServer, reply } from './support/stub-server.js';
import { fakeProcReader } from './support/fake-proc.js';
import { setProcReader } from '../lib/game-process.js';

const stub = await startStubServer((request, socket) => reply(socket, request.id, { message: 'pong' }));
process.env.UNITY_INSPECTOR_PORT = String(stub.port);

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'handshake-tools-'));
const launchMarker = path.join(scratch, 'launched');
process.env.BROFORCE_LAUNCH_CMD = `sh -c ": > '${launchMarker}'"`;

const { handleToolCall, unityClient } = await import('../index.js');

test.after(async () => {
  unityClient.disconnect();
  await stub.close();
  await fs.rm(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  unityClient.disconnect();
  stub.hello = 'accept';
});

function textOf(response) {
  return response.content.map((c) => c.text).join('\n');
}

async function call(name, args = {}) {
  return handleToolCall({ params: { name, arguments: args } });
}

const OLD_MOD = /The Unity Inspector Mod in the game has no connection handshake, so it is older than this server\. Update the Unity Inspector Mod\./;

test('wait_for_game ends at once on a handshake refusal', { timeout: 30000 }, async () => {
  stub.hello = 'old-mod';
  const connectionsBefore = stub.connectionCount;
  const started = Date.now();

  const payload = JSON.parse(textOf(await call('wait_for_game', { timeout: 20, interval: 0.05 })));
  const elapsed = Date.now() - started;

  assert.equal(payload.success, false);
  assert.equal(payload.state, 'handshake-refused', payload.message);
  assert.match(payload.message, OLD_MOD);
  assert.equal(payload.attempts, 1);
  assert.equal(stub.connectionCount, connectionsBefore + 1, 'a refusal was retried');
  assert.ok(elapsed < 5000, `a refusal waited ${elapsed}ms of a 20s budget`);
});

test('wait_for_game reads a hello that goes unanswered as an unresponsive game', { timeout: 30000 }, async () => {
  stub.hello = 'silent';
  const previous = unityClient.connectTimeoutMs;
  unityClient.connectTimeoutMs = 300;
  try {
    const payload = JSON.parse(textOf(await call('wait_for_game', { timeout: 0.2, interval: 0.05 })));
    assert.equal(payload.success, false);
    assert.notEqual(payload.state, 'handshake-refused');
    assert.equal(payload.state, 'connected-unresponsive', payload.message);
    assert.match(payload.message, /accepts connections but the connection handshake got no reply/);
  } finally {
    unityClient.connectTimeoutMs = previous;
  }
});

test('launch_game counts a game that refused the hello as running and launches nothing', { timeout: 30000 }, async (t) => {
  stub.hello = 'refuse';
  if (process.platform === 'linux') {
    setProcReader(fakeProcReader({}));
    t.after(() => setProcReader(null));
  }
  await fs.rm(launchMarker, { force: true });

  const response = await call('launch_game');
  const payload = JSON.parse(textOf(response));

  assert.equal(payload.alreadyRunning, true, payload.message);
  assert.equal(payload.success, false);
  assert.equal(payload.state, 'handshake-refused');
  assert.match(payload.message, /already running, but its inspector refused this server's connection: /);
  assert.match(payload.message, /Found no unity-inspector-\d+\.token in .* \(UNITY_INSPECTOR_TOKEN_FILE\)/);
  await assert.rejects(fs.access(launchMarker), 'a game that answered was launched a second time');
});

test('a launch whose inspector refuses the hello ends at once as handshake-refused', { timeout: 30000 }, async (t) => {
  let hellos = 0;
  stub.hello = () => (++hellos === 1 ? 'close' : 'refuse');
  if (process.platform === 'linux') {
    setProcReader(fakeProcReader({}));
    t.after(() => setProcReader(null));
  }
  const started = Date.now();

  const payload = JSON.parse(textOf(await call('launch_game')));
  const elapsed = Date.now() - started;

  assert.equal(payload.success, false, payload.message);
  assert.equal(payload.state, 'handshake-refused', payload.message);
  assert.equal(payload.alreadyRunning, undefined);
  assert.match(payload.message, /^Game launched with `sh -c .*`, but its inspector refused this server's connection: /);
  assert.match(payload.message, /Found no unity-inspector-\d+\.token in .* \(UNITY_INSPECTOR_TOKEN_FILE\)/);
  assert.equal(payload.attempts, 1);
  assert.equal(hellos, 2);
  assert.match(payload.launchCommand, /^sh -c /);
  assert.ok(elapsed < 10000, `a refusal waited ${elapsed}ms of the 60s launch budget`);
});

test('a command and capture_animations alike fail with the refusal\'s own message', { timeout: 30000 }, async () => {
  stub.hello = 'old-mod';

  const ping = await call('ping');
  assert.equal(ping.isError, true);
  assert.match(textOf(ping), OLD_MOD);

  unityClient.disconnect();
  const capture = await call('capture_animations', { out: path.join(scratch, 'capture') });
  assert.equal(capture.isError, true);
  assert.match(textOf(capture), OLD_MOD);
});

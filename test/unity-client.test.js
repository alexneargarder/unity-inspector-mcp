import './support/session.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMMAND_CANCELLED,
  COMMAND_TIMEOUT,
  UnityInspectorClient,
  commandTimeout,
  defaultPort,
  parseDefaultGateway,
  toolCommand,
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAIN_THREAD_COMMAND_TIMEOUT_MS,
} from '../lib/unity-client.js';
import { startStubServer, reply } from './support/stub-server.js';
import { fakeProcReader } from './support/fake-proc.js';
import { LINUX_GAME_COMM, setProcReader, setWslProbe } from '../lib/game-process.js';
import { NOT_WSL, NO_LISTENER_PORT } from './support/session.js';

const USER_GAME = { isAgentInstance: false, instancesRoot: '/srv/instances' };
const NO_GAME = {};
const A_GAME = { 4242: { comm: LINUX_GAME_COMM, cwd: '/home/player/Broforce' } };

function processTable(t, table) {
  setProcReader(fakeProcReader(table));
  t.after(() => setProcReader(null));
}

function connectedClient(port) {
  return new UnityInspectorClient({ host: '127.0.0.1', port, connectTimeoutMs: 2000 });
}

test('a response that arrives after its command timed out does not resolve the next command', { timeout: 10000 }, async (t) => {
  processTable(t, NO_GAME);
  const stub = await startStubServer((request, socket) => {
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

test('a reply split inside a multi-byte character reaches the caller whole', { timeout: 10000 }, async (t) => {
  const text = `${'x'.repeat(70000)}a—é😀b`;
  const stub = await startStubServer((request, socket) => {
    const bytes = Buffer.from(JSON.stringify({ id: request.id, success: true, result: { text } }) + '\n', 'utf8');
    const emDash = bytes.indexOf(Buffer.from('—', 'utf8'));
    const emoji = bytes.indexOf(Buffer.from('😀', 'utf8'));
    socket.write(bytes.subarray(0, emDash + 1));
    setTimeout(() => {
      socket.write(bytes.subarray(emDash + 1, emoji + 2));
      setTimeout(() => socket.write(bytes.subarray(emoji + 2)), 20);
    }, 20);
  });
  const client = connectedClient(stub.port);
  t.after(async () => { client.disconnect(); await stub.close(); });

  assert.deepEqual(await client.sendCommand('read', {}, 3000), { text });
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
  assert.equal(stub.connectionCount, 1, 'the commands share one connection, one after another');
});

test('connect() rejects instead of hanging when the host is unreachable', { timeout: 10000 }, async () => {
  const client = new UnityInspectorClient({ host: '10.255.255.1', port: 9999, connectTimeoutMs: 300 });
  const started = Date.now();
  await assert.rejects(client.connect());
  assert.ok(Date.now() - started < 5000, 'connect must fail fast, not wait for the OS TCP timeout');
  client.disconnect();
});

test('a closed connection rejects in-flight commands', { timeout: 10000 }, async (t) => {
  processTable(t, NO_GAME);
  const stub = await startStubServer((request, socket) => {
    if (request.method === 'drop') socket.destroy();
  });
  const client = connectedClient(stub.port);
  t.after(async () => { client.disconnect(); await stub.close(); });

  await client.connect();
  await assert.rejects(client.sendCommand('drop', {}, 5000), /Connection (closed|lost)/);
});

const MAIN_THREAD_METHODS = [
  'game_state', 'inspect_component', 'inspect_gameobject', 'inspect_player', 'list_enemies', 'list_gameobjects',
  'query_gameobjects', 'teleport_player', 'set_player_health', 'spawn_entity', 'trace_spawns',
  'set_bro', 'list_bros', 'modify_component', 'take_screenshot',
];

test('commandTimeout pins each command\'s budget', () => {
  for (const method of ['ping', 'list_campaigns']) {
    assert.equal(commandTimeout(method), DEFAULT_COMMAND_TIMEOUT_MS, method);
  }
  assert.equal(DEFAULT_COMMAND_TIMEOUT_MS, 6000);

  assert.equal(MAIN_THREAD_COMMAND_TIMEOUT_MS, 12000);
  for (const method of MAIN_THREAD_METHODS.filter((m) => m !== 'modify_component' && m !== 'take_screenshot')) {
    assert.equal(commandTimeout(method), MAIN_THREAD_COMMAND_TIMEOUT_MS, method);
  }

  assert.equal(commandTimeout('modify_component'), 10000 + 2000 + 1000 + 2000, 'the write, then a read one frame later');
  assert.equal(commandTimeout('take_screenshot'), 2000 + 6000 + 6000 + 3000 + 2000, 'a capture wait, highlight, capture and file');
  assert.equal(commandTimeout('execute_code'), 9000 + 18000 + 2000);
  for (const method of ['execute_script', 'compile_script', 'unload_script']) {
    assert.equal(commandTimeout(method), 10000 + 45000 + 2000, method);
  }

  const arrival = 60000 + 250 + 2000;
  assert.equal(commandTimeout('go_to_level'), 6000 + arrival + 2000, 'a 3s load request, then the in-play wait');
  assert.equal(commandTimeout('restart_level'), 10000 + arrival + 2000, 'a 5s restart, then the in-play wait');
  assert.equal(commandTimeout('swap_bro'), 10000 + 500 + 4000 + 2000, 'the swap, a 500ms pause and a 2s confirmation');
  assert.equal(commandTimeout('set_game_speed'), 10000 + 1000 + 20 + 4000 + 2000, 'the write, then the read-back frames');
});

test('toolCommand picks the mod command and strips the flag that chose it', () => {
  assert.deepEqual(toolCommand('swap_bro', { broName: 'Rambro', ignoreUnlocks: true }), {
    method: 'swap_bro', params: { broName: 'Rambro', ignoreUnlocks: true },
  });
  assert.deepEqual(toolCommand('swap_bro', { broName: 'Rambro', nextSpawn: false }), {
    method: 'swap_bro', params: { broName: 'Rambro' },
  });
  assert.deepEqual(toolCommand('swap_bro', { broName: 'Rambro', playerNum: 1, nextSpawn: true, ignoreUnlocks: false }), {
    method: 'set_bro', params: { broName: 'Rambro', playerNum: 1 },
  });

  assert.deepEqual(toolCommand('execute_script', { source: 's', name: 'n', args: { a: 1 } }), {
    method: 'execute_script', params: { source: 's', name: 'n', args: { a: 1 } },
  });
  assert.deepEqual(toolCommand('execute_script', { source: 's', name: 'n', compileOnly: false }), {
    method: 'execute_script', params: { source: 's', name: 'n' },
  });
  assert.deepEqual(toolCommand('execute_script', { source: 's', name: 'n', args: {}, compileOnly: true }), {
    method: 'compile_script', params: { source: 's', name: 'n' },
  });
  assert.deepEqual(toolCommand('execute_script', { source: 's', name: 'n', origin: '/x/n.cs', compileOnly: true }), {
    method: 'compile_script', params: { source: 's', name: 'n' },
  }, 'compile_script reads no origin');

  const params = { a: 1 };
  assert.deepEqual(toolCommand('ping', params), { method: 'ping', params });
  assert.deepEqual(toolCommand('ping'), { method: 'ping', params: {} });
});

test('a routed tool call waits on its mod command\'s budget', () => {
  const budget = (tool, params) => commandTimeout(toolCommand(tool, params).method);
  assert.equal(budget('swap_bro', { broName: 'Rambro', nextSpawn: true }), MAIN_THREAD_COMMAND_TIMEOUT_MS);
  assert.equal(budget('swap_bro', { broName: 'Rambro' }), commandTimeout('swap_bro'), 'only a swap waits out its confirmation');
  assert.equal(budget('execute_script', { source: 's', name: 'n', compileOnly: true }), commandTimeout('compile_script'));
  assert.equal(budget('execute_script', { source: 's', name: 'n' }), commandTimeout('execute_script'));
});

test('toolCommand refuses a flag the chosen command would ignore', () => {
  assert.throws(
    () => toolCommand('swap_bro', { broName: 'Rambro', nextSpawn: true, ignoreUnlocks: true }),
    /nextSpawn cannot take ignoreUnlocks/,
  );
  assert.throws(
    () => toolCommand('execute_script', { source: 's', name: 'n', compileOnly: true, args: { a: 1 } }),
    /compileOnly cannot take args/,
  );
});

test('pointAt a different port drops the socket, and the same port keeps it', { timeout: 10000 }, async (t) => {
  const first = await startStubServer((request, socket) => reply(socket, request.id, { from: 'first' }));
  const second = await startStubServer((request, socket) => reply(socket, request.id, { from: 'second' }));
  const client = connectedClient(first.port);
  t.after(async () => { client.disconnect(); await first.close(); await second.close(); });

  await client.connect();
  assert.equal(client.pointAt({ port: first.port }), false);
  assert.equal(client.isConnected(), true, 'the same port keeps the socket');

  assert.equal(client.pointAt({ port: second.port }), true);
  assert.equal(client.isConnected(), false, 'a new port drops the old socket');

  assert.deepEqual(await client.sendCommand('ping', {}, 3000), { from: 'second' });
  assert.equal(first.connectionCount, 1);
  assert.equal(second.connectionCount, 1);
});

test('a command with nothing listening says the game is not running', { timeout: 10000, skip: process.platform !== 'linux' }, async (t) => {
  processTable(t, NO_GAME);
  const client = connectedClient(Number(NO_LISTENER_PORT));
  client.gameConfig = USER_GAME;
  t.after(() => client.disconnect());

  await assert.rejects(client.sendCommand('ping', {}, 2000), {
    message: 'Game is not running. Use launch_game to start it.',
  });
});

test('a refused connection to a running game blames the listener, not the game', { timeout: 10000, skip: process.platform !== 'linux' }, async (t) => {
  processTable(t, A_GAME);
  const client = connectedClient(Number(NO_LISTENER_PORT));
  client.gameConfig = USER_GAME;
  t.after(() => client.disconnect());

  await assert.rejects(client.sendCommand('ping', {}, 2000), {
    message: `The game is running, but nothing is listening on 127.0.0.1:${NO_LISTENER_PORT}: the Unity Inspector Mod ` +
      'may still be loading, its server may be stopped or the mod disabled, or it listens on another port.',
  });
});

test('on WSL a refused connection says it cannot tell, names the hosts tried and the setting', { timeout: 10000, skip: process.platform !== 'linux' }, async (t) => {
  processTable(t, A_GAME);
  setWslProbe(() => true);
  t.after(() => setWslProbe(NOT_WSL));
  const client = new UnityInspectorClient({ port: Number(NO_LISTENER_PORT), connectTimeoutMs: 2000 });
  client.gameConfig = USER_GAME;
  client.wslGatewayLookup = Promise.resolve(null);
  t.after(() => client.disconnect());

  const error = await client.sendCommand('ping', {}, 2000).catch((err) => err);
  assert.match(error.message, /^Nothing is listening on 127\.0\.0\.1:1, and whether the game is running cannot be seen from here/);
  assert.match(error.message, /On WSL this server tries 127\.0\.0\.1: .*"Allow remote connections".*UNITY_INSPECTOR_HOST names the host outright\.$/);
});

test('a socket reset under a command reads as a closed connection', { timeout: 10000 }, async (t) => {
  processTable(t, NO_GAME);
  const stub = await startStubServer((request, socket) => {
    if (request.method === 'reset') socket.resetAndDestroy();
    else reply(socket, request.id, { from: request.method });
  });
  const client = connectedClient(stub.port);
  t.after(async () => { client.disconnect(); await stub.close(); });

  await client.connect();
  await assert.rejects(client.sendCommand('reset', {}, 5000), {
    message: 'Connection closed — game likely crashed',
  });

  assert.deepEqual(await client.sendCommand('ping', {}, 3000), { from: 'ping' }, 'the next command reconnects');
});

test('a connection the inspector closes while the game keeps running is not called a crash', { timeout: 10000, skip: process.platform !== 'linux' }, async (t) => {
  processTable(t, A_GAME);
  const stub = await startStubServer((request, socket) => socket.destroy());
  const client = connectedClient(stub.port);
  client.gameConfig = USER_GAME;
  t.after(async () => { client.disconnect(); await stub.close(); });

  await assert.rejects(client.sendCommand('drop', {}, 500), {
    message: 'The Unity Inspector Mod closed the connection while the game kept running: its server was stopped ' +
      'or restarted, or the mod was disabled or reloaded',
  });
});

test('a disconnect under a command gives the command the reason it was dropped', { timeout: 10000 }, async (t) => {
  const stub = await startStubServer(() => {});
  const client = connectedClient(stub.port);
  t.after(async () => { client.disconnect(); await stub.close(); });

  const command = client.sendCommand('execute_code', { code: 'x' }, 5000);
  while (stub.lines.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
  client.disconnect('stop_game stopped the game before this command was answered');
  await assert.rejects(command, { message: 'stop_game stopped the game before this command was answered' });
});

test('a game that dies under a command is reported as a crash', { timeout: 10000, skip: process.platform !== 'linux' }, async (t) => {
  const processes = { ...A_GAME };
  setProcReader(fakeProcReader(processes));

  const stub = await startStubServer(() => {});
  const client = connectedClient(stub.port);
  client.gameConfig = { isAgentInstance: false, instancesRoot: '/srv/instances' };
  t.after(async () => { setProcReader(null); client.disconnect(); await stub.close(); });

  await client.connect();
  const command = client.sendCommand('hang', {}, 8000);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  delete processes[4242];

  await assert.rejects(command, { message: 'Game process died — the command likely caused a crash' });
});

async function heldStub(t) {
  const arrived = [];
  const waiting = [];
  const stub = await startStubServer((request, socket) => {
    const held = { request, socket };
    const waiter = waiting.shift();
    if (waiter) waiter(held);
    else arrived.push(held);
  });
  t.after(() => stub.close());
  return {
    port: stub.port,
    get connectionCount() { return stub.connectionCount; },
    lines: stub.lines,
    next: () => (arrived.length > 0 ? Promise.resolve(arrived.shift()) : new Promise((resolve) => waiting.push(resolve))),
  };
}

async function mockedClockClient(t, port) {
  setProcReader(fakeProcReader({}));
  const client = connectedClient(port);
  t.after(() => { setProcReader(null); client.disconnect(); });
  await client.connect();
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  return client;
}

const STARTED_ACTION_ERROR = (budgetMs) =>
  `Main thread action started but has not finished after ${2 * budgetMs}ms - the main thread is not advancing`;

const STILL_RUNNING = (seconds, stopAtSeconds) =>
  `still running after ${seconds}s, and the stop requested at ${stopAtSeconds}s did not reach it: it is inside a ` +
  'game, engine or library call, or a loop not compiled by the script system; the game\'s main thread is held until it returns';

const LATE_REPLIES = [
  {
    row: 'execute_code.long-running',
    method: 'execute_code',
    params: { code: 'System.Threading.Thread.Sleep(12000);\nreturn "slept 12s";' },
    oldBudgetMs: 10000,
    answersAtMs: 9000 + 2000 + 100,
    result: {
      success: false,
      error: `The code started and is ${STILL_RUNNING(11, 9)}. Every later command that needs the main thread waits behind it.`,
      stackTrace: null, position: null, statement: null, result: null,
    },
  },
  {
    row: 'execute_code.long-running, started at the end of its start budget',
    method: 'execute_code',
    params: { code: 'System.Threading.Thread.Sleep(20000);' },
    oldBudgetMs: 10000,
    answersAtMs: 9000 + 18000 - 100,
    result: {
      success: false,
      error: `The code started and is ${STILL_RUNNING(11, 9)}. Every later command that needs the main thread waits behind it.`,
      stackTrace: null, position: null, statement: null, result: null,
    },
  },
  {
    row: 'execute_script.long-main',
    method: 'execute_script',
    params: { name: 'lifecycle-slow', source: 'public static class LifecycleSlow {}', args: {} },
    oldBudgetMs: 30000,
    answersAtMs: 10000 + 45000 - 100,
    result: {
      success: false,
      error: `execute_script lifecycle-slow is ${STILL_RUNNING(17, 15)} (in Main()). The rest of it runs once that returns, and its outcome is not reported.`,
    },
  },
  {
    row: 'unload_script.unload-stalled',
    method: 'unload_script',
    params: { name: 'lifecycle-stalled' },
    oldBudgetMs: 20000,
    answersAtMs: 10000 + 45000 - 100,
    result: {
      success: false,
      error: `unload_script lifecycle-stalled is ${STILL_RUNNING(17, 15)} (in Unload()). The rest of it runs once that returns, and its outcome is not reported.`,
    },
  },
  {
    row: 'modify_component.main-thread-busy',
    method: 'modify_component',
    params: { path: '/Player', componentType: 'Transform', properties: { tag: 'x' } },
    oldBudgetMs: 6000,
    answersAtMs: 10000,
    result: { success: false, error: STARTED_ACTION_ERROR(5000) },
  },
  {
    row: 'spawn_entity.main-thread-busy',
    method: 'spawn_entity',
    params: { entityType: 'Mook', x: 0, y: 0 },
    oldBudgetMs: 6000,
    answersAtMs: 10000,
    result: { success: false, error: STARTED_ACTION_ERROR(5000), stackTrace: null },
  },
];

for (const { row, method, params, oldBudgetMs, answersAtMs, result } of LATE_REPLIES) {
  test(`${row}: the mod's own late answer reaches the caller`, { timeout: 10000 }, async (t) => {
    assert.ok(answersAtMs > oldBudgetMs, 'the case is one the earlier budget timed out');
    assert.ok(answersAtMs < commandTimeout(method, params), 'the budget outlasts the mod');

    const stub = await heldStub(t);
    const client = await mockedClockClient(t, stub.port);

    const command = client.sendCommand(method, params);
    const { request, socket } = await stub.next();
    assert.equal(request.method, method);

    t.mock.timers.tick(answersAtMs);
    reply(socket, request.id, result);

    assert.deepEqual(await command, result);
  });
}

test('all.started-action-timeout: a started main-thread action\'s answer reaches the caller', { timeout: 10000 }, async (t) => {
  const stub = await heldStub(t);
  const client = await mockedClockClient(t, stub.port);

  for (const method of MAIN_THREAD_METHODS) {
    const answer = { success: false, error: STARTED_ACTION_ERROR(5000) };
    const command = client.sendCommand(method, {});
    const { request, socket } = await stub.next();

    t.mock.timers.tick(2 * 5000);
    reply(socket, request.id, answer);

    assert.deepEqual(await command, answer, method);
  }
});

function outcome(name, command) {
  return command.then((value) => [name, 'resolved', value], (error) => [name, 'rejected', error.message]);
}

const settleIo = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

test('a command is written only once the one before it settles, and its budget starts at its write', { timeout: 10000 }, async (t) => {
  const stub = await heldStub(t);
  const client = await mockedClockClient(t, stub.port);

  const first = client.sendCommand('execute_code', { code: '"first"' });
  const second = client.sendCommand('game_state', {});
  const sentFirst = await stub.next();
  assert.deepEqual(client.inFlightCommands(), ['execute_code', 'game_state'], 'a queued command counts as in flight');

  t.mock.timers.tick(DEFAULT_COMMAND_TIMEOUT_MS + 1000);
  await settleIo();
  assert.equal(stub.lines.length, 1, 'the second command waits unwritten behind the first');

  reply(sentFirst.socket, sentFirst.request.id, { success: true, resultSet: true, result: 'first' });
  assert.deepEqual(await first, { success: true, resultSet: true, result: 'first' });

  const sentSecond = await stub.next();
  assert.equal(sentSecond.request.method, 'game_state');
  t.mock.timers.tick(DEFAULT_COMMAND_TIMEOUT_MS - 1);
  reply(sentSecond.socket, sentSecond.request.id, { scene: 'Test Evan2' });
  assert.deepEqual(await second, { scene: 'Test Evan2' }, 'the wait behind the first was not counted against it');
});

test('an error reply fails its own command and the next one is written', { timeout: 10000 }, async (t) => {
  const stub = await heldStub(t);
  const client = await mockedClockClient(t, stub.port);

  const failing = client.sendCommand('inspect_component', { path: '/Nowhere', componentType: 'Transform' });
  const pending = client.sendCommand('game_state', {});
  const sentFailing = await stub.next();
  sentFailing.socket.write(JSON.stringify({ id: sentFailing.request.id, success: false, error: 'GameObject not found: /Nowhere' }) + '\n');
  await assert.rejects(failing, { message: 'GameObject not found: /Nowhere' });

  const sentPending = await stub.next();
  assert.deepEqual(client.inFlightCommands(), ['game_state']);
  reply(sentPending.socket, sentPending.request.id, { scene: 'Test Evan2' });
  assert.deepEqual(await pending, { scene: 'Test Evan2' });
});

test('all.after-timeout: the next command goes out on a fresh connection and gets its own answer', { timeout: 10000 }, async (t) => {
  const stub = await heldStub(t);
  const client = await mockedClockClient(t, stub.port);

  const dead = client.sendCommand('execute_code', { code: 'for (;;) {}' });
  const held = await stub.next();
  t.mock.timers.tick(commandTimeout('execute_code'));
  await assert.rejects(dead, {
    code: COMMAND_TIMEOUT,
    message: `Command timeout after ${commandTimeout('execute_code')}ms — the game may still carry the command out`,
  });

  const next = client.sendCommand('execute_code', { code: '1 + 1' });
  const { request, socket } = await stub.next();
  assert.deepEqual(request.params, { code: '1 + 1' });
  assert.equal(stub.connectionCount, 2, 'the connection still running the stuck command was dropped');
  assert.notEqual(socket, held.socket);

  reply(socket, request.id, { success: true, resultSet: true, result: 2 });
  assert.deepEqual(await next, { success: true, resultSet: true, result: 2 });
});

test('cancelling a call drops its running command and lets the next one through on a fresh connection', { timeout: 10000 }, async (t) => {
  const stub = await heldStub(t);
  const client = await mockedClockClient(t, stub.port);

  const controller = new AbortController();
  const cancelled = client.runCall(controller.signal, () => client.sendCommand('execute_script', { name: 'slow' }));
  await stub.next();
  const after = client.sendCommand('game_state', {});

  controller.abort();
  await assert.rejects(cancelled, { code: COMMAND_CANCELLED, message: 'execute_script was cancelled' });

  const { request, socket } = await stub.next();
  assert.equal(request.method, 'game_state');
  assert.equal(stub.connectionCount, 2);
  reply(socket, request.id, { scene: 'Test Evan2' });
  assert.deepEqual(await after, { scene: 'Test Evan2' });
});

test('cancelling a call takes its queued command out unwritten and leaves the running one alone', { timeout: 10000 }, async (t) => {
  const stub = await heldStub(t);
  const client = await mockedClockClient(t, stub.port);

  const running = client.sendCommand('execute_code', { code: 'x' });
  const held = await stub.next();
  const controller = new AbortController();
  const queued = client.runCall(controller.signal, () => client.sendCommand('game_state', {}));

  controller.abort();
  await assert.rejects(queued, { code: COMMAND_CANCELLED });
  assert.deepEqual(client.inFlightCommands(), ['execute_code']);

  reply(held.socket, held.request.id, { success: true, resultSet: true, result: 1 });
  assert.deepEqual(await running, { success: true, resultSet: true, result: 1 });
  await settleIo();
  assert.equal(stub.lines.length, 1, 'the cancelled command was never written');
  assert.equal(stub.connectionCount, 1);
});

test('UNITY_INSPECTOR_HOST points the user\'s game elsewhere, and never the instance', { timeout: 10000, skip: process.platform !== 'linux' }, async (t) => {
  const stub = await startStubServer((request, socket) => reply(socket, request.id, { from: 'elsewhere' }), { host: '127.0.0.2' });
  process.env.UNITY_INSPECTOR_HOST = '127.0.0.2';
  t.after(async () => { delete process.env.UNITY_INSPECTOR_HOST; await stub.close(); });
  processTable(t, NO_GAME);

  const client = new UnityInspectorClient({ port: stub.port, connectTimeoutMs: 2000 });
  client.gameConfig = USER_GAME;
  t.after(() => client.disconnect());
  assert.deepEqual(await client.sendCommand('ping', {}, 2000), { from: 'elsewhere' });

  const instance = new UnityInspectorClient({ port: stub.port, connectTimeoutMs: 2000 });
  instance.gameConfig = { isAgentInstance: true, id: 'abc', workDir: '/srv/instances/abc/work' };
  t.after(() => instance.disconnect());
  await assert.rejects(instance.sendCommand('ping', {}, 2000), { message: 'Game is not running. Use launch_game to start it.' });
  assert.deepEqual(instance.lastHosts, ['127.0.0.1']);
});

test('on WSL the Windows host behind the default route is tried after loopback', { timeout: 10000, skip: process.platform !== 'linux' }, async (t) => {
  const stub = await startStubServer((request, socket) => reply(socket, request.id, { from: 'windows' }), { host: '127.0.0.2' });
  t.after(() => stub.close());
  const client = new UnityInspectorClient({ port: stub.port, connectTimeoutMs: 2000 });
  client.platform = 'wsl';
  client.wslGatewayLookup = Promise.resolve('127.0.0.2');
  client.gameConfig = USER_GAME;
  t.after(() => client.disconnect());

  assert.deepEqual(await client.sendCommand('ping', {}, 2000), { from: 'windows' });
  assert.deepEqual(client.lastHosts, ['127.0.0.1', '127.0.0.2']);
});

test('the Windows host is the word after via on the default route, and nothing without one', () => {
  assert.equal(parseDefaultGateway('default via 172.28.160.1 dev eth0 proto kernel\n'), '172.28.160.1');
  assert.equal(parseDefaultGateway('10.0.0.0/8 via 10.0.0.1 dev eth1\ndefault via 192.168.1.1 dev eth0\n'), '192.168.1.1');
  assert.equal(parseDefaultGateway('default dev eth0 scope link\n'), null);
  assert.equal(parseDefaultGateway(''), null);
});

test('an invalid UNITY_INSPECTOR_PORT is logged once, not on every call', (t) => {
  const logged = [];
  const original = console.error;
  console.error = (line) => logged.push(line);
  t.after(() => { console.error = original; });

  for (let i = 0; i < 3; i++) defaultPort({ UNITY_INSPECTOR_PORT: 'abc-once' });
  assert.equal(logged.filter((line) => /abc-once/.test(line)).length, 1);
});

test('concurrent platform detections share one, so none sees it half done', async (t) => {
  const client = new UnityInspectorClient({ port: 1 });
  const first = client.detectPlatform();
  const second = client.detectPlatform();
  assert.equal(first, second);
  await second;
  assert.ok(client.platform);
});

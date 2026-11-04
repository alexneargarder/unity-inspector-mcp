import './support/session.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { startStubServer, reply } from './support/stub-server.js';

const requests = [];
const stub = await startStubServer((request, socket) => {
  requests.push(request);
  reply(socket, request.id, { success: true, method: request.method });
});

// The module-level client reads the port once at import, so the stub has to be listening before index.js loads
process.env.UNITY_INSPECTOR_PORT = String(stub.port);

const { handleToolCall } = await import('../index.js');

after(() => stub.close());

function textOf(response) {
  return response.content.map((c) => c.text).join('\n');
}

function lastRequest(method) {
  const sent = requests.filter((r) => r.method === method);
  assert.ok(sent.length > 0, `no ${method} request reached the game`);
  return sent[sent.length - 1];
}

test('tool calls with no "arguments" member do not throw', { timeout: 20000 }, async () => {
  for (const name of ['list_test_scripts', 'list_scripts', 'read_log', 'list_gameobjects', 'query_gameobjects']) {
    const response = await handleToolCall({ params: { name } });
    const text = textOf(response);
    assert.doesNotMatch(
      text,
      /Cannot read propert(y|ies)|of undefined|is not a function/,
      `${name} blew up on missing arguments: ${text}`,
    );
  }
});

test('a Node-only tool works without arguments', async () => {
  const response = await handleToolCall({ params: { name: 'list_test_scripts' } });
  assert.ok(!response.isError, textOf(response));
  const payload = JSON.parse(textOf(response));
  assert.ok(payload.count >= 3);
});

test('an unknown tool reports an error rather than throwing', async () => {
  const response = await handleToolCall({ params: { name: 'no_such_tool' } });
  assert.equal(response.isError, true);
  assert.match(textOf(response), /Unknown tool/);
});

test('simulate_input forwards a sequence to the game untouched', async () => {
  const sequence = [{ action: 'special', duration: 150 }, { wait: 800 }, { action: 'special', duration: 150 }];
  const response = await handleToolCall({
    params: { name: 'simulate_input', arguments: { sequence, player: 1 } },
  });

  assert.ok(!response.isError, textOf(response));
  const sent = lastRequest('simulate_input');
  assert.deepEqual(sent.params.sequence, sequence);
  assert.equal(sent.params.player, 1);
  assert.equal(sent.params.action, undefined, 'no action is invented for a sequence call');
});

test('a dotted member path reaches the game unchanged', async () => {
  const inspected = await handleToolCall({
    params: {
      name: 'inspect_component',
      arguments: { path: '/Player', componentType: 'TestVanDammeAnim', memberPath: 'transform.localPosition.x' },
    },
  });

  assert.ok(!inspected.isError, textOf(inspected));
  const read = lastRequest('inspect_component');
  assert.equal(read.params.memberPath, 'transform.localPosition.x');
  assert.equal(read.params.path, '/Player');
  assert.equal(read.params.componentType, 'TestVanDammeAnim');

  const modified = await handleToolCall({
    params: {
      name: 'modify_component',
      arguments: {
        path: '/Player',
        component: 'TestVanDammeAnim',
        properties: { 'transform.localPosition.x': 3.5 },
      },
    },
  });

  assert.ok(!modified.isError, textOf(modified));
  const written = lastRequest('modify_component');
  assert.deepEqual(written.params.properties, { 'transform.localPosition.x': 3.5 });
});

test('simulate_input needs exactly one of action and sequence', async () => {
  const neither = await handleToolCall({ params: { name: 'simulate_input', arguments: {} } });
  assert.equal(neither.isError, true);
  assert.match(textOf(neither), /action/);
  assert.match(textOf(neither), /sequence/);

  const both = await handleToolCall({
    params: { name: 'simulate_input', arguments: { action: 'fire', sequence: [{ action: 'jump' }] } },
  });
  assert.equal(both.isError, true);
  assert.match(textOf(both), /action/);
  assert.match(textOf(both), /sequence/);

  const empty = await handleToolCall({ params: { name: 'simulate_input', arguments: { sequence: [] } } });
  assert.equal(empty.isError, true, 'an empty sequence is not a sequence');
});

test('take_screenshot sends a highlight only when one was asked for', async () => {
  const bare = await handleToolCall({ params: { name: 'take_screenshot', arguments: {} } });
  assert.ok(!bare.isError, textOf(bare));
  assert.deepEqual(lastRequest('take_screenshot').params, {}, 'a bare call sends no highlight');

  const byPath = await handleToolCall({
    params: { name: 'take_screenshot', arguments: { highlight: '/Player' } },
  });
  assert.ok(!byPath.isError, textOf(byPath));
  assert.deepEqual(lastRequest('take_screenshot').params, { highlight: '/Player' });

  const rectangle = { x: -10.5, y: 4, width: 20, height: 8.25 };
  const byRect = await handleToolCall({
    params: { name: 'take_screenshot', arguments: { highlight: rectangle } },
  });
  assert.ok(!byRect.isError, textOf(byRect));
  assert.deepEqual(lastRequest('take_screenshot').params, { highlight: rectangle });
});

test('spawn_entity forwards ignoreSuppression to the game', async () => {
  const response = await handleToolCall({
    params: { name: 'spawn_entity', arguments: { type: 'Mook', x: 10, y: 20, ignoreSuppression: true } },
  });
  assert.ok(!response.isError, textOf(response));
  const sent = lastRequest('spawn_entity');
  assert.equal(sent.params.ignoreSuppression, true);
  assert.equal(sent.params.type, 'Mook');
});

test('swap_bro forwards ignoreUnlocks to the game', async () => {
  const response = await handleToolCall({
    params: { name: 'swap_bro', arguments: { broName: 'Rambro', ignoreUnlocks: true } },
  });
  assert.ok(!response.isError, textOf(response));
  assert.deepEqual(lastRequest('swap_bro').params, { broName: 'Rambro', playerNum: 0, ignoreUnlocks: true });
});

test('swap_bro with nextSpawn reaches the mod as set_bro, without the flag', async () => {
  const response = await handleToolCall({
    params: { name: 'swap_bro', arguments: { broName: 'Rambro', playerNum: 2, nextSpawn: true } },
  });
  assert.ok(!response.isError, textOf(response));
  assert.deepEqual(lastRequest('set_bro').params, { broName: 'Rambro', playerNum: 2 });
});

test('swap_bro refuses nextSpawn with ignoreUnlocks and sends nothing', async () => {
  const before = requests.length;
  const response = await handleToolCall({
    params: { name: 'swap_bro', arguments: { broName: 'Rambro', nextSpawn: true, ignoreUnlocks: true } },
  });
  assert.equal(response.isError, true);
  assert.match(textOf(response), /nextSpawn cannot take ignoreUnlocks/);
  assert.equal(requests.length, before);
});

test('execute_script with compileOnly reaches the mod as compile_script, without the flag or args', async () => {
  const response = await handleToolCall({
    params: { name: 'execute_script', arguments: { path: 'watch-field', compileOnly: true } },
  });
  assert.ok(!response.isError, textOf(response));
  const { source, name, ...rest } = lastRequest('compile_script').params;
  assert.match(source, /class /);
  assert.equal(name, 'watch-field');
  assert.deepEqual(rest, {});
});

test('execute_script without compileOnly still runs, its args passed through', async () => {
  const response = await handleToolCall({
    params: { name: 'execute_script', arguments: { path: 'watch-field', args: { field: 'health' }, compileOnly: false } },
  });
  assert.ok(!response.isError, textOf(response));
  const { params } = lastRequest('execute_script');
  assert.deepEqual(params.args, { field: 'health' });
  assert.ok(!('compileOnly' in params), 'the flag never reaches the mod');
});

test('execute_script refuses compileOnly with args and sends nothing', async () => {
  const before = requests.length;
  const response = await handleToolCall({
    params: { name: 'execute_script', arguments: { path: 'watch-field', compileOnly: true, args: { field: 'health' } } },
  });
  assert.equal(response.isError, true);
  assert.match(textOf(response), /compileOnly cannot take args/);
  assert.equal(requests.length, before);
});

test('trace_spawns forwards action, targets and since to the game', async () => {
  const start = await handleToolCall({
    params: { name: 'trace_spawns', arguments: { action: 'start', targets: ['Map.PlaceDoodad'] } },
  });
  assert.ok(!start.isError, textOf(start));
  assert.deepEqual(lastRequest('trace_spawns').params, { action: 'start', targets: ['Map.PlaceDoodad'] });

  const read = await handleToolCall({
    params: { name: 'trace_spawns', arguments: { action: 'read', since: 42 } },
  });
  assert.ok(!read.isError, textOf(read));
  assert.deepEqual(lastRequest('trace_spawns').params, { action: 'read', since: 42 });
});

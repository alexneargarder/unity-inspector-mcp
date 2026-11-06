import './support/session.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { startStubServer, reply } from './support/stub-server.js';
import { CSHARP_SCRIPTS_DIR } from '../lib/script-library.js';
import { wslMountRoot } from '../lib/unity-client.js';

const requests = [];
const answers = new Map();
const stub = await startStubServer((request, socket) => {
  requests.push(request);
  const answer = answers.get(request.method);
  if (answer === 'drop') {
    socket.destroy();
    return;
  }
  reply(socket, request.id, answer ?? { success: true, method: request.method });
});

// The module-level client reads the port once at import, so the stub has to be listening before index.js loads
process.env.UNITY_INSPECTOR_PORT = String(stub.port);

const { handleToolCall, toolArguments, unityClient, resetPlatformDetection } = await import('../index.js');

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

test('simulate_input needs exactly one of action, binding and sequence', async () => {
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

  for (const args of [
    { action: 'fire', binding: 'Utility Mod/Pause/Unpause Game' },
    { binding: 'Utility Mod/Pause/Unpause Game', sequence: [{ action: 'jump' }] },
  ]) {
    await assertRefusedBeforeTheGame('simulate_input', args, /Exactly one of action, binding or sequence is required/);
  }
});

test('simulate_input refuses a malformed plan before it reaches the game', async () => {
  const cases = [
    [{ sequence: [{ action: 'right', hold: 2000 }] }, /Step 0 has no key "hold"; a step takes action, binding, duration and wait/],
    [{ sequence: [{ key: 'jump' }] }, /Step 0 has no key "key"/],
    [{ sequence: [{ action: 'jump', delay: 100 }] }, /Step 0 has no key "delay"/],
    [{ sequence: [{ wait: 500, duration: 90000 }] }, /Step 0 has a duration but no action or binding/],
    [{ sequence: [{ action: 'jump', binding: 'Furibrosa/Switch Weapon' }] }, /Step 0 has both an action and a binding; a step presses one/],
    [{ binding: 'Furibrosa/Switch Weapon', count: 0 }, /count must be at least 1/],
    [{ binding: 'Furibrosa/Switch Weapon', duration: -5 }, /must not be negative/],
    [{ binding: 5 }, /simulate_input: binding must be a string, got 5/],
    [{ sequence: [{ binding: 5 }] }, /simulate_input: sequence\[0\]\.binding must be a string, got 5/],
    [{ sequence: [{ action: 'right', duration: '500' }] }, /simulate_input: sequence\[0\]\.duration must be an integer, got "500"/],
    [{ sequence: [{ action: 'jump', wait: -1 }] }, /Step 0 has a negative duration or wait/],
    [{ sequence: [5] }, /simulate_input: sequence\[0\] must be an object, got 5/],
    [{ sequence: [{ action: 'fire' }, { action: 'jump' }], count: 3 }, /apply to an action, not to a sequence/],
    [{ sequence: [{ action: 'fire' }], duration: 100 }, /apply to an action, not to a sequence/],
    [{ action: 'jump', count: 0 }, /count must be at least 1/],
    [{ action: 'jump', count: 2.5 }, /simulate_input: count must be an integer, got 2.5/],
    [{ action: 'jump', duration: '500' }, /simulate_input: duration must be an integer, got "500"/],
    [{ action: 'jump', interval: -1, count: 2 }, /must not be negative/],
    [{ action: 'jump', player: 4 }, /player must be 0 to 3, got 4/],
    [{ action: 5 }, /simulate_input: action must be a string, got 5/],
  ];
  for (const [args, pattern] of cases) await assertRefusedBeforeTheGame('simulate_input', args, pattern);
});

test('simulate_input answers with the finished plan, polling the game until it ends', async () => {
  answers.set('simulate_input', { pending: true, planId: 41, remainingMs: 10 });
  answers.set('input_plan', { success: true, action: 'jump', player: 0, framesRead: 3 });
  try {
    const before = requests.length;
    const response = await call('simulate_input', { action: 'jump' });
    assert.ok(!response.isError, textOf(response));
    assert.deepEqual(JSON.parse(textOf(response)), { success: true, action: 'jump', player: 0, framesRead: 3 });
    const sent = requests.slice(before);
    assert.deepEqual(sent.map((r) => r.method), ['simulate_input', 'input_plan']);
    assert.deepEqual(sent[1].params, { planId: 41 });
  } finally {
    answers.delete('simulate_input');
    answers.delete('input_plan');
  }
});

test('capture_animations is refused while a test script runs, its waits included', { timeout: 20000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uim-running-script-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scriptPath = path.join(dir, 'slow.json');
  await fs.writeFile(scriptPath, JSON.stringify({
    name: 'slow', steps: [{ command: 'ping', params: {}, wait: 1500 }],
  }));

  const running = call('run_test_script', { script: scriptPath });
  await new Promise((resolve) => setTimeout(resolve, 500));

  const refused = await call('capture_animations', { out: path.join(dir, 'out') });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /Cannot start an animation capture sweep while test script .*slow\.json is running/);

  const finished = await running;
  assert.ok(!finished.isError, textOf(finished));
  const after = await call('capture_animations', { out: path.join(dir, 'out'), timeout: 0.01 });
  assert.doesNotMatch(textOf(after), /while test script/, 'the record is cleared when the script ends');
});

test('a capture sweep and a test script sent together do not both run', { timeout: 20000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uim-sweep-race-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scriptPath = path.join(dir, 'slow.json');
  await fs.writeFile(scriptPath, JSON.stringify({
    name: 'slow', steps: [{ command: 'ping', params: {}, wait: 1000 }],
  }));

  const [capture, script] = await Promise.all([
    call('capture_animations', { out: path.join(dir, 'out'), timeout: 1 }),
    call('run_test_script', { script: scriptPath }),
  ]);
  const refusals = [capture, script].filter((response) => /Cannot (start an animation capture sweep|run run_test_script) while/.test(textOf(response)));
  assert.equal(refusals.length, 1, `capture: ${textOf(capture)}\nscript: ${textOf(script)}`);
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

async function call(name, args) {
  return handleToolCall({ params: { name, arguments: args } });
}

async function assertRefusedBeforeTheGame(name, args, pattern) {
  const before = requests.length;
  const response = await call(name, args);
  assert.equal(response.isError, true, `${name} accepted ${JSON.stringify(args)}: ${textOf(response)}`);
  assert.match(textOf(response), pattern);
  assert.equal(requests.length, before, `${name} reached the game`);
  return textOf(response);
}

test('every tool refuses an argument its schema does not declare, naming it and the valid ones', async () => {
  for (const [name, schemas] of toolArguments()) {
    const valid = Object.keys(schemas);
    const text = await assertRefusedBeforeTheGame(name, { notAnArgument: 1 }, /"notAnArgument"/);
    if (valid.length === 0) {
      assert.match(text, /takes no arguments/, name);
    } else {
      for (const key of valid) assert.match(text, new RegExp(`\\b${key}\\b`), `${name} does not list ${key}`);
    }
  }
});

test('the misnamed keys real calls sent are refused, never run without them', async () => {
  const cases = [
    ['set_player_health', { health: 50, player: '1' }, '"player"', 'playerNum'],
    ['query_gameobjects', { name: 'Mook' }, '"name"', 'namePattern'],
    ['teleport_player', { x: 1, y: 2, player: '0' }, '"player"', 'playerNum'],
    ['simulate_input', { action: 'fire', run_in_background: true }, '"run_in_background"', 'action'],
    ['execute_script', { script: 'class X {}' }, '"script"', 'path'],
    ['unload_script', { path: 'watch-field' }, '"path"', 'name'],
    ['spawn_entity', { entity: 'Mook', x: 1, y: 2 }, '"entity"', 'type'],
    ['inspect_component', { path: '/Player', component: 'Transform' }, '"component"', 'componentType'],
  ];
  for (const [name, args, unknown, valid] of cases) {
    const text = await assertRefusedBeforeTheGame(name, args, new RegExp(unknown));
    assert.match(text, new RegExp(`its arguments are .*\\b${valid}\\b`), `${name}: ${text}`);
  }

  const both = await assertRefusedBeforeTheGame('spawn_entity', { entity: 'Mook', entityType: 'Mook', x: 1, y: 2 }, /arguments "entity", "entityType"/);
  assert.match(both, /\btype\b/);
});

const WRONG_TYPED = {
  string: [5, '5'],
  number: ['1', '"1"'],
  integer: ['1', '"1"'],
  boolean: ['false', '"false"'],
  object: ['x', '"x"'],
  array: ['x', '"x"'],
};

test('every tool refuses an argument of the wrong type, naming it, the type and what was sent', async () => {
  const typeNames = { string: 'a string', number: 'a number', integer: 'an integer', boolean: 'a boolean', object: 'an object', array: 'an array' };
  for (const [name, schemas] of toolArguments()) {
    for (const [key, schema] of Object.entries(schemas)) {
      const types = [schema.type].flat();
      const [value, sent] = types.includes('string') ? [true, 'true'] : WRONG_TYPED[types[0]];
      const expected = `${name}: ${key} must be ${types.map((type) => typeNames[type]).join(' or ')}, got ${sent}`;
      const text = await assertRefusedBeforeTheGame(name, { [key]: value }, /must be/);
      assert.ok(text.includes(expected), `${name}.${key}: ${text}`);
    }
  }
});

test('a string for a flag is refused, never read as true', async () => {
  const cases = [
    ['stop_game', { remove: 'false' }, 'remove'],
    ['launch_game', { restart: 'false' }, 'restart'],
    ['launch_game', { steam: 'no' }, 'steam'],
    ['swap_bro', { broName: 'Rambro', nextSpawn: 'false' }, 'nextSpawn'],
    ['execute_script', { path: 'watch-field', compileOnly: 'false' }, 'compileOnly'],
    ['read_log', { onlyNew: 'true', reset: 'false' }, 'onlyNew'],
    ['spawn_entity', { type: 'Mook', x: 1, y: 2, ignoreSuppression: 1 }, 'ignoreSuppression'],
  ];
  for (const [name, args, key] of cases) {
    await assertRefusedBeforeTheGame(name, args, new RegExp(`${key} must be a boolean`));
  }
});

test('a non-integer where an integer is meant, and a number past the finite range, are refused', async () => {
  const cases = [
    ['go_to_level', { campaignIndex: 1.5, levelIndex: 0 }, 'go_to_level: campaignIndex must be an integer, got 1.5'],
    ['list_bros', { playerNum: 0.5 }, 'list_bros: playerNum must be an integer, got 0.5'],
    ['set_player_health', { health: 50.5 }, 'set_player_health: health must be an integer, got 50.5'],
    ['simulate_input', { action: 'jump', count: 2.5 }, 'simulate_input: count must be an integer, got 2.5'],
    ['teleport_player', { x: Infinity, y: 1 }, 'teleport_player: x must be a number, got Infinity'],
    ['spawn_entity', { type: 'Mook', x: 1, y: NaN }, 'spawn_entity: y must be a number, got NaN'],
    ['set_game_speed', { speed: -Infinity }, 'set_game_speed: speed must be a number, got -Infinity'],
  ];
  for (const [name, args, message] of cases) {
    assert.equal(await assertRefusedBeforeTheGame(name, args, /must be/), `Error: ${message}`);
  }

  const whole = await call('go_to_level', { campaignIndex: 2.0, levelIndex: 0 });
  assert.ok(!whole.isError, textOf(whole));
  assert.deepEqual(lastRequest('go_to_level').params, { campaignIndex: 2, levelIndex: 0 });
});

test('a value inside an argument is checked against the schema it carries', async () => {
  const cases = [
    ['simulate_input', { sequence: [{ action: 'jump', duration: '50' }] }, 'simulate_input: sequence[0].duration must be an integer, got "50"'],
    ['simulate_input', { sequence: [{ action: 'jump' }, 5] }, 'simulate_input: sequence[1] must be an object, got 5'],
    ['take_screenshot', { highlight: { x: '1', y: 2, width: 3, height: 4 } }, 'take_screenshot: highlight.x must be a number, got "1"'],
    ['take_screenshot', { highlight: 5 }, 'take_screenshot: highlight must be a string or an object, got 5'],
    ['trace_spawns', { action: 'pause' }, 'trace_spawns: action must be one of "start", "read", "stop", got "pause"'],
    ['trace_spawns', { action: 'start', targets: ['Nope.Method'] }, 'trace_spawns: targets[0] must be one of'],
  ];
  for (const [name, args, message] of cases) {
    const text = await assertRefusedBeforeTheGame(name, args, /must be/);
    assert.ok(text.startsWith(`Error: ${message}`), text);
  }

  const two = await assertRefusedBeforeTheGame('teleport_player', { x: '1', y: true }, /must be/);
  assert.equal(two, 'Error: teleport_player: x must be a number, got "1"; teleport_player: y must be a number, got true');
});

test('a null argument is an absent one', async () => {
  const teleport = await call('teleport_player', { x: 1, y: 2, z: null, playerNum: null });
  assert.ok(!teleport.isError, textOf(teleport));
  assert.deepEqual(lastRequest('teleport_player').params, { x: 1, y: 2, playerNum: 0 });

  const spawn = await call('spawn_entity', { type: 'Mook', x: 1, y: 2, xI: null, yI: null, ignoreSuppression: null });
  assert.ok(!spawn.isError, textOf(spawn));
  assert.deepEqual(lastRequest('spawn_entity').params, { type: 'Mook', x: 1, y: 2 });

  const listed = await call('list_gameobjects', { includeInactive: null, maxResults: null });
  assert.ok(!listed.isError, textOf(listed));
  assert.deepEqual(lastRequest('list_gameobjects').params, { includeInactive: true, maxResults: 100 });

  await assertRefusedBeforeTheGame('set_game_speed', { speed: null }, /Speed value is required/);
  await assertRefusedBeforeTheGame('teleport_player', { x: null, y: 2 }, /X and Y coordinates are required/);
});

test('a reply whose success is false comes back as an error, its body unchanged', async (t) => {
  const refusal = { success: false, error: 'Player number must be 0-3, or -1 for all players', reason: 'bad-player' };
  answers.set('teleport_player', refusal);
  t.after(() => answers.delete('teleport_player'));

  const failed = await call('teleport_player', { x: 1, y: 2, playerNum: 7 });
  assert.equal(failed.isError, true);
  assert.deepEqual(JSON.parse(textOf(failed)), refusal);

  const answered = await call('list_campaigns', {});
  assert.equal(answered.isError, undefined);
  assert.equal(JSON.parse(textOf(answered)).success, true);
});

test('a call with no arguments member is the same call as one with {}', { timeout: 30000 }, async () => {
  const skipped = new Set(['wait_for_game', 'launch_game', 'stop_game']);
  for (const name of toolArguments().keys()) {
    if (skipped.has(name)) continue;

    const sent = (from) => requests.slice(from)
      .filter((r) => !(r.method === 'execute_code' && /VersionNumber/.test(r.params?.code ?? '')))
      .map((r) => [r.method, r.params]);
    const before = requests.length;
    const bare = await handleToolCall({ params: { name } });
    const bareSent = sent(before);

    const middle = requests.length;
    const empty = await call(name, {});
    const emptySent = sent(middle);

    assert.equal(Boolean(bare.isError), Boolean(empty.isError), `${name}: ${textOf(bare)} vs ${textOf(empty)}`);
    assert.deepEqual(bareSent, emptySent, `${name} sent different params`);
  }
});

test('a missing required argument is refused before anything reaches the game', async () => {
  const cases = [
    ['execute_script', { compileOnly: true }, /Script path is required/],
    ['execute_script', {}, /Script path is required/],
    ['execute_code', {}, /Code is required/],
    ['execute_code', { code: '' }, /Code is required/],
    ['go_to_level', {}, /Campaign index and level index are required/],
    ['go_to_level', { campaignIndex: 1 }, /Campaign index and level index are required/],
    ['inspect_component', { componentType: 'Transform' }, /GameObject path or instanceId is required/],
    ['inspect_component', { path: '/Player' }, /Component type is required/],
    ['inspect_gameobject', {}, /GameObject path or instanceId is required/],
    ['modify_component', { path: '/Player', component: 'Transform' }, /Path or instanceId, component, and properties are required/],
    ['modify_component', { path: '/Player', properties: { x: 1 } }, /Path or instanceId, component, and properties are required/],
    ['modify_component', { component: 'Transform', properties: { x: 1 } }, /Path or instanceId, component, and properties are required/],
    ['swap_bro', { nextSpawn: true }, /Bro name is required/],
    ['swap_bro', {}, /Bro name is required/],
    ['set_game_speed', {}, /Speed value is required/],
    ['set_player_health', {}, /Health value is required/],
    ['simulate_input', { action: '' }, /Exactly one of action, binding or sequence/],
    ['simulate_input', { binding: '' }, /Exactly one of action, binding or sequence/],
    ['simulate_input', { sequence: [] }, /Exactly one of action, binding or sequence/],
    ['simulate_input', {}, /Exactly one of action, binding or sequence/],
    ['spawn_entity', { x: 1, y: 2 }, /Entity type and coordinates are required/],
    ['spawn_entity', { type: 'Mook', y: 2 }, /Entity type and coordinates are required/],
    ['spawn_entity', { type: 'Mook', x: 1 }, /Entity type and coordinates are required/],
    ['teleport_player', { x: 1 }, /X and Y coordinates are required/],
    ['teleport_player', { y: 1 }, /X and Y coordinates are required/],
    ['unload_script', {}, /Script name is required/],
    ['run_test_script', {}, /Script name or path is required/],
  ];
  for (const [name, args, pattern] of cases) await assertRefusedBeforeTheGame(name, args, pattern);
});

test('a script name or path that is not a string is refused in plain words, before anything reaches the game', async () => {
  const cases = [
    ['execute_script', { path: 5, compileOnly: true }, 'execute_script: path must be a string, got 5'],
    ['execute_script', { path: { file: 'x.cs' } }, 'execute_script: path must be a string, got an object'],
    ['execute_script', { path: ['x.cs'] }, 'execute_script: path must be a string, got an array'],
    ['run_test_script', { script: 7 }, 'run_test_script: script must be a string, got 7'],
  ];
  for (const [name, args, message] of cases) {
    const text = await assertRefusedBeforeTheGame(name, args, /must be a string/);
    assert.equal(text, `Error: ${message}`, name);
  }
});

test('a zero is an answer, not a missing value', async () => {
  const sent = async (name, args) => {
    const response = await call(name, args);
    assert.ok(!response.isError, `${name}: ${textOf(response)}`);
    return lastRequest(name).params;
  };

  assert.deepEqual(await sent('go_to_level', { campaignIndex: 0, levelIndex: 0 }), { campaignIndex: 0, levelIndex: 0 });
  assert.deepEqual(await sent('set_game_speed', { speed: 0 }), { speed: 0 });
  assert.deepEqual(await sent('set_player_health', { health: 0 }), { health: 0, playerNum: 0 });
  assert.deepEqual(await sent('spawn_entity', { type: 'Mook', x: 0, y: 0 }), { type: 'Mook', x: 0, y: 0 });
  assert.deepEqual(await sent('teleport_player', { x: 0, y: 0 }), { x: 0, y: 0, playerNum: 0 });
  assert.deepEqual(await sent('teleport_player', { x: 1, y: 2, z: 0, playerNum: 2 }), { x: 1, y: 2, z: 0, playerNum: 2 });
});

test('the defaults a tool fills in reach the game', async () => {
  const sent = async (name, args) => {
    const response = await call(name, args);
    assert.ok(!response.isError, `${name}: ${textOf(response)}`);
    return lastRequest(name).params;
  };

  assert.deepEqual(await sent('list_gameobjects', {}), { includeInactive: true, maxResults: 100 });
  assert.deepEqual(
    await sent('list_gameobjects', { includeInactive: false, maxResults: 0 }),
    { includeInactive: false, maxResults: 0 },
    'false and 0 are kept, not replaced by the defaults',
  );
  assert.deepEqual(await sent('query_gameobjects', {}), { includeInactive: true, maxResults: 100 });
  assert.deepEqual(
    await sent('query_gameobjects', { namePattern: 'Mook', componentType: 'Unit', includeInactive: false, maxResults: 5 }),
    { namePattern: 'Mook', componentType: 'Unit', includeInactive: false, maxResults: 5 },
  );
  assert.deepEqual(await sent('inspect_gameobject', { path: '/Player' }), { path: '/Player', detailed: false });
  assert.deepEqual(await sent('inspect_gameobject', { path: '/Player', detailed: true }), { path: '/Player', detailed: true });
  assert.deepEqual(await sent('list_bros', {}), { playerNum: 0 });
  assert.deepEqual(await sent('list_bros', { playerNum: 2 }), { playerNum: 2 });
  assert.ok(!(await call('swap_bro', { broName: 'Rambro', nextSpawn: true })).isError);
  assert.deepEqual(lastRequest('set_bro').params, { broName: 'Rambro', playerNum: 0 });
  assert.deepEqual(await sent('swap_bro', { broName: 'Rambro' }), { broName: 'Rambro', playerNum: 0 }, 'no ignoreUnlocks unless asked');
  assert.deepEqual(await sent('swap_bro', { broName: 'Rambro', playerNum: 1, ignoreUnlocks: false }), { broName: 'Rambro', playerNum: 1, ignoreUnlocks: false });
});

test('execute_code sends the code byte for byte', async () => {
  const code = '// a comment\nvar s = "tab\\t and \\u00e9";\r\n  return s;   ';
  const response = await call('execute_code', { code });
  assert.ok(!response.isError, textOf(response));
  assert.deepEqual(lastRequest('execute_code').params, { code });
});

test('execute_script sends the source and its name, never the path, with compileOnly too', async () => {
  const executed = await call('execute_script', { path: 'watch-field' });
  assert.ok(!executed.isError, textOf(executed));
  const run = lastRequest('execute_script').params;
  assert.equal(run.name, 'watch-field');
  assert.match(run.source, /WatchField/);
  assert.deepEqual(run.args, {}, 'no args is an empty object');
  assert.equal(run.path, undefined);

  await call('execute_script', { path: 'watch-field', args: { target: 'X', count: 3 } });
  assert.deepEqual(lastRequest('execute_script').params.args, { target: 'X', count: 3 });

  const compiled = await call('execute_script', { path: 'watch-field.cs', compileOnly: true });
  assert.ok(!compiled.isError, textOf(compiled));
  const built = lastRequest('compile_script').params;
  assert.deepEqual(Object.keys(built).sort(), ['name', 'source']);
  assert.equal(built.name, 'watch-field');
});

test('a catalog display name runs the script it names', async () => {
  const response = await call('execute_script', { path: 'Spawn Capture' });
  assert.ok(!response.isError, textOf(response));
  const sent = lastRequest('execute_script').params;
  assert.equal(sent.name, 'spawn-capture');

  const compiled = await call('execute_script', { path: 'watch field', compileOnly: true });
  assert.ok(!compiled.isError, textOf(compiled));
  assert.equal(lastRequest('compile_script').params.name, 'watch-field');
});

test('execute_script sends the file it read as the origin, whatever form named it', async (t) => {
  const library = path.join(CSHARP_SCRIPTS_DIR, 'watch-field.cs');
  for (const form of ['watch-field', 'watch-field.cs', 'watch field']) {
    const response = await call('execute_script', { path: form });
    assert.ok(!response.isError, textOf(response));
    assert.equal(lastRequest('execute_script').params.origin, library, form);
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'origin-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const elsewhere = path.join(dir, 'watch-field.cs');
  await fs.writeFile(elsewhere, 'public static class Elsewhere {}\n');

  const response = await call('execute_script', { path: elsewhere });
  assert.ok(!response.isError, textOf(response));
  const sent = lastRequest('execute_script').params;
  assert.equal(sent.name, 'watch-field');
  assert.equal(sent.origin, elsewhere);
});

test('simulate_input forwards every field of the action form', async () => {
  const args = { action: 'fire', duration: 120, count: 3, interval: 150, player: 2 };
  const response = await call('simulate_input', args);
  assert.ok(!response.isError, textOf(response));
  assert.deepEqual(lastRequest('simulate_input').params, args);

  const emptySequence = await call('simulate_input', { action: 'jump', sequence: [] });
  assert.ok(!emptySequence.isError, 'an empty sequence beside an action is the action form');
  assert.equal(lastRequest('simulate_input').params.action, 'jump');
});

test('simulate_input forwards a binding with every field of the action form, and a binding step in a sequence', async () => {
  const args = { binding: 'Furibrosa/Switch Weapon', duration: 80, count: 2, interval: 300, player: 1 };
  const response = await call('simulate_input', args);
  assert.ok(!response.isError, textOf(response));
  assert.deepEqual(lastRequest('simulate_input').params, args);

  const sequence = [{ binding: 'Utility Mod/Pause/Unpause Game', duration: 60, wait: 200 }, { action: 'jump' }];
  const stepped = await call('simulate_input', { sequence });
  assert.ok(!stepped.isError, textOf(stepped));
  assert.deepEqual(lastRequest('simulate_input').params.sequence, sequence);
  assert.equal(lastRequest('simulate_input').params.binding, undefined, 'no binding is invented for a sequence call');
});

test('trace_spawns forwards a stop', async () => {
  const response = await call('trace_spawns', { action: 'stop' });
  assert.ok(!response.isError, textOf(response));
  assert.deepEqual(lastRequest('trace_spawns').params, { action: 'stop' });
});

test('take_screenshot reads a null highlight as none', async () => {
  const response = await call('take_screenshot', { highlight: null });
  assert.ok(!response.isError, textOf(response));
  assert.deepEqual(lastRequest('take_screenshot').params, {});
});

test('take_screenshot translates the game-side path the way the platform needs', async (t) => {
  t.after(() => {
    answers.delete('take_screenshot');
    resetPlatformDetection();
  });
  const shot = async (gamePath, platform, protonPrefix = null) => {
    answers.set('take_screenshot', { path: gamePath });
    unityClient.platform = platform;
    unityClient.protonPrefix = protonPrefix;
    const response = await call('take_screenshot', {});
    assert.ok(!response.isError, textOf(response));
    return JSON.parse(textOf(response)).path;
  };

  assert.equal(await shot('C:/Users/me/shot.png', 'wsl'), '/mnt/c/Users/me/shot.png');
  assert.equal(await shot('Z:/tmp/shot.png', 'linux', '/pfx'), '/tmp/shot.png');
  assert.equal(await shot('Z:/home/me/shot.png', 'linux'), '/home/me/shot.png', 'Z: is / in every prefix, found or not');
  assert.equal(await shot('C:/users/steamuser/shot.png', 'linux', '/pfx'), '/pfx/dosdevices/c:/users/steamuser/shot.png');
  assert.equal(await shot('/home/me/shot.png', 'linux', '/pfx'), '/home/me/shot.png');
  assert.equal(await shot('C:/shot.png', 'linux'), 'C:/shot.png', 'a native Linux game has no drive letters to map');
});

test('WSL drives sit under the automount root /etc/wsl.conf names, /mnt/ without one', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wsl-conf-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const conf = path.join(dir, 'wsl.conf');

  assert.equal(wslMountRoot(path.join(dir, 'missing.conf')), '/mnt/');
  await fs.writeFile(conf, '[boot]\nroot = /nope\n[automount]\nenabled = true\nroot = /win # drives\n');
  assert.equal(wslMountRoot(conf), '/win/');
  await fs.writeFile(conf, '[automount]\noptions = "metadata"\n');
  assert.equal(wslMountRoot(conf), '/mnt/');
});

test('an instanceId addresses the object in place of a path, a zero included', async () => {
  const sent = async (name, args) => {
    const response = await call(name, args);
    assert.ok(!response.isError, `${name}: ${textOf(response)}`);
    return lastRequest(name).params;
  };

  assert.deepEqual(await sent('inspect_gameobject', { instanceId: -1234 }), { instanceId: -1234, detailed: false });
  assert.deepEqual(await sent('inspect_component', { instanceId: 0, componentType: 'Transform' }), { instanceId: 0, componentType: 'Transform' });
  assert.deepEqual(
    await sent('modify_component', { instanceId: 42, component: 'Transform', properties: { tag: 'x' } }),
    { instanceId: 42, component: 'Transform', properties: { tag: 'x' } },
  );
  assert.deepEqual(await sent('take_screenshot', { highlight: { instanceId: 42 } }), { highlight: { instanceId: 42 } });
});

test('ping and game_state pass on whether the main thread answered', async (t) => {
  t.after(() => {
    answers.delete('ping');
    answers.delete('game_state');
  });
  answers.set('ping', { message: 'pong', mainThreadAnswered: false, frame: null });
  answers.set('game_state', { mainThreadAnswered: false, error: 'The game\'s main thread did not answer' });

  const ping = JSON.parse(textOf(await call('ping', {})));
  assert.equal(ping.mainThreadAnswered, false);

  const state = JSON.parse(textOf(await call('game_state', {})));
  assert.equal(state.mainThreadAnswered, false);
  assert.match(state.error, /main thread did not answer/);
  assert.equal(state.target, 'steam', 'the server\'s own fields still come with it');
});

test('a main-thread stall comes back as an error with its body, on every tool but game_state', async (t) => {
  const stall = { success: false, error: 'Main thread action timed out after 5000ms', mainThreadAnswered: false };
  t.after(() => answers.delete('list_gameobjects'));
  answers.set('list_gameobjects', stall);
  const response = await call('list_gameobjects', {});
  assert.equal(response.isError, true);
  assert.deepEqual(JSON.parse(textOf(response)), stall);
});

test('go_to_level sends nothing of its own after the load', { timeout: 15000 }, async () => {
  const response = await call('go_to_level', { campaignIndex: 1, levelIndex: 0 });
  assert.ok(!response.isError, textOf(response));
  const sentBefore = requests.length;

  await new Promise((resolve) => setTimeout(resolve, 3500));
  assert.equal(requests.length, sentBefore, 'a ping nobody waits on was sent after the load');
});

test('execute_script refuses args that are not an object and sends nothing', async () => {
  for (const args of ['typeName=Mook', ['Mook'], 5]) {
    const before = requests.length;
    const response = await call('execute_script', { path: 'watch-field', args });
    assert.ok(response.isError, `${JSON.stringify(args)}: ${textOf(response)}`);
    assert.match(textOf(response), /execute_script: args must be an object, got/);
    assert.equal(requests.length, before, `${JSON.stringify(args)} reached the game`);
  }
});

test('execute_script names a missing absolute path, and says how it took it, instead of the raw ENOENT text', async () => {
  const missing = path.join(os.tmpdir(), 'no-such-dir-for-unity-inspector', 'probe.cs');
  const response = await call('execute_script', { path: missing });
  assert.ok(response.isError);
  const text = textOf(response);
  assert.match(text, /taken as an absolute path: no file exists there/);
  assert.ok(text.includes(missing), text);
  assert.doesNotMatch(text, /ENOENT: no such file/);
});

test('unload_script sends the name the script was loaded under, from its catalog or file name', async () => {
  for (const given of ['Watch Field', 'watch-field.cs', 'watch-field']) {
    await call('unload_script', { name: given });
    assert.equal(lastRequest('unload_script').params.name, 'watch-field', given);
  }
  await call('unload_script', { name: 'lifecycle-inline' });
  assert.equal(lastRequest('unload_script').params.name, 'lifecycle-inline', 'a name no file has goes as given');
});

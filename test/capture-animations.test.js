import { NO_LISTENER_PORT } from '../test-support/session.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CAPTURE_STATES_DIR,
  DEFAULT_SETTLE_MS,
  DEFAULT_STATES_PATH,
  SCRIPT_PATH,
  DEFAULT_SWAP_SETTLE_MS,
  DEFAULT_SWAP_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  SCRIPT_NAME,
  STATES_COPY_NAME,
  UsageError,
  buildReport,
  captureLogTail,
  cellSequence,
  describeCells,
  describeExpectation,
  describeFailure,
  describeSlot,
  expectedSequence,
  formatLogTail,
  joinGamePath,
  knownMismatchHolds,
  levelIsReady,
  loadStates,
  mergeStates,
  parseLevel,
  partitionLethal,
  runCapture,
  sameSequence,
  slotOf,
  snapshotSlot,
  swapLanded,
  validateStates,
  waitForLevel,
  waitForSentinel,
  waitForSwap,
} from '../lib/animation-capture.js';
import { UnityInspectorClient } from '../lib/unity-client.js';
import { CSHARP_SCRIPTS_DIR, SCRIPTS_DIR, listCSharpScripts } from '../lib/script-library.js';
import { startStubServer, reply } from '../test-support/stub-server.js';

// session.js leaves UNITY_INSPECTOR_PORT on a port with no listener: a live game would leave the
// module-level client's socket open and hang the run. Every handleToolCall test points it at its own
// stub before the call, since the module client re-reads the variable on every pointClientAtTarget().

const { buildToolList, handleToolCall, shutdownServer } = await import('../index.js');

function textOf(response) {
  return response.content.map((c) => c.text).join('\n');
}

// The server's own client picks the port up again on the next call, so a test hands its stub over by
// setting the variable the steam target reads
function pointServerAt(port) {
  process.env.UNITY_INSPECTOR_PORT = String(port);
}

async function callCapture(args) {
  return handleToolCall({ params: { name: 'capture_animations', arguments: args } });
}

// The stub server callback is synchronous, so the sentinel has to land before the reply goes out
function writeNow(file, contents) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'capture-harness-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('parseLevel keeps the numbers as numbers, the way go_to_level wants them', () => {
  assert.deepEqual(parseLevel(' 2:7 '), { campaignIndex: 2, levelIndex: 7 });
});

// The mod compacts the list: it skips empty slots, so no level loaded means no entries, and a slot
// held open for a player with no character yet comes back isAlive false
// (Unity Inspector Mod/MessageHandler.cs game_state).
const noLevel = { scene: 'Intro', players: [] };
const spawning = { scene: 'Level', players: [{ playerIndex: 0, broName: null, isAlive: false }] };
const spawned = { scene: 'Level', players: [{ playerIndex: 0, broName: 'Rambro(Clone)', isAlive: true }] };

// The GameObject names game_state really reports. None of them is the name --bro takes: Swap Bros
// Mod's table calls the first one "Rambro".
const RAMBRO_OBJECT = 'Rambo(Clone) [local]';
const DRUNKEN_OBJECT = 'BM_Drunken Broster(Clone) [local]';
const AMERIBRO_OBJECT = 'BM_Captain Ameribro(Clone) [local]';

const slotState = (broName, { player = 0, isAlive = true, className = 'TestVanDammeAnim' } = {}) => ({
  scene: 'Level',
  players: broName === null ? [] : [{ playerIndex: player, broName, className, isAlive }],
});

// The swap is confirmed by the slot's name changing, so a stub has to answer differently either side
// of swap_bro. Returns a game_state responder and the flag swap_bro flips.
function swappingSlot(before, after, player = 0) {
  const state = { swapped: false };
  return {
    onRequest: (method) => { if (method === 'swap_bro') state.swapped = true; },
    reply: () => slotState(state.swapped ? after : before, { player }),
  };
}

test('levelIsReady wants a live character in the slot the sweep will capture', () => {
  assert.equal(levelIsReady(noLevel, 0), false, 'no level loaded means no entries at all');
  assert.equal(levelIsReady(spawning, 0), false, 'an entry with no character is not something to swap onto');
  assert.equal(levelIsReady(spawned, 0), true);

  const secondOnly = {
    scene: 'Level',
    players: [{ playerIndex: 1, broName: 'Rambro(Clone)', isAlive: true }],
  };
  assert.equal(levelIsReady(secondOnly, 1), true, 'the list is compacted, so position is not the index');
  assert.equal(levelIsReady(secondOnly, 0), false, 'and player 0 is simply not in it');

  const dead = { scene: 'Level', players: [{ playerIndex: 0, broName: 'Rambro(Clone)', isAlive: false }] };
  assert.equal(levelIsReady(dead, 0), false, 'a dead bro is no use to swap_bro');

  assert.equal(levelIsReady({ scene: 'Level' }, 0), false, 'a payload with no players array is not readiness');
  assert.equal(levelIsReady(null, 0), false);
});

// The names game_state really reports, none of which is the name --bro takes
const beforeSwap = { playerIndex: 0, broName: 'Rambo(Clone) [local]', className: 'Rambro', isAlive: true };
const afterSwap = { playerIndex: 0, broName: 'BM_Drunken Broster(Clone) [local]', className: 'DrunkenBroster', isAlive: true };

test('slotOf picks the entry out of the compacted list by its index', () => {
  const state = { scene: 'Level', players: [{ ...afterSwap, playerIndex: 2 }] };

  assert.deepEqual(slotOf(state, 2), { ...afterSwap, playerIndex: 2 }, 'position is not the index');
  assert.equal(slotOf(state, 0), null, 'no entry for the slot');
  assert.equal(slotOf({ scene: 'Level', players: [] }, 0), null, 'no level loaded');
  assert.equal(slotOf({ scene: 'Level' }, 0), null, 'no players array at all');
  assert.equal(slotOf(null, 0), null);
});

test('swapLanded watches for the name to change, not for the name that was asked for', () => {
  const before = { scene: 'Level', players: [beforeSwap] };
  const after = { scene: 'Level', players: [afterSwap] };

  assert.equal(swapLanded(after, 0, beforeSwap), true, 'a different character is in the slot');
  assert.equal(swapLanded(before, 0, beforeSwap), false, 'the old one is still there');
  assert.equal(swapLanded(after, 0, null), true, 'nothing was there before, so anything alive is the swap');
  assert.equal(swapLanded({ scene: 'Level', players: [] }, 0, null), false, 'still nothing there');
  assert.equal(
    swapLanded({ scene: 'Level', players: [{ ...afterSwap, isAlive: false }] }, 0, beforeSwap),
    false,
    'a character that is not alive yet is not the swap landing',
  );
  assert.equal(swapLanded(after, 1, beforeSwap), false, 'the wrong slot');
});

test('describeSlot names the character and the class behind it', () => {
  assert.equal(describeSlot(beforeSwap), 'Rambo(Clone) [local] (Rambro), isAlive=true');
  assert.equal(describeSlot(null), 'no player');
});

test('snapshotSlot reads the slot once, and shrugs off a game_state that fails', async () => {
  const asked = [];
  const ok = { sendCommand: async (method, params) => { asked.push({ method, params }); return { scene: 'Level', players: [beforeSwap] }; } };
  assert.deepEqual(await snapshotSlot({ client: ok, player: 0 }), beforeSwap);
  assert.deepEqual(asked, [{ method: 'game_state', params: {} }], 'once, not a poll');

  const broken = { sendCommand: async () => { throw new Error('Game is not running.'); } };
  assert.equal(await snapshotSlot({ client: broken, player: 0 }), null, 'treated as an empty slot');
});

test('waitForSwap polls until the character changes', async () => {
  const states = [
    { scene: 'Level', players: [beforeSwap] },
    { scene: 'Level', players: [{ ...afterSwap, isAlive: false }] },
    { scene: 'Level', players: [afterSwap] },
  ];
  const asked = [];
  const client = {
    sendCommand: async (method, params) => {
      asked.push({ method, params });
      return states[Math.min(asked.length - 1, states.length - 1)];
    },
  };

  const result = await waitForSwap({ client, player: 0, before: beforeSwap, timeoutMs: 5000, sleep: async () => {} });

  assert.equal(result.landed, true);
  assert.equal(result.slot.broName, 'BM_Drunken Broster(Clone) [local]');
  assert.equal(asked.length, 3, 'the old bro lingering is not the swap landing');
});

test('waitForSwap reports an unchanged slot rather than throwing', async () => {
  const client = { sendCommand: async () => ({ scene: 'Level', players: [beforeSwap] }) };
  let clock = 0;

  const result = await waitForSwap({
    client,
    player: 0,
    before: beforeSwap,
    timeoutMs: 15000,
    sleep: async () => { clock += 5000; },
    now: () => clock,
  });

  // The caller decides what an unconfirmed swap means, so this only reports what it last saw
  assert.equal(result.landed, false);
  assert.equal(result.seconds, 15);
  assert.equal(result.slot.broName, 'Rambo(Clone) [local]');
  assert.deepEqual(result.state, { scene: 'Level', players: [beforeSwap] }, 'and the state it saw it in');
});

test('waitForSwap hands back the error that ended the polling', async () => {
  const client = { sendCommand: async () => { throw new Error('socket closed'); } };
  let clock = 0;

  const result = await waitForSwap({
    client,
    player: 0,
    before: beforeSwap,
    timeoutMs: 15000,
    sleep: async () => { clock += 5000; },
    now: () => clock,
  });

  assert.equal(result.landed, false);
  assert.equal(result.slot, null, 'a game that stopped answering has no slot to describe');
  assert.deepEqual(result.state, { error: 'socket closed' });
});

test('waitForLevel polls game_state until the player is alive', async () => {
  const states = [noLevel, spawning, spawned];
  const asked = [];
  const client = {
    sendCommand: async (method, params) => {
      asked.push({ method, params });
      return states[Math.min(asked.length - 1, states.length - 1)];
    },
  };

  const ready = await waitForLevel({ client, player: 0, timeoutMs: 5000, sleep: async () => {} });

  assert.equal(ready.scene, 'Level');
  assert.equal(asked.length, 3, 'it stops at the first ready state');
  assert.deepEqual(asked[0], { method: 'game_state', params: {} });
});

test('waitForLevel gives up with the last state it saw', async () => {
  const client = { sendCommand: async () => noLevel };
  let clock = 0;

  await assert.rejects(
    () => waitForLevel({ client, player: 0, timeoutMs: 30000, sleep: async () => { clock += 10000; }, now: () => clock }),
    (err) => /never reported a player in slot 0 after 30s/.test(err.message)
      && /scene=Intro players=0 live=0 playerIndex=\[\]/.test(err.message),
  );
});

test('waitForLevel names the indexes it did see when the wanted one never turns up', async () => {
  const client = {
    sendCommand: async () => ({
      scene: 'Level',
      players: [
        { playerIndex: 0, broName: 'Rambro(Clone)', isAlive: true },
        { playerIndex: 2, broName: null, isAlive: false },
      ],
    }),
  };
  let clock = 0;

  await assert.rejects(
    () => waitForLevel({ client, player: 1, timeoutMs: 1000, sleep: async () => { clock += 1000; }, now: () => clock }),
    (err) => /never reported a player in slot 1/.test(err.message)
      && /scene=Level players=2 live=1 playerIndex=\[0,2\]/.test(err.message),
  );
});

test('waitForLevel says so when the payload has no players at all', async () => {
  const client = { sendCommand: async () => ({ scene: 'Level', mode: 'campaign' }) };
  let clock = 0;

  await assert.rejects(
    () => waitForLevel({ client, timeoutMs: 1000, sleep: async () => { clock += 1000; }, now: () => clock }),
    (err) => /no players array in \{"scene":"Level","mode":"campaign"\}/.test(err.message),
  );
});

test('waitForLevel keeps polling through a failed game_state', async () => {
  let calls = 0;
  const client = {
    sendCommand: async () => {
      calls++;
      if (calls === 1) throw new Error('Game is not running.');
      return spawned;
    },
  };

  const ready = await waitForLevel({ client, timeoutMs: 5000, sleep: async () => {} });
  assert.equal(ready.scene, 'Level');
  assert.equal(calls, 2);
});

test('joinGamePath keeps the separator style of the game-side path', () => {
  assert.equal(joinGamePath('/tmp/shots', 'states.json'), '/tmp/shots/states.json');
  assert.equal(joinGamePath('/tmp/shots/', 'states.json'), '/tmp/shots/states.json');
  assert.equal(joinGamePath('Z:\\tmp\\shots', 'states.json'), 'Z:\\tmp\\shots\\states.json');
  assert.equal(joinGamePath('C:/shots', 'states.json'), 'C:/shots\\states.json');
});

test('the bundled base state list validates', async () => {
  const doc = JSON.parse(await fs.readFile(DEFAULT_STATES_PATH, 'utf-8'));
  const { states, errors } = validateStates(doc);

  assert.deepEqual(errors, []);
  assert.ok(states.length > 40, `expected a broad state list, got ${states.length}`);
  assert.ok(states.some((state) => state.unsupported), 'unsupported states are reported, not omitted');
});

test('every bundled state steps exactly as many frames as its expected column span', async () => {
  const doc = JSON.parse(await fs.readFile(DEFAULT_STATES_PATH, 'utf-8'));
  const { states } = validateStates(doc);

  for (const state of states) {
    if (state.unsupported) continue;
    const [from, to] = state.expect.cols;
    assert.equal(
      state.step.values.length,
      to - from + 1,
      `${state.name}: ${state.step.values.length} steps for columns ${from}-${to}`,
    );
    assert.ok(state.note && state.note.includes(':'), `${state.name}: the note must cite source lines`);
  }
});

test('validateStates rejects malformed entries', () => {
  const { errors } = validateStates([
    { step: { values: [0] } },
    { name: 'no-step' },
    { name: 'empty-values', step: { values: [] } },
    { name: 'blank-reason', unsupported: '   ' },
    { name: 'ok', step: { values: [0, 1] } },
    { name: 'ok', step: { values: [0] } },
  ]);

  assert.equal(errors.length, 5);
  assert.match(errors[0], /missing a name/);
  assert.match(errors[1], /needs a step block/);
  assert.match(errors[2], /at least one value/);
  assert.match(errors[3], /non-empty reason/);
  assert.match(errors[4], /duplicate name/);
});

test('validateStates checks the shape of before and after', () => {
  const { errors } = validateStates([
    { name: 'ok', before: ['SwitchToHeldItem'], after: ['ClearHeldItem'], step: { values: [0] } },
    { name: 'no_lists', before: 'SwitchToHeldItem', step: { values: [0] } },
    { name: 'empty_list', after: [], step: { values: [0] } },
    { name: 'blank_name', before: ['  '], step: { values: [0] } },
    { name: 'not_a_name', after: [7], step: { values: [0] } },
  ]);

  assert.equal(errors.length, 8, 'each malformed entry is also unpaired');
  assert.match(errors[0], /^no_lists: before must be a non-empty list of method names/);
  assert.match(errors[2], /^empty_list: after must be a non-empty list of method names/);
  assert.match(errors[4], /^blank_name: before must hold method names/);
  assert.match(errors[6], /^not_a_name: after must hold method names/);
});

test('validateStates insists on before and after together', () => {
  const { errors } = validateStates([
    { name: 'switch_only', before: ['SwitchToHeldItem'], step: { values: [0] } },
    { name: 'clear_only', after: ['ClearHeldItem'], step: { values: [0] } },
    { name: 'paired', before: ['SwitchToHeldItem'], after: ['ClearHeldItem'], step: { values: [0] } },
    { name: 'neither', step: { values: [0] } },
  ]);

  assert.deepEqual(errors, [
    'switch_only: before and after must be given together',
    'clear_only: before and after must be given together',
  ]);
});

test('validateStates checks the shape of insert_before', () => {
  const { errors } = validateStates([
    { name: 'ok', insert_before: 'special_new', step: { values: [0] } },
    { name: 'blank', insert_before: '  ', step: { values: [0] } },
    { name: 'not_a_name', insert_before: 3, step: { values: [0] } },
  ]);

  assert.deepEqual(errors, ['blank: insert_before must name a state', 'not_a_name: insert_before must name a state']);
});

test('mergeStates places an insert_before entry ahead of its anchor', () => {
  const merged = mergeStates([
    [{ name: 'idle' }, { name: 'special_new' }, { name: 'dancing' }],
    [{ name: 'running_holding_item', insert_before: 'special_new' }, { name: 'trailing' }],
  ]);

  assert.deepEqual(merged.map((state) => state.name), [
    'idle',
    'running_holding_item',
    'special_new',
    'dancing',
    'trailing',
  ]);
});

test('mergeStates refuses an insert_before that names no state', () => {
  assert.throws(
    () => mergeStates([[{ name: 'idle' }], [{ name: 'held', insert_before: 'nowhere' }]]),
    (err) => err instanceof UsageError && /insert_before names "nowhere"/.test(err.message),
  );
});

test('mergeStates keeps a restated entry in place and ignores its anchor', () => {
  const merged = mergeStates([
    [{ name: 'idle' }, { name: 'special_new', step: { values: [0] } }, { name: 'dancing' }],
    [{ name: 'special_new', insert_before: 'idle', step: { values: [1] } }],
  ]);

  assert.deepEqual(merged.map((state) => state.name), ['idle', 'special_new', 'dancing']);
  assert.deepEqual(merged[1].step.values, [1], 'the later layer still won');
});

test('validateStates leaves before and after to the game when the entry is unsupported', () => {
  const { errors } = validateStates([
    { name: 'zipline', unsupported: 'needs a live ZipLine reference', before: 'nonsense' },
  ]);

  assert.deepEqual(errors, []);
});

test('validateStates rejects a document that is not a state list', () => {
  const { errors } = validateStates({ animations: [] });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /neither an array nor an object/);
});

test('waitForSentinel resolves on done', async (t) => {
  const dir = await tempDir(t);
  await fs.writeFile(path.join(dir, 'done'), '');

  assert.deepEqual(await waitForSentinel({ dir, timeoutMs: 1000 }), { status: 'done' });
});

test('waitForSentinel reports the error file and prefers it over done', async (t) => {
  const dir = await tempDir(t);
  await fs.writeFile(path.join(dir, 'done'), '');
  await fs.writeFile(path.join(dir, 'error'), 'state \'running\': unknown field \'nope\'\n');

  const result = await waitForSentinel({ dir, timeoutMs: 1000 });
  assert.equal(result.status, 'error');
  assert.equal(result.message, "state 'running': unknown field 'nope'");
});

test('waitForSentinel times out when neither sentinel appears', async (t) => {
  const dir = await tempDir(t);
  let slept = 0;

  const result = await waitForSentinel({
    dir,
    timeoutMs: 30,
    pollMs: 10,
    sleep: async () => { slept++; },
    now: () => slept * 10,
  });

  assert.equal(result.status, 'timeout');
  assert.match(result.message, /no done or error/);
  assert.equal(slept, 3, 'polls until the deadline rather than spinning');
});

test('describeCells compresses runs and skips a deactivated gun', () => {
  const frames = [
    { body: { row: 2, col: 0 }, gun: { row: 2, col: 0, enabled: true } },
    { body: { row: 2, col: 1 }, gun: { row: 2, col: 1, enabled: true } },
    { body: { row: 2, col: 2 }, gun: { row: 2, col: 9, enabled: false } },
    { body: { row: 4, col: 7 }, gun: null },
  ];

  assert.equal(describeCells(frames, 'body', 'main'), 'main row 2 cols 0-2; main row 4 cols 7');
  assert.equal(describeCells(frames, 'gun', 'gun'), 'gun row 2 cols 0-1');
  assert.equal(describeCells([], 'body', 'main'), '');
});

test('describeExpectation renders single columns and spans', () => {
  assert.equal(describeExpectation({ sheet: 'main', row: 1, cols: [0, 0] }), 'main row 1 cols 0');
  assert.equal(describeExpectation({ sheet: 'main', row: 2, cols: [0, 7] }), 'main row 2 cols 0-7');
  assert.equal(describeExpectation(null), '');
});

const fixtureStates = [
  { name: 'running', step: { field: 'frame', values: [0, 1] }, expect: { sheet: 'main', row: 2, cols: [0, 1] } },
  { name: 'idle', step: { field: 'frame', values: [0] }, expect: { sheet: 'main', row: 1, cols: [0, 0] } },
  { name: 'zipline', unsupported: 'needs a live ZipLine reference' },
  { name: 'never_run', step: { field: 'frame', values: [0] }, expect: { sheet: 'main', row: 9, cols: [0, 0] } },
];

const fixtureCapture = {
  bro: { type: 'Rambro', heroType: 'Rambro', customName: null, gameObject: 'Rambro' },
  states: [
    {
      name: 'running',
      skipped: null,
      frames: [
        { step: 0, body: { row: 2, col: 0 }, gun: { row: 2, col: 0, enabled: true }, scaleX: 1, offset: [0, 0] },
        { step: 1, body: { row: 2, col: 1 }, gun: { row: 2, col: 1, enabled: true }, scaleX: 1, offset: [0, 0] },
      ],
    },
    {
      name: 'idle',
      skipped: null,
      frames: [{ step: 0, offscreen: true, body: { row: 1, col: 4 }, gun: null, scaleX: 1, offset: [0, 0] }],
    },
    { name: 'zipline', skipped: 'unsupported: needs a live ZipLine reference', frames: [] },
  ],
};

test('buildReport summarises captured, mismatched, skipped and unreached states', () => {
  const { text: report } = buildReport({
    capture: fixtureCapture,
    states: fixtureStates,
    outDir: '/tmp/shots',
    options: { bro: 'Rambro' },
  });

  assert.match(report, /# Animation capture — Rambro \/ Rambro/);
  assert.match(report, /2 captured, 1 skipped/);
  assert.match(report, /mismatches against the state list: 1/);
  assert.match(report, /\| running \| 2 \| main row 2 cols 0-1 \| gun row 2 cols 0-1 \| main row 2 cols 0-1 ✓ \|/);
  assert.match(report, /idle \(offscreen frames\) \| 1 \| main row 1 cols 4 \| — \| main row 1 cols 0 ✗ \|/);
  assert.match(report, /\/tmp\/shots\/running\.png/);
  assert.match(report, /- \*\*zipline\*\* — unsupported: needs a live ZipLine reference/);
  assert.match(report, /## Never reached \(1\)[\s\S]*- never_run/);
});

test('buildReport survives a missing capture.json', () => {
  const { text: report } = buildReport({ capture: null, states: fixtureStates, outDir: '/tmp/shots', options: {} });

  assert.match(report, /0 captured, 0 skipped/);
  assert.match(report, /## Never reached \(4\)/);
});

test('runCapture drives the documented command sequence against a stub game', { timeout: 20000 }, async (t) => {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'input-states.json');
  const outDir = path.join(dir, 'out');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));

  const seen = [];
  const slot = swappingSlot(AMERIBRO_OBJECT, RAMBRO_OBJECT, 1);
  const stub = await startStubServer((request, socket) => {
    seen.push({ method: request.method, params: request.params });
    slot.onRequest(request.method);

    if (request.method === 'game_state') {
      reply(socket, request.id, slot.reply());
      return;
    }
    if (request.method === 'execute_script') {
      // Stand in for the in-game sweep: the script writes its record and then the sentinel
      writeNow(path.join(outDir, 'capture.json'), JSON.stringify(fixtureCapture));
      writeNow(path.join(outDir, 'done'), '');
    }
    reply(socket, request.id, { success: true });
  });

  const client = new UnityInspectorClient({ host: '127.0.0.1', port: stub.port });
  t.after(async () => { client.disconnect(); await stub.close(); });

  const options = {
    bro: 'Rambro',
    statesPaths: [statesPath],
    out: outDir,
    gameOut: 'Z:\\out',
    timeoutMs: 5000,
    player: 1,
    port: stub.port,
  };

  const result = await runCapture(options, client, { pollMs: 5 });

  assert.deepEqual(result.outcome, { status: 'done' });
  assert.deepEqual(seen.map((entry) => entry.method), [
    'ping', 'game_state', 'swap_bro', 'game_state', 'execute_script', 'unload_script', 'set_game_speed',
  ]);
  assert.deepEqual(seen[1].params, {}, 'the slot is read before the swap, to compare against');
  assert.deepEqual(seen[2].params, { broName: 'Rambro', playerNum: 1 });
  assert.deepEqual(seen[5].params, { name: SCRIPT_NAME });
  assert.deepEqual(seen[6].params, { speed: 1 }, 'the driver never sends speed 0; the script freezes itself');

  const scriptArgs = seen[4].params.args;
  assert.equal(scriptArgs.outDir, 'Z:\\out');
  assert.equal(scriptArgs.statesFile, 'Z:\\out\\states.json', 'the state file is passed as the game sees it');
  assert.equal(scriptArgs.player, '1');
  assert.equal(seen[4].params.name, SCRIPT_NAME);
  assert.match(seen[4].params.source, /class AnimationCapture : MonoBehaviour/, 'the script source is sent, not a path');

  const copied = JSON.parse(await fs.readFile(path.join(outDir, STATES_COPY_NAME), 'utf-8'));
  assert.equal(copied.states.length, fixtureStates.length);

  const written = await fs.readFile(path.join(outDir, 'report.md'), 'utf-8');
  assert.equal(written, `${result.report}\n`);
});

test('runCapture loads the level and waits for its player before swapping the bro', { timeout: 20000 }, async (t) => {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'input-states.json');
  const outDir = path.join(dir, 'out');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));

  const seen = [];
  let polls = 0;
  let swapped = false;
  const stub = await startStubServer((request, socket) => {
    seen.push({ method: request.method, params: request.params });
    if (request.method === 'swap_bro') swapped = true;

    if (request.method === 'game_state') {
      polls++;
      if (swapped) {
        reply(socket, request.id, slotState(RAMBRO_OBJECT));
        return;
      }
      reply(socket, request.id, polls > 1 ? slotState(AMERIBRO_OBJECT) : slotState(null));
      return;
    }
    if (request.method === 'execute_script') {
      writeNow(path.join(outDir, 'capture.json'), JSON.stringify(fixtureCapture));
      writeNow(path.join(outDir, 'done'), '');
    }
    reply(socket, request.id, { success: true });
  });

  const client = new UnityInspectorClient({ host: '127.0.0.1', port: stub.port });
  t.after(async () => { client.disconnect(); await stub.close(); });

  const options = {
    bro: 'Rambro',
    level: { campaignIndex: 1, levelIndex: 0 },
    statesPaths: [statesPath],
    out: outDir,
    gameOut: outDir,
    timeoutMs: 5000,
    player: 0,
    port: stub.port,
  };

  const result = await runCapture(options, client, { pollMs: 5 });

  assert.deepEqual(result.outcome, { status: 'done' });
  assert.deepEqual(seen.map((entry) => entry.method), [
    'ping', 'go_to_level', 'game_state', 'game_state', 'game_state', 'swap_bro', 'game_state',
    'execute_script', 'unload_script', 'set_game_speed',
  ]);
  assert.deepEqual(seen[1].params, { campaignIndex: 1, levelIndex: 0 }, 'the same params the MCP tool sends');
});

test('runCapture settles between the level being ready and the bro swap', { timeout: 20000 }, async (t) => {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'input-states.json');
  const outDir = path.join(dir, 'out');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));

  const seen = [];
  const slot = swappingSlot(AMERIBRO_OBJECT, DRUNKEN_OBJECT);
  const stub = await startStubServer((request, socket) => {
    seen.push(request.method);
    slot.onRequest(request.method);

    if (request.method === 'game_state') {
      reply(socket, request.id, slot.reply());
      return;
    }
    if (request.method === 'execute_script') {
      writeNow(path.join(outDir, 'capture.json'), JSON.stringify(fixtureCapture));
      writeNow(path.join(outDir, 'done'), '');
    }
    reply(socket, request.id, { success: true });
  });

  const client = new UnityInspectorClient({ host: '127.0.0.1', port: stub.port });
  t.after(async () => { client.disconnect(); await stub.close(); });

  // Snapshot the requests sent so far with every sleep, so the settle can be placed in the sequence
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push({ ms, sent: [...seen] }); };

  await runCapture({
      bro: 'Drunken Broster',
      level: { campaignIndex: 1, levelIndex: 0 },
      settleMs: 3000,
      swapSettleMs: 0,
      swapTimeoutMs: 5000,
      statesPaths: [statesPath],
      out: outDir,
      gameOut: outDir,
      timeoutMs: 5000,
      player: 0,
    }, client, { pollMs: 5, sleep });

  const settles = sleeps.filter((call) => call.ms === 3000);
  assert.equal(settles.length, 1, 'settled once, not once per poll');
  assert.equal(settles[0].sent[settles[0].sent.length - 1], 'game_state', 'after the level reported its player');
  assert.ok(!settles[0].sent.includes('swap_bro'), 'and before the swap');
  assert.ok(!settles[0].sent.includes('execute_script'), 'and before the sweep');
  assert.deepEqual(seen, [
    'ping', 'go_to_level', 'game_state', 'game_state', 'swap_bro', 'game_state',
    'execute_script', 'unload_script', 'set_game_speed',
  ]);
});

test('runCapture waits for the slot to report a different character before it sweeps', { timeout: 20000 }, async (t) => {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'input-states.json');
  const outDir = path.join(dir, 'out');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));

  const seen = [];
  let polls = 0;
  let swapped = false;
  const stub = await startStubServer((request, socket) => {
    seen.push(request.method);
    if (request.method === 'swap_bro') swapped = true;

    if (request.method === 'game_state') {
      polls++;
      // The old bro keeps reporting alive for a beat after swap_bro answers
      reply(socket, request.id, swapped && polls > 2
        ? slotState(DRUNKEN_OBJECT)
        : slotState(AMERIBRO_OBJECT));
      return;
    }
    if (request.method === 'execute_script') {
      writeNow(path.join(outDir, 'capture.json'), JSON.stringify(fixtureCapture));
      writeNow(path.join(outDir, 'done'), '');
    }
    reply(socket, request.id, { success: true });
  });

  const client = new UnityInspectorClient({ host: '127.0.0.1', port: stub.port });
  t.after(async () => { client.disconnect(); await stub.close(); });

  const sleeps = [];
  const sleep = async (ms) => { sleeps.push({ ms, sent: [...seen] }); };

  const result = await runCapture({
      bro: 'Drunken Broster',
      level: null,
      swapSettleMs: 2000,
      swapTimeoutMs: 5000,
      statesPaths: [statesPath],
      out: outDir,
      gameOut: outDir,
      timeoutMs: 5000,
      player: 0,
    }, client, { pollMs: 5, sleep });

  assert.deepEqual(result.outcome, { status: 'done' });
  assert.deepEqual(seen, [
    'ping', 'game_state', 'swap_bro', 'game_state', 'game_state',
    'execute_script', 'unload_script', 'set_game_speed',
  ], 'one look before the swap, then polls until the name changes');

  const settles = sleeps.filter((call) => call.ms === 2000);
  assert.equal(settles.length, 1, 'settled once, not once per poll');
  assert.equal(settles[0].sent[settles[0].sent.length - 1], 'game_state', 'after the new character was seen');
  assert.ok(!settles[0].sent.includes('execute_script'), 'and before the sweep');
});

test('runCapture takes anything alive as the swap when the slot was empty first', { timeout: 20000 }, async (t) => {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'input-states.json');
  const outDir = path.join(dir, 'out');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));

  const seen = [];
  let swapped = false;
  const stub = await startStubServer((request, socket) => {
    seen.push(request.method);
    if (request.method === 'swap_bro') swapped = true;

    if (request.method === 'game_state') {
      // No player at all before the swap, so there is no name to differ from
      reply(socket, request.id, swapped ? slotState(DRUNKEN_OBJECT) : slotState(null));
      return;
    }
    if (request.method === 'execute_script') {
      writeNow(path.join(outDir, 'capture.json'), JSON.stringify(fixtureCapture));
      writeNow(path.join(outDir, 'done'), '');
    }
    reply(socket, request.id, { success: true });
  });

  const client = new UnityInspectorClient({ host: '127.0.0.1', port: stub.port });
  t.after(async () => { client.disconnect(); await stub.close(); });

  const result = await runCapture({
      bro: 'Drunken Broster',
      level: null,
      swapSettleMs: 0,
      swapTimeoutMs: 5000,
      statesPaths: [statesPath],
      out: outDir,
      gameOut: outDir,
      timeoutMs: 5000,
      player: 0,
    }, client, { pollMs: 5 });

  assert.deepEqual(result.outcome, { status: 'done' });
  assert.deepEqual(seen, [
    'ping', 'game_state', 'swap_bro', 'game_state', 'execute_script', 'unload_script', 'set_game_speed',
  ], 'the first live character in an empty slot is the swap');
});

test('runCapture takes the swap_bro reply as the change and only waits for liveness', { timeout: 20000 }, async (t) => {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'input-states.json');
  const outDir = path.join(dir, 'out');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));

  const seen = [];
  let polls = 0;
  const stub = await startStubServer((request, socket) => {
    seen.push(request.method);

    if (request.method === 'swap_bro') {
      // StateModifier.SwapBro reads the name back on the main thread, so the reply is the new one
      reply(socket, request.id, { success: true, broName: DRUNKEN_OBJECT, heroType: 'Rambro' });
      return;
    }
    if (request.method === 'game_state') {
      polls++;
      // game_state still names the old character, and the reply has already settled that question,
      // so the only thing left to wait on is the slot coming alive
      reply(socket, request.id, slotState(AMERIBRO_OBJECT, { isAlive: polls > 2 }));
      return;
    }
    if (request.method === 'execute_script') {
      writeNow(path.join(outDir, 'capture.json'), JSON.stringify(fixtureCapture));
      writeNow(path.join(outDir, 'done'), '');
    }
    reply(socket, request.id, { success: true });
  });

  const client = new UnityInspectorClient({ host: '127.0.0.1', port: stub.port });
  t.after(async () => { client.disconnect(); await stub.close(); });

  const result = await runCapture({
      bro: 'Drunken Broster',
      level: null,
      swapSettleMs: 0,
      swapTimeoutMs: 5000,
      statesPaths: [statesPath],
      out: outDir,
      gameOut: outDir,
      timeoutMs: 5000,
      player: 0,
    }, client, { pollMs: 5 });

  assert.deepEqual(result.outcome, { status: 'done' });
  assert.deepEqual(seen, [
    'ping', 'game_state', 'swap_bro', 'game_state', 'game_state',
    'execute_script', 'unload_script', 'set_game_speed',
  ], 'polled until alive, not until the name changed');
});

test('runCapture skips the poll when swap_bro reports the bro that was already there', { timeout: 20000 }, async (t) => {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'input-states.json');
  const outDir = path.join(dir, 'out');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));

  const seen = [];
  const stub = await startStubServer((request, socket) => {
    seen.push(request.method);

    if (request.method === 'swap_bro') {
      // The same name the snapshot saw: the slot already held this bro, so nothing changed
      reply(socket, request.id, { success: true, broName: RAMBRO_OBJECT, heroType: 'Rambro' });
      return;
    }
    if (request.method === 'game_state') {
      reply(socket, request.id, slotState(RAMBRO_OBJECT));
      return;
    }
    if (request.method === 'execute_script') {
      writeNow(path.join(outDir, 'capture.json'), JSON.stringify(fixtureCapture));
      writeNow(path.join(outDir, 'done'), '');
    }
    reply(socket, request.id, { success: true });
  });

  const client = new UnityInspectorClient({ host: '127.0.0.1', port: stub.port });
  t.after(async () => { client.disconnect(); await stub.close(); });

  const result = await runCapture({
      bro: 'Rambro',
      level: null,
      swapSettleMs: 0,
      swapTimeoutMs: 5000,
      statesPaths: [statesPath],
      out: outDir,
      gameOut: outDir,
      timeoutMs: 5000,
      player: 0,
    }, client, { pollMs: 5 });

  assert.deepEqual(result.outcome, { status: 'done' });
  assert.deepEqual(seen, [
    'ping', 'game_state', 'swap_bro', 'execute_script', 'unload_script', 'set_game_speed',
  ], 'the pre-swap snapshot is the only game_state');
});

test('runCapture refuses to sweep when the slot never reports a different character', { timeout: 20000 }, async (t) => {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'input-states.json');
  const outDir = path.join(dir, 'out');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));

  const seen = [];
  const stub = await startStubServer((request, socket) => {
    seen.push(request.method);
    if (request.method === 'game_state') {
      // swap_bro answered success without naming a character, and the slot holds the same one
      // throughout: nothing ever confirms the swap
      reply(socket, request.id, slotState(RAMBRO_OBJECT));
      return;
    }
    if (request.method === 'execute_script') {
      writeNow(path.join(outDir, 'capture.json'), JSON.stringify(fixtureCapture));
      writeNow(path.join(outDir, 'done'), '');
    }
    reply(socket, request.id, { success: true });
  });

  const client = new UnityInspectorClient({ host: '127.0.0.1', port: stub.port });
  t.after(async () => { client.disconnect(); await stub.close(); });

  await assert.rejects(
    runCapture({
        bro: 'Drunken Broster',
        level: null,
        swapSettleMs: 0,
        // The sweep timeout is long; the swap poll is what has to give up
        swapTimeoutMs: 60,
        statesPaths: [statesPath],
        out: outDir,
        gameOut: outDir,
        timeoutMs: 60000,
        player: 0,
      }, client, { pollMs: 5 }),
    /Slot 0 still reports .* after swapping to "Drunken Broster": the swap never landed/,
  );

  assert.ok(!seen.includes('execute_script'), 'the unswapped slot is never swept');
  await assert.rejects(fs.readFile(path.join(outDir, 'report.md'), 'utf-8'), /ENOENT/, 'and no report is left');
  await assert.rejects(fs.readFile(path.join(outDir, 'capture.json'), 'utf-8'), /ENOENT/);
});

test('runCapture aborts when the swapped-in character never comes alive', { timeout: 20000 }, async (t) => {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'input-states.json');
  const outDir = path.join(dir, 'out');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));
  // A report from an earlier run must not survive an abort that deletes the strips it describes
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'report.md'), '# Animation capture\nstale\n');

  const seen = [];
  let swapped = false;
  const stub = await startStubServer((request, socket) => {
    seen.push(request.method);

    if (request.method === 'swap_bro') {
      // What the real mod sends: the swap took, and the reply names the object it left in the slot
      swapped = true;
      reply(socket, request.id, { success: true, broName: DRUNKEN_OBJECT, heroType: 'DrunkenBroster' });
      return;
    }
    if (request.method === 'game_state') {
      // The old character is gone and the new one never spawns, so the slot never comes alive
      reply(socket, request.id, slotState(AMERIBRO_OBJECT, { isAlive: !swapped }));
      return;
    }
    reply(socket, request.id, { success: true });
  });

  const client = new UnityInspectorClient({ host: '127.0.0.1', port: stub.port });
  t.after(async () => { client.disconnect(); await stub.close(); });

  await assert.rejects(
    runCapture({
        bro: 'Drunken Broster',
        level: null,
        swapSettleMs: 0,
        swapTimeoutMs: 60,
        statesPaths: [statesPath],
        out: outDir,
        gameOut: outDir,
        timeoutMs: 60000,
        player: 0,
      }, client, { pollMs: 5 }),
    /isAlive=false 0s after swapping to "Drunken Broster": the swap never landed[\s\S]*last game_state: scene=Level/,
  );

  assert.ok(!seen.includes('execute_script'), 'a slot with nothing alive in it is never swept');
  await assert.rejects(
    fs.readFile(path.join(outDir, 'report.md'), 'utf-8'),
    /ENOENT/,
    'and the previous run\'s report goes with the strips it described',
  );
});

test('runCapture does not settle when no level was asked for', { timeout: 20000 }, async (t) => {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'input-states.json');
  const outDir = path.join(dir, 'out');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));

  const slot = swappingSlot(AMERIBRO_OBJECT, DRUNKEN_OBJECT);
  const stub = await startStubServer((request, socket) => {
    slot.onRequest(request.method);
    if (request.method === 'game_state') {
      reply(socket, request.id, slot.reply());
      return;
    }
    if (request.method === 'execute_script') {
      writeNow(path.join(outDir, 'capture.json'), JSON.stringify(fixtureCapture));
      writeNow(path.join(outDir, 'done'), '');
    }
    reply(socket, request.id, { success: true });
  });

  const client = new UnityInspectorClient({ host: '127.0.0.1', port: stub.port });
  t.after(async () => { client.disconnect(); await stub.close(); });

  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };

  await runCapture({
      bro: 'Rambro',
      level: null,
      // A settle is only supplied alongside a level, and is ignored here either way
      settleMs: 3000,
      statesPaths: [statesPath],
      out: outDir,
      gameOut: outDir,
      timeoutMs: 5000,
      player: 0,
    }, client, { pollMs: 5, sleep });

  assert.ok(!sleeps.includes(3000), 'nothing to settle after');
});

test('runCapture leaves the game where it is without --level', { timeout: 20000 }, async (t) => {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'input-states.json');
  const outDir = path.join(dir, 'out');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));

  const seen = [];
  const slot = swappingSlot(AMERIBRO_OBJECT, DRUNKEN_OBJECT);
  const stub = await startStubServer((request, socket) => {
    seen.push(request.method);
    slot.onRequest(request.method);
    if (request.method === 'game_state') {
      reply(socket, request.id, slot.reply());
      return;
    }
    if (request.method === 'execute_script') {
      writeNow(path.join(outDir, 'capture.json'), JSON.stringify(fixtureCapture));
      writeNow(path.join(outDir, 'done'), '');
    }
    reply(socket, request.id, { success: true });
  });

  const client = new UnityInspectorClient({ host: '127.0.0.1', port: stub.port });
  t.after(async () => { client.disconnect(); await stub.close(); });

  await runCapture({
      bro: 'Rambro',
      level: null,
      statesPaths: [statesPath],
      out: outDir,
      gameOut: outDir,
      timeoutMs: 5000,
      player: 0,
    }, client, { pollMs: 5 });

  assert.deepEqual(seen, [
    'ping', 'game_state', 'swap_bro', 'game_state', 'execute_script', 'unload_script', 'set_game_speed',
  ]);
  assert.ok(!seen.includes('go_to_level'), 'no level was asked for');
  assert.equal(seen.indexOf('game_state'), seen.indexOf('swap_bro') - 1, 'the first poll is the pre-swap snapshot');
});

test('runCapture fails before the sweep when the level never brings a player', { timeout: 20000 }, async (t) => {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'input-states.json');
  const outDir = path.join(dir, 'out');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));

  const seen = [];
  const stub = await startStubServer((request, socket) => {
    seen.push(request.method);
    if (request.method === 'game_state') {
      reply(socket, request.id, { scene: 'Intro', players: [] });
      return;
    }
    reply(socket, request.id, { success: true });
  });

  const client = new UnityInspectorClient({ host: '127.0.0.1', port: stub.port });
  t.after(async () => { client.disconnect(); await stub.close(); });

  await assert.rejects(
    () => runCapture({
        bro: 'Rambro',
        level: { campaignIndex: 1, levelIndex: 0 },
        statesPaths: [statesPath],
        out: outDir,
        gameOut: outDir,
        timeoutMs: 60,
        player: 0,
      }, client, { pollMs: 5 }),
    (err) => /never reported a player in slot 0/.test(err.message)
      && /scene=Intro players=0 live=0/.test(err.message),
  );

  assert.ok(!seen.includes('swap_bro'), 'the swap that would have failed is never sent');
  assert.ok(!seen.includes('execute_script'), 'and the sweep never starts');
});

test('runCapture reports a script-side failure and still restores game speed', { timeout: 20000 }, async (t) => {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'input-states.json');
  const outDir = path.join(dir, 'out');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));

  const seen = [];
  const stub = await startStubServer((request, socket) => {
    seen.push(request.method);
    if (request.method === 'execute_script') {
      writeNow(path.join(outDir, 'error'), "state 'running': unknown field 'nope'");
    }
    reply(socket, request.id, { success: true });
  });

  const client = new UnityInspectorClient({ host: '127.0.0.1', port: stub.port });
  t.after(async () => { client.disconnect(); await stub.close(); });

  const result = await runCapture({ bro: null, statesPaths: [statesPath], out: outDir, gameOut: outDir, timeoutMs: 5000, player: 0 }, client, { pollMs: 5 });

  assert.equal(result.outcome.status, 'error');
  assert.match(result.outcome.message, /unknown field 'nope'/);
  assert.deepEqual(seen, ['ping', 'execute_script', 'unload_script', 'set_game_speed']);
  assert.match(result.report, /0 captured/);
});

test('runCapture refuses a malformed state file before touching the game', { timeout: 20000 }, async (t) => {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'bad-states.json');
  await fs.writeFile(statesPath, JSON.stringify([{ name: 'broken' }]));

  const seen = [];
  const stub = await startStubServer((request, socket) => {
    seen.push(request.method);
    reply(socket, request.id, { success: true });
  });

  const client = new UnityInspectorClient({ host: '127.0.0.1', port: stub.port });
  t.after(async () => { client.disconnect(); await stub.close(); });

  await assert.rejects(
    runCapture({ statesPaths: [statesPath], out: path.join(dir, 'out'), gameOut: path.join(dir, 'out'), timeoutMs: 1000, player: 0 }, client, { pollMs: 5 }),
    (err) => err instanceof UsageError && /needs a step block/.test(err.message),
  );
  assert.deepEqual(seen, [], 'no command reaches the game');
});

test('runCapture surfaces a refused bro swap', { timeout: 20000 }, async (t) => {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'input-states.json');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));

  const stub = await startStubServer((request, socket) => {
    if (request.method === 'swap_bro') {
      reply(socket, request.id, { success: false, error: "Bro 'Nobody' not found or swap failed" });
      return;
    }
    reply(socket, request.id, { success: true });
  });

  const client = new UnityInspectorClient({ host: '127.0.0.1', port: stub.port });
  t.after(async () => { client.disconnect(); await stub.close(); });

  await assert.rejects(
    runCapture({
        bro: 'Nobody', statesPaths: [statesPath], out: path.join(dir, 'out'), gameOut: path.join(dir, 'out'),
        timeoutMs: 1000, player: 0,
      }, client, { pollMs: 5 }),
    /swap_bro failed: Bro 'Nobody' not found/,
  );
});

test('describeFailure carries the compiler errors and the script output', () => {
  const message = describeFailure('execute_script', {
    success: false,
    error: 'Compilation failed',
    compilerErrors: 'animation-capture.cs(11,7): error CS0246: Newtonsoft not found',
    output: ['first line', 'second line'],
  });

  assert.match(message, /execute_script failed: Compilation failed/);
  assert.match(message, /compiler errors:\nanimation-capture\.cs\(11,7\): error CS0246/);
  assert.match(message, /script output:\nfirst line\nsecond line/);
});

test('describeFailure copes with a bare failure', () => {
  assert.equal(describeFailure('ping', { success: false }), 'ping failed: unknown error');
  assert.equal(describeFailure('ping', null), 'ping failed: unknown error');
});

test('buildReport separates a known mismatch from a real one', () => {
  const states = [
    {
      name: 'special_new',
      step: { field: 'frame', values: [0, 1] },
      expect: { sheet: 'main', row: 5, cols: [17, 18] },
      knownMismatch: 'frame 7 self-cancels and re-enters ChangeFrame',
    },
    { name: 'idle', step: { field: 'frame', values: [0] }, expect: { sheet: 'main', row: 1, cols: [0, 0] } },
  ];
  const capture = {
    bro: { type: 'Rambro' },
    errors: [],
    states: [
      {
        name: 'special_new',
        skipped: null,
        frames: [{ step: 0, body: { row: 5, col: 17 } }, { step: 1, body: { row: 1, col: 0 } }],
      },
      { name: 'idle', skipped: null, frames: [{ step: 0, body: { row: 1, col: 4 } }] },
    ],
  };

  const { text: report } = buildReport({ capture, states, outDir: '/tmp/shots', options: {} });

  assert.match(report, /mismatches against the state list: 1/, 'only idle counts as a real mismatch');
  assert.match(report, /## Known mismatches \(1\)/);
  assert.match(report, /- \*\*special_new\*\* — addressed .*; frame 7 self-cancels/);
  assert.match(report, /special_new \| 2 \|.*\(known\) \|/);
  assert.match(report, /idle \| 1 \|.*✗ \|/);
});

test('buildReport lists the states that errored mid-sweep', () => {
  const states = [
    { name: 'running', step: { field: 'frame', values: [0] }, expect: { sheet: 'main', row: 2, cols: [0, 0] } },
    { name: 'rolling', step: { field: 'rollingFrames', values: [2] }, expect: { sheet: 'main', row: 2, cols: [31, 31] } },
  ];
  const capture = {
    bro: { type: 'Rambro' },
    errors: ["state 'rolling': unknown field 'rollingFrames'"],
    states: [
      { name: 'running', skipped: null, frames: [{ step: 0, body: { row: 2, col: 0 } }] },
      { name: 'rolling', skipped: "error: state 'rolling': unknown field 'rollingFrames'", frames: [] },
    ],
  };

  const { text: report } = buildReport({ capture, states, outDir: '/tmp/shots', options: {} });

  assert.match(report, /errored mid-sweep: 1/);
  assert.match(report, /## Errors \(1\)[\s\S]*unknown field 'rollingFrames'/);
  assert.match(report, /- \*\*rolling\*\* — error: state 'rolling'/, 'it also shows under skipped');
  assert.match(report, /1 captured, 1 skipped/);
});

test('buildReport renders a before/after method that the character does not have', () => {
  const states = [
    {
      name: 'running_holding_item',
      before: ['SwitchToHeldItem'],
      after: ['ClearHeldItem'],
      step: { field: 'frame', values: [0] },
      expect: { sheet: 'main', row: 2, cols: [0, 0] },
    },
  ];
  const failure = "state 'running_holding_item': unknown method 'SwitchToHeldItem'";
  const capture = {
    bro: { type: 'Rambro' },
    errors: [failure],
    states: [{ name: 'running_holding_item', skipped: `error: ${failure}`, frames: [] }],
  };

  const { text: report } = buildReport({ capture, states, outDir: '/tmp/shots', options: {} });

  assert.match(report, /0 captured, 1 skipped/);
  assert.match(report, /errored mid-sweep: 1/);
  assert.match(report, /## Errors \(1\)[\s\S]*unknown method 'SwitchToHeldItem'/);
  assert.match(report, /- \*\*running_holding_item\*\* — error: state 'running_holding_item'/);
});

test('buildReport lists an after failure without unmaking the captured state', () => {
  const states = [
    {
      name: 'running_holding_item',
      before: ['SwitchToHeldItem'],
      after: ['ClearHeldItem'],
      step: { field: 'frame', values: [0, 1] },
      expect: { sheet: 'main', row: 2, cols: [0, 1] },
    },
  ];
  const teardown = "state 'running_holding_item' after ClearHeldItem: Object reference not set";
  const capture = {
    bro: { type: 'DrunkenBroster' },
    errors: [],
    states: [
      {
        name: 'running_holding_item',
        skipped: null,
        afterError: teardown,
        frames: [
          { step: 0, body: { row: 2, col: 0 }, gun: { row: 8, col: 0, enabled: true } },
          { step: 1, body: { row: 2, col: 1 }, gun: { row: 8, col: 1, enabled: true } },
        ],
      },
    ],
  };

  const { text: report } = buildReport({ capture, states, outDir: '/tmp/shots', options: {} });

  assert.match(report, /1 captured, 0 skipped/, 'the state keeps its frames');
  assert.match(report, /main row 2 cols 0-1 ✓/, 'and its verdict');
  assert.match(report, /gun row 8 cols 0-1/);
  assert.match(report, /## Errors \(1\)[\s\S]*after ClearHeldItem: Object reference not set/);
});

test('buildReport does not repeat an after failure the game already reported', () => {
  const teardown = "state 'held' after ClearHeldItem: boom";
  const capture = {
    bro: { type: 'DrunkenBroster' },
    errors: [teardown],
    states: [{ name: 'held', skipped: null, afterError: teardown, frames: [{ step: 0, body: { row: 2, col: 0 } }] }],
  };

  const { text: report } = buildReport({ capture, states: [], outDir: '/tmp/shots', options: {} });

  assert.match(report, /errored mid-sweep: 1/);
  assert.equal(report.match(/after ClearHeldItem: boom/g).length, 1);
});

const gunState = {
  name: 'running_holding_item',
  step: { field: 'frame', values: [0, 1] },
  expect: { sheet: 'main', row: 2, cols: [0, 1] },
  expectGun: { row: 8, cols: [0, 1] },
};

const gunCapture = (gun) => ({
  bro: { type: 'DrunkenBroster' },
  errors: [],
  states: [
    {
      name: 'running_holding_item',
      skipped: null,
      frames: [
        { step: 0, body: { row: 2, col: 0 }, gun: gun[0] },
        { step: 1, body: { row: 2, col: 1 }, gun: gun[1] },
      ],
    },
  ],
});

test('buildReport passes a state only when the gun walks its expectGun span too', () => {
  const { text: report } = buildReport({
    capture: gunCapture([{ row: 8, col: 0, enabled: true }, { row: 8, col: 1, enabled: true }]),
    states: [gunState],
    outDir: '/tmp/shots',
    options: {},
  });

  assert.match(report, /mismatches against the state list: 0/);
  assert.match(report, /main row 2 cols 0-1; gun row 8 cols 0-1 ✓/);
});

test('buildReport names the gun sheet the expectGun asks for in both columns', () => {
  const state = { ...gunState, expectGun: { sheet: 'melee', row: 8, cols: [0, 1] } };
  const { text: report } = buildReport({
    capture: gunCapture([{ row: 8, col: 0, enabled: true }, { row: 8, col: 1, enabled: true }]),
    states: [state],
    outDir: '/tmp/shots',
    options: {},
  });

  assert.match(report, /\| melee row 8 cols 0-1 \| main row 2 cols 0-1; melee row 8 cols 0-1 ✓ \|/);
  assert.doesNotMatch(report, /gun row 8/, 'the hardcoded sheet name is gone');
});

test('buildReport fails a state whose body is right and whose gun is not', () => {
  const { text: report } = buildReport({
    capture: gunCapture([{ row: 2, col: 0, enabled: true }, { row: 2, col: 1, enabled: true }]),
    states: [gunState],
    outDir: '/tmp/shots',
    options: {},
  });

  assert.match(report, /mismatches against the state list: 1/);
  assert.match(report, /main row 2 cols 0-1; gun row 8 cols 0-1 ✗/);
  assert.match(report, /## Mismatches \(1\)[\s\S]*expected main row 2 cols 0-1; gun row 8 cols 0-1/);
});

test('buildReport fails a state with an expectGun and no gun cells recorded', () => {
  const { text: report } = buildReport({
    capture: gunCapture([null, { row: 8, col: 1, enabled: false }]),
    states: [gunState],
    outDir: '/tmp/shots',
    options: {},
  });

  assert.match(report, /mismatches against the state list: 1/);
  assert.match(report, /\| — \| main row 2 cols 0-1; gun row 8 cols 0-1 ✗ \|/, 'no gun cells to show');
});

test('buildReport leaves a state with no expectGun judged on its body alone', () => {
  const { expectGun, ...bodyOnly } = gunState;
  const { text: report } = buildReport({
    capture: gunCapture([{ row: 4, col: 9, enabled: true }, { row: 4, col: 9, enabled: true }]),
    states: [bodyOnly],
    outDir: '/tmp/shots',
    options: {},
  });

  assert.match(report, /mismatches against the state list: 0/);
  assert.match(report, /main row 2 cols 0-1 ✓/);
});

test('a knownMismatch cannot excuse a gun that walked somewhere else', () => {
  const state = {
    ...gunState,
    step: { field: 'frame', values: [0, 1, 2] },
    expect: { sheet: 'main', row: 2, cols: [0, 2] },
    expectGun: { row: 8, cols: [0, 2] },
    knownMismatch: 'the last frame self-cancels',
  };
  const capture = {
    bro: { type: 'DrunkenBroster' },
    errors: [],
    states: [
      {
        name: 'running_holding_item',
        skipped: null,
        frames: [
          { step: 0, body: { row: 2, col: 0 }, gun: { row: 2, col: 0, enabled: true } },
          { step: 1, body: { row: 2, col: 1 }, gun: { row: 2, col: 1, enabled: true } },
          { step: 2, body: { row: 1, col: 0 }, gun: { row: 2, col: 2, enabled: true } },
        ],
      },
    ],
  };

  const { text: report } = buildReport({ capture, states: [state], outDir: '/tmp/shots', options: {} });

  assert.match(report, /mismatches against the state list: 1/, 'the gun failure is not excused');
  assert.match(report, /## Known mismatches \(0\)/);
});

test('validateStates rejects an expectation with columns but no row', () => {
  const { errors } = validateStates([
    { name: 'no_body_row', step: { values: [0, 1] }, expect: { sheet: 'main', cols: [0, 1] } },
    { name: 'no_gun_row', step: { values: [0, 1] }, expectGun: { cols: [0, 1] } },
    { name: 'row_is_text', step: { values: [0, 1] }, expect: { row: '2', cols: [0, 1] } },
    { name: 'both_rows', step: { values: [0, 1] }, expect: { row: 2, cols: [0, 1] }, expectGun: { row: 8, cols: [0, 1] } },
  ]);

  assert.deepEqual(errors, [
    'no_body_row: expect.row must be a number',
    'no_gun_row: expectGun.row must be a number',
    'row_is_text: expect.row must be a number',
  ]);
});

test('validateStates checks expectGun against the step count too', () => {
  const { errors } = validateStates([
    { name: 'short', step: { values: [0, 1] }, expectGun: { row: 8, cols: [0, 7] } },
    { name: 'backwards', step: { values: [0] }, expectGun: { row: 8, cols: [7, 0] } },
    { name: 'exact', step: { values: [0, 1] }, expect: { row: 2, cols: [0, 1] }, expectGun: { row: 8, cols: [0, 1] } },
  ]);

  assert.equal(errors.length, 2);
  assert.match(errors[0], /^short: 2 step value\(s\) for expectGun columns 0-7 \(8 cells\)/);
  assert.match(errors[1], /^backwards: expectGun\.cols must be \[from, to\]/);
});

test('runCapture reports state errors and still returns a report', { timeout: 20000 }, async (t) => {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'input-states.json');
  const outDir = path.join(dir, 'out');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));

  const partial = {
    bro: { type: 'Rambro' },
    errors: ["state 'idle': unknown field 'nope'"],
    states: [
      { name: 'running', skipped: null, frames: [{ step: 0, body: { row: 2, col: 0 } }, { step: 1, body: { row: 2, col: 1 } }] },
      { name: 'idle', skipped: "error: state 'idle': unknown field 'nope'", frames: [] },
    ],
  };

  const stub = await startStubServer((request, socket) => {
    if (request.method === 'execute_script') {
      writeNow(path.join(outDir, 'capture.json'), JSON.stringify(partial));
      writeNow(path.join(outDir, 'done'), '');
    }
    reply(socket, request.id, { success: true });
  });

  const client = new UnityInspectorClient({ host: '127.0.0.1', port: stub.port });
  t.after(async () => { client.disconnect(); await stub.close(); });

  const result = await runCapture({ statesPaths: [statesPath], out: outDir, gameOut: outDir, timeoutMs: 5000, player: 0 }, client, { pollMs: 5 });

  assert.deepEqual(result.outcome, { status: 'done' }, 'a state error does not fail the sweep');
  assert.deepEqual(result.stateErrors, ["state 'idle': unknown field 'nope'"]);
  assert.match(result.report, /1 captured, 1 skipped/);
  assert.match(result.report, /## Errors \(1\)/);
});

test('runCapture clears the previous run\'s strips', { timeout: 20000 }, async (t) => {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'input-states.json');
  const outDir = path.join(dir, 'out');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));
  writeNow(path.join(outDir, 'gone_state.png'), 'stale');
  writeNow(path.join(outDir, 'keep.txt'), 'untouched');

  const stub = await startStubServer((request, socket) => {
    if (request.method === 'execute_script') {
      writeNow(path.join(outDir, 'capture.json'), JSON.stringify(fixtureCapture));
      writeNow(path.join(outDir, 'done'), '');
    }
    reply(socket, request.id, { success: true });
  });

  const client = new UnityInspectorClient({ host: '127.0.0.1', port: stub.port });
  t.after(async () => { client.disconnect(); await stub.close(); });

  await runCapture({ statesPaths: [statesPath], out: outDir, gameOut: outDir, timeoutMs: 5000, player: 0 }, client, { pollMs: 5 });

  const left = await fs.readdir(outDir);
  assert.ok(!left.includes('gone_state.png'), 'a stale strip is removed');
  assert.ok(left.includes('keep.txt'), 'nothing else is touched');
});

test('teardown still runs when the sweep throws', { timeout: 20000 }, async (t) => {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'input-states.json');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));

  const seen = [];
  const stub = await startStubServer((request, socket) => {
    seen.push(request.method);
    if (request.method === 'execute_script') {
      reply(socket, request.id, {
        success: false,
        error: 'Compilation failed',
        compilerErrors: 'animation-capture.cs(200,9): error CS0103',
      });
      return;
    }
    reply(socket, request.id, { success: true });
  });

  const client = new UnityInspectorClient({ host: '127.0.0.1', port: stub.port });
  t.after(async () => { client.disconnect(); await stub.close(); });

  await assert.rejects(
    runCapture({ statesPaths: [statesPath], out: path.join(dir, 'out'), gameOut: path.join(dir, 'out'), timeoutMs: 1000, player: 0 }, client, { pollMs: 5 }),
    /Compilation failed[\s\S]*error CS0103/,
  );

  assert.deepEqual(seen, ['ping', 'execute_script', 'unload_script', 'set_game_speed']);
});

test('mergeStates lets a later layer replace an entry of the same name in place', () => {
  const base = [
    { name: 'idle', step: { values: [0] } },
    { name: 'special_new', step: { values: [0, 1] }, knownMismatch: 'terminal step' },
    { name: 'running', step: { values: [0] } },
  ];
  const custom = [
    { name: 'special_new', step: { values: [0, 1, 2] } },
    { name: 'drunk_stagger', step: { values: [0] } },
  ];

  const merged = mergeStates([base, custom]);

  assert.deepEqual(merged.map((state) => state.name), ['idle', 'special_new', 'running', 'drunk_stagger']);
  assert.deepEqual(merged[1].step.values, [0, 1, 2], 'the custom entry wins');
  assert.equal(merged[1].knownMismatch, undefined, 'it replaces rather than merges keys');
});

test('loadStates layers the files it is given, base first', async (t) => {
  const dir = await tempDir(t);
  const basePath = path.join(dir, 'base.json');
  const customPath = path.join(dir, 'custom.json');
  await fs.writeFile(basePath, JSON.stringify({
    states: [{ name: 'idle', step: { values: [0] } }, { name: 'special_new', step: { values: [0] } }],
  }));
  await fs.writeFile(customPath, JSON.stringify([
    { name: 'special_new', unsupported: 'this bro has no special' },
  ]));

  const states = await loadStates([basePath, customPath]);

  assert.deepEqual(states.map((state) => state.name), ['idle', 'special_new']);
  assert.equal(states[1].unsupported, 'this bro has no special');
});

test('loadStates rejects a bad layer by name', async (t) => {
  const dir = await tempDir(t);
  const basePath = path.join(dir, 'base.json');
  const customPath = path.join(dir, 'custom.json');
  await fs.writeFile(basePath, JSON.stringify({ states: [{ name: 'idle', step: { values: [0] } }] }));
  await fs.writeFile(customPath, JSON.stringify([{ name: 'broken' }]));

  await assert.rejects(
    loadStates([basePath, customPath]),
    (err) => err instanceof UsageError && err.message.includes(customPath),
  );
});

const spanState = (cols, steps) => ({
  name: 'probe',
  step: { field: 'frame', values: steps },
  expect: { sheet: 'main', row: 5, cols },
});

test('knownMismatchHolds only excuses the terminal step', () => {
  const state = spanState([17, 20], [0, 1, 2, 3]);
  const walked = [17, 18, 19].map((col) => ({ body: { row: 5, col } }));

  assert.equal(
    knownMismatchHolds([...walked, { body: { row: 1, col: 0 } }], state),
    true,
    'the leading steps walk 17-19 and only the last lands elsewhere',
  );
  assert.equal(
    knownMismatchHolds([{ body: { row: 5, col: 17 } }, { body: { row: 9, col: 3 } }, { body: { row: 5, col: 19 } },
      { body: { row: 1, col: 0 } }], state),
    false,
    'a leading step in the wrong place is a real mismatch',
  );
  assert.equal(
    knownMismatchHolds([{ body: { row: 5, col: 18 } }, { body: { row: 5, col: 17 } }, { body: { row: 5, col: 19 } },
      { body: { row: 1, col: 0 } }], state),
    false,
    'the right leading columns in the wrong order is a real mismatch',
  );
  assert.equal(knownMismatchHolds(walked, { ...state, expect: null }), false);
});

test('knownMismatchHolds does not degenerate on a single-column expectation', () => {
  // cols [3,3] used to become the empty leading span [3,2], which every state matched
  const state = spanState([3, 3], [0]);

  assert.equal(knownMismatchHolds([{ body: { row: 5, col: 3 } }], state), false,
    'one step is all terminal: there is nothing left to vouch for it');
  assert.equal(knownMismatchHolds([{ body: { row: 9, col: 9 } }], state), false);
});

test('cellSequence keeps order and duplicates, unlike the display ranges', () => {
  const frames = [
    { body: { row: 2, col: 1 } },
    { body: { row: 2, col: 0 } },
    { body: { row: 2, col: 0 } },
  ];

  assert.deepEqual(cellSequence(frames, 'body'), [[2, 1], [2, 0], [2, 0]]);
  assert.equal(describeCells(frames, 'body', 'main'), 'main row 2 cols 0-1', 'display still compresses');
  assert.deepEqual(cellSequence([{ body: null }, { gun: { row: 1, col: 1, enabled: false } }], 'gun'), [null, null]);
});

test('expectedSequence walks the span one column per step', () => {
  assert.deepEqual(expectedSequence(spanState([2, 4], [0, 1, 2])), [[5, 2], [5, 3], [5, 4]]);
  assert.deepEqual(expectedSequence(spanState([3, 3], [0])), [[5, 3]]);
  assert.equal(expectedSequence(spanState([2, 4], [0, 1])), null, 'a step count that disagrees has no walk');
  assert.equal(expectedSequence({ name: 'x', step: { values: [0] } }), null);
});

test('sameSequence is order and length sensitive', () => {
  assert.equal(sameSequence([[1, 0], [1, 1]], [[1, 0], [1, 1]]), true);
  assert.equal(sameSequence([[1, 1], [1, 0]], [[1, 0], [1, 1]]), false);
  assert.equal(sameSequence([[1, 0]], [[1, 0], [1, 1]]), false);
  assert.equal(sameSequence([null, [1, 1]], [[1, 0], [1, 1]]), false);
});

test('buildReport fails a state that walks the right columns in the wrong order', () => {
  const states = [{
    name: 'running',
    step: { field: 'frame', values: [0, 1, 2] },
    expect: { sheet: 'main', row: 2, cols: [0, 2] },
  }];
  const ordered = [0, 1, 2].map((col) => ({ body: { row: 2, col } }));

  const verdict = (frames) => {
    const { text: report } = buildReport({
      capture: { bro: { type: 'Rambro' }, errors: [], states: [{ name: 'running', skipped: null, frames }] },
      states,
      outDir: '/tmp/shots',
      options: {},
    });
    return /mismatches against the state list: 0/.test(report);
  };

  assert.equal(verdict(ordered), true, 'the correct walk passes');
  assert.equal(verdict([ordered[2], ordered[1], ordered[0]]), false, 'reversed fails');
  assert.equal(verdict([ordered[0], ordered[0], ordered[2]]), false, 'a duplicated frame fails');
});

test('buildReport demotes a knownMismatch state that is really broken', () => {
  const states = [{
    name: 'special_new',
    step: { field: 'frame', values: [0, 1, 2] },
    expect: { sheet: 'main', row: 5, cols: [17, 19] },
    knownMismatch: 'frame 7 self-cancels and re-enters ChangeFrame',
  }];
  const capture = {
    bro: { type: 'Rambro' },
    errors: [],
    states: [{
      name: 'special_new',
      skipped: null,
      // the second step should have been column 18 and is not: this is not the known problem
      frames: [{ body: { row: 5, col: 17 } }, { body: { row: 2, col: 4 } }, { body: { row: 1, col: 0 } }],
    }],
  };

  const { text: report } = buildReport({ capture, states, outDir: '/tmp/shots', options: {} });

  assert.match(report, /mismatches against the state list: 1/);
  assert.match(report, /## Known mismatches \(0\)/);
  assert.match(report, /## Mismatches \(1\)[\s\S]*more than the known terminal-step mismatch/);
  assert.match(report, /special_new \| 3 \|.*✗ \|/, 'the table shows it as a real mismatch');
});

test('the bundled list marks the states that kill the player', async () => {
  const doc = JSON.parse(await fs.readFile(DEFAULT_STATES_PATH, 'utf-8'));
  const { states } = validateStates(doc);
  const lethal = states.filter((state) => state.lethal).map((state) => state.name).sort();

  assert.deepEqual(lethal, ['death_falling', 'death_grounded', 'insemination']);
  for (const state of states) {
    if (state.lethal) assert.ok(state.lethalReason, `${state.name}: a lethal state must say why`);
  }
});

test('partitionLethal holds lethal states back unless they are asked for', () => {
  const states = [
    { name: 'idle' },
    { name: 'death_grounded', lethal: true, lethalReason: 'kills the player' },
  ];

  assert.deepEqual(partitionLethal(states, false), {
    states: [{ name: 'idle' }],
    excluded: [{ name: 'death_grounded', lethal: true, lethalReason: 'kills the player' }],
  });
  assert.deepEqual(partitionLethal(states, true), { states, excluded: [] });
});

test('buildReport lists the excluded lethal states', () => {
  const { text: report } = buildReport({
    capture: { bro: { type: 'Rambro' }, errors: [], states: [] },
    states: [],
    outDir: '/tmp/shots',
    options: { excluded: [{ name: 'death_grounded', lethalReason: 'the game respawns the player' }] },
  });

  assert.match(report, /0 captured, 0 skipped, 1 excluded/);
  assert.match(report, /## Excluded \(1\)[\s\S]*death_grounded\*\* — the game respawns the player; set includeLethal: true/);
});

test('runCapture leaves lethal states out of the list it sends the game', { timeout: 20000 }, async (t) => {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'input-states.json');
  const outDir = path.join(dir, 'out');
  await fs.writeFile(statesPath, JSON.stringify({
    states: [
      ...fixtureStates,
      { name: 'death_grounded', lethal: true, lethalReason: 'kills the player', step: { values: [0] } },
    ],
  }));

  const stub = await startStubServer((request, socket) => {
    if (request.method === 'execute_script') {
      writeNow(path.join(outDir, 'capture.json'), JSON.stringify(fixtureCapture));
      writeNow(path.join(outDir, 'done'), '');
    }
    reply(socket, request.id, { success: true });
  });

  const client = new UnityInspectorClient({ host: '127.0.0.1', port: stub.port });
  t.after(async () => { client.disconnect(); await stub.close(); });

  const base = {
    statesPaths: [statesPath], out: outDir, gameOut: outDir, timeoutMs: 5000, player: 0,
  };
  const guarded = await runCapture({ ...base, includeLethal: false }, client, { pollMs: 5 });

  assert.deepEqual(guarded.excluded.map((state) => state.name), ['death_grounded']);
  let sent = JSON.parse(await fs.readFile(path.join(outDir, STATES_COPY_NAME), 'utf-8'));
  assert.ok(!sent.states.some((state) => state.name === 'death_grounded'), 'the game never sees it');
  assert.match(guarded.report, /## Excluded \(1\)/);

  const opted = await runCapture({ ...base, includeLethal: true }, client, { pollMs: 5 });

  assert.deepEqual(opted.excluded, []);
  sent = JSON.parse(await fs.readFile(path.join(outDir, STATES_COPY_NAME), 'utf-8'));
  assert.ok(sent.states.some((state) => state.name === 'death_grounded'), '--include-lethal sends it');
});

test('captureLogTail picks the script lines out of the game log', async (t) => {
  const dir = await tempDir(t);
  const logPath = path.join(dir, 'Player.log');
  await fs.writeFile(logPath, [
    '[Info] something unrelated',
    '[Script:animation-capture] Capturing 78 states from Rambro',
    '[Info] more noise',
    '[Script:animation-capture] animation-capture startup failed: state file not found: Z:/nope/states.json',
  ].join('\n'));

  const tail = await captureLogTail({ resolveLog: async () => ({ path: logPath }) });

  assert.equal(tail.path, logPath);
  assert.equal(tail.lines.length, 2);
  assert.match(formatLogTail(tail), /state file not found/);
  assert.doesNotMatch(formatLogTail(tail), /more noise/);
});

test('captureLogTail degrades when there is no log to read', async (t) => {
  const dir = await tempDir(t);

  assert.deepEqual(await captureLogTail({ resolveLog: async () => null }),
    { path: null, lines: [], error: 'no game log found' });
  assert.match(formatLogTail(await captureLogTail({ resolveLog: async () => null })), /no game log found/);

  const missing = await captureLogTail({ resolveLog: async () => ({ path: path.join(dir, 'gone.log') }) });
  assert.deepEqual(missing.lines, []);
  assert.match(formatLogTail(missing), /No animation-capture lines available/);

  const blown = await captureLogTail({ resolveLog: async () => { throw new Error('log search exploded'); } });
  assert.match(formatLogTail(blown), /log search exploded/);
});

test('runCapture tails the game log when the sweep never finishes', { timeout: 20000 }, async (t) => {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'input-states.json');
  const logPath = path.join(dir, 'Player.log');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));
  await fs.writeFile(logPath, [
    '[Info] unrelated',
    '[Script:animation-capture] animation-capture startup failed: player 0 has no character',
  ].join('\n'));

  const stub = await startStubServer((request, socket) => reply(socket, request.id, { success: true }));
  const client = new UnityInspectorClient({ host: '127.0.0.1', port: stub.port });
  t.after(async () => { client.disconnect(); await stub.close(); });

  let slept = 0;
  const result = await runCapture({
      statesPaths: [statesPath], out: path.join(dir, 'out'), gameOut: path.join(dir, 'out'),
      timeoutMs: 30, player: 0,
    }, client, {
      pollMs: 10,
      sleep: async () => { slept++; },
      resolveLog: async () => ({ path: logPath }),
      // Detection unavailable: the poll stays cheap enough to run inside the 30ms budget
      isRunning: async () => null,
    });

  assert.equal(result.outcome.status, 'timeout');
  assert.match(result.outcome.message, /no done or error/);
  assert.match(result.outcome.message, /player 0 has no character/, 'the log tail explains the silence');
  assert.equal(result.outcome.logTail.lines.length, 1);
  assert.ok(slept > 0);
});

test('runCapture passes box through to the script, and leaves it out when unset', { timeout: 20000 }, async (t) => {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'input-states.json');
  const outDir = path.join(dir, 'out');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));

  const seen = [];
  const stub = await startStubServer((request, socket) => {
    seen.push(request);
    if (request.method === 'execute_script') {
      writeNow(path.join(outDir, 'capture.json'), JSON.stringify(fixtureCapture));
      writeNow(path.join(outDir, 'done'), '');
    }
    reply(socket, request.id, { success: true });
  });

  const client = new UnityInspectorClient({ host: '127.0.0.1', port: stub.port });
  t.after(async () => { client.disconnect(); await stub.close(); });

  const base = { statesPaths: [statesPath], out: outDir, gameOut: outDir, timeoutMs: 5000, player: 0 };
  const run = (extra) => runCapture({ ...base, ...extra }, client, { pollMs: 5 });

  await run({ box: 40 });
  assert.equal(seen.find((r) => r.method === 'execute_script').params.args.box, '40');

  seen.length = 0;
  await run({ box: null });
  assert.equal('box' in seen.find((r) => r.method === 'execute_script').params.args, false);
});

test('buildReport counts a blank capture as errored rather than captured', () => {
  const states = [
    { name: 'running', step: { field: 'frame', values: [0, 1] }, expect: { sheet: 'main', row: 2, cols: [0, 1] } },
    { name: 'idle', step: { field: 'frame', values: [0] }, expect: { sheet: 'main', row: 1, cols: [0, 0] } },
  ];
  const blank = "state 'running' blank capture: every pixel of the strip read back as zero";
  const capture = {
    bro: { type: 'DrunkenBroster' },
    errors: [blank],
    states: [
      // The frames are still recorded: the cells the game addressed are known, the screen was empty
      {
        name: 'running',
        skipped: `error: ${blank}`,
        frames: [
          { step: 0, body: { row: 2, col: 0 } },
          { step: 1, body: { row: 2, col: 1 } },
        ],
      },
      { name: 'idle', skipped: null, frames: [{ step: 0, body: { row: 1, col: 0 } }] },
    ],
  };

  const { text: report } = buildReport({ capture, states, outDir: '/tmp/shots', options: {} });

  assert.match(report, /1 captured, 1 skipped/, 'the blank state is not counted a capture');
  assert.match(report, /errored mid-sweep: 1/);
  assert.match(report, /## Errors \(1\)[\s\S]*blank capture: every pixel of the strip read back as zero/);
  assert.match(report, /- \*\*running\*\* — error: state 'running' blank capture/);
  assert.doesNotMatch(report, /\| running \| 2 \|/, 'and it is out of the captured table');
});

test('runCapture turns the script suppression off only when side effects are allowed', { timeout: 20000 }, async (t) => {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'input-states.json');
  const outDir = path.join(dir, 'out');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));

  const seen = [];
  const stub = await startStubServer((request, socket) => {
    seen.push(request);
    if (request.method === 'execute_script') {
      writeNow(path.join(outDir, 'capture.json'), JSON.stringify(fixtureCapture));
      writeNow(path.join(outDir, 'done'), '');
    }
    reply(socket, request.id, { success: true });
  });

  const client = new UnityInspectorClient({ host: '127.0.0.1', port: stub.port });
  t.after(async () => { client.disconnect(); await stub.close(); });

  const base = { statesPaths: [statesPath], out: outDir, gameOut: outDir, timeoutMs: 5000, player: 0 };
  const argsOf = () => seen.find((r) => r.method === 'execute_script').params.args;
  const run = (extra) => runCapture({ ...base, ...extra }, client, { pollMs: 5 });

  await run({ allowSideEffects: true });
  assert.equal(argsOf().suppress, 'false');

  seen.length = 0;
  await run({ allowSideEffects: false });
  assert.equal('suppress' in argsOf(), false, 'the script defaults to suppressing');
});

test('every Drunken Broster state pins the attack flags its ChangeFrame dispatches on', async () => {
  const layerPath = path.join(path.dirname(DEFAULT_STATES_PATH), 'drunken-broster.json');
  const { states } = validateStates(JSON.parse(await fs.readFile(layerPath, 'utf-8')));

  for (const state of states) {
    for (const flag of ['attackStationary', 'attackUpwards', 'attackDownwards', 'attackForwards']) {
      assert.equal(state.setup[flag], false, `${state.name}: ${flag} steers ChangeFrame away from base`);
    }
  }
});

test('the Drunken Broster layer restates special_new and validates', async () => {
  const layerPath = path.join(path.dirname(DEFAULT_STATES_PATH), 'drunken-broster.json');
  const { states, errors } = validateStates(JSON.parse(await fs.readFile(layerPath, 'utf-8')));

  assert.deepEqual(errors, []);
  const drinking = states.find((state) => state.name === 'special_new');
  const sober = states.find((state) => state.name === 'special_new_sober');

  assert.ok(drinking && sober);
  assert.equal(drinking.step.field, 'usingSpecialFrame', 'the override is not driven by frame');
  assert.deepEqual(drinking.expect, { sheet: 'main', row: 8, cols: [0, 7] });
  assert.deepEqual(sober.expect, { sheet: 'main', row: 10, cols: [0, 10] });

  for (const state of states) {
    assert.equal(state.step.values.length, state.expect.cols[1] - state.expect.cols[0] + 1);
    assert.match(state.note, /:\d+/, 'the note must cite source lines');
  }
  for (const state of [drinking, sober]) {
    assert.match(state.note, /--allow-side-effects/, 'the sheet swap needs the flag, and the note says so');
  }
});

test('the Drunken Broster layer reaches the held-item gun sheet through before/after', async () => {
  const layerPath = path.join(path.dirname(DEFAULT_STATES_PATH), 'drunken-broster.json');
  const { states, errors } = validateStates(JSON.parse(await fs.readFile(layerPath, 'utf-8')));

  assert.deepEqual(errors, []);
  const held = states.find((state) => state.name === 'running_holding_item');
  assert.ok(held, 'the layer carries the held-item running state');

  assert.deepEqual(held.before, ['SwitchToHeldItem'], 'the swap is a method call, not a field pin');
  assert.deepEqual(held.after, ['ClearHeldItem'], 'and it is undone when the state ends');
  assert.deepEqual(held.expectGun, { row: 8, cols: [0, 7] }, 'the gun sheet is the point of the state');
  assert.equal(held.requires.holdingItem, false, 'it skips rather than clearing an item the bro already holds');
  assert.equal(held.insert_before, 'special_new', 'it runs before the special hands the bro a bottle');
  assert.deepEqual(held.expect, { sheet: 'main', row: 2, cols: [0, 7] }, 'the body cells are the base running ones');
  assert.deepEqual(held.step, { field: 'frame', values: [0, 1, 2, 3, 4, 5, 6, 7] });
  assert.equal(held.setup.actionState, 'Running');
  assert.equal(held.setup.gunFrame, 0, 'SetGunSprite only runs from the running frames while gunFrame <= 0');
  assert.notEqual(held.setup.chosenItem, 'ExplosiveBarrel', 'a barrel arms a timer the sweep would run down');
  assert.match(held.note, /melee-sheet row 8, columns 0-7/, 'the gun cells are recorded in the note');
  assert.match(held.note, /DrunkenBroster\.cs:2751-2766/, 'the note names the source lines');
  assert.match(held.note, /TestVanDammeAnim\.cs:4075-4078/, 'the Running arm, not the Idle one');
});

test('the Drunken Broster layer sweeps the held-item state before the bro picks a bottle up', async () => {
  const layerPath = path.join(path.dirname(DEFAULT_STATES_PATH), 'drunken-broster.json');
  const merged = await loadStates([DEFAULT_STATES_PATH, layerPath]);
  const names = merged.map((state) => state.name);

  assert.ok(
    names.indexOf('running_holding_item') < names.indexOf('special_new'),
    'BecomeDrunk leaves the bro holding a bottle that BecomeSober never puts down',
  );
});

test('the Drunken Broster layer replaces the base special_new when layered after it', async () => {
  const layerPath = path.join(path.dirname(DEFAULT_STATES_PATH), 'drunken-broster.json');
  const merged = await loadStates([DEFAULT_STATES_PATH, layerPath]);

  const restated = merged.filter((state) => state.name === 'special_new');
  assert.equal(restated.length, 1, 'the name appears once');
  assert.equal(restated[0].step.field, 'usingSpecialFrame', 'the layer won');
  assert.ok(merged.some((state) => state.name === 'special_new_sober'), 'its new state is appended');
  assert.ok(merged.some((state) => state.name === 'idle'), 'the rest of the base list survives');
});

test('validateStates rejects a step count that disagrees with the expected span', () => {
  const { errors } = validateStates([
    { name: 'too_few', step: { values: [0, 1] }, expect: { sheet: 'main', row: 2, cols: [0, 7] } },
    { name: 'too_many', step: { values: [0, 1, 2] }, expect: { sheet: 'main', row: 2, cols: [0, 1] } },
    { name: 'backwards', step: { values: [0] }, expect: { sheet: 'main', row: 2, cols: [7, 0] } },
    { name: 'exact', step: { values: [0, 1] }, expect: { sheet: 'main', row: 2, cols: [4, 5] } },
    { name: 'no_expect', step: { values: [0, 1] } },
  ]);

  assert.equal(errors.length, 3);
  assert.match(errors[0], /^too_few: 2 step value\(s\) for expect columns 0-7 \(8 cells\)/);
  assert.match(errors[1], /^too_many: 3 step value\(s\) for expect columns 0-1 \(2 cells\)/);
  assert.match(errors[2], /^backwards: expect\.cols must be \[from, to\]/);
});

test('loadStates refuses a malformed layer before the game is touched', async (t) => {
  const dir = await tempDir(t);
  const layerPath = path.join(dir, 'layer.json');
  await fs.writeFile(layerPath, JSON.stringify([
    { name: 'special_new', step: { field: 'usingSpecialFrame', values: [0, 1] }, expect: { row: 8, cols: [0, 7] } },
  ]));

  await assert.rejects(
    loadStates([DEFAULT_STATES_PATH, layerPath]),
    (err) => err instanceof UsageError
      && err.message.includes(layerPath)
      && /special_new: 2 step value\(s\) for expect columns 0-7/.test(err.message),
  );
});

test('buildReport counts an unwalkable expectation as a mismatch, not as no expectation', () => {
  const states = [{
    name: 'broken_span',
    step: { field: 'frame', values: [0, 1] },
    expect: { sheet: 'main', row: 2, cols: [0, 7] },
  }];
  const capture = {
    bro: { type: 'Rambro' },
    errors: [],
    states: [{
      name: 'broken_span',
      skipped: null,
      frames: [{ body: { row: 2, col: 0 } }, { body: { row: 2, col: 1 } }],
    }],
  };

  const { text: report } = buildReport({ capture, states, outDir: '/tmp/shots', options: {} });

  assert.match(report, /mismatches against the state list: 1/);
  assert.match(report, /broken_span \| 2 \|.*✗ \|/);
});

test('buildReport still reports no verdict for a state with no expectation at all', () => {
  const { text: report } = buildReport({
    capture: {
      bro: { type: 'Rambro' },
      errors: [],
      states: [{ name: 'freeform', skipped: null, frames: [{ body: { row: 2, col: 0 } }] }],
    },
    states: [{ name: 'freeform', step: { field: 'frame', values: [0] } }],
    outDir: '/tmp/shots',
    options: {},
  });

  assert.match(report, /mismatches against the state list: 0/);
  assert.match(report, /\| freeform \| 1 \| main row 2 cols 0 \| — \| — \|/);
});

// --- the tool ------------------------------------------------------------------------------------

// Stands a stub game up and hands the server's own client to it. The handler answers with success
// for anything the test does not answer itself.
async function toolStub(t, answer) {
  const seen = [];
  const stub = await startStubServer((request, socket) => {
    seen.push(request);
    if (answer && answer(request, socket) === true) return;
    reply(socket, request.id, { success: true });
  });
  t.after(async () => {
    await stub.close();
    process.env.UNITY_INSPECTOR_PORT = NO_LISTENER_PORT;
  });
  pointServerAt(stub.port);
  return { stub, seen, methods: () => seen.map((request) => request.method) };
}

async function toolNamed(name) {
  const tools = await buildToolList();
  const tool = tools.find((entry) => entry.name === name);
  assert.ok(tool, `no ${name} tool in the tool list`);
  return tool;
}

test('the capture script lives outside the script directories, so nothing lists it as a script', async () => {
  assert.ok(path.relative(SCRIPTS_DIR, SCRIPT_PATH).startsWith('..'), 'the script is not under scripts/');
  assert.ok(path.relative(CSHARP_SCRIPTS_DIR, SCRIPT_PATH).startsWith('..'), 'the script is not under scripts/csharp/');
  const { scripts } = await listCSharpScripts();
  assert.ok(!scripts.some((script) => script.file === 'animation-capture.cs'), 'list_scripts does not list it');
});

test('the capture_animations schema carries every argument and the bounds the sweep enforces', async () => {
  const { description, inputSchema } = await toolNamed('capture_animations');
  const properties = inputSchema.properties;

  assert.deepEqual(inputSchema.required, ['out'], 'only the output directory has no sensible default');
  assert.deepEqual(
    Object.keys(properties).sort(),
    ['allowSideEffects', 'bro', 'box', 'gameOut', 'includeLethal', 'level', 'out', 'player', 'settle',
      'states', 'swapSettle', 'swapTimeout', 'timeout'].sort(),
  );

  assert.equal(properties.out.type, 'string');
  assert.equal(properties.gameOut.type, 'string');
  assert.equal(properties.bro.type, 'string');
  assert.equal(properties.level.type, 'string');
  assert.deepEqual(properties.states.type, ['array', 'string'], 'one layer may be given as a bare string');
  assert.equal(properties.states.items.type, 'string');
  assert.equal(properties.settle.minimum, 0, 'zero opts a settle out');
  assert.equal(properties.swapSettle.minimum, 0);
  assert.equal(properties.swapTimeout.minimum, 1);
  assert.equal(properties.timeout.minimum, 1);
  assert.equal(properties.box.minimum, 1);
  assert.equal(properties.player.type, 'integer');
  assert.equal(properties.player.minimum, 0);
  assert.equal(properties.player.maximum, 3);
  assert.equal(properties.includeLethal.type, 'boolean');
  assert.equal(properties.allowSideEffects.type, 'boolean');

  // The defaults the description promises are the ones the library holds
  assert.match(description, new RegExp(`default ${DEFAULT_SETTLE_MS / 1000}`));
  assert.match(description, new RegExp(`default ${DEFAULT_SWAP_SETTLE_MS / 1000}`));
  assert.match(description, new RegExp(`default ${DEFAULT_SWAP_TIMEOUT_MS / 1000}`));
  assert.match(description, new RegExp(`default ${DEFAULT_TIMEOUT_MS / 1000}`));
  assert.match(description, /about 80s without level.*about 140s with it/, 'the caller is told what it is waiting for');
  assert.match(description, /read them off disk/, 'and that the files land whether it waits or not');
});

test('capture_animations refuses an out that is missing, relative or not a directory', async (t) => {
  const dir = await tempDir(t);

  assert.match(textOf(await callCapture({})), /out is required/);
  assert.match(textOf(await callCapture({ out: '  ' })), /out is required/);
  assert.match(textOf(await callCapture({ out: 'shots/out' })), /out must be an absolute path/);

  const file = path.join(dir, 'a-file');
  await fs.writeFile(file, '');
  assert.match(textOf(await callCapture({ out: file })), /out is not a directory/);

  for (const response of [await callCapture({}), await callCapture({ out: 'shots/out' })]) {
    assert.equal(response.isError, true);
  }
});

test('capture_animations only clears an out directory it wrote before', async (t) => {
  const dir = await tempDir(t);
  const populated = path.join(dir, 'someones-pictures');
  await fs.mkdir(populated);
  await fs.writeFile(path.join(populated, 'holiday.png'), '');

  const refusal = textOf(await callCapture({ out: populated }));
  assert.match(refusal, /already holds files and no states\.json/);
  assert.match(refusal, /deletes every \.png/, 'and says why that matters');

  // The mark an earlier sweep leaves is what licenses the clear
  await fs.writeFile(path.join(populated, STATES_COPY_NAME), '{"states":[]}');
  assert.doesNotMatch(textOf(await callCapture({ out: populated, timeout: 1 })), /already holds files/);

  // As does an empty directory, and one that is not there at all
  const empty = path.join(dir, 'empty');
  await fs.mkdir(empty);
  assert.doesNotMatch(textOf(await callCapture({ out: empty, timeout: 1 })), /already holds files/);
  assert.doesNotMatch(textOf(await callCapture({ out: path.join(dir, 'fresh'), timeout: 1 })), /already holds files/);
});

test('capture_animations resolves a relative states name under the state-list directory', async (t) => {
  const dir = await tempDir(t);
  const outDir = path.join(dir, 'out');

  const { seen } = await toolStub(t, (request, socket) => {
    if (request.method === 'game_state') return false;
    if (request.method === 'execute_script') {
      writeNow(path.join(outDir, 'capture.json'), JSON.stringify({ bro: {}, states: [] }));
      writeNow(path.join(outDir, 'done'), '');
    }
    return false;
  });

  const response = await callCapture({ out: outDir, states: 'base-states', timeout: 5 });
  assert.ok(!response.isError, textOf(response));

  // The bundled list is what a bare name reaches, and the sweep copies the merged result out
  const bundled = partitionLethal(await loadStates([DEFAULT_STATES_PATH]), false).states;
  const copied = JSON.parse(await fs.readFile(path.join(outDir, STATES_COPY_NAME), 'utf-8'));
  assert.deepEqual(copied.states.map((state) => state.name), bundled.map((state) => state.name));
  assert.ok(bundled.length > 0);
  assert.ok(seen.some((request) => request.method === 'execute_script'));
});

test('capture_animations refuses a states path that escapes the state-list directory', async (t) => {
  const out = path.join(await tempDir(t), 'out');

  for (const escaping of ['../animation-capture', '../../package.json', 'nested/../../secrets']) {
    const text = textOf(await callCapture({ out, states: escaping }));
    assert.match(text, /must stay inside/, escaping);
    assert.ok(text.includes(CAPTURE_STATES_DIR), 'the refusal names the directory a relative name resolves under');
  }

  // An absolute path is the way out of it, not a traversal
  assert.doesNotMatch(
    textOf(await callCapture({ out, states: '/nowhere/states.json' })),
    /must stay inside/,
  );
});

test('capture_animations surfaces the level, player and seconds arguments it cannot parse', async (t) => {
  const dir = await tempDir(t);
  const out = path.join(dir, 'out');

  assert.match(textOf(await callCapture({ out, level: '1' })), /level must be CAMPAIGN:LEVEL/);
  assert.match(textOf(await callCapture({ out, level: 'first:0' })), /level must be CAMPAIGN:LEVEL/);
  assert.match(textOf(await callCapture({ out, player: 9 })), /player must be an integer/);
  assert.match(textOf(await callCapture({ out, player: 1.5 })), /player must be an integer/);
  assert.match(textOf(await callCapture({ out, timeout: 0 })), /timeout must be a number >= 1/);
  assert.match(textOf(await callCapture({ out, swapTimeout: 'soon' })), /swapTimeout must be a number >= 1/);
  assert.match(textOf(await callCapture({ out, level: '1:0', settle: -1 })), /settle must be a number >= 0/);
  // Checked even where the wait it follows was never asked for, rather than silently discarded
  assert.match(textOf(await callCapture({ out, settle: 'soon' })), /settle must be a number >= 0/);
  assert.match(textOf(await callCapture({ out, swapSettle: -2 })), /swapSettle must be a number >= 0/);
  assert.match(textOf(await callCapture({ out, box: 0 })), /box must be a number >= 1/);
});

test('capture_animations sweeps the stub game and answers with the report and its paths', { timeout: 30000 }, async (t) => {
  const dir = await tempDir(t);
  const outDir = path.join(dir, 'out');
  const statesPath = path.join(dir, 'input-states.json');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));

  const slot = swappingSlot(AMERIBRO_OBJECT, RAMBRO_OBJECT);
  const { seen, methods } = await toolStub(t, (request, socket) => {
    slot.onRequest(request.method);
    if (request.method === 'game_state') {
      reply(socket, request.id, slot.reply());
      return true;
    }
    if (request.method === 'execute_script') {
      writeNow(path.join(outDir, 'capture.json'), JSON.stringify(fixtureCapture));
      writeNow(path.join(outDir, 'done'), '');
    }
    return false;
  });

  const response = await callCapture({
    out: outDir,
    bro: 'Rambro',
    states: [statesPath],
    swapSettle: 0,
    timeout: 5,
  });
  assert.ok(!response.isError, textOf(response));
  const payload = JSON.parse(textOf(response));

  assert.deepEqual(methods(), [
    'ping', 'game_state', 'swap_bro', 'game_state', 'execute_script', 'unload_script', 'set_game_speed',
  ]);
  assert.equal(seen.find((request) => request.method === 'execute_script').params.name, SCRIPT_NAME);

  // A cell mismatch is a finding, not a failed run: only a sentinel short of done or a state that
  // errored inside the sweep makes it one
  assert.equal(payload.success, true);
  assert.equal(payload.status, 'done');
  assert.equal(payload.message, null, 'a finished sweep has nothing to say beyond its report');
  assert.match(payload.report, /# Animation capture/);
  assert.equal(
    `${payload.report}\n`,
    await fs.readFile(path.join(outDir, 'report.md'), 'utf-8'),
    'the reply carries the same text report.md holds',
  );
  assert.deepEqual(payload.paths, {
    out: outDir,
    report: path.join(outDir, 'report.md'),
    capture: path.join(outDir, 'capture.json'),
    states: path.join(outDir, STATES_COPY_NAME),
  });
  assert.deepEqual(payload.summary, { captured: 2, skipped: 1, excluded: 0, mismatches: 1, errors: 0 });
  assert.deepEqual(payload.stateErrors, []);
  assert.equal(payload.swap.requested, 'Rambro');
  assert.equal(payload.swap.alreadyHeld, false);
  assert.equal(payload.swap.slot.broName, RAMBRO_OBJECT);
  assert.equal(payload.logTail, null);
});

test('capture_animations reports no capture file when the game wrote none', { timeout: 30000 }, async (t) => {
  const dir = await tempDir(t);
  const outDir = path.join(dir, 'out');
  const statesPath = path.join(dir, 'input-states.json');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));

  await toolStub(t, (request) => {
    if (request.method === 'execute_script') writeNow(path.join(outDir, 'error'), 'no character in slot 0');
    return false;
  });

  const payload = JSON.parse(textOf(await callCapture({ out: outDir, states: [statesPath], timeout: 5 })));
  assert.equal(payload.success, false);
  assert.equal(payload.status, 'error');
  assert.equal(payload.message, 'no character in slot 0');
  assert.equal(payload.paths.capture, null, 'the report is still written; the capture never was');
  assert.equal(payload.swap, null, 'no bro was asked for');
  assert.match(payload.report, /# Animation capture/);
});

test('a sweep in progress refuses a second sweep and a launch, and releases them when it throws', { timeout: 40000 }, async (t) => {
  const dir = await tempDir(t);
  const outDir = path.join(dir, 'out');
  const statesPath = path.join(dir, 'input-states.json');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));

  let sweeping;
  const started = new Promise((resolve) => { sweeping = resolve; });
  await toolStub(t, (request) => {
    if (request.method === 'execute_script') sweeping();
    return false;
  });

  const sweep = callCapture({ out: outDir, states: [statesPath], timeout: 20 });
  await started;
  // execute_script is answered after the stub's callback returns, so give the sweep the tick it
  // needs to reach the sentinel wait
  await new Promise((resolve) => setTimeout(resolve, 100));

  const second = textOf(await callCapture({ out: path.join(dir, 'other'), timeout: 5 }));
  assert.match(second, /capture_animations sweep into/);
  assert.ok(second.includes(outDir), 'the refusal names the sweep already running');
  assert.match(second, /of its budget left/);
  assert.match(second, /stop_game to end it early/);

  const launch = textOf(await handleToolCall({
    params: { name: 'launch_game', arguments: { steam: true, vanilla: true } },
  }));
  assert.match(launch, /capture_animations sweep into/);
  assert.doesNotMatch(launch, /it disconnects the client/, 'a sweep does not drop the socket; it holds the game');

  const wait = textOf(await handleToolCall({ params: { name: 'wait_for_game', arguments: { timeout: 1 } } }));
  assert.match(wait, /capture_animations sweep into/);

  // The sweep has no sentinel to find and no script the stub could fail: end it by hand
  writeNow(path.join(outDir, 'error'), 'ended by the test');
  const payload = JSON.parse(textOf(await sweep));
  assert.equal(payload.status, 'error');

  const afterwards = textOf(await handleToolCall({
    params: { name: 'launch_game', arguments: { steam: true, vanilla: true } },
  }));
  assert.doesNotMatch(afterwards, /capture_animations sweep into/, 'the guard is released with the sweep');
});

test('a sweep that throws releases the guard too', { timeout: 30000 }, async (t) => {
  const dir = await tempDir(t);
  const outDir = path.join(dir, 'out');

  await toolStub(t, (request, socket) => {
    if (request.method === 'execute_script') {
      reply(socket, request.id, { success: false, error: 'Compilation failed' });
      return true;
    }
    return false;
  });

  const failed = textOf(await callCapture({ out: outDir, timeout: 5 }));
  assert.match(failed, /Compilation failed/);

  const launch = textOf(await handleToolCall({
    params: { name: 'launch_game', arguments: { steam: true, vanilla: true } },
  }));
  assert.doesNotMatch(launch, /capture_animations sweep into/);
});

test('a game that stops mid-sweep ends the sweep instead of sitting out the timeout', { timeout: 20000 }, async (t) => {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'input-states.json');
  const outDir = path.join(dir, 'out');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));

  const seen = [];
  const stub = await startStubServer((request, socket) => {
    seen.push(request.method);
    reply(socket, request.id, { success: true });
  });
  const client = new UnityInspectorClient({ host: '127.0.0.1', port: stub.port });
  t.after(async () => { client.disconnect(); await stub.close(); });

  // Alive for the first look, gone for the second: the sweep must not wait out its whole budget for
  // a sentinel a stopped game will never write
  let looks = 0;
  const result = await runCapture(
    { statesPaths: [statesPath], out: outDir, gameOut: outDir, timeoutMs: 60000, player: 0 },
    client,
    { pollMs: 5, isRunning: async () => ++looks < 2 },
  );

  assert.equal(result.outcome.status, 'game-gone');
  assert.match(result.outcome.message, /the game stopped while the sweep was running/);
  assert.deepEqual(seen, ['ping', 'execute_script'], 'the teardown is not sent to a game that is gone');
  assert.match(result.report, /# Animation capture/, 'and the report is still written');
});

test('a sweep is not declared gone against a game process detection never saw', { timeout: 20000 }, async (t) => {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'input-states.json');
  const outDir = path.join(dir, 'out');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));

  const stub = await startStubServer((request, socket) => {
    if (request.method === 'execute_script') writeNow(path.join(outDir, 'done'), '');
    reply(socket, request.id, { success: true });
  });
  const client = new UnityInspectorClient({ host: '127.0.0.1', port: stub.port });
  t.after(async () => { client.disconnect(); await stub.close(); });

  for (const answer of [false, null]) {
    const result = await runCapture(
      { statesPaths: [statesPath], out: outDir, gameOut: outDir, timeoutMs: 5000, player: 0 },
      client,
      { pollMs: 5, isRunning: async () => answer },
    );
    assert.equal(result.outcome.status, 'done', `isRunning() === ${answer} ended the sweep`);
  }
});

test('shutdownServer unfreezes the game before it exits', { timeout: 30000 }, async (t) => {
  const dir = await tempDir(t);
  const outDir = path.join(dir, 'out');
  const statesPath = path.join(dir, 'input-states.json');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));

  let sweeping;
  const started = new Promise((resolve) => { sweeping = resolve; });
  const { methods } = await toolStub(t, (request) => {
    if (request.method === 'execute_script') sweeping();
    return false;
  });

  const sweep = callCapture({ out: outDir, states: [statesPath], timeout: 20 });
  await started;
  await new Promise((resolve) => setTimeout(resolve, 100));

  const exits = [];
  let seenAtExit = null;
  await shutdownServer('SIGTERM', {
    exit: (code) => {
      exits.push(code);
      seenAtExit = methods();
    },
  });

  assert.deepEqual(exits, [0]);
  assert.deepEqual(
    seenAtExit,
    ['ping', 'execute_script', 'unload_script', 'set_game_speed'],
    'the script is unloaded and the clock restored before the process goes',
  );

  writeNow(path.join(outDir, 'done'), '');
  await sweep;
});

import { NO_LISTENER_PORT } from './support/session.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CAPTURE_STATES_DIR,
  CLAIM_SLACK_MS,
  CUTSCENE_REPRESS_MS,
  DEFAULT_BOX,
  DEFAULT_SETTLE_MS,
  DEFAULT_STATES_PATH,
  SCRIPT_PATH,
  DEFAULT_SWAP_SETTLE_MS,
  DEFAULT_SWAP_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  LIVE_SWEEP_SLOT,
  claimLeaseMs,
  claimSweep,
  SCRIPT_NAME,
  STATES_COPY_NAME,
  OUT_MARKER,
  OUT_MARKER_TEXT,
  UsageError,
  buildReport,
  captureLogTail,
  cellSequence,
  describeCells,
  describeExpectation,
  describeFailure,
  describeSlot,
  dismissCutscene,
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
  swapLanded,
  validateStates,
  waitForLevel,
  waitForSentinel,
  waitForSwap,
  GameGoneError,
  carriedGunFrames,
  confirmBro,
  describeLevelChanges,
  isAbsoluteGamePath,
  selectOnly,
  stripCollisions,
  sweepableProblem,
  teardownGame,
  waitForSweepable,
} from '../lib/animation-capture.js';
import { UnityInspectorClient, commandTimeout } from '../lib/unity-client.js';
import { CSHARP_SCRIPTS_DIR, SCRIPTS_DIR, listCSharpScripts } from '../lib/script-library.js';
import { startStubServer, reply } from './support/stub-server.js';
import { fakeProcReader } from './support/fake-proc.js';
import { LINUX_GAME_COMM, setKillSignaller, setProcReader } from '../lib/game-process.js';

const UNPLAYED_STATES_PATH = path.join(path.dirname(DEFAULT_STATES_PATH), 'unplayed-states.json');

// session.js leaves UNITY_INSPECTOR_PORT on a port with no listener: a live game would leave the
// module-level client's socket open and hang the run. Every handleToolCall test points it at its own
// stub before the call, since the module client re-reads the variable on every pointClientAtTarget().

const { CAPTURE_REPLY_STATE_ERRORS, SHUTDOWN_TEARDOWN_BUDGET_MS, buildToolList, configureLaunchTiming, handleToolCall, shutdownServer, unityClient } = await import('../index.js');

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
const noLevel = { scene: 'Intro', isInGame: false, players: [] };
const spawning = { scene: 'Test Evan2', isInGame: true, levelIndex: 0, players: [{ playerIndex: 0, broName: null, isAlive: false }] };
const spawned = { scene: 'Test Evan2', isInGame: true, levelIndex: 0, players: [{ playerIndex: 0, broName: 'Rambro(Clone)', isAlive: true }] };

// The GameObject names game_state really reports. None of them is the name --bro takes: Swap Bros
// Mod's table calls the first one "Rambro".
const RAMBRO_OBJECT = 'Rambo(Clone) [local]';
const DRUNKEN_OBJECT = 'BM_Drunken Broster(Clone) [local]';
const AMERIBRO_OBJECT = 'BM_Captain Ameribro(Clone) [local]';

const inLevel = { scene: 'Test Evan2', isInGame: true, levelFinished: false, pauseState: 'UnPaused', levelIndex: 0, timeScale: 1 };

const slotState = (broName, { player = 0, isAlive = true, className = 'TestVanDammeAnim', ...extra } = {}) => ({
  ...inLevel,
  ...extra,
  players: broName === null
    ? []
    : [{ playerIndex: player, broName, className, isAlive, state: isAlive ? 'alive' : 'dead', piloting: null }],
});

function startGameStub(handler, options) {
  let swappedTo = null;
  return startStubServer((request, socket) => {
    if (request.method === 'swap_bro') swappedTo = request.params.broName;
    if (request.method === 'list_bros') {
      reply(socket, request.id, { success: true, currentBro: swappedTo });
      return;
    }
    if (request.method !== 'game_state') {
      handler(request, socket);
      return;
    }
    const proxy = {
      write: (text) => {
        const message = JSON.parse(text);
        if (message.result && !('players' in message.result) && !('error' in message.result)) {
          message.result = slotState(RAMBRO_OBJECT, { player: 0 });
        }
        return socket.write(`${JSON.stringify(message)}\n`);
      },
      end: (...rest) => socket.end(...rest),
      destroy: (...rest) => socket.destroy(...rest),
    };
    handler(request, proxy);
  }, options);
}

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

  const secondOnly = { ...spawned, players: [{ playerIndex: 1, broName: 'Rambro(Clone)', isAlive: true }] };
  assert.equal(levelIsReady(secondOnly, 1), true, 'the list is compacted, so position is not the index');
  assert.equal(levelIsReady(secondOnly, 0), false, 'and player 0 is simply not in it');

  const dead = { ...spawned, players: [{ playerIndex: 0, broName: 'Rambro(Clone)', isAlive: false }] };
  assert.equal(levelIsReady(dead, 0), false, 'a dead bro is no use to swap_bro');

  assert.equal(levelIsReady({ scene: 'Test Evan2', isInGame: true }, 0), false, 'a payload with no players array is not readiness');
  assert.equal(levelIsReady(null, 0), false);
});

test('levelIsReady never takes the scene go_to_level is tearing down for the level it asked for', () => {
  assert.equal(levelIsReady({ ...spawned, isInGame: false }, 0, 0), false, 'the old scene, its bro alive');
  assert.equal(levelIsReady({ ...spawned, levelIndex: 3 }, 0, 0), false, 'another level of the campaign');
  assert.equal(levelIsReady({ ...spawned, levelFinished: true }, 0, 0), false, 'a level already won');
  assert.equal(levelIsReady({ ...spawned, levelIndex: 0 }, 0, 0), true);
  assert.equal(levelIsReady({ ...spawned, levelIndex: 3 }, 0), true, 'with no level asked for, any level in play');
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

test('dismissCutscene reads the game once when no cutscene is up, and shrugs off a game_state that fails', async () => {
  const asked = [];
  const state = { scene: 'Level', pauseState: 'UnPaused', players: [beforeSwap] };
  const ok = { sendCommand: async (method, params) => { asked.push({ method, params }); return state; } };
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };
  assert.deepEqual(await dismissCutscene({ client: ok, timeoutMs: 5000, settleMs: 3000, sleep, cutscene: {} }), state);
  assert.deepEqual(asked, [{ method: 'game_state', params: {} }], 'once, not a poll');
  assert.deepEqual(sleeps, [], 'no settle without a cutscene');

  const broken = { sendCommand: async () => { throw new Error('Game is not running.'); } };
  assert.equal(await dismissCutscene({ client: broken, timeoutMs: 5000, sleep, cutscene: {} }), null, 'read as an empty slot');
});

test('dismissCutscene presses past a cutscene, settles once it clears, and names the presses when it never clears', async () => {
  let clock = 0;
  let pause = 'CutscenePause';
  const sent = [];
  let clearsOn = 2;
  const client = {
    sendCommand: async (method, params) => {
      sent.push(method);
      if (method === 'game_state') return slotState(RAMBRO_OBJECT, { player: 1, pauseState: pause });
      assert.deepEqual(params, { action: 'start', duration: 200, player: 1 });
      if (sent.filter((entry) => entry === 'simulate_input').length === clearsOn) pause = 'UnPaused';
      return { success: true, framesRead: 1 };
    },
  };
  const sleep = async (ms) => { sent.push(`sleep ${ms}`); clock += 500; };
  const waits = { client, player: 1, timeoutMs: 10000, settleMs: 1700, pollMs: 500, sleep, now: () => clock };

  const cutscene = {};
  const state = await dismissCutscene({ ...waits, cutscene });
  assert.equal(state.pauseState, 'UnPaused');
  assert.equal(cutscene.presses, 2, 'the first press ignored, the second sent once the cutscene outlasted it');
  assert.deepEqual(sent.slice(sent.lastIndexOf('simulate_input')), ['simulate_input', 'sleep 500', 'game_state', 'sleep 1700', 'game_state'],
    'the settle once it cleared, then a fresh look');
  assert.equal(sent.filter((entry) => entry === 'sleep 1700').length, 1);

  clock = 0;
  pause = 'CutscenePause';
  clearsOn = Infinity;
  sent.length = 0;
  await assert.rejects(
    dismissCutscene({ ...waits, cutscene: {} }),
    /nothing was swept: after 10s the game is paused \(CutscenePause\); start was pressed 4 times to dismiss a cutscene; last game_state:/,
  );
  assert.ok(!sent.includes('sleep 1700'));
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

  assert.equal(ready.scene, 'Test Evan2');
  assert.equal(asked.length, 3, 'it stops at the first ready state');
  assert.deepEqual(asked[0], { method: 'game_state', params: {} });
});

test('waitForLevel gives up with the last state it saw', async () => {
  const client = { sendCommand: async () => noLevel };
  let clock = 0;

  await assert.rejects(
    () => waitForLevel({ client, player: 0, timeoutMs: 30000, sleep: async () => { clock += 10000; }, now: () => clock }),
    (err) => /never reported a level in play with a live player in slot 0 after 30s/.test(err.message)
      && /scene=Intro players=0 live=0 playerIndex=\[\]/.test(err.message),
  );
});

test('waitForLevel names the indexes it did see when the wanted one never turns up', async () => {
  const client = {
    sendCommand: async () => ({
      scene: 'Level',
      isInGame: true,
      players: [
        { playerIndex: 0, broName: 'Rambro(Clone)', isAlive: true },
        { playerIndex: 2, broName: null, isAlive: false },
      ],
    }),
  };
  let clock = 0;

  await assert.rejects(
    () => waitForLevel({ client, player: 1, timeoutMs: 1000, sleep: async () => { clock += 1000; }, now: () => clock }),
    (err) => /never reported a level in play with a live player in slot 1/.test(err.message)
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
  assert.equal(ready.scene, 'Test Evan2');
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
  const states = [];
  for (const statesPath of [DEFAULT_STATES_PATH, UNPLAYED_STATES_PATH]) {
    states.push(...validateStates(JSON.parse(await fs.readFile(statesPath, 'utf-8'))).states);
  }

  for (const state of states) {
    if (state.unsupported) continue;
    assert.notEqual(expectedSequence(state), null, `${state.name}: its expect has a well-formed walk`);
    if (state.expectGun) assert.notEqual(expectedSequence(state, 'expectGun'), null, `${state.name}: and its expectGun`);
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

  assert.equal(errors.length, 4);
  assert.match(errors[0], /^no_lists: before must be a non-empty list of method names/);
  assert.match(errors[1], /^empty_list: after must be a non-empty list of method names/);
  assert.match(errors[2], /^blank_name: before must hold method names/);
  assert.match(errors[3], /^not_a_name: after must hold method names/);
});

test('validateStates takes before and after alone or together', () => {
  const { errors } = validateStates([
    { name: 'switch_only', before: ['SwitchToHeldItem'], step: { values: [0] } },
    { name: 'clear_only', after: ['ClearHeldItem'], step: { values: [0] } },
    { name: 'paired', before: ['SwitchToHeldItem'], after: ['ClearHeldItem'], step: { values: [0] } },
    { name: 'neither', step: { values: [0] } },
  ]);

  assert.deepEqual(errors, []);
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
  const stub = await startGameStub((request, socket) => {
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
    'ping', 'execute_code', 'game_state', 'swap_bro', 'game_state', 'game_state', 'execute_script', 'unload_script',
  ]);
  assert.deepEqual(seen[2].params, {}, 'the slot is read before the swap, to compare against');
  assert.deepEqual(seen[3].params, { broName: 'Rambro', playerNum: 1 }, 'a swap the roster allows needs no bypass');
  assert.deepEqual(seen[7].params, { name: SCRIPT_NAME });
  assert.ok(!seen.some((entry) => entry.method === 'set_game_speed'), 'an unload that went through restores the clock itself');

  const scriptArgs = seen[6].params.args;
  assert.equal(scriptArgs.outDir, 'Z:\\out');
  assert.equal(scriptArgs.statesFile, 'Z:\\out\\states.json', 'the state file is passed as the game sees it');
  assert.equal(scriptArgs.player, '1');
  assert.equal(seen[6].params.name, SCRIPT_NAME);
  assert.match(seen[6].params.source, /class AnimationCapture : MonoBehaviour/, 'the script source is sent, not a path');

  const copied = JSON.parse(await fs.readFile(path.join(outDir, STATES_COPY_NAME), 'utf-8'));
  assert.equal(copied.states.length, fixtureStates.length);

  const written = await fs.readFile(path.join(outDir, 'report.md'), 'utf-8');
  assert.equal(written, `${result.report}\n`);
});

function fakeSlot() {
  const literal = '("(?:[^"\\\\]|\\\\.)*")';
  const claimPattern = new RegExp(`!= ${literal} && .*new object\\[\\] \\{ ${literal}, ${literal}, UnityEngine\\.Time\\.realtimeSinceStartup \\+ ([\\d.]+)f \\}`, 's');
  const releasePattern = new RegExp(`\\(live\\[0\\] as string\\) == ${literal}`);
  const fake = { slot: null, now: 0, claims: [] };
  fake.answer = (request, socket) => {
    if (request.method === 'execute_script') {
      fake.slot = { live: request.params.args.outDir };
      return false;
    }
    if (request.method === 'unload_script') {
      if (fake.slot && fake.slot.live) fake.slot = null;
      return false;
    }
    if (request.method !== 'execute_code') return false;
    const code = request.params.code;
    const claim = claimPattern.exec(code);
    if (claim) {
      const [own, token, out, lease] = [JSON.parse(claim[1]), JSON.parse(claim[2]), JSON.parse(claim[3]), Number(claim[4])];
      const { slot } = fake;
      let held = null;
      if (slot && slot.live) held = slot.live;
      if (slot && slot.token && slot.token !== own && slot.leaseEnd > fake.now) held = slot.out;
      if (held === null) {
        fake.slot = { token, out, leaseEnd: fake.now + lease };
        fake.claims.push({ token, out, lease });
      }
      reply(socket, request.id, { success: true, resultSet: true, result: held });
      return true;
    }
    const release = releasePattern.exec(code);
    assert.ok(release, `execute_code the fake slot cannot read:\n${code}`);
    const mine = Boolean(fake.slot && fake.slot.token === JSON.parse(release[1]));
    if (mine) fake.slot = null;
    reply(socket, request.id, { success: true, resultSet: true, result: mine });
    return true;
  };
  return fake;
}

async function slotStub(t, fake, answer = null) {
  const seen = [];
  const stub = await startGameStub((request, socket) => {
    seen.push(request);
    if (answer && answer(request, socket) === true) return;
    if (fake.answer(request, socket) === true) return;
    if (request.method === 'execute_script') {
      writeNow(path.join(request.params.args.outDir, 'capture.json'), JSON.stringify(fixtureCapture));
      writeNow(path.join(request.params.args.outDir, 'done'), '');
    }
    reply(socket, request.id, { success: true });
  });
  const client = new UnityInspectorClient({ host: '127.0.0.1', port: stub.port });
  t.after(async () => { client.disconnect(); await stub.close(); });
  return { client, seen, methods: () => seen.map((request) => request.method) };
}

async function captureOptionsFor(t, extra = {}) {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'input-states.json');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));
  const out = path.join(dir, 'out');
  return { statesPaths: [statesPath], out, gameOut: out, timeoutMs: 5000, player: 0, ...extra };
}

test('a second claim while one is held is refused before anything changes the game', { timeout: 20000 }, async (t) => {
  const fake = fakeSlot();
  let levelUp = false;
  const { client, seen, methods } = await slotStub(t, fake, (request, socket) => {
    if (request.method === 'game_state' && !levelUp) {
      reply(socket, request.id, slotState(null));
      return true;
    }
    return false;
  });

  const first = await captureOptionsFor(t, { level: { campaignIndex: 1, levelIndex: 0 }, settleMs: 0 });
  const firstRun = runCapture(first, client, { pollMs: 5 });
  await until(() => methods().includes('go_to_level'));
  const before = seen.length;

  const second = await captureOptionsFor(t, { bro: 'Rambro', level: { campaignIndex: 1, levelIndex: 0 } });
  await assert.rejects(
    runCapture(second, client, { pollMs: 5 }),
    (err) => err.message.startsWith(`Another animation-capture sweep, into ${first.gameOut}, is running in this game: wait for it to finish. This sweep changed nothing.`),
  );
  const secondSent = seen.slice(before).filter((request) => request.method !== 'game_state').map((request) => request.method);
  assert.deepEqual(secondSent, ['ping', 'execute_code'], 'no level load, no swap, no release, no script');
  await assert.rejects(fs.access(second.out), 'the output directory is left alone');

  levelUp = true;
  assert.equal((await firstRun).outcome.status, 'done', 'the first run sweeps undisturbed');

  const script = await fs.readFile(SCRIPT_PATH, 'utf-8');
  assert.ok(script.includes(`LiveSlot = "${LIVE_SWEEP_SLOT}"`), 'the claim is made on the slot the script reads');
  assert.match(script, /string claim = ScriptContext\.GetArg\("claim", ""\);/);
});

test('a run claims the game for its setup, hands the claim to the script, and releases it when setup fails', { timeout: 20000 }, async (t) => {
  const fake = fakeSlot();
  let refuseLevel = true;
  let refuseScript = false;
  const { client, seen, methods } = await slotStub(t, fake, (request, socket) => {
    if (request.method === 'go_to_level' && refuseLevel) {
      reply(socket, request.id, { success: false, error: 'Campaign index 28 is out of range - valid indices are 0 to 25 (see list_campaigns)' });
      return true;
    }
    if (request.method === 'execute_script' && refuseScript) {
      reply(socket, request.id, { success: false, error: 'animation-capture startup failed: the game is paused (Paused)' });
      return true;
    }
    return false;
  });

  const failing = await captureOptionsFor(t, { level: { campaignIndex: 28, levelIndex: 0 } });
  await assert.rejects(runCapture(failing, client, { pollMs: 5 }), /Campaign index 28 is out of range/);
  assert.deepEqual(methods(), ['ping', 'execute_code', 'go_to_level', 'execute_code'], 'the claim, the refused load, the release');
  assert.match(seen[3].params.code, new RegExp(`== ${JSON.stringify(fake.claims[0].token)}`), 'the release names this run\'s own claim');
  assert.equal(fake.slot, null, 'the failed setup gave the game back');

  refuseScript = true;
  await assert.rejects(runCapture(await captureOptionsFor(t), client, { pollMs: 5 }), /the game is paused/);
  assert.equal(fake.slot, null, 'a script that refused to start gives the claim back too');

  refuseScript = false;
  const sweep = {};
  const options = await captureOptionsFor(t);
  const start = seen.length;
  const result = await runCapture(options, client, { pollMs: 5, sweep });
  assert.equal(result.outcome.status, 'done');
  assert.deepEqual(methods().slice(start), ['ping', 'execute_code', 'game_state', 'execute_script', 'unload_script'], 'no release once the script holds the slot');
  const claim = fake.claims[fake.claims.length - 1];
  assert.equal(seen.find((request, index) => index >= start && request.method === 'execute_script').params.args.claim, claim.token, 'the script is told the claim it may replace');
  assert.equal(claim.out, options.gameOut);
  assert.ok(claim.lease * 1000 >= claimLeaseMs(options) - 100, 'the lease covers the setup budget');
  assert.equal(sweep.claim, null, 'the shutdown has no claim left to release');
});

test('an expired claim is taken over', { timeout: 20000 }, async (t) => {
  const fake = fakeSlot();
  const { client } = await slotStub(t, fake);

  assert.equal(await claimSweep(client, { token: 'stale', out: '/tmp/killed-server', leaseMs: 1000 }), null);
  fake.now = 0.5;
  await assert.rejects(runCapture(await captureOptionsFor(t), client, { pollMs: 5 }), /into \/tmp\/killed-server/, 'refused inside the lease');

  fake.now = 2;
  const result = await runCapture(await captureOptionsFor(t), client, { pollMs: 5 });
  assert.equal(result.outcome.status, 'done', 'past its lease the dead server\'s claim is taken over');
  assert.notEqual(fake.claims[fake.claims.length - 1].token, 'stale');
});

test('the lease covers every wait and command of the setup it asks for', () => {
  const poll = commandTimeout('game_state');
  const press = commandTimeout('simulate_input', { action: 'start', duration: 200 });
  const script = commandTimeout('execute_script');
  const swap = poll + 2 * commandTimeout('swap_bro') + commandTimeout('list_bros') + 15000 + 700;
  const readinessPress = poll + 2 * press;
  const dismissal = 60000 + 2 * poll + press;

  assert.equal(claimLeaseMs({ timeoutMs: 60000 }) - CLAIM_SLACK_MS, 60000 + poll + script + readinessPress + DEFAULT_SETTLE_MS,
    'the readiness wait with a press and its settle, then the script');
  assert.equal(
    claimLeaseMs({ timeoutMs: 60000, level: { campaignIndex: 0, levelIndex: 1 }, settleMs: 1700, bro: 'Rambro', swapTimeoutMs: 15000, swapSettleMs: 700 }) - CLAIM_SLACK_MS,
    60000 + poll + script + commandTimeout('go_to_level') + dismissal + 60000 + poll + 1700 + dismissal + 1700 + swap,
    'the level, a cutscene go_to_level named, its wait and settle, a later cutscene and the settle again, the swap, and a readiness wait that presses nothing',
  );
  assert.equal(
    claimLeaseMs({ timeoutMs: 60000, bro: 'Rambro', swapTimeoutMs: 15000, swapSettleMs: 700 }) - CLAIM_SLACK_MS,
    60000 + poll + script + readinessPress + DEFAULT_SETTLE_MS + 700 + dismissal + DEFAULT_SETTLE_MS + swap,
    'a cutscene dismissed before the swap, and one at the readiness wait with both settles',
  );
});

test('a server stopped during setup releases its claim before it exits', { timeout: 30000 }, async (t) => {
  const fake = fakeSlot();
  const { methods } = await toolStub(t, (request, socket) => {
    if (fake.answer(request, socket) === true) return true;
    if (request.method === 'game_state') {
      reply(socket, request.id, { ...liveSlots, pauseState: 'Paused' });
      return true;
    }
    return false;
  });

  const sweep = callCapture({ out: path.join(await tempDir(t), 'out'), timeout: 2 });
  await until(() => methods().includes('game_state'));

  const exits = [];
  let seenAtExit = null;
  await shutdownServer('SIGTERM', { exit: (code) => { exits.push(code); seenAtExit = methods(); } });

  assert.deepEqual(exits, [0]);
  assert.deepEqual(seenAtExit.filter((method) => method !== 'game_state'), ['ping', 'execute_code', 'execute_code'], 'the claim and its release, no teardown of a script never sent');
  assert.equal(fake.slot, null);
  await sweep;
});

test('runCapture loads the level and waits for its player before swapping the bro', { timeout: 20000 }, async (t) => {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'input-states.json');
  const outDir = path.join(dir, 'out');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));

  const seen = [];
  let polls = 0;
  let swapped = false;
  const stub = await startGameStub((request, socket) => {
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
    'ping', 'execute_code', 'go_to_level', 'game_state', 'game_state', 'game_state', 'swap_bro', 'game_state',
    'game_state', 'execute_script', 'unload_script',
  ]);
  assert.deepEqual(seen[2].params, { campaignIndex: 1, levelIndex: 0 }, 'the same params the MCP tool sends');
});

test('runCapture settles between the level being ready and the bro swap', { timeout: 20000 }, async (t) => {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'input-states.json');
  const outDir = path.join(dir, 'out');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));

  const seen = [];
  const slot = swappingSlot(AMERIBRO_OBJECT, DRUNKEN_OBJECT);
  const stub = await startGameStub((request, socket) => {
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
    'ping', 'execute_code', 'go_to_level', 'game_state', 'game_state', 'swap_bro', 'game_state',
    'game_state', 'execute_script', 'unload_script',
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
  const stub = await startGameStub((request, socket) => {
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
    'ping', 'execute_code', 'game_state', 'swap_bro', 'game_state', 'game_state',
    'game_state', 'execute_script', 'unload_script',
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
  const stub = await startGameStub((request, socket) => {
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
    'ping', 'execute_code', 'game_state', 'swap_bro', 'game_state', 'game_state', 'execute_script', 'unload_script',
  ], 'the first live character in an empty slot is the swap');
});

test('runCapture takes the swap_bro reply as the change and only waits for liveness', { timeout: 20000 }, async (t) => {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'input-states.json');
  const outDir = path.join(dir, 'out');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));

  const seen = [];
  let polls = 0;
  const stub = await startGameStub((request, socket) => {
    seen.push(request.method);

    if (request.method === 'swap_bro') {
      // StateModifier.SwapBro reads the name back on the main thread, so the reply is the new one
      reply(socket, request.id, { success: true, broName: 'Drunken Broster', objectName: DRUNKEN_OBJECT, heroType: 'Rambro' });
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
    'ping', 'execute_code', 'game_state', 'swap_bro', 'game_state', 'game_state',
    'game_state', 'execute_script', 'unload_script',
  ], 'polled until alive, not until the name changed');
});

test('runCapture skips the poll when swap_bro reports the bro that was already there', { timeout: 20000 }, async (t) => {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'input-states.json');
  const outDir = path.join(dir, 'out');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));

  const seen = [];
  const stub = await startGameStub((request, socket) => {
    seen.push(request.method);

    if (request.method === 'swap_bro') {
      // The same name the snapshot saw: the slot already held this bro, so nothing changed
      reply(socket, request.id, { success: true, broName: 'Rambro', objectName: RAMBRO_OBJECT, heroType: 'Rambro' });
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
    'ping', 'execute_code', 'game_state', 'swap_bro', 'game_state', 'execute_script', 'unload_script',
  ], 'the pre-swap snapshot is the only game_state');
});

test('runCapture sweeps a locked custom bro the slot already holds', { timeout: 20000 }, async (t) => {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'input-states.json');
  const outDir = path.join(dir, 'out');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));

  const jasonObject = 'BM_Jason Brohees(Clone) [local]';
  const seen = [];
  const stub = await startGameStub((request, socket) => {
    seen.push({ method: request.method, params: request.params });

    if (request.method === 'swap_bro') {
      if (request.params.ignoreUnlocks === true) {
        reply(socket, request.id, { success: true, broName: 'Jason Brohees', objectName: jasonObject, heroType: 'Rambro' });
      } else {
        reply(socket, request.id, { success: false, error: "Cannot swap to 'Jason Brohees': it is locked", reason: 'unreachable' });
      }
      return;
    }
    if (request.method === 'game_state') {
      reply(socket, request.id, slotState(jasonObject));
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
      bro: 'Jason Brohees',
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
  assert.equal(result.swap.alreadyHeld, true);
  assert.deepEqual(seen.filter((entry) => entry.method === 'swap_bro').map((entry) => entry.params), [
    { broName: 'Jason Brohees', playerNum: 0 },
    { broName: 'Jason Brohees', playerNum: 0, ignoreUnlocks: true },
  ], 'the refused plain swap is retried once with the unlock bypass');
});

test('runCapture refuses to sweep when the slot never reports a different character', { timeout: 20000 }, async (t) => {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'input-states.json');
  const outDir = path.join(dir, 'out');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));

  const seen = [];
  const stub = await startGameStub((request, socket) => {
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
  const stub = await startGameStub((request, socket) => {
    seen.push(request.method);

    if (request.method === 'swap_bro') {
      // What the real mod sends: the swap took, and the reply names the object it left in the slot
      swapped = true;
      reply(socket, request.id, { success: true, broName: 'Drunken Broster', objectName: DRUNKEN_OBJECT, heroType: 'DrunkenBroster' });
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
    /isAlive=false 0s after swapping to "Drunken Broster": the swap never landed[\s\S]*last game_state: scene=Test Evan2/,
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
  const stub = await startGameStub((request, socket) => {
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
  const stub = await startGameStub((request, socket) => {
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
    'ping', 'execute_code', 'game_state', 'swap_bro', 'game_state', 'game_state', 'execute_script', 'unload_script',
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
  const stub = await startGameStub((request, socket) => {
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
    (err) => /never reported level index 0 in play with a live player in slot 0/.test(err.message)
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
  const stub = await startGameStub((request, socket) => {
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
  assert.deepEqual(seen, ['ping', 'execute_code', 'game_state', 'execute_script', 'unload_script']);
  assert.match(result.report, /0 captured/);
});

test('runCapture refuses a malformed state file before touching the game', { timeout: 20000 }, async (t) => {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'bad-states.json');
  await fs.writeFile(statesPath, JSON.stringify([{ name: 'broken' }]));

  const seen = [];
  const stub = await startGameStub((request, socket) => {
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

test('runCapture surfaces a refused bro swap as it was refused, bypassing unlocks only for an unreachable bro', { timeout: 20000 }, async (t) => {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'input-states.json');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));

  const swaps = [];
  const stub = await startGameStub((request, socket) => {
    if (request.method === 'swap_bro') {
      swaps.push(request.params);
      reply(socket, request.id, { success: false, error: "Bro 'Nobody' not found in any roster", reason: 'unknown-bro' });
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
    /swap_bro failed: Bro 'Nobody' not found in any roster/,
  );
  assert.deepEqual(swaps, [{ broName: 'Nobody', playerNum: 0 }], 'a refusal the bypass cannot change is not retried with it');
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
  assert.match(report, /- \*\*rolling\*\* — errored \(see Errors\)/, 'it also shows under skipped');
  assert.equal(report.split("unknown field 'rollingFrames'").length, 2, 'the message itself is printed once');
  assert.match(report, /1 captured, 1 skipped/);
});

test('buildReport counts a state with two errors as one errored state', () => {
  const states = [
    { name: 'special_new', step: { field: 'frame', values: [0] }, expect: { sheet: 'main', row: 2, cols: [0, 0] } },
    { name: 'idle', step: { field: 'frame', values: [0] }, expect: { sheet: 'main', row: 1, cols: [0, 0] } },
  ];
  const clock = "state 'special_new': the game set the clock to 0.35 while it ran, so the game moved between its frames";
  const nonFinite = "state 'special_new': x went non-finite on the frozen clock and was put back, so this state's frames are not to be trusted";
  const capture = {
    bro: { type: 'Rambro' },
    errors: [clock, nonFinite],
    states: [
      { name: 'special_new', skipped: null, clockDisturbed: 0.35, nonFinite: ['x'], frames: [{ step: 0, body: { row: 2, col: 0 } }] },
      { name: 'idle', skipped: null, frames: [{ step: 0, body: { row: 1, col: 0 } }] },
    ],
  };

  const { text: report, summary } = buildReport({ capture, states, outDir: '/tmp/shots', options: {} });

  assert.match(report, /- States that errored mid-sweep: 1\n/);
  assert.equal(summary.errors, 1);
  assert.match(report, /## Errors \(2\)/, 'both messages are still listed');
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
  assert.match(report, /- \*\*running_holding_item\*\* — errored \(see Errors\)/);
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
    { name: 'recoil', step: { values: [4, 3, 2, 1] }, expectGun: { row: 1, cols: [3, 0] } },
    { name: 'exact', step: { values: [0, 1] }, expect: { row: 2, cols: [0, 1] }, expectGun: { row: 8, cols: [0, 1] } },
  ]);

  assert.equal(errors.length, 2);
  assert.match(errors[0], /^short: 2 step value\(s\) for expectGun columns 0-7 \(8 cells\)/);
  assert.match(errors[1], /^backwards: 1 step value\(s\) for expectGun columns 7-0 \(8 cells\)/, 'a descending walk counts its cells too');
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

  const stub = await startGameStub((request, socket) => {
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

  const stub = await startGameStub((request, socket) => {
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
  const stub = await startGameStub((request, socket) => {
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

  assert.deepEqual(seen, ['ping', 'execute_code', 'game_state', 'execute_script', 'execute_code', 'unload_script'], 'the claim released, then the teardown');
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

test('the states the game never plays for a player are a layer of their own, not part of the default sweep', async () => {
  const unplayed = [
    'gesture_salute',
    'gesture_wave',
    'gesture_point',
    'gesture_thrust',
    'gesture_kneedrop',
    'gesture_shhh',
    'dancing',
  ];
  const baseNames = validateStates(JSON.parse(await fs.readFile(DEFAULT_STATES_PATH, 'utf-8'))).states.map(
    (state) => state.name,
  );
  const { states, errors } = validateStates(JSON.parse(await fs.readFile(UNPLAYED_STATES_PATH, 'utf-8')));

  assert.ok(baseNames.includes('gesture_flex'), 'Flex has an input path, so the default sweep keeps it');
  assert.deepEqual(baseNames.filter((name) => unplayed.includes(name)), []);
  assert.deepEqual(errors, []);
  assert.deepEqual(states.map((state) => state.name), unplayed);

  const merged = await loadStates([DEFAULT_STATES_PATH, UNPLAYED_STATES_PATH]);
  assert.deepEqual(merged.slice(-unplayed.length).map((state) => state.name), unplayed, 'layered, they append');
});

test('the bundled list marks the states that pin the bro dead', async () => {
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
    { name: 'death_grounded', lethal: true, lethalReason: 'pins the bro dead' },
  ];

  assert.deepEqual(partitionLethal(states, false), {
    states: [{ name: 'idle' }],
    excluded: [{ name: 'death_grounded', lethal: true, lethalReason: 'pins the bro dead' }],
  });
  assert.deepEqual(partitionLethal(states, true), { states, excluded: [] });
});

test('buildReport lists the excluded lethal states', () => {
  const { text: report } = buildReport({
    capture: { bro: { type: 'Rambro' }, errors: [], states: [] },
    states: [],
    outDir: '/tmp/shots',
    options: { excluded: [{ name: 'death_grounded', lethalReason: 'pins the bro dead' }] },
  });

  assert.match(report, /0 captured, 0 skipped, 1 excluded/);
  assert.match(report, /## Excluded \(1\)[\s\S]*death_grounded\*\* — pins the bro dead; set includeLethal: true/);
});

test('runCapture leaves lethal states out of the list it sends the game', { timeout: 20000 }, async (t) => {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'input-states.json');
  const outDir = path.join(dir, 'out');
  await fs.writeFile(statesPath, JSON.stringify({
    states: [
      ...fixtureStates,
      { name: 'death_grounded', lethal: true, lethalReason: 'pins the bro dead', step: { values: [0] } },
    ],
  }));

  const stub = await startGameStub((request, socket) => {
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
  assert.ok(sent.states.some((state) => state.name === 'death_grounded'), 'includeLethal sends it');
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

test('runCapture tails the game log when the sweep never finishes, from where the sweep started', { timeout: 20000 }, async (t) => {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'input-states.json');
  const logPath = path.join(dir, 'Player.log');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));
  await fs.writeFile(logPath, '[Script:animation-capture] a sweep from before this one\n');

  const stub = await startGameStub(async (request, socket) => {
    if (request.method === 'execute_script') {
      await fs.appendFile(logPath, [
        '[Info] unrelated',
        '[Script:animation-capture] animation-capture startup failed: player 0 has no character',
      ].join('\n'));
    }
    reply(socket, request.id, { success: true });
  });
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
  assert.equal(result.outcome.logTail.lines.length, 1, 'an earlier sweep\'s lines are not this one\'s');
  assert.ok(slept > 0);
});

test('runCapture passes box through to the script, and leaves it out when unset', { timeout: 20000 }, async (t) => {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'input-states.json');
  const outDir = path.join(dir, 'out');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));

  const seen = [];
  const stub = await startGameStub((request, socket) => {
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

  const statesCopyBox = async () => JSON.parse(await fs.readFile(path.join(outDir, STATES_COPY_NAME), 'utf-8')).params.box;

  await run({ box: 40 });
  assert.equal(seen.find((r) => r.method === 'execute_script').params.args.box, '40');
  assert.equal(await statesCopyBox(), 40);

  seen.length = 0;
  await run({ box: null });
  assert.equal('box' in seen.find((r) => r.method === 'execute_script').params.args, false);
  assert.equal(await statesCopyBox(), DEFAULT_BOX);
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
  assert.match(report, /- \*\*running\*\* — errored \(see Errors\)/);
  assert.match(report, /## Errors[\s\S]*state 'running' blank capture/);
  assert.doesNotMatch(report, /\| running \| 2 \|/, 'and it is out of the captured table');
});

const noContribution = "state 'running' frame 1: the character's renderers contributed no pixel to the crop";
const contributionStates = [
  { name: 'running', step: { field: 'frame', values: [0, 1] }, expect: { sheet: 'main', row: 2, cols: [0, 1] } },
  { name: 'idle', step: { field: 'frame', values: [0, 1] }, expect: { sheet: 'main', row: 1, cols: [0, 1] } },
];
const contributionCapture = {
  bro: { type: 'Rambro' },
  errors: [noContribution],
  states: [
    {
      name: 'running',
      skipped: `error: ${noContribution}`,
      frames: [
        { step: 0, contributed: true, body: { row: 2, col: 0 } },
        { step: 1, contributed: false, cellEmpty: false, body: { row: 2, col: 1 } },
      ],
    },
    {
      name: 'idle',
      skipped: null,
      frames: [
        { step: 0, contributed: true, body: { row: 1, col: 0 } },
        { step: 1, offscreen: true, body: { row: 1, col: 1 } },
      ],
    },
  ],
};

test('buildReport counts the frames the character contributed nothing to', () => {
  const { text: report, summary } = buildReport({
    capture: contributionCapture,
    states: contributionStates,
    outDir: '/tmp/shots',
    options: {},
  });

  assert.equal(summary.contributionFailures, 1);
  assert.equal(summary.errors, 1);
  assert.match(report, /- Frames the character contributed no pixel to: 1/);
  assert.match(report, /errored mid-sweep: 1/);
  assert.match(report, /## Errors \(1\)\n\n- state 'running' frame 1: the character's renderers contributed no pixel to the crop/);
  assert.match(report, /- \*\*running\*\* — errored \(see Errors\)/, 'the failing state is errored, not captured');
  assert.match(report, /\| State \| Frames \| Contributed \| Body cells \|/);
  assert.match(report, /\| idle \(offscreen frames\) \| 2 \| 1\/1 \| main row 1 cols 0-1 \|/, 'an offscreen frame has no verdict');
});

test('buildReport leaves the report as it was when no frame carries a contribution verdict', () => {
  const { text: report, summary } = buildReport({
    capture: fixtureCapture,
    states: fixtureStates,
    outDir: '/tmp/shots',
    options: {},
  });

  assert.equal(summary.contributionFailures, 0);
  assert.equal(summary.emptyCellFrames, 0);
  assert.doesNotMatch(report, /contributed|empty sheet cells/i);
  assert.match(report, /\| State \| Frames \| Body cells \| Gun cells \| Expected \| Strip \|/);
});

test('buildReport counts a frame addressing an empty sheet cell as neither contributed nor failed', () => {
  const states = [
    { name: 'dancing', step: { field: 'frame', values: [0, 1, 2] }, expect: { sheet: 'main', row: 5, cols: [0, 2] } },
  ];
  const capture = {
    bro: { type: 'Rambro' },
    errors: [],
    states: [
      {
        name: 'dancing',
        skipped: null,
        frames: [
          { step: 0, contributed: false, cellEmpty: true, bodyCellEmpty: true, body: { row: 5, col: 0 } },
          { step: 1, contributed: true, bodyCellEmpty: false, body: { row: 5, col: 1 } },
          { step: 2, contributed: false, cellEmpty: true, bodyCellEmpty: true, body: { row: 5, col: 2 } },
        ],
      },
    ],
  };

  const { text: report, summary } = buildReport({ capture, states, outDir: '/tmp/shots', options: {} });

  assert.equal(summary.emptyCellFrames, 2);
  assert.equal(summary.contributionFailures, 0);
  assert.equal(summary.errors, 0);
  assert.match(report, /- Frames addressing empty sheet cells: 2/);
  assert.match(report, /- Frames the character contributed no pixel to: 0/);
  assert.match(report, /\| dancing \| 3 \| 1\/3 \(2 empty\) \| main row 5 cols 0-2 \|/);
  assert.doesNotMatch(report, /## Errors/);
});

test('buildReport shows the contribution figure of a state errored by its own frames', () => {
  const failure = "state 'running' frame 1: the character's renderers contributed no pixel to the crop";
  const states = [
    { name: 'running', step: { field: 'frame', values: [0, 1, 2] }, expect: { sheet: 'main', row: 2, cols: [0, 2] } },
  ];
  const capture = {
    bro: { type: 'Rambro' },
    errors: [failure],
    states: [
      {
        name: 'running',
        skipped: `error: ${failure}`,
        frames: [
          { step: 0, contributed: true, body: { row: 2, col: 0 } },
          { step: 1, contributed: false, cellEmpty: false, body: { row: 2, col: 1 } },
          { step: 2, contributed: false, cellEmpty: true, body: { row: 2, col: 2 } },
        ],
      },
      { name: 'zipline', skipped: 'unsupported: needs a live ZipLine reference', frames: [] },
    ],
  };

  const { text: report } = buildReport({ capture, states, outDir: '/tmp/shots', options: {} });

  assert.match(report, /- \*\*running\*\* — errored \(see Errors\) — contributed 1\/3 \(1 empty\)\n/);
  assert.match(report, /- \*\*zipline\*\* — unsupported: needs a live ZipLine reference\n/, 'a state with no verdicts gets no figure');
});

test('capture_animations passes an empty-cell frame without failing the sweep', { timeout: 30000 }, async (t) => {
  const dir = await tempDir(t);
  const outDir = path.join(dir, 'out');
  const statesPath = path.join(dir, 'input-states.json');
  const states = [{ name: 'dancing', step: { field: 'frame', values: [0, 1] }, expect: { sheet: 'main', row: 5, cols: [0, 1] } }];
  await fs.writeFile(statesPath, JSON.stringify({ states }));
  const capture = {
    bro: { type: 'Rambro' },
    errors: [],
    states: [
      {
        name: 'dancing',
        skipped: null,
        frames: [
          { step: 0, contributed: false, cellEmpty: true, bodyCellEmpty: true, body: { row: 5, col: 0 } },
          { step: 1, contributed: true, bodyCellEmpty: false, body: { row: 5, col: 1 } },
        ],
      },
    ],
  };

  await toolStub(t, (request) => {
    if (request.method === 'execute_script') {
      writeNow(path.join(outDir, 'capture.json'), JSON.stringify(capture));
      writeNow(path.join(outDir, 'done'), '');
    }
    return false;
  });

  const payload = JSON.parse(textOf(await callCapture({ out: outDir, states: [statesPath], timeout: 5 })));

  assert.equal(payload.success, true);
  assert.equal(payload.summary.emptyCellFrames, 1);
  assert.equal(payload.summary.contributionFailures, 0);
});

test('capture_animations passes on the refusal of a sweep with a stale hero in the crop', { timeout: 30000 }, async (t) => {
  const dir = await tempDir(t);
  const outDir = path.join(dir, 'out');
  const statesPath = path.join(dir, 'input-states.json');
  await fs.writeFile(statesPath, JSON.stringify({ states: contributionStates }));
  const refusal = "another hero 'Rambo(Clone) [local]' that no player slot holds is drawn in the capture crop and the "
    + 'sweep would strip it: raise swapSettle or wait for the old character to be destroyed';

  await toolStub(t, (request) => {
    if (request.method === 'execute_script') writeNow(path.join(outDir, 'error'), refusal);
    return false;
  });

  const payload = JSON.parse(textOf(await callCapture({ out: outDir, states: [statesPath], timeout: 5 })));

  assert.equal(payload.success, false);
  assert.equal(payload.status, 'error');
  assert.equal(payload.message, refusal);
});

test('capture_animations fails a sweep with a frame the character contributed nothing to', { timeout: 30000 }, async (t) => {
  const dir = await tempDir(t);
  const outDir = path.join(dir, 'out');
  const statesPath = path.join(dir, 'input-states.json');
  await fs.writeFile(statesPath, JSON.stringify({ states: contributionStates }));

  await toolStub(t, (request) => {
    if (request.method === 'execute_script') {
      writeNow(path.join(outDir, 'capture.json'), JSON.stringify(contributionCapture));
      writeNow(path.join(outDir, 'done'), '');
    }
    return false;
  });

  const payload = JSON.parse(textOf(await callCapture({ out: outDir, states: [statesPath], timeout: 5 })));

  assert.equal(payload.success, false);
  assert.equal(payload.status, 'done');
  assert.equal(payload.summary.contributionFailures, 1);
  assert.deepEqual(payload.stateErrors, [noContribution]);
  assert.match(payload.report, /## Errors \(1\)[\s\S]*frame 1: the character's renderers contributed no pixel/);
});

const leak = "state 'air_flex': 'Foot Poof 2(Clone)' left over from state 'wall_drag_hand_a' is drawn in the crop";
const leakStates = [
  { name: 'wall_drag_hand_a', step: { field: 'frame', values: [0, 1] }, expect: { sheet: 'main', row: 3, cols: [12, 13] } },
  { name: 'air_flex', step: { field: 'frame', values: [0] }, expect: { sheet: 'main', row: 6, cols: [0, 0] } },
];
const leakCapture = {
  bro: { type: 'Rambro' },
  errors: [leak],
  states: [
    {
      name: 'wall_drag_hand_a',
      skipped: null,
      frames: [
        { step: 0, contributed: true, body: { row: 3, col: 12 } },
        { step: 1, contributed: true, body: { row: 3, col: 13 } },
      ],
      retired: [
        { name: 'Foot Poof 1(Clone)', count: 2 },
        { name: 'Foot Poof 3(Clone)', count: 1 },
      ],
    },
    {
      name: 'air_flex',
      skipped: `error: ${leak}`,
      frames: [{ step: 0, contributed: true, body: { row: 6, col: 0 } }],
      retired: [{ name: 'Foot Poof 2(Clone)', count: 1 }],
    },
  ],
};

test('buildReport lists what each state left in the crop and the game retired', () => {
  const { text: report, summary } = buildReport({ capture: leakCapture, states: leakStates, outDir: '/tmp/shots', options: {} });

  assert.equal(summary.retiredObjects, 4);
  assert.match(report, /- Objects retired between states: 4\n/);
  assert.match(
    report,
    /## Retired between states \(2\)\n\n- \*\*wall_drag_hand_a\*\* — Foot Poof 1\(Clone\) ×2, Foot Poof 3\(Clone\) ×1\n- \*\*air_flex\*\* — Foot Poof 2\(Clone\) ×1\n/,
  );
  assert.match(report, /\| wall_drag_hand_a \| 2 \|/, 'a state that left something behind is still captured');

  const clean = buildReport({ capture: fixtureCapture, states: fixtureStates, outDir: '/tmp/shots', options: {} });
  assert.equal(clean.summary.retiredObjects, 0);
  assert.doesNotMatch(clean.text, /retired/i, 'a sweep that retired nothing says nothing about it');
});

test('capture_animations fails a sweep whose crop still draws an earlier state\'s effect', { timeout: 30000 }, async (t) => {
  const dir = await tempDir(t);
  const outDir = path.join(dir, 'out');
  const statesPath = path.join(dir, 'input-states.json');
  await fs.writeFile(statesPath, JSON.stringify({ states: leakStates }));

  await toolStub(t, (request) => {
    if (request.method === 'execute_script') {
      writeNow(path.join(outDir, 'capture.json'), JSON.stringify(leakCapture));
      writeNow(path.join(outDir, 'done'), '');
    }
    return false;
  });

  const payload = JSON.parse(textOf(await callCapture({ out: outDir, states: [statesPath], timeout: 5 })));

  assert.equal(payload.success, false);
  assert.equal(payload.status, 'done');
  assert.deepEqual(payload.stateErrors, [leak]);
  assert.equal(payload.summary.errors, 1);
  assert.equal(payload.summary.retiredObjects, 4);
  assert.match(payload.report, /## Errors \(1\)\n\n- state 'air_flex': 'Foot Poof 2\(Clone\)' left over from state 'wall_drag_hand_a'/);
  assert.match(payload.report, /- \*\*air_flex\*\* — errored \(see Errors\)/, 'the state it shows up in is errored');
  assert.match(payload.report, /## Errors[\s\S]*state 'air_flex': 'Foot Poof 2\(Clone\)'/);
});

test('runCapture turns the script suppression off only when side effects are allowed', { timeout: 20000 }, async (t) => {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'input-states.json');
  const outDir = path.join(dir, 'out');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));

  const seen = [];
  const stub = await startGameStub((request, socket) => {
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
    if (state.expect.cols) assert.equal(state.step.values.length, state.expect.cols[1] - state.expect.cols[0] + 1);
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
  assert.match(held.note, /DrunkenBroster\.cs:2752-2767/, 'the note names the source lines');
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
  assert.match(errors[2], /^backwards: 1 step value\(s\) for expect columns 7-0 \(8 cells\)/);
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
  const stub = await startGameStub((request, socket) => {
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
    ['allowSideEffects', 'bro', 'box', 'gameOut', 'includeLethal', 'level', 'only', 'out', 'player', 'settle',
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
  assert.equal(properties.box.maximum, 256, 'a wider box makes strips past a GPU texture limit');
  assert.equal(properties.only.type, 'array');
  assert.equal(properties.only.items.type, 'string');
  assert.equal(properties.player.type, 'integer');
  assert.equal(properties.player.minimum, 0);
  assert.equal(properties.player.maximum, 3);
  assert.equal(properties.includeLethal.type, 'boolean');
  assert.equal(properties.allowSideEffects.type, 'boolean');

  // The defaults each argument promises are the ones the library holds
  assert.match(properties.settle.description, new RegExp(`default: ${DEFAULT_SETTLE_MS / 1000}`));
  assert.match(properties.swapSettle.description, new RegExp(`default: ${DEFAULT_SWAP_SETTLE_MS / 1000}`));
  assert.match(properties.swapTimeout.description, new RegExp(`default: ${DEFAULT_SWAP_TIMEOUT_MS / 1000}`));
  assert.match(properties.timeout.description, new RegExp(`default: ${DEFAULT_TIMEOUT_MS / 1000}`));
  assert.match(description, /report\.md/, 'the description says what the sweep writes');
  assert.match(description, /animation-capture\.md/, 'and where the full reference lives');
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
  assert.match(refusal, /already holds files and no \.capture-animations mark from an earlier sweep/);
  assert.match(refusal, /deletes every \.png/, 'and says why that matters');

  await fs.writeFile(path.join(populated, STATES_COPY_NAME), '{"states":[]}');
  assert.match(textOf(await callCapture({ out: populated })), /already holds files/);
  await fs.writeFile(path.join(populated, OUT_MARKER), 'hand-written\n');
  assert.match(textOf(await callCapture({ out: populated })), /already holds files/, 'nor a marker file with other contents');

  // The mark an earlier sweep leaves is what licenses the clear
  await fs.writeFile(path.join(populated, OUT_MARKER), OUT_MARKER_TEXT);
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
  assert.match(textOf(await callCapture({ out, swapTimeout: 'soon' })), /swapTimeout must be a number, got "soon"/);
  assert.match(textOf(await callCapture({ out, level: '1:0', settle: -1 })), /settle must be a number >= 0/);
  // Checked even where the wait it follows was never asked for, rather than silently discarded
  assert.match(textOf(await callCapture({ out, settle: 'soon' })), /settle must be a number, got "soon"/);
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
    'ping', 'execute_code', 'game_state', 'swap_bro', 'game_state', 'game_state', 'execute_script', 'unload_script',
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
  assert.deepEqual(payload.summary, {
    captured: 2, skipped: 1, excluded: 0, mismatches: 1, errors: 0, contributionFailures: 0, emptyCellFrames: 0,
    carriedGunFrames: 0, retiredObjects: 0, levelChangeStates: 0, firstLevelChange: null, complete: true, cutscenePresses: 0,
  });
  assert.deepEqual(payload.stateErrors, []);
  assert.equal(payload.swap.requested, 'Rambro');
  assert.equal(payload.swap.alreadyHeld, false);
  assert.equal(payload.swap.slot.broName, RAMBRO_OBJECT);
  assert.equal(payload.swap.currentBro, 'Rambro', 'confirmed by the roster name list_bros reports');
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
  assert.match(second, /stop_game to end it early/);

  const launch = textOf(await handleToolCall({
    params: { name: 'launch_game', arguments: { steam: true, vanilla: true } },
  }));
  assert.match(launch, /capture_animations sweep into/);
  assert.doesNotMatch(launch, /disconnect the client/, 'a sweep does not drop the socket; it holds the game');

  const wait = textOf(await handleToolCall({ params: { name: 'wait_for_game', arguments: { timeout: 1 } } }));
  assert.match(wait, /capture_animations sweep into/);

  const input = textOf(await handleToolCall({ params: { name: 'simulate_input', arguments: { action: 'right' } } }));
  assert.match(input, /Cannot run simulate_input while a capture_animations sweep into/);

  const script = textOf(await handleToolCall({ params: { name: 'run_test_script', arguments: { script: 'input-sequence' } } }));
  assert.match(script, /Cannot run run_test_script while a capture_animations sweep into/);

  // The sweep has no sentinel to find and no script the stub could fail: end it by hand
  writeNow(path.join(outDir, 'error'), 'ended by the test');
  const payload = JSON.parse(textOf(await sweep));
  assert.equal(payload.status, 'error');

  const afterwards = textOf(await handleToolCall({
    params: { name: 'launch_game', arguments: { steam: true, vanilla: true } },
  }));
  assert.doesNotMatch(afterwards, /capture_animations sweep into/, 'the guard is released with the sweep');
});

test('a sweep is refused while a launch_game is still running', { timeout: 30000, skip: process.platform !== 'linux' }, async (t) => {
  const dir = await tempDir(t);
  const script = path.join(dir, 'slow-launch.sh');
  await fs.writeFile(script, 'sleep 1\nexit 0\n');
  const launchCommand = process.env.BROFORCE_LAUNCH_CMD;
  process.env.BROFORCE_LAUNCH_CMD = `sh ${script}`;
  setProcReader(fakeProcReader({}));
  const { startConfirmMs } = configureLaunchTiming({ startConfirmMs: 100 });
  t.after(() => {
    process.env.BROFORCE_LAUNCH_CMD = launchCommand;
    setProcReader(null);
    configureLaunchTiming({ startConfirmMs });
  });

  const launching = handleToolCall({ params: { name: 'launch_game', arguments: { steam: true, vanilla: true } } });
  const refused = textOf(await callCapture({ out: path.join(dir, 'out'), timeout: 5 }));
  assert.match(refused, /Cannot start an animation capture sweep while launch_game is running/);
  await launching;
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
  const stub = await startGameStub((request, socket) => {
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
  assert.deepEqual(seen, ['ping', 'execute_code', 'game_state', 'execute_script'], 'the teardown is not sent to a game that is gone');
  assert.match(result.report, /# Animation capture/, 'and the report is still written');
});

test('a sweep is not declared gone against a game process detection never saw', { timeout: 20000 }, async (t) => {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'input-states.json');
  const outDir = path.join(dir, 'out');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));

  const stub = await startGameStub((request, socket) => {
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
    ['ping', 'execute_code', 'game_state', 'execute_script', 'unload_script'],
    'the script is unloaded and the clock restored before the process goes',
  );

  writeNow(path.join(outDir, 'done'), '');
  await sweep;
});

const isLinux = process.platform === 'linux';

async function until(condition, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition never held');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const liveSlots = {
  ...inLevel,
  players: [0, 1, 2, 3].map((playerIndex) => ({
    playerIndex, broName: RAMBRO_OBJECT, className: 'Rambro', isAlive: true, state: 'alive', piloting: null,
  })),
};

async function finishingStub(t, outDir, { capture = fixtureCapture, answer = null } = {}) {
  const stamps = [];
  const stub = await toolStub(t, (request, socket) => {
    stamps.push({ method: request.method, at: Date.now() });
    if (answer && answer(request, socket) === true) return true;
    if (request.method === 'game_state') {
      reply(socket, request.id, liveSlots);
      return true;
    }
    if (request.method === 'execute_script') {
      writeNow(path.join(outDir, 'capture.json'), JSON.stringify(capture));
      writeNow(path.join(outDir, 'done'), '');
    }
    return false;
  });
  const scriptArgs = () => {
    const sent = stub.seen.filter((request) => request.method === 'execute_script');
    assert.ok(sent.length > 0, 'no execute_script reached the game');
    return sent[sent.length - 1].params.args;
  };
  return { ...stub, stamps, scriptArgs };
}

async function sweepPayload(args) {
  const response = await callCapture(args);
  assert.ok(!textOf(response).startsWith('Error: '), textOf(response));
  const body = JSON.parse(textOf(response));
  assert.equal(Boolean(response.isError), body.success === false, `isError goes with success: false: ${textOf(response)}`);
  return body;
}

async function copiedStateNames(outDir) {
  const copied = JSON.parse(await fs.readFile(path.join(outDir, STATES_COPY_NAME), 'utf-8'));
  return copied.states.map((state) => state.name);
}

test('capture_animations sweeps the bundled base list alone when states is absent, with or without .json', { timeout: 30000 }, async (t) => {
  const outDir = path.join(await tempDir(t), 'out');
  await finishingStub(t, outDir);

  const bundled = partitionLethal(await loadStates([DEFAULT_STATES_PATH]), false).states.map((state) => state.name);
  assert.ok(bundled.length > 0);

  for (const states of [undefined, 'base-states.json', ['base-states.json'], 'base-states']) {
    const payload = await sweepPayload({ out: outDir, ...(states === undefined ? {} : { states }), timeout: 5 });
    assert.equal(payload.status, 'done', JSON.stringify(states));
    assert.deepEqual(await copiedStateNames(outDir), bundled, `states ${JSON.stringify(states)} is the base list`);
  }
});

test('capture_animations layers an absolute custom list over the bundled base, later layers winning in place', { timeout: 30000 }, async (t) => {
  const dir = await tempDir(t);
  const outDir = path.join(dir, 'out');
  const layerPath = path.join(dir, 'custom-layer.json');
  const restated = { name: 'running', step: { field: 'frame', values: [0, 1] }, expect: { sheet: 'main', row: 7, cols: [3, 4] } };
  const added = { name: 'custom_only', step: { field: 'frame', values: [0] }, expect: { sheet: 'main', row: 5, cols: [0, 0] } };
  await fs.writeFile(layerPath, JSON.stringify({ states: [restated, added] }));
  await finishingStub(t, outDir);

  await sweepPayload({ out: outDir, states: ['base-states.json', layerPath], timeout: 5 });

  const base = partitionLethal(await loadStates([DEFAULT_STATES_PATH]), false).states.map((state) => state.name);
  const copied = JSON.parse(await fs.readFile(path.join(outDir, STATES_COPY_NAME), 'utf-8')).states;
  assert.deepEqual(copied.map((state) => state.name), [...base, 'custom_only'], 'base order kept, a new state appended');
  assert.deepEqual(copied.find((state) => state.name === 'running').expect, restated.expect, 'the later layer replaces the base entry');
});

test('capture_animations uses one absolute state list as given, with no base under it', { timeout: 30000 }, async (t) => {
  const dir = await tempDir(t);
  const outDir = path.join(dir, 'out');
  const statesPath = path.join(dir, 'only-these.json');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));
  await finishingStub(t, outDir);

  await sweepPayload({ out: outDir, states: statesPath, timeout: 5 });
  assert.deepEqual(await copiedStateNames(outDir), fixtureStates.map((state) => state.name));
});

test('capture_animations refuses a states entry that is blank or not a string', async (t) => {
  const out = path.join(await tempDir(t), 'out');
  for (const states of ['', ['  ']]) {
    const response = await callCapture({ out, states });
    assert.equal(response.isError, true, JSON.stringify(states));
    assert.match(textOf(response), /Every states entry must be a path to a state list/, JSON.stringify(states));
  }
  for (const [states, problem] of [[[42], 'states[0] must be a string, got 42'], [['base-states', null], 'states[1] must be a string, got null']]) {
    const response = await callCapture({ out, states });
    assert.equal(response.isError, true, JSON.stringify(states));
    assert.equal(textOf(response), `Error: capture_animations: ${problem}`);
  }
});

test('capture_animations loads the level, waits for its player and settles before the sweep', { timeout: 30000 }, async (t) => {
  const outDir = path.join(await tempDir(t), 'out');
  const { seen, methods, stamps } = await finishingStub(t, outDir);

  const payload = await sweepPayload({ out: outDir, level: '1:0', settle: 0.3, timeout: 5 });
  assert.equal(payload.status, 'done');
  assert.deepEqual(methods(), ['ping', 'execute_code', 'go_to_level', 'game_state', 'game_state', 'game_state', 'execute_script', 'unload_script'],
    'the level wait, a look for a cutscene after the settle, the readiness wait');
  assert.deepEqual(seen.find((request) => request.method === 'go_to_level').params, { campaignIndex: 1, levelIndex: 0 });

  const ready = stamps.find((stamp) => stamp.method === 'game_state').at;
  const swept = stamps.find((stamp) => stamp.method === 'execute_script').at;
  assert.ok(swept - ready >= 250, `the sweep started ${swept - ready}ms after the player was live, inside the settle`);
});

test('capture_animations fails with go_to_level\'s own range error and captures nothing', { timeout: 30000 }, async (t) => {
  const outDir = path.join(await tempDir(t), 'out');
  const { methods } = await finishingStub(t, outDir, {
    answer: (request, socket) => {
      if (request.method !== 'go_to_level') return false;
      reply(socket, request.id, { success: false, error: 'Campaign index 28 is out of range - valid indices are 0 to 25 (see list_campaigns)' });
      return true;
    },
  });

  const response = await callCapture({ out: outDir, level: '28:0', settle: 0, timeout: 5 });
  assert.equal(response.isError, true);
  assert.match(textOf(response), /Campaign index 28 is out of range - valid indices are 0 to 25 \(see list_campaigns\)/);
  assert.deepEqual(methods(), ['ping', 'execute_code', 'go_to_level', 'execute_code'], 'no wait, no sweep, the claim released');
  await assert.rejects(fs.access(path.join(outDir, 'capture.json')));
});

test('capture_animations treats a null or blank bro as no swap', { timeout: 30000 }, async (t) => {
  const outDir = path.join(await tempDir(t), 'out');
  const { methods, seen } = await finishingStub(t, outDir);

  for (const bro of [null, '   ']) {
    seen.length = 0;
    const payload = await sweepPayload({ out: outDir, bro, timeout: 5 });
    assert.equal(payload.swap, null, JSON.stringify(bro));
    assert.ok(!methods().includes('swap_bro'), `bro ${JSON.stringify(bro)} swapped`);
    assert.equal(methods().filter((method) => method === 'game_state').length, 1, 'only the look that the bro can be swept');
  }
});

test('capture_animations hands the game out, or gameOut in its own separator style', { timeout: 30000 }, async (t) => {
  const outDir = path.join(await tempDir(t), 'out');
  const { scriptArgs } = await finishingStub(t, outDir);

  for (const gameOut of [undefined, '  ']) {
    await sweepPayload({ out: outDir, ...(gameOut === undefined ? {} : { gameOut }), timeout: 5 });
    assert.equal(scriptArgs().outDir, outDir);
    assert.equal(scriptArgs().statesFile, `${outDir}/${STATES_COPY_NAME}`);
  }

  await sweepPayload({ out: outDir, gameOut: 'Z:\\captures\\out', timeout: 5 });
  assert.equal(scriptArgs().outDir, 'Z:\\captures\\out');
  assert.equal(scriptArgs().statesFile, `Z:\\captures\\out\\${STATES_COPY_NAME}`);
});

test('capture_animations forwards players 1 to 3 to the script and the swap', { timeout: 30000 }, async (t) => {
  const outDir = path.join(await tempDir(t), 'out');
  const { scriptArgs, seen } = await finishingStub(t, outDir, {
    answer: (request, socket) => {
      if (request.method !== 'swap_bro') return false;
      reply(socket, request.id, { success: true, broName: 'Drunken Broster', objectName: DRUNKEN_OBJECT });
      return true;
    },
  });

  for (const player of [1, 2, 3]) {
    await sweepPayload({ out: outDir, player, timeout: 5 });
    assert.equal(scriptArgs().player, String(player));
  }

  seen.length = 0;
  await sweepPayload({ out: outDir, player: 2, bro: 'Drunken Broster', swapSettle: 0, timeout: 5 });
  assert.equal(seen.find((request) => request.method === 'swap_bro').params.playerNum, 2);
});

test('capture_animations refuses a negative player or one past 3', async (t) => {
  const out = path.join(await tempDir(t), 'out');
  assert.match(textOf(await callCapture({ out, player: -1 })), /player must be an integer >= 0/);
  assert.match(textOf(await callCapture({ out, player: 4 })), /player must be an integer >= 0 and <= 3/);
});

test('capture_animations takes a long timeout as the sweep budget', { timeout: 30000 }, async (t) => {
  const dir = await tempDir(t);
  let sweeps = 0;
  await toolStub(t, (request) => {
    if (request.method === 'execute_script') sweeps++;
    return false;
  });

  for (const timeout of [120, 240]) {
    const outDir = path.join(dir, `out-${timeout}`);
    const before = sweeps;
    const sweep = callCapture({ out: outDir, timeout });
    await until(() => sweeps > before);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const refused = textOf(await callCapture({ out: path.join(dir, 'other'), timeout: 5 }));
    assert.match(refused, /capture_animations sweep into/, `timeout ${timeout}`);
    assert.ok(refused.includes(outDir));

    writeNow(path.join(outDir, 'error'), 'ended by the test');
    assert.equal(JSON.parse(textOf(await sweep)).status, 'error');
  }
});

test('capture_animations leaves box to the script unless given, and refuses one under 1', { timeout: 30000 }, async (t) => {
  const outDir = path.join(await tempDir(t), 'out');
  const { scriptArgs } = await finishingStub(t, outDir);

  await sweepPayload({ out: outDir, timeout: 5 });
  assert.equal('box' in scriptArgs(), false);

  await sweepPayload({ out: outDir, box: 12, timeout: 5 });
  assert.equal(scriptArgs().box, '12');

  assert.match(textOf(await callCapture({ out: outDir, box: 0.5 })), /box must be a number >= 1/);
});

test('capture_animations sends lethal states only for includeLethal: true', { timeout: 30000 }, async (t) => {
  const dir = await tempDir(t);
  const outDir = path.join(dir, 'out');
  const statesPath = path.join(dir, 'with-lethal.json');
  await fs.writeFile(statesPath, JSON.stringify({
    states: [...fixtureStates, { name: 'death_grounded', lethal: true, lethalReason: 'pins the bro dead', step: { values: [0] } }],
  }));
  await finishingStub(t, outDir);

  for (const includeLethal of [undefined, false]) {
    const payload = await sweepPayload({ out: outDir, states: statesPath, timeout: 5, ...(includeLethal === undefined ? {} : { includeLethal }) });
    assert.ok(!(await copiedStateNames(outDir)).includes('death_grounded'), `includeLethal ${JSON.stringify(includeLethal)}`);
    assert.equal(payload.summary.excluded, 1);
  }

  const opted = await sweepPayload({ out: outDir, states: statesPath, includeLethal: true, timeout: 5 });
  assert.ok((await copiedStateNames(outDir)).includes('death_grounded'));
  assert.equal(opted.summary.excluded, 0);
});

test('capture_animations turns the script suppression off only for allowSideEffects: true', { timeout: 30000 }, async (t) => {
  const outDir = path.join(await tempDir(t), 'out');
  const { scriptArgs } = await finishingStub(t, outDir);

  for (const allowSideEffects of [undefined, false]) {
    await sweepPayload({ out: outDir, timeout: 5, ...(allowSideEffects === undefined ? {} : { allowSideEffects }) });
    assert.equal('suppress' in scriptArgs(), false, `allowSideEffects ${JSON.stringify(allowSideEffects)}`);
  }

  await sweepPayload({ out: outDir, allowSideEffects: true, timeout: 5 });
  assert.equal(scriptArgs().suppress, 'false');
});

test('capture_animations is refused while another command is in flight', { timeout: 30000 }, async (t) => {
  const outDir = path.join(await tempDir(t), 'out');
  let release = null;
  const { methods } = await toolStub(t, (request, socket) => {
    if (request.method === 'ping' && release === null) {
      release = () => reply(socket, request.id, { success: true });
      return true;
    }
    return false;
  });

  const ping = handleToolCall({ params: { name: 'ping', arguments: {} } });
  await until(() => release !== null);

  const refused = await callCapture({ out: outDir, timeout: 5 });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /Cannot start an animation capture sweep while ping is still in flight/);

  release();
  assert.ok(!(await ping).isError);
  assert.deepEqual(methods(), ['ping'], 'the refused sweep sent nothing');
});

test('capture_animations with no game to connect to says so before it touches anything', { timeout: 30000 }, async (t) => {
  const outDir = path.join(await tempDir(t), 'out');
  process.env.UNITY_INSPECTOR_PORT = NO_LISTENER_PORT;
  setProcReader(fakeProcReader({}));
  t.after(() => setProcReader(null));

  const response = await callCapture({ out: outDir, timeout: 5 });
  assert.equal(response.isError, true);
  assert.match(textOf(response), /Game is not running\. Use launch_game to start it\./);
  await assert.rejects(fs.access(outDir), 'the output directory is not created for a sweep that never started');
});

test('stop_game during a sweep is let through, and the sweep ends game-gone without a teardown', { timeout: 30000, skip: !isLinux }, async (t) => {
  const dir = await tempDir(t);
  const outDir = path.join(dir, 'out');
  const statesPath = path.join(dir, 'input-states.json');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));

  const processes = { 4242: { comm: LINUX_GAME_COMM, cwd: '/home/someone/games/broforce', startTicks: 100 } };
  const signals = [];
  setProcReader(fakeProcReader(processes));
  setKillSignaller((pid, signal) => {
    if (signal !== 0) signals.push(`${signal} ${pid}`);
    if (!(String(pid) in processes)) {
      const error = new Error('ESRCH');
      error.code = 'ESRCH';
      throw error;
    }
    if (signal === 'SIGTERM') delete processes[pid];
    return true;
  });
  t.after(() => { setProcReader(null); setKillSignaller(); });

  let sweeping;
  const started = new Promise((resolve) => { sweeping = resolve; });
  const { methods } = await toolStub(t, (request) => {
    if (request.method === 'execute_script') sweeping();
    return false;
  });

  const sweep = callCapture({ out: outDir, states: [statesPath], timeout: 20 });
  await started;
  await new Promise((resolve) => setTimeout(resolve, 700));

  const stopped = JSON.parse(textOf(await handleToolCall({ params: { name: 'stop_game', arguments: {} } })));
  assert.equal(stopped.success, true, stopped.message);
  assert.deepEqual(signals, ['SIGTERM 4242']);

  const stoppedAt = Date.now();
  const payload = JSON.parse(textOf(await sweep));
  assert.ok(Date.now() - stoppedAt < 3000, 'the sweep ended within a poll, not at its timeout');
  assert.equal(payload.success, false);
  assert.equal(payload.status, 'game-gone');
  assert.match(payload.message, /the game stopped while the sweep was running/);
  assert.ok(!methods().includes('unload_script'), 'the teardown is not sent to a game that is gone');
});

test('a sweep that times out answers with the log tail through the handler', { timeout: 30000 }, async (t) => {
  const dir = await tempDir(t);
  const outDir = path.join(dir, 'out');
  const statesPath = path.join(dir, 'input-states.json');
  const logPath = path.join(dir, 'Player.log');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));
  await fs.writeFile(logPath, '[Script:animation-capture] a sweep from before this one\n');

  const savedLog = process.env.UNITY_INSPECTOR_LOG;
  process.env.UNITY_INSPECTOR_LOG = logPath;
  t.after(() => {
    if (savedLog === undefined) delete process.env.UNITY_INSPECTOR_LOG;
    else process.env.UNITY_INSPECTOR_LOG = savedLog;
  });
  const { methods } = await toolStub(t, (request) => {
    if (request.method === 'execute_script') {
      appendFileSync(logPath, '[Info] unrelated\n[Script:animation-capture] startup failed: player 0 has no character\n');
    }
  });

  const payload = await sweepPayload({ out: outDir, states: [statesPath], timeout: 1 });
  assert.equal(payload.success, false);
  assert.equal(payload.status, 'timeout');
  assert.match(payload.message, /no done or error/);
  assert.match(payload.logTail, /player 0 has no character/);
  assert.doesNotMatch(payload.logTail, /unrelated/);
  assert.doesNotMatch(payload.logTail, /a sweep from before this one/);
  assert.deepEqual(methods().slice(-1), ['unload_script'], 'the game is unfrozen either way');
});

test('a sweep with state errors answers success: false with the errors listed', { timeout: 30000 }, async (t) => {
  const dir = await tempDir(t);
  const outDir = path.join(dir, 'out');
  const statesPath = path.join(dir, 'input-states.json');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));
  await finishingStub(t, outDir, {
    capture: {
      bro: { type: 'Rambro' },
      errors: ["state 'idle': unknown field 'nope'"],
      states: [{ name: 'idle', skipped: "error: state 'idle': unknown field 'nope'", frames: [] }],
    },
  });

  const payload = await sweepPayload({ out: outDir, states: [statesPath], timeout: 5 });
  assert.equal(payload.status, 'done');
  assert.equal(payload.success, false, 'a state that errored inside the sweep fails it');
  assert.deepEqual(payload.stateErrors, ["state 'idle': unknown field 'nope'"]);
  assert.equal(payload.message, null);
});

test('a sweep whose only finding is a repaired delta answers success: true', { timeout: 30000 }, async (t) => {
  const dir = await tempDir(t);
  const outDir = path.join(dir, 'out');
  const statesPath = path.join(dir, 'input-states.json');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));
  await finishingStub(t, outDir, {
    capture: {
      bro: { type: 'BroLee' },
      errors: [],
      states: [{ name: 'idle', skipped: null, deltaRepaired: true, frames: [] }],
    },
  });

  const payload = await sweepPayload({ out: outDir, states: [statesPath], timeout: 5 });
  assert.equal(payload.status, 'done');
  assert.equal(payload.success, true);
  assert.deepEqual(payload.stateErrors, []);
  assert.equal(payload.summary.errors, 0);
  assert.doesNotMatch(payload.report, /## Errors/);
});

test('a non-finite value that lived through an Update still fails the sweep', { timeout: 30000 }, async (t) => {
  const error = "state 'idle': faderTrailDelay went non-finite on the frozen clock and was put back, so this state's frames are not to be trusted";
  const dir = await tempDir(t);
  const outDir = path.join(dir, 'out');
  const statesPath = path.join(dir, 'input-states.json');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));
  await finishingStub(t, outDir, {
    capture: {
      bro: { type: 'BroLee' },
      errors: [error],
      states: [{ name: 'idle', skipped: null, nonFinite: ['faderTrailDelay'], frames: [] }],
    },
  });

  const payload = await sweepPayload({ out: outDir, states: [statesPath], timeout: 5 });
  assert.equal(payload.status, 'done');
  assert.equal(payload.success, false);
  assert.deepEqual(payload.stateErrors, [error]);
  assert.match(payload.report, /## Errors \(1\)\n\n- state 'idle': faderTrailDelay went non-finite/);
});

test('shutdownServer exits after its budget when the teardown never answers, and says the game may be frozen', { timeout: 30000 }, async (t) => {
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
  await new Promise((resolve) => setTimeout(resolve, 100));

  const hung = t.mock.method(unityClient, 'sendCommand', () => new Promise(() => {}));
  const logged = [];
  const quiet = t.mock.method(console, 'error', (...parts) => { logged.push(parts.join(' ')); });

  const exits = [];
  const began = Date.now();
  await shutdownServer('SIGTERM', { exit: (code) => exits.push(code) });
  const took = Date.now() - began;
  hung.mock.restore();
  quiet.mock.restore();

  assert.deepEqual(exits, [0]);
  assert.ok(took >= SHUTDOWN_TEARDOWN_BUDGET_MS - 50, `exited after ${took}ms, before the teardown budget ran out`);
  assert.ok(took < SHUTDOWN_TEARDOWN_BUDGET_MS + 1000, `exited after ${took}ms, well past the budget`);
  assert.ok(logged.some((line) => /teardown did not finish in time — the game may still be frozen/.test(line)), logged.join('\n'));

  writeNow(path.join(outDir, 'done'), '');
  await sweep;
});

test('a cancelled sweep stops waiting, tears the game down and releases the sweep', { timeout: 30000 }, async (t) => {
  const dir = await tempDir(t);
  let started = false;
  const { methods } = await toolStub(t, (request) => {
    if (request.method === 'execute_script') started = true;
    return false;
  });

  const controller = new AbortController();
  const sweep = handleToolCall(
    { params: { name: 'capture_animations', arguments: { out: path.join(dir, 'out'), timeout: 60 } } },
    { signal: controller.signal },
  );
  await until(() => started);
  const cancelledAt = Date.now();
  controller.abort();

  const response = await sweep;
  assert.equal(response.isError, true);
  assert.match(textOf(response), /(capture_animations|execute_script) was cancelled/);
  assert.ok(Date.now() - cancelledAt < 5000, 'the sweep sat out its wait after the cancellation');
  assert.deepEqual(methods().slice(-1), ['unload_script'], 'the game was left frozen');

  const next = await callCapture({ out: path.join(dir, 'other'), timeout: 5, level: 'nonsense' });
  assert.doesNotMatch(textOf(next), /while a capture_animations sweep/, 'the cancelled sweep still holds the server');
});

test('a cancelled run wakes from its wait, sends no further setup command and releases its claim', { timeout: 20000 }, async (t) => {
  const fake = fakeSlot();
  let holdSnapshot = false;
  let held = null;
  const { client, methods } = await slotStub(t, fake, (request, socket) => {
    if (request.method !== 'game_state') return false;
    if (holdSnapshot) held = () => reply(socket, request.id, slotState(RAMBRO_OBJECT));
    else reply(socket, request.id, slotState(null));
    return true;
  });

  const waiting = new AbortController();
  const levelRun = runCapture(
    await captureOptionsFor(t, { level: { campaignIndex: 1, levelIndex: 0 }, settleMs: 0, bro: 'Rambro' }),
    client,
    { pollMs: 5, sleep: () => new Promise(() => {}), signal: waiting.signal },
  );
  await until(() => methods().includes('go_to_level') && methods().at(-1) === 'game_state');
  waiting.abort();
  await assert.rejects(levelRun, /capture_animations was cancelled/);
  assert.deepEqual(methods().filter((method) => method !== 'game_state'), ['ping', 'execute_code', 'go_to_level', 'execute_code'], 'no swap, the claim released');
  assert.equal(fake.slot, null);

  const snapshot = new AbortController();
  holdSnapshot = true;
  const start = methods().length;
  const swapRun = runCapture(await captureOptionsFor(t, { bro: 'Rambro', swapSettleMs: 0 }), client, { pollMs: 5, signal: snapshot.signal });
  await until(() => held !== null);
  snapshot.abort();
  held();
  await assert.rejects(swapRun, /capture_animations was cancelled/);
  assert.deepEqual(methods().slice(start), ['ping', 'execute_code', 'game_state', 'execute_code'], 'no swap_bro after the cancel');
  assert.equal(fake.slot, null);
});

test('a sweep in progress counts the level load and both swap calls in the budget its refusal reports', { timeout: 30000 }, async (t) => {
  const dir = await tempDir(t);
  let levelUp = false;
  const { methods } = await toolStub(t, (request, socket) => {
    if (request.method === 'game_state' && !levelUp) {
      reply(socket, request.id, slotState(null));
      return true;
    }
    return false;
  });

  const sweep = callCapture({ out: path.join(dir, 'out'), level: '1:0', bro: 'Rambro', timeout: 30, settle: 0, swapTimeout: 1, swapSettle: 0 });
  await until(() => methods().includes('go_to_level'));

  const refused = textOf(await callCapture({ out: path.join(dir, 'other'), timeout: 5 }));
  const left = Number(/about (\d+)s of its budget left/.exec(refused)?.[1]);
  const waits = 2 * 30000;
  assert.ok(
    left * 1000 >= waits + commandTimeout('go_to_level') + 2 * commandTimeout('swap_bro') - 2000,
    `${left}s left: ${refused}`,
  );

  levelUp = true;
  await sweep;
});

function callTool(name, args = {}) {
  return handleToolCall({ params: { name, arguments: args } });
}

test('two sweeps started together: one reaches the game and the other is refused, writing nothing', { timeout: 30000 }, async (t) => {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'input-states.json');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));
  const outs = [path.join(dir, 'first'), path.join(dir, 'second')];
  const { methods } = await toolStub(t, (request, socket) => {
    if (request.method === 'game_state') {
      reply(socket, request.id, liveSlots);
      return true;
    }
    if (request.method === 'execute_script') {
      writeNow(path.join(request.params.args.outDir, 'capture.json'), JSON.stringify(fixtureCapture));
      writeNow(path.join(request.params.args.outDir, 'done'), '');
    }
    return false;
  });

  const replies = await Promise.all(outs.map((out) => callCapture({ out, states: [statesPath], timeout: 5 })));

  const refused = replies.findIndex((response) => response.isError);
  assert.notEqual(refused, -1, 'both sweeps ran');
  assert.match(textOf(replies[refused]), /capture_animations sweep into/);
  assert.equal(JSON.parse(textOf(replies[1 - refused])).status, 'done');
  assert.equal(methods().filter((method) => method === 'execute_script').length, 1, 'one sweep reached the game');
  await assert.rejects(fs.access(outs[refused]), 'the refused sweep wrote nothing');
});

test('a sweep holds the game: every tool that could change it is refused, and the ones that only read run', { timeout: 40000 }, async (t) => {
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

  const changing = [
    ['set_game_speed', { speed: 1 }],
    ['go_to_level', { campaignIndex: 0, levelIndex: 1 }],
    ['restart_level', {}],
    ['swap_bro', { broName: 'Rambro' }],
    ['simulate_input', { action: 'fire' }],
    ['teleport_player', { x: 1, y: 2 }],
    ['set_player_health', { health: 3 }],
    ['modify_component', { path: '/A', component: 'B', properties: { c: 1 } }],
    ['spawn_entity', { type: 'Mook', x: 1, y: 2 }],
    ['execute_code', { code: 'return 1;' }],
    ['execute_script', { path: 'find-by-type' }],
    ['unload_script', { name: SCRIPT_NAME }],
    ['trace_spawns', { action: 'start' }],
    ['run_test_script', { script: 'inspection' }],
    ['take_screenshot', { highlight: '/Player' }],
  ];
  const before = methods().length;
  for (const [name, args] of changing) {
    const response = await callTool(name, args);
    assert.equal(response.isError, true, `${name} ran during the sweep`);
    assert.match(textOf(response), new RegExp(`Cannot run ${name} while a capture_animations sweep into`), name);
  }
  assert.equal(methods().length, before, 'none of them reached the game');

  for (const name of ['game_state', 'ping', 'list_bros', 'take_screenshot']) {
    const response = await callTool(name, {});
    assert.doesNotMatch(textOf(response), /capture_animations sweep into/, `${name} only reads`);
  }

  writeNow(path.join(outDir, 'error'), 'ended by the test');
  await sweep;
  assert.doesNotMatch(textOf(await callTool('set_game_speed', { speed: 1 })), /capture_animations sweep into/, 'released with the sweep');
});

test('each server process names its capture script for itself, and unloads that name', { timeout: 20000 }, async (t) => {
  assert.match(SCRIPT_NAME, /^animation-capture-\d+-[0-9a-f]{6}$/, 'another server on the same game cannot replace it');

  const sent = [];
  const client = { sendCommand: async (method, params) => { sent.push({ method, params }); return { success: true }; } };
  assert.deepEqual(await teardownGame(client), []);
  assert.deepEqual(sent, [{ method: 'unload_script', params: { name: SCRIPT_NAME } }]);
});

test('teardown leaves the speed alone when the script unloaded, and restores the one from before the sweep when it did not', async () => {
  for (const unload of [{ success: false, error: 'no script loaded' }, new Error('timed out')]) {
    const sent = [];
    const client = {
      sendCommand: async (method, params) => {
        sent.push({ method, params });
        if (method === 'unload_script') {
          if (unload instanceof Error) throw unload;
          return unload;
        }
        return { success: true };
      },
    };
    const problems = await teardownGame(client, { name: 'animation-capture-1-abcdef', speed: 0.5 });
    assert.deepEqual(sent.map((entry) => entry.method), ['unload_script', 'set_game_speed']);
    assert.deepEqual(sent[1].params, { speed: 0.5 }, 'the user\'s own speed, not 1');
    assert.equal(problems.length, 1);
  }

  const sent = [];
  await teardownGame({ sendCommand: async (method, params) => { sent.push(params); if (method === 'unload_script') throw new Error('x'); return {}; } }, { speed: 0 });
  assert.deepEqual(sent[1], { speed: 1 }, 'a clock that was stopped before the sweep is read as normal speed');
});

test('runCapture restores the speed game_state reported before the sweep when the unload fails', { timeout: 20000 }, async (t) => {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'input-states.json');
  const outDir = path.join(dir, 'out');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));

  const seen = [];
  const stub = await startGameStub((request, socket) => {
    seen.push(request);
    if (request.method === 'game_state') return reply(socket, request.id, slotState(RAMBRO_OBJECT, { timeScale: 0.5 }));
    if (request.method === 'unload_script') return reply(socket, request.id, { success: false, error: 'Unload() threw' });
    if (request.method === 'execute_script') writeNow(path.join(outDir, 'done'), '');
    reply(socket, request.id, { success: true });
  });
  const client = new UnityInspectorClient({ host: '127.0.0.1', port: stub.port });
  t.after(async () => { client.disconnect(); await stub.close(); });

  const sweep = {};
  await runCapture({ statesPaths: [statesPath], out: outDir, gameOut: outDir, timeoutMs: 5000, player: 0 }, client, { pollMs: 5, sweep });
  assert.deepEqual(seen.at(-1).params, { speed: 0.5 });
  assert.equal(sweep.restoreSpeed, 0.5, 'the shutdown path learns the same speed');
  assert.equal(sweep.scriptName, SCRIPT_NAME);
});

test('the level and swap waits end at once when the game stops under them', async () => {
  const client = { sendCommand: async () => { throw new Error('Connection refused'); } };
  let looks = 0;
  const isRunning = async () => ++looks < 2;

  await assert.rejects(
    waitForLevel({ client, timeoutMs: 60000, sleep: async () => {}, isRunning }),
    (err) => err instanceof GameGoneError && /stopped while the sweep was waiting for the level/.test(err.message),
  );
  looks = 0;
  await assert.rejects(
    waitForSwap({ client, before: beforeSwap, timeoutMs: 15000, sleep: async () => {}, isRunning }),
    (err) => err instanceof GameGoneError && /bro swap/.test(err.message),
  );
  looks = 0;
  await assert.rejects(
    waitForSweepable({ client, timeoutMs: 60000, sleep: async () => {}, isRunning }),
    (err) => err instanceof GameGoneError,
  );

  let clock = 0;
  await assert.rejects(
    waitForLevel({ client, timeoutMs: 1000, sleep: async () => { clock += 500; }, now: () => clock, isRunning: async () => false }),
    (err) => !(err instanceof GameGoneError),
  );
});

test('sweepableProblem names what keeps a bro from being swept', () => {
  const ok = slotState(RAMBRO_OBJECT);
  assert.equal(sweepableProblem(ok, 0), null);
  assert.match(sweepableProblem({ ...ok, isInGame: false, scene: 'WorldMap3D' }, 0), /no level is being played \(scene WorldMap3D\)/);
  assert.match(sweepableProblem({ ...ok, pauseState: 'MenuPause' }, 0), /paused \(MenuPause\)/);
  assert.match(sweepableProblem({ ...ok, levelFinished: true }, 0), /level has finished/);
  assert.match(sweepableProblem({ ...ok, players: [{ ...ok.players[0], state: 'dead', isAlive: false }] }, 0), /player 0 is dead/);
  assert.match(sweepableProblem({ ...ok, players: [{ ...ok.players[0], piloting: 'Tank' }] }, 0), /piloting Tank/);
  assert.match(sweepableProblem(ok, 2), /no player in slot 2/);
});

test('runCapture waits out a pause before it sweeps, and refuses a bro that never becomes sweepable', { timeout: 20000 }, async (t) => {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'input-states.json');
  const outDir = path.join(dir, 'out');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));

  let polls = 0;
  let paused = 2;
  const seen = [];
  const stub = await startGameStub((request, socket) => {
    seen.push(request.method);
    if (request.method === 'game_state') {
      polls++;
      return reply(socket, request.id, slotState(RAMBRO_OBJECT, { pauseState: polls <= paused ? 'MenuPause' : 'UnPaused' }));
    }
    if (request.method === 'execute_script') writeNow(path.join(outDir, 'done'), '');
    reply(socket, request.id, { success: true });
  });
  const client = new UnityInspectorClient({ host: '127.0.0.1', port: stub.port });
  t.after(async () => { client.disconnect(); await stub.close(); });

  const options = { statesPaths: [statesPath], out: outDir, gameOut: outDir, timeoutMs: 5000, player: 0 };
  assert.equal((await runCapture(options, client, { pollMs: 5 })).outcome.status, 'done');
  assert.equal(seen.filter((method) => method === 'game_state').length, 3, 'it polled until the pause lifted');

  seen.length = 0;
  polls = 0;
  paused = Infinity;
  await assert.rejects(
    runCapture({ ...options, timeoutMs: 50 }, client, { pollMs: 5 }),
    /nothing was swept: after 0s the game is paused \(MenuPause\)/,
  );
  assert.ok(!seen.includes('execute_script'));
});

test('a sweep presses start past a cutscene pause and sweeps, and still refuses a menu pause with nothing pressed', { timeout: 20000 }, async (t) => {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'input-states.json');
  const outDir = path.join(dir, 'out');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));

  let pause = 'CutscenePause';
  const seen = [];
  const stub = await startGameStub((request, socket) => {
    seen.push(request.method);
    if (request.method === 'game_state') return reply(socket, request.id, slotState(RAMBRO_OBJECT, { pauseState: pause }));
    if (request.method === 'simulate_input') {
      seen.push(request.params);
      if (pause === 'CutscenePause') pause = 'UnPaused';
      return reply(socket, request.id, { success: true, action: 'start', duration: 200, player: 0, framesRead: 1 });
    }
    if (request.method === 'execute_script') writeNow(path.join(outDir, 'done'), '');
    reply(socket, request.id, { success: true });
  });
  const client = new UnityInspectorClient({ host: '127.0.0.1', port: stub.port });
  t.after(async () => { client.disconnect(); await stub.close(); });

  const sleep = async (ms) => { if (ms > 5) seen.push(`sleep ${ms}`); };
  const options = { statesPaths: [statesPath], out: outDir, gameOut: outDir, timeoutMs: 5000, player: 0 };
  const run = await runCapture(options, client, { pollMs: 5, sleep });
  assert.equal(run.outcome.status, 'done');
  const press = { action: 'start', duration: 200, player: 0 };
  assert.deepEqual(seen.slice(2, seen.indexOf('execute_script') + 1), [
    'game_state', 'simulate_input', press, 'game_state', `sleep ${DEFAULT_SETTLE_MS}`, 'game_state', 'execute_script',
  ], 'one press, then the settle the pause held the game through, then a last look before the script');
  assert.equal(run.summary.cutscenePresses, 1);
  assert.match(run.report, /^- Cutscene dismissed before the sweep: start pressed once$/m);

  seen.length = 0;
  pause = 'MenuPause';
  await assert.rejects(
    runCapture({ ...options, timeoutMs: 50 }, client, { pollMs: 5 }),
    (err) => /nothing was swept: after 0s the game is paused \(MenuPause\);/.test(err.message) && !/pressed/.test(err.message),
  );
  assert.ok(!seen.includes('simulate_input'), 'a menu pause is the caller\'s: nothing pressed');
  assert.ok(!seen.includes('execute_script'));
});

async function cutsceneStub(t, outDir) {
  const game = { pauseOn: null, paused: false, swapped: false, swappedWhilePaused: false, seen: [], named: false };
  const stub = await startGameStub((request, socket) => {
    game.seen.push(request.method);
    if (request.method === game.pauseOn) game.paused = true;
    if (request.method === 'game_state') {
      const pauseState = game.paused ? 'CutscenePause' : 'UnPaused';
      return reply(socket, request.id, slotState(game.swapped ? RAMBRO_OBJECT : AMERIBRO_OBJECT, { pauseState, isAlive: !(game.paused && game.named) }));
    }
    if (request.method === 'go_to_level' && game.named) {
      return reply(socket, request.id, { success: true, loaded: true, cutscene: 'CutscenePause', warning: 'A cutscene holds the game paused (CutscenePause) until a key is pressed' });
    }
    if (request.method === 'simulate_input') {
      game.paused = false;
      return reply(socket, request.id, { success: true, framesRead: 1 });
    }
    if (request.method === 'swap_bro') {
      if (game.paused && game.pauseOn !== 'swap_bro') game.swappedWhilePaused = true;
      game.swapped = true;
      return reply(socket, request.id, { success: true, broName: 'Rambro', objectName: RAMBRO_OBJECT });
    }
    if (request.method === 'execute_script') writeNow(path.join(outDir, 'done'), '');
    reply(socket, request.id, { success: true });
  });
  const client = new UnityInspectorClient({ host: '127.0.0.1', port: stub.port });
  t.after(async () => { client.disconnect(); await stub.close(); });
  game.client = client;
  game.sleep = async (ms) => { if (ms > 5) game.seen.push(`sleep ${ms}`); };
  game.reset = (pauseOn, named = false) => Object.assign(game, { pauseOn, named, paused: false, swapped: false, swappedWhilePaused: false, seen: [] });
  return game;
}

test('on a level sweep a cutscene is pressed past before the swap, the settle runs again on the live game, one go_to_level names is pressed past before the level wait, and none is pressed at the readiness wait', { timeout: 20000 }, async (t) => {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'input-states.json');
  const outDir = path.join(dir, 'out');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));
  const game = await cutsceneStub(t, outDir);

  const options = {
    level: { campaignIndex: 1, levelIndex: 0 }, bro: 'Rambro', settleMs: 1700, swapSettleMs: 700, swapTimeoutMs: 5000,
    statesPaths: [statesPath], out: outDir, gameOut: outDir, timeoutMs: 5000, player: 0,
  };
  game.reset('go_to_level');
  const run = await runCapture(options, game.client, { pollMs: 5, sleep: game.sleep });
  assert.equal(run.outcome.status, 'done');
  assert.deepEqual(game.seen, [
    'ping', 'execute_code', 'go_to_level', 'game_state', 'sleep 1700', 'game_state', 'simulate_input', 'game_state', 'sleep 1700',
    'game_state', 'swap_bro', 'game_state', 'sleep 700', 'game_state', 'execute_script', 'unload_script',
  ], 'the press, then the settle on the live game, then the swap');
  assert.equal(game.swappedWhilePaused, false);
  assert.equal(run.summary.cutscenePresses, 1);
  assert.match(run.report, /^- Cutscene dismissed before the sweep: start pressed once$/m);

  game.reset('go_to_level', true);
  const named = await runCapture(options, game.client, { pollMs: 5, sleep: game.sleep });
  assert.equal(named.outcome.status, 'done');
  assert.deepEqual(game.seen, [
    'ping', 'execute_code', 'go_to_level', 'game_state', 'simulate_input', 'game_state', 'game_state', 'game_state', 'sleep 1700',
    'game_state', 'swap_bro', 'game_state', 'sleep 700', 'game_state', 'execute_script', 'unload_script',
  ], 'a cutscene go_to_level names, its bro held off the level, is pressed past before the level wait and the settle');
  assert.equal(named.summary.cutscenePresses, 1);

  game.reset('swap_bro');
  await assert.rejects(
    runCapture({ ...options, timeoutMs: 300 }, game.client, { pollMs: 5, sleep: game.sleep }),
    (err) => /nothing was swept: after 0s the game is paused \(CutscenePause\); last game_state:/.test(err.message),
  );
  assert.ok(!game.seen.includes('simulate_input'), 'a cutscene the level path missed is not pressed after the swap');
});

test('without a level a cutscene up before the swap is pressed past first, and one starting after it at the readiness wait', { timeout: 20000 }, async (t) => {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'input-states.json');
  const outDir = path.join(dir, 'out');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));
  const game = await cutsceneStub(t, outDir);

  const options = {
    level: null, bro: 'Rambro', settleMs: 1234, swapSettleMs: 700, swapTimeoutMs: 5000,
    statesPaths: [statesPath], out: outDir, gameOut: outDir, timeoutMs: 5000, player: 0,
  };
  game.reset('ping');
  assert.equal((await runCapture(options, game.client, { pollMs: 5, sleep: game.sleep })).outcome.status, 'done');
  assert.deepEqual(game.seen, [
    'ping', 'execute_code', 'game_state', 'simulate_input', 'game_state', `sleep ${DEFAULT_SETTLE_MS}`,
    'game_state', 'swap_bro', 'game_state', 'sleep 700', 'game_state', 'execute_script', 'unload_script',
  ], 'pressed and settled before the swap; settle is a level\'s and does not apply');
  assert.equal(game.swappedWhilePaused, false);

  game.reset('swap_bro');
  assert.equal((await runCapture(options, game.client, { pollMs: 5, sleep: game.sleep })).outcome.status, 'done');
  assert.deepEqual(game.seen, [
    'ping', 'execute_code', 'game_state', 'swap_bro', 'game_state', 'sleep 700', 'game_state', 'simulate_input', 'game_state',
    `sleep ${DEFAULT_SETTLE_MS + 700}`, 'game_state', 'execute_script', 'unload_script',
  ], 'pressed at the readiness wait, then the settle and the swap settle again');
});

test('the readiness wait presses again only once a cutscene has outlasted a press by a few seconds, settles once it clears, and names the presses when it never clears', async () => {
  let clock = 0;
  let pause = 'CutscenePause';
  const presses = [];
  let answer = { success: true, framesRead: 1 };
  const client = {
    sendCommand: async (method, params) => {
      if (method === 'game_state') return slotState(RAMBRO_OBJECT, { player: 2, pauseState: pause });
      assert.equal(method, 'simulate_input');
      assert.deepEqual(params, { action: 'start', duration: 200, player: 2 });
      presses.push(clock);
      if (presses.length === 2 && answer.success) pause = 'UnPaused';
      return answer;
    },
  };
  const sleeps = [];
  const waits = { client, player: 2, timeoutMs: 10000, settleMs: 5000, sleep: async (ms) => { sleeps.push(ms); clock += 500; }, now: () => clock };

  const cutscene = {};
  const ready = await waitForSweepable({ ...waits, cutscene });
  assert.equal(ready.pauseState, 'UnPaused');
  assert.deepEqual(presses, [0, CUTSCENE_REPRESS_MS], 'the first press ignored, the second sent a few seconds later');
  assert.equal(cutscene.presses, 2);
  assert.deepEqual(sleeps.filter((ms) => ms !== 500), [5000], 'one settle once the pause cleared');
  assert.equal(sleeps[sleeps.length - 1], 5000, 'and a last look after it');

  pause = 'UnPaused';
  presses.length = 0;
  sleeps.length = 0;
  await waitForSweepable({ ...waits, cutscene: {} });
  assert.deepEqual([presses, sleeps], [[], []], 'no cutscene, no press and no settle');

  clock = 0;
  pause = 'CutscenePause';
  answer = { success: false, error: 'no frame read the press' };
  await assert.rejects(
    waitForSweepable({ ...waits, cutscene: {} }),
    /nothing was swept: after 10s the game is paused \(CutscenePause\); start was pressed 4 times to dismiss a cutscene, the last press answering: no frame read the press; last game_state:/,
  );
  assert.deepEqual(presses, [0, 3000, 6000, 9000]);

  clock = 0;
  presses.length = 0;
  await assert.rejects(
    waitForSweepable(waits),
    (err) => /after 10s the game is paused \(CutscenePause\); last game_state:/.test(err.message),
    'with no cutscene record, as on a level sweep, nothing is pressed',
  );
  assert.deepEqual(presses, []);
});

test('a swap that leaves another bro in the slot is refused before it is swept', { timeout: 20000 }, async (t) => {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'input-states.json');
  const outDir = path.join(dir, 'out');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));

  const seen = [];
  const stub = await startStubServer((request, socket) => {
    seen.push(request);
    if (request.method === 'swap_bro') return reply(socket, request.id, { success: true, broName: 'Rambro', objectName: RAMBRO_OBJECT });
    if (request.method === 'list_bros') return reply(socket, request.id, { success: true, currentBro: 'Rambro' });
    if (request.method === 'game_state') return reply(socket, request.id, slotState(RAMBRO_OBJECT));
    reply(socket, request.id, { success: true });
  });
  const client = new UnityInspectorClient({ host: '127.0.0.1', port: stub.port });
  t.after(async () => { client.disconnect(); await stub.close(); });

  await assert.rejects(
    runCapture({ bro: 'Jason Brohees', swapSettleMs: 0, statesPaths: [statesPath], out: outDir, gameOut: outDir, timeoutMs: 5000, player: 0 }, client, { pollMs: 5 }),
    /Slot 0 holds "Rambro" after the swap to "Jason Brohees", so nothing was swept/,
  );
  assert.deepEqual(seen.find((request) => request.method === 'list_bros').params, { playerNum: 0 });
  assert.ok(!seen.some((request) => request.method === 'execute_script'));
});

test('confirmBro compares the roster name without regard to case, and says when list_bros cannot', async () => {
  const answering = (reply) => ({ sendCommand: async () => reply });
  assert.equal(await confirmBro({ client: answering({ success: true, currentBro: 'Drunken Broster' }), bro: 'drunken broster' }), 'Drunken Broster');
  await assert.rejects(confirmBro({ client: answering({ success: false, error: 'Swap Bros Mod is required' }), bro: 'X' }), /list_bros could not confirm the swap to "X": Swap Bros Mod is required/);
  await assert.rejects(confirmBro({ client: answering({ success: true, currentBro: null }), bro: 'X' }), /holds no bro list_bros can name/);
});

test('waitForSentinel bounds a stall, not a sweep: progress in capture.json moves the deadline on', async (t) => {
  const dir = await tempDir(t);
  const progressFile = path.join(dir, 'capture.json');
  let clock = 0;
  let polls = 0;

  const result = await waitForSentinel({
    dir,
    timeoutMs: 100,
    pollMs: 50,
    now: () => clock,
    progressFile,
    sleep: async () => {
      clock += 50;
      polls++;
      if (polls <= 10 && polls % 2 === 0) await fs.writeFile(progressFile, `{"states":${polls}}`);
    },
  });

  assert.equal(result.status, 'timeout');
  assert.ok(clock >= 600, `it gave up at ${clock}ms, inside a sweep that was still making progress`);
  assert.match(result.message, /without progress/);
});

test('the reply caps the state errors and points at the rest', { timeout: 30000 }, async (t) => {
  const dir = await tempDir(t);
  const outDir = path.join(dir, 'out');
  const statesPath = path.join(dir, 'input-states.json');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));
  const errors = Array.from({ length: CAPTURE_REPLY_STATE_ERRORS + 5 }, (_, index) => `state 's${index}': failed`);
  await finishingStub(t, outDir, { capture: { bro: { type: 'Rambro' }, errors, states: [] } });

  const payload = await sweepPayload({ out: outDir, states: [statesPath], timeout: 5 });
  assert.equal(payload.stateErrors.length, CAPTURE_REPLY_STATE_ERRORS);
  assert.equal(payload.stateErrorsOmitted, 5);
  assert.equal(payload.summary.errors, CAPTURE_REPLY_STATE_ERRORS + 5, 'the report still counts them all');
  assert.match(await fs.readFile(path.join(outDir, 'report.md'), 'utf-8'), /state 's24': failed/);
});

test('state names that would write one strip file are refused before anything is sent', async (t) => {
  assert.deepEqual(stripCollisions([{ name: 'a b' }, { name: 'a_b' }, { name: 'Run' }, { name: 'run' }, { name: 'idle' }]), [
    '"a b" and "a_b" would both write a_b.png',
    '"Run" and "run" would both write run.png',
  ]);

  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'states.json');
  await fs.writeFile(statesPath, JSON.stringify([{ name: 'a b', step: { values: [0] } }, { name: 'a_b', step: { values: [0] } }]));
  const sent = [];
  await assert.rejects(
    runCapture({ statesPaths: [statesPath], out: path.join(dir, 'out'), gameOut: path.join(dir, 'out'), timeoutMs: 1000, player: 0 },
      { sendCommand: async (method) => { sent.push(method); return {}; } }),
    (err) => err instanceof UsageError && /collide as strip files/.test(err.message),
  );
  assert.deepEqual(sent, []);
});

test('validateStates refuses a setup, requires or step pin block that the game would read as nothing', () => {
  const { errors } = validateStates([
    { name: 'list_setup', setup: ['actionState'], step: { values: [0] } },
    { name: 'list_requires', requires: ['useNewFrames'], step: { values: [0] } },
    { name: 'nested', setup: { actionState: { name: 'Idle' } }, step: { values: [0] } },
    { name: 'pins_no_call', step: { values: [0], before: { gunCounter: 0.04 } } },
    { name: 'bad_call', step: { values: [0], call: [] } },
    { name: 'bad_provide', provide: 'rope', step: { values: [0] } },
    { name: 'ok', setup: { actionState: 'Idle', health: 3, fire: true }, requires: { useNewFrames: true },
      provide: 'ladder', step: { values: [4, 3], call: ['RunGun'], before: { gunCounter: 0.04 }, after: { gunCounter: 0 } } },
  ]);
  assert.deepEqual(errors, [
    'list_setup: setup must be an object of field values',
    'list_requires: requires must be an object of field values',
    'nested: setup holds values that are not a boolean, number or string: actionState',
    'pins_no_call: step.before pins fields around step.call, so it needs one',
    'bad_call: step.call must be a non-empty list of method names',
    'bad_provide: provide must be one of zipline, ladder',
  ]);
});

test('capture_animations refuses a box past 256, a gameOut the game cannot resolve, and a malformed only', async (t) => {
  const out = path.join(await tempDir(t), 'out');
  assert.match(textOf(await callCapture({ out, box: 300 })), /box must be a number >= 1 and <= 256/);
  assert.match(textOf(await callCapture({ out, gameOut: 'captures/out' })), /gameOut must be an absolute path as the game sees it/);
  assert.match(textOf(await callCapture({ out, only: [] })), /only must be a non-empty list of state names/);
  assert.match(textOf(await callCapture({ out, only: ['idle', 'idle'] })), /only names "idle" more than once/);

  for (const absolute of ['/tmp/out', 'C:\\out', 'Z:/out', '\\\\host\\share\\out']) assert.ok(isAbsoluteGamePath(absolute), absolute);
  for (const relative of ['out', 'C:out', '.\\out']) assert.ok(!isAbsoluteGamePath(relative), relative);
});

test('capture_animations names a missing state list and an output directory it cannot write in plain words', { timeout: 30000 }, async (t) => {
  const dir = await tempDir(t);
  await finishingStub(t, path.join(dir, 'out'));

  const missing = path.join(dir, 'nope.json');
  const text = textOf(await callCapture({ out: path.join(dir, 'out'), states: [missing], timeout: 5 }));
  assert.match(text, new RegExp(`No state list at ${missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: states names a JSON state list file`));
  assert.doesNotMatch(text, /ENOENT: no such file/);

  const blocked = path.join(dir, 'blocked');
  await fs.writeFile(blocked, '');
  const unwritable = textOf(await callCapture({ out: path.join(blocked, 'out'), timeout: 5 }));
  assert.match(unwritable, /must be a directory this server can (create and )?write/);
  assert.doesNotMatch(unwritable, /^Error: ENOTDIR/);
});

test('only sweeps the named states in merged-list order, and the report says how many of how many', { timeout: 30000 }, async (t) => {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'input-states.json');
  const outDir = path.join(dir, 'out');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));
  await finishingStub(t, outDir, { capture: { bro: {}, errors: [], states: [] } });

  const payload = await sweepPayload({ out: outDir, states: [statesPath], only: ['never_run', 'running'], timeout: 5 });
  assert.deepEqual(await copiedStateNames(outDir), ['running', 'never_run'], 'the merged list decides the order');
  assert.match(payload.report, /- Only: 2 of 4 states/);
  assert.match(payload.report, /## Never reached \(2\)\n\n- running\n- never_run/, 'only the named states are missing');

  const unknown = textOf(await callCapture({ out: outDir, states: [statesPath], only: ['running', 'flying'], timeout: 5 }));
  assert.match(unknown, /only names "flying", not in the merged state list/);
});

test('selectOnly keeps the merged order and refuses a name the list does not have', () => {
  const states = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
  assert.deepEqual(selectOnly(states, null), states);
  assert.deepEqual(selectOnly(states, ['c', 'a']).map((state) => state.name), ['a', 'c']);
  assert.throws(() => selectOnly(states, ['a', 'z']), (err) => err instanceof UsageError && /"z"/.test(err.message));
});

test('the sweep parameters travel with the state list into capture.json, and the report says whether side effects ran', { timeout: 30000 }, async (t) => {
  const dir = await tempDir(t);
  const statesPath = path.join(dir, 'input-states.json');
  const outDir = path.join(dir, 'out');
  await fs.writeFile(statesPath, JSON.stringify({ states: fixtureStates }));
  await finishingStub(t, outDir, { capture: { bro: {}, errors: [], states: [] } });

  const payload = await sweepPayload({ out: outDir, states: [statesPath], allowSideEffects: true, box: 20, level: '1:0', settle: 0, timeout: 5 });
  const copied = JSON.parse(await fs.readFile(path.join(outDir, STATES_COPY_NAME), 'utf-8'));
  assert.deepEqual(copied.params, {
    allowSideEffects: true, includeLethal: false, only: null, states: [statesPath], level: '1:0', bro: null, box: 20,
  });
  assert.match(payload.report, /- Side effects: allowed/);

  const quiet = await sweepPayload({ out: outDir, states: [statesPath], timeout: 5 });
  assert.match(quiet.report, /- Side effects: suppressed/);
  assert.doesNotMatch(quiet.report, /- Only:/);
});

test('the report dates the first level change and lists each record that changed the level', () => {
  const states = [{ name: 'idle', step: { values: [0] } }, { name: 'elbow_slam', step: { values: [0] } }, { name: 'after', step: { values: [0] } }];
  const none = { blocks: [], units: [], doodads: [] };
  const capture = {
    bro: {},
    errors: [],
    states: [
      { name: 'idle', skipped: null, frames: [], levelChanges: none, suppressed: [], damageCalls: [] },
      {
        name: 'elbow_slam',
        skipped: null,
        frames: [],
        levelChanges: {
          blocks: [
            { layer: 'foreground', col: 12, row: 3, name: 'DirtBlock5(Clone)', change: 'destroyed', health: [10, 0] },
            { layer: 'foreground', col: 13, row: 3, name: 'DirtBlock5(Clone)', change: 'destroyed', health: [10, null] },
            { layer: 'background', col: 13, row: 4, name: 'Bg(Clone)', change: 'damaged', health: [10, 4] },
            { layer: 'foreground', col: 2, row: 1, name: 'SandBlock(Clone)', change: 'disturbed', health: [3, 3] },
          ],
          units: [],
          doodads: [{ id: -5678, name: 'Grass(Clone)', change: 'destroyed', health: [1, null] }],
        },
        suppressed: [],
        damageCalls: [{ method: 'MapController.DamageGround', calls: 2, hits: null }, { method: 'Map.HitUnits', calls: 1, hits: 1 }],
      },
      { name: 'after', skipped: null, frames: [], levelChanges: { ...none, units: [{ id: -1, name: 'Mook(Clone)', change: 'killed', health: [3, 0] }] }, suppressed: [{ method: 'Map.HitUnits', calls: 3 }], damageCalls: [] },
    ],
  };

  const { text, summary } = buildReport({ capture, states, outDir: '/tmp/shots', options: {} });
  assert.match(text, /- First level change: elbow_slam/);
  assert.match(text, /## Level changes \(2\)\n\n- \*\*elbow_slam\*\* — blocks: 2 destroyed, 1 damaged, 1 disturbed; doodads: 1 destroyed\n- \*\*after\*\* — units: 1 killed/);
  assert.match(text, /## Damage calls \(2\)\n\n- \*\*elbow_slam\*\* — ran MapController\.DamageGround ×2, Map\.HitUnits ×1, 1 hit\n- \*\*after\*\* — suppressed Map\.HitUnits ×3/);
  assert.equal(summary.firstLevelChange, 'elbow_slam');
  assert.equal(summary.levelChangeStates, 2);

  const quiet = buildReport({ capture: { ...capture, states: [capture.states[0]] }, states, outDir: '/tmp/shots', options: {} });
  assert.match(quiet.text, /- First level change: none/);
  assert.match(quiet.text, /## Level changes \(0\)\n\n_none_/);
  assert.equal(describeLevelChanges(none), '');
});

test('a sweep cut short is reported as the states it finished, the rest never reached', () => {
  const capture = {
    bro: {},
    complete: false,
    errors: [],
    states: [{ name: 'running', skipped: null, frames: [{ step: 0, body: { row: 2, col: 0 } }, { step: 1, body: { row: 2, col: 1 } }] }],
  };
  const { text, summary } = buildReport({ capture, states: fixtureStates, outDir: '/tmp/shots', options: {} });
  assert.match(text, /- Capture incomplete: the sweep stopped after 1 of 4 states/);
  assert.match(text, /## Captured \(1\)/);
  assert.match(text, /## Never reached \(3\)/);
  assert.equal(summary.complete, false);
});

test('a descending walk and a held cell are walks too', () => {
  const recoil = { name: 'idle_firing', step: { values: [4, 3, 2, 1] }, expectGun: { row: 1, cols: [3, 0] } };
  assert.deepEqual(expectedSequence(recoil, 'expectGun'), [[1, 3], [1, 2], [1, 1], [1, 0]]);
  const held = { name: 'hanging_one_armed', step: { values: [0, 1, 2] }, expectGun: { row: 2, col: 6 } };
  assert.deepEqual(expectedSequence(held, 'expectGun'), [[2, 6], [2, 6], [2, 6]]);
  assert.equal(describeExpectation(held.expectGun, 'gun'), 'gun row 2 col 6 held');
  assert.deepEqual(validateStates([recoil, held]).errors, []);
  assert.deepEqual(validateStates([{ name: 'both', step: { values: [0] }, expect: { row: 1, col: 2, cols: [2, 2] } }]).errors,
    ['both: expect takes col (a held cell) or cols (a walk), not both']);
});

test('a carried-over cell never satisfies an expectation, and the report counts and lists the carried gun frames', () => {
  const states = [{ name: 'hanging_one_armed', step: { values: [0, 1] }, expectGun: { row: 2, col: 6 } }];
  const frames = (written) => [0, 1].map((step) => ({
    step,
    body: { row: 4, col: 23 + step, written: 'capture' },
    gun: { row: 2, col: 6, enabled: true, written },
  }));

  const carried = buildReport({ capture: { bro: {}, errors: [], states: [{ name: 'hanging_one_armed', skipped: null, frames: frames('carried') }] }, states, outDir: '/tmp', options: {} });
  assert.equal(carried.summary.mismatches, 1, 'the right cell, left over from before the step, is no proof');
  assert.match(carried.text, /- Frames with a carried-over gun cell: 2/);
  assert.match(carried.text, /## Carried-over gun cells \(1\)\n\n- \*\*hanging_one_armed\*\* — frames 0-1/);
  assert.deepEqual(carriedGunFrames(frames('carried')), [0, 1]);

  const drawn = buildReport({ capture: { bro: {}, errors: [], states: [{ name: 'hanging_one_armed', skipped: null, frames: frames('capture') }] }, states, outDir: '/tmp', options: {} });
  assert.equal(drawn.summary.mismatches, 0);
  assert.match(drawn.text, /- Frames with a carried-over gun cell: 0/);
  assert.deepEqual(cellSequence(frames('game'), 'gun'), [[2, 6], [2, 6]], 'a cell the game drew is still the step\'s cell');
});

test('a frame on an empty body cell is counted even when the gun drew something', () => {
  const states = [{ name: 'custom', step: { values: [0, 1] } }];
  const capture = {
    bro: {},
    errors: [],
    states: [{
      name: 'custom',
      skipped: null,
      frames: [
        { step: 0, contributed: true, bodyCellEmpty: true, gunCellEmpty: false, body: { row: 1, col: 0 } },
        { step: 1, contributed: true, bodyCellEmpty: false, body: { row: 1, col: 1 } },
      ],
    }],
  };
  const { text, summary } = buildReport({ capture, states, outDir: '/tmp', options: {} });
  assert.equal(summary.emptyCellFrames, 1);
  assert.match(text, /## Empty sheet cells \(1\)\n\n- \*\*custom\*\* — body frames 0/);
});

test('the base list draws the gun the way the game does, recoil included, and gives the ladder and zipline states what they need', async () => {
  const states = await loadStates([DEFAULT_STATES_PATH]);
  const named = (name) => states.find((state) => state.name === name);

  const hanging = named('hanging_one_armed');
  assert.deepEqual(hanging.step.call, ['StartHanging']);
  assert.deepEqual(hanging.expectGun, { sheet: 'gun', row: 2, col: 6 });

  for (const [name, cols] of [['idle_firing', [3, 0]], ['idle_ducking_firing', [3, 0]], ['running_firing', [3, 0]],
    ['jumping_firing', [3, 0]], ['hanging_firing', [9, 6]], ['zipline_firing', [9, 6]]]) {
    const state = named(name);
    assert.ok(state, name);
    assert.equal(state.setup.fire, true, name);
    assert.deepEqual(state.step, { field: 'gunFrame', values: [4, 3, 2, 1], before: { gunCounter: 0.04 }, call: ['RunGun'], after: { gunCounter: 0 } }, name);
    assert.deepEqual(state.expectGun.cols, cols, name);
  }

  for (const name of ['idle', 'running', 'pushing', 'jumping_rising_slow']) assert.equal(named(name).setup.gunFrame, 0, name);
  for (const name of ['ladder_climb_up', 'ladder_climb_down', 'ladder_one_armed_hang', 'ladder_climb_legacy']) {
    assert.equal(named(name).provide, 'ladder', name);
    assert.equal(named(name).unsupported, undefined, name);
  }
  for (const name of ['zipline_moving', 'zipline_hanging', 'zipline_firing']) assert.equal(named(name).provide, 'zipline', name);
  assert.deepEqual(named('zipline_hanging').step.call, ['AttachToZipline']);
});

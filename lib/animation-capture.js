// The host side of the animation-capture sweep: loads the level, swaps the bro, runs the in-game
// script, waits for its sentinel file, then reports which sheet cells each state addressed. The
// capture_animations tool in index.js is what drives it; nothing here imports index.js.

import { randomBytes } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import { isGameRunning } from './game-process.js';
import { linesBackward, markLogEnd, markedStart } from './log-delta.js';
import { cancelledError, commandTimeout } from './unity-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const CAPTURE_DIR = path.join(__dirname, 'animation-capture');
export const SCRIPT_PATH = path.join(CAPTURE_DIR, 'animation-capture.cs');
export const SCRIPT_NAME = `animation-capture-${process.pid}-${randomBytes(3).toString('hex')}`;
export const CAPTURE_STATES_DIR = path.join(CAPTURE_DIR, 'states');
export const DEFAULT_STATES_PATH = path.join(CAPTURE_STATES_DIR, 'base-states.json');
export const STATES_COPY_NAME = 'states.json';
export const DONE_FILE = 'done';
export const ERROR_FILE = 'error';
export const CAPTURE_FILE = 'capture.json';
export const REPORT_FILE = 'report.md';
export const OUT_MARKER = '.capture-animations';
export const OUT_MARKER_TEXT = 'capture_animations output directory: every .png here is deleted before each sweep\n';

// Everything animation-capture.cs logs is prefixed [Script:animation-capture] by the mod, so this
// picks its lines out of the game log when the wait times out
export const LOG_MARKER = 'animation-capture';

// A level reports a live player about a second before it renders the world, and there is nothing in
// game_state that says which side of that the game is on
export const DEFAULT_SETTLE_MS = 3000;

// swap_bro returns before the new character is on screen: the old one keeps rendering for a beat,
// and a sweep that freezes the clock in that window strips the wrong bro
export const DEFAULT_SWAP_SETTLE_MS = 2000;

// A swap that lands shows up within a second or two, so the poll that confirms it is not worth the
// whole sweep timeout: an unchanged slot should be reported quickly, not sit out the full sweep timeout
export const DEFAULT_SWAP_TIMEOUT_MS = 15000;

export const DEFAULT_TIMEOUT_MS = 60000;

export const DEFAULT_BOX = 24;

const CUTSCENE_PRESS = { action: 'start', duration: 200 };
export const CUTSCENE_REPRESS_MS = 3000;

export class UsageError extends Error {}

// go_to_level takes the pair as two numbers; the tool takes them the way list_campaigns prints them
export function parseLevel(raw) {
  const match = /^(\d+):(\d+)$/.exec(String(raw).trim());
  if (!match) throw new UsageError(`level must be CAMPAIGN:LEVEL with two integers, got "${raw}"`);
  return { campaignIndex: Number(match[1]), levelIndex: Number(match[2]) };
}

// The game may run under Proton, where the output directory is a Windows-view path
export function joinGamePath(base, name) {
  const windows = base.includes('\\') || /^[A-Za-z]:/.test(base);
  const separator = windows ? '\\' : '/';
  const trimmed = base.replace(/[\\/]+$/, '');
  return `${trimmed}${separator}${name}`;
}

export function isAbsoluteGamePath(raw) {
  return /^\//.test(raw) || /^[A-Za-z]:[\\/]/.test(raw) || /^\\\\[^\\]/.test(raw);
}

export function stripName(name) {
  return `${String(name).replace(/[^A-Za-z0-9._-]/g, '_')}.png`;
}

function isPinValue(value) {
  return typeof value === 'boolean' || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

function pinProblem(label, block) {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return `${label} must be an object of field values`;
  const bad = Object.entries(block).filter(([, value]) => !isPinValue(value)).map(([key]) => key);
  return bad.length > 0 ? `${label} holds values that are not a boolean, number or string: ${bad.join(', ')}` : null;
}

function methodListProblem(label, names) {
  if (!Array.isArray(names) || names.length === 0) return `${label} must be a non-empty list of method names`;
  if (!names.every((entry) => typeof entry === 'string' && entry.trim() !== '')) return `${label} must hold method names`;
  return null;
}

export const PROVIDED_OBJECTS = ['zipline', 'ladder'];

export function validateStates(doc) {
  const states = Array.isArray(doc) ? doc : doc && Array.isArray(doc.states) ? doc.states : null;
  if (!states) return { states: [], errors: ['the state file is neither an array nor an object with a states array'] };

  const errors = [];
  const seen = new Set();

  states.forEach((state, index) => {
    const label = `entry ${index}`;
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      errors.push(`${label}: not an object`);
      return;
    }

    const name = state.name;
    if (typeof name !== 'string' || name.trim() === '') {
      errors.push(`${label}: missing a name`);
      return;
    }
    if (seen.has(name)) errors.push(`${name}: duplicate name`);
    seen.add(name);

    if (typeof state.unsupported === 'string' && state.unsupported.trim() !== '') return;
    if ('unsupported' in state) {
      errors.push(`${name}: unsupported must be a non-empty reason string`);
      return;
    }

    for (const field of ['setup', 'requires']) {
      if (!(field in state)) continue;
      const problem = pinProblem(field, state[field]);
      if (problem) errors.push(`${name}: ${problem}`);
    }

    // The game resolves these against the live character, so all this side can check is the shape
    for (const phase of ['before', 'after']) {
      if (!(phase in state)) continue;
      const problem = methodListProblem(phase, state[phase]);
      if (problem) errors.push(`${name}: ${problem}`);
    }
    if ('insert_before' in state && (typeof state.insert_before !== 'string' || state.insert_before.trim() === '')) {
      errors.push(`${name}: insert_before must name a state`);
    }
    if ('provide' in state && !PROVIDED_OBJECTS.includes(state.provide)) {
      errors.push(`${name}: provide must be one of ${PROVIDED_OBJECTS.join(', ')}`);
    }

    const step = state.step;
    if (!step || typeof step !== 'object') {
      errors.push(`${name}: needs a step block or an unsupported reason`);
      return;
    }
    if (!Array.isArray(step.values) || step.values.length === 0) {
      errors.push(`${name}: step.values must hold at least one value`);
    }
    if ('field' in step && (typeof step.field !== 'string' || step.field.trim() === '')) {
      errors.push(`${name}: step.field must be a field name`);
    }
    if ('call' in step) {
      const problem = methodListProblem('step.call', step.call);
      if (problem) errors.push(`${name}: ${problem}`);
    }
    for (const phase of ['before', 'after']) {
      if (!(phase in step)) continue;
      if (!('call' in step)) errors.push(`${name}: step.${phase} pins fields around step.call, so it needs one`);
      const problem = pinProblem(`step.${phase}`, step[phase]);
      if (problem) errors.push(`${name}: ${problem}`);
    }

    // Without this the entry has no well-formed walk, so nothing could ever match it and the
    // report would only say so after a whole sweep had run
    for (const field of ['expect', 'expectGun']) {
      const expect = state[field];
      if (!expect || typeof expect !== 'object') continue;
      const held = 'col' in expect;
      if (!held && !Array.isArray(expect.cols)) continue;

      // The row is what turns a column span into cells: without one the walk is unbuildable, and the
      // state would otherwise sweep, render an empty expectation and be counted a mismatch
      if (typeof expect.row !== 'number') errors.push(`${name}: ${field}.row must be a number`);
      if (held) {
        if ('cols' in expect) errors.push(`${name}: ${field} takes col (a held cell) or cols (a walk), not both`);
        if (!Number.isInteger(expect.col)) errors.push(`${name}: ${field}.col must be an integer`);
        continue;
      }
      if (!Array.isArray(step.values)) continue;

      const [from, to] = expect.cols;
      if (expect.cols.length !== 2 || !Number.isInteger(from) || !Number.isInteger(to)) {
        errors.push(`${name}: ${field}.cols must be [from, to], two integers`);
      } else if (Math.abs(to - from) + 1 !== step.values.length) {
        errors.push(
          `${name}: ${step.values.length} step value(s) for ${field} columns ${from}-${to} (${Math.abs(to - from) + 1} cells)`,
        );
      }
    }
  });

  return { states, errors };
}

// A per-bro list restates only the entries that differ, so a later layer replaces an earlier
// entry of the same name and keeps its position; anything new is appended. A new entry that names
// insert_before goes in ahead of that state instead, for one whose setup a later state would spoil.
export function mergeStates(layers) {
  const merged = [];
  const indexOf = (name) => merged.findIndex((entry) => entry.name === name);

  for (const layer of layers) {
    for (const state of layer) {
      const existing = indexOf(state.name);
      if (existing !== -1) {
        merged[existing] = state;
        continue;
      }
      if (state.insert_before === undefined) {
        merged.push(state);
        continue;
      }

      // Checked here and not in validateStates: the state it names is usually in another layer
      const anchor = indexOf(state.insert_before);
      if (anchor === -1) {
        throw new UsageError(
          `${state.name}: insert_before names "${state.insert_before}", which is not in the merged state list`,
        );
      }
      merged.splice(anchor, 0, state);
    }
  }
  return merged;
}

export function selectOnly(states, only) {
  if (only === null || only === undefined) return states;

  const known = new Set(states.map((state) => state.name));
  const unknown = only.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new UsageError(`only names ${unknown.map((name) => `"${name}"`).join(', ')}, not in the merged state list`);
  }
  const wanted = new Set(only);
  return states.filter((state) => wanted.has(state.name));
}

export function partitionLethal(states, includeLethal) {
  if (includeLethal) return { states, excluded: [] };
  return {
    states: states.filter((state) => !state.lethal),
    excluded: states.filter((state) => state.lethal),
  };
}

export function stripCollisions(states) {
  const byFile = new Map();
  for (const state of states) {
    const file = stripName(state.name).toLowerCase();
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(state.name);
  }
  return [...byFile.entries()].filter(([, names]) => names.length > 1)
    .map(([file, names]) => `${names.map((name) => `"${name}"`).join(' and ')} would both write ${file}`);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cancellableSleep(sleep, signal) {
  if (!signal) return sleep;
  return async (ms) => {
    throwIfCancelled(signal);
    let wake;
    const aborted = new Promise((resolve) => { wake = resolve; });
    signal.addEventListener('abort', wake, { once: true });
    try {
      await Promise.race([sleep(ms), aborted]);
    } finally {
      signal.removeEventListener('abort', wake);
    }
    throwIfCancelled(signal);
  };
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw cancelledError('capture_animations');
}

async function readIfPresent(file) {
  try {
    return await fs.readFile(file, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function statSignature(file) {
  try {
    const stat = await fs.stat(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

function gameWatch(isRunning) {
  let sawAlive = false;
  return async () => {
    if (!isRunning) return false;
    let alive = null;
    try {
      alive = await isRunning();
    } catch {
      alive = null;
    }
    if (alive === true) sawAlive = true;
    return alive === false && sawAlive;
  };
}

export class GameGoneError extends Error {}

export async function waitForSentinel({
  dir,
  timeoutMs,
  pollMs = 500,
  sleep = delay,
  now = Date.now,
  isRunning = null,
  progressFile = null,
}) {
  let deadline = now() + timeoutMs;
  let progress = progressFile ? await statSignature(progressFile) : null;
  const gone = gameWatch(isRunning);

  for (;;) {
    // Read error first: a failed sweep never writes done, and a stale done must not mask it
    const failure = await readIfPresent(path.join(dir, ERROR_FILE));
    if (failure !== null) {
      return { status: 'error', message: failure.trim() || 'the script reported an unspecified failure' };
    }
    if ((await readIfPresent(path.join(dir, DONE_FILE))) !== null) return { status: 'done' };

    if (await gone()) {
      return {
        status: 'game-gone',
        message: `the game stopped while the sweep was running; nothing more will be written to ${dir}`,
      };
    }

    if (progressFile) {
      const current = await statSignature(progressFile);
      if (current !== progress) {
        progress = current;
        deadline = now() + timeoutMs;
      }
    }

    if (now() >= deadline) {
      return {
        status: 'timeout',
        message: `no ${DONE_FILE} or ${ERROR_FILE} in ${dir} after ${Math.round(timeoutMs / 1000)}s without progress`,
      };
    }
    await sleep(pollMs);
  }
}

export function playerSlots(state) {
  const players = state && typeof state === 'object' ? state.players : null;
  return Array.isArray(players) ? players : null;
}

export function slotOf(state, player) {
  const slots = playerSlots(state);
  if (slots === null) return null;

  const slot = slots.find((entry) => entry && entry.playerIndex === player);
  return slot === undefined ? null : slot;
}

export function levelIsReady(state, player = 0, levelIndex = null) {
  if (!state || state.isInGame !== true || state.levelFinished === true) return false;
  if (levelIndex !== null && state.levelIndex !== levelIndex) return false;

  const slot = slotOf(state, player);
  return slot !== null && slot.isAlive === true;
}

export function sweepableProblem(state, player = 0) {
  if (playerSlots(state) === null) return describeGameState(state);
  if (state.isInGame !== true) return `no level is being played (scene ${state.scene ?? 'unknown'})`;
  if (state.levelFinished === true) return 'the level has finished';
  if (state.pauseState && state.pauseState !== 'UnPaused') return `the game is paused (${state.pauseState})`;

  const slot = slotOf(state, player);
  if (slot === null) return `no player in slot ${player}`;
  if (slot.state !== 'alive') return `player ${player} is ${slot.state ?? 'not alive'}`;
  if (slot.piloting) return `player ${player} is piloting ${slot.piloting}`;
  return null;
}

export function describeGameState(state) {
  const slots = playerSlots(state);
  // No list at all is the interesting failure: it means this reads the payload wrong, so hand back
  // enough of it to see that rather than a tidy summary of nothing
  if (slots === null) return `no players array in ${JSON.stringify(state ?? null).slice(0, 200)}`;

  const live = slots.filter((entry) => entry && entry.isAlive === true).length;
  const indexes = slots.map((entry) => (entry ? entry.playerIndex : entry)).join(',');
  const names = slots.map((entry) => (entry ? entry.broName : entry)).join(',');
  return `scene=${state.scene ?? 'unknown'} players=${slots.length} live=${live} `
    + `playerIndex=[${indexes}] broName=[${names}]`;
}

// `before` is null once the swap_bro reply has already confirmed the change, leaving only liveness.
export function swapLanded(state, player, before) {
  const slot = slotOf(state, player);
  if (slot === null || slot.isAlive !== true) return false;

  // Nothing was in the slot to begin with, so anything alive in it now is the swap
  if (!before) return true;
  return slot.broName !== before.broName;
}

export function describeSlot(slot) {
  if (!slot) return 'no player';
  return `${slot.broName} (${slot.className}), isAlive=${slot.isAlive}`;
}

async function pollGameState({ client, timeoutMs, pollMs, sleep, now, isRunning, ready, unmet, during, nudge = null }) {
  const deadline = now() + timeoutMs;
  const gone = gameWatch(isRunning);
  let last = null;

  for (;;) {
    try {
      last = await client.sendCommand('game_state', {});
      if (ready(last)) return last;
    } catch (err) {
      last = { error: err.message };
    }

    if (await gone()) throw new GameGoneError(`the game stopped while the sweep was ${during}`);
    if (now() >= deadline) {
      throw new Error(`${unmet(Math.round(timeoutMs / 1000), last)}; last game_state: ${describeGameState(last)}`);
    }
    if (nudge) await nudge(last);
    await sleep(pollMs);
  }
}

async function pressPastCutscene({ client, player, state, cutscene, now }) {
  if (!state || state.pauseState !== 'CutscenePause') return;
  // The game ignores a skip pressed in a cutscene's first second (SkippableCutsceneControl.delayBeforeSkippable)
  if (cutscene.pressedAt != null && now() - cutscene.pressedAt < CUTSCENE_REPRESS_MS) return;

  cutscene.presses = (cutscene.presses || 0) + 1;
  cutscene.pressedAt = now();
  try {
    const result = await client.sendCommand('simulate_input', { ...CUTSCENE_PRESS, player });
    cutscene.error = result && result.success === false ? result.error || 'refused' : null;
  } catch (err) {
    cutscene.error = err.message;
  }
}

function describePresses(cutscene) {
  if (!cutscene || !cutscene.presses) return '';
  const times = cutscene.presses === 1 ? 'once' : `${cutscene.presses} times`;
  return `; start was pressed ${times} to dismiss a cutscene${cutscene.error ? `, the last press answering: ${cutscene.error}` : ''}`;
}

export async function dismissCutscene({
  client,
  player = 0,
  timeoutMs,
  settleMs = 0,
  pollMs = 500,
  sleep = delay,
  now = Date.now,
  isRunning = null,
  cutscene,
}) {
  const deadline = now() + timeoutMs;
  const gone = gameWatch(isRunning);
  let pressed = false;

  for (;;) {
    let state = null;
    try {
      state = await client.sendCommand('game_state', {});
    } catch {
      state = null;
    }

    if (!state || state.pauseState !== 'CutscenePause') {
      if (!pressed) return state;
      pressed = false;
      if (settleMs > 0) await sleep(settleMs);
      continue;
    }

    if (await gone()) throw new GameGoneError('the game stopped while the sweep was dismissing a cutscene');
    if (now() >= deadline) {
      throw new Error(`nothing was swept: after ${Math.round(timeoutMs / 1000)}s the game is paused (CutscenePause)`
        + `${describePresses(cutscene)}; last game_state: ${describeGameState(state)}`);
    }
    await pressPastCutscene({ client, player, state, cutscene, now });
    pressed = true;
    await sleep(pollMs);
  }
}

export function waitForLevel({
  client,
  player = 0,
  levelIndex = null,
  timeoutMs,
  pollMs = 500,
  sleep = delay,
  now = Date.now,
  isRunning = null,
}) {
  return pollGameState({
    client,
    timeoutMs,
    pollMs,
    sleep,
    now,
    isRunning,
    during: 'waiting for the level to load',
    ready: (state) => levelIsReady(state, player, levelIndex),
    unmet: (seconds) => `the game never reported ${levelIndex === null ? 'a level' : `level index ${levelIndex}`} in play with a live player in slot ${player} after ${seconds}s`,
  });
}

export async function waitForSweepable({
  client,
  player = 0,
  timeoutMs,
  pollMs = 500,
  sleep = delay,
  now = Date.now,
  isRunning = null,
  cutscene = null,
  settleMs = 0,
}) {
  let budget = timeoutMs;
  let settledAfter = cutscene ? cutscene.presses || 0 : 0;
  for (;;) {
    const started = now();
    const state = await pollGameState({
      client,
      timeoutMs: budget,
      pollMs,
      sleep,
      now,
      isRunning,
      during: 'waiting for the bro to be sweepable',
      ready: (candidate) => sweepableProblem(candidate, player) === null,
      unmet: (_, last) => `nothing was swept: after ${Math.round(timeoutMs / 1000)}s ${last && last.error ? 'game_state still fails' : sweepableProblem(last, player)}${describePresses(cutscene)}`,
      nudge: cutscene ? (last) => pressPastCutscene({ client, player, state: last, cutscene, now }) : null,
    });
    if (!cutscene || (cutscene.presses || 0) === settledAfter || settleMs <= 0) return state;
    settledAfter = cutscene.presses;
    budget = Math.max(0, budget - (now() - started));
    await sleep(settleMs);
  }
}

function dismissSettleMs(options) {
  return options.level ? options.settleMs || 0 : DEFAULT_SETTLE_MS;
}

function readinessSettleMs(options) {
  return DEFAULT_SETTLE_MS + (options.swapSettleMs || 0);
}

// swap_bro answers as soon as it has swapped the component, while the character being drawn is still
// the old one, so the slot is polled until it catches up. A slot that never changes comes back as
// landed:false rather than thrown, leaving the caller to say what an unconfirmed swap means to it.
// A caller that injects an instantly-resolving sleep turns this into a hot loop for the whole cap;
// tests that do that keep the cap small.
export async function waitForSwap({
  client,
  player = 0,
  before,
  timeoutMs,
  pollMs = 500,
  sleep = delay,
  now = Date.now,
  isRunning = null,
}) {
  const deadline = now() + timeoutMs;
  const gone = gameWatch(isRunning);
  let last = null;

  for (;;) {
    try {
      last = await client.sendCommand('game_state', {});
      if (swapLanded(last, player, before)) return { landed: true, slot: slotOf(last, player) };
    } catch (err) {
      last = { error: err.message };
    }

    if (await gone()) throw new GameGoneError('the game stopped while the sweep was waiting for the bro swap');
    if (now() >= deadline) {
      // The state comes back too: a game that stopped answering leaves nothing in the slot, and the
      // error that ended the polling is the only thing that says why
      return { landed: false, slot: slotOf(last, player), state: last, seconds: Math.round(timeoutMs / 1000) };
    }
    await sleep(pollMs);
  }
}

export async function confirmBro({ client, player = 0, bro }) {
  const reply = await client.sendCommand('list_bros', { playerNum: player });
  if (!reply || reply.success === false) {
    throw new Error(`list_bros could not confirm the swap to "${bro}": ${(reply && reply.error) || 'no reply'}`);
  }
  const current = typeof reply.currentBro === 'string' ? reply.currentBro : null;
  if (current === null || current.trim().toLowerCase() !== bro.trim().toLowerCase()) {
    throw new Error(
      `Slot ${player} holds ${current === null ? 'no bro list_bros can name' : `"${current}"`} after the swap to "${bro}", `
        + 'so nothing was swept',
    );
  }
  return current;
}

function compressRanges(values) {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const ranges = [];

  for (const value of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && value === last[1] + 1) last[1] = value;
    else ranges.push([value, value]);
  }

  return ranges.map(([from, to]) => (from === to ? `${from}` : `${from}-${to}`)).join(',');
}

function isCarried(cell) {
  return cell && cell.written === 'carried';
}

// compressRanges is for display only: it sorts and dedupes, so it cannot tell a correct walk from
// the same columns in the wrong order or with a step repeated. cellSequence keeps the order.
export function cellSequence(frames, key) {
  const sequence = [];

  for (const frame of frames || []) {
    const cell = frame && frame[key];
    if (!cell || typeof cell.row !== 'number' || typeof cell.col !== 'number' || cell.enabled === false || isCarried(cell)) {
      sequence.push(null);
      continue;
    }
    sequence.push([cell.row, cell.col]);
  }
  return sequence;
}

export function expectedSequence(state, field = 'expect') {
  const expect = state && state[field];
  const values = state && state.step && state.step.values;
  if (!expect || !Array.isArray(values) || typeof expect.row !== 'number') return null;

  if ('col' in expect) {
    if (!Number.isInteger(expect.col) || 'cols' in expect) return null;
    return values.map(() => [expect.row, expect.col]);
  }
  if (!Array.isArray(expect.cols)) return null;

  const [from, to] = expect.cols;
  if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
  if (Math.abs(to - from) + 1 !== values.length) return null;

  const direction = to >= from ? 1 : -1;
  return values.map((_, index) => [expect.row, from + direction * index]);
}

export function sameSequence(actual, expected) {
  if (!Array.isArray(actual) || !Array.isArray(expected)) return false;
  if (actual.length !== expected.length) return false;

  return actual.every((cell, index) => {
    const wanted = expected[index];
    return Array.isArray(cell) && cell[0] === wanted[0] && cell[1] === wanted[1];
  });
}

export function describeCells(frames, key, sheet) {
  const rows = new Map();

  for (const frame of frames || []) {
    const cell = frame && frame[key];
    if (!cell || typeof cell.row !== 'number' || typeof cell.col !== 'number') continue;
    // A deactivated gun still carries the cell it was last pointed at; it is not on screen
    if (cell.enabled === false) continue;
    if (!rows.has(cell.row)) rows.set(cell.row, []);
    rows.get(cell.row).push(cell.col);
  }

  if (rows.size === 0) return '';
  return [...rows.entries()]
    .map(([row, cols]) => `${sheet} row ${row} cols ${compressRanges(cols)}`)
    .join('; ');
}

export function describeExpectation(expect, defaultSheet = 'main') {
  if (!expect || typeof expect.row !== 'number') return '';
  const sheet = expect.sheet || defaultSheet;
  if ('col' in expect) return `${sheet} row ${expect.row} col ${expect.col} held`;
  if (!Array.isArray(expect.cols)) return '';
  const [from, to] = expect.cols;
  const cols = from === to ? `${from}` : `${from}-${to}`;
  return `${sheet} row ${expect.row} cols ${cols}`;
}

// The reason on a knownMismatch entry only ever excuses its last step. Everything before that must
// still walk the expected columns in order, or the state is really broken and the known reason is
// just a footnote. A one-column expectation is all terminal step, so there is nothing left to vouch
// for it and it can never be excused — hence the length guard.
export function knownMismatchHolds(frames, state) {
  const walk = expectedSequence(state);
  if (walk === null || walk.length < 2) return false;

  const actual = cellSequence(frames, 'body');
  if (actual.length !== walk.length) return false;

  return sameSequence(actual.slice(0, -1), walk.slice(0, -1));
}

export function contributionOf(frames) {
  const judged = (frames || []).filter((frame) => frame && typeof frame.contributed === 'boolean');
  const contributed = judged.filter((frame) => frame.contributed).length;
  const empty = judged.filter((frame) => !frame.contributed && frame.cellEmpty === true).length;
  return { judged: judged.length, contributed, empty, failed: judged.length - contributed - empty };
}

function contributionFigure({ judged, contributed, empty }) {
  return `${contributed}/${judged}${empty > 0 ? ` (${empty} empty)` : ''}`;
}

function framesWhere(frames, test) {
  const steps = [];
  (frames || []).forEach((frame, index) => { if (frame && test(frame)) steps.push(index); });
  return steps;
}

export function carriedGunFrames(frames) {
  return framesWhere(frames, (frame) => frame.gun && frame.gun.enabled !== false && isCarried(frame.gun));
}

export function emptyCellFrames(frames) {
  return {
    body: framesWhere(frames, (frame) => frame.bodyCellEmpty === true),
    gun: framesWhere(frames, (frame) => frame.gunCellEmpty === true),
  };
}

const LEVEL_KINDS = ['blocks', 'units', 'doodads'];

function levelChangeEntries(record) {
  const changes = record && record.levelChanges;
  if (!changes || typeof changes !== 'object') return 0;
  return LEVEL_KINDS.reduce((sum, kind) => sum + (Array.isArray(changes[kind]) ? changes[kind].length : 0), 0);
}

export function describeLevelChanges(changes) {
  const parts = [];
  for (const kind of LEVEL_KINDS) {
    const entries = changes && Array.isArray(changes[kind]) ? changes[kind] : [];
    if (entries.length === 0) continue;
    const counts = new Map();
    for (const entry of entries) counts.set(entry.change, (counts.get(entry.change) || 0) + 1);
    parts.push(`${kind}: ${[...counts.entries()].map(([change, count]) => `${count} ${change}`).join(', ')}`);
  }
  return parts.join('; ');
}

function describeCalls(entries) {
  return (entries || []).map((entry) => {
    const hits = typeof entry.hits === 'number' ? `, ${entry.hits} hit` : '';
    return `${entry.method} ×${entry.calls}${hits}`;
  }).join(', ');
}

export function buildReport({ capture, states, outDir, options }) {
  const byName = new Map(states.map((state) => [state.name, state]));
  const records = (capture && capture.states) || [];
  const bro = (capture && capture.bro) || {};
  const broLabel = [bro.customName, bro.type, bro.heroType].filter(Boolean).join(' / ') || 'unknown';

  const captured = [];
  const skipped = [];

  for (const record of records) {
    const state = byName.get(record.name) || {};
    if (record.skipped) {
      skipped.push({ name: record.name, reason: record.skipped, note: state.note || '', contribution: contributionOf(record.frames) });
      continue;
    }

    const sheet = (state.expect && state.expect.sheet) || 'main';
    const gunSheet = (state.expectGun && state.expectGun.sheet) || 'gun';
    const body = describeCells(record.frames, 'body', sheet);
    const expected = [describeExpectation(state.expect), describeExpectation(state.expectGun, 'gun')]
      .filter(Boolean)
      .join('; ');

    // An expectation that yields no walk is malformed, not absent: nothing can satisfy it. A state
    // that states both has to walk both — a gun expectation is the only check on a state whose body
    // row is the one it would address anyway.
    const verdict = (field, key) => {
      const walk = expectedSequence(state, field);
      if (walk === null) return state[field] ? false : null;
      return sameSequence(cellSequence(record.frames, key), walk);
    };
    const bodyMatches = verdict('expect', 'body');
    const gunMatches = verdict('expectGun', 'gun');
    const matches = bodyMatches === null && gunMatches === null
      ? null
      : bodyMatches !== false && gunMatches !== false;

    // A knownMismatch only ever excuses the body's terminal step, so it cannot cover a gun that
    // walked somewhere else
    const known = state.knownMismatch && gunMatches !== false && knownMismatchHolds(record.frames, state)
      ? state.knownMismatch
      : null;
    captured.push({
      name: record.name,
      frames: (record.frames || []).length,
      body,
      gun: describeCells(record.frames, 'gun', gunSheet),
      expected,
      matches,
      knownMismatch: known,
      knownReason: state.knownMismatch || null,
      offscreen: (record.frames || []).some((frame) => frame && frame.offscreen),
      contribution: contributionOf(record.frames),
      strip: path.join(outDir, stripName(record.name)),
    });
  }

  const knownMismatches = captured.filter((entry) => entry.matches === false && entry.knownMismatch);
  const mismatched = captured.filter((entry) => entry.matches === false && !entry.knownMismatch);

  // A state whose after methods threw keeps its frames and its verdict; the teardown failure rides
  // on the record and is listed here. The game reports it too, so the same text is not repeated.
  const errors = [...((capture && capture.errors) || [])];
  for (const record of records) {
    const problem = record && record.afterError;
    if (typeof problem === 'string' && problem !== '' && !errors.includes(problem)) errors.push(problem);
  }

  const erroredStates = new Set();
  for (const record of records) {
    if (!record) continue;
    if ((typeof record.skipped === 'string' && record.skipped.startsWith('error: '))
      || (typeof record.afterError === 'string' && record.afterError !== '')
      || typeof record.clockDisturbed === 'number'
      || (Array.isArray(record.nonFinite) && record.nonFinite.length > 0)) erroredStates.add(record.name);
  }
  for (const message of errors) {
    const named = /^state '(.*?)'[: ]/.exec(message);
    if (named) erroredStates.add(named[1]);
  }

  const excluded = (options && options.excluded) || [];

  const contributionTotals = records.map((record) => contributionOf(record.frames));
  const contributionChecked = contributionTotals.some((entry) => entry.judged > 0);
  const contributionFailures = contributionTotals.reduce((sum, entry) => sum + entry.failed, 0);

  const empties = records
    .map((record) => ({ name: record.name, ...emptyCellFrames(record.frames) }))
    .filter((entry) => entry.body.length > 0 || entry.gun.length > 0);
  const emptyFrames = records.reduce((sum, record) => sum + framesWhere(
    record.frames,
    (frame) => frame.bodyCellEmpty === true || frame.gunCellEmpty === true,
  ).length, 0);

  const carried = records
    .map((record) => ({ name: record.name, frames: carriedGunFrames(record.frames) }))
    .filter((entry) => entry.frames.length > 0);
  const carriedFrames = carried.reduce((sum, entry) => sum + entry.frames.length, 0);

  const retired = records
    .filter((record) => record && Array.isArray(record.retired) && record.retired.length > 0)
    .map((record) => ({ name: record.name, objects: record.retired }));
  const retiredObjects = retired.reduce(
    (sum, entry) => sum + entry.objects.reduce((count, object) => count + (Number(object.count) || 0), 0),
    0,
  );

  const levelChanged = records.filter((record) => levelChangeEntries(record) > 0);
  const firstLevelChange = levelChanged.length > 0 ? levelChanged[0].name : null;
  const calls = records.filter((record) => (Array.isArray(record.suppressed) && record.suppressed.length > 0)
    || (Array.isArray(record.damageCalls) && record.damageCalls.length > 0));

  const params = capture && capture.params ? capture.params : null;
  const sideEffects = (params ? params.allowSideEffects : options && options.allowSideEffects) === true;
  const only = options && Array.isArray(options.only) ? options.only : null;

  const lines = [
    `# Animation capture — ${broLabel}`,
    '',
    `- Output: ${outDir}`,
    `- States: ${captured.length} captured, ${skipped.length} skipped, ${excluded.length} excluded`,
  ];
  if (only) lines.push(`- Only: ${only.length} of ${options.mergedCount ?? states.length} states`);
  lines.push(`- Side effects: ${sideEffects ? 'allowed' : 'suppressed'}`);
  if (capture && capture.complete === false) {
    lines.push(`- Capture incomplete: the sweep stopped after ${records.length} of ${states.length} states`);
  }
  lines.push(
    `- Cell mismatches against the state list: ${mismatched.length}`,
    `- States that errored mid-sweep: ${erroredStates.size}`,
    `- First level change: ${firstLevelChange ?? 'none'}`,
  );
  if (contributionChecked) lines.push(`- Frames the character contributed no pixel to: ${contributionFailures}`);
  if (emptyFrames > 0) lines.push(`- Frames addressing empty sheet cells: ${emptyFrames}`);
  lines.push(`- Frames with a carried-over gun cell: ${carriedFrames}`);
  if (retiredObjects > 0) lines.push(`- Objects retired between states: ${retiredObjects}`);
  if (options && options.bro) lines.push(`- Requested bro: ${options.bro}`);
  const presses = (options && options.cutscenePresses) || 0;
  if (presses > 0) lines.push(`- Cutscene dismissed before the sweep: start pressed ${presses === 1 ? 'once' : `${presses} times`}`);
  lines.push('');

  lines.push(`## Captured (${captured.length})`, '');
  if (captured.length === 0) {
    lines.push('_none_', '');
  } else {
    const showContribution = captured.some((entry) => entry.contribution.judged > 0);
    lines.push(`| State | Frames |${showContribution ? ' Contributed |' : ''} Body cells | Gun cells | Expected | Strip |`);
    lines.push(`| --- | --- |${showContribution ? ' --- |' : ''} --- | --- | --- | --- |`);
    for (const entry of captured) {
      const flag = entry.matches ? '✓' : entry.knownMismatch ? '(known)' : '✗';
      const expected = entry.expected === '' ? '—' : `${entry.expected} ${flag}`;
      const name = entry.offscreen ? `${entry.name} (offscreen frames)` : entry.name;
      const counts = entry.contribution.judged === 0 ? '—' : contributionFigure(entry.contribution);
      const contribution = showContribution ? ` ${counts} |` : '';
      lines.push(`| ${name} | ${entry.frames} |${contribution} ${entry.body || '—'} | ${entry.gun || '—'} | ${expected} | ${entry.strip} |`);
    }
    lines.push('');
  }

  lines.push(`## Known mismatches (${knownMismatches.length})`, '');
  if (knownMismatches.length === 0) {
    lines.push('_none_', '');
  } else {
    for (const entry of knownMismatches) {
      lines.push(`- **${entry.name}** — addressed ${entry.body || 'nothing'}; ${entry.knownMismatch}`);
    }
    lines.push('');
  }

  if (mismatched.length > 0) {
    lines.push(`## Mismatches (${mismatched.length})`, '');
    for (const entry of mismatched) {
      const suffix = entry.knownReason
        ? ` (more than the known terminal-step mismatch: ${entry.knownReason})`
        : '';
      lines.push(`- **${entry.name}** — addressed ${entry.body || 'nothing'}, expected ${entry.expected}${suffix}`);
    }
    lines.push('');
  }

  lines.push(`## Level changes (${levelChanged.length})`, '');
  if (levelChanged.length === 0) {
    lines.push('_none_', '');
  } else {
    for (const record of levelChanged) lines.push(`- **${record.name}** — ${describeLevelChanges(record.levelChanges)}`);
    lines.push('');
  }

  if (calls.length > 0) {
    lines.push(`## Damage calls (${calls.length})`, '');
    for (const record of calls) {
      const parts = [];
      if (record.suppressed && record.suppressed.length > 0) parts.push(`suppressed ${describeCalls(record.suppressed)}`);
      if (record.damageCalls && record.damageCalls.length > 0) parts.push(`ran ${describeCalls(record.damageCalls)}`);
      lines.push(`- **${record.name}** — ${parts.join('; ')}`);
    }
    lines.push('');
  }

  if (carried.length > 0) {
    lines.push(`## Carried-over gun cells (${carried.length})`, '');
    for (const entry of carried) lines.push(`- **${entry.name}** — frames ${compressRanges(entry.frames)}`);
    lines.push('');
  }

  if (empties.length > 0) {
    lines.push(`## Empty sheet cells (${empties.length})`, '');
    for (const entry of empties) {
      const parts = [];
      if (entry.body.length > 0) parts.push(`body frames ${compressRanges(entry.body)}`);
      if (entry.gun.length > 0) parts.push(`gun frames ${compressRanges(entry.gun)}`);
      lines.push(`- **${entry.name}** — ${parts.join('; ')}`);
    }
    lines.push('');
  }

  if (excluded.length > 0) {
    lines.push(`## Excluded (${excluded.length})`, '');
    for (const entry of excluded) {
      lines.push(`- **${entry.name}** — ${entry.lethalReason || 'lethal'}; set includeLethal: true to sweep it`);
    }
    lines.push('');
  }

  if (errors.length > 0) {
    lines.push(`## Errors (${errors.length})`, '', ...errors.map((message) => `- ${message}`), '');
  }

  lines.push(`## Skipped (${skipped.length})`, '');
  if (skipped.length === 0) {
    lines.push('_none_', '');
  } else {
    for (const entry of skipped) {
      const figure = entry.contribution.judged > 0 ? ` — contributed ${contributionFigure(entry.contribution)}` : '';
      const reason = entry.reason.startsWith('error: ') ? 'errored (see Errors)' : entry.reason;
      lines.push(`- **${entry.name}** — ${reason}${figure}`);
    }
    lines.push('');
  }

  if (retired.length > 0) {
    lines.push(`## Retired between states (${retired.length})`, '');
    for (const entry of retired) {
      const objects = entry.objects.map((object) => `${object.name} ×${object.count}`).join(', ');
      lines.push(`- **${entry.name}** — ${objects}`);
    }
    lines.push('');
  }

  const missing = states
    .filter((state) => !records.some((record) => record.name === state.name))
    .map((state) => state.name);
  if (missing.length > 0) {
    lines.push(`## Never reached (${missing.length})`, '', ...missing.map((name) => `- ${name}`), '');
  }

  return {
    text: lines.join('\n'),
    summary: {
      captured: captured.length,
      skipped: skipped.length,
      excluded: excluded.length,
      mismatches: mismatched.length,
      errors: erroredStates.size,
      contributionFailures,
      emptyCellFrames: emptyFrames,
      carriedGunFrames: carriedFrames,
      retiredObjects,
      levelChangeStates: levelChanged.length,
      firstLevelChange,
      complete: capture ? capture.complete !== false : false,
      cutscenePresses: presses,
    },
  };
}

export function describeFailure(method, result) {
  const parts = [`${method} failed: ${(result && result.error) || 'unknown error'}`];
  if (result && result.compilerErrors) parts.push(`compiler errors:\n${result.compilerErrors}`);
  const output = linesOf(result && result.output);
  if (output.length > 0) parts.push(`script output:\n${output.join('\n')}`);
  return parts.join('\n');
}

function linesOf(output) {
  if (Array.isArray(output)) return output.map(String);
  if (typeof output === 'string' && output !== '') return output.split('\n');
  return [];
}

const LOG_TAIL_SCAN_BYTES = 4 * 1024 * 1024;

export async function markCaptureLog(resolveLog) {
  if (typeof resolveLog !== 'function') return null;
  try {
    const chosen = await resolveLog();
    return chosen?.path ? await markLogEnd(chosen.path) : null;
  } catch {
    return null;
  }
}

export async function captureLogTail({ resolveLog, since = null, maxLines = 20 } = {}) {
  if (typeof resolveLog !== 'function') return { path: null, lines: [], error: 'no log resolver was supplied' };

  let chosen = since;
  if (!chosen) {
    try {
      chosen = await resolveLog();
    } catch (err) {
      return { path: null, lines: [], error: err.message };
    }
  }
  if (!chosen || !chosen.path) return { path: null, lines: [], error: 'no game log found' };

  try {
    const start = since ? await markedStart(since) : 0;
    if (start === null) return { path: chosen.path, lines: [], error: `${chosen.path} is gone` };
    const hits = [];
    let scanned = 0;
    for await (const line of linesBackward(chosen.path, { start, maxLineBytes: 4096 })) {
      if (line.text.includes(LOG_MARKER)) hits.unshift(line.text);
      scanned += Buffer.byteLength(line.text) + 1;
      if (hits.length >= maxLines || scanned >= LOG_TAIL_SCAN_BYTES) break;
    }
    return { path: chosen.path, lines: hits };
  } catch (err) {
    return { path: chosen.path, lines: [], error: err.message };
  }
}

export function formatLogTail(tail) {
  if (!tail) return '';
  if (tail.lines.length > 0) {
    return `Last ${tail.lines.length} ${LOG_MARKER} line(s) from ${tail.path}:\n${tail.lines.join('\n')}`;
  }
  return tail.error
    ? `No ${LOG_MARKER} lines available: ${tail.error}`
    : `No ${LOG_MARKER} lines in ${tail.path} — the script may never have started`;
}

async function expectOk(client, method, params, timeoutMs) {
  const result = await client.sendCommand(method, params, timeoutMs);
  if (result && result.success === false) {
    throw new Error(describeFailure(method, result));
  }
  return result;
}

export async function teardownGame(client, { timeoutMs = null, name = SCRIPT_NAME, speed = null } = {}) {
  const problems = [];
  let unloaded = false;
  try {
    const reply = await client.sendCommand('unload_script', { name }, timeoutMs);
    unloaded = !(reply && reply.success === false);
    if (!unloaded) problems.push(`unload_script: ${(reply && reply.error) || 'refused'}`);
  } catch (err) {
    problems.push(`unload_script: ${err.message}`);
  }
  if (unloaded) return problems;

  try {
    await client.sendCommand('set_game_speed', { speed: speed > 0 ? speed : 1 }, timeoutMs);
  } catch (err) {
    problems.push(`set_game_speed: ${err.message}`);
  }
  return problems;
}

export const LIVE_SWEEP_SLOT = 'UnityInspector.AnimationCapture.Live';
export const CLAIM_SLACK_MS = 10000;

// A JSON string literal is a valid C# one
const csString = (value) => JSON.stringify(String(value));

function liveRule(token) {
  return [
    `object[] live = System.AppDomain.CurrentDomain.GetData(${csString(LIVE_SWEEP_SLOT)}) as object[];`,
    'string held = null;',
    'if (live != null && live.Length == 2 && (live[0] as UnityEngine.GameObject) != null) held = "" + live[1];',
    `if (live != null && live.Length == 3 && live[0] is string && live[2] is float && (string)live[0] != ${csString(token)}`
      + ' && (float)live[2] > UnityEngine.Time.realtimeSinceStartup) held = "" + live[1];',
  ];
}

export function claimCode({ token, out, leaseMs }) {
  return [
    ...liveRule(token),
    `if (held == null) System.AppDomain.CurrentDomain.SetData(${csString(LIVE_SWEEP_SLOT)}, new object[] { ${csString(token)}, `
      + `${csString(out)}, UnityEngine.Time.realtimeSinceStartup + ${(leaseMs / 1000).toFixed(1)}f });`,
    'return held;',
  ].join('\n');
}

export function releaseCode(token) {
  return [
    `object[] live = System.AppDomain.CurrentDomain.GetData(${csString(LIVE_SWEEP_SLOT)}) as object[];`,
    `bool mine = live != null && live.Length == 3 && (live[0] as string) == ${csString(token)};`,
    `if (mine) System.AppDomain.CurrentDomain.SetData(${csString(LIVE_SWEEP_SLOT)}, null);`,
    'return mine;',
  ].join('\n');
}

export function claimLeaseMs(options) {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const poll = commandTimeout('game_state');
  const press = commandTimeout('simulate_input', CUTSCENE_PRESS);
  let ms = timeout + poll + commandTimeout('execute_script');
  if (options.level) ms += commandTimeout('go_to_level') + timeout + 2 * poll + press + timeout + poll + (options.settleMs || 0);
  if (options.level || options.bro) ms += timeout + 2 * poll + press + dismissSettleMs(options);
  if (!options.level) ms += poll + 2 * press + readinessSettleMs(options);
  if (options.bro) {
    ms += poll + 2 * commandTimeout('swap_bro') + commandTimeout('list_bros')
      + (options.swapTimeoutMs ?? DEFAULT_SWAP_TIMEOUT_MS) + (options.swapSettleMs || 0);
  }
  return ms + CLAIM_SLACK_MS;
}

export async function claimSweep(client, claim) {
  const reply = await expectOk(client, 'execute_code', { code: claimCode(claim) });
  return reply && typeof reply.result === 'string' ? reply.result : null;
}

export async function releaseClaim(client, token, timeoutMs = undefined) {
  try {
    await client.sendCommand('execute_code', { code: releaseCode(token) }, timeoutMs);
  } catch {
  }
}

export async function loadStates(statesPaths) {
  const layers = [];

  for (const statesPath of statesPaths) {
    let text;
    try {
      text = await fs.readFile(statesPath, 'utf-8');
    } catch (err) {
      throw new UsageError(err.code === 'ENOENT'
        ? `No state list at ${statesPath}: states names a JSON state list file`
        : `The state list ${statesPath} could not be read (${err.code || err.message})`);
    }
    let doc;
    try {
      doc = JSON.parse(text);
    } catch (err) {
      throw new UsageError(`The state list ${statesPath} is not valid JSON: ${err.message}`);
    }
    const { states, errors } = validateStates(doc);
    if (errors.length > 0) {
      throw new UsageError(`${statesPath} is not a usable state list:\n  ${errors.join('\n  ')}`);
    }
    layers.push(states);
  }
  return mergeStates(layers);
}

export async function outDirProblem(out) {
  let entries;
  try {
    entries = await fs.readdir(out);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  if (entries.length === 0) return null;
  const mark = entries.includes(OUT_MARKER) ? await readIfPresent(path.join(out, OUT_MARKER)) : null;
  if (mark === OUT_MARKER_TEXT) return null;
  return `${out} already holds files and no ${OUT_MARKER} mark from an earlier sweep, and the sweep deletes every .png `
    + 'in its output directory. Pass a new or empty directory, or one this tool wrote before.';
}

export function sweepParams(options) {
  return {
    allowSideEffects: options.allowSideEffects === true,
    includeLethal: options.includeLethal === true,
    only: Array.isArray(options.only) ? options.only : null,
    states: options.statesPaths,
    level: options.level ? `${options.level.campaignIndex}:${options.level.levelIndex}` : null,
    bro: options.bro ?? null,
    box: options.box ?? DEFAULT_BOX,
  };
}

export async function runCapture(options, client, { sleep: injectedSleep = delay, pollMs = 500, resolveLog = undefined, isRunning = null, sweep = null, signal = null } = {}) {
  const sleep = cancellableSleep(injectedSleep, signal);
  const gameIsRunning = isRunning ?? (() => isGameRunning(client.gameConfig ?? undefined));

  const all = await loadStates(options.statesPaths);
  const { states, excluded } = partitionLethal(selectOnly(all, options.only), options.includeLethal);
  const collisions = stripCollisions(states);
  if (collisions.length > 0) throw new UsageError(`state names collide as strip files: ${collisions.join('; ')}`);

  throwIfCancelled(signal);
  await expectOk(client, 'ping', {});
  const claim = randomBytes(8).toString('hex');
  const running = await claimSweep(client, { token: claim, out: options.gameOut ?? options.out, leaseMs: claimLeaseMs(options) });
  if (running !== null) {
    throw new Error(`Another animation-capture sweep, into ${running}, is running in this game: wait for it to finish. `
      + 'This sweep changed nothing.');
  }
  if (sweep) sweep.claim = claim;
  const logMark = await markCaptureLog(resolveLog);

  let source;
  let waits;
  let swapResult = null;
  let restoreSpeed;
  const cutscene = { presses: 0 };
  try {
    try {
      await fs.mkdir(options.out, { recursive: true });
      await fs.writeFile(path.join(options.out, OUT_MARKER), OUT_MARKER_TEXT);
      await fs.writeFile(
        path.join(options.out, STATES_COPY_NAME),
        JSON.stringify({ params: sweepParams(options), states }, null, 2),
      );
      for (const stale of [DONE_FILE, ERROR_FILE, CAPTURE_FILE, REPORT_FILE]) {
        await fs.rm(path.join(options.out, stale), { force: true });
      }
      for (const entry of await fs.readdir(options.out)) {
        if (entry.endsWith('.png')) await fs.rm(path.join(options.out, entry), { force: true });
      }
    } catch (err) {
      throw new UsageError(
        `Could not prepare the output directory ${options.out} (${err.code || err.message}${err.path && err.path !== options.out ? ` on ${err.path}` : ''}): `
          + 'out must be a directory this server can create and write',
      );
    }

    source = await fs.readFile(SCRIPT_PATH, 'utf-8');
    waits = { client, player: options.player, pollMs, sleep, isRunning: gameIsRunning };

    if (options.level) {
      throwIfCancelled(signal);
      const loaded = await expectOk(client, 'go_to_level', options.level);
      if (loaded && loaded.cutscene) await dismissCutscene({ ...waits, timeoutMs: options.timeoutMs, cutscene });
      await waitForLevel({ ...waits, levelIndex: options.level.levelIndex, timeoutMs: options.timeoutMs });
      if (options.settleMs > 0) await sleep(options.settleMs);
    }

    const looked = options.level || options.bro
      ? await dismissCutscene({ ...waits, timeoutMs: options.timeoutMs, cutscene, settleMs: dismissSettleMs(options) })
      : null;

    if (options.bro) {
      const before = slotOf(looked, options.player);
      const swapParams = { broName: options.bro, playerNum: options.player };
      throwIfCancelled(signal);
      let reply = await client.sendCommand('swap_bro', swapParams);
      if (reply && reply.success === false && reply.reason === 'unreachable') {
        throwIfCancelled(signal);
        reply = await client.sendCommand('swap_bro', { ...swapParams, ignoreUnlocks: true });
      }
      if (reply && reply.success === false) throw new Error(describeFailure('swap_bro', reply));

      // StateModifier.SwapBro reads the slot's GameObject name on the main thread after the swap, so
      // the reply already says whether the character changed
      const replyName = reply && typeof reply.objectName === 'string' ? reply.objectName : null;

      if (before && replyName !== null && replyName === before.broName) {
        swapResult = { requested: options.bro, slot: before, alreadyHeld: true };
      } else {
        const swap = await waitForSwap({
          ...waits,
          // A reply that named a different character has settled the change already, leaving liveness;
          // a reply with no name to compare falls back to watching the slot for the change itself
          before: replyName === null ? before : null,
          // Falls back rather than reading undefined: a NaN deadline would poll forever
          timeoutMs: options.swapTimeoutMs ?? DEFAULT_SWAP_TIMEOUT_MS,
        });

        // The already-held case is settled by the reply above, so reaching the cap means the slot
        // never reported the swap landing, and a sweep would file whatever it holds under the bro asked for
        if (!swap.landed) {
          throw new Error(
            `Slot ${options.player} still reports ${describeSlot(swap.slot)} ${swap.seconds}s after swapping to `
              + `"${options.bro}": the swap never landed, so nothing was swept; `
              + `last game_state: ${describeGameState(swap.state)}`,
          );
        }
        swapResult = { requested: options.bro, slot: swap.slot, alreadyHeld: false };
      }
      swapResult.currentBro = await confirmBro({ client, player: options.player, bro: options.bro });
      if (options.swapSettleMs > 0) await sleep(options.swapSettleMs);
    }

    const ready = await waitForSweepable({
      ...waits,
      timeoutMs: options.timeoutMs,
      cutscene: options.level ? null : cutscene,
      settleMs: readinessSettleMs(options),
    });
    throwIfCancelled(signal);
    restoreSpeed = typeof ready.timeScale === 'number' && ready.timeScale > 0 ? ready.timeScale : 1;
    if (sweep) {
      sweep.scriptName = SCRIPT_NAME;
      sweep.restoreSpeed = restoreSpeed;
    }
  } catch (err) {
    if (!(err instanceof GameGoneError)) await releaseClaim(client, claim);
    throw err;
  }

  let outcome;
  try {
    // The script freezes the clock itself: freezing it here first would have it snapshot 0
    const scriptArgs = {
      outDir: options.gameOut,
      statesFile: joinGamePath(options.gameOut, STATES_COPY_NAME),
      player: String(options.player),
      claim,
    };
    // Left out unless asked for, so the script's own default stays the single source of truth
    if (options.box !== null && options.box !== undefined) scriptArgs.box = String(options.box);
    if (options.allowSideEffects) scriptArgs.suppress = 'false';

    try {
      await expectOk(client, 'execute_script', { source, name: SCRIPT_NAME, args: scriptArgs });
    } catch (err) {
      await releaseClaim(client, claim);
      throw err;
    }
    if (sweep) sweep.claim = null;

    outcome = await waitForSentinel({
      dir: options.out,
      timeoutMs: options.timeoutMs,
      pollMs,
      sleep,
      isRunning: gameIsRunning,
      progressFile: path.join(options.out, CAPTURE_FILE),
    });
  } finally {
    // A game that is gone has nothing to unfreeze, and both commands would only time out against it
    if (!outcome || outcome.status !== 'game-gone') await teardownGame(client, { speed: restoreSpeed });
  }

  if (outcome.status === 'timeout') {
    const tail = await captureLogTail({ resolveLog, since: logMark });
    outcome = { ...outcome, logTail: tail, message: `${outcome.message}\n${formatLogTail(tail)}` };
  }

  const captureRaw = await readIfPresent(path.join(options.out, CAPTURE_FILE));
  let capture = null;
  if (captureRaw !== null) {
    try {
      capture = JSON.parse(captureRaw);
    } catch (err) {
      capture = null;
    }
  }
  const { text, summary } = buildReport({
    capture,
    states,
    outDir: options.out,
    options: { ...options, excluded, mergedCount: all.length, cutscenePresses: cutscene.presses },
  });
  await fs.writeFile(path.join(options.out, REPORT_FILE), `${text}\n`);

  const stateErrors = (capture && capture.errors) || [];
  return { outcome, report: text, summary, capture, states, excluded, stateErrors, swap: swapResult };
}

// The host side of the animation-capture sweep: loads the level, swaps the bro, runs the in-game
// script, waits for its sentinel file, then reports which sheet cells each state addressed. The
// capture_animations tool in index.js is what drives it; nothing here imports index.js.

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import { isGameRunning } from './game-process.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const CAPTURE_DIR = path.join(__dirname, 'animation-capture');
export const SCRIPT_PATH = path.join(CAPTURE_DIR, 'animation-capture.cs');
export const SCRIPT_NAME = 'animation-capture';
export const CAPTURE_STATES_DIR = path.join(CAPTURE_DIR, 'states');
export const DEFAULT_STATES_PATH = path.join(CAPTURE_STATES_DIR, 'base-states.json');
export const STATES_COPY_NAME = 'states.json';
export const DONE_FILE = 'done';
export const ERROR_FILE = 'error';
export const CAPTURE_FILE = 'capture.json';
export const REPORT_FILE = 'report.md';

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

// A full sweep takes about two seconds; a long default only stalls a failure, but a sweep that has
// to load a level first waits on that under the same budget
export const DEFAULT_TIMEOUT_MS = 60000;

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

    // The game resolves these against the live character, so all this side can check is the shape
    for (const phase of ['before', 'after']) {
      if (!(phase in state)) continue;
      const names = state[phase];
      if (!Array.isArray(names) || names.length === 0) {
        errors.push(`${name}: ${phase} must be a non-empty list of method names`);
      } else if (!names.every((entry) => typeof entry === 'string' && entry.trim() !== '')) {
        errors.push(`${name}: ${phase} must hold method names`);
      }
    }
    // Whatever before switched has to be switched back, so the pair is the unit: an entry with only
    // one half either leaves the character altered or reverses something it never did
    if (('before' in state) !== ('after' in state)) {
      errors.push(`${name}: before and after must be given together`);
    }

    if ('insert_before' in state && (typeof state.insert_before !== 'string' || state.insert_before.trim() === '')) {
      errors.push(`${name}: insert_before must name a state`);
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

    // Without this the entry has no well-formed walk, so nothing could ever match it and the
    // report would only say so after a whole sweep had run
    for (const field of ['expect', 'expectGun']) {
      const expect = state[field];
      if (!expect || !Array.isArray(expect.cols)) continue;

      // The row is what turns a column span into cells: without one the walk is unbuildable, and the
      // state would otherwise sweep, render an empty expectation and be counted a mismatch
      if (typeof expect.row !== 'number') errors.push(`${name}: ${field}.row must be a number`);
      if (!Array.isArray(step.values)) continue;

      const [from, to] = expect.cols;
      if (typeof from !== 'number' || typeof to !== 'number' || to < from) {
        errors.push(`${name}: ${field}.cols must be [from, to] with to >= from`);
      } else if (to - from + 1 !== step.values.length) {
        errors.push(
          `${name}: ${step.values.length} step value(s) for ${field} columns ${from}-${to} (${to - from + 1} cells)`,
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

export function partitionLethal(states, includeLethal) {
  if (includeLethal) return { states, excluded: [] };
  return {
    states: states.filter((state) => !state.lethal),
    excluded: states.filter((state) => state.lethal),
  };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readIfPresent(file) {
  try {
    return await fs.readFile(file, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// isRunning is asked alongside the sentinels because nothing is on the socket for the length of the
// sweep: a game that stops or crashes would otherwise sit out the whole timeout. A stop is declared
// only after the game was seen alive, the way the crash detector does it, so a target where process
// detection is unavailable degrades to the timeout rather than reporting a game that never ran.
export async function waitForSentinel({ dir, timeoutMs, pollMs = 500, sleep = delay, now = Date.now, isRunning = null }) {
  const deadline = now() + timeoutMs;
  let sawAlive = false;

  for (;;) {
    // Read error first: a failed sweep never writes done, and a stale done must not mask it
    const failure = await readIfPresent(path.join(dir, ERROR_FILE));
    if (failure !== null) {
      return { status: 'error', message: failure.trim() || 'the script reported an unspecified failure' };
    }
    if ((await readIfPresent(path.join(dir, DONE_FILE))) !== null) return { status: 'done' };

    if (isRunning) {
      let alive = null;
      try {
        alive = await isRunning();
      } catch {
        alive = null;
      }
      if (alive === true) sawAlive = true;
      else if (alive === false && sawAlive) {
        return {
          status: 'game-gone',
          message: `the game stopped while the sweep was running; nothing more will be written to ${dir}`,
        };
      }
    }

    if (now() >= deadline) {
      return {
        status: 'timeout',
        message: `no ${DONE_FILE} or ${ERROR_FILE} in ${dir} after ${Math.round(timeoutMs / 1000)}s`,
      };
    }
    await sleep(pollMs);
  }
}

// game_state's players list is compacted: the mod skips empty slots, so with no level loaded it is
// empty, and a slot the game is holding open for a player who has no character yet comes back with
// isAlive false. swap_bro needs a live character, so the entry has to be found by its playerIndex
// and asked whether it is alive rather than merely present. What this cannot see is pilottedUnit: a
// bro inside a mech is alive by this measure, and the payload carries nothing that says so.
export function playerSlots(state) {
  const players = state && typeof state === 'object' ? state.players : null;
  return Array.isArray(players) ? players : null;
}

export function levelIsReady(state, player = 0) {
  const slots = playerSlots(state);
  if (slots === null) return false;

  const slot = slots.find((entry) => entry && entry.playerIndex === player);
  return slot !== undefined && slot.isAlive === true;
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

export function slotOf(state, player) {
  const slots = playerSlots(state);
  if (slots === null) return null;

  const slot = slots.find((entry) => entry && entry.playerIndex === player);
  return slot === undefined ? null : slot;
}

// bro speaks Swap Bros Mod's display-name table, and game_state reports the character's GameObject
// name. The two do not map: Rambro's object is "Rambo(Clone) [local]", "Broffy the Vampire Slayer"
// is "Broffy", "Mr. Anderbro" is "Nebro". So the swap is confirmed by the name *changing* from what
// the slot held beforehand, not by matching it against anything — which confirms a change and not
// that the change was the bro asked for: a BroMaker substitution that failed would leave a plain
// Rambro in the slot and read as landed here.
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

// Both waits are the same poll asking a different question, so the loop lives here and the caller
// brings the predicate and what to say when the deadline passes
async function pollGameState({ client, timeoutMs, pollMs, sleep, now, ready, unmet }) {
  const deadline = now() + timeoutMs;
  let last = null;

  for (;;) {
    try {
      last = await client.sendCommand('game_state', {});
      if (ready(last)) return last;
    } catch (err) {
      last = { error: err.message };
    }

    if (now() >= deadline) {
      throw new Error(`${unmet(Math.round(timeoutMs / 1000))}; last game_state: ${describeGameState(last)}`);
    }
    await sleep(pollMs);
  }
}

// go_to_level returns as soon as the load is asked for, so the bro swap that follows can still land
// on the old scene or on a level whose players have not spawned
export function waitForLevel({ client, player = 0, timeoutMs, pollMs = 500, sleep = delay, now = Date.now }) {
  return pollGameState({
    client,
    timeoutMs,
    pollMs,
    sleep,
    now,
    ready: (state) => levelIsReady(state, player),
    unmet: (seconds) => `the game never reported a player in slot ${player} after ${seconds}s`,
  });
}

// One look at the slot before the swap, so the poll afterwards has something to compare against. A
// game_state that fails here is not fatal: it just means the poll takes anything alive as the swap.
export async function snapshotSlot({ client, player = 0 }) {
  try {
    return slotOf(await client.sendCommand('game_state', {}), player);
  } catch (err) {
    return null;
  }
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
}) {
  const deadline = now() + timeoutMs;
  let last = null;

  for (;;) {
    try {
      last = await client.sendCommand('game_state', {});
      if (swapLanded(last, player, before)) return { landed: true, slot: slotOf(last, player) };
    } catch (err) {
      last = { error: err.message };
    }

    if (now() >= deadline) {
      // The state comes back too: a game that stopped answering leaves nothing in the slot, and the
      // error that ended the polling is the only thing that says why
      return { landed: false, slot: slotOf(last, player), state: last, seconds: Math.round(timeoutMs / 1000) };
    }
    await sleep(pollMs);
  }
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

// compressRanges is for display only: it sorts and dedupes, so it cannot tell a correct walk from
// the same columns in the wrong order or with a step repeated. cellSequence keeps the order.
export function cellSequence(frames, key) {
  const sequence = [];

  for (const frame of frames || []) {
    const cell = frame && frame[key];
    if (!cell || typeof cell.row !== 'number' || typeof cell.col !== 'number') {
      sequence.push(null);
      continue;
    }
    if (cell.enabled === false) {
      sequence.push(null);
      continue;
    }
    sequence.push([cell.row, cell.col]);
  }
  return sequence;
}

// One column per step, walking the expect span in order. A state whose step count and span length
// disagree has no well-formed walk, so nothing can match it. expectGun is the same shape over the
// gun overlay, for a state whose point is the gun sheet rather than the body row.
export function expectedSequence(state, field = 'expect') {
  const expect = state && state[field];
  const values = state && state.step && state.step.values;
  if (!expect || !Array.isArray(expect.cols) || !Array.isArray(values)) return null;

  const [from, to] = expect.cols;
  if (typeof from !== 'number' || typeof to !== 'number' || typeof expect.row !== 'number') return null;
  if (to - from + 1 !== values.length) return null;

  const walk = [];
  for (let col = from; col <= to; col++) walk.push([expect.row, col]);
  return walk;
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
  if (!expect || typeof expect.row !== 'number' || !Array.isArray(expect.cols)) return '';
  const [from, to] = expect.cols;
  const cols = from === to ? `${from}` : `${from}-${to}`;
  return `${expect.sheet || defaultSheet} row ${expect.row} cols ${cols}`;
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
      skipped.push({ name: record.name, reason: record.skipped, note: state.note || '' });
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
      strip: path.join(outDir, `${record.name.replace(/[^A-Za-z0-9._-]/g, '_')}.png`),
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

  const excluded = (options && options.excluded) || [];

  const lines = [
    `# Animation capture — ${broLabel}`,
    '',
    `- Output: ${outDir}`,
    `- States: ${captured.length} captured, ${skipped.length} skipped, ${excluded.length} excluded`,
    `- Cell mismatches against the state list: ${mismatched.length}`,
    `- States that errored mid-sweep: ${errors.length}`,
  ];
  if (options && options.bro) lines.push(`- Requested bro: ${options.bro}`);
  lines.push('');

  lines.push(`## Captured (${captured.length})`, '');
  if (captured.length === 0) {
    lines.push('_none_', '');
  } else {
    lines.push('| State | Frames | Body cells | Gun cells | Expected | Strip |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const entry of captured) {
      const flag = entry.matches ? '✓' : entry.knownMismatch ? '(known)' : '✗';
      const expected = entry.expected === '' ? '—' : `${entry.expected} ${flag}`;
      const name = entry.offscreen ? `${entry.name} (offscreen frames)` : entry.name;
      lines.push(`| ${name} | ${entry.frames} | ${entry.body || '—'} | ${entry.gun || '—'} | ${expected} | ${entry.strip} |`);
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
    for (const entry of skipped) lines.push(`- **${entry.name}** — ${entry.reason}`);
    lines.push('');
  }

  const missing = states
    .filter((state) => !records.some((record) => record.name === state.name))
    .map((state) => state.name);
  if (missing.length > 0) {
    lines.push(`## Never reached (${missing.length})`, '', ...missing.map((name) => `- ${name}`), '');
  }

  // The same five numbers the summary bullets carry, so the tool reply need not parse its own report
  return {
    text: lines.join('\n'),
    summary: {
      captured: captured.length,
      skipped: skipped.length,
      excluded: excluded.length,
      mismatches: mismatched.length,
      errors: errors.length,
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

// The script's own log lines go to the UMM log, not to execute_script's captured output: the
// output capture only covers Main(), and the sweep runs after Main() has returned
export async function captureLogTail({ resolveLog, maxLines = 20 } = {}) {
  if (typeof resolveLog !== 'function') return { path: null, lines: [], error: 'no log resolver was supplied' };

  let chosen;
  try {
    chosen = await resolveLog();
  } catch (err) {
    return { path: null, lines: [], error: err.message };
  }
  if (!chosen || !chosen.path) return { path: null, lines: [], error: 'no game log found' };

  try {
    const text = await fs.readFile(chosen.path, 'utf-8');
    const hits = text.split('\n').filter((line) => line.includes(LOG_MARKER)).slice(-maxLines);
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

// timeoutMs bounds each of the two commands separately, so a shutdown path can cap what the
// teardown costs it; null leaves each command on its own default budget
export async function teardownGame(client, { timeoutMs = null } = {}) {
  const problems = [];
  for (const [method, params] of [['unload_script', { name: SCRIPT_NAME }], ['set_game_speed', { speed: 1 }]]) {
    try {
      await client.sendCommand(method, params, timeoutMs);
    } catch (err) {
      // The sweep is over either way; a failed teardown step must not hide the capture result,
      // and set_game_speed must still be attempted after a failed unload
      problems.push(`${method}: ${err.message}`);
    }
  }
  return problems;
}

export async function loadStates(statesPaths) {
  const layers = [];

  for (const statesPath of statesPaths) {
    const { states, errors } = validateStates(JSON.parse(await fs.readFile(statesPath, 'utf-8')));
    if (errors.length > 0) {
      throw new UsageError(`${statesPath} is not a usable state list:\n  ${errors.join('\n  ')}`);
    }
    layers.push(states);
  }
  return mergeStates(layers);
}

// The sweep runs on the client the tool layer hands it, so it follows the server to whatever target
// it is pointed at. The options bag is the seam the tests inject their clock through; the tool
// handler passes only resolveLog.
export async function runCapture(options, client, { sleep = delay, pollMs = 500, resolveLog = undefined, isRunning = null } = {}) {
  const gameIsRunning = isRunning ?? (() => isGameRunning(client.gameConfig ?? undefined));

  const all = await loadStates(options.statesPaths);
  const { states, excluded } = partitionLethal(all, options.includeLethal);

  await fs.mkdir(options.out, { recursive: true });
  await fs.writeFile(path.join(options.out, STATES_COPY_NAME), JSON.stringify({ states }, null, 2));
  for (const stale of [DONE_FILE, ERROR_FILE, CAPTURE_FILE, REPORT_FILE]) {
    await fs.rm(path.join(options.out, stale), { force: true });
  }
  // Strips are written per state, so a state that errors this run would otherwise leave the
  // previous run's image sitting next to a report that never mentions it
  for (const entry of await fs.readdir(options.out)) {
    if (entry.endsWith('.png')) await fs.rm(path.join(options.out, entry), { force: true });
  }

  const source = await fs.readFile(SCRIPT_PATH, 'utf-8');

  await client.connect();
  await expectOk(client, 'ping', {});

  if (options.level) {
    await expectOk(client, 'go_to_level', options.level);
    await waitForLevel({ client, player: options.player, timeoutMs: options.timeoutMs, pollMs, sleep });
    if (options.settleMs > 0) await sleep(options.settleMs);
  }

  let swapResult = null;
  if (options.bro) {
    const before = await snapshotSlot({ client, player: options.player });
    const reply = await expectOk(client, 'swap_bro', { broName: options.bro, playerNum: options.player });

    // StateModifier.SwapBro reads the slot's GameObject name on the main thread after the swap, so
    // the reply already says whether the character changed
    const replyName = reply && typeof reply.broName === 'string' ? reply.broName : null;

    if (before && replyName !== null && replyName === before.broName) {
      // Not an error, but not proof the sweep ran on the bro that was asked for either: the slot
      // already held it, so the caller is told rather than the swap being reported as landed
      swapResult = { requested: options.bro, slot: before, alreadyHeld: true };
    } else {
      const swap = await waitForSwap({
        client,
        player: options.player,
        // A reply that named a different character has settled the change already, leaving liveness;
        // a reply with no name to compare falls back to watching the slot for the change itself
        before: replyName === null ? before : null,
        // Falls back rather than reading undefined: a NaN deadline would poll forever
        timeoutMs: options.swapTimeoutMs ?? DEFAULT_SWAP_TIMEOUT_MS,
        pollMs,
        sleep,
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
    if (options.swapSettleMs > 0) await sleep(options.swapSettleMs);
  }

  let outcome;
  try {
    // The script freezes the clock itself: freezing it here first would have it snapshot 0
    const scriptArgs = {
      outDir: options.gameOut,
      statesFile: joinGamePath(options.gameOut, STATES_COPY_NAME),
      player: String(options.player),
    };
    // Left out unless asked for, so the script's own default stays the single source of truth
    if (options.box !== null && options.box !== undefined) scriptArgs.box = String(options.box);
    if (options.allowSideEffects) scriptArgs.suppress = 'false';

    await expectOk(client, 'execute_script', { source, name: SCRIPT_NAME, args: scriptArgs });

    outcome = await waitForSentinel({
      dir: options.out,
      timeoutMs: options.timeoutMs,
      pollMs,
      sleep,
      isRunning: gameIsRunning,
    });
  } finally {
    // A game that is gone has nothing to unfreeze, and both commands would only time out against it
    if (!outcome || outcome.status !== 'game-gone') await teardownGame(client);
  }

  if (outcome.status === 'timeout') {
    // Nothing came back through the socket: the sweep runs after Main() returns, so whatever went
    // wrong is only in the game log. Read it after teardown, so the game is unfrozen either way.
    const tail = await captureLogTail({ resolveLog });
    outcome = { ...outcome, logTail: tail, message: `${outcome.message}\n${formatLogTail(tail)}` };
  }

  const captureRaw = await readIfPresent(path.join(options.out, CAPTURE_FILE));
  const capture = captureRaw === null ? null : JSON.parse(captureRaw);
  const { text, summary } = buildReport({ capture, states, outDir: options.out, options: { ...options, excluded } });
  await fs.writeFile(path.join(options.out, REPORT_FILE), `${text}\n`);

  const stateErrors = (capture && capture.errors) || [];
  return { outcome, report: text, summary, capture, states, excluded, stateErrors, swap: swapResult };
}

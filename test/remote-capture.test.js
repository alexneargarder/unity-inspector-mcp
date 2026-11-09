import { NO_LISTENER_PORT, NO_TOKEN_FILE } from './support/session.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { recordingKill, recordingProcReader } from './support/fake-proc.js';
import { fakeRemoteFs, remoteFsHandler } from './support/remote-fs.js';
import { reply, startStubServer } from './support/stub-server.js';

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-capture-'));

const { handleToolCall, resetTargetResolution, setLaunchResolver, shutdownServer, unityClient } = await import('../index.js');
const {
  CLAIM_SLACK_MS, FETCH_BUDGET_MS, buildReport, runCapture, LEFTOVER_REMOVALS_PER_RUN, REMOTE_CAPTURE_DIR, SCRIPT_PATH, claimLeaseMs, fetchLeaseMs,
  remoteSetupMs,
} = await import('../lib/animation-capture.js');
const { LINUX_GAME_COMM, setKillSignaller, setProcReader } = await import('../lib/game-process.js');
const { WRITE_CHUNK_BYTES } = await import('../lib/remote-files.js');
const { UnityInspectorClient, commandTimeout } = await import('../lib/unity-client.js');

const LOCAL_GAME = { 4242: { comm: LINUX_GAME_COMM, cwd: '/home/player/Broforce', startTicks: 100 } };
const isLinux = process.platform === 'linux';

let procCalls = [];
let kill = recordingKill();
let resolved = 0;

test.after(async () => {
  unityClient.disconnect();
  setProcReader(null);
  setKillSignaller(null);
  setLaunchResolver();
  delete process.env.UNITY_INSPECTOR_HOST;
  await fs.rm(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  resetTargetResolution();
  unityClient.disconnect();
  const { reader, calls } = recordingProcReader(LOCAL_GAME);
  setProcReader(reader);
  procCalls = calls;
  kill = recordingKill();
  setKillSignaller(kill);
  resolved = 0;
  setLaunchResolver(async () => {
    resolved++;
    throw new Error('a launch was resolved on a remote target');
  });
  process.env.UNITY_INSPECTOR_PORT = NO_LISTENER_PORT;
  process.env.UNITY_INSPECTOR_TOKEN_FILE = NO_TOKEN_FILE;
  delete process.env.UNITY_INSPECTOR_HOST;
  delete process.env.UNITY_INSPECTOR_LOG;
});

function assertFenced() {
  assert.deepEqual(procCalls, [], 'the process table was read on a remote target');
  assert.deepEqual(kill.calls, [], 'a signal was sent');
  assert.equal(resolved, 0, 'a launch was resolved');
}

const call = (name, args = {}, options = {}) => handleToolCall({ params: { name, arguments: args } }, options);
const textOf = (response) => response.content.map((c) => c.text).join('\n');

function payload(response) {
  const text = textOf(response);
  assert.ok(!text.startsWith('Error: '), text);
  const body = JSON.parse(response.content[0].text);
  assert.equal(Boolean(response.isError), body.success === false, `isError goes with success: false: ${text}`);
  return body;
}

const exists = (file) => fs.access(file).then(() => true, () => false);

async function until(condition, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition never held');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const LIVE = {
  scene: 'Test Evan2', isInGame: true, levelFinished: false, pauseState: 'UnPaused', levelIndex: 0, timeScale: 1,
  players: [{ playerIndex: 0, broName: 'Rambo(Clone) [local]', className: 'Rambro', isAlive: true, state: 'alive', piloting: null }],
};

const STATES = [
  { name: 'running', step: { field: 'frame', values: [0, 1] }, expect: { sheet: 'main', row: 2, cols: [0, 1] } },
  { name: 'idle', step: { field: 'frame', values: [0] }, expect: { sheet: 'main', row: 1, cols: [0, 0] } },
];

const CAPTURE = {
  bro: { type: 'Rambro', heroType: 'Rambro', customName: null },
  complete: true,
  states: [
    { name: 'running', skipped: null, frames: [{ step: 0, body: { row: 2, col: 0 } }, { step: 1, body: { row: 2, col: 1 } }] },
    { name: 'idle', skipped: null, frames: [{ step: 0, body: { row: 1, col: 0 } }] },
  ],
  errors: [],
};

const STRIPS = { 'running.png': Buffer.from('the remote running strip'), 'idle.png': Buffer.from('the remote idle strip') };

// The AppDomain slot the claim, the sweep and the fetch lease share, read back from the code the server sends
function fakeSlot() {
  const literal = '("(?:[^"\\\\]|\\\\.)*")';
  const entry = new RegExp(`new object\\[\\] \\{ ${literal}, ${literal}, UnityEngine\\.Time\\.realtimeSinceStartup \\+ ([\\d.]+)f \\}`);
  const own = new RegExp(`\\(string\\)live\\[0\\] != ${literal}`);
  const ours = new RegExp(`\\("" \\+ live\\[1\\]\\) == ${literal}`);
  const released = new RegExp(`\\(live\\[0\\] as string\\) == ${literal}`);
  const slot = { entry: null, now: 0, history: [] };
  const set = (value, why) => {
    slot.entry = value;
    slot.history.push({ why, entry: value });
  };
  const held = (token) => {
    const { entry: live } = slot;
    if (live?.kind === 'sweep') return live.out;
    if (live?.kind === 'claim' && live.token !== token && live.leaseEnd > slot.now) return live.out;
    return null;
  };
  const leased = (code) => {
    const [, token, out, seconds] = entry.exec(code);
    return { kind: 'claim', token: JSON.parse(token), out: JSON.parse(out), lease: Number(seconds), leaseEnd: slot.now + Number(seconds) };
  };
  slot.answer = (code) => {
    if (code.includes('bool mine = held == null')) {
      const token = JSON.parse(own.exec(code)[1]);
      const mine = held(token) === null || (slot.entry?.kind === 'sweep' && slot.entry.out === JSON.parse(ours.exec(code)[1]));
      if (mine) set(leased(code), 'lease');
      return mine;
    }
    if (code.includes('if (held == null)')) {
      const holder = held(JSON.parse(own.exec(code)[1]));
      if (holder === null) set(leased(code), 'claim');
      return holder;
    }
    const match = released.exec(code);
    assert.ok(match, `execute_code the fake slot cannot read:\n${code}`);
    const mine = slot.entry?.kind === 'claim' && slot.entry.token === JSON.parse(match[1]);
    if (mine) set(null, 'release');
    return mine;
  };
  return slot;
}

// A remote game: its files are the fake filesystem, its slot the fake slot, and execute_script stands in for
// the capture script, writing what `onScript` gives it into the folder it was handed
async function remoteCaptureGame(t, { remote = fakeRemoteFs({ temporaryCachePath: path.join(scratch, 'game-cache') }), onScript, onUnload, declare = true, delay = null } = {}) {
  const slot = fakeSlot();
  const seen = [];
  const game = { remote, slot, seen, script: null };
  const handler = remoteFsHandler(remote, {
    execute_code: (request, socket) => reply(socket, request.id, { success: true, resultSet: true, result: slot.answer(request.params.code) }),
    game_state: LIVE,
    execute_script: async (request, socket) => {
      const { args } = request.params;
      game.script = args;
      slot.entry = { kind: 'sweep', out: args.outDir };
      slot.history.push({ why: 'script', entry: slot.entry });
      await onScript?.(game, args);
      reply(socket, request.id, { success: true });
    },
    unload_script: (request, socket) => {
      if (slot.entry?.kind === 'sweep') slot.entry = null;
      slot.history.push({ why: 'unload', entry: slot.entry });
      onUnload?.(game);
      reply(socket, request.id, { success: true });
    },
  });
  const stub = await startStubServer(async (request, socket) => {
    seen.push(request);
    const wait = delay?.(request) ?? 0;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    return handler(request, socket);
  });
  t.after(() => stub.close());
  game.stub = stub;
  game.tokenFile = path.join(scratch, `token-${stub.port}`);
  await fs.writeFile(game.tokenFile, createHash('sha256').update(String(stub.port)).digest('hex'));
  if (declare) {
    const declared = payload(await call('launch_game', { remote: { host: '127.0.0.1', port: stub.port, tokenFile: game.tokenFile } }));
    assert.equal(declared.success, true, declared.message);
  }
  procCalls.length = 0;
  game.ops = () => remote.calls.map((entry) => entry.op);
  return game;
}

// What the capture script leaves behind on a finished run: its strips, capture.json, the sentinel, and the
// finished sweep's hold on the slot under its claim
function finishSweep(game, args, { capture = CAPTURE, strips = STRIPS } = {}) {
  const { remote, slot } = game;
  for (const [name, bytes] of Object.entries(strips)) remote.write(path.posix.join(args.outDir, name), bytes);
  remote.write(path.posix.join(args.outDir, 'capture.json'), JSON.stringify(capture));
  remote.write(path.posix.join(args.outDir, 'done'), '');
  slot.entry = { kind: 'claim', token: args.claim, out: args.outDir, leaseEnd: slot.now + Number(args.hold) };
  slot.history.push({ why: 'finish', entry: slot.entry });
}

async function sweepSetup(t, { states = STATES } = {}) {
  const dir = await fs.mkdtemp(path.join(scratch, 'sweep-'));
  const statesPath = path.join(dir, 'states.json');
  await fs.writeFile(statesPath, JSON.stringify({ states }));
  return { dir, out: path.join(dir, 'out'), statesPath };
}

const remoteFilesUnder = (remote, folder) => [...remote.files.keys()].filter((file) => file.startsWith(`${folder}/`));

test('capture_animations takes no gameOut on a remote target, declared or from UNITY_INSPECTOR_HOST, and sends nothing', { timeout: 20000 }, async (t) => {
  const { out, statesPath } = await sweepSetup(t);
  const game = await remoteCaptureGame(t);
  const sent = game.seen.length;

  const refused = await call('capture_animations', { out, states: statesPath, gameOut: '/game/out' });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), new RegExp(`capture_animations takes no gameOut on the remote game at 127\\.0\\.0\\.1:${game.stub.port}: the sweep writes into a folder of its own in the game's temporary cache`));
  assert.equal(game.seen.length, sent, 'a refused sweep reached the game');
  assert.equal(await exists(out), false, 'a refused sweep prepared out');

  if (isLinux) {
    process.env.UNITY_INSPECTOR_HOST = '0.0.0.0';
    process.env.UNITY_INSPECTOR_PORT = String(game.stub.port);
    process.env.UNITY_INSPECTOR_TOKEN_FILE = game.tokenFile;
    resetTargetResolution();
    unityClient.disconnect();
    const envRefused = await call('capture_animations', { out, states: statesPath, gameOut: 'C:\\out' });
    assert.match(textOf(envRefused), /capture_animations takes no gameOut on the user's game/);

    const env = await remoteCaptureGame(t, { declare: false, remote: game.remote, onScript: finishSweep });
    process.env.UNITY_INSPECTOR_PORT = String(env.stub.port);
    process.env.UNITY_INSPECTOR_TOKEN_FILE = env.tokenFile;
    unityClient.disconnect();
    const swept = payload(await call('capture_animations', { out, states: statesPath, timeout: 5 }));
    assert.equal(swept.status, 'done', swept.message);
    assert.deepEqual(await fs.readFile(path.join(out, 'running.png')), STRIPS['running.png'], 'the env path\'s remote steam target fetches as a declared remote does');
  }
  assertFenced();
});

test('a remote sweep sets up its own folder in the game\'s cache, polls it, fetches the strips and capture.json, and removes it', { timeout: 30000 }, async (t) => {
  const note = 'x'.repeat(WRITE_CHUNK_BYTES + 1000);
  const { out, statesPath } = await sweepSetup(t, { states: STATES.map((state) => ({ ...state, note })) });
  const cache = path.join(scratch, 'game-cache');
  const root = path.posix.join(cache, REMOTE_CAPTURE_DIR);
  let probes = 0;
  const game = await remoteCaptureGame(t, {
    onScript: async (game, args) => {
      // The same folder on this machine holds other bytes and an error sentinel: the server must read neither
      await fs.mkdir(args.outDir, { recursive: true });
      await fs.writeFile(path.join(args.outDir, 'running.png'), 'a decoy strip on this machine');
      await fs.writeFile(path.join(args.outDir, 'error'), 'a decoy error on this machine');
      game.remote.write(path.posix.join(args.outDir, 'capture.json'), JSON.stringify({ ...CAPTURE, complete: false, states: [] }));
      game.remote.hooks.sentinel = () => {
        probes++;
        if (probes === 2) game.remote.write(path.posix.join(args.outDir, 'capture.json'), JSON.stringify({ ...CAPTURE, complete: false }));
        if (probes === 3) finishSweep(game, args);
      };
    },
  });
  game.remote.write(path.posix.join(root, 'crashed-server/running.png'), 'left by a server that died');
  game.remote.write(path.posix.join(root, 'stale-run/states.json'), '{}');

  const swept = payload(await call('capture_animations', { out, states: statesPath, timeout: 1 }));
  assert.equal(swept.status, 'done', swept.message);
  assert.equal(probes, 3, 'the sentinel was not polled through execute_code, or capture.json\'s progress did not hold the deadline off');
  assertFenced();

  const claim = game.slot.history.find((step) => step.why === 'claim').entry;
  const gameOut = path.posix.join(root, claim.token);
  assert.equal(claim.out, gameOut, 'the claim names the folder the sweep writes into');
  assert.deepEqual(game.script.outDir, gameOut);
  assert.deepEqual(game.script.statesFile, path.posix.join(gameOut, 'states.json'));
  assert.equal(game.script.claim, claim.token);
  assert.equal(Number(game.script.hold), fetchLeaseMs() / 1000, 'the finished sweep holds the slot until the fetch takes it over');

  const ops = game.ops();
  assert.equal(ops[0], 'list', 'the cache folder is listed before anything changes');
  const removed = game.remote.callsOf('removeDir').map((entry) => entry.params.path);
  assert.deepEqual(removed.slice(0, 2).sort(), [path.posix.join(root, 'crashed-server'), path.posix.join(root, 'stale-run')], 'the leftover folders are removed');
  assert.deepEqual(remoteFilesUnder(game.remote, path.posix.join(root, 'crashed-server')), []);
  const writes = game.remote.callsOf('write');
  const local = await fs.readFile(path.join(out, 'states.json'));
  assert.equal(writes.length, Math.ceil(local.length / WRITE_CHUNK_BYTES), 'states.json is written in chunks');
  assert.ok(writes.every((entry) => entry.params.path === path.posix.join(gameOut, 'states.json')));
  assert.ok(writes.every((entry) => entry.bytes <= WRITE_CHUNK_BYTES));

  for (const [name, bytes] of Object.entries(STRIPS)) {
    assert.deepEqual(await fs.readFile(path.join(out, name)), bytes, `${name} is the game's bytes, not the decoy's`);
  }
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(out, 'capture.json'), 'utf-8')), CAPTURE);
  assert.deepEqual((await fs.readdir(out)).filter((name) => name.endsWith('.part')), [], 'every file was renamed whole');
  assert.ok(await exists(path.join(out, 'report.md')));
  assert.match(swept.report, /## Captured \(2\)/);
  assert.doesNotMatch(swept.report, /Not fetched/);
  assert.equal(swept.paths.capture, path.join(out, 'capture.json'));

  assert.deepEqual(remoteFilesUnder(game.remote, gameOut), [], 'the sweep\'s folder is removed once fetched');
  const order = game.slot.history.map((step) => step.why);
  assert.deepEqual(order, ['claim', 'script', 'finish', 'lease', 'unload', 'release'], 'the lease replaces the finished sweep before the unload, and is released last');
  const lease = game.slot.history.find((step) => step.why === 'lease').entry;
  assert.equal(lease.token, claim.token);
  assert.equal(lease.out, gameOut);
  assert.equal(lease.lease, Number((fetchLeaseMs() / 1000).toFixed(1)));
  assert.equal(game.slot.entry, null);
  const pullsAfterUnload = game.remote.calls.slice(ops.lastIndexOf('sentinel') + 1).map((entry) => entry.op);
  assert.deepEqual(pullsAfterUnload, ['list', 'stat', 'read', 'removeDir'], 'one listing, one stat and one read for the whole set, then the removal');
});

test('the claim lease covers the setup calls a remote sweep adds, and the fetch lease the fetch\'s budget', { timeout: 20000 }, async (t) => {
  const executeCode = commandTimeout('execute_code');
  const options = { timeoutMs: 60000 };
  assert.equal(
    claimLeaseMs(options, { removals: 3, statesBytes: 2 * WRITE_CHUNK_BYTES + 1 }) - claimLeaseMs(options),
    executeCode * (3 + 3 + 4),
    'each leftover removal, each chunk of states.json and the log sync before the mark',
  );
  assert.equal(remoteSetupMs({}), executeCode * (1 + 4), 'an empty states.json still takes one write');
  assert.ok(fetchLeaseMs() >= commandTimeout('unload_script') + commandTimeout('set_game_speed') + FETCH_BUDGET_MS + CLAIM_SLACK_MS);

  const { out, statesPath } = await sweepSetup(t);
  const root = path.posix.join(scratch, 'game-cache', REMOTE_CAPTURE_DIR);
  const game = await remoteCaptureGame(t, { onScript: finishSweep });
  for (let i = 0; i < LEFTOVER_REMOVALS_PER_RUN + 2; i++) game.remote.write(path.posix.join(root, `left-${i}`, 'x.png'), 'x');
  payload(await call('capture_animations', { out, states: statesPath, timeout: 5 }));

  const claim = game.slot.history.find((step) => step.why === 'claim').entry;
  const statesBytes = (await fs.stat(path.join(out, 'states.json'))).size;
  const removals = game.remote.callsOf('removeDir').length - 1;
  assert.equal(removals, LEFTOVER_REMOVALS_PER_RUN, 'one run removes at most its share of leftovers');
  const expected = claimLeaseMs({ timeoutMs: 5000, settleMs: 0, swapSettleMs: 0 }, { removals, statesBytes });
  assert.equal(claim.lease, Number((expected / 1000).toFixed(1)), 'the lease the claim asks for covers the removals and writes it went on to make');
});

test('a cancelled remote sweep still delivers capture.json, and writes no report.md', { timeout: 30000 }, async (t) => {
  const { out, statesPath } = await sweepSetup(t);
  const unloaded = { ...CAPTURE, complete: false, states: CAPTURE.states.slice(0, 1) };
  let gameOut = null;
  const game = await remoteCaptureGame(t, {
    onScript: (game, args) => {
      gameOut = args.outDir;
      game.remote.write(path.posix.join(args.outDir, 'running.png'), STRIPS['running.png']);
    },
    onUnload: (game) => game.remote.write(path.posix.join(gameOut, 'capture.json'), JSON.stringify(unloaded)),
  });

  const controller = new AbortController();
  const sweep = call('capture_animations', { out, states: statesPath, timeout: 60 }, { signal: controller.signal });
  await until(() => game.remote.callsOf('sentinel').length > 0);
  const refused = await call('set_game_speed', { speed: 1 });
  assert.match(textOf(refused), /while a capture_animations sweep into .* Wait for it to finish\.$/m);
  assert.doesNotMatch(textOf(refused), /stop_game/, 'the refusal offers stop_game, which a remote target refuses');
  controller.abort();
  const response = await sweep;
  assert.equal(response.isError, true);
  assert.match(textOf(response), /capture_animations was cancelled/);

  assert.deepEqual(JSON.parse(await fs.readFile(path.join(out, 'capture.json'), 'utf-8')), unloaded, 'the capture.json the unload wrote is fetched');
  assert.deepEqual(await fs.readFile(path.join(out, 'running.png')), STRIPS['running.png']);
  assert.equal(await exists(path.join(out, 'report.md')), false);
  assert.deepEqual(remoteFilesUnder(game.remote, gameOut), []);
  assert.deepEqual(game.slot.history.map((step) => step.why), ['claim', 'script', 'lease', 'unload', 'release']);
  assertFenced();
});

test('a remote game that stops answering mid-sweep ends as timeout, with what arrived fetched and the rest named', { timeout: 40000 }, async (t) => {
  const { out, statesPath } = await sweepSetup(t);
  const partial = { ...CAPTURE, complete: false, states: CAPTURE.states.slice(0, 1) };
  const hung = await remoteCaptureGame(t, {
    onScript: (game, args) => {
      game.remote.write(path.posix.join(args.outDir, 'running.png'), STRIPS['running.png']);
      game.remote.write(path.posix.join(args.outDir, 'capture.json'), JSON.stringify(partial));
      game.remote.append(game.remote.playerLog, '[Script:animation-capture] state running captured\n');
      game.remote.fail.sentinel = "the game's main thread did not answer";
    },
  });
  hung.remote.write(hung.remote.playerLog, '[Script:animation-capture] a line from an earlier sweep\n');

  const timedOut = payload(await call('capture_animations', { out, states: statesPath, timeout: 1 }));
  assert.equal(timedOut.status, 'timeout');
  assert.equal(timedOut.success, false);
  assert.deepEqual(await fs.readFile(path.join(out, 'running.png')), STRIPS['running.png'], 'what the game wrote before it hung is fetched');
  assert.match(timedOut.report, /## Captured \(1\)/);
  assert.match(timedOut.logTail, /state running captured/, 'the tail syncs the log mirror before it reads');
  assert.doesNotMatch(timedOut.logTail, /an earlier sweep/, 'the mark synced the mirror before it marked');
  assertFenced();

  const dead = await remoteCaptureGame(t, { onScript: () => { setTimeout(() => dead.stub.close(), 50); } });
  const started = Date.now();
  const gone = payload(await call('capture_animations', { out, states: statesPath, timeout: 1 }));
  assert.equal(gone.status, 'timeout', 'a dead remote game is a timeout, never game-gone');
  assert.ok(Date.now() - started < FETCH_BUDGET_MS, 'the fetch from a dead game ran past its budget');
  const gameOut = dead.script.outDir;
  assert.match(gone.report, new RegExp(`## Not fetched\\n\\n- The sweep's folder ${gameOut.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} could not be listed, so nothing was fetched: `));
  assert.match(gone.report, /- Files not fetched from the game's machine: all of them, since the sweep's folder could not be listed/);
  assert.doesNotMatch(gone.report, /Never reached/, 'states whose capture.json never arrived are not blamed on the sweep');
  assertFenced();
});

test('a failed pull leaves a report built from what arrived, naming what did not', { timeout: 30000 }, async (t) => {
  const { out, statesPath } = await sweepSetup(t);
  const game = await remoteCaptureGame(t, {
    onScript: (game, args) => {
      finishSweep(game, args);
      game.remote.hooks.read = () => game.remote.files.delete(path.posix.join(args.outDir, 'idle.png'));
    },
  });

  const swept = payload(await call('capture_animations', { out, states: statesPath, timeout: 5 }));
  assert.equal(swept.status, 'done');
  const missing = path.posix.join(game.script.outDir, 'idle.png');
  assert.match(swept.report, new RegExp(`## Not fetched \\(1\\)\\n\\n- ${missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} — it changed or vanished while it was read`));
  assert.match(swept.report, /## Captured \(2\)/, 'the report is built from the capture.json that arrived');
  assert.deepEqual(await fs.readFile(path.join(out, 'running.png')), STRIPS['running.png']);
  assert.equal(await exists(path.join(out, 'idle.png')), false);
  assert.equal(game.slot.entry, null, 'the lease is released after a failed pull too');
});

test('a server shut down during a remote sweep fetches nothing', { timeout: 30000 }, async (t) => {
  const { out, statesPath } = await sweepSetup(t);
  let script = null;
  const game = await remoteCaptureGame(t, { onScript: (game, args) => { script = args; } });

  const sweep = call('capture_animations', { out, states: statesPath, timeout: 20 });
  await until(() => game.remote.callsOf('sentinel').length > 0);
  const exits = [];
  await shutdownServer('SIGTERM', { exit: (code) => exits.push(code) });
  assert.deepEqual(exits, [0]);
  assert.equal(game.seen.filter((request) => request.method === 'unload_script').length, 1, 'the shutdown unloaded the script before it exited');
  const atExit = game.remote.calls.length;

  finishSweep(game, script);
  await sweep;
  const after = game.remote.calls.slice(atExit).map((entry) => entry.op);
  assert.deepEqual(after.filter((op) => op !== 'sentinel' && op !== 'logSync'), [], 'something was fetched or removed after the shutdown');
  assert.equal(await exists(path.join(out, 'running.png')), false);
});

test('a refused claim leaves every folder in the game\'s cache alone', { timeout: 20000 }, async (t) => {
  const { out, statesPath } = await sweepSetup(t);
  const root = path.posix.join(scratch, 'game-cache', REMOTE_CAPTURE_DIR);
  const game = await remoteCaptureGame(t);
  game.remote.write(path.posix.join(root, 'another-server/running.png'), 'still being fetched');
  game.slot.entry = { kind: 'claim', token: 'another-server', out: path.posix.join(root, 'another-server'), leaseEnd: 100 };

  const refused = await call('capture_animations', { out, states: statesPath, timeout: 5 });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), new RegExp(`Another animation-capture sweep, into ${root}/another-server, is running in this game`));
  assert.deepEqual(game.ops(), ['list'], 'nothing was removed or written');
  assert.deepEqual(remoteFilesUnder(game.remote, path.posix.join(root, 'another-server')), [path.posix.join(root, 'another-server/running.png')]);
});

test('the capture script hands a finished sweep\'s slot to its claim for the hold it was given', async () => {
  const script = await fs.readFile(SCRIPT_PATH, 'utf-8');
  assert.match(script, /float hold = ParseFloat\(ScriptContext\.GetArg\("hold", "0"\), 0f\);/);
  assert.match(script, /new object\[\] \{ claimToken, outDir, Time\.realtimeSinceStartup \+ holdSeconds \}/);
  const finish = script.slice(script.indexOf('private void Finish()'), script.indexOf('private bool WriteCapture('));
  assert.match(finish, /HoldLiveSlot\(\);/);
  assert.doesNotMatch(finish, /ReleaseLiveSlot\(\);/);
});

test('a report whose capture.json was not fetched blames no state on the sweep', () => {
  const notFetched = [{ gamePath: '/game/cache/capture-animations/abc/capture.json', reason: 'the budget ran out' }];
  const { text } = buildReport({ capture: null, states: STATES, outDir: '/tmp/out', options: { notFetched } });
  assert.match(text, /## Not fetched \(1\)\n\n- \/game\/cache\/capture-animations\/abc\/capture\.json — the budget ran out/);
  assert.doesNotMatch(text, /Never reached/);
  assert.match(buildReport({ capture: null, states: STATES, outDir: '/tmp/out', options: {} }).text, /## Never reached \(2\)/);
});

test('capture.json is fetched before the strips, so a budget that runs out after the first read still delivers it', { timeout: 30000 }, async (t) => {
  const { out, statesPath } = await sweepSetup(t);
  const big = { 'running.png': Buffer.alloc(1.5 * 1024 * 1024, 1), 'idle.png': Buffer.alloc(1.5 * 1024 * 1024, 2) };
  let reads = 0;
  const game = await remoteCaptureGame(t, {
    declare: false,
    onScript: (game, args) => finishSweep(game, args, { strips: big }),
    delay: (request) => (request.method === 'execute_code' && request.params.code.startsWith('// remote-files read ') && ++reads > 1 ? 2000 : 0),
  });
  const client = new UnityInspectorClient({ host: '127.0.0.1', port: game.stub.port });
  t.after(() => client.disconnect());

  const run = await runCapture(
    { remote: true, statesPaths: [statesPath], out, gameOut: null, timeoutMs: 5000, player: 0 },
    client,
    { pollMs: 5, remotePollMs: 5, fetchBudgetMs: 1000, isRunning: async () => null },
  );
  assert.equal(run.outcome.status, 'done');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(out, 'capture.json'), 'utf-8')), CAPTURE, 'capture.json came in the first read');
  assert.deepEqual(await fs.readFile(path.join(out, 'running.png')), big['running.png']);
  assert.equal(await exists(path.join(out, 'idle.png')), false, 'the budget did not run out after the first read');
  assert.match(run.report, /## Not fetched \(1\)\n\n- .*idle\.png — /);
  assert.match(run.report, /## Captured \(2\)/, 'the report is built from the capture.json that arrived');
});

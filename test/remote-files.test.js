import { NO_LISTENER_PORT, NO_TOKEN_FILE, REMOTE_FILES_SCRATCH } from './support/session.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { recordingKill, recordingProcReader } from './support/fake-proc.js';
import { fakeRemoteFs, remoteFsHandler } from './support/remote-fs.js';
import { startStubServer } from './support/stub-server.js';

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-files-'));

const { handleToolCall, resetTargetResolution, setLaunchResolver, setTarget, unityClient } = await import('../index.js');
const { LINUX_GAME_COMM, setKillSignaller, setProcReader } = await import('../lib/game-process.js');
const { sessionFolder } = await import('../lib/instance.js');
const { LOG_READ_MAX_BYTES } = await import('../lib/log-delta.js');
const {
  TRANSFER_MAX_BYTES, WRITE_CHUNK_BYTES, csString, listCode, logChunkCode, logMirrorPaths, logSyncCode, pruneRemoteSessions,
  pullFile, pullFiles, pullScreenshot, readCode, remoteFilesRoot, removeDirCode, removeRemoteDir, sentinelCode, statCode,
  writeCode, writeRemoteFile,
} = await import('../lib/remote-files.js');

const MiB = 1024 * 1024;
const LOCAL_GAME = { 4242: { comm: LINUX_GAME_COMM, cwd: '/home/player/Broforce', startTicks: 100 } };
const screenshotsDir = path.join(REMOTE_FILES_SCRATCH, sessionFolder(), 'screenshots');

let procCalls = [];
let kill = recordingKill();
let resolved = 0;

test.after(async () => {
  unityClient.disconnect();
  setProcReader(null);
  setKillSignaller(null);
  setLaunchResolver();
  delete process.env.UNITY_INSPECTOR_LOG;
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
  delete process.env.UNITY_INSPECTOR_LOG;
});

function assertFenced() {
  assert.deepEqual(procCalls, [], 'the process table was read on a remote target');
  assert.deepEqual(kill.calls, [], 'a signal was sent');
  assert.equal(resolved, 0, 'a launch was resolved');
}

const call = (name, args = {}) => handleToolCall({ params: { name, arguments: args } });
const textOf = (response) => response.content.map((c) => c.text).join('\n');

function payload(response) {
  const text = response.content[0].text;
  assert.ok(!text.startsWith('Error: '), text);
  return JSON.parse(text);
}

// A client answering execute_code from the fake filesystem, for the transfers alone
const directClient = (remote) => ({
  sendCommand: async (_method, params) => ({ success: true, resultSet: true, result: remote.handle(params.code) }),
});

// A stub mod serving the fake filesystem, declared as this server's remote target
async function remoteGame(t, remote, others = {}) {
  const stub = await startStubServer(remoteFsHandler(remote, others));
  t.after(() => stub.close());
  const tokenFile = path.join(scratch, `token-${stub.port}`);
  await fs.writeFile(tokenFile, createHash('sha256').update(String(stub.port)).digest('hex'));
  const declared = payload(await call('launch_game', { remote: { host: '127.0.0.1', port: stub.port, tokenFile } }));
  assert.equal(declared.success, true, declared.message);
  // Switching away from the user's game asks whether it is still running; nothing after that may
  procCalls.length = 0;
  return { stub, mirror: logMirrorPaths(`127.0.0.1:${stub.port}`) };
}

function bigLog(prefix, bytes) {
  const lines = [];
  let size = 0;
  for (let i = 0; size < bytes; i++) {
    const line = `${prefix} ${i} ${'x'.repeat(90)}\n`;
    lines.push(line);
    size += line.length;
  }
  return Buffer.from(lines.join(''));
}

const syncBytes = (remote) => remote.callsOf('logSync').at(-1).bytes;

// --- transfers -----------------------------------------------------------------------------------

test('the transfer code writes System.IO names in full, declares no generic type or enum, and quotes paths as string literals', () => {
  const file = 'C:\\Users\\"quoted"\\game/Player.log';
  const request = { known: -1, guard: '', lastPath: null };
  const codes = {
    read: readCode([{ path: file, offset: 0, length: 10 }]),
    stat: statCode([file]),
    write: writeCode({ path: file, append: false, data: 'AAAA' }),
    removeDir: removeDirCode(file),
    list: listCode({ path: file }),
    listCache: listCode({ path: file, underCache: true }),
    sentinel: sentinelCode({ path: file, done: 'done', error: 'error', progress: 'capture.json' }),
    logSync: logSyncCode({ player: { ...request, lastPath: file }, umm: request }),
    logChunk: logChunkCode([{ path: file, offset: 0, length: 10, size: 10, tail: '' }]),
  };
  for (const [op, code] of Object.entries(codes)) {
    assert.doesNotMatch(code, /\benum\b/, op);
    assert.doesNotMatch(code, /\w<\w/, `${op} uses a generic type`);
    assert.doesNotMatch(code, /(^|[^.\w])(File|Directory|Path|FileStream|FileInfo|FileMode|FileAccess|FileShare|SeekOrigin)\./m, `${op} names System.IO in short`);
    assert.doesNotMatch(code, /^\s*using\s+[\w.]+\s*;/m, `${op} imports a namespace`);
    if (op !== 'logSync') assert.ok(code.includes(csString(file)), `${op} does not carry the path as a literal`);
  }
  assert.ok(codes.logSync.includes(csString(file)));
  for (const op of ['read', 'logSync', 'logChunk', 'sentinel']) assert.match(codes[op], /System\.IO\.FileShare\.ReadWrite/, op);
  assert.match(codes.listCache, /System\.IO\.Path\.Combine\(UnityEngine\.Application\.temporaryCachePath, /);
});

test('a set past 2 MiB takes more calls, a file past 2 MiB is read in chunks, and a missing file is named', async () => {
  const remote = fakeRemoteFs();
  const sizes = { 'a.bin': 1.5 * MiB, 'b.bin': 1.5 * MiB, 'c.bin': 5 * MiB + 3, 'd.bin': 10, 'e.bin': 0 };
  for (const [name, size] of Object.entries(sizes)) {
    remote.write(`/game/out/${name}`, Buffer.alloc(size, name.charCodeAt(0)));
  }
  const files = [...Object.keys(sizes), 'missing.bin'].map((name) => ({ gamePath: `/game/out/${name}`, localPath: path.join(scratch, 'set', name) }));

  const { pulled, failed } = await pullFiles(directClient(remote), files);
  assert.deepEqual(failed, [{ gamePath: '/game/out/missing.bin', reason: "missing on the game's machine" }]);
  assert.equal(pulled.length, 5);
  for (const [name] of Object.entries(sizes)) {
    assert.ok((await fs.readFile(path.join(scratch, 'set', name))).equals(remote.bytesOf(`/game/out/${name}`)), name);
  }
  const reads = remote.callsOf('read');
  const total = Object.values(sizes).reduce((sum, size) => sum + size, 0);
  assert.ok(reads.length >= Math.ceil(total / TRANSFER_MAX_BYTES), `${reads.length} calls for ${total} bytes`);
  for (const read of reads) assert.ok(read.bytes <= TRANSFER_MAX_BYTES, `a call carried ${read.bytes} bytes`);
  assert.ok(reads.filter((read) => read.params.segments.some((s) => s.path.endsWith('c.bin'))).length >= 3, 'the 5 MiB file came whole');

  remote.calls.length = 0;
  const single = path.join(scratch, 'single.bin');
  assert.equal(await pullFile(directClient(remote), '/game/out/c.bin', single), sizes['c.bin']);
  assert.ok((await fs.readFile(single)).equals(remote.bytesOf('/game/out/c.bin')));
  assert.deepEqual(remote.callsOf('read').map((read) => read.bytes), [TRANSFER_MAX_BYTES, TRANSFER_MAX_BYTES, MiB + 3]);
});

test('a file is written in chunks of about 96 KiB, and a folder is removed whole', async () => {
  const remote = fakeRemoteFs();
  const client = directClient(remote);
  const bytes = Buffer.from(Array.from({ length: 250 * 1024 }, (_, i) => i % 251));
  assert.equal(await writeRemoteFile(client, '/game/cache/capture/states.json', bytes), bytes.length);
  assert.ok(remote.bytesOf('/game/cache/capture/states.json').equals(bytes));
  const writes = remote.callsOf('write');
  assert.deepEqual(writes.map((write) => write.params.append), [false, true, true]);
  for (const write of writes) assert.ok(write.bytes <= WRITE_CHUNK_BYTES);

  await writeRemoteFile(client, '/game/cache/capture/empty.txt', Buffer.alloc(0));
  assert.equal(remote.bytesOf('/game/cache/capture/empty.txt').length, 0);

  assert.equal(await removeRemoteDir(client, '/game/cache/capture'), 'removed');
  assert.equal(remote.bytesOf('/game/cache/capture/states.json'), null);
  assert.equal(await removeRemoteDir(client, '/game/cache/capture'), 'absent');
});

test('remote copies live under the override root, else the state directory, and a session idle for a week is pruned', async () => {
  assert.equal(remoteFilesRoot({ UNITY_INSPECTOR_REMOTE_DIR: '/x/remote' }), '/x/remote');
  assert.equal(remoteFilesRoot({ XDG_STATE_HOME: '/state' }), '/state/unity-inspector-mcp/remote');
  assert.equal(remoteFilesRoot({ XDG_STATE_HOME: 'relative' }, '/home/u'), '/home/u/.local/state/unity-inspector-mcp/remote');

  const root = path.join(scratch, 'prune');
  const week = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const folders = { 'pid-1': now - week - 1000, 'pid-2': now - 1000, 'this-session': now - week - 1000, 'not a session': now - week - 1000 };
  for (const [name, mtime] of Object.entries(folders)) {
    await fs.mkdir(path.join(root, name, 'logs'), { recursive: true });
    await fs.utimes(path.join(root, name), new Date(mtime), new Date(mtime));
  }
  await pruneRemoteSessions(root, path.join(root, 'this-session'), { nowMs: now });
  assert.deepEqual((await fs.readdir(root)).sort(), ['not a session', 'pid-2', 'this-session']);
});

// --- screenshots ---------------------------------------------------------------------------------

test('a plain shot, a backdrop shot and a test-script step each land the game\'s bytes here, never the decoy\'s', { timeout: 30000 }, async (t) => {
  const remote = fakeRemoteFs();
  const gameDir = path.join(scratch, 'decoy', 'Screenshots');
  await fs.mkdir(gameDir, { recursive: true });
  const shots = {
    plain: path.join(gameDir, 'screenshot_plain.png'),
    backdrop: path.join(gameDir, 'screenshot_backdrop.png'),
    step: path.join(gameDir, 'screenshot_step.png'),
  };
  for (const [kind, file] of Object.entries(shots)) {
    await fs.writeFile(file, `DECOY ${kind}`);
    remote.write(file, `REMOTE ${kind}`);
  }
  let next = shots.plain;
  await remoteGame(t, remote, {
    take_screenshot: (request, socket) => socket.write(JSON.stringify({ id: request.id, success: true, result: { path: next } }) + '\n'),
    execute_code: { success: true, resultSet: true, result: shots.backdrop },
  });

  const plain = payload(await call('take_screenshot'));
  assert.equal(plain.gamePath, shots.plain);
  assert.equal(path.dirname(plain.path), screenshotsDir);
  assert.equal(await fs.readFile(plain.path, 'utf8'), 'REMOTE plain');

  const backdrop = payload(await call('take_screenshot', { backdrop: true }));
  assert.equal(backdrop.gamePath, shots.backdrop);
  assert.equal(backdrop.backdrop, '#FF00FF');
  assert.equal(path.dirname(backdrop.path), screenshotsDir);
  assert.equal(await fs.readFile(backdrop.path, 'utf8'), 'REMOTE backdrop');

  next = shots.step;
  const script = path.join(scratch, 'shot-step.json');
  await fs.writeFile(script, JSON.stringify({ name: 'shot-step', steps: [{ command: 'take_screenshot' }] }));
  const run = payload(await call('run_test_script', { script }));
  assert.equal(run.passed, true, JSON.stringify(run));
  const step = JSON.parse(await fs.readFile(run.resultsFile, 'utf8')).results[0].result;
  assert.equal(step.gamePath, shots.step);
  assert.equal(path.dirname(step.path), screenshotsDir);
  assert.equal(await fs.readFile(step.path, 'utf8'), 'REMOTE step');
  assertFenced();
});

test('a C:/ game path is fetched as the game names it, never through this machine\'s Proton prefix', { timeout: 20000 }, async (t) => {
  const remote = fakeRemoteFs();
  const gamePath = 'C:/users/steamuser/Broforce/Mods/Unity Inspector Mod/Screenshots/screenshot_windows.png';
  remote.write(gamePath, 'REMOTE windows');
  await remoteGame(t, remote, { take_screenshot: { path: gamePath } });
  const prefix = unityClient.protonPrefix;
  const platform = unityClient.platform;
  unityClient.protonPrefix = path.join(scratch, 'pfx');
  unityClient.platform = 'linux';
  t.after(() => {
    unityClient.protonPrefix = prefix;
    unityClient.platform = platform;
  });

  const shot = payload(await call('take_screenshot'));
  assert.equal(shot.gamePath, gamePath);
  assert.equal(shot.path, path.join(screenshotsDir, 'screenshot_windows.png'));
  assert.equal(await fs.readFile(shot.path, 'utf8'), 'REMOTE windows');
  assert.deepEqual(remote.callsOf('read').map((read) => read.params.segments[0].path), [gamePath]);
  assertFenced();
});

test('a screenshot that cannot be fetched is a tool error naming the game\'s own path', { timeout: 20000 }, async (t) => {
  const remote = fakeRemoteFs();
  await remoteGame(t, remote, { take_screenshot: { path: '/game/Screenshots/screenshot_gone.png' } });

  const missing = await call('take_screenshot');
  assert.equal(missing.isError, true);
  assert.match(textOf(missing), /The screenshot was taken but could not be fetched from the game's machine, where it is \/game\/Screenshots\/screenshot_gone\.png: \/game\/Screenshots\/screenshot_gone\.png could not be read/);

  remote.write('/game/Screenshots/screenshot_gone.png', 'bytes');
  remote.fail.read = 'the main thread is busy';
  const failed = await call('take_screenshot');
  assert.equal(failed.isError, true);
  assert.match(textOf(failed), /could not be fetched from the game's machine.*the main thread is busy/);
  assertFenced();
});

test('only the newest 50 fetched screenshots are kept', async () => {
  const remote = fakeRemoteFs();
  const client = { ...directClient(remote) };
  for (let i = 0; i < 52; i++) {
    const name = `/game/Screenshots/keep_${String(i).padStart(3, '0')}.png`;
    remote.write(name, `shot ${i}`);
    await pullScreenshot(client, name);
  }
  const kept = (await fs.readdir(screenshotsDir)).filter((name) => name.startsWith('keep_'));
  assert.equal(kept.length, 50);
  assert.ok(!kept.includes('keep_000.png') && !kept.includes('keep_001.png'), kept.join(', '));
});

// --- read_log ------------------------------------------------------------------------------------

test('read_log reads a mirror of the remote log, and onlyNew across two syncs fetches only the new bytes', { timeout: 20000 }, async (t) => {
  const remote = fakeRemoteFs();
  remote.write(remote.playerLog, 'one\ntwo\n');
  const { mirror } = await remoteGame(t, remote);

  const tail = payload(await call('read_log'));
  assert.equal(tail.path, mirror.player);
  assert.equal(tail.content, 'one\ntwo');
  assert.equal(tail.modifiedAt, new Date(remote.files.get(remote.playerLog).mtimeMs).toISOString());
  assert.equal(tail.stale, undefined);
  const inode = (await fs.stat(mirror.player)).ino;

  assert.equal(payload(await call('read_log', { onlyNew: true })).isBaseline, true);
  remote.append(remote.playerLog, 'three\n');
  const first = payload(await call('read_log', { onlyNew: true }));
  assert.deepEqual([first.isBaseline, first.content], [false, 'three']);
  assert.equal(syncBytes(remote), 'three\n'.length);
  remote.append(remote.playerLog, 'four\n');
  const second = payload(await call('read_log', { onlyNew: true }));
  assert.deepEqual([second.isBaseline, second.content], [false, 'four']);
  assert.equal(syncBytes(remote), 'four\n'.length);

  assert.ok((await fs.readFile(mirror.player)).equals(remote.bytesOf(remote.playerLog)));
  assert.equal((await fs.stat(mirror.player)).ino, inode, 'an append replaced the mirror');
  assertFenced();
});

test('a remote log already past the window at the first sync keeps onlyNew and the run delta right once appended to', { timeout: 60000 }, async (t) => {
  const remote = fakeRemoteFs();
  remote.write(remote.playerLog, bigLog('before', LOG_READ_MAX_BYTES + MiB));
  const error = '[Remote Mod] [Error] it broke during the run\n';
  const { mirror } = await remoteGame(t, remote, {
    list_campaigns: (request, socket) => {
      remote.append(remote.playerLog, error);
      socket.write(JSON.stringify({ id: request.id, success: true, result: {} }) + '\n');
    },
  });

  assert.equal(payload(await call('read_log', { onlyNew: true })).isBaseline, true);
  const held = await fs.readFile(mirror.player);
  const whole = remote.bytesOf(remote.playerLog);
  assert.ok(held.length <= LOG_READ_MAX_BYTES && held.length > LOG_READ_MAX_BYTES - 200, `${held.length} bytes mirrored`);
  assert.ok(whole.subarray(whole.length - held.length).equals(held), 'the mirror is not the file\'s newest bytes');
  assert.ok(held.toString().startsWith('before '), 'the window starts mid-line');

  remote.append(remote.playerLog, 'after one\n');
  const next = payload(await call('read_log', { onlyNew: true }));
  assert.deepEqual([next.isBaseline, next.content], [false, 'after one']);

  const script = path.join(scratch, 'grows.json');
  await fs.writeFile(script, JSON.stringify({ name: 'grows', steps: [{ command: 'list_campaigns' }] }));
  const syncs = remote.callsOf('logSync').length;
  const run = payload(await call('run_test_script', { script }));
  assert.equal(run.logs.player.path, mirror.player);
  assert.equal(run.logs.player.bytes, error.length);
  assert.equal(run.logs.player.rotated, undefined);
  assert.equal(run.logs.summary.errors, 1, JSON.stringify(run.logs));
  assert.equal(remote.callsOf('logSync').length - syncs, 2, 'the run syncs before its snapshot and before its delta');
  assertFenced();
});

test('a gap past the window rebaselines onlyNew, and the mirror holds no NUL or stitched bytes', { timeout: 60000 }, async (t) => {
  const remote = fakeRemoteFs();
  remote.write(remote.playerLog, 'start\n');
  const { mirror } = await remoteGame(t, remote);

  assert.equal(payload(await call('read_log', { onlyNew: true })).isBaseline, true);
  remote.append(remote.playerLog, bigLog('flood', LOG_READ_MAX_BYTES + 64 * 1024));
  const after = payload(await call('read_log', { onlyNew: true }));
  assert.equal(after.isBaseline, true, 'the bytes between were never fetched');

  const held = await fs.readFile(mirror.player);
  const whole = remote.bytesOf(remote.playerLog);
  assert.equal(held.indexOf(0), -1, 'the mirror holds a NUL');
  assert.ok(!held.includes('start\n'), 'the old bytes were stitched to the new');
  assert.ok(held.length <= LOG_READ_MAX_BYTES);
  assert.ok(whole.subarray(whole.length - held.length).equals(held));
  assertFenced();
});

test('a shrunk or rotated remote log rewrites the mirror in place', { timeout: 20000 }, async (t) => {
  const remote = fakeRemoteFs();
  remote.write(remote.playerLog, 'old a\nold b\nold c\n');
  const { mirror } = await remoteGame(t, remote);
  assert.equal(payload(await call('read_log')).content, 'old a\nold b\nold c');
  const inode = (await fs.stat(mirror.player)).ino;

  remote.write(remote.playerLog, 'new\n');
  assert.equal(payload(await call('read_log')).content, 'new');
  assert.equal(await fs.readFile(mirror.player, 'utf8'), 'new\n');

  remote.write(remote.playerLog, 'xyz\n');
  assert.equal(payload(await call('read_log')).content, 'xyz');
  assert.equal(await fs.readFile(mirror.player, 'utf8'), 'xyz\n');
  assert.equal((await fs.stat(mirror.player)).ino, inode, 'a refill replaced the mirror rather than truncating it');
  assertFenced();
});

test('a rotation between a sync\'s chunks aborts the sync, and the next sync rewrites', { timeout: 60000 }, async (t) => {
  const remote = fakeRemoteFs();
  remote.write(remote.playerLog, 'before\n');
  const { mirror } = await remoteGame(t, remote);
  assert.equal(payload(await call('read_log')).content, 'before');

  remote.write(remote.playerLog, bigLog('first', 3 * MiB));
  remote.hooks.logChunk = () => {
    remote.hooks.logChunk = null;
    remote.write(remote.playerLog, bigLog('second', 3 * MiB));
  };
  const aborted = await call('read_log');
  assert.equal(aborted.isError, true);
  assert.match(textOf(aborted), /The remote game's log .*Player\.log shrank or was rewritten while it was being fetched/);
  assert.equal(await fs.readFile(mirror.player, 'utf8'), 'before\n', 'an aborted sync wrote to the mirror');

  const fresh = payload(await call('read_log', { lines: 1 }));
  assert.match(fresh.content, /^second \d+ x+$/);
  assert.ok((await fs.readFile(mirror.player)).equals(remote.bytesOf(remote.playerLog)));
  assertFenced();
});

test('parallel syncs of one endpoint fetch each byte once, and a refill never interleaves with an append', { timeout: 30000 }, async (t) => {
  const remote = fakeRemoteFs();
  remote.write(remote.playerLog, 'start\n');
  let syncs = 0;
  let beforeRotation = 0;
  remote.hooks.logSync = () => {
    syncs++;
    if (syncs === 3) {
      beforeRotation = remote.bytesOf(remote.playerLog).length;
      remote.write(remote.playerLog, 'rotated\n');
    } else {
      remote.append(remote.playerLog, `line ${syncs}\n`);
    }
  };
  const { mirror } = await remoteGame(t, remote);

  const reads = await Promise.all([
    call('read_log'), call('read_log', { onlyNew: true }), call('read_log'),
    call('read_log', { onlyNew: true }), call('read_log', { filter: 'line' }), call('read_log'),
  ]);
  for (const read of reads) assert.ok(!read.isError, textOf(read));
  assert.equal(syncs, 6);
  const final = remote.bytesOf(remote.playerLog);
  assert.ok((await fs.readFile(mirror.player)).equals(final), 'the mirror is not the remote file');
  assert.equal(remote.fetchedBytes('logSync'), beforeRotation + final.length);
  assertFenced();
});

test('filter and a deep tail read the mirror right after a refill', { timeout: 20000 }, async (t) => {
  const remote = fakeRemoteFs();
  remote.write(remote.playerLog, 'a1 keep\na2\n');
  await remoteGame(t, remote);
  assert.equal(payload(await call('read_log')).content, 'a1 keep\na2');

  remote.write(remote.playerLog, 'b1 keep\nb2\nb3 keep\n');
  assert.equal(payload(await call('read_log', { filter: 'KEEP' })).content, 'b1 keep\nb3 keep');
  const deep = payload(await call('read_log', { lines: 1000 }));
  assert.deepEqual([deep.content, deep.returnedLines], ['b1 keep\nb2\nb3 keep', 3]);
  assertFenced();
});

test('a failed sync is a read_log error', { timeout: 20000 }, async (t) => {
  const remote = fakeRemoteFs();
  remote.write(remote.playerLog, 'line\n');
  await remoteGame(t, remote);
  remote.fail.logSync = 'the evaluator could not compile it';
  for (const args of [{}, { onlyNew: true }, { filter: 'line' }]) {
    const failed = await call('read_log', args);
    assert.equal(failed.isError, true, JSON.stringify(args));
    assert.match(textOf(failed), /Fetching the game's log failed in the game: the evaluator could not compile it/);
  }
  assertFenced();
});

test('a remote game with no log at all says so, and the UMM log stands in for a missing player log', { timeout: 20000 }, async (t) => {
  const remote = fakeRemoteFs();
  const { mirror } = await remoteGame(t, remote);
  const none = await call('read_log');
  assert.equal(none.isError, true);
  assert.match(textOf(none), /The remote game at 127\.0\.0\.1:\d+ has no log yet: neither its Unity player log .* nor Unity Mod Manager's log exists on its machine/);

  remote.write(remote.ummLog, '[UMM] loaded\n');
  const umm = payload(await call('read_log'));
  assert.deepEqual([umm.path, umm.content], [mirror.umm, '[UMM] loaded']);
  assertFenced();
});

test('UNITY_INSPECTOR_LOG is ignored on a declared remote', { timeout: 20000 }, async (t) => {
  const remote = fakeRemoteFs();
  remote.write(remote.playerLog, 'remote line\n');
  const decoy = path.join(scratch, 'decoy-Player.log');
  await fs.writeFile(decoy, 'decoy line\n');
  process.env.UNITY_INSPECTOR_LOG = decoy;
  const { mirror } = await remoteGame(t, remote);

  const read = payload(await call('read_log'));
  assert.deepEqual([read.path, read.content], [mirror.player, 'remote line']);
  assert.deepEqual(payload(await call('game_state')).logs, mirror);
  assertFenced();
});

test('game_state names the mirrors and sends no sync', { timeout: 20000 }, async (t) => {
  const remote = fakeRemoteFs();
  remote.write(remote.playerLog, 'line\n');
  const { mirror } = await remoteGame(t, remote, { game_state: { scene: 'Test Evan2' } });
  const state = payload(await call('game_state'));
  assert.deepEqual(state.logs, mirror);
  assert.equal(remote.callsOf('logSync').length, 0);
  assertFenced();
});

test('onlyNew keeps its position across a switch between targets', { timeout: 20000 }, async (t) => {
  const remote = fakeRemoteFs();
  remote.write(remote.playerLog, 'remote 1\n');
  const local = path.join(scratch, 'switch-Player.log');
  await fs.writeFile(local, 'local 1\n');
  process.env.UNITY_INSPECTOR_LOG = local;
  await remoteGame(t, remote);

  assert.equal(payload(await call('read_log', { onlyNew: true })).isBaseline, true);
  await setTarget('steam');
  assert.equal(payload(await call('read_log', { onlyNew: true })).isBaseline, true);

  await fs.appendFile(local, 'local 2\n');
  remote.append(remote.playerLog, 'remote 2\n');
  await setTarget('remote');
  const back = payload(await call('read_log', { onlyNew: true }));
  assert.deepEqual([back.isBaseline, back.content], [false, 'remote 2']);
  await setTarget('steam');
  const steam = payload(await call('read_log', { onlyNew: true }));
  assert.deepEqual([steam.isBaseline, steam.content], [false, 'local 2']);
});

// --- run_test_script -----------------------------------------------------------------------------

test('a connection-level failure under a step is the game gone on a remote target, with no process read', { timeout: 30000 }, async (t) => {
  const remote = fakeRemoteFs();
  remote.write(remote.playerLog, 'line\n');
  await remoteGame(t, remote, { list_campaigns: (_request, socket) => socket.destroy() });
  const script = path.join(scratch, 'gone.json');
  await fs.writeFile(script, JSON.stringify({ name: 'gone', steps: [{ command: 'list_campaigns' }], cleanup: [{ command: 'list_bros' }] }));

  const run = payload(await call('run_test_script', { script }));
  assert.equal(run.passed, false);
  assert.match(run.cleanupSkipped, /^the game is gone \(The connection to the remote game at 127\.0\.0\.1:\d+ closed under the command, which may have run/);
  assert.equal(remote.callsOf('logSync').length, 1, 'the delta synced a game that is gone');
  assert.deepEqual(run.logs, { error: "the remote game is gone, so its log was not fetched after the run: read it on the game's own machine" });
  assertFenced();
});

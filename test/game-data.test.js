import { NOT_WSL } from './support/session.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const { handleToolCall, resetPlatformDetection, targetLogPaths } = await import('../index.js');
const { LINUX_GAME_COMM, activeUmmLog, forgetGameDataLocations, gameDataLocations, setProcReader, setWslProbe } = await import('../lib/game-process.js');
const { UnityInspectorClient, tokenFileName, unityDataDirs } = await import('../lib/unity-client.js');
const { instanceConfig, steamConfig, withRoot } = await import('../lib/instance.js');
const { fakeProcReader, recordingProcReader } = await import('./support/fake-proc.js');
const { reply, startStubServer } = await import('./support/stub-server.js');

const linuxOnly = { skip: process.platform !== 'linux' && 'the game is read from /proc on Linux only' };

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'game-data-'));
test.after(() => fs.rm(scratch, { recursive: true, force: true }));

const PRODUCT = 'Free Lives/Broforce';
const LOCALLOW = 'drive_c/users/steamuser/AppData/LocalLow';
const tokenOf = (seed) => createHash('sha256').update(seed).digest('hex');
// The fake game starts a second after the fake boot, so anything written now is from its run
const BEFORE_THE_RUN = new Date('2025-06-01T00:00:00Z');
const winPath = (unixPath) => unixPath.replace(/\//g, '\\');

let counter = 0;
async function write(file, contents, mtime = null) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
  if (mtime) await fs.utimes(file, mtime, mtime);
  return file;
}

// The game's own launcher moved its data folders under a root that holds a space
async function withMovedGame(processes, run) {
  const home = path.join(scratch, `home-${++counter}`);
  const root = path.join(scratch, `root-${counter}`, 'moved data');
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(root, { recursive: true });

  const keys = ['HOME', 'APPDATA', 'USERPROFILE', 'UNITY_INSPECTOR_TOKEN_FILE', 'UNITY_INSPECTOR_LOG'];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.HOME = home;
  for (const key of keys.slice(1)) delete process.env[key];
  resetPlatformDetection();
  forgetGameDataLocations();
  const table = { current: processes(root, home) };
  setProcReader(fakeProcReader(table.current));

  try {
    return await run({ root, home, table, exitGame: () => setProcReader(fakeProcReader({})) });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    setProcReader(null);
    forgetGameDataLocations();
    resetPlatformDetection();
  }
}

const nativeGame = (root, home) => ({
  700: {
    comm: LINUX_GAME_COMM,
    cwd: path.join(root, 'game'),
    startTicks: 100,
    cmdline: [path.join(root, 'game/Broforce.x86_64')],
    environ: [`HOME=${home}`, `XDG_CONFIG_HOME=${root}/config`, `DOORSTOP_TARGET_ASSEMBLY=${root}/profile/UMM/Core/UnityModManager.dll`, 'LANG=C'],
  },
});

const protonGame = (extraEnv = []) => (root, home) => ({
  800: {
    comm: 'wine64-preloader',
    cwd: path.join(root, 'game'),
    startTicks: 100,
    cmdline: [
      `Z:${winPath(root)}\\game\\Broforce.exe`,
      '--doorstop-enabled', 'true',
      '--doorstop-target-assembly', `Z:${winPath(root)}\\profile\\UMM\\Core\\UnityModManager.dll`,
      '--r2profile', 'Default',
    ],
    environ: [`HOME=${home}`, `STEAM_COMPAT_DATA_PATH=${root}/compatdata`, ...extraEnv],
  },
});

const nativeDataDir = (root) => path.join(root, 'config/unity3d', PRODUCT);
const protonDataDir = (root) => path.join(root, 'compatdata/pfx', LOCALLOW, PRODUCT);
const homeDataDir = (home) => path.join(home, '.config/unity3d', PRODUCT);
const movedUmmLog = (root) => path.join(root, 'profile/UMM/Core/Log.txt');

async function helloToken(dataDir, home) {
  const stub = await startStubServer((request, socket) => reply(socket, request.id, { pong: true }), { hello: 'accept' });
  const client = new UnityInspectorClient({ host: '127.0.0.1', port: stub.port, connectTimeoutMs: 2000 });
  client.pointAt({ port: stub.port, gameConfig: steamConfig() });
  try {
    await write(path.join(homeDataDir(home), tokenFileName(stub.port)), tokenOf('stale'), BEFORE_THE_RUN);
    await write(path.join(dataDir, tokenFileName(stub.port)), tokenOf('moved'));
    await client.sendCommand('ping', {}, 3000);
    return stub.hellos[0].token;
  } finally {
    client.disconnect();
    await stub.close();
  }
}

async function readLog(args = { lines: 5 }) {
  const response = await handleToolCall({ params: { name: 'read_log', arguments: args } });
  const text = response.content.map((c) => c.text).join('\n');
  return response.isError ? { error: text } : JSON.parse(text);
}

test('a native game with its data folders moved: its token, its player log and its UMM log', linuxOnly, async () => {
  await withMovedGame(nativeGame, async ({ root, home }) => {
    assert.equal(await helloToken(nativeDataDir(root), home), tokenOf('moved'), 'the hello carries the moved token, not the stale one');

    const missing = await readLog();
    assert.match(missing.error, /Log file not found/);
    assert.ok(missing.error.includes(path.join(nativeDataDir(root), 'Player.log')), missing.error);
    assert.ok(missing.error.includes(movedUmmLog(root)), 'the not-found message names the derived logs');

    await write(path.join(homeDataDir(home), 'Player.log'), 'another run\n', BEFORE_THE_RUN);
    const player = await write(path.join(nativeDataDir(root), 'Player.log'), 'moved run\n');
    await write(path.join(home, '.config/r2modmanPlus-local/Broforce/profiles/Default/UMM/Core/Log.txt'), 'a profile log\n');
    const umm = await write(movedUmmLog(root), 'moved umm\n');

    const read = await readLog();
    assert.equal(read.path, player);
    assert.match(read.content, /moved run/);
    assert.deepEqual(await targetLogPaths(), { umm, player });
  });
});

test('a Proton game with its prefix moved: its token, its output_log.txt and the UMM log of its Z: target', linuxOnly, async () => {
  await withMovedGame(protonGame(), async ({ root, home }) => {
    assert.equal(await helloToken(protonDataDir(root), home), tokenOf('moved'));

    const player = await write(path.join(protonDataDir(root), 'output_log.txt'), 'proton run\n');
    const umm = await write(movedUmmLog(root), 'moved umm\n');
    assert.equal((await readLog()).path, player);
    assert.deepEqual(await targetLogPaths(), { umm, player });
  });
});

test('WINEPREFIX wins over STEAM_COMPAT_DATA_PATH, and a drive other than Z: translates through it', linuxOnly, async () => {
  await withMovedGame(protonGame(['WINEPREFIX=/srv/own prefix/']), async ({ table }) => {
    assert.deepEqual((await gameDataLocations(steamConfig(), fakeProcReader(table.current))).winePrefixes, ['/srv/own prefix']);

    const client = new UnityInspectorClient({ host: '127.0.0.1', port: 1 });
    client.platform = 'linux';
    client.protonPrefix = '/steam/compatdata/274190/pfx';
    client.pointAt({ port: 1, gameConfig: steamConfig() });
    assert.equal(await client.translateScreenshotPath('C:/users/steamuser/shot.png'), '/srv/own prefix/dosdevices/c:/users/steamuser/shot.png');
    assert.equal(await client.translateScreenshotPath('Z:/tmp/shot.png'), '/tmp/shot.png');

    setProcReader(fakeProcReader({}));
    forgetGameDataLocations();
    assert.equal(await client.translateScreenshotPath('C:/users/steamuser/shot.png'), '/steam/compatdata/274190/pfx/dosdevices/c:/users/steamuser/shot.png',
      'with no prefix of its own the Steam library\'s stands in');
  });
});

test('a Doorstop target found only on an ancestor\'s argv names the UMM log', linuxOnly, async () => {
  const root = '/srv/moved data';
  const reader = fakeProcReader({
    900: { comm: 'sh', cwd: '/home/u', startTicks: 50, cmdline: ['/bin/sh', `${root}/profile/run_umm.sh`, 'Broforce.x86_64', '--doorstop-enabled', 'true', '--doorstop-target', `${root}/profile/UMM/Core/UnityModManager.dll`] },
    901: { comm: LINUX_GAME_COMM, cwd: `${root}/game`, ppid: 900, startTicks: 100, cmdline: [`${root}/game/Broforce.x86_64`], environ: ['LANG=C'] },
  });
  forgetGameDataLocations();
  assert.equal(await activeUmmLog(steamConfig(), { reader }), movedUmmLog(root));
  forgetGameDataLocations();
});

test('an ordinary desktop run and a Proton run under r2modman\'s profile folder resolve the same log and token folders as before', linuxOnly, async () => {
  const home = '/home/u';
  const defaultTarget = `${home}/.config/r2modmanPlus-local/Broforce/profiles/Default/UMM/Core/UnityModManager.dll`;
  const defaultLog = `${home}/.config/r2modmanPlus-local/Broforce/profiles/Default/UMM/Core/Log.txt`;
  const steamPrefix = `${home}/.local/share/Steam/steamapps/compatdata/274190/pfx`;

  const desktop = fakeProcReader({
    95: { comm: 'reaper', cwd: home, startTicks: 95, cmdline: `${home}/.local/share/Steam/ubuntu12_32/reaper SteamLaunch AppId=274190 -- ${home}/.config/r2modmanPlus-local/Broforce/profiles/Default/linux_wrapper.sh ${home}/game/Broforce.x86_64 --doorstop-enabled true --doorstop-target-assembly ${defaultTarget} --r2profile Default` },
    100: { comm: LINUX_GAME_COMM, cwd: `${home}/game`, ppid: 95, startTicks: 100, cmdline: `${home}/game/Broforce.x86_64`, environ: `HOME=${home} DOORSTOP_TARGET_ASSEMBLY=${defaultTarget}` },
  });
  forgetGameDataLocations();
  const native = await gameDataLocations(steamConfig(), desktop);
  assert.equal(native.ummLog, defaultLog);
  assert.deepEqual(await unityDataDirs({ env: {}, home, gameData: native }), await unityDataDirs({ env: {}, home }));

  const proton = fakeProcReader({
    100: {
      comm: 'wine64-preloader',
      cwd: `${home}/.local/share/Steam/steamapps/common/Broforce`,
      startTicks: 100,
      cmdline: `Z:\\home\\u\\.local\\share\\Steam\\steamapps\\common\\Broforce\\Broforce.exe --doorstop-enabled true --doorstop-target-assembly Z:${defaultTarget} --r2profile Default`,
      environ: `HOME=${home} STEAM_COMPAT_DATA_PATH=${home}/.local/share/Steam/steamapps/compatdata/274190 WINEPREFIX=${steamPrefix}/`,
    },
  });
  forgetGameDataLocations();
  const wine = await gameDataLocations(steamConfig(), proton);
  assert.equal(wine.ummLog, defaultLog);
  const folders = async (gameData) => {
    const { linux, windows } = await unityDataDirs({ env: {}, home, protonPrefix: steamPrefix, gameData });
    return [...linux, ...windows].sort();
  };
  assert.deepEqual(await folders(wine), await folders(null), 'every candidate is ranked by mtime, so only the set counts');
  forgetGameDataLocations();
});

test('two games given different Doorstop targets pick no UMM log, and the newest of every candidate is read', linuxOnly, async () => {
  const twoGames = (root, home) => ({
    700: { ...nativeGame(root, home)[700], environ: [`HOME=${home}`, `DOORSTOP_TARGET_ASSEMBLY=${root}/one/UMM/Core/UnityModManager.dll`] },
    701: { ...nativeGame(root, home)[700], environ: [`HOME=${home}`, `DOORSTOP_TARGET_ASSEMBLY=${root}/two/UMM/Core/UnityModManager.dll`] },
  });
  await withMovedGame(twoGames, async ({ root, home, table }) => {
    const found = await gameDataLocations(steamConfig(), fakeProcReader(table.current));
    assert.equal(found.ummLog, null);
    assert.deepEqual(found.ummLogs, [`${root}/one/UMM/Core/Log.txt`, `${root}/two/UMM/Core/Log.txt`]);

    await write(path.join(home, '.config/r2modmanPlus-local/Broforce/profiles/Default/UMM/Core/Log.txt'), 'profile\n', new Date(Date.now() - 20000));
    await write(`${root}/one/UMM/Core/Log.txt`, 'one\n', new Date(Date.now() - 10000));
    const two = await write(`${root}/two/UMM/Core/Log.txt`, 'two\n');
    assert.equal((await readLog()).path, two);
    assert.equal((await targetLogPaths()).umm, two);
  });
});

test('once the game exits its moved folders are still read, and a fresher log elsewhere outranks them', linuxOnly, async () => {
  await withMovedGame(nativeGame, async ({ root, home, exitGame, table }) => {
    const moved = await write(path.join(nativeDataDir(root), 'Player.log'), 'the crashed run\n', new Date(Date.now() - 30000));
    assert.equal((await readLog()).path, moved);

    exitGame();
    assert.equal((await readLog()).path, moved, 'the run that crashed is still the log');
    const remembered = await gameDataLocations(steamConfig());
    assert.equal(remembered.ummLog, null, 'a remembered UMM log is a candidate, never the active one');
    assert.deepEqual(remembered.ummLogs, [movedUmmLog(root)]);

    const throwing = { ...fakeProcReader(table.current), pids: async () => { throw new Error('EACCES'); } };
    assert.deepEqual((await gameDataLocations(steamConfig(), throwing)).configHomes, [path.join(root, 'config')], 'a reader that throws derives nothing');

    const fresher = await write(path.join(homeDataDir(home), 'Player.log'), 'a later run\n');
    assert.equal((await readLog()).path, fresher);
  });
});

test('a remote target, the UNITY_INSPECTOR_HOST path and WSL read no process, and an instance derives nothing', linuxOnly, async () => {
  forgetGameDataLocations();
  const game = nativeGame('/srv/moved', '/home/u');
  const unread = async (config) => {
    const { reader, calls } = recordingProcReader(game);
    assert.deepEqual(await gameDataLocations(config, reader), { configHomes: [], winePrefixes: [], ummLog: null, ummLogs: [] });
    assert.equal(await activeUmmLog(config, { reader }), null);
    assert.deepEqual(calls, []);
  };

  await unread({ ...steamConfig(), declared: true, remote: { host: '192.0.2.7', port: 9999, tokenFile: '/tmp/remote.token' } });
  await unread({ ...steamConfig(), remote: { host: '192.0.2.7', port: null, tokenFile: null, fromEnv: true } });
  await unread(withRoot(instanceConfig({ CLAUDE_SESSION_ID: 'game-data', BROFORCE_INSTANCE_CMD: 'launcher' }, { platform: 'linux' }), '/var/lib/instances'));

  setWslProbe(() => true);
  try {
    await unread(steamConfig());
  } finally {
    setWslProbe(NOT_WSL);
  }
});

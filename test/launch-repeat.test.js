import { LAUNCH_RECORDS_SCRATCH, NO_LISTENER_PORT, NO_OP_LAUNCH_CMD, NO_TOKEN_FILE } from './support/session.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { setTimeout as delay } from 'timers/promises';

import { fakeProcReader, recordingKill } from './support/fake-proc.js';
import { fakeInspector, useStubLauncher } from './support/stub-launcher.js';
import { reply, startStubServer } from './support/stub-server.js';

const isLinux = process.platform === 'linux';
const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'launch-repeat-')));
const steamUp = path.join(scratch, 'steam-up');
const steamCalls = path.join(scratch, 'steam-calls.log');
const steamLauncher = path.join(scratch, 'steam-launcher.sh');
await fs.writeFile(steamLauncher, `case "$1" in --help|--args-help) exit 0;; esac\nprintf '%s\\n' "$*" >> '${steamCalls}'\n: > '${steamUp}'\n`);
const STEAM_LAUNCH_CMD = `sh ${steamLauncher}`;
const failingLauncher = path.join(scratch, 'failing-launcher.sh');
await fs.writeFile(failingLauncher, `case "$1" in --help|--args-help) exit 0;; esac\nprintf '%s\\n' "$*" >> '${steamCalls}'\nexit 3\n`);
const idleLauncher = path.join(scratch, 'idle-launcher.sh');
await fs.writeFile(idleLauncher, `case "$1" in --help|--args-help) exit 0;; esac\nprintf '%s\\n' "$*" >> '${steamCalls}'\n`);
const steamStop = path.join(scratch, 'steam-stop.sh');
await fs.writeFile(steamStop, `rm -f '${steamUp}'\n`);

const SESSION = 'repeat-session-7c2d';
const instancesRoot = path.join(scratch, 'instances');
await fs.mkdir(instancesRoot);
const binDir = path.join(scratch, 'bin');
const instanceCalls = path.join(instancesRoot, 'calls.log');

const { activeTarget, configureLaunchTiming, handleToolCall, resetTargetResolution, setLaunchResolver, unityClient } = await import('../index.js');
const { LINUX_GAME_COMM, invalidateGameProcessScan, resetInstanceModeProbe, resolveLaunchCommand, setKillSignaller, setProcReader } = await import('../lib/game-process.js');
const { forgetLaunchRecords, lastLaunch, launchOutputFile, launchRecordFile, pruneLaunchRecords, setLaunchRecordWriter } = await import('../lib/launch-record.js');

const exists = (file) => fs.access(file).then(() => true, () => false);
const STEAM_PID = '801';
const INSTANCE_PID = '4242';

async function instanceActions() {
  const calls = (await fs.readFile(instanceCalls, 'utf8').catch(() => '')).split('\n');
  return calls.filter((line) => line.startsWith(`instance ${SESSION} launch`) || line.startsWith(`instance ${SESSION} stop`));
}

async function instanceLaunches() {
  return (await instanceActions()).filter((line) => line.startsWith(`instance ${SESSION} launch`)).length;
}

let instanceDiedAt = 0;
async function instanceUp() {
  const actions = await instanceActions();
  return (await instanceLaunches()) > instanceDiedAt && actions.at(-1).startsWith(`instance ${SESSION} launch`);
}

function procTable() {
  const base = fakeProcReader({
    [STEAM_PID]: { comm: LINUX_GAME_COMM, cwd: '/home/player/Broforce', startTicks: 200 },
    [INSTANCE_PID]: { comm: LINUX_GAME_COMM, cwd: path.join(instancesRoot, SESSION, 'work'), startTicks: 300 },
  });
  return {
    ...base,
    async pids() {
      return [
        ...((await exists(steamUp)) ? [STEAM_PID] : []),
        ...((await instanceUp()) ? [INSTANCE_PID] : []),
      ];
    },
  };
}

const steamGame = await startStubServer(async (request, socket) => {
  for (let waited = 0; !(await exists(steamUp)) && waited < 300; waited += 25) await new Promise((r) => setTimeout(r, 25));
  if (await exists(steamUp)) reply(socket, request.id, {});
  else socket.destroy();
});
const remoteGame = await startStubServer((request, socket) => reply(socket, request.id, {}));
const inspector = await fakeInspector();
const tokenFile = path.join(scratch, 'remote.token');
await fs.writeFile(tokenFile, `${'a'.repeat(64)}\n`);

let kill = recordingKill();

test.after(async () => {
  unityClient.disconnect();
  setProcReader(null);
  setKillSignaller();
  setLaunchResolver();
  process.env.BROFORCE_LAUNCH_CMD = NO_OP_LAUNCH_CMD;
  process.env.UNITY_INSPECTOR_PORT = NO_LISTENER_PORT;
  delete process.env.BROFORCE_STOP_CMD;
  await steamGame.close();
  await remoteGame.close();
  await inspector.close();
  await fs.rm(scratch, { recursive: true, force: true });
});

function withoutInstance() {
  delete process.env.CLAUDE_SESSION_ID;
  delete process.env.BROFORCE_INSTANCE_CMD;
  delete process.env.STUB_INSTANCES_ROOT;
  delete process.env.STUB_STAGE_ROOT;
}

beforeEach(async () => {
  withoutInstance();
  resetInstanceModeProbe();
  resetTargetResolution();
  unityClient.disconnect();
  setLaunchResolver();
  configureLaunchTiming({ startConfirmMs: 600, startStableMs: 150, startPollMs: 50 });
  await fs.rm(steamUp, { force: true });
  await fs.rm(steamCalls, { force: true });
  await fs.rm(path.join(instancesRoot, SESSION), { recursive: true, force: true });
  await fs.rm(instanceCalls, { force: true });
  instanceDiedAt = 0;
  setProcReader(procTable());
  kill = recordingKill();
  setKillSignaller(kill);
  process.env.BROFORCE_LAUNCH_CMD = STEAM_LAUNCH_CMD;
  process.env.UNITY_INSPECTOR_PORT = String(steamGame.port);
  process.env.UNITY_INSPECTOR_TOKEN_FILE = NO_TOKEN_FILE;
  process.env.BROFORCE_STOP_CMD = `sh ${steamStop}`;
  delete process.env.UNITY_INSPECTOR_HOST;
  steamGame.hello = 'accept';
  inspector.hello = 'accept';
});

async function withInstance() {
  await useStubLauncher({ session: SESSION, root: instancesRoot, binDir });
  process.env.BROFORCE_LAUNCH_CMD = STEAM_LAUNCH_CMD;
  process.env.UNITY_INSPECTOR_PORT = String(steamGame.port);
  await fs.writeFile(path.join(instancesRoot, 'allocated-port'), String(inspector.port));
  resetInstanceModeProbe();
  resetTargetResolution();
}

const call = (name, args = {}) => handleToolCall({ params: { name, arguments: args } });
const launch = (args = {}) => call('launch_game', args);
const textOf = (response) => response.content.map((c) => c.text).join('\n');

function payload(response) {
  const text = textOf(response);
  assert.ok(!text.startsWith('Error: '), text);
  const body = JSON.parse(text);
  assert.equal(Boolean(response.isError), body.success === false, `isError goes with success: false: ${text}`);
  return body;
}

async function launched(args) {
  const body = payload(await launch(args));
  assert.equal(body.success, true, body.message);
  return body;
}

async function restarted(args) {
  invalidateGameProcessScan();
  const body = await launched(args);
  assert.match(body.message, /restarted and ready/);
  return body;
}

function refused(response) {
  assert.equal(response.isError, true, textOf(response));
  assert.match(textOf(response), /^Error: Nothing was launched or stopped: this session's last launch of /);
  return textOf(response);
}

async function steamLaunches() {
  return (await fs.readFile(steamCalls, 'utf8').catch(() => '')).split('\n').filter((line, i, all) => i < all.length - 1);
}

async function steamGameDies() {
  await fs.rm(steamUp, { force: true });
  invalidateGameProcessScan();
  unityClient.disconnect();
}

async function instanceGameDies() {
  instanceDiedAt = await instanceLaunches();
  await fs.rm(path.join(instancesRoot, SESSION, 'game.pid'), { force: true });
  invalidateGameProcessScan();
  unityClient.disconnect();
}

test('a relaunch of the user\'s game from a remote target is refused when it leaves out the launch\'s launchArgs', { timeout: 30000, skip: !isLinux }, async () => {
  await launched({ steam: true, launchArgs: '--some-flag' });
  assert.deepEqual(await steamLaunches(), ['--some-flag']);

  const declared = payload(await launch({ remote: { host: '127.0.0.1', port: remoteGame.port, tokenFile } }));
  assert.equal(declared.target, 'remote');
  await steamGameDies();

  const text = refused(await launch({ steam: true }));
  assert.match(text, /the user's game carried launchArgs: "--some-flag", and this call gives no launchArgs\./);
  assert.match(text, /Pass launchArgs: "--some-flag" to launch it the same way, or launchArgs: "" to launch without them\./);
  assert.deepEqual(await steamLaunches(), ['--some-flag'], 'the refusal launched nothing');
  assert.equal(activeTarget(), 'remote', 'the refusal leaves the target on the remote');
  assert.deepEqual(kill.calls, []);
});

test('a bare restart after a launch with launchArgs is refused before it stops the game', { timeout: 30000, skip: !isLinux }, async () => {
  await launched({ launchArgs: '--some-flag' });

  refused(await launch({ restart: true }));
  assert.deepEqual(kill.calls, [], 'the refusal signalled nothing');
  assert.equal(await exists(steamUp), true, 'the game is still running');
  assert.deepEqual(await steamLaunches(), ['--some-flag']);
  assert.equal(activeTarget(), 'steam');
});

test('after a vanilla launch a bare launch is refused, and vanilla: false launches with mods', { timeout: 30000, skip: !isLinux }, async () => {
  const first = await launched({ vanilla: true });
  assert.equal(first.vanilla, true);
  assert.deepEqual(await lastLaunch('steam'), { launchArgs: null, vanilla: true });
  await steamGameDies();

  const text = refused(await launch({}));
  assert.match(text, /carried vanilla: true, and this call gives no vanilla\. Pass vanilla: true to launch it the same way, or vanilla: false to launch with mods\./);

  const modded = await launched({ vanilla: false });
  assert.equal(modded.vanilla, undefined);
  assert.deepEqual(await steamLaunches(), ['--vanilla', '']);
  assert.deepEqual(await lastLaunch('steam'), { launchArgs: null, vanilla: false });
});

test('launchArgs and vanilla left out together are named together', { timeout: 30000, skip: !isLinux }, async () => {
  await launched({ vanilla: true, launchArgs: '-x' });
  await steamGameDies();

  const text = refused(await launch({}));
  assert.match(text, /carried launchArgs: "-x" and vanilla: true, and this call gives no launchArgs or vanilla\. Pass launchArgs: "-x", vanilla: true to launch it the same way, or launchArgs: "" and vanilla: false to launch with neither\./);
  await launched({ launchArgs: '--vanilla -x' });
  assert.deepEqual(await steamLaunches(), ['--vanilla -x', '--vanilla -x']);
});

test('launchArgs: "" after a launch with launchArgs launches plain and records it, so a bare launch then passes', { timeout: 30000, skip: !isLinux }, async () => {
  await launched({ launchArgs: '--some-flag' });
  await steamGameDies();

  await launched({ launchArgs: '' });
  assert.deepEqual(await lastLaunch('steam'), { launchArgs: null, vanilla: false });
  await steamGameDies();

  await launched({});
  assert.deepEqual(await steamLaunches(), ['--some-flag', '', '']);
});

test('the same launchArgs launch again, and different ones launch with what they say', { timeout: 30000, skip: !isLinux }, async () => {
  await launched({ launchArgs: '--some-flag' });
  await steamGameDies();
  await launched({ launchArgs: '--some-flag' });
  await steamGameDies();
  await launched({ launchArgs: '--other-flag 2' });

  assert.deepEqual(await steamLaunches(), ['--some-flag', '--some-flag', '--other-flag 2']);
  assert.deepEqual(await lastLaunch('steam'), { launchArgs: '--other-flag 2', vanilla: false });
});

test('a bare launch that finds the game running points at it, whatever the last launch carried', { timeout: 30000, skip: !isLinux }, async () => {
  await launched({ launchArgs: '--some-flag' });

  const again = await launched({ steam: true });
  assert.equal(again.alreadyRunning, true);
  assert.deepEqual(await steamLaunches(), ['--some-flag']);
});

test('the instance has a record of its own, and neither target\'s record gates the other', { timeout: 60000, skip: !isLinux }, async () => {
  await withInstance();

  await launched({ steam: true });
  const instance = await launched({ launchArgs: '--window 800x450' });
  assert.equal(instance.target, 'instance');
  assert.equal(await instanceLaunches(), 1);

  await steamGameDies();
  await launched({ steam: true });
  assert.deepEqual(await steamLaunches(), ['', '']);

  await instanceGameDies();
  const text = refused(await launch({}));
  assert.match(text, new RegExp(`the game of instance ${SESSION} carried launchArgs: "--window 800x450"`));
  assert.equal(await instanceLaunches(), 1, 'the refusal ran no launch');
  assert.equal(activeTarget(), 'steam', 'the refusal put the target back');

  await launched({ launchArgs: '' });
  await steamGameDies();
  await launched({ steam: true, launchArgs: '-x' });
  await instanceGameDies();
  await launched({});
  assert.equal(await instanceLaunches(), 3);
  assert.deepEqual(await lastLaunch('instance'), { launchArgs: null, vanilla: false });
  assert.deepEqual(await lastLaunch('steam'), { launchArgs: '-x', vanilla: false });
});

test('the record outlives the server process: a new process reads it back from the session\'s file', { timeout: 30000, skip: !isLinux }, async () => {
  await launched({ launchArgs: '--some-flag' });
  const file = launchRecordFile();
  assert.equal(path.dirname(file), LAUNCH_RECORDS_SCRATCH);
  assert.equal(path.basename(file), `pid-${process.ppid}.json`);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).steam, { launchArgs: '--some-flag', vanilla: false });
  const beside = (await fs.readdir(LAUNCH_RECORDS_SCRATCH)).filter((name) => name !== path.basename(launchOutputFile()));
  assert.deepEqual(beside, [path.basename(file)], 'no temp file is left beside it');
  await steamGameDies();

  forgetLaunchRecords();
  resetTargetResolution();
  refused(await launch({}));
  assert.deepEqual(await steamLaunches(), ['--some-flag']);
});

test('another session\'s record does not gate this session', { timeout: 30000, skip: !isLinux }, async (t) => {
  t.after(() => { delete process.env.CLAUDE_SESSION_ID; });
  await fs.mkdir(LAUNCH_RECORDS_SCRATCH, { recursive: true });
  await fs.writeFile(path.join(LAUNCH_RECORDS_SCRATCH, 'other-session.json'), JSON.stringify({ steam: { launchArgs: '--theirs', vanilla: true } }));

  process.env.CLAUDE_SESSION_ID = 'this-session';
  resetTargetResolution();
  await launched({});
  await steamGameDies();

  process.env.CLAUDE_SESSION_ID = 'other-session';
  resetTargetResolution();
  assert.match(refused(await launch({})), /launchArgs: "--theirs" and vanilla: true/);
  assert.deepEqual(await steamLaunches(), ['']);
});

test('a record file that does not parse reads as no record, and the next launch writes a good one', { timeout: 30000, skip: !isLinux }, async () => {
  await fs.mkdir(LAUNCH_RECORDS_SCRATCH, { recursive: true });
  await fs.writeFile(launchRecordFile(), '{"steam": {"launchArgs": "--some-');

  await launched({});
  await steamGameDies();
  await launched({ launchArgs: '--some-flag' });
  assert.deepEqual(JSON.parse(await fs.readFile(launchRecordFile(), 'utf8')), { steam: { launchArgs: '--some-flag', vanilla: false } });
});

test('a launch prunes other sessions\' records idle for a week, and nothing it did not write', { timeout: 30000, skip: !isLinux }, async () => {
  const root = path.join(scratch, 'prune');
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root);
  const now = Date.now();
  const week = 7 * 24 * 60 * 60 * 1000;
  const files = {
    'idle.json': now - week - 1000, 'fresh.json': now - week + 60000, 'kept.json': now - 2 * week, 'notes.txt': now - 2 * week, 'bad id!.json': now - 2 * week,
    'idle.steam.stderr': now - week - 1000, 'fresh.steam.stderr': now - week + 60000, 'kept.steam.stderr': now - 2 * week, 'notes.stderr': now - 2 * week,
  };
  for (const [name, mtime] of Object.entries(files)) {
    await fs.writeFile(path.join(root, name), '{}');
    await fs.utimes(path.join(root, name), new Date(mtime), new Date(mtime));
  }
  await fs.mkdir(path.join(root, 'dir.json'));
  await pruneLaunchRecords(root, path.join(root, 'kept.json'), { nowMs: now });
  assert.deepEqual((await fs.readdir(root)).sort(), ['bad id!.json', 'dir.json', 'fresh.json', 'fresh.steam.stderr', 'kept.json', 'kept.steam.stderr', 'notes.stderr', 'notes.txt']);

  await fs.mkdir(LAUNCH_RECORDS_SCRATCH, { recursive: true });
  const idle = path.join(LAUNCH_RECORDS_SCRATCH, 'idle-session.json');
  await fs.writeFile(idle, '{}');
  await fs.utimes(idle, new Date(now - week - 1000), new Date(now - week - 1000));
  await launched({});
  assert.equal(await exists(idle), false, 'the launch pruned the idle session');
  assert.equal(await exists(launchRecordFile()), true);
});

test('a launch removes the launch-output streams a crashed server left, any session\'s, and never a fresh one', { timeout: 30000, skip: !isLinux }, async () => {
  const root = path.join(scratch, 'prune-streams');
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root);
  const now = Date.now();
  const streams = { 'kept.steam.stderr.41-aa.fifo': now - 120000, 'other.steam.stderr.42-bb.fifo': now - 120000, 'other.steam.stderr.43-cc.fifo': now - 1000 };
  for (const [name, mtime] of Object.entries(streams)) {
    execFileSync('mkfifo', [path.join(root, name)]);
    await fs.utimes(path.join(root, name), new Date(mtime), new Date(mtime));
  }
  await fs.writeFile(path.join(root, 'notes.fifo'), '');
  await fs.utimes(path.join(root, 'notes.fifo'), new Date(now - 120000), new Date(now - 120000));

  await pruneLaunchRecords(root, path.join(root, 'kept.json'), { nowMs: now });

  assert.deepEqual((await fs.readdir(root)).sort(), ['notes.fifo', 'other.steam.stderr.43-cc.fifo']);
});

test('a launch the protocol fallback made without its arguments records none', { timeout: 30000, skip: !isLinux }, async () => {
  const noSteam = { onPath: async () => false, steamRoots: () => [], findSteamGame: async () => ({ gamePath: null, protonPrefix: null, steamapps: null }), profilesRoot: () => '/nonexistent' };
  setLaunchResolver(async (requested, env, platform, config) => {
    const fallback = await resolveLaunchCommand(requested, {}, 'linux', config, noSteam);
    assert.equal(fallback.source, 'steam-protocol');
    // The fallback's own command would open the user's real Steam
    return { ...fallback, command: 'sh', args: [steamLauncher], display: `sh ${steamLauncher}` };
  });

  const first = await launched({ steam: true, launchArgs: '--vanilla --some-flag' });
  assert.match(first.note, /Ignored launch arguments --vanilla --some-flag/);
  assert.deepEqual(await lastLaunch('steam'), { launchArgs: null, vanilla: false });
  await steamGameDies();

  await launched({ steam: true });
  assert.deepEqual(await steamLaunches(), ['', '']);
});

test('a remote target is untouched by the records: declared, or the user\'s game at a non-loopback host', { timeout: 30000, skip: !isLinux }, async () => {
  await launched({ steam: true, launchArgs: '--some-flag' });
  await steamGameDies();

  const declared = payload(await launch({ remote: { host: '127.0.0.1', port: remoteGame.port, tokenFile } }));
  assert.equal(declared.success, true, declared.message);

  process.env.UNITY_INSPECTOR_HOST = '0.0.0.0';
  process.env.UNITY_INSPECTOR_PORT = String(remoteGame.port);
  process.env.UNITY_INSPECTOR_TOKEN_FILE = tokenFile;
  resetTargetResolution();
  const pointed = await launched({ steam: true });
  assert.match(pointed.message, /Nothing was launched/);

  assert.deepEqual(await steamLaunches(), ['--some-flag']);
  assert.deepEqual(await lastLaunch('steam'), { launchArgs: '--some-flag', vanilla: false });
});

test('a launch whose launcher exits non-zero after the spawn still leaves its record, and the next bare launch is refused', { timeout: 30000, skip: !isLinux }, async () => {
  process.env.BROFORCE_LAUNCH_CMD = `sh ${failingLauncher}`;
  const failed = payload(await launch({ launchArgs: '--some-flag' }));
  assert.equal(failed.state, 'launcher-failed', failed.message);
  assert.deepEqual(await lastLaunch('steam'), { launchArgs: '--some-flag', vanilla: false });

  refused(await launch({}));
  assert.deepEqual(await steamLaunches(), ['--some-flag']);
});

test('a call cancelled after its spawn still leaves its record, and the next bare launch is refused', { timeout: 30000, skip: !isLinux }, async () => {
  process.env.BROFORCE_LAUNCH_CMD = `sh ${idleLauncher}`;
  const controller = new AbortController();
  const launching = handleToolCall({ params: { name: 'launch_game', arguments: { launchArgs: '--some-flag' } } }, { signal: controller.signal });
  for (let waited = 0; (await steamLaunches()).length === 0 && waited < 15000; waited += 25) await delay(25);
  controller.abort();
  const cancelled = await launching;
  assert.equal(cancelled.isError, true);
  assert.match(textOf(cancelled), /cancelled/);

  refused(await launch({}));
  assert.deepEqual(await steamLaunches(), ['--some-flag']);
});

test('the record file is on disk when the launch_game call returns', { timeout: 30000, skip: !isLinux }, async (t) => {
  t.after(() => setLaunchRecordWriter());
  setLaunchRecordWriter(async (file, text) => {
    await delay(2000);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  });

  await launched({ launchArgs: '--some-flag' });
  assert.deepEqual(JSON.parse(await fs.readFile(launchRecordFile(), 'utf8')).steam, { launchArgs: '--some-flag', vanilla: false });
});

test('launchArgs: null is absent, and is refused after a launch with launchArgs', { timeout: 30000, skip: !isLinux }, async () => {
  await launched({ launchArgs: '--some-flag' });
  await steamGameDies();

  assert.match(refused(await launch({ launchArgs: null })), /this call gives no launchArgs\./);
  assert.deepEqual(await steamLaunches(), ['--some-flag']);
});

test('a whitespace-only launchArgs launches plain and records none', { timeout: 30000, skip: !isLinux }, async () => {
  await launched({ launchArgs: ' \t ' });
  assert.deepEqual(await lastLaunch('steam'), { launchArgs: null, vanilla: false });
  await steamGameDies();

  await launched({});
  assert.deepEqual(await steamLaunches(), ['', '']);
});

test('a records folder that cannot be written leaves the launch going, and the rule still holds in this process', { timeout: 30000, skip: !isLinux }, async (t) => {
  const blocker = path.join(scratch, 'not-a-folder');
  await fs.writeFile(blocker, '');
  process.env.UNITY_INSPECTOR_LAUNCHES_DIR = path.join(blocker, 'launches');
  t.after(() => {
    process.env.UNITY_INSPECTOR_LAUNCHES_DIR = LAUNCH_RECORDS_SCRATCH;
    forgetLaunchRecords();
  });

  await launched({ launchArgs: '--some-flag' });
  assert.equal(await exists(launchRecordFile()), false);
  await steamGameDies();

  refused(await launch({}));
  assert.deepEqual(await steamLaunches(), ['--some-flag']);
});

async function followsVanillaAdvice(first, advice, follow) {
  const started = await launched(first);
  assert.equal(started.vanilla, true);
  assert.ok(started.message.includes(`Relaunch it with ${advice} to drive it.`), started.message);
  const ping = await call('ping');
  assert.equal(ping.isError, true);
  assert.ok(textOf(ping).includes(`Relaunch it with ${advice} to drive it.`), textOf(ping));
  const again = payload(await launch(first.steam ? { steam: true } : {}));
  assert.equal(again.alreadyRunning, true);
  assert.ok(again.message.includes(`Relaunch it with ${advice} to drive it.`), again.message);

  assert.equal((await restarted(follow)).vanilla, undefined);
}

test('the vanilla advice names a relaunch with mods the rule accepts', { timeout: 30000, skip: !isLinux }, async () => {
  await followsVanillaAdvice({ vanilla: true }, 'launch_game { restart: true, vanilla: false }', { restart: true, vanilla: false });
  assert.deepEqual(await steamLaunches(), ['--vanilla', '']);
  assert.deepEqual(await lastLaunch('steam'), { launchArgs: null, vanilla: false });
});

test('the vanilla advice after a launch with launchArgs repeats them', { timeout: 30000, skip: !isLinux }, async () => {
  await followsVanillaAdvice(
    { vanilla: true, launchArgs: '--some-flag' },
    'launch_game { restart: true, launchArgs: "--some-flag", vanilla: false }',
    { restart: true, launchArgs: '--some-flag', vanilla: false },
  );
  assert.deepEqual(await steamLaunches(), ['--vanilla --some-flag', '--some-flag']);
});

test('the vanilla advice for --vanilla in launchArgs says to take it out', { timeout: 30000, skip: !isLinux }, async () => {
  await followsVanillaAdvice(
    { launchArgs: '--vanilla --some-flag' },
    'launch_game { restart: true, launchArgs: "--vanilla --some-flag", vanilla: false } (with --vanilla taken out of launchArgs)',
    { restart: true, launchArgs: '--some-flag', vanilla: false },
  );
  assert.deepEqual(await steamLaunches(), ['--vanilla --some-flag', '--some-flag']);
});

test('in a session with an instance the vanilla advice for the user\'s game leads with steam: true, and the instance\'s does not', { timeout: 60000, skip: !isLinux }, async () => {
  await withInstance();

  await followsVanillaAdvice({ steam: true, vanilla: true }, 'launch_game { steam: true, restart: true, vanilla: false }', { steam: true, restart: true, vanilla: false });
  assert.equal(activeTarget(), 'steam');
  assert.deepEqual(await steamLaunches(), ['--vanilla', '']);
  assert.equal(await instanceLaunches(), 0);

  await followsVanillaAdvice({ vanilla: true }, 'launch_game { restart: true, vanilla: false }', { restart: true, vanilla: false });
  assert.equal(activeTarget(), 'instance');
  assert.deepEqual(await instanceActions(), [`instance ${SESSION} launch --vanilla`, `instance ${SESSION} stop`, `instance ${SESSION} launch`]);
  assert.deepEqual(await steamLaunches(), ['--vanilla', '']);
});

test('the already-running reply names a relaunch with mods the rule accepts, and reads as before after a plain launch', { timeout: 30000, skip: !isLinux }, async () => {
  await launched({ launchArgs: '--some-flag' });
  const running = await launched({});
  assert.equal(running.alreadyRunning, true);
  assert.equal(running.message, 'the user\'s game is already running. Use restart: true, launchArgs: "--some-flag" to stop and relaunch.');
  await restarted({ restart: true, launchArgs: '--some-flag' });

  await restarted({ restart: true, launchArgs: '' });
  const plain = await launched({});
  assert.equal(plain.message, 'the user\'s game is already running. Use restart: true to stop and relaunch.');
  await restarted({ restart: true });
  assert.deepEqual(await steamLaunches(), ['--some-flag', '--some-flag', '', '']);
});

test('the already-running reply after a vanilla launch, its game since replaced by a modded one, names a relaunch with mods', { timeout: 30000, skip: !isLinux }, async () => {
  await launched({ launchArgs: '--vanilla --some-flag' });
  resetTargetResolution();
  invalidateGameProcessScan();
  const running = await launched({});
  assert.equal(running.alreadyRunning, true);
  assert.equal(running.message, 'the user\'s game is already running. Use restart: true, launchArgs: "--vanilla --some-flag", vanilla: false (with --vanilla taken out of launchArgs) to stop and relaunch.');

  const relaunched = await restarted({ restart: true, launchArgs: '--some-flag', vanilla: false });
  assert.equal(relaunched.vanilla, undefined);
  assert.deepEqual(await steamLaunches(), ['--vanilla --some-flag', '--some-flag']);
  assert.deepEqual(await lastLaunch('steam'), { launchArgs: '--some-flag', vanilla: false });
});

async function silentGameAdvice(game, args = {}) {
  game.hello = 'close';
  unityClient.disconnect();
  invalidateGameProcessScan();
  const silent = payload(await launch(args));
  game.hello = 'accept';
  assert.equal(silent.alreadyRunning, true, silent.message);
  return silent.message;
}

test('the not-answering reply names a relaunch the rule accepts, and reads as before after a plain launch', { timeout: 30000, skip: !isLinux }, async () => {
  await launched({ launchArgs: '--some-flag' });
  const advice = await silentGameAdvice(steamGame);
  assert.match(advice, /not responding on TCP/);
  assert.ok(advice.endsWith('Use restart: true, launchArgs: "--some-flag" to stop and relaunch.'), advice);
  await restarted({ restart: true, launchArgs: '--some-flag' });

  await restarted({ restart: true, launchArgs: '' });
  const plain = await silentGameAdvice(steamGame);
  assert.ok(plain.endsWith('The mod may have failed to load. Use restart: true to stop and relaunch.'), plain);
  await restarted({ restart: true });
  assert.deepEqual(await steamLaunches(), ['--some-flag', '--some-flag', '', '']);
});

test('the instance\'s live-pidfile reply names a relaunch the rule accepts, and reads as before after a plain launch', { timeout: 60000, skip: !isLinux }, async () => {
  await withInstance();
  await launched({ launchArgs: '--window 800x450' });
  const advice = await silentGameAdvice(inspector);
  assert.match(advice, new RegExp(`^Instance ${SESSION} has a game running \\(pid ${INSTANCE_PID}\\)`));
  assert.ok(advice.endsWith('Use restart: true, launchArgs: "--window 800x450" to stop and relaunch it.'), advice);
  await restarted({ restart: true, launchArgs: '--window 800x450' });

  await restarted({ restart: true, launchArgs: '' });
  const plain = await silentGameAdvice(inspector);
  assert.ok(plain.endsWith('Its mod may have failed to load. Use restart: true to stop and relaunch it.'), plain);
  await restarted({ restart: true });

  const launches = (await instanceActions()).filter((line) => line.includes(' launch'));
  assert.deepEqual(launches, [
    `instance ${SESSION} launch --window 800x450`,
    `instance ${SESSION} launch --window 800x450`,
    `instance ${SESSION} launch`,
    `instance ${SESSION} launch`,
  ]);
});

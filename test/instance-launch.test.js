import { NOT_WSL, NO_OP_LAUNCH_CMD } from './support/session.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import os from 'os';
import path from 'path';

import { STUB_GAME_ROOT, fakeInspector, instanceListJsonl, seedInstanceDir, useStubLauncher, writeStubStopCommand } from './support/stub-launcher.js';
import { conditionalProcReader, fakeFileSystem, fakeProcReader } from './support/fake-proc.js';

const isLinux = process.platform === 'linux';
const SESSION = 'launch-session-a41f';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'instances-'));
const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-bin-'));
const { instanceDir, launcher, stagePath } = await useStubLauncher({ session: SESSION, root, binDir });

const {
  activeTarget,
  adoptRunningInstance,
  configureLaunchTiming,
  discoverInstancesRoot,
  handleToolCall,
  instanceLaunchRefusal,
  instanceModeAvailable,
  launchLogTail,
  resetTargetResolution,
  resolveTarget,
  sessionInstance,
  setServerPlatform,
  unityClient,
  userGame,
} = await import('../index.js');
const { LINUX_GAME_COMM, instanceModeChecked, invalidateGameProcessScan, lastSpawnOptions, resetInstanceModeProbe, setKillSignaller, setProcReader } = await import('../lib/game-process.js');

const inspector = await fakeInspector();
test.after(() => inspector.close());
test.after(() => setProcReader(null));
test.after(() => setKillSignaller());
test.after(() => fs.rm(root, { recursive: true, force: true }));
test.after(() => fs.rm(binDir, { recursive: true, force: true }));

const callsLog = path.join(root, 'calls.log');
const portFile = path.join(instanceDir, 'port');
const control = (name, contents) => fs.writeFile(path.join(root, name), contents);
const clearControl = (name) => fs.rm(path.join(root, name), { force: true });

async function until(condition, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition never held');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const slowLaunchFinished = () => until(async () =>
  (await fs.readFile(path.join(instanceDir, 'launch.log'), 'utf8').catch(() => '')).includes('launch: set up'));

async function launcherCalls() {
  try {
    return (await fs.readFile(callsLog, 'utf8')).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

beforeEach(async () => {
  resetInstanceModeProbe();
  resetTargetResolution();
  setProcReader(fakeProcReader({}));
  unityClient.disconnect();
  configureLaunchTiming({ capPollMs: 50, capWaitMs: 400, portWaitMs: 600, instanceBudgetMs: 6000, vanillaExitWaitMs: 45000, rootRetryMs: 15000, probeRetryMs: 15000, startConfirmMs: 600, startStableMs: 150, startPollMs: 50 });
  process.env.CLAUDE_SESSION_ID = SESSION;
  await fs.rm(instanceDir, { recursive: true, force: true });
  await fs.rm(callsLog, { force: true });
  for (const name of ['cap-refusals', 'launch-fails', 'skip-port', 'slow-launch', 'slow-fail', 'stderr-only', 'decoy-port', 'bad-port', 'list-fails-after', 'list.json', 'stop-leaves-survivor', 'user-game-stopped', 'owner-at-launch', 'slow-help', 'creates-nothing', 'stop-fails', 'help-fails', 'no-instance-mode', 'hang-help', 'create-late', 'slow-list', 'launch-terminated', 'stop-refused']) await clearControl(name);
  await control('allocated-port', String(inspector.port));
});

function payload(response) {
  const text = response.content.map((c) => c.text).join('\n');
  assert.ok(!text.startsWith('Error: '), text);
  const body = JSON.parse(text);
  assert.equal(Boolean(response.isError), body.success === false, `isError goes with success: false: ${text}`);
  return body;
}

// The instance's paths come from the root the launcher reports, which resolving the target settles
const rootedInstance = async () => {
  await resolveTarget();
  return sessionInstance();
};

const launch = (args = {}) => handleToolCall({ params: { name: 'launch_game', arguments: args } });
const stop = (args = {}) => handleToolCall({ params: { name: 'stop_game', arguments: args } });

const withoutSessionId = () => {
  delete process.env.CLAUDE_SESSION_ID;
  resetTargetResolution();
};

const instanceGameOnceLaunched = (pid = 4242) => setProcReader(conditionalProcReader({}, {
  when: async () => (await launcherCalls()).some(call => call.startsWith(`instance ${SESSION} launch`)),
  extra: { [pid]: { comm: LINUX_GAME_COMM, cwd: path.join(instanceDir, 'work'), startTicks: 100 } },
}));

test('launch_game starts this session\'s instance and reads the allocated port back', { timeout: 30000, skip: !isLinux }, async () => {
  const result = payload(await launch());

  assert.equal(result.success, true, result.message);
  assert.equal(result.target, 'instance');
  assert.equal(result.launchCommand, `${launcher} instance ${SESSION} launch`);
  assert.deepEqual(result.instance, { id: SESSION, port: inspector.port });
  assert.equal(result.logs.umm, path.join(instanceDir, 'profile/UMM/Core/Log.txt'));
  assert.equal(result.logs.player, path.join(instanceDir, 'home/unity3d/Free Lives/Broforce/Player.log'));

  // The port came from the launcher, and the client is now pointed at it
  assert.equal(unityClient.port, inspector.port);
  assert.equal((await fs.readFile(path.join(instanceDir, 'port'), 'utf8')).trim(), String(inspector.port));

  // Only the launcher's stderr is piped; its stdout would collide with this process's MCP stream
  assert.deepEqual(lastSpawnOptions().stdio, ['ignore', 'ignore', 'pipe']);

  const calls = await launcherCalls();
  assert.deepEqual(calls.slice(0, 2), ['--help', 'instance list --json'],
    'the launcher is asked for its instance mode, then for where it keeps its instances');
  assert.ok(calls.includes(`instance ${SESSION} launch`), calls.join(' | '));
  assert.ok(!calls.some(call => call.includes('--port')), 'the server never asks for a port');
});

test('a launch that finds the instance already running names the game it would have started', { timeout: 30000, skip: !isLinux }, async () => {
  await fs.mkdir(instanceDir, { recursive: true });
  await fs.writeFile(portFile, String(inspector.port));
  setProcReader(fakeProcReader({
    900: { comm: LINUX_GAME_COMM, cwd: path.join(instanceDir, 'work'), startTicks: 100 },
  }));

  const result = payload(await launch());

  assert.equal(result.success, true, result.message);
  assert.equal(result.alreadyRunning, true);
  // The game already running is the one this launch would have started, so it is named the same way
  assert.deepEqual(result.instance, { id: SESSION, port: inspector.port });
  assert.deepEqual(result.logs, {
    umm: path.join(instanceDir, 'profile/UMM/Core/Log.txt'),
    player: path.join(instanceDir, 'home/unity3d/Free Lives/Broforce/Player.log'),
  });
  assert.ok(!(await launcherCalls()).includes(`instance ${SESSION} launch`), 'and nothing was launched');
});

test('a launch that writes no port is reported rather than waited out', { timeout: 90000, skip: !isLinux }, async () => {
  await control('skip-port', '1');
  configureLaunchTiming({ instanceBudgetMs: 60000 });

  const started = Date.now();
  const result = payload(await launch());

  assert.equal(result.success, false);
  assert.equal(result.state, 'no-port');
  assert.match(result.message, new RegExp(path.join(instanceDir, 'port').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // The launch command's own elapsed time, not the port wait it was never held up by
  assert.match(result.message, /finished after \d+\.\d+s/);
  assert.ok(Date.now() - started < 20000, `took ${Date.now() - started}ms`);
});

test('a launch refused at the cap waits for a slot and then launches', { timeout: 30000, skip: !isLinux }, async () => {
  await control('cap-refusals', '1');
  // The list shows a slot free, so the wait ends at the first poll
  await control('list.json', instanceListJsonl(8, [{ id: 'busy-one', running: true, pid: 944835, port: 9901 }]));

  const result = payload(await launch());

  assert.equal(result.success, true, result.message);
  assert.equal(result.instance.port, inspector.port);
  const calls = await launcherCalls();
  assert.equal(calls.filter(call => call === `instance ${SESSION} launch`).length, 2, 'the launch was not retried');
  assert.ok(calls.includes('instance list --json'), calls.join(' | '));
});

test('a launcher that reports no cap has its refusal read as a free slot', { timeout: 30000, skip: !isLinux }, async () => {
  await control('cap-refusals', '1');
  // A launcher that does not cap running instances leaves cap out of its header: there is no cap to
  // be at, so the first poll ends the wait and the launch is retried
  await control('list.json', instanceListJsonl(undefined, [{ id: 'busy-one', running: true, pid: 944835, port: 9901 }]));

  const result = payload(await launch());

  assert.equal(result.success, true, result.message);
  assert.equal(result.instance.port, inspector.port);
  const calls = await launcherCalls();
  assert.equal(calls.filter(call => call === `instance ${SESSION} launch`).length, 2, 'the launch was not retried');
  // The root discovery read the list, one poll ended the wait, and the reply's own
  // runningInstances read it once more
  assert.equal(calls.filter(call => call === 'instance list --json').length, 3, 'the wait polled more than once');
});

test('a capless launcher that keeps refusing is reported without a cap it never gave', { timeout: 30000, skip: !isLinux }, async () => {
  // Every poll frees the launch and every relaunch is refused again, until the wait runs out
  configureLaunchTiming({ capPollMs: 1, capWaitMs: 60 });
  await control('cap-refusals', '99');
  await control('list.json', instanceListJsonl(undefined, [{ id: 'busy-one', running: true, pid: 944835, port: 9901 }]));

  const result = payload(await launch());

  assert.equal(result.state, 'cap-reached', result.message);
  assert.match(result.message, /at its instance cap and no slot came free/);
  assert.match(result.message, /list last showed 1 running \(busy-one\), yet the launcher refused/);
  assert.doesNotMatch(result.message, /of (null|undefined|NaN)/, 'a cap the launcher never reported was quoted back');
});

test('a cap that never frees is reported with the instances holding the slots', { timeout: 90000, skip: !isLinux }, async () => {
  await control('cap-refusals', '99');
  configureLaunchTiming({ instanceBudgetMs: 60000 });
  await control('list.json', instanceListJsonl(2, [
    { id: 'busy-one', running: true, pid: 944835, port: 9901, last_launch: 1788687953 },
    { id: 'busy-two', running: true, pid: 944836, port: 9902, last_launch: 1788688953 },
    { id: 'idle-one', running: false, port: 9903 },
  ]));

  const started = Date.now();
  const result = payload(await launch());
  const elapsed = Date.now() - started;

  assert.equal(result.success, false);
  assert.equal(result.state, 'cap-reached');
  assert.match(result.message, /cap of 2/);
  assert.match(result.message, /busy-one, busy-two/);
  assert.deepEqual(result.runningInstances.map(entry => entry.id), ['busy-one', 'busy-two']);
  assert.equal(result.runningInstances[0].last_launch, 1788687953);
  // The cap wait is its own budget and must not run to the full launch budget
  assert.ok(elapsed < 20000, `the cap wait overran: ${elapsed}ms`);
});

test('a refusal the launcher\'s own list disagrees with is reported as the list showed it', { timeout: 30000, skip: !isLinux }, async () => {
  // Every poll reads the list and sees a free slot; every relaunch is refused again, and the wait
  // ends on a re-entry that had no budget left to poll with
  configureLaunchTiming({ capPollMs: 1, capWaitMs: 60 });
  await control('cap-refusals', '99');
  await control('list.json', instanceListJsonl(8, [{ id: 'busy-one', running: true, pid: 944835, port: 9901 }]));

  const result = payload(await launch());

  assert.equal(result.state, 'cap-reached', result.message);
  // One instance does not hold eight slots, whatever the launcher said when it refused
  assert.match(result.message, /list last showed 1 of 8 running \(busy-one\), yet the launcher refused/);
  assert.doesNotMatch(result.message, /holding the slots/);
  assert.doesNotMatch(result.message, /could not be read/, 'a readable list was reported as unreadable');
  assert.doesNotMatch(result.message, /before the launcher's instance list could be checked/);
  assert.deepEqual(result.runningInstances.map(entry => entry.id), ['busy-one']);
});

test('a list that fails after reading full keeps what it read', { timeout: 30000, skip: !isLinux }, async () => {
  // The root discovery reads it once, two polls read a full list, the fourth read fails, and the
  // relaunch is refused with the budget spent
  configureLaunchTiming({ capPollMs: 1, capWaitMs: 60 });
  await control('cap-refusals', '99');
  await control('list-fails-after', '3');
  await control('list.json', instanceListJsonl(2, [
    { id: 'busy-one', running: true, pid: 944835, port: 9901 },
    { id: 'busy-two', running: true, pid: 944836, port: 9902 },
  ]));

  const result = payload(await launch());

  assert.equal(result.state, 'cap-reached', result.message);
  assert.match(result.message, /Instances holding the slots: busy-one, busy-two/);
  assert.doesNotMatch(result.message, /could not be read on any attempt/, 'one failed poll erased every good one');
  assert.deepEqual(result.runningInstances.map(entry => entry.id), ['busy-one', 'busy-two']);
});

test('a cap wait with no budget to poll with says that, not that the list failed', { timeout: 30000, skip: !isLinux }, async () => {
  configureLaunchTiming({ capPollMs: 5000, capWaitMs: 0 });
  await control('cap-refusals', '99');
  await control('list.json', instanceListJsonl(8, [{ id: 'busy-one', running: true, pid: 944835, port: 9901 }]));

  const result = payload(await launch());

  assert.equal(result.state, 'cap-reached', result.message);
  assert.match(result.message, /ran out before the launcher's instance list could be checked/);
  assert.doesNotMatch(result.message, /could not be read/);
  assert.equal(result.runningInstances, undefined);
  // The one read is the root discovery's, before the launch: the wait itself never asked
  assert.deepEqual((await launcherCalls()).filter(call => call === 'instance list --json'),
    ['instance list --json']);
});

test('a cap wait that never saw a readable list says so', { timeout: 30000, skip: !isLinux }, async () => {
  await control('cap-refusals', '99');
  // The root discovery gets the one readable list; every poll after it is refused
  await control('list-fails-after', '1');

  const result = payload(await launch());

  assert.equal(result.success, false);
  assert.equal(result.state, 'cap-reached');
  assert.match(result.message, /instance list could not be read on any attempt/);
  assert.doesNotMatch(result.message, /Instances holding the slots/, 'zero holders were reported as fact');
  assert.equal(result.runningInstances, undefined);
});

test('a launcher that fails ends the wait at once and reports its own log', { timeout: 90000, skip: !isLinux }, async () => {
  await control('launch-fails', '1');
  configureLaunchTiming({ instanceBudgetMs: 60000 });

  const started = Date.now();
  const result = payload(await launch());

  assert.equal(result.success, false);
  assert.equal(result.state, 'launcher-failed', result.message);
  assert.match(result.message, /exited with status 3/);
  assert.match(result.message, /the display could not be created/);
  assert.doesNotMatch(result.message, /raw game noise/);
  assert.ok(Date.now() - started < 20000, `took ${Date.now() - started}ms`);
});

test('a launch a stop of the instance ended is reported in the launcher\'s own words', { timeout: 30000, skip: !isLinux }, async () => {
  await control('launch-terminated', '1');

  const result = payload(await launch());

  assert.equal(result.success, false, result.message);
  assert.equal(result.state, 'launcher-failed', result.message);
  assert.ok(
    result.message.includes(`launch: terminated by SIGTERM (a stop or remove of instance ${SESSION} sends one)`),
    result.message,
  );
});

test('a vanilla launch on an instance reports the game started without mods', { timeout: 30000, skip: !isLinux }, async (t) => {
  instanceGameOnceLaunched();
  t.after(() => setProcReader(null));
  const result = payload(await launch({ vanilla: true }));

  assert.equal(result.success, true, result.message);
  assert.equal(result.vanilla, true);
  assert.match(result.message, new RegExp(`instance ${SESSION}`));
  assert.match(result.message, /nothing will answer/i);
  assert.ok((await launcherCalls()).includes(`instance ${SESSION} launch --vanilla`));
});

test('a vanilla launch waits on the launch command, not on an inspector', { timeout: 90000, skip: !isLinux }, async (t) => {
  // The launcher is still running when the budget runs out, and no port is ever written
  await control('slow-launch', '1');
  instanceGameOnceLaunched();
  t.after(() => setProcReader(null));
  t.after(slowLaunchFinished);
  configureLaunchTiming({ instanceBudgetMs: 500, portWaitMs: 60000 });

  const started = Date.now();
  const result = payload(await launch({ vanilla: true }));
  const elapsed = Date.now() - started;

  assert.equal(result.success, true, result.message);
  assert.equal(result.vanilla, true);
  // The instance's own budget is the one spent, and the one reported
  assert.match(result.message, /still running after 0.5s and was left to finish/);
  assert.doesNotMatch(result.message, /45s/, 'the reported wait is not the one that was spent');
  // Waiting a second time on the vanilla budget would double it, and the port wait must not run
  assert.ok(elapsed < 20000, `the vanilla launch waited twice (${elapsed}ms)`);
});

test('a vanilla launch at the cap is reported as the cap, not as a launch', { timeout: 30000, skip: !isLinux }, async () => {
  configureLaunchTiming({ capPollMs: 1, capWaitMs: 60 });
  await control('cap-refusals', '99');
  await control('list.json', instanceListJsonl(2, [
    { id: 'busy-one', running: true, pid: 944835, port: 9901 },
    { id: 'busy-two', running: true, pid: 944836, port: 9902 },
  ]));

  const result = payload(await launch({ vanilla: true }));

  assert.equal(result.success, false, result.message);
  assert.equal(result.state, 'cap-reached');
  assert.match(result.message, /Instances holding the slots: busy-one, busy-two/);
});

test('a vanilla launch whose launcher fails late is still reported as a failure', { timeout: 30000, skip: !isLinux }, async () => {
  // It fails after the user's-game vanilla budget would have given up, but inside the instance's
  await control('slow-fail', '1');
  configureLaunchTiming({ instanceBudgetMs: 4000, vanillaExitWaitMs: 200 });

  const result = payload(await launch({ vanilla: true }));

  assert.equal(result.success, false, result.message);
  assert.equal(result.state, 'launcher-failed');
  assert.match(result.message, /exited with status 3/);
  assert.match(result.message, /the display could not be created/);
});

test('a live pidfile refuses a second game on the instance', { timeout: 30000, skip: !isLinux }, async () => {
  const config = await rootedInstance();
  const reader = fakeProcReader({ 4242: { comm: LINUX_GAME_COMM, cwd: config.workDir, startTicks: 100 } });

  const refusal = await instanceLaunchRefusal(config, {
    reader,
    fileSystem: fakeFileSystem({ [config.pidfile]: '4242' }),
  });
  assert.match(refusal, /pid 4242/);
  assert.match(refusal, /restart: true/);

  // A pidfile naming a process that is not this instance's game is stale, and no refusal
  assert.equal(
    await instanceLaunchRefusal(config, { reader, fileSystem: fakeFileSystem({ [config.pidfile]: '999' }) }),
    null,
  );
  assert.equal(await instanceLaunchRefusal(config, { reader, fileSystem: fakeFileSystem() }), null);
});

test('the log messages on an instance name its own two logs and no environment variable', { timeout: 30000, skip: !isLinux }, async (t) => {
  const { findLogPath, resolveLogFile } = await import('../index.js');
  await fs.rm(instanceDir, { recursive: true, force: true });

  const missing = await handleToolCall({ params: { name: 'read_log', arguments: {} } });
  const text = missing.content.map((c) => c.text).join('\n');
  assert.equal(missing.isError, true, text);
  assert.match(text, new RegExp(`No log file for instance ${SESSION} yet`));
  assert.match(text, /profile\/UMM\/Core\/Log\.txt/);
  assert.match(text, /Player\.log/);
  assert.match(text, /once the instance's game has started/);
  assert.doesNotMatch(text, /UNITY_INSPECTOR_LOG/, 'a variable the instance target ignores was advised');

  // A log older than the running game is stale, and says so in the instance's own terms
  const ummLog = path.join(instanceDir, 'profile/UMM/Core/Log.txt');
  await fs.mkdir(path.dirname(ummLog), { recursive: true });
  await fs.writeFile(ummLog, 'an earlier run wrote this\n');
  const anHourAgo = new Date(Date.now() - 3600_000);
  await fs.utimes(ummLog, anHourAgo, anHourAgo);

  const resolved = await resolveLogFile(async () => null, async () => Date.now());
  assert.equal(resolved.path, ummLog);
  assert.equal(resolved.stale, true);
  assert.match(resolved.warning, new RegExp(`Neither of instance ${SESSION}'s logs has been written since it started`));
  assert.doesNotMatch(resolved.warning, /UNITY_INSPECTOR_LOG/);
  assert.equal(await findLogPath(async () => null, async () => null), ummLog);

  const playerLog = path.join(instanceDir, 'home/unity3d/Free Lives/Broforce/Player.log');
  await fs.mkdir(path.dirname(playerLog), { recursive: true });
  await fs.writeFile(playerLog, 'this run\n');
  await fs.writeFile(ummLog, 'this run too\n');
  const started = Date.now() - 60_000;
  assert.equal(await findLogPath(async () => null, async () => started), playerLog);
  assert.equal(await findLogPath(async () => null, async () => null), playerLog);

  await fs.utimes(playerLog, anHourAgo, anHourAgo);
  assert.equal(await findLogPath(async () => null, async () => started), ummLog, 'a player log the game no longer writes gives way');

  await fs.rm(ummLog, { force: true });
  const stalePlayer = await resolveLogFile(async () => null, async () => Date.now());
  assert.equal(stalePlayer.path, playerLog);
  assert.equal(stalePlayer.stale, true);
  assert.match(stalePlayer.warning, new RegExp(`Neither of instance ${SESSION}'s logs`));
  assert.doesNotMatch(stalePlayer.warning, /UNITY_INSPECTOR_LOG/);
});

test('the launch.log tail keeps the launcher lines and drops the game noise', async () => {
  const launchLog = path.join(instanceDir, 'launch.log');
  await fs.mkdir(path.dirname(launchLog), { recursive: true });

  const launcherLines = Array.from({ length: 25 }, (_, i) => `[2026-01-02 03:04:${String(i).padStart(2, '0')}] launch: step ${i}`);
  const noise = ['Fallback handler could not load library', 'NullReferenceException: Player.Start', ''];
  await fs.writeFile(launchLog, [...launcherLines, ...noise].join('\n'));

  const tail = await launchLogTail(await rootedInstance());
  const lines = tail.split('\n');

  assert.equal(lines.length, 20);
  assert.equal(lines[0], launcherLines[5]);
  assert.equal(lines.at(-1), launcherLines.at(-1));
  for (const line of lines) assert.match(line, /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] /);
});

test('the launch.log tail is read from the end of a log the game filled, never whole', async () => {
  const { readFileTail } = await import('../index.js');
  const launchLog = path.join(instanceDir, 'launch.log');
  await fs.mkdir(path.dirname(launchLog), { recursive: true });
  const early = '[2026-01-02 03:04:05] launch: requested';
  const late = '[2026-01-02 03:04:09] launch: game pid 4242';
  await fs.writeFile(launchLog, `${early}\n${'game noise\n'.repeat(400000)}${late}\n`);

  const read = await readFileTail(launchLog, 1024);
  assert.ok(Buffer.byteLength(read) <= 1024);
  assert.ok(read.startsWith('game noise\n'), 'the read began mid-line');
  assert.equal(await launchLogTail(await rootedInstance()), late);
});

// The wrapper's pid and its start time, the line the wrapper compares itself against at shutdown
const OWNER_LINE_RE = new RegExp(`^${process.ppid} \\d+$`);
const ownerFile = path.join(instanceDir, 'owner.pid');

const startTicksOf = async (pid) => {
  const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
};

async function deadOwnerLine() {
  const { spawn } = await import('child_process');
  const child = spawn('sleep', ['5'], { stdio: 'ignore' });
  const line = `${child.pid} ${await startTicksOf(child.pid)}`;
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));
  return line;
}

async function liveNewerOwner(t) {
  const { spawn } = await import('child_process');
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  return `${child.pid} ${await startTicksOf(child.pid)}`;
}

test('the id of an instance that already exists is claimed before its launcher runs', { timeout: 30000, skip: !isLinux }, async () => {
  await seedInstanceDir(instanceDir);

  const result = payload(await launch());
  assert.equal(result.success, true, result.message);

  // The stub copies the file it found when launch ran, so the claim cannot have come afterwards
  const atLaunch = (await fs.readFile(path.join(root, 'owner-at-launch'), 'utf8')).trim();
  assert.match(atLaunch, OWNER_LINE_RE);
  assert.equal((await fs.readFile(ownerFile, 'utf8')).trim(), atLaunch);
});

test('a brand-new id launches, and is claimed once the launcher has created it', { timeout: 30000, skip: !isLinux }, async () => {
  await assert.rejects(fs.access(instanceDir), 'the id was not new to begin with');

  const result = payload(await launch());

  assert.equal(result.success, true, result.message);
  // The launcher creates the instance it was asked for, which a claim made first would have denied it
  await fs.access(path.join(instanceDir, 'profile'));
  assert.match((await fs.readFile(ownerFile, 'utf8')).trim(), OWNER_LINE_RE);
  await assert.rejects(
    fs.access(path.join(root, 'owner-at-launch')),
    'the directory was claimed before the launcher could create it',
  );
});

test('a launcher that creates nothing leaves nothing claimed', { timeout: 30000, skip: !isLinux }, async () => {
  await control('creates-nothing', '1');

  const result = payload(await launch());

  assert.equal(result.success, false);
  assert.match(result.message, /exited with status 3/);
  await assert.rejects(fs.access(instanceDir), 'the claim created the directory the launcher refused to');
});

test('a launcher that fails after creating a brand-new id still leaves it claimed', { timeout: 30000, skip: !isLinux }, async () => {
  await assert.rejects(fs.access(instanceDir), 'the id was not new to begin with');
  await control('launch-fails', '1');

  const result = payload(await launch());

  assert.equal(result.success, false);
  assert.match(result.message, /exited with status 3/);
  assert.match((await fs.readFile(ownerFile, 'utf8')).trim(), OWNER_LINE_RE);
});

test('a brand-new id claimed at the cap stays claimed once the freed slot launches', { timeout: 30000, skip: !isLinux }, async () => {
  await assert.rejects(fs.access(instanceDir), 'the id was not new to begin with');
  await control('cap-refusals', '1');
  await control('list.json', instanceListJsonl(8, [{ id: 'busy-one', running: true, pid: 944835, port: 9901 }]));

  const result = payload(await launch());

  assert.equal(result.success, true, result.message);
  assert.match((await fs.readFile(ownerFile, 'utf8')).trim(), OWNER_LINE_RE);
});

test('the ownership claim never creates the instance directory', { timeout: 30000, skip: !isLinux }, async () => {
  const { writeOwnerFile } = await import('../index.js');
  // The root has to be known for there to be a path to claim at all
  await resolveTarget();
  assert.equal(sessionInstance().ownerFile, ownerFile);

  assert.equal(await writeOwnerFile(sessionInstance()), null);
  await assert.rejects(fs.access(instanceDir), 'the claim created the instance directory');
});

test('the server records where it claimed the id, for the wrapper that stops it', { timeout: 30000, skip: !isLinux }, async (t) => {
  const claimFile = path.join(root, 'wrapper.claim');
  process.env.UNITY_INSPECTOR_MCP_CLAIM_FILE = claimFile;
  t.after(async () => {
    delete process.env.UNITY_INSPECTOR_MCP_CLAIM_FILE;
    await fs.rm(claimFile, { force: true });
  });
  await seedInstanceDir(instanceDir);

  const result = payload(await launch());
  assert.equal(result.success, true, result.message);
  // The wrapper knows no instances root, so this is the only path it can stop the instance by
  assert.equal((await fs.readFile(claimFile, 'utf8')).trim(), ownerFile);

  payload(await stop());
  await assert.rejects(fs.access(ownerFile));
  await assert.rejects(fs.access(claimFile), 'the claim outlived the owner file it named');
});

test('a server that finds its instance already running claims it', { timeout: 30000, skip: !isLinux }, async (t) => {
  await fs.mkdir(path.join(instanceDir, 'work'), { recursive: true });
  setProcReader(fakeProcReader({
    4242: { comm: LINUX_GAME_COMM, cwd: path.join(instanceDir, 'work'), startTicks: 100 },
  }));
  t.after(() => setProcReader(null));

  // The working directory is what settles it: nothing was launched from here
  assert.equal(await resolveTarget(), 'instance');
  await adoptRunningInstance();

  assert.match((await fs.readFile(ownerFile, 'utf8')).trim(), OWNER_LINE_RE);
});

test('at startup the id is taken whenever the instance directory exists, game or none', { timeout: 30000, skip: !isLinux }, async (t) => {
  await fs.mkdir(instanceDir, { recursive: true });
  await fs.writeFile(ownerFile, `1 ${await startTicksOf(1)}\n`);
  setProcReader(fakeProcReader({}));
  t.after(() => setProcReader(null));

  await resolveTarget();
  await adoptRunningInstance();

  assert.match((await fs.readFile(ownerFile, 'utf8')).trim(), OWNER_LINE_RE, 'the older wrapper kept the id');
});

test('the id is claimed as soon as the root is known', { timeout: 30000, skip: !isLinux }, async (t) => {
  // The launcher takes its time over `--help`, and the old wrapper's takeover wait is running out
  await control('slow-help', '');
  await fs.mkdir(path.join(instanceDir, 'work'), { recursive: true });
  setProcReader(fakeProcReader({
    4242: { comm: LINUX_GAME_COMM, cwd: path.join(instanceDir, 'work'), startTicks: 100 },
  }));
  t.after(() => setProcReader(null));

  const started = Date.now();
  const resolved = resolveTarget();

  let claimedAt = null;
  while (claimedAt === null && Date.now() - started < 15000) {
    try {
      await fs.access(ownerFile);
      claimedAt = Date.now();
    } catch {
      await new Promise((done) => setTimeout(done, 25));
    }
  }

  assert.ok(claimedAt !== null, 'the id was never claimed');
  // Far inside the 15s the old wrapper waits before stopping the game it still thinks it owns
  assert.ok(claimedAt - started < 12000, `the claim took ${claimedAt - started}ms`);
  assert.match((await fs.readFile(ownerFile, 'utf8')).trim(), OWNER_LINE_RE);
  assert.equal(await resolved, 'instance');

  // Nothing was launched: the claim followed the probe and the list the root came from, and no
  // command after them
  assert.deepEqual(await launcherCalls(), ['--help', 'instance list --json']);
});

test('a stage root the launcher reports is carried on the config', { timeout: 30000, skip: !isLinux }, async (t) => {
  const reported = process.env.STUB_STAGE_ROOT;
  process.env.STUB_STAGE_ROOT = '/srv/stage';
  t.after(() => { process.env.STUB_STAGE_ROOT = reported; });

  assert.equal(await resolveTarget(), 'instance');
  assert.equal(sessionInstance().stageRoot, '/srv/stage');
  assert.equal(sessionInstance().stagePath, `/srv/stage/${SESSION}/UMM`);
  // instancesRoot is where instances live; the launcher's own `root` in the same header is not,
  // and no path of this server's comes from it
  assert.equal(sessionInstance().instancesRoot, root);
  assert.equal(sessionInstance().root, instanceDir);
  assert.ok(!sessionInstance().root.startsWith(STUB_GAME_ROOT), sessionInstance().root);
});

test('a stage root that is not an absolute path is dropped, as a relative instances root is', { timeout: 30000, skip: !isLinux }, async (t) => {
  const reported = process.env.STUB_STAGE_ROOT;
  process.env.STUB_STAGE_ROOT = 'stages';
  t.after(() => { process.env.STUB_STAGE_ROOT = reported; });

  assert.equal(await resolveTarget(), 'instance', 'the instances root is absolute and the instance stands');
  assert.equal((await discoverInstancesRoot()).stageRoot, null);
  assert.equal(sessionInstance().stageRoot, null);
  assert.equal(sessionInstance().stagePath, null, 'resolving it against a cwd would name a directory of somebody else\'s');
  assert.equal(userGame().stageRoot, null);
});

test('a list the launcher cannot print leaves the session with no target until it can', { timeout: 30000, skip: !isLinux }, async () => {
  // Every read of the list is refused, the root discovery's included
  await control('list-fails-after', '0');

  assert.equal(await resolveTarget(), null);

  const state = payload(await handleToolCall({ params: { name: 'game_state', arguments: {} } }));
  assert.equal(state.target, null);
  assert.equal(state.port, null);
  assert.equal(state.success, false);
  assert.match(state.message, /no target yet/);
  assert.equal(state.instance, null);
  assert.match(state.instanceReason, /could not be read/);
  assert.match(state.instanceReason, /instance list --json/);

  const ping = await handleToolCall({ params: { name: 'ping', arguments: {} } });
  assert.equal(ping.isError, true);
  assert.match(ping.content[0].text, /no target yet/);
  assert.match(ping.content[0].text, /could not be read/);
  assert.equal(unityClient.connected, false);
  const stopped = await stop();
  assert.equal(stopped.isError, true);
  assert.match(stopped.content[0].text, /no target yet/);

  await clearControl('list-fails-after');
  configureLaunchTiming({ rootRetryMs: 0 });
  const settled = payload(await handleToolCall({ params: { name: 'game_state', arguments: {} } }));
  assert.equal(settled.target, 'instance');
  assert.equal(activeTarget(), 'instance');
  assert.deepEqual(settled.instance, { id: SESSION, port: null, root: instanceDir, stage: stagePath });
});

test('a launcher that answers after startup has its running instance claimed and served', { timeout: 30000, skip: !isLinux }, async (t) => {
  await control('help-fails', '1');
  await fs.mkdir(path.join(instanceDir, 'work'), { recursive: true });
  await fs.writeFile(portFile, String(inspector.port));
  setProcReader(fakeProcReader({ 4242: { comm: LINUX_GAME_COMM, cwd: path.join(instanceDir, 'work'), startTicks: 100 } }));
  t.after(() => setProcReader(null));

  assert.equal(await resolveTarget(), null);
  await assert.rejects(fs.access(ownerFile), 'a game nothing could place was claimed');

  await clearControl('help-fails');
  configureLaunchTiming({ probeRetryMs: 0 });
  payload(await handleToolCall({ params: { name: 'ping', arguments: {} } }));

  assert.equal(activeTarget(), 'instance');
  assert.equal(unityClient.port, inspector.port);
  assert.match((await fs.readFile(ownerFile, 'utf8')).trim(), OWNER_LINE_RE);
});

// A game of the user's own, and a signaller that records what it was sent and lets the process die
function gameRunning(pid, cwd, signalled) {
  const alive = new Set([pid]);
  setProcReader(fakeProcReader({ [pid]: { comm: LINUX_GAME_COMM, cwd, startTicks: 100 } }));
  setKillSignaller((target, signal) => {
    if (signal !== 0) signalled.push(`${signal} ${target}`);
    if (!alive.has(target)) {
      const error = new Error('ESRCH');
      error.code = 'ESRCH';
      throw error;
    }
    if (signal === 'SIGTERM') alive.delete(target);
    return true;
  });
}

const userGameRunning = (signalled) => gameRunning(800, '/home/x/.local/share/broforce-linux', signalled);
const foreignInstanceRunning = (signalled) => gameRunning(800, path.join(root, 'other-session', 'work'), signalled);

const clearProcessStubs = () => {
  setProcReader(null);
  setKillSignaller();
};

test('a stop after the root is discovered acts on the config that knows it', { timeout: 40000, skip: !isLinux }, async (t) => {
  withoutSessionId();
  await control('list-fails-after', '0');
  const signalled = [];
  // Another session's instance game, which only the discovered root tells from the user's own
  foreignInstanceRunning(signalled);
  t.after(clearProcessStubs);

  assert.equal(await resolveTarget(), 'steam');
  assert.equal(userGame().instancesRoot, null);

  // The launcher answers again, and the stop is the first call to ask it
  await clearControl('list-fails-after');
  configureLaunchTiming({ rootRetryMs: 0 });

  const stopped = payload(await stop());

  assert.deepEqual(signalled, [], "another session's instance was signalled");
  assert.equal(stopped.success, false, stopped.message);
  assert.match(stopped.message, /No Broforce process is running for the user's game/);
});

test('with no launcher configured the user\'s game is stopped as it always was', { timeout: 40000, skip: !isLinux }, async (t) => {
  const configured = process.env.BROFORCE_INSTANCE_CMD;
  delete process.env.BROFORCE_INSTANCE_CMD;
  resetTargetResolution();
  const signalled = [];
  userGameRunning(signalled);
  t.after(() => {
    process.env.BROFORCE_INSTANCE_CMD = configured;
    clearProcessStubs();
  });

  assert.equal(await resolveTarget(), 'steam');
  const stopped = payload(await stop());

  assert.equal(stopped.success, true, stopped.message);
  assert.deepEqual(signalled, ['SIGTERM 800']);
});

test('off Linux the user\'s game is stopped as it always was', { timeout: 40000, skip: !isLinux }, async (t) => {
  setServerPlatform('darwin');
  const signalled = [];
  userGameRunning(signalled);
  t.after(() => {
    setServerPlatform();
    clearProcessStubs();
  });

  assert.equal(await resolveTarget(), 'steam');
  const stopped = payload(await stop());

  assert.equal(stopped.success, true, stopped.message);
  assert.deepEqual(signalled, ['SIGTERM 800']);
});

test('a launcher with no instance mode leaves the stop alone', { timeout: 40000, skip: !isLinux }, async (t) => {
  await control('no-instance-mode', '1');
  const signalled = [];
  userGameRunning(signalled);
  t.after(clearProcessStubs);

  assert.equal(await resolveTarget(), 'steam');
  assert.equal(instanceModeChecked(), false);
  const stopped = payload(await stop());

  assert.equal(stopped.success, true, stopped.message);
  assert.deepEqual(signalled, ['SIGTERM 800']);
  // There are no instances to be confused with, so the launcher was never asked for a list
  assert.deepEqual((await launcherCalls()).filter(call => call.includes('list')), []);
});

test('a launch of the user\'s game is held back while the instances root is unknown', { timeout: 40000, skip: !isLinux }, async (t) => {
  await control('list-fails-after', '0');
  const signalled = [];
  // A game in another session's instance, which without the root reads as the user's own
  foreignInstanceRunning(signalled);

  // A launch command that leaves a mark, so "nothing was launched" is a fact and not an absence
  const marker = path.join(root, 'user-game-launched');
  const script = path.join(binDir, 'stub-user-launch');
  await fs.writeFile(script, `#!/bin/sh\n: > '${marker}'\nexit 0\n`, { mode: 0o755 });
  process.env.BROFORCE_LAUNCH_CMD = script;
  setProcReader(conditionalProcReader({
    800: { comm: LINUX_GAME_COMM, cwd: path.join(root, 'other-session', 'work'), startTicks: 100 },
  }, {
    when: () => fs.access(marker).then(() => true, () => false),
    extra: { 801: { comm: LINUX_GAME_COMM, cwd: '/home/x/.local/share/broforce-linux', startTicks: 200 } },
  }));
  t.after(async () => {
    process.env.BROFORCE_LAUNCH_CMD = NO_OP_LAUNCH_CMD;
    clearProcessStubs();
    await fs.rm(marker, { force: true });
  });

  const held = payload(await launch({ steam: true, vanilla: true }));

  assert.equal(held.success, false, held.message);
  assert.equal(held.state, 'root-unknown');
  assert.match(held.message, /instances root is unknown/);
  assert.match(held.message, /cannot tell whether the user's game is running/);
  await assert.rejects(fs.access(marker), 'a game was launched over an instance nothing could place');

  // A plain launch is the same answer: the session's own instance is out of reach, and the fallback
  // to the user's game is gated no differently
  const plain = payload(await launch({ vanilla: true }));
  assert.equal(plain.success, false, plain.message);
  assert.equal(plain.state, 'root-unknown');
  assert.equal(plain.target, null, 'a launch that launched nothing moved the target');
  await assert.rejects(fs.access(marker));

  // The launcher answers again, the foreign process is placed where it belongs, and the launch runs
  await clearControl('list-fails-after');
  configureLaunchTiming({ rootRetryMs: 0 });

  const launched = payload(await launch({ steam: true, vanilla: true }));
  assert.equal(launched.success, true, launched.message);
  assert.equal(launched.target, 'steam');
  await fs.access(marker);
  assert.deepEqual(signalled, []);
});

test('game_state recovers the root for a session with no instance of its own', { timeout: 30000, skip: !isLinux }, async (t) => {
  delete process.env.CLAUDE_SESSION_ID;
  resetTargetResolution();
  await control('list-fails-after', '0');
  t.after(() => { process.env.CLAUDE_SESSION_ID = SESSION; });

  assert.equal(await resolveTarget(), 'steam');
  const unknown = payload(await handleToolCall({ params: { name: 'game_state', arguments: {} } }));
  assert.match(unknown.instanceReason, /CLAUDE_SESSION_ID is not set/);
  assert.equal(userGame().instancesRoot, null);

  await clearControl('list-fails-after');
  configureLaunchTiming({ rootRetryMs: 0 });

  const recovered = payload(await handleToolCall({ params: { name: 'game_state', arguments: {} } }));
  // The reason is still the session's own missing id, and the root came back all the same
  assert.match(recovered.instanceReason, /CLAUDE_SESSION_ID is not set/);
  assert.equal(userGame().instancesRoot, root);
});

test('a launcher that could not answer --help holds the stop back too', { timeout: 40000, skip: !isLinux }, async (t) => {
  withoutSessionId();
  await control('help-fails', '1');
  const signalled = [];
  // A game in another session's instance: with no verdict there is no root, and no way to tell
  foreignInstanceRunning(signalled);
  t.after(clearProcessStubs);

  assert.equal(await resolveTarget(), 'steam');

  const held = payload(await stop());
  assert.equal(held.success, false, held.message);
  assert.equal(held.unknown, true);
  assert.match(held.message, /did not answer `--help`/);
  assert.deepEqual(signalled, []);

  // The retry is what changes the answer, not the wait: while the launcher keeps failing, so does it
  configureLaunchTiming({ probeRetryMs: 0 });
  const retried = payload(await stop());
  assert.equal(retried.success, false, retried.message);
  assert.match(retried.message, /did not answer `--help`/);
  assert.deepEqual(signalled, []);

  // The launcher answers, and the process it can now place is not the user's game
  await clearControl('help-fails');
  const settled = payload(await stop());
  assert.equal(settled.success, false, settled.message);
  assert.match(settled.message, /No Broforce process is running for the user's game/);
  assert.deepEqual(signalled, [], "another session's instance was signalled");
});

test('game_state alone drives the probe retry and the discovery after it', { timeout: 40000, skip: !isLinux }, async () => {
  await control('help-fails', '1');
  await fs.mkdir(instanceDir, { recursive: true });
  await fs.writeFile(portFile, '9931');

  assert.equal(await resolveTarget(), null);
  const unanswered = payload(await handleToolCall({ params: { name: 'game_state', arguments: {} } }));
  assert.equal(unanswered.instance, null);
  assert.equal(unanswered.target, null);
  assert.match(unanswered.instanceReason, /did not answer `--help` \(it exited with status 3/);

  await clearControl('help-fails');
  configureLaunchTiming({ probeRetryMs: 0 });

  // One reply later the launcher has been asked again, and the list after it
  const answered = payload(await handleToolCall({ params: { name: 'game_state', arguments: {} } }));
  assert.equal(answered.instanceReason, undefined, answered.instanceReason);
  assert.equal(answered.target, 'instance');
  assert.deepEqual(answered.instance, { id: SESSION, port: null, root: instanceDir, stage: stagePath });
  assert.deepEqual((await launcherCalls()).filter(call => call === '--help'), ['--help', '--help']);
  assert.ok((await launcherCalls()).includes('instance list --json'));
});

test('a config taken before the root was known gains it', { timeout: 30000, skip: !isLinux }, async () => {
  withoutSessionId();
  await control('list-fails-after', '0');

  assert.equal(await resolveTarget(), 'steam');
  // Both of these are handed out while the root is unknown, and neither is asked for again
  const captured = userGame();
  const pointedAt = unityClient.gameConfig;
  assert.equal(captured.instancesRoot, null);

  await clearControl('list-fails-after');
  configureLaunchTiming({ rootRetryMs: 0 });
  assert.equal((await discoverInstancesRoot()).instancesRoot, root);

  assert.equal(captured.instancesRoot, root, 'a config handed out before the root was known went stale');
  assert.equal(pointedAt.instancesRoot, root, "the client's own game config went stale");
});

test('a --help that could not answer is asked again once the cooldown is up', { timeout: 30000, skip: !isLinux }, async () => {
  await control('help-fails', '1');

  assert.equal(await instanceModeAvailable(), false);
  assert.equal(instanceModeChecked(), null, 'a launcher that never answered was written off');

  // The launcher answers again, but the failure is this fresh
  await clearControl('help-fails');
  assert.equal(await instanceModeAvailable(), false, 'the launcher was asked again inside the cooldown');
  assert.deepEqual(await launcherCalls(), ['--help']);

  configureLaunchTiming({ probeRetryMs: 0 });
  assert.equal(await instanceModeAvailable(), true);
  assert.equal(instanceModeChecked(), true);
  assert.deepEqual(await launcherCalls(), ['--help', '--help']);
});

test('a --help that never answers is given up on inside the probe\'s budget', { timeout: 30000, skip: !isLinux }, async () => {
  await control('hang-help', '1');

  const started = Date.now();
  assert.equal(await instanceModeAvailable(), false);
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 15000, `the probe waited ${elapsed}ms on a launcher that never answered`);
  assert.equal(instanceModeChecked(), null, 'a launcher that never answered left a verdict behind');
});

test('a launch of the user\'s game is held back while --help goes unanswered', { timeout: 40000, skip: !isLinux }, async (t) => {
  await control('help-fails', '1');
  const signalled = [];
  foreignInstanceRunning(signalled);
  t.after(clearProcessStubs);

  const held = payload(await launch({ steam: true, vanilla: true }));

  assert.equal(held.success, false, held.message);
  assert.equal(held.state, 'root-unknown');
  assert.match(held.message, /did not answer `--help`/);
  assert.deepEqual((await launcherCalls()).filter(call => call.includes('list')), [],
    'the list was asked for by a launcher that had answered nothing');
  assert.deepEqual(signalled, []);
});

test('a --help that answered and named no instance mode is never asked again', { timeout: 30000, skip: !isLinux }, async () => {
  await control('no-instance-mode', '1');

  assert.equal(await instanceModeAvailable(), false);
  assert.equal(instanceModeChecked(), false, 'a launcher that answered left no verdict');

  // Nothing about that answer expires: this launcher has no instance mode, and asking again would
  // hand `instance` to a launcher that reads it as a profile name
  configureLaunchTiming({ probeRetryMs: 0 });
  await clearControl('no-instance-mode');
  assert.equal(await instanceModeAvailable(), false);
  assert.deepEqual(await launcherCalls(), ['--help']);
});

test('a launcher that could not answer is asked again once the cooldown is up', { timeout: 30000, skip: !isLinux }, async () => {
  await control('list-fails-after', '0');

  assert.equal(await resolveTarget(), null);
  assert.equal(userGame().instancesRoot, null, 'a root came from a list nothing could read');

  // The launcher is healthy again, but the failure is this fresh
  await clearControl('list-fails-after');
  assert.equal((await discoverInstancesRoot()).instancesRoot, null, 'the launcher was asked again inside the cooldown');

  configureLaunchTiming({ rootRetryMs: 0 });
  assert.equal((await discoverInstancesRoot()).instancesRoot, root);
  // The user's game is every process outside that root, and now it knows which
  assert.equal(userGame().instancesRoot, root);
});

test('the user\'s game is not stopped by process while the instances root is unknown', { timeout: 40000, skip: !isLinux }, async (t) => {
  withoutSessionId();
  await control('list-fails-after', '0');
  // A game of another session's instance, which nothing here can tell from the user's own
  setProcReader(fakeProcReader({
    800: { comm: LINUX_GAME_COMM, cwd: path.join(root, 'other-session', 'work'), startTicks: 100 },
  }));
  const signalled = [];
  setKillSignaller((pid, signal) => {
    if (signal !== 0) signalled.push(`${signal} ${pid}`);
    return true;
  });
  t.after(() => {
    setProcReader(null);
    setKillSignaller();
  });

  assert.equal(await resolveTarget(), 'steam');

  const stopped = payload(await stop());
  assert.equal(stopped.success, false, stopped.message);
  assert.equal(stopped.unknown, true);
  assert.match(stopped.message, /instances root is unknown/);
  assert.match(stopped.message, /could not be read/);
  assert.deepEqual(signalled, [], "another session's instance was signalled");

  // A launch is held at the same gate, one step earlier: it cannot tell whether the game it would
  // restart is the user's, so it stops nothing and launches nothing
  const relaunch = payload(await launch({ steam: true, restart: true, vanilla: true }));
  assert.equal(relaunch.success, false, relaunch.message);
  assert.equal(relaunch.state, 'root-unknown');
  assert.match(relaunch.message, /instances root is unknown/);
  assert.deepEqual(signalled, []);
});

test('off Linux the launcher is asked nothing at all', { timeout: 30000, skip: !isLinux }, async (t) => {
  setServerPlatform('darwin');
  t.after(() => setServerPlatform());

  assert.equal(await resolveTarget(), 'steam');
  assert.deepEqual(await launcherCalls(), [], 'a launcher was run off Linux');

  const state = payload(await handleToolCall({ params: { name: 'game_state', arguments: {} } }));
  assert.equal(state.target, 'steam');
  assert.equal(state.instance, null);
  assert.match(state.instanceReason, /not on Linux/);
});

test('a header with no instancesRoot leaves the session with no target and launches nothing', { timeout: 30000, skip: !isLinux }, async () => {
  // The launcher's own game root is not where it keeps instances, and the server takes nothing from it
  await control('list.json', `{"root":"${STUB_GAME_ROOT}","cap":8}\n`);

  assert.equal(await resolveTarget(), null);

  const state = payload(await handleToolCall({ params: { name: 'game_state', arguments: {} } }));
  assert.equal(state.target, null);
  assert.equal(state.instance, null);
  assert.match(state.instanceReason, /reports no absolute instancesRoot/);
  assert.match(state.instanceReason, /instance list --json/);
  // A target that never became an instance launched nothing through the launcher
  assert.deepEqual((await launcherCalls()).filter(call => call.includes('launch')), []);

  // And the fallback to the user's game is held at the same gate, saying why on both counts
  const attempted = payload(await launch({ vanilla: true }));
  assert.equal(attempted.success, false, attempted.message);
  assert.equal(attempted.state, 'root-unknown');
  assert.equal(attempted.target, null);
  assert.match(attempted.message, /reports no absolute instancesRoot/);
  assert.equal(attempted.instanceReason, state.instanceReason);
});

test('a launch claims the id while its slow launch command is still running', { timeout: 30000, skip: !isLinux }, async () => {
  await assert.rejects(fs.access(instanceDir), 'the id was not new to begin with');
  await control('slow-launch', '1');

  const pending = launch();
  const settled = pending.then(() => true, () => true);
  let owner = '';
  try {
    while (!owner && !(await Promise.race([settled, new Promise((done) => setTimeout(done, 25, false))]))) {
      owner = await fs.readFile(ownerFile, 'utf8').catch(() => '');
    }
    assert.match(owner.trim(), OWNER_LINE_RE, 'the launch ended with the id unclaimed');
  } finally {
    await settled;
  }

  const result = payload(await pending);
  assert.equal(result.success, false);
  assert.equal(result.state, 'no-port');
});

test('stop_game gives the instance id up again', { timeout: 30000, skip: !isLinux }, async () => {
  await fs.mkdir(instanceDir, { recursive: true });
  await fs.writeFile(ownerFile, `${process.ppid} 1\n`);

  payload(await stop());

  await assert.rejects(fs.access(ownerFile), 'a confirmed stop left the instance owned');
});

test('stop_game with no game left still tidies the instance up', { timeout: 30000, skip: !isLinux }, async () => {
  const result = payload(await stop());

  // Nothing was stopped, but the tidy-up this call asked the launcher for is what succeeded
  assert.equal(result.success, true, result.message);
  assert.equal(result.target, 'instance');
  assert.match(result.message, new RegExp(`No Broforce process is running for instance ${SESSION}`));
  assert.match(result.message, /tidied the instance up/);
  // The launcher's stop tears the display down and clears the pidfile, which is worth doing anyway
  assert.ok((await launcherCalls()).includes(`instance ${SESSION} stop`), 'the display was left standing');
});

test('a tidy-up the launcher refused is not a success', { timeout: 30000, skip: !isLinux }, async () => {
  await control('stop-fails', '1');

  const result = payload(await stop());

  assert.equal(result.success, false, result.message);
  assert.match(result.message, new RegExp(`No Broforce process is running for instance ${SESSION}`));
  assert.match(result.message, /exited 4/);
  assert.doesNotMatch(result.message, /tidied the instance up/);
});

for (const [label, survives] of [['falls back to the signal', false], ['and a signal that fails, is no stop', true]]) {
  test(`a stop the launcher refused for want of the id's lock, with the game still running, ${label}`, { timeout: 40000, skip: !isLinux }, async (t) => {
    const refusal = `instance ${SESSION}: a launch of this id (pid 4242) still holds ${root}/.lock-${SESSION} after 12s; nothing was stopped`;
    await control('stop-refused', refusal);
    const alive = new Set([901]);
    const signalled = [];
    setProcReader(fakeProcReader({ 901: { comm: LINUX_GAME_COMM, cwd: path.join(instanceDir, 'work'), startTicks: 100 } }));
    setKillSignaller((pid, signal) => {
      if (signal !== 0) signalled.push(`${signal} ${pid}`);
      if (!alive.has(pid)) {
        const error = new Error('ESRCH');
        error.code = 'ESRCH';
        throw error;
      }
      if (signal !== 0 && !survives) alive.delete(pid);
      return true;
    });
    t.after(() => {
      setProcReader(null);
      setKillSignaller();
    });
    await fs.mkdir(instanceDir, { recursive: true });

    const result = payload(await stop());

    assert.equal(result.success, !survives, result.message);
    assert.ok(result.message.includes(refusal), result.message);
    assert.ok(signalled.includes('SIGTERM 901'), 'the game was left running with no attempt to stop it');
    assert.equal(Boolean(result.unknown), survives);
    if (survives) assert.match(result.message, /Could not stop/);
    else assert.match(result.message, /by signal/);
  });
}

test('stop_game with remove deletes the instance through the launcher', { timeout: 30000, skip: !isLinux }, async () => {
  await fs.mkdir(instanceDir, { recursive: true });
  await fs.writeFile(path.join(instanceDir, 'port'), String(inspector.port));

  const result = payload(await stop({ remove: true }));

  assert.equal(result.removed, true, result.message);
  assert.ok((await launcherCalls()).includes(`instance ${SESSION} remove`));
  await assert.rejects(fs.access(instanceDir), 'the instance directory outlived remove');
});

test('a launcher that has not finished is not a launcher that wrote no port', { timeout: 30000, skip: !isLinux }, async (t) => {
  await control('slow-launch', '1');
  t.after(slowLaunchFinished);
  configureLaunchTiming({ instanceBudgetMs: 500, portWaitMs: 300 });

  const result = payload(await launch());

  assert.equal(result.success, false);
  assert.equal(result.state, 'no-port');
  assert.match(result.message, /still running after 0.5s and was left to finish/);
  assert.doesNotMatch(result.message, /finished without writing/);
});

test('a stop that left a process behind removes nothing', { timeout: 40000, skip: !isLinux }, async (t) => {
  const workDir = path.join(instanceDir, 'work');
  const alive = new Set([901, 902]);
  const signalled = [];
  // 902 survives everything, as a process whose kill was refused would
  const kill = (pid, signal) => {
    if (signal !== 0) signalled.push(`${signal} ${pid}`);
    if (!alive.has(pid)) {
      const error = new Error('ESRCH');
      error.code = 'ESRCH';
      throw error;
    }
    if (signal === 'SIGKILL' && pid !== 902) alive.delete(pid);
    return true;
  };

  setProcReader(fakeProcReader({
    901: { comm: LINUX_GAME_COMM, cwd: workDir, startTicks: 100 },
    902: { comm: LINUX_GAME_COMM, cwd: workDir, startTicks: 200 },
  }));
  setKillSignaller(kill);
  t.after(() => {
    setProcReader(null);
    setKillSignaller();
  });
  await fs.mkdir(instanceDir, { recursive: true });

  const result = payload(await stop({ remove: true }));

  assert.equal(result.success, false, 'a stop that left a game running reported success');
  assert.equal(result.removed, false, result.message);
  assert.match(result.message, /pid 902 is still running\. Instance/, result.message);
  assert.match(result.message, /not removed/);
  assert.deepEqual((await launcherCalls()).filter(call => call.includes('remove')), [], 'a live game was removed');
  assert.ok(signalled.includes('SIGKILL 902'), signalled.join(', '));
  await fs.access(instanceDir);
});

test('a port file from an earlier run is not this launch\'s allocation', { timeout: 30000, skip: !isLinux }, async (t) => {
  // Somebody else's game now answers on the port this instance was given last time
  const stranger = await fakeInspector();
  t.after(() => stranger.close());
  await seedInstanceDir(instanceDir);
  await fs.writeFile(portFile, String(stranger.port));
  const anHourAgo = new Date(Date.now() - 3600_000);
  await fs.utimes(portFile, anHourAgo, anHourAgo);

  await control('slow-launch', '1');
  t.after(slowLaunchFinished);
  configureLaunchTiming({ instanceBudgetMs: 500, portWaitMs: 400 });

  const result = payload(await launch());

  assert.equal(result.success, false, 'a stranger\'s game was adopted as this launch');
  assert.equal(result.state, 'no-port');
  assert.match(result.message, /still running after 0.5s/);
  assert.notEqual(unityClient.port, stranger.port, 'the client was pointed at the stale port');
});

test('a launch leaves the launcher\'s pidfile alone', { timeout: 30000, skip: !isLinux }, async () => {
  const result = payload(await launch());

  assert.equal(result.success, true, result.message);
  // The pidfile names a game that has not chdir'd into work/ yet, and asking who owns the instance
  // on every poll attempt must not delete it
  assert.equal((await fs.readFile(path.join(instanceDir, 'game.pid'), 'utf8')).trim(), '4242');
});

test('a launcher that refuses before it writes a log still says why', { timeout: 30000, skip: !isLinux }, async () => {
  await control('stderr-only', '1');

  const result = payload(await launch());

  assert.equal(result.success, false);
  assert.match(result.message, /exited with status 3/);
  assert.match(result.message, /Last lines of the launcher's error output/);
  assert.match(result.message, /no display could be created/);
  await assert.rejects(fs.access(path.join(instanceDir, 'launch.log')), 'the launcher wrote a log after all');
});

test('a restart that could not stop the game launches nothing', { timeout: 40000, skip: !isLinux }, async (t) => {
  const workDir = path.join(instanceDir, 'work');
  const alive = new Set([911]);
  const kill = (pid, signal) => {
    if (!alive.has(pid)) {
      const error = new Error('ESRCH');
      error.code = 'ESRCH';
      throw error;
    }
    return true;
  };

  setProcReader(fakeProcReader({ 911: { comm: LINUX_GAME_COMM, cwd: workDir, startTicks: 100 } }));
  setKillSignaller(kill);
  t.after(() => {
    setProcReader(null);
    setKillSignaller();
  });

  const result = payload(await launch({ restart: true }));

  assert.equal(result.success, false, result.message);
  assert.equal(result.state, 'stop-failed');
  assert.deepEqual(result.survivors, [911]);
  assert.match(result.message, /nothing was launched/);
  assert.match(result.message, /still running\. Stop pid 911/, result.message);
  assert.deepEqual(
    (await launcherCalls()).filter(call => call.endsWith(' launch')),
    [],
    'a second game was launched into an instance that still holds the first',
  );
});

test('an earlier run\'s launch log is not this launch\'s account', { timeout: 30000, skip: !isLinux }, async () => {
  const launchLog = path.join(instanceDir, 'launch.log');
  await seedInstanceDir(instanceDir);
  await fs.writeFile(launchLog, '[2026-01-02 03:04:05] launch: ready\n');
  const anHourAgo = new Date(Date.now() - 3600_000);
  await fs.utimes(launchLog, anHourAgo, anHourAgo);

  // This launcher refuses before it has anything to write, so its stderr is all there is
  await control('stderr-only', '1');
  const result = payload(await launch());

  assert.equal(result.success, false);
  assert.match(result.message, /Last lines of the launcher's error output/);
  assert.match(result.message, /no display could be created/);
  assert.doesNotMatch(result.message, /launch: ready/, 'an earlier run\'s log was reported as this launch\'s');
});

test('a port left behind by a cap refusal is not the relaunch\'s allocation', { timeout: 30000, skip: !isLinux }, async (t) => {
  const decoy = await fakeInspector();
  t.after(() => decoy.close());

  await control('cap-refusals', '1');
  await control('decoy-port', String(decoy.port));
  await control('list.json', instanceListJsonl(8, [{ id: 'busy-one', running: true, pid: 944835, port: 9901 }]));

  const result = payload(await launch());

  assert.equal(result.success, true, result.message);
  // The refusal wrote a port after the first spawn, so only re-anchoring on the relaunch rejects it
  assert.equal(result.instance.port, inspector.port);
  assert.notEqual(result.instance.port, decoy.port, 'the refusal\'s leftover port was adopted');
  assert.equal(unityClient.port, inspector.port);
});

test('a port file this launch wrote but cannot be read is its own failure', { timeout: 30000, skip: !isLinux }, async () => {
  await control('bad-port', '1');

  const result = payload(await launch());

  assert.equal(result.success, false);
  assert.equal(result.state, 'no-port');
  assert.match(result.message, /does not hold a usable port: 'not-a-port'/);
  assert.doesNotMatch(result.message, /earlier run/, 'a file this launch wrote is not an earlier run\'s');
  assert.doesNotMatch(result.message, /-\d+(\.\d+)?s before this launch/, 'the file was dated with a negative age');
});

test('a decoy port from a cap refusal is not adopted when the relaunch writes none', { timeout: 30000, skip: !isLinux }, async (t) => {
  const decoy = await fakeInspector();
  t.after(() => decoy.close());

  await control('cap-refusals', '1');
  await control('decoy-port', String(decoy.port));
  await control('skip-port', '1');
  await control('list.json', instanceListJsonl(8, [{ id: 'busy-one', running: true, pid: 944835, port: 9901 }]));

  const result = payload(await launch());

  // The relaunch wrote nothing, so the only port on disk is the one the refusal left behind
  assert.equal(result.success, false, 'the refusal\'s leftover port was adopted');
  assert.equal(result.state, 'no-port');
  assert.notEqual(unityClient.port, decoy.port);
  assert.match(result.message, /earlier run's allocation/);
});

test('a second refusal at the cap re-enters the wait on the budget it has left', { timeout: 90000, skip: !isLinux }, async () => {
  await control('cap-refusals', '2');
  configureLaunchTiming({ instanceBudgetMs: 60000 });
  await control('list.json', instanceListJsonl(8, [{ id: 'busy-one', running: true, pid: 944835, port: 9901 }]));

  const started = Date.now();
  const result = payload(await launch());

  assert.equal(result.success, true, result.message);
  const calls = await launcherCalls();
  assert.equal(calls.filter(call => call === `instance ${SESSION} launch`).length, 3, 'the second refusal ended the launch');
  assert.equal(calls.filter(call => call === 'instance list --json').length >= 2, true, calls.join(' | '));
  // Both waits come out of the one cap budget, which is far shorter than the launch budget
  assert.ok(Date.now() - started < 20000, `took ${Date.now() - started}ms`);
});

test('a launch that changes target says the other game is still running', { timeout: 30000, skip: !isLinux }, async (t) => {
  // A Broforce process outside the instances root is the user's game, and the instance launch leaves it alone
  setProcReader(fakeProcReader({
    800: { comm: LINUX_GAME_COMM, cwd: '/home/x/.local/share/broforce-linux', startTicks: 100 },
  }));
  t.after(() => setProcReader(null));

  const { setTarget } = await import('../index.js');
  await setTarget('steam');

  const result = payload(await launch());

  assert.equal(result.target, 'instance');
  assert.equal(result.success, true, result.message);
  assert.match(result.targetNote, /still running/);
  assert.match(result.targetNote, /user's game/);
});

test('stop_game on the user\'s game with none running signals nothing', { timeout: 30000, skip: !isLinux }, async (t) => {
  const { setTarget } = await import('../index.js');
  setProcReader(fakeProcReader({}));
  t.after(() => setProcReader(null));
  await setTarget('steam');

  const result = payload(await stop());

  assert.equal(result.success, false, result.message);
  assert.equal(result.target, 'steam');
  assert.equal(result.message, "No Broforce process is running for the user's game, so nothing was signalled.");
});

// The user's game is the Broforce process outside the instances root; the configured stop command is
// what makes it go away, which the fake /proc reader follows
function userGameReader(root) {
  const base = fakeProcReader({
    800: { comm: LINUX_GAME_COMM, cwd: '/home/x/.local/share/broforce-linux', startTicks: 100 },
  });
  return {
    ...base,
    async pids() {
      try {
        await fs.access(path.join(root, 'user-game-stopped'));
        return [];
      } catch {
        return base.pids();
      }
    },
  };
}

test('the user\'s game is stopped with the configured stop command', { timeout: 30000, skip: !isLinux }, async (t) => {
  const { setTarget } = await import('../index.js');
  const stopCommand = await writeStubStopCommand(binDir, root);
  process.env.BROFORCE_STOP_CMD = stopCommand;
  setProcReader(userGameReader(root));
  setKillSignaller(() => true);
  t.after(() => {
    delete process.env.BROFORCE_STOP_CMD;
    setProcReader(null);
    setKillSignaller();
  });

  await setTarget('steam');
  const result = payload(await stop());

  assert.equal(result.success, true, result.message);
  assert.equal(result.target, 'steam');
  assert.match(result.message, new RegExp(stopCommand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok((await launcherCalls()).some(call => call.startsWith('stop ')), (await launcherCalls()).join(' | '));
});

test('a stop command that leaves the user\'s game running falls back to the signal', { timeout: 30000, skip: !isLinux }, async (t) => {
  const { setTarget } = await import('../index.js');
  const stopCommand = await writeStubStopCommand(binDir, root);
  await control('stop-leaves-survivor', '1');
  process.env.BROFORCE_STOP_CMD = stopCommand;
  setProcReader(userGameReader(root));
  const signalled = [];
  setKillSignaller((pid, signal) => {
    if (signal !== 0) signalled.push(signal);
    return true;
  });
  t.after(() => {
    delete process.env.BROFORCE_STOP_CMD;
    setProcReader(null);
    setKillSignaller();
  });

  await setTarget('steam');
  const result = payload(await stop());

  assert.ok((await launcherCalls()).some(call => call.startsWith('stop ')), 'the stop command never ran');
  assert.match(result.message, /still running/);
  assert.deepEqual(signalled, ['SIGTERM', 'SIGKILL']);
});

test('remove is refused while the server is pointed at the user\'s game', { timeout: 30000, skip: !isLinux }, async () => {
  const { setTarget } = await import('../index.js');
  await setTarget('steam');
  assert.equal(activeTarget(), 'steam');

  const response = await stop({ remove: true });
  const text = response.content.map((c) => c.text).join('\n');

  assert.equal(response.isError, true, text);
  assert.match(text, /remove: true/);
  // Nothing was stopped and nothing was removed
  assert.deepEqual((await launcherCalls()).filter(call => call.includes('remove')), []);
});

test('a launch onto the user\'s game says the instance\'s game is still running', { timeout: 30000, skip: !isLinux }, async (t) => {
  await fs.mkdir(path.join(instanceDir, 'work'), { recursive: true });
  setProcReader(fakeProcReader({
    900: { comm: LINUX_GAME_COMM, cwd: path.join(instanceDir, 'work'), startTicks: 100 },
  }));
  t.after(() => setProcReader(null));

  assert.equal(await resolveTarget(), 'instance');
  const marker = path.join(root, 'user-game-launched');
  const script = path.join(binDir, 'stub-user-launch');
  await fs.writeFile(script, `#!/bin/sh\n: > '${marker}'\nexit 0\n`, { mode: 0o755 });
  process.env.BROFORCE_LAUNCH_CMD = script;
  setProcReader(conditionalProcReader({
    900: { comm: LINUX_GAME_COMM, cwd: path.join(instanceDir, 'work'), startTicks: 100 },
  }, {
    when: () => fs.access(marker).then(() => true, () => false),
    extra: { 801: { comm: LINUX_GAME_COMM, cwd: '/home/x/.local/share/broforce-linux', startTicks: 200 } },
  }));
  t.after(async () => {
    process.env.BROFORCE_LAUNCH_CMD = NO_OP_LAUNCH_CMD;
    await fs.rm(marker, { force: true });
  });

  const result = payload(await launch({ steam: true, vanilla: true }));

  assert.equal(result.target, 'steam');
  assert.equal(result.success, true, result.message);
  assert.match(result.targetNote, /still running/);
  assert.match(result.targetNote, new RegExp(`instance ${SESSION}`));
  assert.ok(!(await launcherCalls()).some(call => call.includes(' stop')), 'the instance was stopped by the switch');
});

function instanceGameUntilStopped(pid) {
  const base = fakeProcReader({ [pid]: { comm: LINUX_GAME_COMM, cwd: path.join(instanceDir, 'work'), startTicks: 100 } });
  return {
    ...base,
    async pids() {
      return (await launcherCalls()).includes(`instance ${SESSION} stop`) ? [] : base.pids();
    },
  };
}

test('a restart stops the instance\'s game through the launcher and launches it again', { timeout: 40000, skip: !isLinux }, async (t) => {
  await seedInstanceDir(instanceDir);
  await fs.mkdir(path.join(instanceDir, 'work'), { recursive: true });
  await fs.writeFile(portFile, String(inspector.port));
  setProcReader(instanceGameUntilStopped(905));
  const signalled = [];
  setKillSignaller((pid, signal) => {
    if (signal !== 0) signalled.push(`${signal} ${pid}`);
    const error = new Error('ESRCH');
    error.code = 'ESRCH';
    throw error;
  });
  t.after(clearProcessStubs);

  const result = payload(await launch({ restart: true }));

  assert.equal(result.success, true, result.message);
  assert.match(result.message, /restarted and ready/);
  assert.deepEqual(result.instance, { id: SESSION, port: inspector.port });
  const calls = await launcherCalls();
  const stopAt = calls.indexOf(`instance ${SESSION} stop`);
  const launchAt = calls.indexOf(`instance ${SESSION} launch`);
  assert.ok(stopAt >= 0, calls.join(' | '));
  assert.ok(launchAt > stopAt, `the launch did not follow the stop: ${calls.join(' | ')}`);
  assert.deepEqual(signalled, [], 'the launcher\'s stop was enough, so nothing was signalled');
});

test('a restart with nothing running is a plain launch', { timeout: 30000, skip: !isLinux }, async (t) => {
  setProcReader(fakeProcReader({}));
  t.after(() => setProcReader(null));

  const result = payload(await launch({ restart: true }));

  assert.equal(result.success, true, result.message);
  assert.match(result.message, /launched and ready/, 'nothing was there to restart');
  assert.deepEqual(result.instance, { id: SESSION, port: inspector.port });
  const calls = await launcherCalls();
  assert.ok(!calls.includes(`instance ${SESSION} stop`), `a game nothing ran was stopped: ${calls.join(' | ')}`);
  assert.equal(calls.filter(call => call === `instance ${SESSION} launch`).length, 1);
});

test('a launch that comes up carries the launcher\'s running instances', { timeout: 30000, skip: !isLinux }, async () => {
  await control('list.json', instanceListJsonl(8, [
    { id: SESSION, running: true, pid: 4242, port: inspector.port },
    { id: 'busy-one', running: true, pid: 944835, port: 9901 },
    { id: 'idle-one', running: false, port: 9903 },
  ]));

  const result = payload(await launch());

  assert.equal(result.success, true, result.message);
  assert.deepEqual(result.runningInstances.map(entry => entry.id), [SESSION, 'busy-one']);
});

test('BROFORCE_STOP_CMD still stops the user\'s game while the instances root is unknown', { timeout: 40000, skip: !isLinux }, async (t) => {
  withoutSessionId();
  await control('list-fails-after', '0');
  const stopCommand = await writeStubStopCommand(binDir, root);
  process.env.BROFORCE_STOP_CMD = stopCommand;
  setProcReader(userGameReader(root));
  const signalled = [];
  setKillSignaller((pid, signal) => {
    if (signal !== 0) signalled.push(`${signal} ${pid}`);
    return true;
  });
  t.after(async () => {
    delete process.env.BROFORCE_STOP_CMD;
    clearProcessStubs();
    await fs.rm(path.join(root, 'user-game-stopped'), { force: true });
  });

  assert.equal(await resolveTarget(), 'steam');
  const stopped = payload(await stop());

  assert.equal(stopped.success, true, stopped.message);
  assert.match(stopped.message, new RegExp(stopCommand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok((await launcherCalls()).some(call => call.startsWith('stop ')), 'the stop command never ran');
  assert.deepEqual(signalled, []);

  await fs.rm(path.join(root, 'user-game-stopped'), { force: true });
  await control('stop-leaves-survivor', '1');
  setProcReader(userGameReader(root));
  const held = payload(await stop());
  assert.equal(held.success, false, held.message);
  assert.equal(held.unknown, true);
  assert.match(held.message, /instances root is unknown/);
  assert.deepEqual(signalled, [], 'the user\'s game was signalled while the root was unknown');
});

test('a stop that left a process behind keeps the instance claimed', { timeout: 40000, skip: !isLinux }, async (t) => {
  const workDir = path.join(instanceDir, 'work');
  setProcReader(fakeProcReader({ 912: { comm: LINUX_GAME_COMM, cwd: workDir, startTicks: 100 } }));
  setKillSignaller(() => true);
  t.after(clearProcessStubs);
  await fs.mkdir(instanceDir, { recursive: true });
  await fs.writeFile(ownerFile, `${process.ppid} 1\n`);

  const result = payload(await stop());

  assert.equal(result.success, false, result.message);
  assert.match(result.message, /912/);
  assert.match((await fs.readFile(ownerFile, 'utf8')).trim(), OWNER_LINE_RE);
});

test('a cancelled launch stops waiting on the cap and launches nothing more', { timeout: 30000, skip: !isLinux }, async () => {
  await resolveTarget();
  await control('cap-refusals', '99');
  await control('list.json', instanceListJsonl(1, [{ id: 'busy-one', running: true, pid: 944835, port: 9901 }]));
  configureLaunchTiming({ capPollMs: 60000, capWaitMs: 20000 });
  const controller = new AbortController();
  const started = Date.now();
  const launching = handleToolCall({ params: { name: 'launch_game', arguments: {} } }, { signal: controller.signal });
  while (!(await launcherCalls()).includes(`instance ${SESSION} launch`)) {
    assert.ok(Date.now() - started < 10000, 'the launch never ran');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  const cancelledAt = Date.now();
  controller.abort();

  const response = await launching;
  const after = Date.now() - cancelledAt;
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /launch_game was cancelled/);
  assert.ok(after < 5000, `the cap wait ran on for ${after}ms after the cancellation`);
  await assertNoLaunchAfterCancel();
  const launches = (await launcherCalls()).filter(call => call === `instance ${SESSION} launch`);
  assert.equal(launches.length, 1, 'the launcher was called more than once');
});

async function assertNoLaunchAfterCancel() {
  const launches = async () => (await launcherCalls()).filter(call => call === `instance ${SESSION} launch`).length;
  await new Promise((resolve) => setTimeout(resolve, 300));
  const settled = await launches();
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(await launches(), settled, 'a launch ran after the cancellation');
}

test('a launch cancelled while the cap wait reads the instance list launches nothing more', { timeout: 30000, skip: !isLinux }, async () => {
  await resolveTarget();
  await control('cap-refusals', '99');
  await control('slow-list', '0.6');
  configureLaunchTiming({ capPollMs: 50, capWaitMs: 20000 });
  const controller = new AbortController();
  const started = Date.now();
  const launching = handleToolCall({ params: { name: 'launch_game', arguments: {} } }, { signal: controller.signal });
  while (!(await launcherCalls()).includes(`instance ${SESSION} launch`)) {
    assert.ok(Date.now() - started < 10000, 'the launch never ran');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const launchCalls = async () => (await launcherCalls()).filter(call => call === `instance ${SESSION} launch`);
  let atAbort = null;
  setTimeout(async () => {
    controller.abort();
    atAbort = { launches: (await launchCalls()).length, calls: await launcherCalls() };
  }, 300);

  const response = await launching;
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /launch_game was cancelled/);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(atAbort.calls.at(-1), 'instance list --json', 'the abort did not land during the cap wait\'s list');
  assert.equal((await launchCalls()).length, atAbort.launches, 'a launch ran after the cancellation');
});

test('a launch that fails validation leaves the target where it was', { timeout: 30000, skip: !isLinux }, async (t) => {
  setProcReader(fakeProcReader({}));
  t.after(() => setProcReader(null));
  assert.equal(await resolveTarget(), 'instance');

  const badArgs = await launch({ steam: true, launchArgs: "--profile='My Mods" });
  assert.equal(badArgs.isError, true);
  assert.match(badArgs.content[0].text, /Invalid launchArgs/);
  assert.equal(activeTarget(), 'instance', 'a launch refused before it ran moved the target');

  process.env.BROFORCE_LAUNCH_CMD = path.join(binDir, 'no-such-launch-command');
  t.after(() => { process.env.BROFORCE_LAUNCH_CMD = NO_OP_LAUNCH_CMD; });
  const unspawnable = await launch({ steam: true });
  assert.equal(unspawnable.isError, true);
  assert.match(unspawnable.content[0].text, /Failed to launch Broforce/);
  assert.equal(activeTarget(), 'instance', 'a launch that could not spawn moved the target');
});

test('a target switch is refused while another tool call on the target is still running', { timeout: 30000, skip: !isLinux }, async () => {
  assert.equal(await resolveTarget(), 'instance');
  const waiting = handleToolCall({ params: { name: 'wait_for_game', arguments: { timeout: 1.5, interval: 1 } } });
  await new Promise((resolve) => setTimeout(resolve, 300));

  const refused = await launch({ steam: true, vanilla: true });
  assert.equal(refused.isError, true, refused.content[0].text);
  assert.match(refused.content[0].text, /wait_for_game is still running/);
  assert.equal(activeTarget(), 'instance');

  await waiting;
  const allowed = payload(await launch({ steam: true, vanilla: true }));
  assert.equal(allowed.target, 'steam');
});

test('a launcher allowing no instances is reported at once, not polled for a slot', { timeout: 30000, skip: !isLinux }, async () => {
  configureLaunchTiming({ capPollMs: 10, capWaitMs: 20000 });
  await control('cap-refusals', '99');
  await control('list.json', instanceListJsonl(0, []));

  const started = Date.now();
  const result = payload(await launch());

  assert.equal(result.state, 'cap-reached');
  assert.match(result.message, /allows no instances to run \(its cap is 0\)/);
  assert.ok(Date.now() - started < 15000, `the wait ran ${Date.now() - started}ms of its 20s`);
  assert.equal((await launcherCalls()).filter(call => call === `instance ${SESSION} launch`).length, 1);
});

test('a launch that finds its instance running claims it, whoever launched it', { timeout: 30000, skip: !isLinux }, async (t) => {
  await fs.mkdir(path.join(instanceDir, 'work'), { recursive: true });
  await fs.writeFile(portFile, String(inspector.port));
  await fs.writeFile(ownerFile, `${await deadOwnerLine()}\n`);
  setProcReader(fakeProcReader({ 900: { comm: LINUX_GAME_COMM, cwd: path.join(instanceDir, 'work'), startTicks: 100 } }));
  t.after(() => setProcReader(null));

  const result = payload(await launch());
  assert.equal(result.alreadyRunning, true, result.message);
  assert.match((await fs.readFile(ownerFile, 'utf8')).trim(), OWNER_LINE_RE);
});

test('a live claim of a newer wrapper of the session is never written over', { timeout: 30000, skip: !isLinux }, async (t) => {
  const newer = await liveNewerOwner(t);
  await fs.mkdir(path.join(instanceDir, 'work'), { recursive: true });
  await fs.writeFile(portFile, String(inspector.port));
  await fs.writeFile(ownerFile, `${newer}\n`);
  setProcReader(fakeProcReader({ 900: { comm: LINUX_GAME_COMM, cwd: path.join(instanceDir, 'work'), startTicks: 100 } }));
  t.after(() => setProcReader(null));

  assert.equal(await resolveTarget(), 'instance');
  payload(await handleToolCall({ params: { name: 'ping', arguments: {} } }));
  const result = payload(await launch());
  assert.equal(result.alreadyRunning, true, result.message);
  assert.equal((await fs.readFile(ownerFile, 'utf8')).trim(), newer, 'an older server took the id back');

  const { claimInstanceWhenCreated } = await import('../index.js');
  assert.equal(await claimInstanceWhenCreated(sessionInstance(), Promise.resolve()), null);
  assert.equal((await fs.readFile(ownerFile, 'utf8')).trim(), newer);
});

test('a startup with no instance directory takes the id once a launch elsewhere creates it', { timeout: 30000, skip: !isLinux }, async (t) => {
  setProcReader(fakeProcReader({}));
  t.after(() => setProcReader(null));
  assert.equal(await resolveTarget(), 'instance');
  await assert.rejects(fs.access(ownerFile));

  await fs.mkdir(instanceDir, { recursive: true });
  await fs.writeFile(ownerFile, `1 ${await startTicksOf(1)}\n`);
  await handleToolCall({ params: { name: 'ping', arguments: {} } });

  assert.match((await fs.readFile(ownerFile, 'utf8')).trim(), OWNER_LINE_RE);
});

test('a game of the instance that comes up after startup is claimed by the next command', { timeout: 30000, skip: !isLinux }, async (t) => {
  await fs.mkdir(path.join(instanceDir, 'work'), { recursive: true });
  setProcReader(fakeProcReader({}));
  t.after(() => setProcReader(null));
  assert.equal(await resolveTarget(), 'instance');
  await fs.rm(ownerFile, { force: true });

  await fs.writeFile(portFile, String(inspector.port));
  setProcReader(fakeProcReader({ 900: { comm: LINUX_GAME_COMM, cwd: path.join(instanceDir, 'work'), startTicks: 100 } }));
  payload(await handleToolCall({ params: { name: 'ping', arguments: {} } }));

  assert.match((await fs.readFile(ownerFile, 'utf8')).trim(), OWNER_LINE_RE);
});

test('a server whose wrapper has died claims nothing in its name', { timeout: 30000, skip: !isLinux }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orphan-'));
  const child = path.join(dir, 'orphan.mjs');
  const indexUrl = new URL('../index.js', import.meta.url).href;
  const sessionUrl = new URL('./support/session.js', import.meta.url).href;
  await fs.writeFile(child, `
    import '${sessionUrl}';
    import { writeFileSync } from 'fs';
    const { writeOwnerFile } = await import('${indexUrl}');
    const parent = process.ppid;
    writeFileSync(${JSON.stringify(path.join(dir, 'ready'))}, '');
    while (process.ppid === parent) await new Promise((r) => setTimeout(r, 20));
    const config = { isAgentInstance: true, root: ${JSON.stringify(dir)}, ownerFile: ${JSON.stringify(path.join(dir, 'owner.pid'))} };
    process.stderr.write('claim=' + (await writeOwnerFile(config)) + '\\n', () => process.exit(0));
  `);
  const { spawn } = await import('child_process');
  const out = path.join(dir, 'out');
  const ready = path.join(dir, 'ready');
  await new Promise((resolve) => {
    spawn('sh', ['-c', `"${process.execPath}" "${child}" 2> "${out}" & until [ -e "${ready}" ]; do sleep 0.05; done`], { stdio: 'ignore' }).on('exit', resolve);
  });
  let text = '';
  for (let i = 0; i < 200 && !/claim=/.test(text); i++) {
    await new Promise((r) => setTimeout(r, 50));
    text = await fs.readFile(out, 'utf8').catch(() => '');
  }
  try {
    assert.match(text, /claim=null/, text);
    await assert.rejects(fs.access(path.join(dir, 'owner.pid')), 'an orphaned server wrote a claim');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a shutdown whose wrapper the client has already killed still claims a brand-new instance for its reaper', { timeout: 30000, skip: !isLinux }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orphan-shutdown-'));
  const child = path.join(dir, 'orphan.mjs');
  const ready = path.join(dir, 'ready');
  const instance = path.join(dir, 'instance');
  const indexUrl = new URL('../index.js', import.meta.url).href;
  const sessionUrl = new URL('./support/session.js', import.meta.url).href;
  await fs.writeFile(child, `
    import '${sessionUrl}';
    import fs from 'fs/promises';
    const { claimInstanceWhenCreated, ownerIdentity, shutdownServer } = await import('${indexUrl}');
    const identity = await ownerIdentity();
    const parent = process.ppid;
    const config = { isAgentInstance: true, root: ${JSON.stringify(instance)}, ownerFile: ${JSON.stringify(path.join(instance, 'owner.pid'))} };
    claimInstanceWhenCreated(config, new Promise(() => {}));
    await fs.writeFile(${JSON.stringify(ready)}, '');
    while (process.ppid === parent) await new Promise((r) => setTimeout(r, 20));
    setTimeout(() => fs.mkdir(config.root), 300);
    await shutdownServer('SIGINT', { exit: async () => {
      const owner = await fs.readFile(config.ownerFile, 'utf8').catch(() => null);
      process.stderr.write(JSON.stringify({ identity, owner }) + '\\n', () => process.exit(0));
    } });
  `);
  const { spawn } = await import('child_process');
  const out = path.join(dir, 'out');
  await new Promise((resolve) => {
    spawn('sh', ['-c', `"${process.execPath}" "${child}" 2> "${out}" & while [ ! -e "${ready}" ]; do sleep 0.05; done`], { stdio: 'ignore' })
      .on('exit', resolve);
  });
  let text = '';
  for (let i = 0; i < 200 && !/"identity"/.test(text); i++) {
    await new Promise((r) => setTimeout(r, 50));
    text = await fs.readFile(out, 'utf8').catch(() => '');
  }
  try {
    const { identity, owner } = JSON.parse(text.split('\n').find((line) => line.includes('"identity"')));
    assert.match(String(identity), /^\d+ \d+$/);
    assert.equal(owner, `${identity}\n`, 'the brand-new instance was left unclaimed for the reaper');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a claim being written never leaves owner.pid a truncated line for another server to read', { timeout: 30000, skip: !isLinux }, async (t) => {
  const { claimInstance } = await import('../index.js');
  await fs.mkdir(instanceDir, { recursive: true });
  await resolveTarget();
  const previous = await deadOwnerLine();
  await fs.writeFile(ownerFile, `${previous}\n`);

  // The real write truncates its file before the bytes land
  const write = fs.writeFile;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let entered;
  const writing = new Promise((resolve) => { entered = resolve; });
  fs.writeFile = async (file, data, options) => {
    if (String(file).startsWith(instanceDir)) {
      await write(file, '');
      entered();
      await gate;
    }
    return write(file, data, options);
  };
  t.after(() => { fs.writeFile = write; });

  const claiming = claimInstance(sessionInstance());
  await writing;
  assert.equal((await fs.readFile(ownerFile, 'utf8')).trim(), previous, 'a reader found the claim half written');
  release();
  assert.match(String(await claiming), OWNER_LINE_RE);
  assert.match((await fs.readFile(ownerFile, 'utf8')).trim(), OWNER_LINE_RE);
});

test('under WSL launch_game and stop_game refuse the user\'s game rather than answer for it', { timeout: 30000, skip: !isLinux }, async (t) => {
  const { setTarget } = await import('../index.js');
  const { setWslProbe } = await import('../lib/game-process.js');
  setWslProbe(() => true);
  t.after(() => setWslProbe(NOT_WSL));
  await resolveTarget();
  await setTarget('steam');

  const launched = await launch({ steam: true });
  assert.equal(launched.isError, true);
  assert.match(launched.content[0].text, /cannot reach the user's game from WSL/);
  const stopped = await stop();
  assert.equal(stopped.isError, true);
  assert.match(stopped.content[0].text, /cannot reach the user's game from WSL/);
});

test('a stop waits for this server\'s own launch command before it asks the launcher', { timeout: 30000, skip: !isLinux }, async () => {
  await control('slow-launch', '1');
  configureLaunchTiming({ portWaitMs: 100 });

  const launching = launch();
  while (!(await launcherCalls()).includes(`instance ${SESSION} launch`)) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const stopped = payload(await stop());
  await launching;

  const launchLog = await fs.readFile(path.join(instanceDir, 'launch.log'), 'utf8');
  const calls = await launcherCalls();
  assert.ok(calls.indexOf(`instance ${SESSION} stop`) > calls.indexOf(`instance ${SESSION} launch`), calls.join(' | '));
  assert.match(launchLog, /launch: set up[\s\S]*stop: done/);
  assert.equal(stopped.target, 'instance');
});

test('an instances root reported through a symlink is the path the game\'s working directory reads', { timeout: 30000, skip: !isLinux }, async (t) => {
  const link = `${root}-link`;
  await fs.symlink(root, link);
  process.env.STUB_INSTANCES_ROOT = link;
  t.after(async () => {
    process.env.STUB_INSTANCES_ROOT = root;
    await fs.rm(link, { force: true });
  });
  await fs.mkdir(path.join(instanceDir, 'work'), { recursive: true });
  const real = await fs.realpath(root);
  setProcReader(fakeProcReader({ 900: { comm: LINUX_GAME_COMM, cwd: path.join(real, SESSION, 'work'), startTicks: 100 } }));
  t.after(() => setProcReader(null));

  assert.equal(await resolveTarget(), 'instance');
  assert.equal(sessionInstance().root, path.join(real, SESSION));
  assert.equal(userGame().instancesRoot, real);
  const { isGameRunning } = await import('../lib/game-process.js');
  assert.equal(await isGameRunning(sessionInstance()), true, 'the instance\'s own game was not recognised');
});

test('a launcher that cannot be run says why, not only that it did not answer', { timeout: 30000, skip: !isLinux }, async (t) => {
  process.env.BROFORCE_INSTANCE_CMD = path.join(binDir, 'no-such-launcher');
  resetTargetResolution();
  t.after(() => {
    process.env.BROFORCE_INSTANCE_CMD = launcher;
    resetTargetResolution();
  });

  const state = payload(await handleToolCall({ params: { name: 'game_state', arguments: {} } }));
  assert.match(state.instanceReason, /did not answer `--help` \(it could not be run \(spawn .*no-such-launcher ENOENT\)\)/);
});

test('game_state names the store and build of the game it is pointed at', { timeout: 30000, skip: !isLinux }, async (t) => {
  const { startStubServer, reply } = await import('./support/stub-server.js');
  const game = await startStubServer((request, socket) => reply(socket, request.id,
    request.method === 'execute_code'
      ? { success: true, resultSet: true, result: '1135 2023-05-17 10:12' }
      : { scene: 'Test Evan2' }));
  t.after(() => game.close());
  const gameDir = path.join(root, 'gog', 'game');
  await fs.mkdir(gameDir, { recursive: true });
  await fs.writeFile(path.join(gameDir, 'goggame-1470490225.info'), '{"buildId":"57322851356943141"}');
  await fs.mkdir(path.join(instanceDir, 'work'), { recursive: true });
  await fs.writeFile(portFile, String(game.port));
  setProcReader(fakeProcReader({
    900: { comm: LINUX_GAME_COMM, cwd: path.join(instanceDir, 'work'), exe: path.join(gameDir, 'Broforce.x86_64'), startTicks: 100 },
  }));
  t.after(() => setProcReader(null));

  const state = payload(await handleToolCall({ params: { name: 'game_state', arguments: {} } }));
  assert.deepEqual(state.build, {
    store: 'gog',
    storeBuild: '57322851356943141',
    gameDir,
    version: 1135,
    buildDate: '2023-05-17 10:12',
  });
});

test('a hung game is asked for no version, and one that answers later gets its version', { timeout: 30000, skip: !isLinux }, async (t) => {
  const { startStubServer, reply } = await import('./support/stub-server.js');
  const seen = [];
  let hung = true;
  let versionFails = false;
  const game = await startStubServer((request, socket) => {
    seen.push(request.method);
    if (request.method === 'execute_code') {
      reply(socket, request.id, versionFails
        ? { success: false, error: 'Main thread action timed out after 5000ms', mainThreadAnswered: false }
        : { success: true, resultSet: true, result: '1135 2023-05-17 10:12' });
    } else {
      reply(socket, request.id, hung
        ? { mainThreadAnswered: false, error: 'The game\'s main thread did not answer' }
        : { mainThreadAnswered: true, scene: 'Test Evan2' });
    }
  });
  t.after(() => game.close());
  await fs.mkdir(path.join(instanceDir, 'work'), { recursive: true });
  await fs.writeFile(portFile, String(game.port));
  setProcReader(fakeProcReader({
    900: { comm: LINUX_GAME_COMM, cwd: path.join(instanceDir, 'work'), startTicks: 100 },
  }));
  t.after(() => setProcReader(null));
  const ask = () => handleToolCall({ params: { name: 'game_state', arguments: {} } });

  const stalled = await ask();
  assert.ok(!stalled.isError, 'a stalled game\'s game_state is an answer, not an error');
  assert.equal(payload(stalled).mainThreadAnswered, false);
  assert.ok(!seen.includes('execute_code'), 'a hung game was asked for its version');

  hung = false;
  versionFails = true;
  assert.equal(payload(await ask()).build?.version ?? null, null);
  assert.equal(seen.filter((method) => method === 'execute_code').length, 1);

  versionFails = false;
  assert.equal(payload(await ask()).build.version, 1135, 'a failed version query was kept for the connection');
  assert.equal(seen.filter((method) => method === 'execute_code').length, 2);
  await ask();
  assert.equal(seen.filter((method) => method === 'execute_code').length, 2, 'an answered version is asked once');
});

test('two launches for opposite targets at once: the second is refused, not switched under the first', { timeout: 30000, skip: !isLinux }, async (t) => {
  setProcReader(fakeProcReader({}));
  t.after(() => setProcReader(null));
  assert.equal(await resolveTarget(), 'instance');

  const [toSteam, toInstance] = await Promise.all([launch({ steam: true, vanilla: true }), launch({})]);
  const refused = [toSteam, toInstance].filter(reply => reply.isError);
  assert.equal(refused.length, 1, [toSteam, toInstance].map(reply => reply.content[0].text).join('\n---\n'));
  assert.match(refused[0].content[0].text, /launch_game is still running/);
  const ran = JSON.parse((refused[0] === toSteam ? toInstance : toSteam).content[0].text);
  assert.equal(ran.target, activeTarget(), 'the launch that ran ended pointed somewhere else');
});

test('a launch uses its allocated port only while the contract keeps it reserved', { timeout: 30000, skip: !isLinux }, async (t) => {
  setProcReader(fakeProcReader({}));
  t.after(() => setProcReader(null));
  configureLaunchTiming({ instanceBudgetMs: 1500, portReservationMs: 0 });
  t.after(() => configureLaunchTiming({ portReservationMs: 180000 }));

  const hellosBefore = inspector.hellos.length;
  const expired = payload(await launch());
  assert.equal(expired.success, false, expired.message);
  assert.equal(expired.state, 'no-port');
  assert.equal(inspector.hellos.length, hellosBefore, 'the poll connected to a port past its reservation');

  configureLaunchTiming({ portReservationMs: 180000 });
  await fs.rm(path.join(instanceDir, 'game.pid'), { force: true });
  const reserved = payload(await launch());
  assert.equal(reserved.success, true, reserved.message);
});

async function runningInstanceGame() {
  const workDir = path.join(instanceDir, 'work');
  await fs.mkdir(workDir, { recursive: true });
  await fs.writeFile(portFile, String(inspector.port));
  return { 900: { comm: LINUX_GAME_COMM, cwd: workDir, startTicks: 100 } };
}

async function startSweepBehind(t, release) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sweep-overlap-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const before = inspector.lines.length;
  const sweep = handleToolCall({ params: { name: 'capture_animations', arguments: { out: path.join(dir, 'out'), timeout: 1 } } });
  await until(() => inspector.lines.slice(before).some((line) => line.method === 'ping'));
  await release();
  return { sweep, sentSince: () => inspector.lines.slice(before).map((line) => line.method) };
}

for (const [name, args] of [['simulate_input', { action: 'jump' }], ['run_test_script', { script: 'input-sequence' }]]) {
  test(`${name} held in its target wait while a sweep starts is refused`, { timeout: 30000, skip: !isLinux }, async (t) => {
    const processes = await runningInstanceGame();
    setProcReader(fakeProcReader(processes));
    assert.equal(await resolveTarget(), 'instance');

    const table = fakeProcReader(processes);
    let reachedScan;
    const reached = new Promise((resolve) => { reachedScan = resolve; });
    let releaseScan;
    const scanHeld = new Promise((resolve) => { releaseScan = resolve; });
    let first = true;
    setProcReader({
      ...table,
      async pids() {
        if (first) {
          first = false;
          reachedScan();
          await scanHeld;
        }
        return table.pids();
      },
    });
    t.after(() => {
      releaseScan();
      setProcReader(null);
    });

    const held = handleToolCall({ params: { name, arguments: args } });
    await reached;
    invalidateGameProcessScan();
    const { sweep, sentSince } = await startSweepBehind(t, releaseScan);

    const response = await held;
    assert.equal(response.isError, true, response.content[0].text);
    assert.match(response.content[0].text, new RegExp(`Cannot run ${name} while a capture_animations sweep`));
    assert.ok(!sentSince().includes(name), 'the held call reached the game beside the sweep');
    await sweep;
  });
}

for (const [name, argsFor] of [['execute_script', (file) => ({ path: file })], ['unload_script', (file) => ({ name: file })]]) {
  test(`${name} held reading its script file while a sweep starts is refused`, { timeout: 30000, skip: !isLinux }, async (t) => {
    setProcReader(fakeProcReader(await runningInstanceGame()));
    t.after(() => setProcReader(null));
    assert.equal(await resolveTarget(), 'instance');

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sweep-overlap-fifo-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const fifo = path.join(dir, 'held.cs');
    execFileSync('mkfifo', [fifo]);
    // The read blocks until something opens the other end, which r+ does without blocking itself
    let released = null;
    const release = () => (released ??= fs.writeFile(fifo, 'public static class Held {}', { flag: 'r+' }));
    t.after(release);

    const held = handleToolCall({ params: { name, arguments: argsFor(fifo) } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const { sweep, sentSince } = await startSweepBehind(t, release);

    const response = await held;
    assert.equal(response.isError, true, response.content[0].text);
    assert.match(response.content[0].text, new RegExp(`Cannot run ${name} while a capture_animations sweep`));
    assert.ok(!sentSince().includes(name), 'the held call reached the game beside the sweep');
    await sweep;
  });
}

test('a shutdown during a brand-new instance\'s launch waits for its creation claim', { timeout: 30000, skip: !isLinux }, async () => {
  const { shutdownServer } = await import('../index.js');
  await control('create-late', '1');
  await resolveTarget();

  const launching = launch();
  while (!(await launcherCalls()).includes(`instance ${SESSION} launch`)) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  let claimedAtExit = null;
  await shutdownServer('SIGTERM', {
    exit: () => { claimedAtExit = existsSync(ownerFile); },
  });
  await launching;

  assert.equal(claimedAtExit, true, 'the server exited before the brand-new instance was claimed');
  assert.match((await fs.readFile(ownerFile, 'utf8')).trim(), OWNER_LINE_RE);
});

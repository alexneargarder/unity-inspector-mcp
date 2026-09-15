import './support/session.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';

import { instanceConfig, steamConfig, withRoot } from '../lib/instance.js';
import {
  LINUX_GAME_COMM,
  detectActiveProfile,
  gameStartTime,
  isGameRunning,
  isUnder,
  killGame,
  ownedGameProcesses,
  ownsProcess,
  parseBootTimeMs,
  parseStatPpid,
  parseStatStartTicks,
  probeInstanceMode,
  readValidatedPidfile,
  resetInstanceModeProbe,
  scanGameProcesses,
} from '../lib/game-process.js';
import { FAKE_BOOT_TIME_MS, fakeFileSystem, fakeProcReader, recordingKill } from './support/fake-proc.js';

// These tests own their launch command: an inherited one would change what they mean
delete process.env.BROFORCE_LAUNCH_CMD;

const isLinux = process.platform === 'linux';
// The root the launcher reported, which is the only thing that makes these paths
const INSTANCES_ROOT = '/var/lib/agent-games/instances';
const homeOptions = { platform: 'linux' };
const SESSION_ONE = 'session-one';
const SESSION_TWO = 'session-two';

const rooted = (env) => withRoot(instanceConfig(env, homeOptions), INSTANCES_ROOT);
const userGame = withRoot(steamConfig(), INSTANCES_ROOT);
const LAUNCHER = 'game-launcher';
const agentOne = rooted({ CLAUDE_SESSION_ID: SESSION_ONE, BROFORCE_INSTANCE_CMD: LAUNCHER });
const agentTwo = rooted({ CLAUDE_SESSION_ID: SESSION_TWO, BROFORCE_INSTANCE_CMD: LAUNCHER });

// pid 100 is the user's Steam game, 101 and 102 are agent instances 1 and 2, 103 is not the game.
// The wrapper eats --r2profile and run_umm.sh eats --doorstop-target-assembly, so the profile path
// is on the shells that started the game, never on the game's own argv.
const PROCESSES = {
  90: { comm: 'bash', cwd: '/home/u', startTicks: 90000, cmdline: 'bash /nix/store/x-launch/bin/launch-game' },
  95: { comm: 'reaper', cwd: '/home/u', ppid: 90, startTicks: 95000, cmdline: '/home/u/.local/share/Steam/ubuntu12_32/reaper SteamLaunch AppId=274190 -- /home/u/.config/r2modmanPlus-local/Broforce/profiles/Default/run_umm.sh /home/u/.local/share/broforce-linux/Broforce.x86_64' },
  100: { comm: LINUX_GAME_COMM, cwd: '/home/u/.local/share/broforce-linux', ppid: 95, startTicks: 100000, cmdline: '/home/u/.local/share/broforce-linux/Broforce.x86_64 -screen-fullscreen 0' },
  101: { comm: LINUX_GAME_COMM, cwd: `${INSTANCES_ROOT}/${SESSION_ONE}/work`, ppid: 90, startTicks: 200000, cmdline: `${INSTANCES_ROOT}/${SESSION_ONE}/profile/run_umm.sh --doorstop-enabled true` },
  102: { comm: LINUX_GAME_COMM, cwd: `${INSTANCES_ROOT}/${SESSION_TWO}/work`, startTicks: 300000 },
  103: { comm: 'steam', cwd: `${INSTANCES_ROOT}/${SESSION_ONE}/work`, startTicks: 50000 },
};

const reader = () => fakeProcReader(PROCESSES);
beforeEach(() => resetInstanceModeProbe());
const pidsOf = (procs) => procs.map(proc => proc.pid).sort((a, b) => a - b);

test('the scan finds every Broforce process and nothing else', async () => {
  const procs = await scanGameProcesses(reader());
  assert.deepEqual(pidsOf(procs), [100, 101, 102]);
  assert.equal(procs[0].cwd, '/home/u/.local/share/broforce-linux');
  assert.equal(procs[0].startMs, FAKE_BOOT_TIME_MS + 1000000);
});

test('/proc field parsing survives the shapes the kernel emits', () => {
  // The comm field is parenthesised and may itself contain spaces and brackets
  assert.equal(parseStatStartTicks(`7 (odd ) name) S ${Array(18).fill(0).join(' ')} 4242 0 0`), 4242);
  assert.equal(parseStatStartTicks(''), null);
  assert.equal(parseStatStartTicks(null), null);

  assert.equal(parseBootTimeMs('cpu 1 2 3\nbtime 1767225600\nprocesses 9\n'), 1767225600000);
  assert.equal(parseBootTimeMs('cpu 1 2 3\n'), null);
  assert.equal(parseBootTimeMs(null), null);
});

test('parseStatPpid reads the parent, including for a comm full of parentheses', { skip: !isLinux }, async () => {
  assert.equal(parseStatPpid(await fs.readFile('/proc/self/stat', 'utf8')), process.ppid);
  assert.equal(parseStatPpid(`7 (odd ) name) S 42 ${Array(17).fill(0).join(' ')} 4242 0 0`), 42);
  // pid 0 is no parent at all, and neither is a line that has none
  assert.equal(parseStatPpid(`7 (sh) S 0 ${Array(17).fill(0).join(' ')} 4242 0 0`), null);
  assert.equal(parseStatPpid(''), null);
  assert.equal(parseStatPpid(null), null);
});

test('parseStatStartTicks reads a real /proc entry', { skip: !isLinux }, async () => {
  const ticks = parseStatStartTicks(await fs.readFile('/proc/self/stat', 'utf8'));
  assert.ok(Number.isFinite(ticks) && ticks > 0, `got ${ticks}`);
});

test('a comm truncated by the kernel still matches the Windows depot', async () => {
  // /proc/<pid>/comm stops at 15 characters, which cuts 'Broforce_beta.exe' short
  const truncated = fakeProcReader({
    400: { comm: 'Broforce_beta.e', cwd: '/home/u/game', startTicks: 100, cmdline: 'Z:\\game\\Broforce_beta.exe --doorstop-enabled true' },
    401: { comm: 'Broforce_other.', cwd: '/home/u/game', startTicks: 100, cmdline: 'Z:\\game\\Broforce_other.dll' },
  });

  assert.deepEqual(pidsOf(await ownedGameProcesses(userGame, truncated)), [400]);
});

test('a renamed copy of the Linux binary is the game, whatever comm was truncated to', { skip: !isLinux }, async () => {
  // A renamed copy of the Linux binary, whose name comm cuts to 15 characters
  const renamed = {
    700: {
      comm: 'Broforce-alt.x8',
      cwd: '/home/x/.local/share/broforce-linux',
      startTicks: 100,
      cmdline: '/home/x/.local/share/broforce-linux/Broforce-alt.x86_64',
    },
  };

  assert.deepEqual(pidsOf(await ownedGameProcesses(userGame, fakeProcReader(renamed))), [700]);
  assert.deepEqual(pidsOf(await ownedGameProcesses(agentOne, fakeProcReader(renamed))), []);
  assert.equal(await isGameRunning(userGame, fakeProcReader(renamed)), true);
  assert.equal(await gameStartTime(userGame, fakeProcReader(renamed)), FAKE_BOOT_TIME_MS + 1000);

  const kill = recordingKill();
  const result = await killGame({
    config: userGame,
    reader: fakeProcReader(renamed),
    fileSystem: fakeFileSystem(),
    kill,
    graceMs: 0,
  });
  assert.equal(result.killed, true, result.detail);
  assert.deepEqual([...new Set(kill.calls.map(call => call.pid))], [700]);

  // A Broforce-prefixed comm running some other program is not the game
  const impostor = fakeProcReader({
    701: { comm: 'Broforce-alt.x8', cwd: '/home/x', startTicks: 100, cmdline: '/usr/bin/something' },
  });
  assert.deepEqual(pidsOf(await ownedGameProcesses(userGame, impostor)), []);
  assert.equal(await isGameRunning(userGame, impostor), false);
});

test('a process that merely mentions the game executable is not the game', async () => {
  const bystanders = fakeProcReader({
    500: { comm: 'broforce-instan', cwd: '/home/u', startTicks: 100, cmdline: 'tail -f /home/u/Broforce.exe.log' },
    501: { comm: 'wine64-preloader', cwd: '/home/u', startTicks: 100, cmdline: 'wineserver --logfile /home/u/Broforce.exe.log' },
  });

  assert.deepEqual(pidsOf(await ownedGameProcesses(userGame, bystanders)), []);
});

test('killGame leaves no stale answer in the scan cache', { skip: !isLinux }, async () => {
  const alive = { 600: { comm: LINUX_GAME_COMM, cwd: '/home/u/game', startTicks: 100 } };
  const counting = fakeProcReader(alive);
  let walks = 0;
  const inner = counting.pids;
  counting.pids = async () => { walks++; return inner(); };

  assert.deepEqual(pidsOf(await scanGameProcesses(counting)), [600]);
  await killGame({ config: userGame, reader: counting, fileSystem: fakeFileSystem(), kill: recordingKill(), graceMs: 0 });
  delete alive[600];

  assert.deepEqual(pidsOf(await scanGameProcesses(counting)), [], 'the cache outlived the kill');
  assert.ok(walks >= 2, `expected a fresh walk after the kill, saw ${walks}`);
});

test('repeat scans within the cache window share one walk of /proc', async () => {
  const counting = fakeProcReader({ 100: PROCESSES[100] });
  let walks = 0;
  const inner = counting.pids;
  counting.pids = async () => { walks++; return inner(); };

  await scanGameProcesses(counting);
  await scanGameProcesses(counting);
  assert.equal(walks, 1, 'the second scan should have been served from the cache');

  await scanGameProcesses(counting, { maxAgeMs: 0 });
  assert.equal(walks, 2, 'an expired cache must be walked again');

  // A different reader is a different question and never reads the cached answer
  const other = fakeProcReader({ 101: PROCESSES[101] });
  assert.deepEqual(pidsOf(await scanGameProcesses(other)), [101]);
});

test('path containment does not treat a sibling directory as a child', () => {
  assert.equal(isUnder(`${INSTANCES_ROOT}/${SESSION_ONE}/work`, `${INSTANCES_ROOT}/${SESSION_ONE}/work`), true);
  assert.equal(isUnder(`${INSTANCES_ROOT}/${SESSION_ONE}/work/Saves`, `${INSTANCES_ROOT}/${SESSION_ONE}/work`), true);
  assert.equal(isUnder(`${INSTANCES_ROOT}/${SESSION_ONE}x/work`, `${INSTANCES_ROOT}/${SESSION_ONE}/work`), false);
  assert.equal(isUnder('/home/u/.local/share/broforce-linux', INSTANCES_ROOT), false);
  assert.equal(isUnder(null, INSTANCES_ROOT), false);
});

test('an agent instance owns only the process in its own work directory', async () => {
  assert.deepEqual(pidsOf(await ownedGameProcesses(agentOne, reader())), [101]);
  assert.deepEqual(pidsOf(await ownedGameProcesses(agentTwo, reader())), [102]);
});

test("the user's game is every Broforce process outside the instances root", async () => {
  assert.deepEqual(pidsOf(await ownedGameProcesses(userGame, reader())), [100]);

  // A process whose cwd cannot be read belongs to another user, so it is never an agent instance
  const hidden = fakeProcReader({ 200: { comm: LINUX_GAME_COMM, cwd: null, startTicks: 10 } });
  assert.deepEqual(pidsOf(await ownedGameProcesses(userGame, hidden)), [200]);
  assert.deepEqual(pidsOf(await ownedGameProcesses(agentOne, hidden)), []);

  assert.equal(ownsProcess({ pid: 1, cwd: `${INSTANCES_ROOT}/session-three/work` }, userGame), false);
});

test('a Proton game is found by command line, since its comm is the wine loader', { skip: !isLinux }, async () => {
  const proton = fakeProcReader({
    300: { comm: 'wine64-preloader', cwd: '/home/u/steam/Broforce', startTicks: 400000, cmdline: 'Z:\\game\\Broforce.exe --doorstop-enabled true' },
    301: { comm: 'wineserver', cwd: '/home/u/steam/Broforce', startTicks: 400001, cmdline: 'wineserver -p' },
    302: { comm: 'bash', cwd: '/home/u', startTicks: 1, cmdline: 'tail -f Broforce.exe.log' },
  });

  assert.deepEqual(pidsOf(await ownedGameProcesses(userGame, proton)), [300]);
  assert.deepEqual(pidsOf(await ownedGameProcesses(agentOne, proton)), []);

  const chain = fakeProcReader({
    300: { comm: 'proton', cwd: '/home/u/steam/Broforce', startTicks: 400000, cmdline: 'proton run Z:\\game\\Broforce.exe' },
    301: { comm: 'wine64-preloader', cwd: '/home/u/steam/Broforce', startTicks: 500000, cmdline: 'Z:\\game\\Broforce.exe' },
  });
  // With only command-line matches the game is the last of the chain to start
  assert.equal(await gameStartTime(userGame, chain), FAKE_BOOT_TIME_MS + 5000000);
});

test('isGameRunning answers for the owned process only', { skip: !isLinux }, async () => {
  const onlyAgentTwo = fakeProcReader({ 102: PROCESSES[102] });
  assert.equal(await isGameRunning(agentTwo, onlyAgentTwo), true);
  assert.equal(await isGameRunning(agentOne, onlyAgentTwo), false);
  assert.equal(await isGameRunning(userGame, onlyAgentTwo), false);

  const unreadable = { ...reader(), pids: async () => { throw new Error('EACCES'); } };
  assert.equal(await isGameRunning(userGame, unreadable), null);
});

test('gameStartTime takes the earliest start among owned processes only', { skip: !isLinux }, async () => {
  assert.equal(await gameStartTime(userGame, reader()), FAKE_BOOT_TIME_MS + 1000000);
  assert.equal(await gameStartTime(agentOne, reader()), FAKE_BOOT_TIME_MS + 2000000);

  const twoForOne = fakeProcReader({
    101: PROCESSES[101],
    104: { comm: LINUX_GAME_COMM, cwd: `${INSTANCES_ROOT}/${SESSION_ONE}/work`, startTicks: 150000 },
  });
  assert.equal(await gameStartTime(agentOne, twoForOne), FAKE_BOOT_TIME_MS + 1500000);

  assert.equal(await gameStartTime(rooted({ CLAUDE_SESSION_ID: 'session-nine', BROFORCE_INSTANCE_CMD: LAUNCHER }), reader()), null);
});

test('the launched profile is read from the process chain that started the game', { skip: !isLinux }, async () => {
  assert.equal(await detectActiveProfile(userGame, reader()), 'Default');
  // An agent instance runs from its own profile directory, which is not an r2modman profile
  assert.equal(await detectActiveProfile(agentOne, reader()), null);

  // A chain that never names a profile must not borrow one from a sibling process
  const orphan = fakeProcReader({
    100: { comm: LINUX_GAME_COMM, cwd: '/home/u/game', startTicks: 100, cmdline: '/home/u/game/Broforce.x86_64' },
  });
  assert.equal(await detectActiveProfile(userGame, orphan), null);
});

test('two games under different profiles resolve to no profile at all', { skip: !isLinux }, async () => {
  const both = fakeProcReader({
    100: { comm: LINUX_GAME_COMM, cwd: '/home/u/game', startTicks: 100, environ: 'DOORSTOP_TARGET_ASSEMBLY=/home/u/.config/r2modmanPlus-local/Broforce/profiles/Default/UMM/Core/UnityModManager.dll' },
    200: { comm: LINUX_GAME_COMM, cwd: '/home/u/game2', startTicks: 200, environ: 'DOORSTOP_TARGET_ASSEMBLY=/home/u/.config/r2modmanPlus-local/Broforce/profiles/Testing/UMM/Core/UnityModManager.dll' },
  });

  assert.equal(await detectActiveProfile(userGame, both), null);
});

test('the profile is also read from the doorstop environment variable', { skip: !isLinux }, async () => {
  const environ = fakeProcReader({
    100: {
      comm: LINUX_GAME_COMM,
      cwd: '/home/u/game',
      startTicks: 100,
      cmdline: '/home/u/game/Broforce.x86_64',
      environ: 'HOME=/home/u DOORSTOP_TARGET_ASSEMBLY=/home/u/.config/r2modmanPlus-local/Broforce/profiles/UMM_Local_Install/UMM/Core/UnityModManager.dll LANG=C',
    },
  });

  assert.equal(await detectActiveProfile(userGame, environ), 'UMM_Local_Install');
});

test('a pidfile whose process no longer matches is never trusted, and pruned only on request', async () => {
  const valid = fakeFileSystem({ [agentOne.pidfile]: '101\n' });
  assert.equal(await readValidatedPidfile(agentOne, { reader: reader(), fileSystem: valid, prune: true }), 101);
  assert.ok(valid.store.has(agentOne.pidfile), 'a valid pidfile must survive');

  for (const contents of ['102', '999', 'nonsense', '']) {
    const stale = fakeFileSystem({ [agentOne.pidfile]: contents });
    assert.equal(
      await readValidatedPidfile(agentOne, { reader: reader(), fileSystem: stale, prune: true }),
      null,
      `pidfile ${JSON.stringify(contents)} was trusted`,
    );
    assert.equal(stale.store.has(agentOne.pidfile), false, `stale pidfile ${JSON.stringify(contents)} was left behind`);

    // Asking who owns the instance is a question, not a verdict: a pidfile the game has not caught
    // up with yet must survive being asked about
    const asked = fakeFileSystem({ [agentOne.pidfile]: contents });
    assert.equal(await readValidatedPidfile(agentOne, { reader: reader(), fileSystem: asked }), null);
    assert.ok(asked.store.has(agentOne.pidfile), `pidfile ${JSON.stringify(contents)} was deleted by a mere question`);
  }

  assert.equal(await readValidatedPidfile(userGame, { reader: reader(), fileSystem: fakeFileSystem() }), null);
});

// A launcher with an instance mode lists it in --help; one without has no such line
const HELP_TEXT = 'Usage: stub [profile] [options]\n  stub instance <id> <cmd>   launch, stop or status for an agent instance\n';

function probeStub({ code = 0, stdout = HELP_TEXT, stderr = '', error = null } = {}) {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args].join(' '));
    return { code, stdout, stderr, error };
  };
  run.calls = calls;
  return run;
}

function stopCommandStub({ code = 0, error = null, removes = null, processes = null } = {}) {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args].join(' '));
    if (removes !== null && processes !== null) delete processes[String(removes)];
    return { code, error, stdout: '', stderr: error ? '' : '' };
  };
  run.calls = calls;
  return run;
}

test("the instance mode is read from the launcher's help text, the one question it cannot misread", async () => {
  const accepted = probeStub();
  assert.equal(await probeInstanceMode(agentOne, { runProbe: accepted }), true);
  assert.deepEqual(accepted.calls, [`${LAUNCHER} --help`], 'only --help is safe to ask an unknown launcher');

  // The setting's own leading arguments belong to --help as much as to every other verb
  resetInstanceModeProbe();
  const withArgs = probeStub();
  const configured = instanceConfig(
    { CLAUDE_SESSION_ID: SESSION_ONE, BROFORCE_INSTANCE_CMD: 'mytool game --quiet' },
    homeOptions,
  );
  assert.equal(await probeInstanceMode(configured, { runProbe: withArgs }), true);
  assert.deepEqual(withArgs.calls, ['mytool game --quiet --help']);

  // The verdict is settled once per server process, and concurrent callers share the one probe
  resetInstanceModeProbe();
  const cached = probeStub();
  await Promise.all([
    probeInstanceMode(agentOne, { runProbe: cached }),
    probeInstanceMode(agentOne, { runProbe: cached }),
  ]);
  await probeInstanceMode(agentOne, { runProbe: cached });
  assert.equal(cached.calls.length, 1);

  for (const [name, answer] of [
    ['help without instance mode', { stdout: 'Usage: stub [profile] [options]\n  --vanilla   launch without mods\n' }],
    ['a launcher that launched instead of answering', { stdout: 'Launching Broforce (profile: instance)...\n' }],
    ['a non-zero exit', { code: 2 }],
    ['a missing launcher', { code: null, error: new Error('spawn ENOENT') }],
    ['a probe that timed out', { code: null, stdout: '', error: new Error('Timed out') }],
  ]) {
    resetInstanceModeProbe();
    assert.equal(await probeInstanceMode(agentOne, { runProbe: probeStub(answer) }), false, name);
  }

  // Some tools print their usage on stderr
  resetInstanceModeProbe();
  assert.equal(await probeInstanceMode(agentOne, { runProbe: probeStub({ stdout: '', stderr: HELP_TEXT }) }), true);

  // A runner that throws is an answer, not a rejection left behind for the next caller
  resetInstanceModeProbe();
  const throwing = async () => { throw new Error('spawn failed'); };
  assert.equal(await probeInstanceMode(agentOne, { runProbe: throwing }), false);
  resetInstanceModeProbe();
  assert.equal(await probeInstanceMode(agentOne, { runProbe: probeStub() }), true, 'a failed probe must not poison the next one');

  resetInstanceModeProbe();
  assert.equal(await probeInstanceMode(userGame, { runProbe: probeStub() }), false);
});

test('a target that leaves between the stop command and the signal still counts as stopped', { skip: !isLinux }, async () => {
  const live = { 101: { ...PROCESSES[101] } };
  const kill = recordingKill({ startsDead: [101] });

  const result = await killGame({
    config: agentOne,
    reader: fakeProcReader(live),
    fileSystem: fakeFileSystem({ [agentOne.pidfile]: '101' }),
    kill,
    // Exits 0 but the process is still in /proc when we look
    runStop: stopCommandStub(),
    runProbe: probeStub(),
    graceMs: 0,
  });

  assert.equal(result.killed, true, result.detail);
  assert.match(result.detail, new RegExp(`${LAUNCHER} instance ${SESSION_ONE} stop`));
  assert.doesNotMatch(result.detail, /had already exited/);
});

test('a stop command that leaves a process behind is followed by a signal', { skip: !isLinux }, async () => {
  const second = { comm: LINUX_GAME_COMM, cwd: `${INSTANCES_ROOT}/${SESSION_ONE}/work`, startTicks: 210000 };
  const live = { 101: { ...PROCESSES[101] }, 111: second };
  const kill = recordingKill();

  const result = await killGame({
    config: agentOne,
    reader: fakeProcReader(live),
    fileSystem: fakeFileSystem({ [agentOne.pidfile]: '101' }),
    kill,
    // The command reports success having stopped only one of the two
    runStop: stopCommandStub({ removes: 101, processes: live }),
    runProbe: probeStub(),
    graceMs: 0,
  });

  assert.equal(result.killed, true, result.detail);
  assert.match(result.detail, /still running/);
  assert.deepEqual(kill.signalsFor(111).filter(signal => signal !== 0), ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(kill.signalsFor(101), [], 'the pid the command stopped must not be signalled');
});

test('BROFORCE_LAUNCH_CMD is the user\'s game and never touches an instance stop', { skip: !isLinux }, async (t) => {
  process.env.BROFORCE_LAUNCH_CMD = 'other-launcher';
  t.after(() => { delete process.env.BROFORCE_LAUNCH_CMD; });

  const live = { 101: { ...PROCESSES[101] } };
  const runStop = stopCommandStub({ removes: 101, processes: live });
  const kill = recordingKill();

  const result = await killGame({
    config: agentOne,
    reader: fakeProcReader(live),
    fileSystem: fakeFileSystem({ [agentOne.pidfile]: '101' }),
    kill,
    runStop,
    runProbe: probeStub(),
    graceMs: 0,
  });

  assert.equal(result.killed, true, result.detail);
  assert.deepEqual(runStop.calls, [`${LAUNCHER} instance ${SESSION_ONE} stop`]);
  assert.deepEqual(kill.calls.filter(call => call.signal !== 0), [], 'nothing should have been signalled');
});

test('a launcher without instance mode is never asked to stop anything', { skip: !isLinux }, async () => {
  const runStop = stopCommandStub();
  const kill = recordingKill();

  const result = await killGame({
    config: agentOne,
    reader: reader(),
    fileSystem: fakeFileSystem({ [agentOne.pidfile]: '101' }),
    kill,
    runStop,
    runProbe: probeStub({ stdout: 'Launching Broforce (profile: instance)...\n' }),
    graceMs: 0,
  });

  assert.equal(result.killed, true, result.detail);
  assert.deepEqual(runStop.calls, [], 'the stop command must not run without instance mode');
  assert.match(result.detail, /no instance mode/);
  assert.deepEqual(kill.signalsFor(101).filter(signal => signal !== 0), ['SIGTERM', 'SIGKILL']);
});

test("an instance is stopped with the launcher's instance mode, not by signal", { skip: !isLinux }, async () => {
  const live = { 101: { ...PROCESSES[101] } };
  const runStop = stopCommandStub({ removes: 101, processes: live });
  const kill = recordingKill();
  const fileSystem = fakeFileSystem({ [agentOne.pidfile]: '101' });

  const result = await killGame({
    config: agentOne,
    reader: fakeProcReader(live),
    fileSystem,
    kill,
    runStop,
    runProbe: probeStub(),
    graceMs: 0,
  });

  assert.equal(result.killed, true, result.detail);
  assert.deepEqual(runStop.calls, [`${LAUNCHER} instance ${SESSION_ONE} stop`]);
  assert.match(result.detail, new RegExp(`${LAUNCHER} instance ${SESSION_ONE} stop`));
  assert.deepEqual(kill.calls.filter(call => call.signal !== 0), [], 'nothing should have been signalled');
  assert.equal(fileSystem.store.has(agentOne.pidfile), false);
});

test('an instance stop that exited non-zero but left nothing running is still a stop', { skip: !isLinux }, async () => {
  const live = { 101: { ...PROCESSES[101] } };
  const kill = recordingKill();
  const fileSystem = fakeFileSystem({ [agentOne.pidfile]: '101' });

  const result = await killGame({
    config: agentOne,
    reader: fakeProcReader(live),
    fileSystem,
    kill,
    runStop: stopCommandStub({ code: 3, removes: 101, processes: live }),
    runProbe: probeStub(),
    graceMs: 0,
  });

  assert.equal(result.killed, true, result.detail);
  assert.match(result.detail, new RegExp(`Stopped instance ${SESSION_ONE} with`));
  assert.match(result.detail, /though .* exited 3/);
  assert.deepEqual(kill.calls.filter(call => call.signal !== 0), [], 'nothing should have been signalled');
  assert.equal(fileSystem.store.has(agentOne.pidfile), false, 'the pidfile outlived the stop');
});

test('a stop command that fails hands over to the pid-scoped kill', { skip: !isLinux }, async () => {
  const kill = recordingKill();
  const fileSystem = fakeFileSystem({ [agentOne.pidfile]: '101' });

  const result = await killGame({
    config: agentOne,
    reader: reader(),
    fileSystem,
    kill,
    runStop: stopCommandStub({ code: 3 }),
    runProbe: probeStub(),
    graceMs: 0,
  });

  assert.equal(result.killed, true, result.detail);
  assert.match(result.detail, /exited 3/);
  assert.deepEqual(kill.signalsFor(101).filter(signal => signal !== 0), ['SIGTERM', 'SIGKILL']);
});

test('a missing stop command is a fallback, not a failure', { skip: !isLinux }, async () => {
  const kill = recordingKill();
  const result = await killGame({
    config: agentOne,
    reader: reader(),
    fileSystem: fakeFileSystem(),
    kill,
    runStop: stopCommandStub({ code: null, error: new Error('spawn ENOENT') }),
    runProbe: probeStub(),
    graceMs: 0,
  });

  assert.equal(result.killed, true, result.detail);
  assert.match(result.detail, /ENOENT/);
  assert.deepEqual(kill.signalsFor(101).filter(signal => signal !== 0), ['SIGTERM', 'SIGKILL']);
});

const STOP_CMD = '/opt/stop-broforce --now';

test("BROFORCE_STOP_CMD stops the user's game and is named for it", { skip: !isLinux }, async () => {
  const live = { 100: { ...PROCESSES[100] } };
  const runStop = stopCommandStub({ removes: 100, processes: live });
  const runProbe = probeStub();
  const kill = recordingKill();

  const result = await killGame({
    config: userGame,
    reader: fakeProcReader(live),
    fileSystem: fakeFileSystem(),
    kill,
    runStop,
    runProbe,
    env: { BROFORCE_STOP_CMD: STOP_CMD },
    graceMs: 0,
  });

  assert.deepEqual(runStop.calls, [STOP_CMD]);
  assert.deepEqual(runProbe.calls, [], "the user's game is nothing to do with the instance launcher");
  assert.equal(result.killed, true, result.detail);
  assert.match(result.detail, new RegExp(`Stopped the user's game with .${STOP_CMD}`));
  assert.deepEqual(kill.calls.filter(call => call.signal !== 0), [], 'nothing should have been signalled');
});

test('a stop command that leaves the game running hands over to the signal', { skip: !isLinux }, async () => {
  const kill = recordingKill();
  const result = await killGame({
    config: userGame,
    reader: reader(),
    fileSystem: fakeFileSystem(),
    kill,
    // Exits 0 but the game is still in /proc when we look
    runStop: stopCommandStub(),
    env: { BROFORCE_STOP_CMD: STOP_CMD },
    graceMs: 0,
  });

  assert.equal(result.killed, true, result.detail);
  assert.match(result.detail, /still running/);
  assert.deepEqual(kill.signalsFor(100).filter(signal => signal !== 0), ['SIGTERM', 'SIGKILL']);
});

test('a stop command that could not run says so and signals instead', { skip: !isLinux }, async () => {
  for (const outcome of [{ code: 3 }, { code: null, error: new Error('spawn ENOENT') }]) {
    const kill = recordingKill();
    const result = await killGame({
      config: userGame,
      reader: reader(),
      fileSystem: fakeFileSystem(),
      kill,
      runStop: stopCommandStub(outcome),
      env: { BROFORCE_STOP_CMD: STOP_CMD },
      graceMs: 0,
    });

    assert.equal(result.killed, true, result.detail);
    assert.match(result.detail, /exited 3|ENOENT/);
    assert.deepEqual(kill.signalsFor(100).filter(signal => signal !== 0), ['SIGTERM', 'SIGKILL']);
  }
});

test('a stop command that left nothing running stopped the game, whatever it exited', { skip: !isLinux }, async () => {
  const live = { 100: { ...PROCESSES[100] } };
  const kill = recordingKill();

  const result = await killGame({
    config: userGame,
    reader: fakeProcReader(live),
    fileSystem: fakeFileSystem(),
    kill,
    runStop: stopCommandStub({ code: 3, removes: 100, processes: live }),
    env: { BROFORCE_STOP_CMD: STOP_CMD },
    graceMs: 0,
  });

  assert.equal(result.killed, true, result.detail);
  assert.match(result.detail, new RegExp(`Stopped the user's game with .${STOP_CMD}`));
  assert.match(result.detail, /though .* exited 3/);
  assert.deepEqual(kill.calls.filter(call => call.signal !== 0), []);
});

test('with no game running no stop command is run', { skip: !isLinux }, async () => {
  const runStop = stopCommandStub();
  const kill = recordingKill();

  const result = await killGame({
    config: userGame,
    reader: fakeProcReader({}),
    fileSystem: fakeFileSystem(),
    kill,
    runStop,
    env: { BROFORCE_STOP_CMD: STOP_CMD },
    graceMs: 0,
  });

  assert.equal(result.killed, false);
  assert.match(result.detail, /No Broforce process is running/);
  assert.deepEqual(runStop.calls, []);
  assert.deepEqual(kill.calls, []);
});

test('without the setting the user\'s game is stopped by signal alone', { skip: !isLinux }, async () => {
  const runStop = stopCommandStub();
  const kill = recordingKill();

  const result = await killGame({
    config: userGame,
    reader: reader(),
    fileSystem: fakeFileSystem(),
    kill,
    runStop,
    env: {},
    graceMs: 0,
  });

  assert.deepEqual(runStop.calls, []);
  assert.equal(result.killed, true, result.detail);
  assert.deepEqual([...new Set(kill.calls.map(call => call.pid))], [100]);
});

test('BROFORCE_STOP_CMD is never run on the instance target', { skip: !isLinux }, async () => {
  const live = { 101: { ...PROCESSES[101] } };
  const runStop = stopCommandStub({ removes: 101, processes: live });

  const result = await killGame({
    config: agentOne,
    reader: fakeProcReader(live),
    fileSystem: fakeFileSystem({ [agentOne.pidfile]: '101' }),
    kill: recordingKill(),
    runStop,
    runProbe: probeStub(),
    env: { BROFORCE_STOP_CMD: STOP_CMD },
    graceMs: 0,
  });

  assert.deepEqual(runStop.calls, [`${LAUNCHER} instance ${SESSION_ONE} stop`]);
  assert.equal(result.killed, true, result.detail);
});

test("the user's game is never routed through an instance stop command", { skip: !isLinux }, async () => {
  const runStop = stopCommandStub();
  const kill = recordingKill();

  const result = await killGame({ config: userGame, reader: reader(), fileSystem: fakeFileSystem(), kill, runStop, runProbe: probeStub(), env: {}, graceMs: 0 });

  assert.equal(result.killed, true, result.detail);
  assert.deepEqual(runStop.calls, []);
  assert.deepEqual([...new Set(kill.calls.map(call => call.pid))], [100]);
});

test('killGame stops the pid from the pidfile and escalates to SIGKILL', { skip: !isLinux }, async () => {
  const kill = recordingKill();
  const fileSystem = fakeFileSystem({ [agentOne.pidfile]: '101' });
  const result = await killGame({ config: agentOne, reader: reader(), fileSystem, kill, runStop: stopCommandStub({ code: 3 }), runProbe: probeStub(), graceMs: 0 });

  assert.equal(result.killed, true);
  assert.match(result.detail, new RegExp(`instance ${SESSION_ONE}`));
  assert.deepEqual(kill.signalsFor(101).filter(signal => signal !== 0), ['SIGTERM', 'SIGKILL']);
  assert.equal(fileSystem.store.has(agentOne.pidfile), false, 'the pidfile outlived the process');
});

test('killGame waits for a SIGKILL to take effect before calling it a survivor', { skip: !isLinux }, async () => {
  const kill = recordingKill({ diesOnKillAfter: 1 });
  const fileSystem = fakeFileSystem({ [agentOne.pidfile]: '101' });
  const result = await killGame({ config: agentOne, reader: reader(), fileSystem, kill, runStop: stopCommandStub({ code: 3 }), runProbe: probeStub(), graceMs: 0, pollMs: 10 });

  assert.equal(result.killed, true, result.detail);
  assert.equal(fileSystem.store.has(agentOne.pidfile), false, 'the pidfile outlived the process it named');
});

test('killGame leaves a process that answered SIGTERM alone', { skip: !isLinux }, async () => {
  const kill = recordingKill({ diesOnTerm: true });
  const result = await killGame({
    config: agentOne,
    reader: reader(),
    fileSystem: fakeFileSystem({ [agentOne.pidfile]: '101' }),
    kill,
    runStop: stopCommandStub({ code: 3 }),
    runProbe: probeStub(),
    graceMs: 200,
    pollMs: 10,
  });

  assert.equal(result.killed, true);
  assert.deepEqual(kill.signalsFor(101).filter(signal => signal !== 0), ['SIGTERM']);
});

test('killGame falls back to the scan and never targets another instance', { skip: !isLinux }, async () => {
  const agentKill = recordingKill();
  const agentResult = await killGame({
    config: agentTwo,
    reader: reader(),
    fileSystem: fakeFileSystem(),
    kill: agentKill,
    runStop: stopCommandStub({ code: 3 }),
    runProbe: probeStub(),
    graceMs: 0,
  });
  assert.equal(agentResult.killed, true);
  assert.deepEqual([...new Set(agentKill.calls.map(call => call.pid))], [102]);

  const userKill = recordingKill();
  const userResult = await killGame({
    config: userGame,
    reader: reader(),
    fileSystem: fakeFileSystem(),
    kill: userKill,
    graceMs: 0,
  });
  assert.equal(userResult.killed, true);
  assert.deepEqual([...new Set(userKill.calls.map(call => call.pid))], [100]);
});

test('killGame reports honestly when this instance has no process', { skip: !isLinux }, async () => {
  const kill = recordingKill();
  const result = await killGame({
    config: rooted({ CLAUDE_SESSION_ID: 'session-nine', BROFORCE_INSTANCE_CMD: LAUNCHER }),
    reader: reader(),
    fileSystem: fakeFileSystem(),
    kill,
    runStop: stopCommandStub({ code: 3 }),
    runProbe: probeStub(),
    graceMs: 0,
  });

  assert.equal(result.killed, false);
  assert.match(result.detail, /instance session-nine/);
  assert.doesNotMatch(result.detail, /though/);
  assert.deepEqual(kill.calls, []);
});

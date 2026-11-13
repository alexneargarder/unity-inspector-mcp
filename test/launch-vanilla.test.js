import { NOT_WSL, NO_LISTENER_PORT, NO_OP_LAUNCH_CMD } from './support/session.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import { existsSync, mkdirSync, rmSync } from 'fs';
import os from 'os';
import { execFileSync, spawn } from 'child_process';
import path from 'path';

import { conditionalProcReader, fakeProcReader } from './support/fake-proc.js';
import { startStubServer, reply } from './support/stub-server.js';
import { withNoRealGame } from './support/real-game.js';

const { LAUNCH_OUTPUT_MARK, commandIsRunnable, configureLaunchTiming, handleToolCall, launcherExitWatcher, launchPending, pollUntilResponsive, setLaunchResolver, unityClient, userGame, vanillaTookEffect } = await import('../index.js');
const { LINUX_GAME_COMM, composeExtraLaunchArgs, isGameRunning, lastSpawnOptions, resolveLaunchCommand, setCommandSpawner, setKillSignaller, setProcReader, setStderrDrainProgram, setWslProbe } = await import('../lib/game-process.js');
const { launchOutputFile } = await import('../lib/launch-record.js');
const { tokenizeCommand } = await import('../lib/command-line.js');

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'vanilla-'));
test.after(() => fs.rm(scratch, { recursive: true, force: true }));

const realGameUp = async () => (await isGameRunning()) !== false;
const USER_GAME_UP = 'a Broforce process is running, so launch_game would report it instead of launching';

if (process.platform === 'linux') {
  setProcReader(fakeProcReader({}));
  test.after(() => setProcReader(null));
}
configureLaunchTiming({ startConfirmMs: 600, startStableMs: 150, startPollMs: 50 });

function userGameOnceLaunched(marker) {
  setProcReader(conditionalProcReader({}, {
    when: () => fs.access(marker).then(() => true, () => false),
    extra: { 801: { comm: LINUX_GAME_COMM, cwd: '/home/x/.local/share/broforce-linux', startTicks: 200 } },
  }));
}

function textOf(response) {
  return response.content.map((c) => c.text).join('\n');
}

test('a vanilla launch that the launch command refuses is not reported as started', { timeout: 60000 }, async (t) => {
  await withNoRealGame(t, realGameUp, USER_GAME_UP, async () => {

    const script = path.join(scratch, 'refusing-launcher.sh');
    await fs.writeFile(script, 'exit 7\n');
    process.env.BROFORCE_LAUNCH_CMD = `sh ${script}`;
    t.after(() => { process.env.BROFORCE_LAUNCH_CMD = NO_OP_LAUNCH_CMD; });

    const response = await handleToolCall({ params: { name: 'launch_game', arguments: { vanilla: true } } });
    const payload = JSON.parse(textOf(response));

    assert.equal(payload.success, false, payload.message);
    assert.match(payload.message, /exited with status 7/);
  });
});

test('a launch through Steam is refused rather than run under the tests', { timeout: 60000 }, async (t) => {
  await withNoRealGame(t, realGameUp, USER_GAME_UP, async () => {

    delete process.env.BROFORCE_LAUNCH_CMD;
    t.after(() => { process.env.BROFORCE_LAUNCH_CMD = NO_OP_LAUNCH_CMD; });

    const response = await handleToolCall({ params: { name: 'launch_game', arguments: { steam: true, vanilla: true } } });

    assert.equal(response.isError, true, textOf(response));
    assert.match(textOf(response), /UNITY_INSPECTOR_TEST/);
    assert.match(textOf(response), /BROFORCE_LAUNCH_CMD/);
  });
});

test('a launch that dropped --vanilla is never reported as a vanilla launch', async () => {
  const custom = await resolveLaunchCommand({ vanilla: true }, { BROFORCE_LAUNCH_CMD: 'a-launcher' }, 'linux');
  assert.equal(vanillaTookEffect(custom), true);

  // The Steam protocol launch takes no arguments, so the game comes up modded
  const noSteam = { onPath: async () => false, steamRoots: () => [], findSteamGame: async () => ({ gamePath: null, protonPrefix: null, steamapps: null }), profilesRoot: () => '/nonexistent' };
  const steam = await resolveLaunchCommand({ vanilla: true }, {}, 'linux', null, noSteam);
  assert.deepEqual(steam.ignoredArgs, ['--vanilla']);
  assert.equal(vanillaTookEffect(steam), false);

  assert.equal(vanillaTookEffect(await resolveLaunchCommand({}, { BROFORCE_LAUNCH_CMD: 'a-launcher' }, 'linux')), false);
});

test('--vanilla in launchArgs is a vanilla launch, up to a -- that hands the rest to the game', async () => {
  const env = { BROFORCE_LAUNCH_CMD: 'a-launcher' };
  const given = await resolveLaunchCommand(composeExtraLaunchArgs({ launchArgs: '--window 800x450 --vanilla' }), env, 'linux');
  assert.equal(vanillaTookEffect(given), true);
  assert.deepEqual(given.args, ['--vanilla', '--window', '800x450'], 'the flag is the path\'s own spelling, not an argument passed along');

  assert.deepEqual(composeExtraLaunchArgs({ vanilla: true, launchArgs: '--vanilla' }), { vanilla: true, extraArgs: [] });
  assert.deepEqual(composeExtraLaunchArgs({ vanilla: true, launchArgs: '-x' }), { vanilla: true, extraArgs: ['-x'] });

  const forGame = await resolveLaunchCommand(composeExtraLaunchArgs({ launchArgs: '-- --vanilla' }), env, 'linux');
  assert.equal(vanillaTookEffect(forGame), false);
  assert.deepEqual(forGame.args, ['--', '--vanilla']);
});

test('a vanilla launch the command carries out reports the game started without mods', { timeout: 60000 }, async (t) => {
  await withNoRealGame(t, realGameUp, USER_GAME_UP, async () => {

    const marker = path.join(scratch, 'slow-launcher-ran');
    const script = path.join(scratch, 'slow-launcher.sh');
    await fs.writeFile(script, `sleep 0.2\n: > '${marker}'\nexit 0\n`);
    process.env.BROFORCE_LAUNCH_CMD = `sh ${script}`;
    if (process.platform === 'linux') userGameOnceLaunched(marker);
    t.after(async () => {
      process.env.BROFORCE_LAUNCH_CMD = NO_OP_LAUNCH_CMD;
      if (process.platform === 'linux') setProcReader(fakeProcReader({}));
      await fs.rm(marker, { force: true });
    });

    const response = await handleToolCall({ params: { name: 'launch_game', arguments: { vanilla: true } } });
    const payload = JSON.parse(textOf(response));

    assert.equal(payload.success, true, payload.message);
    assert.equal(payload.vanilla, true);
    assert.match(payload.message, /without mods/);
    assert.doesNotMatch(payload.message, /still running/);

    const ping = await handleToolCall({ params: { name: 'ping', arguments: {} } });
    assert.equal(ping.isError, true);
    assert.match(textOf(ping), /launched without mods/);
    const again = JSON.parse(textOf(await handleToolCall({ params: { name: 'launch_game', arguments: {} } })));
    assert.equal(again.alreadyRunning, true);
    assert.match(again.message, /launched without mods/);
    assert.doesNotMatch(again.message, /failed to load/);
  });
});

test('a vanilla launch whose command exits cleanly but leaves no game running is a failure', { timeout: 60000 }, async (t) => {
  await withNoRealGame(t, realGameUp, USER_GAME_UP, async () => {
    process.env.BROFORCE_LAUNCH_CMD = NO_OP_LAUNCH_CMD;

    const payload = JSON.parse(textOf(await handleToolCall({ params: { name: 'launch_game', arguments: { vanilla: true } } })));

    assert.equal(payload.success, false, payload.message);
    assert.equal(payload.state, 'no-process');
    assert.match(payload.message, /exited cleanly, but no Broforce process/);
  });
});

test('a cancelled vanilla launch stops waiting for the game to start at once', { timeout: 60000, skip: process.platform !== 'linux' }, async (t) => {
  await withNoRealGame(t, realGameUp, USER_GAME_UP, async () => {
    process.env.BROFORCE_LAUNCH_CMD = NO_OP_LAUNCH_CMD;
    configureLaunchTiming({ startConfirmMs: 15000 });
    t.after(() => configureLaunchTiming({ startConfirmMs: 600 }));

    const controller = new AbortController();
    const started = Date.now();
    const launching = handleToolCall({ params: { name: 'launch_game', arguments: { vanilla: true } } }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 300);
    const response = await launching;

    assert.equal(response.isError, true);
    assert.match(textOf(response), /launch_game was cancelled/);
    assert.ok(Date.now() - started < 5000, 'the start confirmation ran on after the cancellation');
  });
});

test('launchArgs carrying --vanilla is waited on as a vanilla launch, not polled for an inspector', { timeout: 60000 }, async (t) => {
  await withNoRealGame(t, realGameUp, USER_GAME_UP, async () => {
    const marker = path.join(scratch, 'args-vanilla-ran');
    const script = path.join(scratch, 'args-vanilla.sh');
    await fs.writeFile(script, `: > '${marker}'\nexit 0\n`);
    process.env.BROFORCE_LAUNCH_CMD = `sh ${script}`;
    if (process.platform === 'linux') userGameOnceLaunched(marker);
    t.after(async () => {
      process.env.BROFORCE_LAUNCH_CMD = NO_OP_LAUNCH_CMD;
      if (process.platform === 'linux') setProcReader(fakeProcReader({}));
      await fs.rm(marker, { force: true });
    });

    const started = Date.now();
    const payload = JSON.parse(textOf(await handleToolCall({ params: { name: 'launch_game', arguments: { launchArgs: '--vanilla' } } })));

    assert.equal(payload.success, true, payload.message);
    assert.equal(payload.vanilla, true);
    assert.ok(Date.now() - started < 10000, `polled for an inspector for ${Date.now() - started}ms`);
  });
});

test('a vanilla launch of the user\'s game reports its own budget', { timeout: 60000 }, async (t) => {
  await withNoRealGame(t, realGameUp, USER_GAME_UP, async () => {

    const marker = path.join(scratch, 'lingering-launcher-ran');
    const script = path.join(scratch, 'lingering-launcher.sh');
    await fs.writeFile(script, `: > '${marker}'\nsleep 1\nexit 0\n`);
    process.env.BROFORCE_LAUNCH_CMD = `sh ${script}`;
    if (process.platform === 'linux') userGameOnceLaunched(marker);
    // The instance budget belongs to the other target and must not be the one reported here
    configureLaunchTiming({ vanillaExitWaitMs: 200, instanceBudgetMs: 20000 });
    t.after(async () => {
      process.env.BROFORCE_LAUNCH_CMD = NO_OP_LAUNCH_CMD;
      configureLaunchTiming({ vanillaExitWaitMs: 45000, instanceBudgetMs: 180000 });
      if (process.platform === 'linux') setProcReader(fakeProcReader({}));
      await fs.rm(marker, { force: true });
    });

    const response = await handleToolCall({ params: { name: 'launch_game', arguments: { vanilla: true } } });
    const payload = JSON.parse(textOf(response));

    assert.equal(payload.success, true, payload.message);
    assert.match(payload.message, /still running after 0.2s and was left to finish/);
  });
});

test('the restart pre-flight tells a program from a path that only looks like one', async () => {
  assert.equal(await commandIsRunnable('sh'), true);
  assert.equal(await commandIsRunnable('/bin/sh'), true);
  assert.equal(await commandIsRunnable('definitely-not-on-this-path-xyz'), false);
  assert.equal(await commandIsRunnable(path.join(scratch, 'no-such-file')), false);

  // A directory answers X_OK on POSIX, and spawning one fails with EACCES
  assert.equal(await commandIsRunnable(scratch), false);

  // The first token of a quoted command carries its spaces through
  const spaced = path.join(scratch, 'my launchers');
  await fs.mkdir(spaced, { recursive: true });
  const script = path.join(spaced, 'launch.sh');
  await fs.writeFile(script, 'exit 0\n', { mode: 0o755 });
  assert.deepEqual(tokenizeCommand(`"${script}" --vanilla`), [script, '--vanilla']);
  assert.equal(await commandIsRunnable(script), true);

  await fs.chmod(script, 0o644);
  assert.equal(await commandIsRunnable(script), false, 'a file nobody may execute is not a program');

  // Windows has no execute bit and a bare name resolves through PATHEXT
  assert.equal(await commandIsRunnable('steam.exe', 'win32'), true);
  assert.equal(await commandIsRunnable('C:/nope/nothing.exe', 'win32'), false, 'a stale registry path');
  assert.equal(await commandIsRunnable(script, 'win32'), true);
  assert.equal(await commandIsRunnable(spaced, 'win32'), false, 'a folder');
});

test('a vanilla launch of the user\'s game appends launchArgs verbatim', { timeout: 60000 }, async (t) => {
  await withNoRealGame(t, realGameUp, USER_GAME_UP, async () => {

    const stub = path.join(scratch, 'game-launcher');
    await fs.writeFile(stub, '#!/bin/sh\nexit 5\n', { mode: 0o755 });
    process.env.BROFORCE_LAUNCH_CMD = stub;
    t.after(() => { process.env.BROFORCE_LAUNCH_CMD = NO_OP_LAUNCH_CMD; });

    const response = await handleToolCall({
      params: { name: 'launch_game', arguments: { vanilla: true, launchArgs: '-m' } },
    });
    const payload = JSON.parse(textOf(response));

    assert.equal(payload.launchCommand, `${stub} --vanilla -m`);
    assert.equal(payload.success, false, payload.message);
    assert.match(payload.message, /exited with status 5/);
    assert.equal(payload.note, undefined, 'nothing was changed, so there is nothing to note');
  });
});

const isLinux = process.platform === 'linux';

const userGameUp = () => setProcReader(fakeProcReader({
  800: { comm: LINUX_GAME_COMM, cwd: '/home/x/.local/share/broforce-linux', startTicks: 100 },
}));
const noGame = () => setProcReader(fakeProcReader({}));

function clearStubs() {
  setProcReader(null);
  setKillSignaller();
  process.env.BROFORCE_LAUNCH_CMD = NO_OP_LAUNCH_CMD;
  process.env.UNITY_INSPECTOR_PORT = NO_LISTENER_PORT;
  unityClient.disconnect();
  unityClient.pointAt({ port: Number(NO_LISTENER_PORT) });
}

const launch = (args) => handleToolCall({ params: { name: 'launch_game', arguments: args } });

const ERROR_OUTPUT = "\n\nLast lines of the launch command's error output:\n";
const REFUSAL = 'another launch (pid 4242) is launching the game; retry once it ends.';

async function refusingCommand(name, { status = 75 } = {}) {
  const script = path.join(scratch, `${name}.sh`);
  await fs.writeFile(script, `printf 'launch: preparing\\n' >&2\nprintf '%s\\n' '${REFUSAL}' >&2\nexit ${status}\n`);
  return `sh ${script}`;
}

const processGone = async (pid, withinMs) => {
  for (const until = Date.now() + withinMs; Date.now() < until; await new Promise((resolve) => setTimeout(resolve, 50))) {
    if (!existsSync(`/proc/${pid}`)) return true;
  }
  return !existsSync(`/proc/${pid}`);
};

test('a vanilla launch command that refuses is quoted back from its error output, its stdout never piped', { timeout: 30000, skip: !isLinux }, async (t) => {
  noGame();
  const command = await refusingCommand('refusing-vanilla');
  process.env.BROFORCE_LAUNCH_CMD = command;
  t.after(clearStubs);

  const payload = JSON.parse(textOf(await launch({ vanilla: true })));

  assert.equal(payload.success, false, payload.message);
  assert.equal(payload.state, 'launcher-failed', payload.message);
  assert.equal(payload.message, `\`${command} --vanilla\` failed: the launch command exited with status 75.${ERROR_OUTPUT}launch: preparing\n${REFUSAL}`);

  // stdout carries the MCP protocol, and stderr goes to the drain, never to this process
  const spawned = lastSpawnOptions();
  assert.equal(spawned.stdio[0], 'ignore');
  assert.equal(spawned.stdio[1], 'ignore');
  assert.notEqual(spawned.stdio[2], 'pipe');
  assert.equal(typeof spawned.drainPid, 'number');
  assert.deepEqual(await fifosLeft(), []);
});

test('a modded launch command that refuses ends the poll quoting its error output', { timeout: 30000, skip: !isLinux }, async (t) => {
  noGame();
  const command = await refusingCommand('refusing-modded');
  process.env.BROFORCE_LAUNCH_CMD = command;
  t.after(clearStubs);

  const started = Date.now();
  const payload = JSON.parse(textOf(await launch({})));

  assert.equal(payload.state, 'launcher-failed', payload.message);
  assert.ok(payload.message.startsWith(`\`${command}\` failed: The launcher exited with status 75 after `), payload.message);
  assert.ok(payload.message.endsWith(`${ERROR_OUTPUT}launch: preparing\n${REFUSAL}`), payload.message);
  assert.ok(Date.now() - started < 5000, 'the failure ended the poll');
});

test('a launch command\'s error output is quoted as it stood at its exit, never with what it left running wrote after', { timeout: 30000, skip: !isLinux }, async (t) => {
  noGame();
  const go = path.join(scratch, 'late-writer-go');
  const marker = path.join(scratch, 'late-writer-done');
  const script = path.join(scratch, 'leaves-a-writer.sh');
  await fs.writeFile(script, [
    `( i=0; while [ ! -e '${go}' ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done; printf 'child: written after the launch command exited\\n' >&2; : > '${marker}' ) &`,
    `printf 'launch: handed the game to the service\\n' >&2`,
    'exit 0',
  ].join('\n') + '\n');
  process.env.BROFORCE_LAUNCH_CMD = `sh ${script}`;
  shortLaunchWaits(t, { launchPollMs: 2500, launchCommandMs: 8000 });
  t.after(async () => {
    await fs.writeFile(go, '');
    clearStubs();
    await fs.rm(marker, { force: true });
    await fs.rm(go, { force: true });
  });

  setTimeout(() => fs.writeFile(go, ''), 1200);
  const payload = JSON.parse(textOf(await launch({})));

  assert.equal(payload.state, 'no-process', payload.message);
  assert.ok(existsSync(marker), 'the child had written its line before the reply');
  assert.ok(payload.message.endsWith(`— the launch command exited without leaving a game running.${ERROR_OUTPUT}launch: handed the game to the service`), payload.message);
  assert.match(await fs.readFile(launchOutputFile(), 'utf8'), /child: written after/, 'the drain was still reading for the child');
});

test('what a failed launch command leaves holding its stderr writes on after the server\'s process group is hung up', { timeout: 30000, skip: !isLinux }, async (t) => {
  const go = path.join(scratch, 'orphan-writer-go');
  const marker = path.join(scratch, 'orphan-writer-done');
  const replyFile = path.join(scratch, 'orphan-writer-reply.json');
  const script = path.join(scratch, 'orphans-a-writer.sh');
  await fs.writeFile(script, [
    `( i=0; while [ ! -e '${go}' ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done; sleep 1; printf 'child: still writing\\n' >&2; : > '${marker}' ) &`,
    `printf 'launch: %s\\n' '${REFUSAL}' >&2`,
    'exit 4',
  ].join('\n') + '\n');
  t.after(async () => {
    await fs.writeFile(go, '');
    for (const file of [marker, go, replyFile]) await fs.rm(file, { force: true });
  });

  // The server leads a process group of its own, as a client's session leads the one a hangup reaches
  const server = spawn(process.execPath, [new URL('./support/launch-and-exit.js', import.meta.url).pathname, `sh ${script}`, replyFile], { stdio: 'ignore', detached: true });
  const exited = new Promise((resolve) => server.once('exit', resolve));
  for (const until = Date.now() + 15000; !existsSync(replyFile) && Date.now() < until;) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(existsSync(replyFile), 'the server never answered');
  process.kill(-server.pid, 'SIGHUP');
  await exited;
  await fs.writeFile(go, '');

  const payload = JSON.parse(JSON.parse(await fs.readFile(replyFile, 'utf8')).content[0].text);
  assert.equal(payload.state, 'launcher-failed', payload.message);
  assert.ok(payload.message.endsWith(`exited with status 4.${ERROR_OUTPUT}launch: ${REFUSAL}`), payload.message);
  for (const until = Date.now() + 8000; !existsSync(marker) && Date.now() < until;) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(existsSync(marker), 'the child did not live through its write to stderr once the server\'s group was hung up');
});

const DRAIN_SCRIPT = new URL('../lib/stderr-drain.js', import.meta.url).pathname;
const slowDrain = (seconds) => ['sh', '-c', `sleep ${seconds}; exec '${process.execPath}' '${DRAIN_SCRIPT}' "$@"`, 'slow-drain'];
const GATED_DRAIN = new URL('./support/gated-drain.js', import.meta.url).pathname;
const gatedDrain = (marked) => [process.execPath, GATED_DRAIN, marked, LAUNCH_OUTPUT_MARK];
const PAST_THE_TEST_TIMEOUT_MS = 120000;
const STALLED_DRAIN_S = 25;
const holdUntil = (file) => `i=0; while [ ! -e '${file}' ] && [ $i -lt 1200 ]; do sleep 0.05; i=$((i+1)); done`;
const waitFor = (file) => `i=0; until [ -e '${file}' ] || [ $i -ge 3000 ]; do sleep 0.01; i=$((i+1)); done`;

function outputBound(t, ms) {
  configureLaunchTiming({ launchOutputMs: ms });
  t.after(() => configureLaunchTiming({ launchOutputMs: 2000 }));
}

async function leavesAWriter(name, lines) {
  const script = path.join(scratch, `${name}.sh`);
  await fs.writeFile(script, lines.join('\n') + '\n');
  process.env.BROFORCE_LAUNCH_CMD = `sh ${script}`;
  return `sh ${script}`;
}

test('the capture file exists, readable by the user alone, before the launch command runs, however slowly its drain starts', { timeout: 30000, skip: !isLinux }, async (t) => {
  noGame();
  setStderrDrainProgram(slowDrain(0.5));
  outputBound(t, PAST_THE_TEST_TIMEOUT_MS);
  const script = path.join(scratch, 'checks-its-capture.sh');
  await fs.writeFile(script, `stat -c 'capture mode %a' '${launchOutputFile()}' >&2 || echo 'capture missing' >&2\nexit 3\n`);
  process.env.BROFORCE_LAUNCH_CMD = `sh ${script}`;
  t.after(() => {
    setStderrDrainProgram();
    clearStubs();
  });

  const payload = JSON.parse(textOf(await launch({ vanilla: true })));

  assert.equal(payload.state, 'launcher-failed', payload.message);
  assert.ok(payload.message.endsWith(`${ERROR_OUTPUT}capture mode 600`), payload.message);
});

test('a drain slow to start reading still has the refusal quoted, an empty capture never counting as settled', { timeout: 30000, skip: !isLinux }, async (t) => {
  noGame();
  setStderrDrainProgram(slowDrain(0.6));
  outputBound(t, PAST_THE_TEST_TIMEOUT_MS);
  const command = await refusingCommand('slow-drain-refusal');
  process.env.BROFORCE_LAUNCH_CMD = command;
  t.after(() => {
    setStderrDrainProgram();
    clearStubs();
  });

  const payload = JSON.parse(textOf(await launch({ vanilla: true })));

  assert.equal(payload.message, `\`${command} --vanilla\` failed: the launch command exited with status 75.${ERROR_OUTPUT}launch: preparing\n${REFUSAL}`);
});

test('a cancel ends the wait for a slow drain\'s capture at once', { timeout: 30000, skip: !isLinux }, async (t) => {
  noGame();
  setStderrDrainProgram(slowDrain(STALLED_DRAIN_S));
  outputBound(t, PAST_THE_TEST_TIMEOUT_MS);
  process.env.BROFORCE_LAUNCH_CMD = await refusingCommand('cancelled-capture-wait');
  await fs.rm(launchOutputFile(), { force: true });
  t.after(() => {
    setStderrDrainProgram();
    clearStubs();
  });

  const controller = new AbortController();
  let aborted = false;
  const launching = handleToolCall({ params: { name: 'launch_game', arguments: { vanilla: true } } }, { signal: controller.signal });
  setTimeout(() => { aborted = true; controller.abort(); }, 300);
  const response = await launching;

  assert.equal(response.isError, true, textOf(response));
  assert.ok(aborted, 'the call answered before the cancel');
  const captured = await fs.stat(launchOutputFile()).then((stat) => stat.size, () => 0);
  assert.equal(captured, 0, 'the drain had read something, so the cancel was not what ended the wait');
  assert.deepEqual(await fifosLeft(), []);
});

test('a launch command the drain cannot be handed to still launches, with every stream closed', { timeout: 30000, skip: !isLinux }, async (t) => {
  noGame();
  setCommandSpawner((command, args, options) => {
    if (Array.isArray(options.stdio) && options.stdio[2] !== 'pipe') throw new Error('the stream could not be handed over');
    return spawn(command, args, options);
  });
  const command = await refusingCommand('no-hand-off');
  process.env.BROFORCE_LAUNCH_CMD = command;
  t.after(() => {
    setCommandSpawner();
    clearStubs();
  });

  const payload = JSON.parse(textOf(await launch({ vanilla: true })));

  assert.equal(payload.message, `\`${command} --vanilla\` failed: the launch command exited with status 75.`);
  assert.equal(lastSpawnOptions().stdio, 'ignore');
  assert.equal(lastSpawnOptions().drainPid, null);
  assert.deepEqual(await fifosLeft(), []);
});

test('a launch command flooding its stderr past the capture bound is not held up, and the capture keeps only the bound', { timeout: 30000, skip: !isLinux }, async (t) => {
  noGame();
  const release = path.join(scratch, 'flood-release');
  await leavesAWriter('flooding-launcher', [
    `( ${holdUntil(release)} ) &`,
    "yes 'progress: still preparing the launch' | head -c 1500000 >&2",
    "printf 'failed at the end\\n' >&2",
    'exit 2',
  ]);
  outputBound(t, PAST_THE_TEST_TIMEOUT_MS);
  t.after(async () => {
    await fs.writeFile(release, '');
    clearStubs();
  });

  const payload = JSON.parse(textOf(await launch({ vanilla: true })));

  assert.equal(payload.state, 'launcher-failed', payload.message);
  assert.match(payload.message, /exited with status 2\.\n\nLast lines of the launch command's error output \(only its first 1 MiB was kept\):\nprogress: still preparing the launch\n/);
  assert.equal((await fs.stat(launchOutputFile())).size, 1024 * 1024);
  await fs.writeFile(release, '');
  assert.ok(await processGone(lastSpawnOptions().drainPid, 20000), 'the drain read to the end');
});

test('a line what the launch command left running writes after its exit is not quoted, and the quote waits for neither that writer nor the bound', { timeout: 30000, skip: !isLinux }, async (t) => {
  noGame();
  const marked = path.join(scratch, 'late-line-marked');
  const release = path.join(scratch, 'late-line-release');
  setStderrDrainProgram(gatedDrain(marked));
  const command = await leavesAWriter('leaves-a-late-line', [
    `( ${waitFor(marked)}; printf 'child: steam startup line\\n' >&2; ${holdUntil(release)} ) &`,
    "printf 'launch: the refusal\\n' >&2",
    'exit 4',
  ]);
  outputBound(t, PAST_THE_TEST_TIMEOUT_MS);
  t.after(async () => {
    await fs.writeFile(release, '');
    setStderrDrainProgram();
    clearStubs();
  });

  const payload = JSON.parse(textOf(await launch({ vanilla: true })));

  assert.equal(payload.message, `\`${command} --vanilla\` failed: the launch command exited with status 4.${ERROR_OUTPUT}launch: the refusal`);
  assert.match(await fs.readFile(launchOutputFile(), 'utf8'), /child: steam startup line/, 'the writer\'s line was in the capture when the quote was taken');
});

test('a launch command leaving a writer that never stops still has its refusal quoted and none of the writer\'s lines, without waiting out the bound', { timeout: 30000, skip: !isLinux }, async (t) => {
  noGame();
  const marked = path.join(scratch, 'chatty-marked');
  const release = path.join(scratch, 'chatty-release');
  setStderrDrainProgram(gatedDrain(marked));
  const command = await leavesAWriter('leaves-a-chatty-writer', [
    `( ${waitFor(marked)}; i=0; while [ ! -e '${release}' ] && [ $i -lt 2000 ]; do printf 'child: noise %d\\n' $i >&2; sleep 0.03; i=$((i+1)); done ) &`,
    "printf 'launch: the refusal\\n' >&2",
    'exit 4',
  ]);
  outputBound(t, PAST_THE_TEST_TIMEOUT_MS);
  t.after(async () => {
    await fs.writeFile(release, '');
    setStderrDrainProgram();
    clearStubs();
  });

  const payload = JSON.parse(textOf(await launch({ vanilla: true })));

  assert.equal(payload.message, `\`${command} --vanilla\` failed: the launch command exited with status 4.${ERROR_OUTPUT}launch: the refusal`);
  assert.match(await fs.readFile(launchOutputFile(), 'utf8'), /child: noise 0/, 'the writer\'s lines were in the capture when the quote was taken');
});

test('a silent failing launch command leaving a silent writer holding its stderr is answered without waiting out the bound', { timeout: 30000, skip: !isLinux }, async (t) => {
  noGame();
  const release = path.join(scratch, 'silent-writer-release');
  const command = await leavesAWriter('leaves-a-silent-writer', [
    `( ${holdUntil(release)} ) &`,
    'exit 5',
  ]);
  outputBound(t, PAST_THE_TEST_TIMEOUT_MS);
  t.after(async () => {
    await fs.writeFile(release, '');
    clearStubs();
  });

  const payload = JSON.parse(textOf(await launch({ vanilla: true })));

  assert.equal(payload.message, `\`${command} --vanilla\` failed: the launch command exited with status 5.`);
});

test('a drain that reads nothing within the bound has the quote taken at the bound, from what the capture holds', { timeout: 30000, skip: !isLinux }, async (t) => {
  noGame();
  setStderrDrainProgram(slowDrain(STALLED_DRAIN_S));
  outputBound(t, 300);
  const command = await refusingCommand('stalled-drain');
  process.env.BROFORCE_LAUNCH_CMD = command;
  t.after(() => {
    setStderrDrainProgram();
    clearStubs();
  });

  const payload = JSON.parse(textOf(await launch({ vanilla: true })));

  assert.equal(payload.message, `\`${command} --vanilla\` failed: the launch command exited with status 75.`);
});

test('with nothing left holding its stderr, a launch command\'s drain ends with it', { timeout: 30000, skip: !isLinux }, async (t) => {
  noGame();
  process.env.BROFORCE_LAUNCH_CMD = await refusingCommand('drain-ends');
  t.after(clearStubs);

  const payload = JSON.parse(textOf(await launch({ vanilla: true })));
  const drainPid = lastSpawnOptions().drainPid;

  assert.equal(payload.state, 'launcher-failed', payload.message);
  assert.equal(typeof drainPid, 'number');
  assert.ok(await processGone(drainPid, 2000), `drain ${drainPid} outlived its launch command`);
});

test('a launch command that prints nothing is answered with no error output section', { timeout: 30000, skip: !isLinux }, async (t) => {
  noGame();
  const script = path.join(scratch, 'silent-failing-launcher.sh');
  await fs.writeFile(script, 'exit 7\n');
  process.env.BROFORCE_LAUNCH_CMD = `sh ${script}`;
  shortLaunchWaits(t, { launchPollMs: 400, launchCommandMs: 3000 });
  t.after(clearStubs);

  const failed = JSON.parse(textOf(await launch({ vanilla: true })));
  assert.equal(failed.message, `\`sh ${script} --vanilla\` failed: the launch command exited with status 7.`);

  process.env.BROFORCE_LAUNCH_CMD = NO_OP_LAUNCH_CMD;
  const gone = JSON.parse(textOf(await launch({ vanilla: false })));
  assert.equal(gone.state, 'no-process', gone.message);
  assert.match(gone.message, /^Ran `sh -c exit 0` but no Broforce process is running after [\d.]+s \(\d+ attempts\) — the launch command exited without leaving a game running\.$/);
});

test('a drain that cannot start leaves the launch going with every stream closed', { timeout: 30000, skip: !isLinux }, async (t) => {
  noGame();
  setStderrDrainProgram([path.join(scratch, 'no-such-drain')]);
  const command = await refusingCommand('no-drain');
  process.env.BROFORCE_LAUNCH_CMD = command;
  t.after(() => {
    setStderrDrainProgram();
    clearStubs();
  });

  const payload = JSON.parse(textOf(await launch({ vanilla: true })));

  assert.equal(payload.message, `\`${command} --vanilla\` failed: the launch command exited with status 75.`);
  assert.equal(lastSpawnOptions().stdio, 'ignore');
  assert.equal(lastSpawnOptions().drainPid, null);
  assert.deepEqual(await fifosLeft(), []);
});

async function fifosLeft() {
  const entries = await fs.readdir(path.dirname(launchOutputFile()), { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFIFO()).map((entry) => entry.name);
}

const writesBothWays = (status, marker = null) => [
  'set -e',
  "echo 'launch: via dev stderr' > /dev/stderr",
  "echo 'launch: via fd 2' >&2",
  ...(marker ? [`: > '${marker}'`] : []),
  `exit ${status}`,
];

test('a launch command writing to /dev/stderr and to fd 2 under set -e is answered with its own status and both lines', { timeout: 30000, skip: !isLinux }, async (t) => {
  noGame();
  const command = await leavesAWriter('writes-both-ways', writesBothWays(4));
  t.after(clearStubs);

  const payload = JSON.parse(textOf(await launch({ vanilla: true })));

  assert.equal(payload.message, `\`${command} --vanilla\` failed: the launch command exited with status 4.${ERROR_OUTPUT}launch: via dev stderr\nlaunch: via fd 2`);
});

test('a launch command writing to /dev/stderr and to fd 2 under set -e that exits 0 is not a failed launch', { timeout: 30000, skip: !isLinux }, async (t) => {
  noGame();
  const marker = path.join(scratch, 'writes-both-ways-ran');
  await leavesAWriter('writes-both-ways-cleanly', writesBothWays(0, marker));
  userGameOnceLaunched(marker);
  t.after(async () => {
    clearStubs();
    await fs.rm(marker, { force: true });
  });

  const payload = JSON.parse(textOf(await launch({ vanilla: true })));

  assert.equal(payload.success, true, payload.message);
  assert.match(payload.message, /without mods/);
});

test('a launch command\'s stderr is a pipe, write-only and blocking', { timeout: 30000, skip: !isLinux }, async (t) => {
  noGame();
  await leavesAWriter('checks-its-stderr', [
    "if [ -p /dev/fd/2 ]; then echo 'stderr: a pipe' >&2; else echo 'stderr: not a pipe' >&2; fi",
    "sed -n 's/^flags:[[:space:]]*/stderr flags: /p' /proc/$$/fdinfo/2 >&2",
    'exit 3',
  ]);
  t.after(clearStubs);

  const payload = JSON.parse(textOf(await launch({ vanilla: true })));

  const [, quote = ''] = payload.message.split(ERROR_OUTPUT);
  const [kind, flags] = quote.split('\n');
  assert.equal(kind, 'stderr: a pipe', payload.message);
  const bits = parseInt(flags?.replace('stderr flags: ', ''), 8);
  assert.equal(bits & 0o3, 0o1, `stderr is not write-only: ${flags}`);
  assert.equal(bits & 0o4000, 0, `stderr is non-blocking: ${flags}`);
});

test('with no mkfifo to make the stream, a launch command still launches with every stream closed', { timeout: 30000, skip: !isLinux }, async (t) => {
  noGame();
  const bin = path.join(scratch, 'bin-without-mkfifo');
  await fs.mkdir(bin, { recursive: true });
  const sh = execFileSync('sh', ['-c', 'command -v sh'], { encoding: 'utf8' }).trim();
  await fs.rm(path.join(bin, 'sh'), { force: true });
  await fs.symlink(sh, path.join(bin, 'sh'));
  const command = await refusingCommand('no-mkfifo');
  process.env.BROFORCE_LAUNCH_CMD = command;
  const pathBefore = process.env.PATH;
  process.env.PATH = bin;
  t.after(() => {
    process.env.PATH = pathBefore;
    clearStubs();
  });

  const payload = JSON.parse(textOf(await launch({ vanilla: true })));

  assert.equal(payload.message, `\`${command} --vanilla\` failed: the launch command exited with status 75.`);
  assert.equal(lastSpawnOptions().stdio, 'ignore');
  assert.equal(lastSpawnOptions().drainPid, null);
  assert.deepEqual(await fifosLeft(), []);
});

test('a marker cut by the capture bound is never quoted', { timeout: 30000, skip: !isLinux }, async (t) => {
  noGame();
  const command = await leavesAWriter('fills-to-the-bound', [
    "yes 'progress: preparing' | head -c 1048560 >&2",
    "printf 'done!\\n' >&2",
    'exit 2',
  ]);
  outputBound(t, PAST_THE_TEST_TIMEOUT_MS);
  t.after(clearStubs);

  const payload = JSON.parse(textOf(await launch({ vanilla: true })));

  assert.match(await fs.readFile(launchOutputFile(), 'utf8'), /done!\n\nunity-ins$/, 'the marker did not straddle the bound');
  assert.ok(payload.message.startsWith(`\`${command} --vanilla\` failed: the launch command exited with status 2.\n\nLast lines of the launch command's error output (only its first 1 MiB was kept):\nprogress: preparing\n`), payload.message);
  assert.ok(payload.message.endsWith('\nprogress: preparing\ndone!'), payload.message);
});

const FILLS_ITS_STDERR = new URL('./support/fills-its-stderr.js', import.meta.url).pathname;

test('a marker that finds the pipe full at the launch command\'s exit lands once the drain reads again, and what is written after it is not quoted', { timeout: 60000, skip: !isLinux }, async (t) => {
  noGame();
  const release = path.join(scratch, 'full-pipe-release');
  const marked = path.join(scratch, 'full-pipe-marked');
  const full = path.join(scratch, 'full-pipe-full');
  setStderrDrainProgram(['sh', '-c', `${waitFor(release)}; exec '${process.execPath}' '${GATED_DRAIN}' "$@"`, 'held-drain', marked, LAUNCH_OUTPUT_MARK]);
  setCommandSpawner((command, args, options) => {
    const child = spawn(command, args, options);
    // Runs before the server's own exit listener, so the drain reads again only after the marker's first write
    child.once('exit', () => fs.writeFile(release, ''));
    return child;
  });
  const command = await leavesAWriter('leaves-a-full-pipe', [
    `'${process.execPath}' '${FILLS_ITS_STDERR}' '${full}' '${marked}' &`,
    waitFor(full),
    "printf 'launch: the refusal\\n' >&2",
    'exit 4',
  ]);
  outputBound(t, PAST_THE_TEST_TIMEOUT_MS);
  t.after(async () => {
    await fs.writeFile(release, '');
    await fs.writeFile(marked, '');
    setCommandSpawner();
    setStderrDrainProgram();
    clearStubs();
  });

  const payload = JSON.parse(textOf(await launch({ vanilla: true })));

  assert.equal(payload.message, `\`${command} --vanilla\` failed: the launch command exited with status 4.${ERROR_OUTPUT}launch: the refusal`);
  const capture = await fs.readFile(launchOutputFile(), 'utf8');
  const markAt = capture.indexOf(`\n${LAUNCH_OUTPUT_MARK}`);
  assert.ok(markAt > capture.indexOf('launch: the refusal\n'), 'the marker is not in the capture after the refusal');
  assert.ok(capture.indexOf('child: written once the drain read again') > markAt, 'the later line was not in the capture after the marker when the quote was taken');
  assert.ok(await processGone(lastSpawnOptions().drainPid, 20000), 'the drain outlived every writer');
  assert.deepEqual(await fifosLeft(), []);
});

test('a game whose mod does not answer is reported, not launched over', { timeout: 30000, skip: !isLinux }, async (t) => {
  userGameUp();
  const marker = path.join(scratch, 'launched-over');
  const script = path.join(scratch, 'marking-launcher.sh');
  await fs.writeFile(script, `: > '${marker}'\nexit 0\n`);
  process.env.BROFORCE_LAUNCH_CMD = `sh ${script}`;
  t.after(clearStubs);

  const payload = JSON.parse(textOf(await launch({})));

  assert.equal(payload.success, false, payload.message);
  assert.equal(payload.alreadyRunning, true);
  assert.match(payload.message, /not responding on TCP/);
  assert.match(payload.message, /restart: true/);
  await assert.rejects(fs.access(marker), 'a second game was launched over the first');
});

test('a launch command that cannot be parsed is an error naming the setting', { timeout: 30000, skip: !isLinux }, async (t) => {
  noGame();
  process.env.BROFORCE_LAUNCH_CMD = '"unbalanced';
  t.after(clearStubs);

  const response = await launch({});
  assert.equal(response.isError, true, textOf(response));
  assert.match(textOf(response), /BROFORCE_LAUNCH_CMD should hold the command that starts Broforce/);

  process.env.BROFORCE_LAUNCH_CMD = '   ';
  const blank = await launch({});
  assert.equal(blank.isError, true, textOf(blank));
  assert.match(textOf(blank), /UNITY_INSPECTOR_TEST/);
  assert.doesNotMatch(textOf(blank), /\.\./, 'one sentence, one period');
});

test('launchArgs that are not a string or do not parse are refused before anything runs', { timeout: 30000, skip: !isLinux }, async (t) => {
  noGame();
  const marker = path.join(scratch, 'launched-with-bad-args');
  const script = path.join(scratch, 'marking-launcher-args.sh');
  await fs.writeFile(script, `: > '${marker}'\nexit 0\n`);
  process.env.BROFORCE_LAUNCH_CMD = `sh ${script}`;
  t.after(clearStubs);

  const unbalanced = await launch({ vanilla: true, launchArgs: '--title "Broforce' });
  assert.equal(unbalanced.isError, true, textOf(unbalanced));
  assert.match(textOf(unbalanced), /Invalid launchArgs/);

  const notString = await launch({ vanilla: true, launchArgs: ['-m'] });
  assert.equal(notString.isError, true, textOf(notString));
  assert.match(textOf(notString), /launch_game: launchArgs must be a string, got an array/);

  await assert.rejects(fs.access(marker), 'the launch ran with arguments it could not read');
});

test('a restart whose launch command cannot run stops nothing', { timeout: 30000, skip: !isLinux }, async (t) => {
  userGameUp();
  const signalled = [];
  setKillSignaller((pid, signal) => {
    signalled.push(`${signal} ${pid}`);
    return true;
  });
  const missing = path.join(scratch, 'no-such-launcher');
  process.env.BROFORCE_LAUNCH_CMD = missing;
  t.after(clearStubs);

  const response = await launch({ restart: true });

  assert.equal(response.isError, true, textOf(response));
  assert.match(textOf(response), /so nothing was stopped/);
  assert.match(textOf(response), /BROFORCE_LAUNCH_CMD/);
  assert.ok(textOf(response).includes(missing), textOf(response));
  assert.deepEqual(signalled, [], 'the running game was signalled before the relaunch was known to be possible');
});

async function restartThroughSteam(t, { env = {} } = {}) {
  userGameUp();
  const signalled = [];
  setKillSignaller((pid, signal) => {
    if (signal !== 0) signalled.push(`${signal} ${pid}`);
    return true;
  });
  const root = await fs.mkdtemp(path.join(scratch, 'steam-'));
  const marker = path.join(root, 'steam-ran');
  await fs.writeFile(path.join(root, 'steam.sh'), `#!/bin/sh\n: > '${marker}'\n`, { mode: 0o755 });
  const profile = path.join(root, 'profiles/Default');
  await fs.mkdir(path.join(profile, 'UMM/Core'), { recursive: true });
  await fs.writeFile(path.join(profile, 'UMM/Core/UnityModManager.dll'), '');
  const steamapps = path.join(root, 'steamapps');
  const gamePath = path.join(steamapps, 'common/Broforce');
  await fs.mkdir(gamePath, { recursive: true });
  const lookups = {
    onPath: async () => false,
    steamRoots: () => [root],
    findSteamGame: async () => ({ gamePath, protonPrefix: null, steamapps }),
    profilesRoot: () => path.dirname(profile),
  };
  setLaunchResolver((requested, _env, _platform, config) =>
    resolveLaunchCommand(requested, env, 'linux', config, lookups));
  t.after(() => {
    setLaunchResolver();
    clearStubs();
  });
  return { signalled, marker, profile, userReg: path.join(steamapps, 'compatdata/274190/pfx/user.reg') };
}
function userGameGone() {
  setProcReader(fakeProcReader({}));
}

test('a restart whose profile scripts cannot be made executable stops nothing', { timeout: 30000, skip: !isLinux }, async (t) => {
  const { signalled, marker, profile } = await restartThroughSteam(t, {});
  await fs.symlink(path.join(profile, 'gone'), path.join(profile, 'run_umm.sh'));

  const response = await launch({ restart: true });

  assert.equal(response.isError, true, textOf(response));
  assert.match(textOf(response), /Could not prepare the Steam launch/);
  assert.match(textOf(response), /nothing was stopped/);
  assert.deepEqual(signalled, [], 'the running game was signalled before the relaunch was known to be possible');
  assert.equal(existsSync(marker), false);
});

test('a restart whose Proton user.reg cannot be written stops nothing', { timeout: 30000, skip: !isLinux }, async (t) => {
  for (const unwritable of ['file', 'folder']) {
    const { signalled, marker, userReg } = await restartThroughSteam(t, { env: { BROFORCE_LAUNCH_TYPE: 'proton' } });
    await fs.mkdir(path.dirname(userReg), { recursive: true });
    await fs.writeFile(userReg, 'WINE REGISTRY Version 2\n');
    const locked = unwritable === 'file' ? userReg : path.dirname(userReg);
    const mode = (await fs.stat(locked)).mode & 0o777;
    await fs.chmod(locked, mode & 0o555);
    t.after(() => fs.chmod(locked, mode));

    const response = await launch({ restart: true });

    assert.equal(response.isError, true, textOf(response));
    assert.match(textOf(response), /nothing was stopped/);
    assert.deepEqual(signalled, [], unwritable);
    assert.equal(existsSync(marker), false, unwritable);
    await fs.chmod(locked, mode);
  }
});

test('a Proton user.reg write that fails once the restart stopped the game says the game was stopped', { timeout: 30000, skip: !isLinux }, async (t) => {
  const { signalled, marker, userReg } = await restartThroughSteam(t, { env: { BROFORCE_LAUNCH_TYPE: 'proton' } });
  await fs.mkdir(path.dirname(userReg), { recursive: true });
  await fs.writeFile(userReg, 'WINE REGISTRY Version 2\n');
  setKillSignaller((pid, signal) => {
    if (signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    signalled.push(`${signal} ${pid}`);
    userGameGone();
    rmSync(userReg);
    mkdirSync(userReg);
    return true;
  });

  const response = await launch({ restart: true });

  assert.equal(response.isError, true, textOf(response));
  assert.match(textOf(response), /Could not write the Proton override/);
  assert.match(textOf(response), /had already been stopped/);
  assert.ok(signalled.length > 0);
  assert.equal(existsSync(marker), false);
});

test('a launch command that cannot be spawned is a tool error naming it', { timeout: 30000, skip: !isLinux }, async (t) => {
  noGame();
  const missing = path.join(scratch, 'vanished-launcher');
  process.env.BROFORCE_LAUNCH_CMD = missing;
  t.after(clearStubs);

  const response = await launch({});

  assert.equal(response.isError, true, textOf(response));
  assert.match(textOf(response), /Failed to launch Broforce with `/);
  assert.ok(textOf(response).includes(missing), textOf(response));
  assert.match(textOf(response), /Set the BROFORCE_LAUNCH_CMD environment variable/);
});

test('a launch of the user\'s game is ready once its inspector answers', { timeout: 30000, skip: !isLinux }, async (t) => {
  noGame();
  let pings = 0;
  const game = await startStubServer((request, socket) => {
    if (++pings === 1) socket.destroy();
    else reply(socket, request.id, {});
  });
  process.env.UNITY_INSPECTOR_PORT = String(game.port);
  t.after(async () => {
    clearStubs();
    await game.close();
  });

  const payload = JSON.parse(textOf(await launch({})));

  assert.equal(payload.success, true, payload.message);
  assert.equal(payload.target, 'steam');
  assert.equal(payload.launchCommand, 'sh -c exit 0');
  assert.match(payload.message, /Game launched and ready \(1 attempts/);
  assert.equal(pings, 2);
  assert.equal(payload.instance, undefined, 'the user\'s game has no instance to name');
});

test('a restart never takes the old game, still answering as it shuts down, for the new one', { timeout: 30000, skip: !isLinux }, async (t) => {
  const processes = {
    800: { comm: LINUX_GAME_COMM, cwd: '/home/x/.local/share/broforce-linux', startTicks: 100 },
  };
  setProcReader(fakeProcReader(processes));
  const oldAlive = path.join(scratch, 'old-game-alive');
  await fs.writeFile(oldAlive, '');

  let termSent = false;
  let checksLeft = null;
  let seenDying = 0;
  const gone = () => {
    delete processes[800];
    rmSync(oldAlive, { force: true });
    const error = new Error('ESRCH');
    error.code = 'ESRCH';
    return error;
  };
  setKillSignaller((pid, signal) => {
    if (pid !== 800 || !processes[800]) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    if (signal === 'SIGTERM') {
      termSent = true;
      checksLeft = 3;
    } else if (signal === 'SIGKILL') {
      throw gone();
    } else if (signal === 0 && checksLeft !== null) {
      if (--checksLeft <= 0) throw gone();
      seenDying++;
    }
    return true;
  });

  const launched = path.join(scratch, 'restart-launched');
  const script = path.join(scratch, 'restart-launcher.sh');
  await fs.writeFile(script, `if [ -e '${oldAlive}' ]; then echo old-alive > '${launched}.tmp'; else echo old-gone > '${launched}.tmp'; fi\nmv '${launched}.tmp' '${launched}'\n`);
  process.env.BROFORCE_LAUNCH_CMD = `sh ${script}`;

  const answeredBy = [];
  const game = await startStubServer((request, socket) => {
    if (processes[800]) {
      answeredBy.push(termSent ? 'old after it was told to stop' : 'old');
      reply(socket, request.id, { game: 'old' });
    } else if (existsSync(launched)) {
      processes[801] ??= { comm: LINUX_GAME_COMM, cwd: '/home/x/.local/share/broforce-linux', startTicks: 200 };
      answeredBy.push('new');
      reply(socket, request.id, { game: 'new' });
    } else {
      socket.destroy();
    }
  });
  process.env.UNITY_INSPECTOR_PORT = String(game.port);
  t.after(async () => {
    clearStubs();
    rmSync(oldAlive, { force: true });
    await game.close();
  });

  const payload = JSON.parse(textOf(await launch({ restart: true })));

  assert.equal(payload.success, true, payload.message);
  assert.match(payload.message, /Game restarted and ready/);
  assert.ok(seenDying > 0, 'the old game was never seen alive after it was told to stop');
  assert.equal((await fs.readFile(launched, 'utf8')).trim(), 'old-gone', 'the launch ran while the old game was still there');
  assert.deepEqual(answeredBy.filter((by) => by !== 'old'), ['new'], answeredBy.join(', '));
});

test('a user\'s game slower to start than its 60s budget is reported as still starting, pointing at wait_for_game', { timeout: 30000, skip: !isLinux }, async (t) => {
  const launched = path.join(scratch, 'slow-game-launched');
  const script = path.join(scratch, 'slow-game-launcher.sh');
  await fs.writeFile(script, `: > '${launched}'\nexit 0\n`);
  process.env.BROFORCE_LAUNCH_CMD = `sh ${script}`;
  const up = fakeProcReader({ 800: { comm: LINUX_GAME_COMM, cwd: '/home/x/.local/share/broforce-linux', startTicks: 100 } });
  setProcReader({ ...up, pids: async () => (existsSync(launched) ? up.pids() : []) });
  t.after(clearStubs);

  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  let settled = false;
  const pending = launch({});
  pending.then(() => { settled = true; }, () => { settled = true; });
  while (!settled) {
    for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
    if (existsSync(launched)) t.mock.timers.tick(500);
  }
  const payload = JSON.parse(textOf(await pending));

  assert.equal(payload.success, false, payload.message);
  assert.equal(payload.state, 'connection-refused', payload.message);
  assert.ok(payload.attempts > 1, `${payload.attempts} attempts`);
  assert.match(
    payload.message,
    new RegExp(`^Game launched with \`sh ${script}\` but never answered — The game process is running but nothing accepted a connection on port ${NO_LISTENER_PORT} after 6\\d(\\.\\d)?s`),
  );
  assert.match(payload.message, /\. It may still be starting: call wait_for_game to keep waiting for it\.$/);
});

async function heldLauncher(t, name, { exitCode = 0, marks = null } = {}) {
  const released = path.join(scratch, `${name}-released`);
  const script = path.join(scratch, `${name}.sh`);
  await fs.writeFile(script, `${marks ? `: > '${marks}'\n` : ''}i=0\nwhile [ ! -e '${released}' ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done\nexit ${exitCode}\n`);
  const release = () => fs.writeFile(released, '');
  t.after(async () => {
    await release();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await fs.rm(released, { force: true });
  });
  return { command: `sh ${script}`, release };
}

function gameAppearsWith(marker) {
  setProcReader(conditionalProcReader({}, {
    when: () => fs.access(marker).then(() => true, () => false),
    extra: { 802: { comm: LINUX_GAME_COMM, cwd: '/home/x/.local/share/broforce-linux', startTicks: 300 } },
  }));
}

function shortLaunchWaits(t, timing) {
  configureLaunchTiming(timing);
  t.after(() => configureLaunchTiming({ launchPollMs: 60000, launchCommandMs: 600000, vanillaExitWaitMs: 45000 }));
}

const secondsIn = (message, pattern) => Number(message.match(pattern)?.[1]);

test('a launch whose command is still running with no game keeps waiting, and takes the game that comes up late', { timeout: 15000, skip: !isLinux }, async (t) => {
  const marker = path.join(scratch, 'late-game-up');
  const held = await heldLauncher(t, 'late-game-launcher');
  process.env.BROFORCE_LAUNCH_CMD = held.command;
  gameAppearsWith(marker);
  const game = await startStubServer((request, socket) => reply(socket, request.id, {}), {
    hello: () => (existsSync(marker) ? 'accept' : 'close'),
  });
  process.env.UNITY_INSPECTOR_PORT = String(game.port);
  shortLaunchWaits(t, { launchPollMs: 400, launchCommandMs: 3000 });
  t.after(async () => {
    clearStubs();
    await game.close();
    await fs.rm(marker, { force: true });
  });

  const started = Date.now();
  setTimeout(() => fs.writeFile(marker, ''), 1200);
  const payload = JSON.parse(textOf(await launch({})));

  assert.equal(payload.success, true, payload.message);
  assert.match(payload.message, /Game launched and ready/);
  assert.ok(Date.now() - started >= 1100, `answered after ${Date.now() - started}ms, before the game came up`);
});

test('a launch command still running with no game at the ceiling is left running, pointing at wait_for_game', { timeout: 15000, skip: !isLinux }, async (t) => {
  const held = await heldLauncher(t, 'stuck-launcher');
  process.env.BROFORCE_LAUNCH_CMD = held.command;
  noGame();
  shortLaunchWaits(t, { launchPollMs: 400, launchCommandMs: 3000 });
  t.after(clearStubs);

  const started = Date.now();
  const payload = JSON.parse(textOf(await launch({})));
  const waited = Date.now() - started;

  assert.equal(payload.success, false, payload.message);
  assert.equal(payload.state, 'no-process', payload.message);
  assert.match(payload.message, /still running after 3(\.\d)?s/);
  assert.match(payload.message, /and no Broforce process is running\. It was left running/);
  assert.match(payload.message, /left running/);
  assert.match(payload.message, /wait_for_game/);
  assert.doesNotMatch(payload.message, /exited without leaving a game running/);
  assert.ok(waited >= 2900 && waited < 4500, `waited ${waited}ms`);
});

test('a launch command that exits at once with no game is no-process after the plain budget', { timeout: 15000, skip: !isLinux }, async (t) => {
  noGame();
  shortLaunchWaits(t, { launchPollMs: 400, launchCommandMs: 3000 });
  t.after(clearStubs);

  const started = Date.now();
  const payload = JSON.parse(textOf(await launch({})));
  const waited = Date.now() - started;

  assert.equal(payload.success, false, payload.message);
  assert.equal(payload.state, 'no-process', payload.message);
  assert.match(payload.message, /— the launch command exited without leaving a game running\./);
  assert.ok(waited < 2000, `waited ${waited}ms`);
});

test('a launch command that exits cleanly after the plain budget, with no game, is no-process worded as exited, between its exit and the ceiling', { timeout: 15000, skip: !isLinux }, async (t) => {
  const held = await heldLauncher(t, 'late-exit-launcher');
  process.env.BROFORCE_LAUNCH_CMD = held.command;
  noGame();
  shortLaunchWaits(t, { launchPollMs: 400, launchCommandMs: 3000 });
  t.after(clearStubs);

  const started = Date.now();
  setTimeout(held.release, 1200);
  const payload = JSON.parse(textOf(await launch({})));
  const waited = Date.now() - started;

  assert.equal(payload.success, false, payload.message);
  assert.equal(payload.state, 'no-process', payload.message);
  assert.match(payload.message, /— the launch command exited without leaving a game running\./);
  assert.ok(waited >= 1200 && waited < 2600, `waited ${waited}ms`);
});

test('a poll on a launch command that exits cleanly after the plain budget gives the game the plain budget from its exit', { timeout: 15000, skip: !isLinux }, async (t) => {
  noGame();
  t.after(clearStubs);
  const child = spawn('sh', ['-c', 'sleep 1.2'], { stdio: 'ignore' });
  const watcher = launcherExitWatcher(child);
  let exitedAt = null;
  const started = Date.now();
  watcher.exit.then(() => { exitedAt = Date.now() - started; });

  const poll = await pollUntilResponsive(1000, 250, watcher, {
    pendingLaunch: { isPending: () => launchPending(watcher, userGame()), ceilingMs: 4000 },
  });
  const waited = Date.now() - started;

  assert.equal(poll.state, 'no-process', poll.message);
  assert.ok(exitedAt !== null && exitedAt >= 1100, `the command exited at ${exitedAt}ms`);
  assert.ok(waited >= exitedAt + 650, `the wait ended ${waited - exitedAt}ms after the command exited`);
  assert.ok(waited < 3000, `waited ${waited}ms, toward the ceiling`);
});

test('a launch command that fails after the plain budget ends the wait at once as launcher-failed', { timeout: 15000, skip: !isLinux }, async (t) => {
  const held = await heldLauncher(t, 'late-failing-launcher', { exitCode: 3 });
  process.env.BROFORCE_LAUNCH_CMD = held.command;
  noGame();
  shortLaunchWaits(t, { launchPollMs: 2000, launchCommandMs: 8000 });
  t.after(clearStubs);

  const started = Date.now();
  setTimeout(held.release, 2500);
  const payload = JSON.parse(textOf(await launch({})));
  const waited = Date.now() - started;

  assert.equal(payload.success, false, payload.message);
  assert.equal(payload.state, 'launcher-failed', payload.message);
  assert.match(payload.message, /exited with status 3/);
  assert.ok(waited >= 2450 && waited < 3200, `waited ${waited}ms`);
});

test('a launch whose game came up and died while its command keeps running is not pending again', { timeout: 15000, skip: !isLinux }, async (t) => {
  const marker = path.join(scratch, 'short-lived-game-up');
  gameAppearsWith(marker);
  const child = spawn('sh', ['-c', 'sleep 10'], { stdio: 'ignore' });
  t.after(async () => {
    child.kill();
    clearStubs();
    await fs.rm(marker, { force: true });
  });
  const watcher = launcherExitWatcher(child);

  const started = Date.now();
  setTimeout(() => fs.writeFile(marker, ''), 600);
  setTimeout(() => fs.rm(marker, { force: true }), 1100);
  const poll = await pollUntilResponsive(1000, 250, watcher, {
    pendingLaunch: { isPending: () => launchPending(watcher, userGame()), ceilingMs: 4000 },
  });
  const waited = Date.now() - started;

  assert.equal(poll.success, false, poll.message);
  assert.equal(watcher.gameSeen, true, 'the game was never seen');
  assert.equal(watcher.exited, null, 'the command was still running');
  assert.ok(waited >= 1000 && waited < 2400, `waited ${waited}ms`);
});

test('a launch cancelled while its command is still running with no game stops waiting at once', { timeout: 15000, skip: !isLinux }, async (t) => {
  const held = await heldLauncher(t, 'cancelled-launcher');
  process.env.BROFORCE_LAUNCH_CMD = held.command;
  noGame();
  shortLaunchWaits(t, { launchPollMs: 2000, launchCommandMs: 8000 });
  t.after(clearStubs);

  const controller = new AbortController();
  let abortedAt = null;
  const launching = handleToolCall({ params: { name: 'launch_game', arguments: {} } }, { signal: controller.signal });
  setTimeout(() => { abortedAt = Date.now(); controller.abort(); }, 2500);
  const response = await launching;
  const late = Date.now() - abortedAt;

  assert.equal(response.isError, true, textOf(response));
  assert.match(textOf(response), /was cancelled/);
  assert.ok(late < 500, `answered ${late}ms after the cancel`);
});

test('a vanilla launch cancelled while its command is still running with no game stops waiting at once', { timeout: 15000, skip: !isLinux }, async (t) => {
  const held = await heldLauncher(t, 'cancelled-vanilla-launcher');
  process.env.BROFORCE_LAUNCH_CMD = held.command;
  noGame();
  shortLaunchWaits(t, { vanillaExitWaitMs: 200, launchCommandMs: 5000 });
  t.after(clearStubs);

  const controller = new AbortController();
  const started = Date.now();
  const launching = handleToolCall({ params: { name: 'launch_game', arguments: { vanilla: true } } }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 600);
  const response = await launching;

  assert.equal(response.isError, true, textOf(response));
  assert.match(textOf(response), /launch_game was cancelled/);
  assert.ok(Date.now() - started < 1500, `answered after ${Date.now() - started}ms`);
});

test('a launch command that keeps running beside its game gets no wait beyond the plain budget', { timeout: 15000, skip: !isLinux }, async (t) => {
  const marker = path.join(scratch, 'foreground-game-up');
  const held = await heldLauncher(t, 'foreground-launcher', { marks: marker });
  process.env.BROFORCE_LAUNCH_CMD = held.command;
  gameAppearsWith(marker);
  shortLaunchWaits(t, { launchPollMs: 400, launchCommandMs: 3000 });
  t.after(async () => {
    clearStubs();
    await fs.rm(marker, { force: true });
  });

  const started = Date.now();
  const payload = JSON.parse(textOf(await launch({})));
  const waited = Date.now() - started;

  assert.equal(payload.success, false, payload.message);
  assert.equal(payload.state, 'connection-refused', payload.message);
  assert.match(payload.message, /It may still be starting: call wait_for_game to keep waiting for it\./);
  assert.ok(waited < 1500, `waited ${waited}ms`);
});

test('a vanilla launch whose command is still running with no game keeps waiting for the game it starts late', { timeout: 15000, skip: !isLinux }, async (t) => {
  const marker = path.join(scratch, 'late-vanilla-game-up');
  const held = await heldLauncher(t, 'late-vanilla-launcher');
  process.env.BROFORCE_LAUNCH_CMD = held.command;
  gameAppearsWith(marker);
  shortLaunchWaits(t, { vanillaExitWaitMs: 200, launchCommandMs: 3000 });
  t.after(async () => {
    clearStubs();
    await fs.rm(marker, { force: true });
  });

  setTimeout(() => fs.writeFile(marker, ''), 1200);
  const payload = JSON.parse(textOf(await launch({ vanilla: true })));

  assert.equal(payload.success, true, payload.message);
  assert.equal(payload.vanilla, true);
  const waited = secondsIn(payload.message, /still running after ([\d.]+)s and was left to finish/);
  assert.ok(waited >= 0.8 && waited < 2, payload.message);
});

test('a vanilla launch whose command is still running with no game at the ceiling says how long it ran', { timeout: 15000, skip: !isLinux }, async (t) => {
  const held = await heldLauncher(t, 'stuck-vanilla-launcher');
  process.env.BROFORCE_LAUNCH_CMD = held.command;
  noGame();
  shortLaunchWaits(t, { vanillaExitWaitMs: 200, launchCommandMs: 1500 });
  t.after(clearStubs);

  const payload = JSON.parse(textOf(await launch({ vanilla: true })));

  assert.equal(payload.success, false, payload.message);
  assert.equal(payload.state, 'no-process', payload.message);
  const waited = secondsIn(payload.message, /still running after ([\d.]+)s and was left to finish/);
  assert.ok(waited >= 1.4 && waited < 2.2, payload.message);
});

test('a poll with no game process ends no-process', { timeout: 30000, skip: !isLinux }, async (t) => {
  noGame();
  t.after(clearStubs);

  const poll = await pollUntilResponsive(300, 100);

  assert.equal(poll.success, false);
  assert.equal(poll.state, 'no-process', poll.message);
  assert.match(poll.message, /No Broforce process is running/);
});

test('a poll with the game up and nothing listening ends connection-refused', { timeout: 30000, skip: !isLinux }, async (t) => {
  userGameUp();
  t.after(clearStubs);

  const poll = await pollUntilResponsive(300, 100);

  assert.equal(poll.success, false);
  assert.equal(poll.state, 'connection-refused', poll.message);
  assert.match(poll.message, new RegExp(`nothing accepted a connection on port ${NO_LISTENER_PORT}`));
});

test('a poll whose port never answers ends connected-unresponsive', { timeout: 30000, skip: !isLinux }, async (t) => {
  userGameUp();
  const silent = await startStubServer(() => {});
  process.env.UNITY_INSPECTOR_PORT = String(silent.port);
  t.after(async () => {
    clearStubs();
    await silent.close();
  });

  const poll = await pollUntilResponsive(500, 100);

  assert.equal(poll.success, false);
  assert.equal(poll.state, 'connected-unresponsive', poll.message);
  assert.match(poll.message, new RegExp(`Port ${silent.port} accepts connections but ping got no reply`));
});

test('a launch that cannot see processes and gets no answer from the inspector starts nothing', { timeout: 30000, skip: !isLinux }, async (t) => {
  setProcReader({ ...fakeProcReader({}), async pids() { throw new Error('EACCES'); } });
  const marker = path.join(scratch, 'launched-blind');
  const script = path.join(scratch, 'blind-launcher.sh');
  await fs.writeFile(script, `: > '${marker}'\nexit 0\n`);
  process.env.BROFORCE_LAUNCH_CMD = `sh ${script}`;
  t.after(() => {
    clearStubs();
    setProcReader(fakeProcReader({}));
  });

  for (const args of [{}, { restart: true }, { vanilla: true }]) {
    const payload = JSON.parse(textOf(await launch(args)));
    assert.equal(payload.success, false, payload.message);
    assert.equal(payload.state, 'unknown');
    assert.match(payload.message, /process detection is unavailable/);
  }
  await assert.rejects(fs.access(marker), 'a launch ran with no way to tell whether the game was already up');
});

test('a launch of the user\'s game from WSL starts nothing', { timeout: 30000, skip: !isLinux }, async (t) => {
  noGame();
  setWslProbe(() => true);
  const marker = path.join(scratch, 'launched-wsl');
  const script = path.join(scratch, 'wsl-launcher.sh');
  await fs.writeFile(script, `: > '${marker}'\nexit 0\n`);
  process.env.BROFORCE_LAUNCH_CMD = `sh ${script}`;
  t.after(() => {
    setWslProbe(NOT_WSL);
    clearStubs();
  });

  for (const args of [{}, { restart: true }, { vanilla: true }]) {
    const response = await launch(args);
    assert.equal(response.isError, true);
    assert.match(textOf(response), /cannot reach the user's game from WSL/);
  }
  await assert.rejects(fs.access(marker), 'a launch ran beside a game on Windows this server cannot see');
});

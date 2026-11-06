import { NOT_WSL, NO_LISTENER_PORT, NO_OP_LAUNCH_CMD } from './support/session.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import { existsSync, mkdirSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

import { conditionalProcReader, fakeProcReader } from './support/fake-proc.js';
import { startStubServer, reply } from './support/stub-server.js';
import { withNoRealGame } from './support/real-game.js';

const { commandIsRunnable, configureLaunchTiming, handleToolCall, pollUntilResponsive, setLaunchResolver, unityClient, vanillaTookEffect } = await import('../index.js');
const { LINUX_GAME_COMM, composeExtraLaunchArgs, isGameRunning, lastSpawnOptions, resolveLaunchCommand, setKillSignaller, setProcReader, setWslProbe } = await import('../lib/game-process.js');
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

test('a launcher for the user\'s game is never quoted back from its stderr', { timeout: 60000 }, async (t) => {
  await withNoRealGame(t, realGameUp, USER_GAME_UP, async () => {

    // The Steam client and the game itself would inherit a pipe, so only an instance launcher's is read
    const script = path.join(scratch, 'noisy-launcher.sh');
    await fs.writeFile(script, "printf 'launcher: could not reach Steam\\n' >&2\nexit 9\n");
    process.env.BROFORCE_LAUNCH_CMD = `sh ${script}`;
    t.after(() => { process.env.BROFORCE_LAUNCH_CMD = NO_OP_LAUNCH_CMD; });

    const response = await handleToolCall({ params: { name: 'launch_game', arguments: { vanilla: true } } });
    const payload = JSON.parse(textOf(response));

    assert.equal(payload.success, false, payload.message);
    assert.match(payload.message, /exited with status 9/);
    assert.doesNotMatch(payload.message, /error output/);
    assert.doesNotMatch(payload.message, /could not reach Steam/);

    // Nothing is piped from the user's launcher: the Steam client and the game inherit its handles
    assert.equal(lastSpawnOptions().stdio, 'ignore');

    // And even a captured stream would not be quoted back for a game that is not an instance
    const { launchFailureTail, userGame } = await import('../index.js');
    assert.equal(await launchFailureTail(userGame(), { text: 'launcher: could not reach Steam' }), '');
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

test('a launch of the user\'s game on another host, with nothing answering, starts nothing', { timeout: 30000, skip: !isLinux }, async (t) => {
  noGame();
  process.env.UNITY_INSPECTOR_HOST = '192.0.2.1';
  const connectTimeoutMs = unityClient.connectTimeoutMs;
  unityClient.connectTimeoutMs = 300;
  const marker = path.join(scratch, 'launched-remote');
  const script = path.join(scratch, 'remote-launcher.sh');
  await fs.writeFile(script, `: > '${marker}'\nexit 0\n`);
  process.env.BROFORCE_LAUNCH_CMD = `sh ${script}`;
  t.after(() => {
    delete process.env.UNITY_INSPECTOR_HOST;
    unityClient.connectTimeoutMs = connectTimeoutMs;
    clearStubs();
  });

  for (const args of [{}, { restart: true }, { vanilla: true }]) {
    const payload = JSON.parse(textOf(await launch(args)));
    assert.equal(payload.success, false, payload.message);
    assert.equal(payload.state, 'unknown');
    assert.match(payload.message, /runs on 192\.0\.2\.1 \(UNITY_INSPECTOR_HOST\)/);
  }
  await assert.rejects(fs.access(marker), 'a launch ran beside a game whose host this server cannot see');
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

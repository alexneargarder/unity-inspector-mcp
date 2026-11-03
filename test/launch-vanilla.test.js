import { NO_OP_LAUNCH_CMD } from './support/session.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const { commandIsRunnable, configureLaunchTiming, handleToolCall, vanillaTookEffect } = await import('../index.js');
const { isGameRunning, lastSpawnOptions, resolveLaunchCommand, setProcReader } = await import('../lib/game-process.js');
const { fakeProcReader } = await import('./support/fake-proc.js');
const { tokenizeCommand } = await import('../lib/command-line.js');

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'vanilla-'));
test.after(() => fs.rm(scratch, { recursive: true, force: true }));

if (process.platform === 'linux') {
  setProcReader(fakeProcReader({}));
  test.after(() => setProcReader(null));
}

function textOf(response) {
  return response.content.map((c) => c.text).join('\n');
}

test('a vanilla launch that the launch command refuses is not reported as started', { timeout: 60000 }, async (t) => {
  if ((await isGameRunning()) !== false) {
    t.skip('a Broforce process is running, so launch_game would report it instead of launching');
    return;
  }

  const script = path.join(scratch, 'refusing-launcher.sh');
  await fs.writeFile(script, 'exit 7\n');
  process.env.BROFORCE_LAUNCH_CMD = `sh ${script}`;
  t.after(() => { process.env.BROFORCE_LAUNCH_CMD = NO_OP_LAUNCH_CMD; });

  const response = await handleToolCall({ params: { name: 'launch_game', arguments: { vanilla: true } } });
  const payload = JSON.parse(textOf(response));

  assert.equal(payload.success, false, payload.message);
  assert.match(payload.message, /exited with status 7/);
});

test('the Steam protocol launch is refused rather than run under the tests', { timeout: 60000 }, async (t) => {
  if ((await isGameRunning()) !== false) {
    t.skip('a Broforce process is running, so launch_game would report it instead of launching');
    return;
  }

  // With no command configured this is the Steam protocol launch, which would start the real game
  delete process.env.BROFORCE_LAUNCH_CMD;
  t.after(() => { process.env.BROFORCE_LAUNCH_CMD = NO_OP_LAUNCH_CMD; });

  const response = await handleToolCall({ params: { name: 'launch_game', arguments: { steam: true, vanilla: true } } });

  assert.equal(response.isError, true, textOf(response));
  assert.match(textOf(response), /UNITY_INSPECTOR_TEST/);
  assert.match(textOf(response), /BROFORCE_LAUNCH_CMD/);
});

test('a launch that dropped --vanilla is never reported as a vanilla launch', () => {
  const custom = resolveLaunchCommand(['--vanilla'], { BROFORCE_LAUNCH_CMD: 'a-launcher' }, 'linux');
  assert.equal(vanillaTookEffect(custom, { vanilla: true }), true);

  // The Steam protocol launch takes no arguments, so the game comes up modded
  const steam = resolveLaunchCommand(['--vanilla'], {}, 'linux');
  assert.deepEqual(steam.ignoredArgs, ['--vanilla']);
  assert.equal(vanillaTookEffect(steam, { vanilla: true }), false);

  assert.equal(vanillaTookEffect(custom, {}), false);
});

test('a vanilla launch the command carries out reports the game started without mods', { timeout: 60000 }, async (t) => {
  if ((await isGameRunning()) !== false) {
    t.skip('a Broforce process is running, so launch_game would report it instead of launching');
    return;
  }

  const script = path.join(scratch, 'slow-launcher.sh');
  await fs.writeFile(script, 'sleep 0.2\nexit 0\n');
  process.env.BROFORCE_LAUNCH_CMD = `sh ${script}`;
  t.after(() => { process.env.BROFORCE_LAUNCH_CMD = NO_OP_LAUNCH_CMD; });

  const response = await handleToolCall({ params: { name: 'launch_game', arguments: { vanilla: true } } });
  const payload = JSON.parse(textOf(response));

  assert.equal(payload.success, true, payload.message);
  assert.equal(payload.vanilla, true);
  assert.match(payload.message, /without mods/);
  assert.doesNotMatch(payload.message, /still running/);
});

test('a launcher for the user\'s game is never quoted back from its stderr', { timeout: 60000 }, async (t) => {
  if ((await isGameRunning()) !== false) {
    t.skip('a Broforce process is running, so launch_game would report it instead of launching');
    return;
  }

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

test('a vanilla launch of the user\'s game reports its own budget', { timeout: 60000 }, async (t) => {
  if ((await isGameRunning()) !== false) {
    t.skip('a Broforce process is running, so launch_game would report it instead of launching');
    return;
  }

  const script = path.join(scratch, 'lingering-launcher.sh');
  await fs.writeFile(script, 'sleep 1\nexit 0\n');
  process.env.BROFORCE_LAUNCH_CMD = `sh ${script}`;
  // The instance budget belongs to the other target and must not be the one reported here
  configureLaunchTiming({ vanillaExitWaitMs: 200, instanceBudgetMs: 20000 });
  t.after(() => {
    process.env.BROFORCE_LAUNCH_CMD = NO_OP_LAUNCH_CMD;
    configureLaunchTiming({ vanillaExitWaitMs: 45000, instanceBudgetMs: 180000 });
  });

  const response = await handleToolCall({ params: { name: 'launch_game', arguments: { vanilla: true } } });
  const payload = JSON.parse(textOf(response));

  assert.equal(payload.success, true, payload.message);
  assert.match(payload.message, /still running after 0.2s and was left to finish/);
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

  // Windows has no execute bit, so the pre-flight defers to the spawn itself
  assert.equal(await commandIsRunnable('C:/nope/nothing.exe', 'win32'), true);
});

test('a vanilla launch of the user\'s game appends launchArgs verbatim', { timeout: 60000 }, async (t) => {
  if ((await isGameRunning()) !== false) {
    t.skip('a Broforce process is running, so launch_game would report it instead of launching');
    return;
  }

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

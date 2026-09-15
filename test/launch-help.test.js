import './support/session.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { writeStubLauncher } from './support/stub-launcher.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'launch-help-'));
const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'launch-help-bin-'));
const launcher = await writeStubLauncher(binDir, root);

const { buildToolList, resetLaunchHelpCapture, sessionInstance } = await import('../index.js');
const { probeInstanceMode, resetInstanceModeProbe } = await import('../lib/game-process.js');

test.after(() => fs.rm(root, { recursive: true, force: true }));
test.after(() => fs.rm(binDir, { recursive: true, force: true }));

const callsLog = path.join(root, 'calls.log');
const control = (name, contents) => fs.writeFile(path.join(root, name), contents);
const clearControl = (name) => fs.rm(path.join(root, name), { force: true });

async function launcherCalls() {
  try {
    return (await fs.readFile(callsLog, 'utf8')).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

async function launchDescription() {
  const tools = await buildToolList();
  const tool = tools.find((t) => t.name === 'launch_game');
  assert.ok(tool, 'no launch_game tool in the tool list');
  return tool.description;
}

beforeEach(async () => {
  resetLaunchHelpCapture();
  resetInstanceModeProbe();
  await fs.rm(callsLog, { force: true });
  for (const name of ['no-args-help', 'long-args-help']) await clearControl(name);
  delete process.env.BROFORCE_LAUNCH_CMD;
  delete process.env.BROFORCE_INSTANCE_CMD;
  delete process.env.CLAUDE_SESSION_ID;
});

test('a launch command that publishes argument help is quoted verbatim', async () => {
  process.env.BROFORCE_LAUNCH_CMD = launcher;

  const description = await launchDescription();

  assert.match(description, /Arguments the configured launch command accepts, in its own words:/);
  assert.match(description, /```\nstub launch arguments:\n {2}--window WxH {3}the size of the window it opens\n```/);
  assert.deepEqual(await launcherCalls(), ['--help', '--args-help']);
});

test('a launch command whose help does not list the flag is never asked for it', async () => {
  await control('no-args-help', '1');
  process.env.BROFORCE_LAUNCH_CMD = launcher;

  const description = await launchDescription();

  assert.match(description, /publishes no argument help/);
  assert.match(description, /launchArgs pass through to it as given/);
  assert.doesNotMatch(description, /in its own words/);
  // Handing an unknown flag by name to an unknown launcher could launch the game instead
  assert.deepEqual(await launcherCalls(), ['--help'], 'the launcher was asked something it never offered');
});

test('with no launch command the description says arguments are not accepted', async () => {
  const description = await launchDescription();

  assert.match(description, /The Steam protocol launch takes no arguments, so launchArgs are not accepted\./);
  assert.deepEqual(await launcherCalls(), [], 'nothing should have been run');
});

test('argument help longer than the cap is cut, and says so', async () => {
  await control('long-args-help', '1');
  process.env.BROFORCE_LAUNCH_CMD = launcher;

  const description = await launchDescription();

  assert.match(description, /\[cut off at 1024 bytes\]/);
  const quoted = description.slice(description.indexOf('```\n') + 4, description.lastIndexOf('\n['));
  assert.equal(quoted.length, 1024);
});

test('the same command named for both settings is asked for its help once', { skip: process.platform !== 'linux' }, async () => {
  process.env.BROFORCE_LAUNCH_CMD = launcher;
  process.env.BROFORCE_INSTANCE_CMD = launcher;
  process.env.CLAUDE_SESSION_ID = 'help-session-9c21';

  assert.equal(await probeInstanceMode(sessionInstance()), true);
  await launchDescription();

  assert.deepEqual(
    (await launcherCalls()).filter((call) => call === '--help'),
    ['--help'],
    'the launch-help channel and the instance probe each ran their own --help',
  );
});

test('the description is rebuilt from the one startup capture on every listing', async () => {
  process.env.BROFORCE_LAUNCH_CMD = launcher;

  const first = await launchDescription();
  const second = await launchDescription();

  assert.equal(first, second);
  assert.deepEqual(await launcherCalls(), ['--help', '--args-help'], 'a listing re-ran the capture');
});

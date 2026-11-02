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

const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'launch-help-other-'));
const otherBinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'launch-help-other-bin-'));
const otherLauncher = await writeStubLauncher(otherBinDir, otherRoot);
const OTHER_ARGS_HELP = 'other launch arguments:\n  --profile NAME   the profile it launches';
const INSTANCE_BLOCK = '  --port P   the inspector port it allocates';
const PLAIN_BLOCK = '  --visible   opens a window on the user\'s desktop';
const LABELLED_ARGS_HELP = `[instance launch]\n${INSTANCE_BLOCK}\n\n[plain launch]\n${PLAIN_BLOCK}\n`;

const { buildToolList, configureLaunchTiming, resetLaunchHelpCapture, resetTargetResolution, sessionInstance, setServerPlatform, setToolListChangedNotifier } = await import('../index.js');
const { probeInstanceMode, resetInstanceModeProbe } = await import('../lib/game-process.js');

test.after(() => fs.rm(root, { recursive: true, force: true }));
test.after(() => fs.rm(binDir, { recursive: true, force: true }));
test.after(() => fs.rm(otherRoot, { recursive: true, force: true }));
test.after(() => fs.rm(otherBinDir, { recursive: true, force: true }));

const callsLog = path.join(root, 'calls.log');
const otherCallsLog = path.join(otherRoot, 'calls.log');
const control = (name, contents) => fs.writeFile(path.join(root, name), contents);
const clearControl = (name) => fs.rm(path.join(root, name), { force: true });
const otherControl = (name, contents) => fs.writeFile(path.join(otherRoot, name), contents);

async function callsIn(log) {
  try {
    return (await fs.readFile(log, 'utf8')).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

const launcherCalls = () => callsIn(callsLog);
const otherLauncherCalls = () => callsIn(otherCallsLog);
const helpCalls = async (calls) => (await calls).filter((call) => call.includes('help'));

const SESSION = 'help-session-9c21';

function fencedBlocks(description) {
  const parts = description.split('```');
  assert.equal(parts.length % 2, 1, 'an unclosed fenced block in the description');
  return parts.filter((_, index) => index % 2 === 1);
}

function quotedBody(block) {
  const marker = block.indexOf('\n[cut off at ');
  return block.slice(1, marker === -1 ? block.length - 1 : marker);
}

const { probeRetryMs: probeRetry, rootRetryMs: rootRetry } = configureLaunchTiming();

const notifications = [];
test.after(() => setToolListChangedNotifier());

async function waitFor(condition, budgetMs = 10000) {
  const deadline = Date.now() + budgetMs;
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  return condition();
}

async function listUntil(pattern, budgetMs = 10000) {
  const deadline = Date.now() + budgetMs;
  let description = await launchDescription();
  while (!pattern.test(description) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    description = await launchDescription();
  }
  return description;
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
  resetTargetResolution();
  setServerPlatform();
  await fs.rm(callsLog, { force: true });
  await fs.rm(otherCallsLog, { force: true });
  for (const name of ['no-args-help', 'args-help-text', 'long-args-help', 'help-fails', 'help-nonzero', 'slow-help']) await clearControl(name);
  for (const name of ['no-args-help', 'args-help-text', 'long-args-help', 'no-instance-mode', 'help-fails', 'slow-help', 'list-fails-after']) {
    await fs.rm(path.join(otherRoot, name), { force: true });
  }
  await otherControl('args-help-text', `${OTHER_ARGS_HELP}\n`);
  configureLaunchTiming({ probeRetryMs: probeRetry, rootRetryMs: rootRetry });
  notifications.length = 0;
  setToolListChangedNotifier(() => notifications.push(Date.now()));
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
  process.env.CLAUDE_SESSION_ID = SESSION;

  assert.equal(await probeInstanceMode(sessionInstance()), true);
  const description = await launchDescription();

  assert.deepEqual(
    await helpCalls(launcherCalls()),
    ['--help', '--args-help'],
    'the launch-help channel and the instance probe each ran their own --help',
  );
  assert.match(description, /Argument help from the configured launcher, which both launches go through:/);
  assert.deepEqual(fencedBlocks(description), ['\nstub launch arguments:\n  --window WxH   the size of the window it opens\n']);
});

test('two different launchers are each quoted for the launch they run', { skip: process.platform !== 'linux' }, async () => {
  process.env.CLAUDE_SESSION_ID = SESSION;
  process.env.BROFORCE_INSTANCE_CMD = otherLauncher;
  process.env.BROFORCE_LAUNCH_CMD = launcher;

  const description = await launchDescription();

  const instanceIntro = description.indexOf("Arguments the instance launch accepts, in the instance launcher's own words:");
  const steamIntro = description.indexOf('Arguments the launch command accepts with steam: true, in its own words:');
  assert.ok(instanceIntro !== -1, description);
  assert.ok(steamIntro > instanceIntro, 'the instance launch is the default, and is introduced first');

  const [forInstance, forSteam] = fencedBlocks(description);
  assert.equal(forInstance.trim(), OTHER_ARGS_HELP, "the instance launch quotes its own launcher");
  assert.match(forSteam, /--window WxH/);
  assert.deepEqual(await helpCalls(otherLauncherCalls()), ['--help', '--args-help']);
  assert.deepEqual(await launcherCalls(), ['--help', '--args-help']);
});

test('an instance launcher whose help does not list the flag is never handed it', { skip: process.platform !== 'linux' }, async () => {
  await otherControl('no-args-help', '1');
  process.env.CLAUDE_SESSION_ID = SESSION;
  process.env.BROFORCE_INSTANCE_CMD = otherLauncher;
  process.env.BROFORCE_LAUNCH_CMD = launcher;

  const description = await launchDescription();

  assert.match(description, /The configured instance launcher publishes no argument help, so launchArgs pass through to the instance launch as given\./);
  assert.match(description, /Arguments the launch command accepts with steam: true/);
  assert.deepEqual(await helpCalls(otherLauncherCalls()), ['--help'], 'the instance launcher was asked something it never offered');
});

test('a launcher with no instance mode gets no instance section, and no --args-help', { skip: process.platform !== 'linux' }, async () => {
  await otherControl('no-instance-mode', '1');
  process.env.CLAUDE_SESSION_ID = SESSION;
  process.env.BROFORCE_INSTANCE_CMD = otherLauncher;
  process.env.BROFORCE_LAUNCH_CMD = launcher;

  const description = await launchDescription();

  assert.match(description, /Arguments the configured launch command accepts, in its own words:/);
  assert.doesNotMatch(description, /Arguments the instance launch accepts|instance launcher publishes no argument help/);
  assert.deepEqual(await helpCalls(otherLauncherCalls()), ['--help']);
});

test('an unanswered --help renders no instance section, and a later listing picks one up', { skip: process.platform !== 'linux' }, async () => {
  await otherControl('help-fails', '1');
  process.env.CLAUDE_SESSION_ID = SESSION;
  process.env.BROFORCE_INSTANCE_CMD = otherLauncher;
  process.env.BROFORCE_LAUNCH_CMD = launcher;

  const refused = await launchDescription();

  assert.doesNotMatch(refused, /Arguments the instance launch accepts|instance launcher publishes no argument help/);
  assert.deepEqual(await helpCalls(otherLauncherCalls()), ['--help'], 'the launcher was quoted for a launch it never answered about');

  await fs.rm(path.join(otherRoot, 'help-fails'), { force: true });
  configureLaunchTiming({ probeRetryMs: 0 });
  const answered = await listUntil(/Arguments the instance launch accepts/);

  assert.match(answered, /Arguments the instance launch accepts, in the instance launcher's own words:/);
  assert.deepEqual(await helpCalls(otherLauncherCalls()), ['--help', '--help', '--args-help']);
});

test('each quoted block is capped on its own', { skip: process.platform !== 'linux' }, async () => {
  await control('long-args-help', '1');
  await otherControl('long-args-help', '1');
  process.env.CLAUDE_SESSION_ID = SESSION;
  process.env.BROFORCE_INSTANCE_CMD = otherLauncher;
  process.env.BROFORCE_LAUNCH_CMD = launcher;

  const description = await launchDescription();

  const blocks = fencedBlocks(description);
  assert.equal(blocks.length, 2);
  for (const block of blocks) {
    assert.equal(quotedBody(block).length, 1024);
    assert.match(block, /\n\[cut off at 1024 bytes\]\n$/);
  }
});

test('the quoted help is a bounded tail on top of the tool\'s own text', { skip: process.platform !== 'linux' }, async () => {
  await control('no-args-help', '1');
  process.env.CLAUDE_SESSION_ID = SESSION;
  process.env.BROFORCE_INSTANCE_CMD = launcher;
  process.env.BROFORCE_LAUNCH_CMD = launcher;

  const withoutHelp = await launchDescription();

  const long = (mark) => `${mark} `.repeat(600).slice(0, 1200);
  await clearControl('no-args-help');
  await control('args-help-text', `[instance launch]\n${long('i')}\n[plain launch]\n${long('p')}\n`);
  resetLaunchHelpCapture();
  resetInstanceModeProbe();
  resetTargetResolution();

  const withHelp = await launchDescription();

  const blocks = fencedBlocks(withHelp);
  assert.equal(blocks.length, 2);
  for (const block of blocks) assert.equal(quotedBody(block).length, 1024);
  const added = withHelp.length - withoutHelp.length;
  assert.ok(added <= 2048 + 400, `the quoted tail added ${added} characters`);
});

test('a labelled answer is a block per launch', { skip: process.platform !== 'linux' }, async () => {
  await otherControl('args-help-text', LABELLED_ARGS_HELP);
  await control('args-help-text', LABELLED_ARGS_HELP);
  process.env.CLAUDE_SESSION_ID = SESSION;
  process.env.BROFORCE_INSTANCE_CMD = otherLauncher;
  process.env.BROFORCE_LAUNCH_CMD = launcher;

  const description = await launchDescription();

  const [forInstance, forSteam] = fencedBlocks(description);
  assert.equal(forInstance.trim(), INSTANCE_BLOCK.trim());
  assert.equal(forSteam.trim(), PLAIN_BLOCK.trim());
  assert.doesNotMatch(description, /\[instance launch\]|\[plain launch\]/);
});

test('one program labelling its blocks is two sections', { skip: process.platform !== 'linux' }, async () => {
  await control('args-help-text', LABELLED_ARGS_HELP);
  process.env.CLAUDE_SESSION_ID = SESSION;
  process.env.BROFORCE_INSTANCE_CMD = launcher;
  process.env.BROFORCE_LAUNCH_CMD = launcher;

  const description = await launchDescription();

  assert.doesNotMatch(description, /both launches go through/, 'a labelled answer speaks for each launch separately');
  assert.match(description, /Arguments the instance launch accepts, in the instance launcher's own words:/);
  assert.match(description, /Arguments the launch command accepts with steam: true, in its own words:/);
  assert.deepEqual(fencedBlocks(description).map((block) => block.trim()), [INSTANCE_BLOCK.trim(), PLAIN_BLOCK.trim()]);
  assert.deepEqual(await helpCalls(launcherCalls()), ['--help', '--args-help'], 'one program, one answer');
});

test('a launch the labels leave out publishes no argument help', { skip: process.platform !== 'linux' }, async () => {
  await control('args-help-text', `[instance launch]\n${INSTANCE_BLOCK}\n`);
  process.env.CLAUDE_SESSION_ID = SESSION;
  process.env.BROFORCE_INSTANCE_CMD = launcher;
  process.env.BROFORCE_LAUNCH_CMD = launcher;

  const description = await launchDescription();

  assert.match(description, /Arguments the instance launch accepts, in the instance launcher's own words:/);
  assert.match(description, /With steam: true the configured launch command publishes no argument help, so launchArgs pass through to it as given\./);
  assert.equal(fencedBlocks(description).length, 1);
});

test('headers survive CRLF and trailing space, and a repeat adds nothing', { skip: process.platform !== 'linux' }, async () => {
  const crlf = [
    '[instance launch] ',
    INSTANCE_BLOCK,
    '[plain launch]',
    PLAIN_BLOCK,
    '[plain launch]',
    '  --ignored   a second block under the same header',
    '',
  ].join('\r\n');
  await control('args-help-text', crlf);
  process.env.CLAUDE_SESSION_ID = SESSION;
  process.env.BROFORCE_INSTANCE_CMD = launcher;
  process.env.BROFORCE_LAUNCH_CMD = launcher;

  const description = await launchDescription();

  assert.deepEqual(fencedBlocks(description).map((block) => block.trim()), [INSTANCE_BLOCK.trim(), PLAIN_BLOCK.trim()]);
  assert.doesNotMatch(description, /\r/, 'the quoted blocks carry the capture\'s line endings');
  assert.doesNotMatch(description, /a second block under the same header/);
});

test('the cap is bytes, and cuts on a whole character', { skip: process.platform !== 'linux' }, async () => {
  await control('args-help-text', `${'\u3042'.repeat(600)}\n`);
  process.env.BROFORCE_LAUNCH_CMD = launcher;

  const description = await launchDescription();

  const [block] = fencedBlocks(description);
  const body = quotedBody(block);
  assert.match(block, /\n\[cut off at 1024 bytes\]\n$/);
  assert.ok(Buffer.byteLength(body) <= 1024, `the block is ${Buffer.byteLength(body)} bytes`);
  assert.match(body, /^\u3042+$/);
  assert.equal(body.length, 341);
});

test('a usage that offers the flag and exits non-zero is not an answer', async () => {
  await control('help-nonzero', '1');
  process.env.BROFORCE_LAUNCH_CMD = launcher;

  const description = await launchDescription();

  assert.doesNotMatch(description, /argument help|in its own words/);
  assert.deepEqual(await launcherCalls(), ['--help'], 'a --help that could not answer offered nothing');
});

test('a header this server does not know takes its block with it', { skip: process.platform !== 'linux' }, async () => {
  await control('args-help-text', `[some other launch]\n  --nowhere   goes nowhere\n\n[plain launch]\n${PLAIN_BLOCK}\n`);
  process.env.CLAUDE_SESSION_ID = SESSION;
  process.env.BROFORCE_INSTANCE_CMD = launcher;
  process.env.BROFORCE_LAUNCH_CMD = launcher;

  const description = await launchDescription();

  assert.doesNotMatch(description, /goes nowhere|some other launch/);
  assert.deepEqual(fencedBlocks(description).map((block) => block.trim()), [PLAIN_BLOCK.trim()]);
  assert.match(description, /The configured instance launcher publishes no argument help/);
});

test('with no session id the launch command is the launch that gets quoted', { skip: process.platform !== 'linux' }, async () => {
  process.env.BROFORCE_INSTANCE_CMD = otherLauncher;
  process.env.BROFORCE_LAUNCH_CMD = launcher;

  const description = await launchDescription();

  assert.match(description, /Arguments the configured launch command accepts, in its own words:/);
  assert.doesNotMatch(description, /steam: true, in its own words/);
  assert.doesNotMatch(description, /Arguments the instance launch accepts|instance launcher publishes no argument help/);
  assert.deepEqual(await helpCalls(otherLauncherCalls()), ['--help'], 'the instance launcher was quoted for a launch this server never runs');
});

test('one program for both settings, publishing no argument help', { skip: process.platform !== 'linux' }, async () => {
  await control('no-args-help', '1');
  process.env.CLAUDE_SESSION_ID = SESSION;
  process.env.BROFORCE_INSTANCE_CMD = launcher;
  process.env.BROFORCE_LAUNCH_CMD = launcher;

  const description = await launchDescription();

  assert.match(description, /The configured launcher publishes no argument help, so launchArgs pass through to either launch as given\./);
  assert.deepEqual(await helpCalls(launcherCalls()), ['--help']);
});

test('an instance launcher with no launch command beside it', { skip: process.platform !== 'linux' }, async () => {
  process.env.CLAUDE_SESSION_ID = SESSION;
  process.env.BROFORCE_INSTANCE_CMD = otherLauncher;

  const description = await launchDescription();

  assert.match(description, /Arguments the instance launch accepts, in the instance launcher's own words:/);
  assert.match(description, /With steam: true the Steam protocol launch takes no arguments, so launchArgs are not accepted\./);
  assert.equal(fencedBlocks(description).length, 1, 'the one block takes the whole budget');
});

test('a launch command publishing none beside an instance launcher that publishes', { skip: process.platform !== 'linux' }, async () => {
  await control('no-args-help', '1');
  process.env.CLAUDE_SESSION_ID = SESSION;
  process.env.BROFORCE_INSTANCE_CMD = otherLauncher;
  process.env.BROFORCE_LAUNCH_CMD = launcher;

  const description = await launchDescription();

  assert.match(description, /Arguments the instance launch accepts, in the instance launcher's own words:/);
  assert.match(description, /With steam: true the configured launch command publishes no argument help, so launchArgs pass through to it as given\./);
  assert.deepEqual(await launcherCalls(), ['--help']);
});

test('a --help that failed once is not remembered as no argument help', { skip: process.platform !== 'linux' }, async () => {
  await control('help-fails', '1');
  process.env.CLAUDE_SESSION_ID = SESSION;
  process.env.BROFORCE_INSTANCE_CMD = launcher;
  process.env.BROFORCE_LAUNCH_CMD = launcher;

  assert.doesNotMatch(await launchDescription(), /argument help|in its own words/);

  await clearControl('help-fails');
  configureLaunchTiming({ probeRetryMs: 0 });
  const answered = await listUntil(/in its own words|both launches go through/);

  assert.match(answered, /Argument help from the configured launcher, which both launches go through:/);
  assert.deepEqual(
    (await helpCalls(launcherCalls())).filter((call) => call === '--args-help'),
    ['--args-help'],
    'the one program was asked for its arguments more than once',
  );
});

test("a launcher's leading arguments go to both of its help questions", async () => {
  process.env.BROFORCE_LAUNCH_CMD = `${launcher} --quiet`;

  const description = await launchDescription();

  assert.match(description, /Arguments the configured launch command accepts, in its own words:/);
  assert.match(description, /--window WxH/);
  assert.deepEqual(await launcherCalls(), ['--quiet --help', '--quiet --args-help']);
});

test('a retry runs in the background rather than holding a listing up', async () => {
  await control('help-fails', '1');
  process.env.BROFORCE_LAUNCH_CMD = launcher;

  assert.doesNotMatch(await launchDescription(), /argument help|in its own words/);

  await clearControl('help-fails');
  await control('slow-help', '1');
  const started = Date.now();
  const duringRetry = await launchDescription();
  const elapsed = Date.now() - started;

  assert.doesNotMatch(duringRetry, /in its own words/);
  assert.ok(elapsed < 1000, `the listing waited ${elapsed}ms on the retry`);

  assert.match(await listUntil(/in its own words/), /Arguments the configured launch command accepts, in its own words:/);
});

test('a listing does not wait on a launcher that has not answered', { skip: process.platform !== 'linux' }, async () => {
  await otherControl('slow-help', '1');
  process.env.CLAUDE_SESSION_ID = SESSION;
  process.env.BROFORCE_INSTANCE_CMD = otherLauncher;
  process.env.BROFORCE_LAUNCH_CMD = launcher;

  const started = Date.now();
  const description = await launchDescription();
  const elapsed = Date.now() - started;

  assert.match(description, /The argument help for this launch follows once the configured launcher has answered\./);
  assert.equal(fencedBlocks(description).length, 0);
  assert.ok(elapsed < 2500, `the listing waited ${elapsed}ms on the launcher`);
});

test('a launcher answering behind the first listing is announced once', { skip: process.platform !== 'linux' }, async () => {
  await otherControl('slow-help', '1');
  process.env.CLAUDE_SESSION_ID = SESSION;
  process.env.BROFORCE_INSTANCE_CMD = otherLauncher;
  process.env.BROFORCE_LAUNCH_CMD = launcher;

  assert.match(await launchDescription(), /follows once the configured launcher has answered/);
  assert.ok(await waitFor(() => notifications.length > 0), 'the settled tail was never announced');

  assert.equal(notifications.length, 1, 'one change, one notification');
  assert.match(await launchDescription(), /Arguments the instance launch accepts, in the instance launcher's own words:/);
});

test('a root discovered after its cooldown flips the rendering and says so', { skip: process.platform !== 'linux' }, async () => {
  await otherControl('list-fails-after', '0');
  process.env.CLAUDE_SESSION_ID = SESSION;
  process.env.BROFORCE_INSTANCE_CMD = otherLauncher;
  process.env.BROFORCE_LAUNCH_CMD = launcher;

  assert.match(await launchDescription(), /Arguments the configured launch command accepts, in its own words:/);

  await fs.rm(path.join(otherRoot, 'list-fails-after'), { force: true });
  configureLaunchTiming({ rootRetryMs: 0 });
  await launchDescription();

  assert.ok(await waitFor(() => notifications.length > 0), 'the flipped tail was never announced');
  assert.equal(notifications.length, 1);
  assert.match(await launchDescription(), /Arguments the instance launch accepts, in the instance launcher's own words:/);
});

test('a background retry is announced when it lands', { skip: process.platform !== 'linux' }, async () => {
  await control('help-fails', '1');
  process.env.CLAUDE_SESSION_ID = SESSION;
  process.env.BROFORCE_INSTANCE_CMD = launcher;
  process.env.BROFORCE_LAUNCH_CMD = launcher;

  await launchDescription();
  await clearControl('help-fails');
  configureLaunchTiming({ probeRetryMs: 0 });

  assert.doesNotMatch(await launchDescription(), /in its own words|both launches go through/);

  assert.ok(await waitFor(() => notifications.length > 0), 'the retry landing was never announced');
  assert.match(await launchDescription(), /Argument help from the configured launcher, which both launches go through:/);
});

test('a listing that changes nothing announces nothing', { skip: process.platform !== 'linux' }, async () => {
  process.env.CLAUDE_SESSION_ID = SESSION;
  process.env.BROFORCE_INSTANCE_CMD = otherLauncher;
  process.env.BROFORCE_LAUNCH_CMD = launcher;

  const first = await launchDescription();
  const second = await launchDescription();

  assert.equal(first, second);
  await waitFor(() => notifications.length > 0, 500);
  assert.deepEqual(notifications, []);
});

test('off Linux the instance launcher is asked nothing at all', async (t) => {
  setServerPlatform('darwin');
  t.after(() => setServerPlatform());
  process.env.CLAUDE_SESSION_ID = SESSION;
  process.env.BROFORCE_INSTANCE_CMD = otherLauncher;
  process.env.BROFORCE_LAUNCH_CMD = launcher;

  const description = await launchDescription();

  assert.match(description, /Arguments the configured launch command accepts, in its own words:/);
  assert.doesNotMatch(description, /Arguments the instance launch accepts|instance launcher publishes no argument help/);
  assert.deepEqual(await otherLauncherCalls(), [], 'instances are a Linux arrangement');
});

test('with no instance launcher configured only the launch command is quoted', async () => {
  process.env.BROFORCE_LAUNCH_CMD = launcher;

  const description = await launchDescription();

  assert.match(description, /Arguments the configured launch command accepts, in its own words:/);
  assert.doesNotMatch(description, /Arguments the instance launch accepts|instance launcher publishes no argument help/);
  assert.equal(fencedBlocks(description).length, 1);
});

test('the description is rebuilt from the one startup capture on every listing', async () => {
  process.env.BROFORCE_LAUNCH_CMD = launcher;

  const first = await launchDescription();
  const second = await launchDescription();

  assert.equal(first, second);
  assert.deepEqual(await launcherCalls(), ['--help', '--args-help'], 'a listing re-ran the capture');
});

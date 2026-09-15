import './support/session.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import { readFileSync } from 'fs';
import os from 'os';
import path from 'path';

import { startWrapper } from './support/wrapper-harness.js';
import { writeStubLauncher } from './support/stub-launcher.js';

const isLinux = process.platform === 'linux';
const SESSION = 'wrapper-session-77b0';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wrapper-instances-'));
const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wrapper-launcher-bin-'));
const launcher = await writeStubLauncher(binDir, root);

test.after(() => fs.rm(root, { recursive: true, force: true }));
test.after(() => fs.rm(binDir, { recursive: true, force: true }));

const instanceDir = path.join(root, SESSION);
const ownerFile = path.join(instanceDir, 'owner.pid');
const callsLog = path.join(root, 'calls.log');
const STOP_CALL = `instance ${SESSION} stop`;

const wrapperEnv = {
  CLAUDE_SESSION_ID: SESSION,
  BROFORCE_INSTANCE_CMD: launcher,
  // Short enough to run inside a test, long enough that a takeover has time to land
  UNITY_INSPECTOR_MCP_STOP_WAIT_MS: '600',
};

async function launcherCalls() {
  try {
    return (await fs.readFile(callsLog, 'utf8')).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

// The same line the server writes: a pid and field 22 of /proc/<pid>/stat
function ownerLineFor(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return `${pid} ${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}\n`;
}

// What the server does when it claims the id: it writes owner.pid, and records where it wrote it
// in the file the wrapper named, since the wrapper knows no instances root of its own
async function claimFor(w) {
  await fs.mkdir(instanceDir, { recursive: true });
  await fs.writeFile(ownerFile, ownerLineFor(w.proc.pid));
  await recordClaim(w);
}

const recordClaim = (w) => fs.writeFile(w.claimFile, `${ownerFile}\n`);

const exited = (w) => new Promise((resolve) => w.proc.on('exit', resolve));

beforeEach(async () => {
  await fs.rm(callsLog, { force: true });
  await fs.rm(path.join(root, 'stop-fails'), { force: true });
  await fs.rm(instanceDir, { recursive: true, force: true });
});

test('a wrapper that owns the instance stops it when its stdin closes', { timeout: 20000, skip: !isLinux }, async (t) => {
  const w = startWrapper(wrapperEnv);
  t.after(() => w.stop());
  await w.initialize(0);
  await claimFor(w);

  w.proc.stdin.end();
  await exited(w);

  assert.deepEqual((await launcherCalls()).filter((call) => call === STOP_CALL), [STOP_CALL]);
  // A real session end is what reveals the grace period, so both intervals are on the record
  const log = await fs.readFile(w.logFile, 'utf8');
  assert.match(log, new RegExp(`Stopped instance ${SESSION}, \\d+ms after stdin end`));
  assert.match(log, /Wrapper exiting, \d+ms after stdin end/);
  // A stop that exited while a launch was still in flight would leave an untracked game behind,
  // so giving the id up is the server's to do, never the wrapper's
  await fs.access(ownerFile);
  await assert.rejects(fs.access(w.claimFile), 'the wrapper left its own claim file behind');
});

// Long enough that a wrapper which waited the window out could not exit inside the assertion below
const LONG_WAIT = { ...wrapperEnv, UNITY_INSPECTOR_MCP_STOP_WAIT_MS: '3000' };

test('a wrapper that owns nothing exits without touching the launcher', { timeout: 20000, skip: !isLinux }, async (t) => {
  const w = startWrapper(LONG_WAIT);
  t.after(() => w.stop());
  await w.initialize(0);

  const started = Date.now();
  w.proc.stdin.end();
  await exited(w);

  assert.deepEqual(await launcherCalls(), [], 'a launcher with no instance mode could read `instance` as a profile');
  assert.ok(Date.now() - started < 1500, 'an unowned instance was waited over');
  assert.match(await fs.readFile(w.logFile, 'utf8'), new RegExp(`Instance ${SESSION} is not owned by this wrapper`));
});

test('a wrapper whose instance was claimed by another pid leaves it alone', { timeout: 20000, skip: !isLinux }, async (t) => {
  const w = startWrapper(LONG_WAIT);
  t.after(() => w.stop());
  await w.initialize(0);
  await fs.mkdir(instanceDir, { recursive: true });
  await fs.writeFile(ownerFile, `${process.pid} 1\n`);
  await recordClaim(w);

  const started = Date.now();
  w.proc.stdin.end();
  await exited(w);

  assert.deepEqual(await launcherCalls(), []);
  assert.ok(Date.now() - started < 1500, 'an instance owned by another pid was waited over');
  assert.match(await fs.readFile(w.logFile, 'utf8'), new RegExp(`Instance ${SESSION} is not owned by this wrapper`));
  await fs.access(ownerFile);
});

test('a claim carrying this pid with another start time is a recycled pid, not ownership', { timeout: 20000, skip: !isLinux }, async (t) => {
  const w = startWrapper(LONG_WAIT);
  t.after(() => w.stop());
  await w.initialize(0);
  await fs.mkdir(instanceDir, { recursive: true });
  await fs.writeFile(ownerFile, `${w.proc.pid} 1\n`);
  await recordClaim(w);

  const started = Date.now();
  w.proc.stdin.end();
  await exited(w);

  assert.deepEqual(await launcherCalls(), []);
  assert.ok(Date.now() - started < 1500, 'a claim from an earlier process at this pid was waited over');
  assert.match(await fs.readFile(w.logFile, 'utf8'), new RegExp(`Instance ${SESSION} is not owned by this wrapper`));
});

test('a claim naming an owner file that is gone stops nothing', { timeout: 20000, skip: !isLinux }, async (t) => {
  const w = startWrapper(LONG_WAIT);
  t.after(() => w.stop());
  await w.initialize(0);
  await recordClaim(w);

  const started = Date.now();
  w.proc.stdin.end();
  await exited(w);

  assert.deepEqual(await launcherCalls(), []);
  assert.ok(Date.now() - started < 1500, 'an instance nothing claimed was waited over');
  assert.match(await fs.readFile(w.logFile, 'utf8'), new RegExp(`Instance ${SESSION} is not owned by this wrapper`));
});

test('a claim file the wrapper cannot read stops nothing', { timeout: 20000, skip: !isLinux }, async (t) => {
  const w = startWrapper(LONG_WAIT);
  t.after(() => w.stop());
  await w.initialize(0);
  // The owner file names this wrapper, so only the unreadable claim can hold the stop back
  await claimFor(w);
  await fs.rm(w.claimFile, { force: true });
  await fs.mkdir(w.claimFile);

  const started = Date.now();
  w.proc.stdin.end();
  await exited(w);

  assert.deepEqual(await launcherCalls(), []);
  assert.ok(Date.now() - started < 1500, 'an unreadable claim was waited over');
  assert.match(await fs.readFile(w.logFile, 'utf8'),
    new RegExp(`Could not read the owner claim for instance ${SESSION}: EISDIR`));
});

test('an instance taken over during the wait is left running', { timeout: 20000, skip: !isLinux }, async (t) => {
  const w = startWrapper({ ...wrapperEnv, UNITY_INSPECTOR_MCP_STOP_WAIT_MS: '4000' });
  t.after(() => w.stop());
  await w.initialize(0);
  await claimFor(w);

  const done = exited(w);
  w.proc.stdin.end();
  // A newer server adopting the id rewrites owner.pid, and the old wrapper stands down
  await w.sleep(700);
  await fs.writeFile(ownerFile, `${process.pid} 1\n`);
  await done;

  assert.deepEqual(await launcherCalls(), []);
});

test('restart_server replaces the child and stops no game', { timeout: 20000, skip: !isLinux }, async (t) => {
  const w = startWrapper(wrapperEnv);
  t.after(() => w.stop());
  await w.initialize(0);
  await claimFor(w);

  w.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'restart_server', arguments: {} } });
  const restarted = await w.waitFor((m) => m.id === 1, 10000);
  assert.ok(restarted?.result, 'restart_server did not answer');
  await w.sleep(300);

  assert.deepEqual(await launcherCalls(), []);
  await fs.access(ownerFile);
});

test('an empty stop wait falls back to the default rather than to no wait at all', { timeout: 30000, skip: !isLinux }, async (t) => {
  const w = startWrapper({ ...wrapperEnv, UNITY_INSPECTOR_MCP_STOP_WAIT_MS: '' });
  t.after(() => w.stop());
  await w.initialize(0);
  await claimFor(w);

  const done = exited(w);
  w.proc.stdin.end();
  await w.sleep(300);
  await fs.writeFile(ownerFile, `${process.pid} 1\n`);
  await done;

  assert.deepEqual(await launcherCalls(), [], 'the takeover landed inside the window and was missed');
});

test('a stop the launcher refuses is logged as the failure it was', { timeout: 20000, skip: !isLinux }, async (t) => {
  await fs.writeFile(path.join(root, 'stop-fails'), '');
  const w = startWrapper(wrapperEnv);
  t.after(() => w.stop());
  await w.initialize(0);
  await claimFor(w);

  w.proc.stdin.end();
  await exited(w);

  const log = await fs.readFile(w.logFile, 'utf8');
  assert.match(log, new RegExp(`Stopping instance ${SESSION} exited with status 4, \\d+ms after stdin end`));
  assert.doesNotMatch(log, /Stopped instance/);
});

// A signalled wrapper is killed uncatchably about a second later, so a wait it could sit out is a
// wait it would be killed inside of: every signal path below has to beat this window by far
const SIGNAL_WAIT = { ...wrapperEnv, UNITY_INSPECTOR_MCP_STOP_WAIT_MS: '5000' };

// The stop runs before the wrapper exits, so the exit is the latest moment it can have been recorded
async function stopCallElapsed(done, signalledAt) {
  await done;
  const elapsed = Date.now() - signalledAt;
  assert.deepEqual((await launcherCalls()).filter((call) => call === STOP_CALL), [STOP_CALL]);
  return elapsed;
}

test('a wrapper that owns the instance stops it at once on SIGTERM', { timeout: 20000, skip: !isLinux }, async (t) => {
  const w = startWrapper(SIGNAL_WAIT);
  t.after(() => w.stop());
  await w.initialize(0);
  await claimFor(w);

  const done = exited(w);
  const signalledAt = Date.now();
  w.proc.kill('SIGTERM');
  const elapsed = await stopCallElapsed(done, signalledAt);

  assert.ok(elapsed < 1500, `the stop waited ${elapsed}ms instead of running at once`);
  assert.match(await fs.readFile(w.logFile, 'utf8'), new RegExp(`Stopped instance ${SESSION}, \\d+ms after SIGTERM`));
  assert.match(await fs.readFile(w.logFile, 'utf8'), /Wrapper exiting, \d+ms after SIGTERM/);
});

test('a wrapper that owns the instance stops it at once on SIGINT', { timeout: 20000, skip: !isLinux }, async (t) => {
  const w = startWrapper(SIGNAL_WAIT);
  t.after(() => w.stop());
  await w.initialize(0);
  await claimFor(w);

  const done = exited(w);
  const signalledAt = Date.now();
  w.proc.kill('SIGINT');
  const elapsed = await stopCallElapsed(done, signalledAt);

  assert.ok(elapsed < 1500, `the stop waited ${elapsed}ms instead of running at once`);
  assert.match(await fs.readFile(w.logFile, 'utf8'), new RegExp(`Stopped instance ${SESSION}, \\d+ms after SIGINT`));
});

test('a signalled wrapper whose instance was taken over first stops nothing', { timeout: 20000, skip: !isLinux }, async (t) => {
  const w = startWrapper(SIGNAL_WAIT);
  t.after(() => w.stop());
  await w.initialize(0);
  await claimFor(w);
  await fs.writeFile(ownerFile, `${process.pid} 1\n`);

  const done = exited(w);
  w.proc.kill('SIGTERM');
  await done;

  assert.deepEqual(await launcherCalls(), []);
  assert.match(await fs.readFile(w.logFile, 'utf8'), new RegExp(`Instance ${SESSION} is not owned by this wrapper`));
});

test('a signal arriving during the wait cuts it short and stops the instance once', { timeout: 20000, skip: !isLinux }, async (t) => {
  const w = startWrapper(SIGNAL_WAIT);
  t.after(() => w.stop());
  await w.initialize(0);
  await claimFor(w);

  const done = exited(w);
  w.proc.stdin.end();
  // Past the first poll tick, so a wait that only noticed the signal on the next one would show
  await w.sleep(550);
  const signalledAt = Date.now();
  w.proc.kill('SIGTERM');
  const elapsed = await stopCallElapsed(done, signalledAt);

  assert.ok(elapsed < 300, `the signal left ${elapsed}ms of the wait standing`);
  assert.match(await fs.readFile(w.logFile, 'utf8'), new RegExp(`Stopped instance ${SESSION}, \\d+ms after SIGTERM`));
});

test('a second signal during the stop does not stop the instance twice', { timeout: 20000, skip: !isLinux }, async (t) => {
  const w = startWrapper(SIGNAL_WAIT);
  t.after(() => w.stop());
  await w.initialize(0);
  await claimFor(w);

  const done = exited(w);
  const signalledAt = Date.now();
  w.proc.kill('SIGINT');
  await w.sleep(100);
  w.proc.kill('SIGTERM');
  const elapsed = await stopCallElapsed(done, signalledAt);

  assert.ok(elapsed < 1500, `the stop waited ${elapsed}ms instead of running at once`);
  assert.match(await fs.readFile(w.logFile, 'utf8'), new RegExp(`Stopped instance ${SESSION}, \\d+ms after SIGINT`));
});

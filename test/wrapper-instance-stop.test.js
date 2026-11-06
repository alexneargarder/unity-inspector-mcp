import './support/session.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import { readFileSync } from 'fs';
import os from 'os';
import path from 'path';

import { alive, claudeCodeClose, sdkClientClose, startWrapper } from './support/wrapper-harness.js';
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

const exited = (w) => new Promise((resolve) => {
  if (w.proc.exitCode !== null || w.proc.signalCode !== null) resolve();
  else w.proc.on('exit', resolve);
});

const stopCalls = async () => (await launcherCalls()).filter((call) => call === STOP_CALL);

const takeOver = () => fs.writeFile(ownerFile, `${process.pid} 1\n`);

beforeEach(async () => {
  await fs.rm(callsLog, { force: true });
  await fs.rm(path.join(root, 'stop-fails'), { force: true });
  await fs.rm(instanceDir, { recursive: true, force: true });
});


async function endAndReap(w, end) {
  const done = exited(w);
  const started = Date.now();
  await end();
  await done;
  const wrapperGone = Date.now() - started;
  assert.ok(await w.waitForReaper(), 'the reaper never finished');
  return wrapperGone;
}

test('a wrapper that owns the instance stops it once the takeover window has passed after stdin closes', { timeout: 20000, skip: !isLinux }, async (t) => {
  const w = startWrapper(wrapperEnv);
  t.after(() => w.stop());
  await w.initialize(0);
  await claimFor(w);

  const wrapperGone = await endAndReap(w, () => w.proc.stdin.end());

  assert.ok(wrapperGone < 1500, `the wrapper took ${wrapperGone}ms to exit`);
  assert.deepEqual(await stopCalls(), [STOP_CALL]);
  // A real session end is what reveals the grace period, so both intervals are on the record
  const log = w.readLog();
  const [, stoppedAfter] = log.match(new RegExp(`Stopped instance ${SESSION}, (\\d+)ms after stdin end`));
  assert.ok(Number(stoppedAfter) >= 600, `the stop ran ${stoppedAfter}ms in, inside the takeover window`);
  assert.match(log, /Wrapper exiting, \d+ms after stdin end/);
  // A stop that exited while a launch was still in flight would leave an untracked game behind,
  // so giving the id up is the server's to do, never the wrapper's
  await fs.access(ownerFile);
  await assert.rejects(fs.access(w.claimFile), 'the claim file was left behind');
});

const LONG_WAIT = { ...wrapperEnv, UNITY_INSPECTOR_MCP_STOP_WAIT_MS: '3000' };

async function assertLeftAlone(w, pattern) {
  const started = Date.now();
  await endAndReap(w, () => w.proc.stdin.end());
  const elapsed = Date.now() - started;

  assert.deepEqual(await launcherCalls(), [], 'a launcher with no instance mode could read `instance` as a profile');
  assert.ok(elapsed < 1500, `an instance this wrapper does not own was waited over (${elapsed}ms)`);
  assert.match(w.readLog(), pattern);
}

test('a wrapper that owns nothing exits without touching the launcher', { timeout: 20000, skip: !isLinux }, async (t) => {
  const w = startWrapper(LONG_WAIT);
  t.after(() => w.stop());
  await w.initialize(0);

  await assertLeftAlone(w, new RegExp(`Instance ${SESSION} is not owned by this wrapper`));
});

test('a wrapper whose instance was claimed by another pid leaves it alone', { timeout: 20000, skip: !isLinux }, async (t) => {
  const w = startWrapper(LONG_WAIT);
  t.after(() => w.stop());
  await w.initialize(0);
  await fs.mkdir(instanceDir, { recursive: true });
  await takeOver();
  await recordClaim(w);

  await assertLeftAlone(w, new RegExp(`Instance ${SESSION} is not owned by this wrapper`));
  await fs.access(ownerFile);
});

test('a claim carrying this pid with another start time is a recycled pid, not ownership', { timeout: 20000, skip: !isLinux }, async (t) => {
  const w = startWrapper(LONG_WAIT);
  t.after(() => w.stop());
  await w.initialize(0);
  await fs.mkdir(instanceDir, { recursive: true });
  await fs.writeFile(ownerFile, `${w.proc.pid} 1\n`);
  await recordClaim(w);

  await assertLeftAlone(w, new RegExp(`Instance ${SESSION} is not owned by this wrapper`));
});

test('a claim naming an owner file that is gone stops nothing', { timeout: 20000, skip: !isLinux }, async (t) => {
  const w = startWrapper(LONG_WAIT);
  t.after(() => w.stop());
  await w.initialize(0);
  await recordClaim(w);

  await assertLeftAlone(w, new RegExp(`Instance ${SESSION} is not owned by this wrapper`));
});

test('a claim file the wrapper cannot read stops nothing', { timeout: 20000, skip: !isLinux }, async (t) => {
  const w = startWrapper(LONG_WAIT);
  t.after(() => w.stop());
  await w.initialize(0);
  // The owner file names this wrapper, so only the unreadable claim can hold the stop back
  await claimFor(w);
  await fs.rm(w.claimFile, { force: true });
  await fs.mkdir(w.claimFile);

  await assertLeftAlone(w, new RegExp(`Could not read the owner claim for instance ${SESSION}: EISDIR`));
});

test('an instance taken over during the wait is left running', { timeout: 20000, skip: !isLinux }, async (t) => {
  const w = startWrapper({ ...wrapperEnv, UNITY_INSPECTOR_MCP_STOP_WAIT_MS: '4000' });
  t.after(() => w.stop());
  await w.initialize(0);
  await claimFor(w);

  await endAndReap(w, async () => {
    w.proc.stdin.end();
    await w.sleep(700);
    await takeOver();
  });

  assert.deepEqual(await launcherCalls(), []);
  assert.match(w.readLog(), new RegExp(`Instance ${SESSION} was taken over \\d+ms after stdin end`));
});

test('restart_server replaces the child and stops no game', { timeout: 20000, skip: !isLinux }, async (t) => {
  const w = startWrapper(wrapperEnv);
  t.after(() => w.stop());
  await w.initialize(0);
  await claimFor(w);

  w.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'restart_server', arguments: {} } });
  const restarted = await w.waitFor((m) => m.id === 1, 10000);
  assert.ok(restarted?.result, 'restart_server did not answer');
  await w.sleep(1000);

  assert.deepEqual(await launcherCalls(), []);
  assert.equal(w.reaperPid(), null, 'a restart handed the instance to a reaper');
  await fs.access(ownerFile);
});

test('an empty stop wait falls back to the default rather than to no wait at all', { timeout: 30000, skip: !isLinux }, async (t) => {
  const w = startWrapper({ ...wrapperEnv, UNITY_INSPECTOR_MCP_STOP_WAIT_MS: '' });
  t.after(() => w.stop());
  await w.initialize(0);
  await claimFor(w);

  await endAndReap(w, async () => {
    w.proc.stdin.end();
    await w.sleep(1500);
    await takeOver();
  });

  assert.deepEqual(await launcherCalls(), [], 'the takeover landed inside the window and was missed');
});

test('a stop the launcher refuses is logged as the failure it was', { timeout: 20000, skip: !isLinux }, async (t) => {
  await fs.writeFile(path.join(root, 'stop-fails'), '');
  const w = startWrapper(wrapperEnv);
  t.after(() => w.stop());
  await w.initialize(0);
  await claimFor(w);

  await endAndReap(w, () => w.proc.stdin.end());

  const log = w.readLog();
  assert.match(log, new RegExp(`Stopping instance ${SESSION} exited with status 4, \\d+ms after stdin end`));
  assert.doesNotMatch(log, /Stopped instance/);
});

const RECONNECT_WAIT = { ...wrapperEnv, UNITY_INSPECTOR_MCP_STOP_WAIT_MS: '3000' };

test("Claude Code's close keeps the takeover window: a reconnecting server keeps the instance", { timeout: 20000, skip: !isLinux }, async (t) => {
  const w = startWrapper(RECONNECT_WAIT);
  t.after(() => w.stop());
  await w.initialize(0);
  await claimFor(w);
  const [server] = w.childPids().map(Number);

  await endAndReap(w, async () => {
    await claudeCodeClose(w.proc);
    await w.sleep(500);
    await takeOver();
  });

  assert.deepEqual(await launcherCalls(), []);
  assert.match(w.readLog(), new RegExp(`Instance ${SESSION} was taken over \\d+ms after SIGINT`));
  assert.equal(alive(server), false, 'the server outlived its wrapper');
});

test("Claude Code's close with no reconnect stops the instance after the window", { timeout: 20000, skip: !isLinux }, async (t) => {
  const w = startWrapper(wrapperEnv);
  t.after(() => w.stop());
  await w.initialize(0);
  await claimFor(w);

  await endAndReap(w, () => claudeCodeClose(w.proc));

  assert.deepEqual(await stopCalls(), [STOP_CALL]);
  const log = w.readLog();
  assert.match(log, new RegExp(`Stopped instance ${SESSION}, \\d+ms after SIGINT`));
  assert.equal(log.match(/to reaper/g).length, 1, 'the SIGTERM that followed started a second stop');
  await assert.rejects(fs.access(w.claimFile), 'the claim file was left behind');
});

test("a wrapper Claude Code kills while its server is still shutting down still stops the instance, after the server", { timeout: 20000, skip: !isLinux }, async (t) => {
  const w = startWrapper({ ...wrapperEnv, STUB_CHILD_SLOW_STOP_MS: '1500' });
  t.after(() => w.stop());
  await w.initialize(0);
  await claimFor(w);
  const [server] = w.childPids().map(Number);

  const done = exited(w);
  const closing = claudeCodeClose(w.proc);
  let stopWhileServerRan = false;
  while (w.reaperPid() === null || alive(w.reaperPid())) {
    if ((await stopCalls()).length > 0 && alive(server)) stopWhileServerRan = true;
    await w.sleep(25);
  }
  await closing;
  await done;

  assert.equal(w.proc.signalCode, 'SIGKILL', 'the wrapper finished before the SIGKILL, so nothing here was cut short');
  assert.equal(stopWhileServerRan, false, 'the instance was stopped while its server still ran');
  assert.deepEqual(await stopCalls(), [STOP_CALL]);
  assert.match(w.readLog(), new RegExp(`Stopped instance ${SESSION}, \\d+ms after SIGINT`));
});

test('a server that will not stop is killed by the reaper before the instance stop', { timeout: 20000, skip: !isLinux }, async (t) => {
  const w = startWrapper({ ...wrapperEnv, STUB_CHILD_IGNORE_STOP: '1' });
  const [server] = await (async () => { await w.initialize(0); return w.childPids().map(Number); })();
  t.after(() => {
    try { process.kill(server, 'SIGKILL'); } catch {}
    w.stop();
  });
  await claimFor(w);

  await endAndReap(w, () => claudeCodeClose(w.proc));

  assert.equal(alive(server), false, 'the server outlived the session');
  assert.deepEqual(await stopCalls(), [STOP_CALL]);
  const log = w.readLog();
  assert.ok(log.indexOf(`Killed server ${server}`) >= 0, 'the reaper did not kill the server');
  assert.ok(log.indexOf(`Killed server ${server}`) < log.indexOf('Stopped instance'), 'the instance was stopped first');
});

test("the MCP SDK client's close keeps the takeover window", { timeout: 20000, skip: !isLinux }, async (t) => {
  const w = startWrapper(RECONNECT_WAIT);
  t.after(() => w.stop());
  await w.initialize(0);
  await claimFor(w);

  await endAndReap(w, async () => {
    const closing = sdkClientClose(w.proc);
    await w.sleep(2500);
    await takeOver();
    await closing;
  });

  assert.deepEqual(await launcherCalls(), []);
  assert.match(w.readLog(), new RegExp(`Instance ${SESSION} was taken over \\d+ms after stdin end`));
});

test("the MCP SDK client's close with no reconnect stops the instance", { timeout: 20000, skip: !isLinux }, async (t) => {
  const w = startWrapper(wrapperEnv);
  t.after(() => w.stop());
  await w.initialize(0);
  await claimFor(w);

  await endAndReap(w, () => sdkClientClose(w.proc));

  assert.deepEqual(await stopCalls(), [STOP_CALL]);
  assert.match(w.readLog(), new RegExp(`Stopped instance ${SESSION}, \\d+ms after stdin end`));
});

test('a hangup of the process group, and a kill of whatever it left, still stops the instance', { timeout: 20000, skip: !isLinux }, async (t) => {
  const w = startWrapper({ ...wrapperEnv, STUB_CHILD_SLOW_STOP_MS: '1500' }, { detached: true });
  t.after(() => w.stop());
  await w.initialize(0);
  await claimFor(w);
  const [server] = w.childPids().map(Number);

  await endAndReap(w, async () => {
    process.kill(-w.proc.pid, 'SIGHUP');
    assert.ok(await w.waitForLog(/to reaper \d+/), 'no reaper was started');
    process.kill(-w.proc.pid, 'SIGKILL');
  });

  assert.equal(alive(server), false, 'the server outlived the hangup');
  assert.deepEqual(await stopCalls(), [STOP_CALL]);
  assert.match(w.readLog(), new RegExp(`Stopped instance ${SESSION}, \\d+ms after SIGHUP`));
});

test('a signalled wrapper whose instance was taken over first stops nothing', { timeout: 20000, skip: !isLinux }, async (t) => {
  const w = startWrapper(wrapperEnv);
  t.after(() => w.stop());
  await w.initialize(0);
  await claimFor(w);
  await takeOver();

  await endAndReap(w, () => w.proc.kill('SIGTERM'));

  assert.deepEqual(await launcherCalls(), []);
  assert.match(w.readLog(), new RegExp(`Instance ${SESSION} is not owned by this wrapper`));
});

test('a restart queued when stdin ends never starts a server during the shutdown', { timeout: 20000, skip: !isLinux }, async (t) => {
  const starts = path.join(root, 'starts');
  await fs.rm(starts, { force: true });
  const w = startWrapper({
    ...wrapperEnv,
    STUB_CHILD_START_COUNTER: starts,
    STUB_CHILD_SLOW_INIT_ON: '2',
  });
  t.after(() => w.stop());
  await w.initialize(0);
  await claimFor(w);

  w.send({ jsonrpc: '2.0', id: 1, method: 'test/die' });
  await w.waitFor((m) => m.id === 1);
  await w.sleep(200);
  w.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'restart_server', arguments: {} } });
  await w.sleep(100);
  await endAndReap(w, () => w.proc.stdin.end());

  assert.equal(await fs.readFile(starts, 'utf8'), '2', 'a server was started after the shutdown began');
});

for (const [label, stateHome] of [['an absolute', 'absolute'], ['a relative', 'relative'], ['no', 'unset']]) {
  test(`with ${label} XDG_STATE_HOME the reaper reads the default claim and logs to the default log`, { timeout: 20000, skip: !isLinux }, async (t) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'wrapper-default-home-'));
    const absoluteState = await fs.mkdtemp(path.join(os.tmpdir(), 'wrapper-default-state-'));
    const xdg = { absolute: absoluteState, relative: 'relative/state', unset: undefined }[stateHome];
    const stateDir = path.join(stateHome === 'absolute' ? absoluteState : path.join(home, '.local', 'state'), 'unity-inspector-mcp');
    const w = startWrapper({
      ...wrapperEnv,
      UNITY_INSPECTOR_MCP_WRAPPER_LOG: '',
      UNITY_INSPECTOR_MCP_CLAIM_FILE: '',
      HOME: home,
      XDG_STATE_HOME: xdg,
    });
    const logFile = path.join(stateDir, `mcp-wrapper-${w.proc.pid}.log`);
    const claimFile = path.join(stateDir, `mcp-wrapper-${w.proc.pid}.claim`);
    const readLog = () => { try { return readFileSync(logFile, 'utf8'); } catch { return ''; } };
    let reaper = null;
    t.after(async () => {
      if (reaper !== null) { try { process.kill(reaper, 'SIGKILL'); } catch {} }
      w.stop();
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(absoluteState, { recursive: true, force: true });
    });
    await w.initialize(0);
    await fs.mkdir(instanceDir, { recursive: true });
    await fs.writeFile(ownerFile, ownerLineFor(w.proc.pid));
    await fs.writeFile(claimFile, `${ownerFile}\n`);

    const done = exited(w);
    w.proc.stdin.end();
    await done;
    reaper = Number(readLog().match(/to reaper (\d+)/)?.[1] ?? NaN);
    assert.ok(Number.isInteger(reaper), `no reaper was handed the instance:\n${readLog()}`);
    const deadline = Date.now() + 15000;
    while (alive(reaper) && Date.now() < deadline) await w.sleep(25);

    assert.match(readLog(), new RegExp(`Stopped instance ${SESSION}, \\d+ms after stdin end`));
    assert.deepEqual(await stopCalls(), [STOP_CALL]);
    await assert.rejects(fs.access(claimFile), 'the claim file was left behind');
  });
}

test('the claim the server records for the wrapper is readable by its owner alone', { timeout: 20000, skip: !isLinux }, async (t) => {
  const { writeOwnerFile } = await import('../index.js');
  const claimDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wrapper-claim-mode-'));
  const claimFile = path.join(claimDir, 'wrapper.claim');
  process.env.UNITY_INSPECTOR_MCP_CLAIM_FILE = claimFile;
  t.after(async () => {
    delete process.env.UNITY_INSPECTOR_MCP_CLAIM_FILE;
    await fs.rm(claimDir, { recursive: true, force: true });
  });
  await fs.mkdir(instanceDir, { recursive: true });

  assert.notEqual(await writeOwnerFile({ isAgentInstance: true, root: instanceDir, ownerFile }), null);
  assert.equal(await fs.readFile(claimFile, 'utf8'), `${ownerFile}\n`);
  assert.equal((await fs.stat(claimFile)).mode & 0o777, 0o600);
});

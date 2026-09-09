import { NO_LISTENER_PORT } from '../test-support/session.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { fakeInspector, instanceListJsonl, useStubLauncher } from '../test-support/stub-launcher.js';
import { fakeProcReader } from '../test-support/fake-proc.js';

const isLinux = process.platform === 'linux';
const SESSION = 'target-session-8c02';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'instances-'));
const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-bin-'));
const { instanceDir, stagePath } = await useStubLauncher({ session: SESSION, root, binDir });

const {
  activeConfig,
  activeTarget,
  findLogPath,
  pointClientAtTarget,
  handleToolCall,
  instanceField,
  resetTargetResolution,
  resolveTarget,
  serverStateFields,
  setTarget,
  targetLogPaths,
  unityClient,
} = await import('../index.js');
const { LINUX_GAME_COMM, isGameRunning, resetInstanceModeProbe, setProcReader } = await import('../lib/game-process.js');

// The port is only this instance's while a game of its own is running, so ownership has to be faked
const ownGame = (pid = 900) => setProcReader(fakeProcReader({
  [pid]: { comm: LINUX_GAME_COMM, cwd: path.join(instanceDir, 'work'), startTicks: 100 },
}));

test.after(() => setProcReader(null));
test.after(() => fs.rm(root, { recursive: true, force: true }));
test.after(() => fs.rm(binDir, { recursive: true, force: true }));

// The `steam` target's own port, as the test session fences it: nothing listens on it, so no
// assertion here can be answered by the user's real game
const STEAM_PORT = Number(NO_LISTENER_PORT);

const portFile = path.join(instanceDir, 'port');
const noGameStart = async () => null;

beforeEach(async () => {
  resetInstanceModeProbe();
  resetTargetResolution();
  setProcReader(null);
  unityClient.disconnect();
  process.env.CLAUDE_SESSION_ID = SESSION;
  process.env.UNITY_INSPECTOR_PORT = NO_LISTENER_PORT;
  delete process.env.UNITY_INSPECTOR_LOG;
  await fs.rm(instanceDir, { recursive: true, force: true });
});

function payload(response) {
  const text = response.content.map((c) => c.text).join('\n');
  assert.ok(!response.isError, text);
  return JSON.parse(text);
}

test('a session with an instance serves it, on the port the launcher recorded', { timeout: 30000, skip: !isLinux }, async () => {
  await fs.mkdir(instanceDir, { recursive: true });
  await fs.writeFile(portFile, '9931\n');
  ownGame();

  assert.equal(await resolveTarget(), 'instance');
  assert.equal(activeTarget(), 'instance');
  assert.equal(activeConfig().id, SESSION);
  assert.equal(unityClient.port, 9931, 'a server started beside a running instance adopts its port');
  assert.equal(unityClient.gameConfig.workDir, path.join(instanceDir, 'work'));
});

test('the recorded port is only this instance\'s while a game of its own is running', { timeout: 30000, skip: !isLinux }, async (t) => {
  // The launcher hands a freed port to the next instance, so a listener on it can be another game
  const foreign = await fakeInspector();
  t.after(() => foreign.close());
  await fs.mkdir(instanceDir, { recursive: true });
  await fs.writeFile(portFile, String(foreign.port));

  await resolveTarget();
  assert.equal(unityClient.port, null, 'a port with no game of ours behind it was adopted');

  const denied = payload(await handleToolCall({ params: { name: 'game_state', arguments: {} } }));
  assert.equal(denied.success, false);
  assert.match(denied.message, new RegExp(`No inspector port is known for instance ${SESSION}`));
  assert.match(denied.message, /no game of this instance is running/);
  assert.equal(unityClient.connected, false, 'a command reached somebody else\'s game');

  ownGame();
  assert.equal(await pointClientAtTarget(), foreign.port);

  const answered = payload(await handleToolCall({ params: { name: 'ping', arguments: {} } }));
  assert.ok(answered !== null);
  assert.equal(unityClient.connected, true);
});

test('an instance with no allocated port has no port to connect to', { timeout: 30000, skip: !isLinux }, async () => {
  assert.equal(await resolveTarget(), 'instance');
  assert.equal(unityClient.port, null);

  const result = payload(await handleToolCall({ params: { name: 'game_state', arguments: {} } }));
  assert.equal(result.success, false);
  assert.match(result.message, new RegExp(`No inspector port is known for instance ${SESSION}`));
  assert.match(result.message, /no game of this instance is running/);
});

test('no session id means the user\'s game on the usual port', { timeout: 30000, skip: !isLinux }, async () => {
  delete process.env.CLAUDE_SESSION_ID;
  resetTargetResolution();

  assert.equal(await resolveTarget(), 'steam');
  assert.equal(activeConfig().isAgentInstance, false);
  assert.equal(unityClient.port, STEAM_PORT);

  const { instance, instanceReason } = await instanceField();
  assert.equal(instance, null);
  assert.match(instanceReason, /CLAUDE_SESSION_ID is not set/);
});

// A game running in somebody else's instance, which the user's game must never be confused with
const foreignInstanceReader = () => fakeProcReader({
  900: { comm: LINUX_GAME_COMM, cwd: path.join(root, 'other-session', 'work'), startTicks: 100 },
});

test('a session with no instance still learns where instances live', { timeout: 30000, skip: !isLinux }, async (t) => {
  delete process.env.CLAUDE_SESSION_ID;
  resetTargetResolution();
  setProcReader(foreignInstanceReader());
  t.after(() => { process.env.CLAUDE_SESSION_ID = SESSION; setProcReader(null); });

  assert.equal(await resolveTarget(), 'steam');
  // The launcher is asked whatever this session's id says, since the answer is also what keeps
  // another session's game out of this server's stop_game
  assert.equal(activeConfig().instancesRoot, root);
  assert.equal(await isGameRunning(activeConfig()), false, "another session's instance read as the user's game");
});

test('with no launcher configured every game process is the user\'s', { timeout: 30000, skip: !isLinux }, async (t) => {
  const configured = process.env.BROFORCE_INSTANCE_CMD;
  delete process.env.BROFORCE_INSTANCE_CMD;
  delete process.env.CLAUDE_SESSION_ID;
  resetTargetResolution();
  setProcReader(foreignInstanceReader());
  t.after(() => {
    process.env.BROFORCE_INSTANCE_CMD = configured;
    process.env.CLAUDE_SESSION_ID = SESSION;
    setProcReader(null);
  });

  assert.equal(await resolveTarget(), 'steam');
  // Nothing here knows where instances live, so a game running in one cannot be told from the
  // user's own — the documented behaviour with no launcher configured
  assert.equal(activeConfig().instancesRoot, null);
  assert.equal(await isGameRunning(activeConfig()), true);
});

test('without a configured instance launcher there is no instance', { timeout: 30000, skip: !isLinux }, async (t) => {
  const configured = process.env.BROFORCE_INSTANCE_CMD;
  delete process.env.BROFORCE_INSTANCE_CMD;
  t.after(() => { process.env.BROFORCE_INSTANCE_CMD = configured; });
  resetTargetResolution();

  assert.equal(await resolveTarget(), 'steam');
  assert.equal(activeConfig().isAgentInstance, false);
  assert.equal(unityClient.port, STEAM_PORT);

  const state = payload(await handleToolCall({ params: { name: 'game_state', arguments: {} } }));
  assert.equal(state.target, 'steam');
  assert.equal(state.instance, null);
  assert.match(state.instanceReason, /BROFORCE_INSTANCE_CMD is not set/);
});

test('a malformed session id serves the user\'s game and says why', { timeout: 30000, skip: !isLinux }, async (t) => {
  const valid = process.env.CLAUDE_SESSION_ID;
  process.env.CLAUDE_SESSION_ID = 'not a usable id';
  t.after(() => { process.env.CLAUDE_SESSION_ID = valid; });
  resetTargetResolution();

  assert.equal(await resolveTarget(), 'steam');
  assert.equal(activeConfig().isAgentInstance, false);

  const state = payload(await handleToolCall({ params: { name: 'game_state', arguments: {} } }));
  assert.equal(state.target, 'steam');
  assert.equal(state.instance, null);
  assert.match(state.instanceReason, /not a usable instance id/);
  assert.equal(state.port, STEAM_PORT);
});

test('a launcher without instance mode serves the user\'s game, never a refusal', { timeout: 30000, skip: !isLinux }, async () => {
  resetInstanceModeProbe(false);

  assert.equal(await resolveTarget(), 'steam');
  assert.equal(unityClient.port, STEAM_PORT);

  const { instance, instanceReason } = await instanceField();
  assert.equal(instance, null);
  assert.match(instanceReason, /no instance mode/);
});

test('switching the target re-points the client and drops the other game\'s socket', { timeout: 30000, skip: !isLinux }, async (t) => {
  const inspector = await fakeInspector();
  t.after(() => inspector.close());
  await fs.mkdir(instanceDir, { recursive: true });
  await fs.writeFile(portFile, String(inspector.port));
  ownGame();

  await resolveTarget();
  await unityClient.connect();
  assert.equal(unityClient.connected, true);

  const switched = await setTarget('steam');
  assert.equal(switched.changed, true);
  assert.equal(activeTarget(), 'steam');
  assert.equal(unityClient.port, STEAM_PORT);
  assert.equal(unityClient.connected, false, 'the instance\'s socket survived the switch');
  assert.equal(unityClient.gameConfig.isAgentInstance, false);

  const back = await setTarget('instance');
  assert.equal(back.port, inspector.port);
  assert.equal(unityClient.port, inspector.port);
  assert.equal(unityClient.gameConfig.isAgentInstance, true);

  // The same target twice is not a switch
  assert.equal((await setTarget('instance')).changed, false);
});

test('wait_for_game says so while the instance has no port to connect to', { timeout: 30000, skip: !isLinux }, async () => {
  await resolveTarget();

  const result = payload(await handleToolCall({
    params: { name: 'wait_for_game', arguments: { timeout: 0.3, interval: 0.05 } },
  }));

  assert.equal(result.success, false);
  assert.equal(result.state, 'no-port');
  assert.match(result.message, new RegExp(`No inspector port is known for instance ${SESSION}`));
  assert.doesNotMatch(result.message, /null/);
});

test('a wait picks up the instance\'s game when it comes up mid-wait', { timeout: 30000, skip: !isLinux }, async (t) => {
  const inspector = await fakeInspector();
  t.after(() => inspector.close());
  await fs.mkdir(instanceDir, { recursive: true });
  await fs.writeFile(portFile, String(inspector.port));

  await resolveTarget();
  assert.equal(unityClient.port, null, 'the port counted before any game of ours was running');

  // The port is only ours once a game of ours is running, which happens partway through the wait
  const appears = setTimeout(() => ownGame(), 1500);
  t.after(() => clearTimeout(appears));

  const started = Date.now();
  const result = payload(await handleToolCall({
    params: { name: 'wait_for_game', arguments: { timeout: 8, interval: 0.5 } },
  }));
  const elapsed = Date.now() - started;

  assert.equal(result.success, true, result.message);
  assert.ok(elapsed >= 1500, `answered before the game existed (${elapsed}ms)`);
  assert.ok(elapsed < 7000, `the wait did not pick the game up (${elapsed}ms)`);
});

test('a target switch is refused while a command is in flight', { timeout: 30000, skip: !isLinux }, async (t) => {
  const silent = await fakeInspector({ answers: false });
  t.after(() => silent.close());
  await fs.mkdir(instanceDir, { recursive: true });
  await fs.writeFile(portFile, String(silent.port));
  ownGame();

  await resolveTarget();
  const pending = handleToolCall({ params: { name: 'ping', arguments: {} } });
  await new Promise(resolve => setTimeout(resolve, 200));

  const response = await handleToolCall({ params: { name: 'launch_game', arguments: { steam: true, vanilla: true } } });
  const text = response.content.map((c) => c.text).join('\n');

  assert.equal(response.isError, true, text);
  assert.match(text, /ping/);
  assert.match(text, /in flight/);
  assert.equal(activeTarget(), 'instance', 'the target moved under a command in flight');

  // The wait's own poll disconnects the client, so it is refused on the same ground
  const waiting = await handleToolCall({ params: { name: 'wait_for_game', arguments: { timeout: 1 } } });
  const waitText = waiting.content.map((c) => c.text).join('\n');
  assert.equal(waiting.isError, true, waitText);
  assert.match(waitText, /ping/);
  assert.match(waitText, /in flight/);

  // Launching disconnects the client whatever the target, so the same-target launch is refused too
  const sameTarget = await handleToolCall({ params: { name: 'launch_game', arguments: {} } });
  const sameText = sameTarget.content.map((c) => c.text).join('\n');
  assert.equal(sameTarget.isError, true, sameText);
  assert.match(sameText, /ping/);
  assert.match(sameText, /in flight/);
  assert.deepEqual((await fs.readFile(path.join(root, 'calls.log'), 'utf8').catch(() => ''))
    .split('\n').filter(line => line.includes('launch')), [], 'a refused launch ran the launcher');

  const settled = await pending;
  assert.equal(settled.isError, true, 'the in-flight ping should have timed out on its own');
});

test('UNITY_INSPECTOR_PORT and UNITY_INSPECTOR_LOG belong to the user\'s game alone', { timeout: 30000, skip: !isLinux }, async (t) => {
  const elsewhere = path.join(root, 'elsewhere.log');
  await fs.writeFile(elsewhere, 'a log the user pointed at\n');
  await fs.mkdir(path.dirname(path.join(instanceDir, 'profile/UMM/Core/Log.txt')), { recursive: true });
  await fs.writeFile(path.join(instanceDir, 'profile/UMM/Core/Log.txt'), 'the instance own log\n');
  await fs.writeFile(portFile, '9931');

  process.env.UNITY_INSPECTOR_PORT = '9500';
  process.env.UNITY_INSPECTOR_LOG = elsewhere;
  t.after(() => {
    process.env.UNITY_INSPECTOR_PORT = NO_LISTENER_PORT;
    delete process.env.UNITY_INSPECTOR_LOG;
  });

  ownGame();
  await resolveTarget();
  assert.equal(activeTarget(), 'instance');
  assert.equal(unityClient.port, 9931, 'UNITY_INSPECTOR_PORT must never reach the instance');
  assert.deepEqual(await targetLogPaths(), {
    umm: path.join(instanceDir, 'profile/UMM/Core/Log.txt'),
    player: path.join(instanceDir, 'home/unity3d/Free Lives/Broforce/Player.log'),
  });
  assert.equal(await findLogPath(async () => null, noGameStart), path.join(instanceDir, 'profile/UMM/Core/Log.txt'));

  await setTarget('steam');
  assert.equal(unityClient.port, 9500);
  assert.deepEqual(await targetLogPaths(), { umm: elsewhere, player: null });
  assert.equal(await findLogPath(async () => null, noGameStart), elsewhere);
});

test('game_state carries the target, the instance and the logs with no game answering', { timeout: 30000, skip: !isLinux }, async () => {
  await fs.mkdir(instanceDir, { recursive: true });
  await fs.writeFile(portFile, '9931');
  await fs.writeFile(path.join(root, 'list.json'), instanceListJsonl(8, [
    { id: 'other-session', running: true, pid: 944835, port: 9930, display: ':2' },
  ]));

  const result = payload(await handleToolCall({ params: { name: 'game_state', arguments: {} } }));

  assert.equal(result.success, false);
  assert.ok(result.message, 'the reply says why no game answered');
  assert.equal(result.target, 'instance');
  assert.equal(result.port, null, 'the target port is the one in use, not the one on record');
  assert.deepEqual(result.instance, { id: SESSION, port: 9931, root: instanceDir, stage: stagePath });
  assert.equal(result.instanceReason, undefined);
  assert.equal(result.logs.umm, path.join(instanceDir, 'profile/UMM/Core/Log.txt'));
  assert.equal(result.logs.player, path.join(instanceDir, 'home/unity3d/Free Lives/Broforce/Player.log'));
  assert.deepEqual(result.runningInstances.map(entry => entry.id), ['other-session']);

  const fields = await serverStateFields();
  assert.equal(fields.target, 'instance');
  assert.equal(fields.instance.id, SESSION);

  // With a game of its own running, the target's port is the instance's
  ownGame();
  assert.equal((await serverStateFields()).port, 9931);

  // And on the user's game it is the one the mod listens on
  await setTarget('steam');
  const steam = payload(await handleToolCall({ params: { name: 'game_state', arguments: {} } }));
  assert.equal(steam.target, 'steam');
  assert.equal(steam.port, STEAM_PORT);
  // The session still has an instance; the top-level port is the one this reply is about
  assert.equal(steam.instance.port, 9931);
});

import { NOT_WSL, NO_LISTENER_PORT, NO_TOKEN_FILE } from './support/session.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import fs from 'fs/promises';
import net from 'net';
import os from 'os';
import path from 'path';

import { fakeProcReader, recordingKill, recordingProcReader } from './support/fake-proc.js';
import { reply, startStubServer } from './support/stub-server.js';

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-target-'));
const launchMarker = path.join(scratch, 'launched');
// Listing the tools asks the launch command for its --help, which is no launch
const launcher = path.join(scratch, 'launcher.sh');
await fs.writeFile(launcher, `case "$1" in --help|--args-help) exit 0;; esac\n: > '${launchMarker}'\n`);
process.env.BROFORCE_LAUNCH_CMD = `sh ${launcher}`;

const {
  activeConfig,
  activeTarget,
  buildToolList,
  handleToolCall,
  resetTargetResolution,
  setLaunchResolver,
  staleCodeNotice,
  unityClient,
} = await import('../index.js');
const {
  LINUX_GAME_COMM,
  ownedGameProcesses,
  ownsProcess,
  runningGameDir,
  setKillSignaller,
  setProcReader,
  setWslProbe,
  userGameOutOfReach,
} = await import('../lib/game-process.js');
const { logMirrorPaths } = await import('../lib/remote-files.js');

const isLinux = process.platform === 'linux';
const tokenOf = (seed) => createHash('sha256').update(seed).digest('hex');

const LOCAL_GAME = { 4242: { comm: LINUX_GAME_COMM, cwd: '/home/player/Broforce', startTicks: 100 } };

let kill = recordingKill();
let resolved = 0;
const countingResolver = async () => {
  resolved++;
  throw new Error('a launch was resolved on a remote target');
};

const gameReplies = {
  game_state: { scene: 'Test Evan2', isInGame: false },
  execute_code: { success: true, resultSet: true, result: '1234 2024-05-01' },
  take_screenshot: { path: '/remote/Screenshots/screenshot_1.png' },
  simulate_input: { framesRead: 1 },
};

async function remoteGame(t, { hello, handler, host = '127.0.0.1', port = 0 } = {}) {
  const stub = await startStubServer(handler ?? ((request, socket) => reply(socket, request.id, gameReplies[request.method] ?? {})), { hello, host, port });
  t.after(() => stub.close());
  return stub;
}

async function tokenFile(name, contents) {
  const file = path.join(scratch, name);
  await fs.writeFile(file, `${contents}\n`);
  return file;
}

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const call = (name, args = {}) => handleToolCall({ params: { name, arguments: args } });
const textOf = (response) => response.content.map((c) => c.text).join('\n');

function payload(response) {
  const text = response.content[0].text;
  assert.ok(!text.startsWith('Error: '), text);
  const body = JSON.parse(text);
  assert.equal(Boolean(response.isError), body.success === false, `isError goes with success: false: ${text}`);
  return body;
}

const declare = (remote, extra = {}) => call('launch_game', { remote, ...extra });

test.after(async () => {
  unityClient.disconnect();
  setProcReader(null);
  setKillSignaller(null);
  setLaunchResolver();
  await fs.rm(scratch, { recursive: true, force: true });
});

beforeEach(async () => {
  resetTargetResolution();
  unityClient.disconnect();
  setProcReader(fakeProcReader({}));
  kill = recordingKill();
  setKillSignaller(kill);
  resolved = 0;
  setLaunchResolver(countingResolver);
  process.env.UNITY_INSPECTOR_PORT = NO_LISTENER_PORT;
  process.env.UNITY_INSPECTOR_TOKEN_FILE = NO_TOKEN_FILE;
  delete process.env.UNITY_INSPECTOR_HOST;
  delete process.env.UNITY_INSPECTOR_LOG;
  await fs.rm(launchMarker, { force: true });
});

async function assertNothingLaunched() {
  assert.equal(resolved, 0, 'a launch was resolved');
  await assert.rejects(fs.access(launchMarker), 'a launch command ran');
}

test('a declaration points the server at the remote game, launches nothing, and game_state names it', { timeout: 20000 }, async (t) => {
  const token = tokenOf('remote');
  const stub = await remoteGame(t, { hello: (params) => (params.token === token ? 'accept' : 'refuse') });
  const file = await tokenFile('declared.token', token);

  const declared = payload(await declare({ host: '127.0.0.1', port: stub.port, tokenFile: file }));
  assert.equal(declared.success, true, declared.message);
  assert.equal(declared.target, 'remote');
  assert.equal(declared.state, 'ready');
  assert.deepEqual(declared.remote, { host: '127.0.0.1', port: stub.port, tokenFile: file });
  assert.match(declared.message, new RegExp(`the remote game at 127\\.0\\.0\\.1:${stub.port}, which answered\\. Nothing was launched`));
  assert.equal(activeTarget(), 'remote');

  const state = payload(await call('game_state'));
  assert.equal(state.target, 'remote');
  assert.deepEqual(state.remote, { host: '127.0.0.1', port: stub.port, tokenFile: file });
  assert.equal(state.port, stub.port);
  assert.deepEqual(state.logs, logMirrorPaths(`127.0.0.1:${stub.port}`), 'the logs are the local mirrors, whether or not a read made them yet');
  assert.deepEqual(state.build, { store: null, storeBuild: null, gameDir: null, version: 1234, buildDate: '2024-05-01' });
  assert.equal(state.scene, 'Test Evan2');
  await assertNothingLaunched();
});

test('each malformed remote field, a nested null, an unknown key and each launch flag is refused, with the target unchanged', { timeout: 30000 }, async (t) => {
  const stub = await remoteGame(t);
  const file = await tokenFile('malformed.token', tokenOf('malformed'));
  const good = { host: '127.0.0.1', port: stub.port, tokenFile: file };
  const refusals = [
    [{ ...good, host: '' }, /host must be a host name or address alone/],
    [{ ...good, host: 'game box' }, /host must be/],
    [{ ...good, host: 'tcp://game' }, /host must be/],
    [{ ...good, host: 'game/inspector' }, /host must be/],
    [{ ...good, host: 'game:9999' }, /host must be/],
    [{ ...good, host: '[game]' }, /host must be/],
    [{ ...good, host: 5 }, /remote\.host must be a string/],
    [{ ...good, port: 0 }, /port must be an integer from 1 to 65535, got 0/],
    [{ ...good, port: 65536 }, /port must be an integer from 1 to 65535/],
    [{ ...good, port: 1.5 }, /remote\.port must be an integer/],
    [{ ...good, port: '9999' }, /remote\.port must be an integer/],
    [{ ...good, tokenFile: 'relative/remote.token' }, /tokenFile must be an absolute path on this machine/],
    [{ ...good, host: null }, /needs host/],
    [{ ...good, tokenFile: null }, /needs tokenFile/],
    [{ host: '127.0.0.1', tokenFile: file }, /needs port/],
    [{ ...good, user: 'me' }, /has no key "user"; it takes host, port and tokenFile/],
    ['127.0.0.1', /remote must be an object/],
  ];
  const flags = [{ steam: true }, { vanilla: true }, { restart: true }, { launchArgs: '--fast' }];

  const assertRefusedFrom = async (target) => {
    const port = unityClient.port;
    for (const [remote, reason] of refusals) {
      const response = await declare(remote);
      assert.equal(response.isError, true, `${JSON.stringify(remote)} was accepted`);
      assert.match(textOf(response), reason, JSON.stringify(remote));
      assert.equal(activeTarget(), target);
      assert.equal(unityClient.port, port);
    }
    for (const flag of flags) {
      const response = await declare(good, flag);
      assert.equal(response.isError, true, `${JSON.stringify(flag)} was accepted`);
      assert.match(textOf(response), new RegExp(`remote launches nothing, so it takes no ${Object.keys(flag)[0]}`));
      assert.equal(activeTarget(), target);
    }
  };

  await assertRefusedFrom('steam');
  assert.equal(payload(await declare(good)).success, true);
  const connections = stub.connectionCount;
  await assertRefusedFrom('remote');
  assert.equal(stub.connectionCount, connections, 'a refused re-declaration dropped the socket');
  await assertNothingLaunched();
});

test('an IPv6 literal is taken with or without its brackets', { timeout: 20000 }, async () => {
  const file = await tokenFile('ipv6.token', tokenOf('ipv6'));
  for (const host of ['[::1]', '::1']) {
    const declared = payload(await declare({ host, port: await unusedPort(), tokenFile: file }));
    assert.equal(declared.target, 'remote', host);
    assert.equal(declared.remote.host, '::1', host);
    assert.match(declared.message, /the remote game at \[::1\]:\d+/, host);
  }
});

test('a declaration is refused while a command is in flight and while a bound call runs, one on a remote target included', { timeout: 30000 }, async (t) => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const stub = await remoteGame(t, {
    handler: async (request, socket) => {
      if (request.method === 'execute_code') await held;
      reply(socket, request.id, gameReplies[request.method] ?? {});
    },
  });
  const file = await tokenFile('bound.token', tokenOf('bound'));
  const remote = { host: '127.0.0.1', port: stub.port, tokenFile: file };
  assert.equal(payload(await declare(remote)).success, true);

  const running = call('execute_code', { code: '1' });
  while (unityClient.inFlightCommands().length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
  const inFlight = await declare({ ...remote, host: '127.0.0.2' });
  assert.equal(inFlight.isError, true);
  assert.match(textOf(inFlight), /Cannot launch while execute_code is still in flight on the remote target/);
  release();
  await running;

  const script = path.join(scratch, 'waiting.json');
  await fs.writeFile(script, JSON.stringify({ name: 'waiting', steps: [{ command: 'ping', wait: 1500 }] }));
  const boundRefusal = async (on) => {
    const run = call('run_test_script', { script });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const bound = await declare({ ...remote, host: '127.0.0.2' });
    assert.equal(bound.isError, true);
    assert.match(
      textOf(bound),
      new RegExp(`Cannot switch to the remote game at 127\\.0\\.0\\.2:${stub.port} while run_test_script is still running on ${on}`),
    );
    await run;
  };
  await boundRefusal(`the remote game at 127\\.0\\.0\\.1:${stub.port}`);
  assert.equal(activeConfig().remote.host, '127.0.0.1', 'a refused declaration moved the target');

  resetTargetResolution();
  unityClient.disconnect();
  process.env.UNITY_INSPECTOR_PORT = String(stub.port);
  await boundRefusal("the user's game");
  assert.equal(activeTarget(), 'steam', 'a refused first declaration moved the target');
});

test('re-declaring the same port on another host gets a fresh socket, and re-declaring at all drops it', { timeout: 20000, skip: !isLinux }, async (t) => {
  const first = await remoteGame(t);
  const second = await remoteGame(t, { host: '127.0.0.2', port: first.port });
  const file = await tokenFile('rehost.token', tokenOf('rehost'));

  assert.equal(payload(await declare({ host: '127.0.0.1', port: first.port, tokenFile: file })).success, true);
  assert.equal(first.connectionCount, 1);
  assert.equal(payload(await declare({ host: '127.0.0.2', port: first.port, tokenFile: file })).success, true);
  assert.equal(second.connectionCount, 1, 'the second host was never connected to');
  payload(await call('ping'));
  assert.deepEqual(second.lines.map((line) => line.method), ['ping', 'ping']);
  assert.equal(first.lines.filter((line) => line.method === 'ping').length, 1, 'the old host answered after the re-declaration');

  assert.equal(payload(await declare({ host: '127.0.0.2', port: first.port, tokenFile: file })).success, true);
  assert.equal(second.connectionCount, 2, 'a re-declaration kept the old socket');
});

test('{} and { steam: true } switch back, saying the remote game was left as it was', { timeout: 30000 }, async (t) => {
  setLaunchResolver();
  const remote = await remoteGame(t);
  const local = await remoteGame(t);
  process.env.UNITY_INSPECTOR_PORT = String(local.port);
  const file = await tokenFile('switch.token', tokenOf('switch'));
  const steamToken = await tokenFile('steam.token', tokenOf('steam'));
  process.env.UNITY_INSPECTOR_TOKEN_FILE = steamToken;

  for (const args of [{}, { steam: true }]) {
    assert.equal(payload(await declare({ host: '127.0.0.1', port: remote.port, tokenFile: file })).target, 'remote');
    const back = payload(await call('launch_game', args));
    assert.equal(back.target, 'steam', JSON.stringify(args));
    assert.equal(back.alreadyRunning, true, back.message);
    assert.match(back.targetNote, new RegExp(`The remote game at 127\\.0\\.0\\.1:${remote.port} was left as it was`));
    assert.equal(unityClient.port, local.port);
  }
  await assert.rejects(fs.access(launchMarker), 'switching back launched over a running game');
});

const ALL_TOOL_ARGS = (file, port) => ({
  ping: {},
  list_gameobjects: {},
  inspect_gameobject: { path: '/Player' },
  inspect_component: { path: '/Player', componentType: 'Transform' },
  query_gameobjects: { namePattern: 'Player' },
  inspect_player: {},
  list_enemies: {},
  take_screenshot: {},
  execute_code: { code: '1' },
  modify_component: { path: '/Player', component: 'Transform', properties: { x: 1 } },
  teleport_player: { x: 1, y: 1 },
  set_player_health: { health: 1 },
  spawn_entity: { type: 'Mook', x: 1, y: 1 },
  trace_spawns: { action: 'read' },
  set_game_speed: { speed: 1 },
  list_campaigns: {},
  go_to_level: { campaignIndex: 0, levelIndex: 0 },
  swap_bro: { broName: 'Rambro' },
  list_bros: {},
  restart_level: {},
  simulate_input: { action: 'jump' },
  list_test_scripts: {},
  wait_for_game: { timeout: 0 },
  game_state: {},
  read_log: {},
  run_test_script: { script: path.join(scratch, 'fence.json') },
  execute_script: { path: path.join(scratch, 'Fence.cs') },
  list_scripts: {},
  unload_script: { path: 'Fence' },
  capture_animations: { out: path.join(scratch, 'fence-capture'), timeout: 1 },
  launch_game: { remote: { host: '127.0.0.1', port, tokenFile: file } },
  stop_game: {},
});

test('no tool on a remote target reads the process table, signals or launches anything', { timeout: 120000 }, async (t) => {
  const stub = await remoteGame(t);
  const file = await tokenFile('fence.token', tokenOf('fence'));
  await fs.writeFile(path.join(scratch, 'fence.json'), JSON.stringify({ name: 'fence', steps: [{ command: 'ping' }] }));
  await fs.writeFile(path.join(scratch, 'Fence.cs'), 'public static class Fence { public static void Main() {} }\n');
  assert.equal(payload(await declare({ host: '127.0.0.1', port: stub.port, tokenFile: file })).success, true);

  const { reader, calls } = recordingProcReader(LOCAL_GAME);
  setProcReader(reader);
  const args = ALL_TOOL_ARGS(file, stub.port);
  const tools = (await buildToolList()).map((tool) => tool.name);
  assert.deepEqual(tools.filter((name) => !(name in args)), [], 'a tool the fence does not call');

  for (const name of tools) {
    await call(name, args[name]);
    assert.equal(activeTarget(), 'remote', `${name} moved the target`);
    assert.deepEqual(calls, [], `${name} read the process table`);
  }
  assert.deepEqual(kill.calls, [], 'a signal was sent');
  await assertNothingLaunched();
});

test('runningGameDir names no directory for a remote config, on Linux and on Windows', async () => {
  const remote = { isAgentInstance: false, declared: true, remote: { host: '127.0.0.1', port: 9000, tokenFile: '/tmp/x' } };
  const { reader, calls } = recordingProcReader(LOCAL_GAME);
  const ran = [];
  const run = async (...argv) => { ran.push(argv); return { code: 0, stdout: '[]', stderr: '' }; };

  assert.equal(await runningGameDir(remote, { reader, platform: 'linux' }), null);
  assert.equal(await runningGameDir(remote, { reader, platform: 'win32', run }), null);
  assert.deepEqual(calls, []);
  assert.deepEqual(ran, []);

  await assert.rejects(ownedGameProcesses(remote, reader), /Cannot list the game's processes: the remote game at 127\.0\.0\.1:9000 runs on another machine/);
  assert.deepEqual(calls, [], 'the scan ran before the reach check');
  assert.throws(() => ownsProcess({ pid: 1, cwd: '/' }, remote), /No local process belongs to a remote target/);
  assert.match(userGameOutOfReach({ ...remote, isAgentInstance: true }), /runs on another machine/, 'the flag decides before anything else');
});

test('stop_game is refused on a remote target, and a local game on the same port is left untouched', { timeout: 20000 }, async (t) => {
  const stub = await remoteGame(t);
  process.env.UNITY_INSPECTOR_PORT = String(stub.port);
  const file = await tokenFile('stop.token', tokenOf('stop'));
  assert.equal(payload(await declare({ host: '127.0.0.1', port: stub.port, tokenFile: file })).success, true);
  const { reader, calls } = recordingProcReader(LOCAL_GAME);
  setProcReader(reader);
  const sent = stub.lines.length;

  for (const args of [{}, { remove: true }]) {
    const stopped = payload(await call('stop_game', args));
    assert.equal(stopped.success, false);
    assert.equal(stopped.target, 'remote');
    assert.match(stopped.message, /^Nothing was stopped: the remote game at 127\.0\.0\.1:\d+ runs on another machine.*stop_game touches nothing on this machine/);
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(kill.calls, []);
  assert.equal(stub.lines.length, sent, 'stop_game sent the remote game a command');
});

test('the declared token file is read again on every connect, never UNITY_INSPECTOR_TOKEN_FILE, and a refusal names it', { timeout: 20000 }, async (t) => {
  let accepted = tokenOf('first');
  const stub = await remoteGame(t, { hello: (params) => (params.token === accepted ? 'accept' : 'refuse') });
  process.env.UNITY_INSPECTOR_TOKEN_FILE = await tokenFile('user-game.token', tokenOf('user-game'));
  const file = await tokenFile('reread.token', tokenOf('first'));

  assert.equal(payload(await declare({ host: '127.0.0.1', port: stub.port, tokenFile: file })).success, true);
  accepted = tokenOf('second');
  await fs.writeFile(file, tokenOf('second'));
  unityClient.disconnect();
  payload(await call('ping'));
  assert.deepEqual(stub.hellos.map((hello) => hello.token), [tokenOf('first'), tokenOf('second')]);

  accepted = tokenOf('third');
  unityClient.disconnect();
  const refused = await call('ping');
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), new RegExp(`The Unity Inspector Mod refused the token in ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`));
  assert.match(textOf(refused), /Copy the game's current unity-inspector-<port>\.token from its machine.*the next command reads the file again/);
});

test('a token file holding anything but 64 lowercase hex characters sends no token, on every target, and the refusal names it', { timeout: 20000 }, async (t) => {
  const stub = await remoteGame(t, { hello: 'refuse' });
  const cases = ['not-a-token', tokenOf('upper').toUpperCase(), tokenOf('short').slice(0, 63), `${tokenOf('long')}0`];

  for (const contents of cases) {
    const file = await tokenFile('bad.token', contents);
    resetTargetResolution();
    unityClient.disconnect();
    const declared = payload(await declare({ host: '127.0.0.1', port: stub.port, tokenFile: file }));
    assert.equal(declared.state, 'handshake-refused', contents);
    assert.equal(stub.hellos.at(-1).token, null, contents);
    assert.match(declared.message, /bad\.token holds no inspector token: the Unity Inspector Mod writes one as 64 lowercase hex characters/);
    assert.match(declared.message, /Copy the game's current unity-inspector-<port>\.token/);
  }

  resetTargetResolution();
  unityClient.disconnect();
  process.env.UNITY_INSPECTOR_PORT = String(stub.port);
  process.env.UNITY_INSPECTOR_TOKEN_FILE = await tokenFile('steam-bad.token', 'not-a-token');
  const steam = await call('ping');
  assert.equal(stub.hellos.at(-1).token, null);
  assert.match(textOf(steam), /steam-bad\.token holds no inspector token: .* It writes unity-inspector-\d+\.token again when its server starts\./);
});

test('nothing listening on a loopback port is a tunnel that is not running', { timeout: 20000 }, async () => {
  const port = await unusedPort();
  const file = await tokenFile('tunnel.token', tokenOf('tunnel'));
  const declared = payload(await declare({ host: '127.0.0.1', port, tokenFile: file }));
  assert.equal(declared.success, false);
  assert.equal(declared.target, 'remote', 'the target stays declared even when the game is unreachable');
  assert.equal(declared.state, 'unknown');
  const tunnel = new RegExp(`Nothing is listening on 127\\.0\\.0\\.1:${port}, so the ssh tunnel to the remote game is not running\\. Start it with ssh -N -L ${port}:127\\.0\\.0\\.1:<mod port> <host>`);
  assert.match(declared.message, tunnel);

  const ping = await call('ping');
  assert.match(textOf(ping), tunnel);
  assert.doesNotMatch(textOf(ping), /Game is not running/);
});

test('a direct host\'s connect error names the code, the remote-connections setting and the firewall', { timeout: 20000, skip: !isLinux }, async () => {
  const port = await unusedPort();
  const file = await tokenFile('direct.token', tokenOf('direct'));
  const declared = payload(await declare({ host: '0.0.0.0', port, tokenFile: file }));
  assert.equal(declared.state, 'unknown');
  assert.match(
    declared.message,
    new RegExp(`Could not connect to the remote game at 0\\.0\\.0\\.0:${port} \\(ECONNREFUSED\\): its Unity Inspector Mod answers another machine only with its "Allow remote connections" setting on and its port open in that machine's firewall`),
  );
});

test('a close during the hello says nothing is behind the tunnel', { timeout: 20000 }, async (t) => {
  const stub = await remoteGame(t, { hello: 'close' });
  const file = await tokenFile('closed.token', tokenOf('closed'));
  const declared = payload(await declare({ host: '127.0.0.1', port: stub.port, tokenFile: file }));
  assert.equal(declared.state, 'connection-dropped');
  assert.match(declared.message, /took the connection and closed it during the handshake, so nothing is behind the tunnel: the game is not running on its machine, its Unity Inspector Mod's server is stopped, or the tunnel forwards to another port/);
});

test('a token refusal names tokenFile and says to copy the token again', { timeout: 20000 }, async (t) => {
  const stub = await remoteGame(t, { hello: 'refuse' });
  const file = await tokenFile('stale.token', tokenOf('stale'));
  const declared = payload(await declare({ host: '127.0.0.1', port: stub.port, tokenFile: file }));
  assert.equal(declared.state, 'handshake-refused');
  assert.ok(declared.message.includes(`The Unity Inspector Mod refused the token in ${file}. Invalid token Copy the game's current unity-inspector-<port>.token`), declared.message);

  await fs.rm(file);
  unityClient.disconnect();
  assert.match(textOf(await call('ping')), new RegExp(`No token file at ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\. Copy the game's current`));
});

test('a close under a command says the command may have run, and names the tunnel only on a loopback host', { timeout: 20000 }, async (t) => {
  const handler = (request, socket) => (request.method === 'execute_code' ? socket.destroy() : reply(socket, request.id, {}));
  const file = await tokenFile('dropped.token', tokenOf('dropped'));
  const hosts = isLinux ? ['127.0.0.1', '0.0.0.0'] : ['127.0.0.1'];
  for (const host of hosts) {
    const stub = await remoteGame(t, { handler, host });
    assert.equal(payload(await declare({ host, port: stub.port, tokenFile: file })).success, true);
    const response = await call('execute_code', { code: '1' });
    assert.equal(response.isError, true);
    assert.match(textOf(response), new RegExp(`The connection to the remote game at ${host.replace(/\./g, '\\.')}:${stub.port} closed under the command, which may have run`));
    if (host === '127.0.0.1') assert.match(textOf(response), /server stopped, or the tunnel dropped\. Check the game/);
    else assert.match(textOf(response), /server stopped\. Check the game/);
  }
});

test('wait_for_game on a remote target never answers no-process', { timeout: 20000 }, async (t) => {
  const file = await tokenFile('wait.token', tokenOf('wait'));
  const closing = await remoteGame(t, { hello: 'close' });
  for (const port of [await unusedPort(), closing.port]) {
    payload(await declare({ host: '127.0.0.1', port, tokenFile: file }));
    const waited = payload(await call('wait_for_game', { timeout: 0.2, interval: 0.05 }));
    assert.equal(waited.success, false);
    assert.notEqual(waited.state, 'no-process', waited.message);
    assert.doesNotMatch(waited.message, /No Broforce process/);
  }
});

test('a non-loopback UNITY_INSPECTOR_HOST gives the steam target the remote flag, and { steam: true } there only points and pings', { timeout: 30000, skip: !isLinux }, async (t) => {
  const stub = await remoteGame(t, { hello: (params) => (params.token === tokenOf('env') ? 'accept' : 'refuse') });
  process.env.UNITY_INSPECTOR_HOST = '0.0.0.0';
  process.env.UNITY_INSPECTOR_PORT = String(stub.port);
  const file = await tokenFile('env.token', tokenOf('env'));
  process.env.UNITY_INSPECTOR_TOKEN_FILE = file;
  resetTargetResolution();
  setLaunchResolver();

  assert.equal(activeConfig().remote?.host, '0.0.0.0');
  for (const args of [{ steam: true, restart: true }, { steam: true, vanilla: true }, { restart: true }]) {
    const refused = await call('launch_game', args);
    assert.equal(refused.isError, true, JSON.stringify(args));
    assert.match(textOf(refused), /launch_game takes no (restart|vanilla) here: the user's game runs on 0\.0\.0\.0 \(UNITY_INSPECTOR_HOST\)/);
  }
  for (const args of [{ steam: true }, {}]) {
    const pointed = payload(await call('launch_game', args));
    assert.equal(pointed.success, true, pointed.message);
    assert.equal(pointed.target, 'steam');
    assert.match(pointed.message, /Nothing was launched/);
  }
  await assert.rejects(fs.access(launchMarker), 'the env path launched a game');
  assert.equal(stub.hellos.at(-1).token, tokenOf('env'));

  const state = payload(await call('game_state'));
  assert.deepEqual(state.remote, { host: '0.0.0.0', port: stub.port, tokenFile: file });
  assert.deepEqual(state.logs, logMirrorPaths(`0.0.0.0:${stub.port}`));
  const log = path.join(scratch, 'Player.log');
  await fs.writeFile(log, 'a line\n');
  process.env.UNITY_INSPECTOR_LOG = log;
  assert.deepEqual(payload(await call('game_state')).logs, { umm: null, player: log }, 'UNITY_INSPECTOR_LOG stays authoritative');
  const sent = stub.lines.length;
  assert.deepEqual(payload(await call('read_log')).path, log);
  assert.equal(stub.lines.length, sent, 'read_log fetched the remote log over a UNITY_INSPECTOR_LOG copy');

  const stopped = payload(await call('stop_game'));
  assert.equal(stopped.success, false);
  assert.match(stopped.message, /^Nothing was stopped: the user's game runs on 0\.0\.0\.0 \(UNITY_INSPECTOR_HOST\)/);
  assert.deepEqual(kill.calls, []);

  delete process.env.UNITY_INSPECTOR_TOKEN_FILE;
  unityClient.disconnect();
  assert.match(textOf(await call('ping')), /its token is read from UNITY_INSPECTOR_TOKEN_FILE alone, which is not set/);
});

test('a loopback UNITY_INSPECTOR_HOST stays this machine\'s game, and so does any host under WSL', (t) => {
  t.after(() => setWslProbe(NOT_WSL));
  for (const host of ['127.0.0.1', 'localhost', '::1']) {
    process.env.UNITY_INSPECTOR_HOST = host;
    resetTargetResolution();
    assert.equal(activeConfig().remote, undefined, host);
  }
  process.env.UNITY_INSPECTOR_HOST = '192.0.2.1';
  setWslProbe(() => true);
  resetTargetResolution();
  assert.equal(activeConfig().remote, undefined, 'WSL reaches the Windows side as before');
});

test('the stale-code notice says a restart forgets the declared remote', { timeout: 20000 }, async (t) => {
  const stub = await remoteGame(t);
  const file = await tokenFile('notice.token', tokenOf('notice'));
  assert.doesNotMatch(staleCodeNotice(['index.js']), /remote/);
  payload(await declare({ host: '127.0.0.1', port: stub.port, tokenFile: file }));
  for (const isError of [false, true]) {
    assert.match(
      staleCodeNotice(['index.js'], { isError }),
      /A restart forgets the remote game declared with launch_game \{ remote \} and puts the target back on this session's default; declare it again after the restart\.$/,
    );
  }
});

test('launch_game lists its remote object and game_state its remote target', async () => {
  const tools = await buildToolList();
  const { remote } = tools.find((tool) => tool.name === 'launch_game').inputSchema.properties;
  assert.equal(remote.type, 'object');
  assert.deepEqual(
    Object.fromEntries(Object.entries(remote.properties).map(([key, schema]) => [key, schema.type])),
    { host: 'string', port: 'integer', tokenFile: 'string' },
  );
  assert.match(tools.find((tool) => tool.name === 'game_state').description, /`target` \(`instance`, `steam`, `remote`/);
});

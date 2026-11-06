import './support/session.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SESSION_ID_RE,
  instanceConfig,
  resetInstanceIdWarning,
  sessionInstanceId,
  steamConfig,
  withRoot,
} from '../lib/instance.js';
import { resolveLaunchCommand, summarizeInstanceList } from '../lib/game-process.js';
import { defaultPort, DEFAULT_PORT } from '../lib/unity-client.js';

const SESSION = '0f9c1b2a-4d5e-4f60-9a3b-7c8d9e0f1a2b';
const options = { platform: 'linux' };
// What the launcher reports in its `instance list --json` header; the server assumes no location
const INSTANCES_ROOT = '/var/lib/agent-games/instances';
const LAUNCHER = '/opt/launchers/game-launcher';
const withId = (id, extra = {}) => ({ CLAUDE_SESSION_ID: id, BROFORCE_INSTANCE_CMD: LAUNCHER, ...extra });

test('the session id derives every per-instance path from the launcher\'s root', () => {
  const derived = instanceConfig(withId(SESSION), options);
  // No path is known before the launcher has said where it keeps its instances
  assert.equal(derived.instancesRoot, null);
  assert.equal(derived.root, null);
  assert.equal(derived.workDir, undefined);
  assert.equal(derived.ownerFile, undefined);
  assert.equal(derived.stagePath, null);

  const config = withRoot(derived, INSTANCES_ROOT);
  const root = `${INSTANCES_ROOT}/${SESSION}`;

  assert.equal(config.id, SESSION);
  assert.equal(config.isAgentInstance, true);
  assert.equal(config.reason, null);
  assert.equal(config.instancesRoot, INSTANCES_ROOT);
  assert.equal(config.stageRoot, null);
  assert.equal(config.root, root);
  assert.equal(config.workDir, `${root}/work`);
  assert.equal(config.pidfile, `${root}/game.pid`);
  assert.equal(config.portFile, `${root}/port`);
  assert.equal(config.launchLog, `${root}/launch.log`);
  // A header naming no stage root leaves the session no stage of its own
  assert.equal(config.stagePath, null);
  assert.equal(config.ummLog, `${root}/profile/UMM/Core/Log.txt`);
  assert.equal(config.unityDataDir, `${root}/home/unity3d/Free Lives/Broforce`);
  assert.equal(config.playerLog, `${config.unityDataDir}/Player.log`);
  assert.equal(config.ownerFile, `${root}/owner.pid`);
  assert.equal(config.launchCommand, LAUNCHER);
  // The launcher allocates the port and writes it to the instance; the server never asks for one
  assert.deepEqual(config.launchArgs, ['instance', SESSION, 'launch']);
  assert.ok(!config.launchArgs.includes('--port'));
  assert.deepEqual(config.stopArgs, ['instance', SESSION, 'stop']);
  assert.deepEqual(config.removeArgs, ['instance', SESSION, 'remove']);
  assert.deepEqual(config.listArgs, ['instance', 'list', '--json']);
  assert.equal(config.port, undefined, 'the port is read back, never derived');
});

test('no session id means the user\'s game', () => {
  for (const env of [{}, withId(''), withId('   ')]) {
    const config = instanceConfig(env, options);
    assert.equal(config.id, null, JSON.stringify(env));
    assert.equal(config.isAgentInstance, false);
    assert.equal(config.instancesRoot, null);
    assert.equal(config.workDir, undefined);
    assert.match(config.reason, /CLAUDE_SESSION_ID is not set/);
  }
});

test('a malformed session id is reported once and then treated as absent', () => {
  const warnings = [];
  const warn = (message) => warnings.push(message);

  for (const bad of ['has spaces', 'x'.repeat(65), 'slash/id', 'dotted.id', 'quote"id']) {
    resetInstanceIdWarning();
    warnings.length = 0;
    const answer = sessionInstanceId(withId(bad), { ...options, warn });
    assert.equal(answer.id, null, bad);
    assert.match(answer.reason, /not a usable instance id/);
    assert.equal(warnings.length, 1, `no warning for ${bad}`);
    assert.match(warnings[0], /CLAUDE_SESSION_ID/);

    // The same bad id is not worth saying twice
    sessionInstanceId(withId(bad), { ...options, warn });
    assert.equal(warnings.length, 1, `the warning repeated for ${bad}`);

    assert.doesNotThrow(() => instanceConfig(withId(bad), { ...options, warn }));
    assert.equal(instanceConfig(withId(bad), { ...options, warn }).isAgentInstance, false);
  }

  for (const good of [SESSION, 'a', 'A_b-1', 'x'.repeat(64)]) {
    assert.equal(SESSION_ID_RE.test(good), true, good);
    assert.equal(sessionInstanceId(withId(good), options).id, good);
  }
});

test('without a configured launcher there is no instance', () => {
  for (const env of [{ CLAUDE_SESSION_ID: SESSION }, { CLAUDE_SESSION_ID: SESSION, BROFORCE_INSTANCE_CMD: '  ' }]) {
    const config = instanceConfig(env, options);
    assert.equal(config.isAgentInstance, false, JSON.stringify(env));
    assert.equal(config.id, null);
    assert.match(config.reason, /BROFORCE_INSTANCE_CMD is not set/);
  }

  // An unreadable setting is a reason, never a throw
  const unbalanced = instanceConfig(withId(SESSION, { BROFORCE_INSTANCE_CMD: "launcher 'oops" }), options);
  assert.equal(unbalanced.isAgentInstance, false);
  assert.match(unbalanced.reason, /could not be read as a command/);
});

test('the launcher setting carries its own leading arguments', () => {
  const config = instanceConfig(withId(SESSION, { BROFORCE_INSTANCE_CMD: '"/opt/my launchers/run" --quiet' }), options);

  assert.equal(config.launchCommand, '/opt/my launchers/run');
  assert.deepEqual(config.launchArgs, ['--quiet', 'instance', SESSION, 'launch']);
  assert.deepEqual(config.stopArgs, ['--quiet', 'instance', SESSION, 'stop']);
  assert.deepEqual(config.removeArgs, ['--quiet', 'instance', SESSION, 'remove']);
  assert.deepEqual(config.listArgs, ['--quiet', 'instance', 'list', '--json']);

  assert.deepEqual(config.leadingArgs, ['--quiet']);
});

test('instances are a Linux arrangement, whatever the session id says', () => {
  for (const platform of ['win32', 'darwin']) {
    const config = instanceConfig(withId(SESSION), { ...options, platform });
    assert.equal(config.isAgentInstance, false, platform);
    assert.match(config.reason, /not on Linux/);
  }
});

test('the root the launcher reports is the only root there is', () => {
  const elsewhere = withRoot(instanceConfig(withId(SESSION), options), '/srv/games/instances');
  assert.equal(elsewhere.root, `/srv/games/instances/${SESSION}`);
  assert.equal(elsewhere.workDir, `/srv/games/instances/${SESSION}/work`);

  // A launcher that stages instances elsewhere says so in the same header
  const staged = withRoot(instanceConfig(withId(SESSION), options), INSTANCES_ROOT, { stageRoot: '/srv/stage' });
  assert.equal(staged.stageRoot, '/srv/stage');
  assert.equal(staged.stagePath, `/srv/stage/${SESSION}/UMM`);

  for (const nothing of [undefined, null, '', 42]) {
    assert.throws(() => withRoot(instanceConfig(withId(SESSION), options), nothing), /instances root/);
  }
});

test('the user\'s game config owns no instance, and takes the same root', () => {
  const config = steamConfig();
  assert.equal(config.isAgentInstance, false);
  assert.equal(config.id, null);
  assert.equal(config.instancesRoot, null);

  // The rule that tells the user's game from an instance's is the instances root, once it is known
  const rooted = withRoot(config, INSTANCES_ROOT);
  assert.equal(rooted.instancesRoot, INSTANCES_ROOT);
  assert.equal(rooted.isAgentInstance, false);
  assert.equal(rooted.workDir, undefined);
});

test('UNITY_INSPECTOR_PORT is the user\'s game and never an instance', () => {
  assert.equal(defaultPort({}), DEFAULT_PORT);
  assert.equal(defaultPort(withId(SESSION)), DEFAULT_PORT, 'a session id derives no port');
  assert.equal(defaultPort({ UNITY_INSPECTOR_PORT: '9500' }), 9500);
  assert.equal(defaultPort({ UNITY_INSPECTOR_PORT: 'nope' }), DEFAULT_PORT);
});

test('an instance launches through the launcher\'s instance mode, whatever the environment says', async () => {
  const config = instanceConfig(withId(SESSION), options);

  const derived = await resolveLaunchCommand({}, {}, 'linux', config);
  assert.equal(derived.source, 'instance');
  assert.equal(derived.command, LAUNCHER);
  assert.deepEqual(derived.args, ['instance', SESSION, 'launch']);
  assert.deepEqual(derived.ignoredArgs, []);

  // Both the vanilla flag and any launchArgs land after the subcommand
  assert.deepEqual(
    (await resolveLaunchCommand({ vanilla: true, extraArgs: ['-m'] }, {}, 'linux', config)).args,
    ['instance', SESSION, 'launch', '--vanilla', '-m'],
  );

  // BROFORCE_LAUNCH_CMD belongs to the user's game: an instance is never launched by it
  const overridden = await resolveLaunchCommand({}, { BROFORCE_LAUNCH_CMD: 'other-launcher' }, 'linux', config);
  assert.equal(overridden.source, 'instance');
  assert.deepEqual(overridden.args, ['instance', SESSION, 'launch']);

  const steam = await resolveLaunchCommand({}, { BROFORCE_LAUNCH_CMD: 'other-launcher' }, 'linux', steamConfig());
  assert.equal(steam.source, 'BROFORCE_LAUNCH_CMD');
  assert.equal(steam.command, 'other-launcher');
});

test('the launcher\'s instance list is read as the JSON Lines it prints', () => {
  // Captured from the launcher with no games running
  const idle = [
    '{"instancesRoot":"/var/lib/agent-games/instances","root":"/opt/launcher/game","cap":8}',
    '{"id":"1","running":0,"pid":null,"port":null,"display":"","last_launch":1788687953,"stale":0}',
    '{"id":"2","running":0,"pid":null,"port":null,"display":"","last_launch":1788676282,"stale":0}',
    '',
  ].join('\n');

  const quiet = summarizeInstanceList(idle);
  // instancesRoot is where this launcher keeps its instances, and the only place it is said; the
  // launcher's own root is its business and never a path of this server's
  assert.equal(quiet.instancesRoot, INSTANCES_ROOT);
  assert.equal(quiet.root, undefined, "the launcher's own game root was read as something");
  assert.equal(quiet.stageRoot, null);
  assert.equal(quiet.cap, 8);
  assert.deepEqual(quiet.ids, []);
  assert.equal(quiet.count, 0);

  const withRunning = summarizeInstanceList([
    '{"instancesRoot":"/var/lib/agent-games/instances","cap":8}',
    '{"id":"live-a-49cf67","running":1,"pid":944835,"port":9900,"display":":2","last_launch":1788687953,"stale":0}',
    '{"id":"2","running":0,"pid":null,"port":null,"display":"","last_launch":1788676282,"stale":0}',
  ].join('\n'));
  assert.equal(withRunning.cap, 8);
  assert.deepEqual(withRunning.ids, ['live-a-49cf67']);
  assert.deepEqual(withRunning.running, [
    { id: 'live-a-49cf67', port: 9900, last_launch: 1788687953, stale: 0 },
  ]);

  // One unreadable line is one line, not the answer
  const noisy = summarizeInstanceList([
    'warning: profile sync skipped',
    '{"instancesRoot":"/x","cap":4}',
    '{"id":"one","running":1,"port":9901,"last_launch":1,"stale":1}',
    '{"id":"two","running":',
  ].join('\n'));
  assert.equal(noisy.cap, 4);
  assert.deepEqual(noisy.ids, ['one']);
  assert.equal(noisy.running[0].stale, 1);

  // A launcher that caps nothing reports no cap, or reports it null, and both mean no cap
  assert.equal(summarizeInstanceList('{"instancesRoot":"/x"}\n{"id":"one","running":1}').cap, null);
  const uncapped = summarizeInstanceList('{"instancesRoot":"/x","cap":null}\n{"id":"one","running":1}');
  assert.equal(uncapped.cap, null);
  assert.deepEqual(uncapped.ids, ['one']);

  // A launcher that stages instances elsewhere reports that in the same header
  const staged = summarizeInstanceList('{"instancesRoot":"/x","stageRoot":"/y","cap":4}\n{"id":"one","running":1}');
  assert.equal(staged.instancesRoot, '/x');
  assert.equal(staged.stageRoot, '/y');

  // A launcher that reports only its own root has said nothing about where instances live
  assert.equal(summarizeInstanceList('{"root":"/x","cap":4}\n{"id":"one","running":1}').instancesRoot, null);

  // A header the launcher never printed leaves the cap and the root unknown, and the instances count
  const headerless = summarizeInstanceList('{"id":"one","running":1,"port":9901}');
  assert.equal(headerless.cap, null);
  assert.equal(headerless.instancesRoot, null);
  assert.deepEqual(headerless.ids, ['one']);

  // An entry with no id cannot be reported as holding a slot
  assert.deepEqual(summarizeInstanceList('{"cap":8}\n{"running":1}').ids, []);

  for (const nothing of ['', '   \n\n', 'not json', '[]', '42', undefined, null]) {
    assert.equal(summarizeInstanceList(nothing), null, JSON.stringify(nothing));
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';

import {
  POSIX_GAME_CHECK_CMD,
  isGameRunning,
  killGame,
  resolveLaunchCommand,
  runChild,
  spawnDetached,
  tokenizeCommand,
  STEAM_LAUNCH_URL,
} from '../lib/game-process.js';

const isPosix = process.platform !== 'win32';

/** Is a real Broforce process running right now? Checked without pgrep. */
async function broforceIsActuallyRunning() {
  const { stdout } = await runChild('ps', ['-A', '-o', 'args=']);
  return stdout
    .split('\n')
    .some((line) => /Broforce\.x86_64|(^|\/)Broforce(\s|$)|Broforce.*\.exe/.test(line) && !line.includes('pgrep'));
}

test('the process check does not match its own shell', { skip: !isPosix }, async (t) => {
  if (await broforceIsActuallyRunning()) {
    t.skip('a real Broforce process is running');
    return;
  }

  const { code, error } = await runChild('sh', ['-c', POSIX_GAME_CHECK_CMD], { capture: false });
  assert.equal(error, null);
  assert.notEqual(code, 0, 'the check must exit non-zero when no game process exists');
});

test('isGameRunning reports false (never throws) with no game running', async (t) => {
  const answer = await isGameRunning();
  assert.ok(answer === true || answer === false || answer === null);

  if (isPosix && !(await broforceIsActuallyRunning())) {
    assert.equal(answer, false);
  } else {
    t.diagnostic(`isGameRunning() -> ${answer}`);
  }
});

test('killGame reports honestly when nothing was killed', async (t) => {
  if (isPosix && (await broforceIsActuallyRunning())) {
    t.skip('a real Broforce process is running; refusing to kill it');
    return;
  }

  const result = await killGame();
  assert.equal(result.killed, false);
  assert.ok(typeof result.detail === 'string' && result.detail.length > 0);
});

test('killGame says so when pkill is unavailable', { skip: !isPosix }, async (t) => {
  const { mkdtemp, symlink, rm } = await import('fs/promises');
  const { tmpdir } = await import('os');
  const { join, dirname } = await import('path');
  const { fileURLToPath } = await import('url');

  // A PATH containing sh but no pkill: the kill command's own 2>/dev/null used
  // to turn "pkill missing" into a confident "nothing was running"
  const binDir = await mkdtemp(join(tmpdir(), 'no-pkill-'));
  t.after(() => rm(binDir, { recursive: true, force: true }));
  await symlink('/bin/sh', join(binDir, 'sh'));

  const moduleUrl = new URL('../lib/game-process.js', import.meta.url).href;
  const script = `import(${JSON.stringify(moduleUrl)}).then(m => m.killGame()).then(r => process.stdout.write(JSON.stringify(r)))`;

  const output = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', script], {
      env: { PATH: binDir },
      cwd: dirname(fileURLToPath(moduleUrl)),
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => resolve('{}'));
    child.on('close', () => resolve(out));
  });

  const result = JSON.parse(output || '{}');
  assert.equal(result.killed, false);
  assert.equal(result.unknown, true, `expected an honest unknown, got ${output}`);
  assert.doesNotMatch(result.detail ?? '', /No Broforce process was running/);
});

test('tokenizeCommand handles quoting', () => {
  assert.deepEqual(tokenizeCommand('bf --vanilla'), ['bf', '--vanilla']);
  assert.deepEqual(tokenizeCommand('  "/opt/my games/bf.sh"   -a  b '), ['/opt/my games/bf.sh', '-a', 'b']);
  assert.deepEqual(tokenizeCommand("steam 'steam://rungameid/274190'"), ['steam', 'steam://rungameid/274190']);
  assert.deepEqual(tokenizeCommand(''), []);
});

test('BROFORCE_LAUNCH_CMD wins and receives the extra tool args', () => {
  const launch = resolveLaunchCommand(['--vanilla'], { BROFORCE_LAUNCH_CMD: 'bf --mode proton' });
  assert.equal(launch.source, 'BROFORCE_LAUNCH_CMD');
  assert.equal(launch.command, 'bf');
  assert.deepEqual(launch.args, ['--mode', 'proton', '--vanilla']);
  assert.deepEqual(launch.ignoredArgs, []);
});

test('the default launch is a platform-appropriate Steam protocol launch', () => {
  const linux = resolveLaunchCommand([], {}, 'linux');
  assert.equal(linux.command, 'sh');
  assert.ok(linux.args.join(' ').includes('steam'));
  assert.ok(linux.args.join(' ').includes('xdg-open'));
  assert.ok(linux.args.includes(STEAM_LAUNCH_URL));

  const win = resolveLaunchCommand([], {}, 'win32');
  assert.equal(win.command, 'cmd');
  assert.deepEqual(win.args, ['/c', 'start', '', STEAM_LAUNCH_URL]);

  const mac = resolveLaunchCommand([], {}, 'darwin');
  assert.equal(mac.command, 'open');
  assert.deepEqual(mac.args, [STEAM_LAUNCH_URL]);

  // Steam launches cannot take the game's own flags; they are reported, not silently dropped
  assert.deepEqual(resolveLaunchCommand(['--vanilla'], {}, 'linux').ignoredArgs, ['--vanilla']);
});

test('spawnDetached rejects on a missing binary instead of crashing the process', async () => {
  await assert.rejects(
    spawnDetached('definitely-not-a-real-command-xyz', []),
    (err) => err.code === 'ENOENT',
  );
});

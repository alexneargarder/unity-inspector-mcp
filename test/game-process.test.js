import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';

import {
  POSIX_GAME_CHECK_CMD,
  POSIX_PROFILE_SCAN_CMD,
  composeExtraLaunchArgs,
  extractProfileName,
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

test('extractProfileName resolves the launched profile from process listings', () => {
  const reaper =
    '202905 /home/u/.local/share/Steam/ubuntu12_32/reaper SteamLaunch AppId=274190 -- ' +
    '/home/u/.config/r2modmanPlus-local/Broforce/profiles/Default/run_umm.sh ' +
    '/home/u/.local/share/broforce-linux/Broforce.x86_64 --doorstop-enabled true ' +
    '--doorstop-target-assembly /home/u/.config/r2modmanPlus-local/Broforce/profiles/Default/UMM/Core/UnityModManager.dll';
  assert.equal(extractProfileName(reaper), 'Default');

  const windows =
    'C:\\Broforce\\Broforce.exe --doorstop-target-assembly ' +
    '"C:\\Users\\u\\AppData\\Roaming\\r2modmanPlus-local\\Broforce\\profiles\\UMM_Local_Install\\UMM\\Core\\UnityModManager.dll"';
  assert.equal(extractProfileName(windows), 'UMM_Local_Install');

  // Two distinct profiles across launcher lines means no confident answer
  const secondLauncher =
    '888 /home/u/.config/r2modmanPlus-local/Broforce/profiles/UMM_Local_Install/run_umm.sh';
  assert.equal(extractProfileName(reaper + '\n' + secondLauncher), null);

  // Non-launcher processes touching a profile path neither drive nor spoil the choice
  const strayShell =
    '999 tail -f /home/u/.config/r2modmanPlus-local/Broforce/profiles/UMM_Local_Install/UMM/Core/Log.txt';
  assert.equal(extractProfileName(strayShell), null);
  assert.equal(extractProfileName(reaper + '\n' + strayShell), 'Default');

  // A profile name with a space must not truncate into a match on another profile
  const spaced =
    '777 /home/u/.config/r2modmanPlus-local/Broforce/profiles/Default Backup/run_umm.sh --doorstop-enabled true';
  assert.equal(extractProfileName(spaced), null);

  assert.equal(extractProfileName(''), null);
  // The scan command's own bracketed pattern must never match itself
  assert.equal(extractProfileName(POSIX_PROFILE_SCAN_CMD), null);
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

test('tool launchArgs tokenize and append after the built-in flags', () => {
  assert.deepEqual(composeExtraLaunchArgs({}), []);
  assert.deepEqual(composeExtraLaunchArgs({ vanilla: true }), ['--vanilla']);

  const extra = composeExtraLaunchArgs({ vanilla: true, launchArgs: '-m "second arg"' });
  const launch = resolveLaunchCommand(extra, { BROFORCE_LAUNCH_CMD: 'bf --mode proton' });
  assert.deepEqual(launch.args, ['--mode', 'proton', '--vanilla', '-m', 'second arg']);
  assert.equal(launch.display, 'bf --mode proton --vanilla -m second arg');

  // Malformed input is an error, not silently dropped or mangled args
  assert.throws(() => composeExtraLaunchArgs({ launchArgs: 5 }), /must be a string/);
  assert.throws(() => composeExtraLaunchArgs({ launchArgs: '-m "second arg' }), /Unbalanced double quote/);
  assert.throws(() => tokenizeCommand("bf 'oops"), /Unbalanced single quote/);
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

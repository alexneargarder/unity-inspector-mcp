import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';

import {
  POSIX_GAME_CHECK_CMD,
  POSIX_GAME_CMDLINE_PID_CMD,
  POSIX_GAME_PID_CMD,
  POSIX_PROFILE_SCAN_CMD,
  startFromEtimes,
  startFromLstart,
  composeExtraLaunchArgs,
  extractProfileName,
  isGameRunning,
  killGame,
  parseWmicCreationDate,
  resolveLaunchCommand,
  runChild,
  spawnDetached,
  tokenizeCommand,
  STEAM_LAUNCH_URL,
} from '../lib/game-process.js';

const isPosix = process.platform !== 'win32';

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

test('the pid lookups do not match their own shell', { skip: !isPosix }, async (t) => {
  if (await broforceIsActuallyRunning()) {
    t.skip('a real Broforce process is running');
    return;
  }

  for (const [name, command] of [
    ['POSIX_GAME_PID_CMD', POSIX_GAME_PID_CMD],
    ['POSIX_GAME_CMDLINE_PID_CMD', POSIX_GAME_CMDLINE_PID_CMD],
  ]) {
    const { code, stdout, error } = await runChild('sh', ['-c', command]);
    assert.equal(error, null, `${name} could not run`);
    assert.notEqual(code, 0, `${name} must exit non-zero when no game process exists`);
    assert.equal(stdout.trim(), '', `${name} matched something: ${stdout}`);
  }
});

test('startFromEtimes survives the shapes ps actually emits', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');

  assert.equal(startFromEtimes('  10\n  90\n', now), now - 90000);
  assert.equal(startFromEtimes('  10\n  90\n', now, 'latest'), now - 10000);
  assert.equal(startFromEtimes('   42   ', now), now - 42000);
  assert.equal(startFromEtimes('\n\n120\n\n', now), now - 120000);

  // Number('') is 0: a blank answer must not read as "started this instant"
  assert.equal(startFromEtimes('', now), null);
  assert.equal(startFromEtimes('\n \n\n', now), null);
  assert.equal(startFromEtimes('ELAPSED', now), null);
  assert.equal(startFromEtimes(undefined, now), null);
});

test('startFromLstart survives the shapes ps actually emits', () => {
  const early = Date.parse('Thu Sep  3 20:02:00 2026');
  const late = Date.parse('Thu Sep  3 21:30:00 2026');

  assert.equal(startFromLstart('Thu Sep  3 20:02:00 2026\nThu Sep  3 21:30:00 2026\n'), early);
  assert.equal(startFromLstart('Thu Sep  3 20:02:00 2026\nThu Sep  3 21:30:00 2026\n', 'latest'), late);
  assert.equal(startFromLstart('  Thu Sep  3 20:02:00 2026  '), early);

  assert.equal(startFromLstart(''), null);
  assert.equal(startFromLstart('\n \n'), null);
  assert.equal(startFromLstart('STARTED'), null);
  assert.equal(startFromLstart(null), null);
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

test('parseWmicCreationDate reads wmic timestamps and rejects anything else', () => {
  // The offset is minutes from UTC, so the same wall clock in two zones is two different instants
  assert.equal(
    parseWmicCreationDate('20250903181601.123456+060'),
    Date.parse('2025-09-03T17:16:01.123Z'),
  );
  assert.equal(
    parseWmicCreationDate('20250903181601.123456-300'),
    Date.parse('2025-09-03T23:16:01.123Z'),
  );
  assert.equal(
    parseWmicCreationDate('20250903181601.000000+000'),
    Date.parse('2025-09-03T18:16:01.000Z'),
  );
  // wmic output arrives with the column header and padding around the values
  assert.equal(
    parseWmicCreationDate('  20250903181601.123456+060  '),
    Date.parse('2025-09-03T17:16:01.123Z'),
  );

  for (const notATimestamp of ['CreationDate', '', '   ', '2025-09-03T18:16:01Z', '20250903181601']) {
    assert.equal(parseWmicCreationDate(notATimestamp), null, `parsed ${JSON.stringify(notATimestamp)}`);
  }
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

  const secondLauncher =
    '888 /home/u/.config/r2modmanPlus-local/Broforce/profiles/UMM_Local_Install/run_umm.sh';
  assert.equal(extractProfileName(reaper + '\n' + secondLauncher), null);

  const strayShell =
    '999 tail -f /home/u/.config/r2modmanPlus-local/Broforce/profiles/UMM_Local_Install/UMM/Core/Log.txt';
  assert.equal(extractProfileName(strayShell), null);
  assert.equal(extractProfileName(reaper + '\n' + strayShell), 'Default');

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

  assert.deepEqual(resolveLaunchCommand(['--vanilla'], {}, 'linux').ignoredArgs, ['--vanilla']);
});

test('spawnDetached rejects on a missing binary instead of crashing the process', async () => {
  await assert.rejects(
    spawnDetached('definitely-not-a-real-command-xyz', []),
    (err) => err.code === 'ENOENT',
  );
});

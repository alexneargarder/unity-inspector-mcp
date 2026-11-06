import './support/session.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { fakeProcReader } from './support/fake-proc.js';

const {
  LINUX_GAME_COMM,
  commandFailure,
  createProcReader,
  gameBuild,
  isWslRelease,
  killGame,
  runChild,
  storeOfGameDir,
  summarizeInstanceList,
  windowsActiveProfile,
  windowsGameStartTime,
  windowsProcesses,
} = await import('../lib/game-process.js');
const { steamConfig, withRoot } = await import('../lib/instance.js');

const isLinux = process.platform === 'linux';
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'process-platforms-'));
test.after(() => fs.rm(scratch, { recursive: true, force: true }));

function fakeRun(answers) {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args]);
    const answer = answers[command];
    const value = typeof answer === 'function' ? answer(args) : answer;
    return { code: 0, signal: null, stdout: '', stderr: '', error: null, ...(value ?? { code: 1 }) };
  };
  run.calls = calls;
  return run;
}

test('a command that exits while something it started holds its pipes still settles on its exit', { skip: !isLinux }, async () => {
  const started = Date.now();
  const result = await runChild('sh', ['-c', 'sleep 5 & echo done; exit 0'], { timeoutMs: 4000 });

  assert.equal(result.error, null, result.error?.message);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /done/);
  assert.ok(Date.now() - started < 3000, `settled after ${Date.now() - started}ms`);
});

test('a command past its budget did not finish, which is not a command that could not run', { skip: !isLinux }, async () => {
  const result = await runChild('sh', ['-c', 'sleep 5'], { timeoutMs: 200 });

  assert.equal(result.error.code, 'ETIMEDOUT');
  assert.equal(commandFailure('stub instance x stop', result), '`stub instance x stop` did not finish within 0.2s');
  assert.equal(
    commandFailure('stub instance x stop', { error: Object.assign(new Error('spawn stub ENOENT'), { code: 'ENOENT' }) }),
    '`stub instance x stop` could not run (spawn stub ENOENT)',
  );
  assert.equal(commandFailure('stub', { error: null, code: 4, stderr: 'busy\n' }), '`stub` exited 4 (busy)');
  assert.equal(commandFailure('stub', { error: null, code: 0 }), null);
});

test('a /proc read that hangs is given up on and not asked again while it hangs', async () => {
  let cmdlineReads = 0;
  const hanging = {
    async readdir() { return ['77']; },
    async readlink() { throw new Error('ENOENT'); },
    readFile(file) {
      if (file.endsWith('/cmdline')) {
        cmdlineReads++;
        return new Promise(() => {});
      }
      return Promise.resolve(file.endsWith('/comm') ? 'Broforce-rename\n' : '');
    },
  };
  const reader = createProcReader('/fake-proc', hanging, { readTimeoutMs: 50 });

  const started = Date.now();
  assert.equal(await reader.cmdline(77), null);
  assert.ok(Date.now() - started < 1000);
  assert.equal(await reader.cmdline(77), null);
  assert.equal(cmdlineReads, 1, 'a second read joined the first in holding an fs thread');
  assert.equal(await reader.comm(77), 'Broforce-rename\n');
});

test('the launcher list keeps a cap of 0 and counts the lines it could not parse', () => {
  const zero = summarizeInstanceList('{"instancesRoot":"/i","cap":0}\n');
  assert.equal(zero.cap, 0);

  const capless = summarizeInstanceList('{"instancesRoot":"/i","cap":null}\n');
  assert.equal(capless.cap, null);
  assert.equal(summarizeInstanceList('{"instancesRoot":"/i"}\n').cap, null);

  const torn = summarizeInstanceList([
    '{"instancesRoot":"/i","cap":2}',
    '{"id":"a","running":1}',
    '{"id":"b","running":1,"launched_by":{"session_name":"tab\there"}}',
    '[1]',
  ].join('\n'));
  assert.equal(torn.count, 1);
  assert.equal(torn.unparsed, 2);
});

test('WSL is told from Linux by its kernel release', () => {
  assert.equal(isWslRelease('5.15.167.4-microsoft-standard-WSL2'), true);
  assert.equal(isWslRelease('4.4.0-19041-Microsoft'), true);
  assert.equal(isWslRelease('6.18.59'), false);
});

test('Windows processes are read through CIM, and wmic only when PowerShell cannot answer', async () => {
  const start = '2026-03-04T05:06:07.0000000Z';
  const cim = fakeRun({
    powershell: { stdout: JSON.stringify([
      { start, commandLine: 'C:\\Games\\Broforce\\Broforce.exe', path: 'C:\\Games\\Broforce\\Broforce.exe' },
      { start: '2026-03-04T05:07:00.0000000Z', commandLine: '', path: null },
    ]) },
  });
  assert.equal(await windowsGameStartTime(cim), Date.parse(start));
  assert.deepEqual(cim.calls.map(call => call[0]), ['powershell']);
  const encoded = cim.calls[0][cim.calls[0].indexOf('-EncodedCommand') + 1];
  assert.match(Buffer.from(encoded, 'base64').toString('utf16le'), /Name='Broforce\.exe' OR Name='Broforce_beta\.exe'/);

  // One process comes back as one object, and none as no output at all
  const one = fakeRun({ powershell: { stdout: JSON.stringify({ start, commandLine: 'x', path: 'C:\\B\\Broforce.exe' }) } });
  assert.equal((await windowsProcesses("Name='Broforce.exe'", one)).length, 1);
  assert.deepEqual(await windowsProcesses("Name='Broforce.exe'", fakeRun({ powershell: { stdout: '\r\n' } })), []);

  const noPowershell = fakeRun({
    powershell: { code: null, error: new Error('spawn powershell ENOENT') },
    wmic: (args) => (args[2] === "name='Broforce.exe'" ? { stdout: 'CreationDate\r\n20260304050607.000000+000\r\n' } : { stdout: '' }),
  });
  assert.equal(await windowsGameStartTime(noPowershell), Date.parse('2026-03-04T05:06:07Z'));

  const profile = fakeRun({
    powershell: { stdout: JSON.stringify({ start, commandLine: '"C:\\r2\\run.exe" --doorstop-target "C:\\Users\\u\\AppData\\Roaming\\r2modmanPlus-local\\Broforce\\profiles\\Testing\\UMM\\x.dll"', path: null }) },
  });
  assert.equal(await windowsActiveProfile(profile), 'Testing');
});

test('a Windows or macOS kill counts only once the process has left', async () => {
  let listed = 0;
  const lingering = fakeRun({
    taskkill: (args) => (args[2] === 'Broforce.exe' ? { code: 0 } : { code: 128 }),
    tasklist: () => ({ stdout: listed++ < 100 ? 'Broforce.exe   4242 Console' : 'INFO: No tasks' }),
  });
  const stuck = await killGame({ platform: 'win32', run: lingering, confirmMs: 200, pollMs: 20 });
  assert.equal(stuck.killed, false);
  assert.equal(stuck.unknown, true);
  assert.match(stuck.detail, /still running 0\.2s later/);

  let gone = 0;
  const leaving = fakeRun({
    taskkill: (args) => (args[2] === 'Broforce.exe' ? { code: 0 } : { code: 128 }),
    tasklist: () => ({ stdout: gone++ < 2 ? 'Broforce.exe   4242 Console' : 'INFO: No tasks' }),
  });
  const stopped = await killGame({ platform: 'win32', run: leaving, confirmMs: 2000, pollMs: 10 });
  assert.equal(stopped.killed, true, stopped.detail);

  const mac = fakeRun({ sh: (args) => (args[1].startsWith('command -v') || args[1].includes('pkill -9') ? { code: 0 } : { code: 0 }) });
  const macStuck = await killGame({ platform: 'darwin', run: mac, confirmMs: 100, pollMs: 20 });
  assert.equal(macStuck.unknown, true, 'pgrep still finding the game was taken for a stop');
});

test('the store of a game directory is read from the file each store leaves', async () => {
  const gog = path.join(scratch, 'gog-install', 'game');
  await fs.mkdir(gog, { recursive: true });
  await fs.writeFile(path.join(gog, 'goggame-1470490225.info'), JSON.stringify({ buildId: '57322851356943141', version: 1 }));
  assert.deepEqual(await storeOfGameDir(gog), { store: 'gog', storeBuild: '57322851356943141' });

  const steamapps = path.join(scratch, 'Steam', 'steamapps');
  const steam = path.join(steamapps, 'common', 'Broforce');
  await fs.mkdir(steam, { recursive: true });
  await fs.writeFile(path.join(steamapps, 'appmanifest_274190.acf'), '"AppState"\n{\n\t"appid"\t\t"274190"\n\t"buildid"\t\t"12964083"\n}\n');
  assert.deepEqual(await storeOfGameDir(steam), { store: 'steam', storeBuild: '12964083' });

  const loose = path.join(scratch, 'somewhere', 'Broforce');
  await fs.mkdir(loose, { recursive: true });
  assert.deepEqual(await storeOfGameDir(loose), { store: null, storeBuild: null });
});

test('the running game\'s directory comes from its executable, or from Proton\'s Windows path', { skip: !isLinux }, async () => {
  const config = withRoot(steamConfig(), path.join(scratch, 'instances'));
  const steamapps = path.join(scratch, 'Steam', 'steamapps');
  const steamDir = path.join(steamapps, 'common', 'Broforce');
  await fs.mkdir(steamDir, { recursive: true });
  await fs.writeFile(path.join(steamapps, 'appmanifest_274190.acf'), '"buildid"\t\t"12964083"\n');

  const native = fakeProcReader({
    800: { comm: LINUX_GAME_COMM, cwd: steamDir, exe: path.join(steamDir, 'Broforce.x86_64'), startTicks: 1 },
  });
  assert.deepEqual(await gameBuild(config, { reader: native, platform: 'linux' }),
    { store: 'steam', storeBuild: '12964083', gameDir: steamDir });

  const proton = fakeProcReader({
    801: { comm: 'Broforce.exe', cwd: steamDir, cmdline: `Z:${steamDir.replace(/\//g, '\\')}\\Broforce.exe`, startTicks: 1 },
  });
  assert.equal((await gameBuild(config, { reader: proton, platform: 'linux' })).gameDir, steamDir);

  assert.equal(await gameBuild(config, { reader: fakeProcReader({}), platform: 'linux' }), null);
});

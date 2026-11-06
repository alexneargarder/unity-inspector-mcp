import { NO_LISTENER_PORT, NO_OP_LAUNCH_CMD } from './support/session.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { conditionalProcReader, fakeProcReader } from './support/fake-proc.js';
import { reply, startStubServer } from './support/stub-server.js';

const { configureLaunchTiming, handleToolCall, setLaunchResolver, unityClient } = await import('../index.js');
const { LINUX_GAME_COMM, composeExtraLaunchArgs, resolveLaunchCommand, setProcReader, wineserverHoldsPrefix } = await import('../lib/game-process.js');
const { LAUNCH_REFUSED, parseRegQuery, preflightSteamLaunch, prepareSteamLaunch, realOnPath, realProfilesRoot, resolveSteamLaunch, withWinhttpOverride } = await import('../lib/steam-launch.js');
const { COMMAND_CANCELLED, FLATPAK_STEAM_ROOT } = await import('../lib/unity-client.js');

const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'steam-launch-')));
test.after(() => fs.rm(scratch, { recursive: true, force: true }));

let counter = 0;

async function write(file, text = '') {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}

async function fixture({ profile = 'Default', doorstop = '4.4.1', gameFiles = {}, root = `home-${++counter}` } = {}) {
  const home = path.join(scratch, root);
  const profiles = path.join(home, 'profiles');
  const steamapps = path.join(home, 'library/steamapps');
  const gamePath = path.join(steamapps, 'common/Broforce');
  await fs.mkdir(gamePath, { recursive: true });
  await fs.mkdir(profiles, { recursive: true });
  for (const [name, text] of Object.entries(gameFiles)) await write(path.join(gamePath, name), text);
  const profileDir = path.join(profiles, profile ?? 'unused');
  const preloader = path.join(profileDir, 'UMM/Core/UnityModManager.dll');
  if (profile !== null) {
    await write(preloader);
    if (doorstop !== null) await write(path.join(profileDir, '.doorstop_version'), `${doorstop}\n`);
  }
  return {
    home, profiles, steamapps, gamePath, profileDir, preloader,
    lookups: {
      onPath: async (name) => name === 'steam',
      steamRoots: () => [],
      registry: async (key) => (key.startsWith('HKLM') ? 'C:/Steam' : null),
      findSteamGame: async () => ({ gamePath, protonPrefix: null, steamapps }),
      profilesRoot: () => profiles,
    },
  };
}

const resolve = (requested, { env = {}, platform = 'linux', lookups }) =>
  resolveLaunchCommand(requested, env, platform, null, lookups);

const applaunchArgs = (launch) => launch.args.slice(launch.args.indexOf('274190') + 1);

test('Windows: the modded launch carries the profile through Doorstop 4 or 3, then launchArgs', async () => {
  const v4 = await fixture();
  const launch = await resolve({ extraArgs: ['-popupwindow'] }, { platform: 'win32', lookups: v4.lookups });

  assert.equal(launch.source, 'steam-applaunch');
  assert.equal(launch.command, path.join('C:/Steam', 'steam.exe'));
  assert.deepEqual(launch.args, [
    '-applaunch', '274190', '--doorstop-enabled', 'true', '--doorstop-target-assembly', v4.preloader, '-popupwindow',
  ]);
  assert.equal(launch.vanilla, false);
  assert.deepEqual(launch.ignoredArgs, []);
  assert.equal(launch.waitsOnExit, false);
  assert.equal(launch.prepare, null, 'Windows has no prefix or scripts to prepare');

  const v3 = await fixture({ doorstop: '3.4.0' });
  assert.deepEqual(applaunchArgs(await resolve({}, { platform: 'win32', lookups: v3.lookups })), [
    '--doorstop-enable', 'true', '--doorstop-target', v3.preloader,
  ]);
});

test('Windows: a vanilla launch switches Doorstop off in the version\'s own spelling', async () => {
  const v4 = await fixture();
  const launch = await resolve({ vanilla: true, extraArgs: ['-x'] }, { platform: 'win32', lookups: v4.lookups });
  assert.deepEqual(applaunchArgs(launch), ['--doorstop-enabled', 'false', '-x']);
  assert.equal(launch.vanilla, true);
  assert.equal(launch.waitsOnExit, false);

  const v3 = await fixture({ doorstop: '3.4.0' });
  const older = await resolve({ vanilla: true }, { platform: 'win32', lookups: v3.lookups });
  assert.deepEqual(applaunchArgs(older), ['--doorstop-enable', 'false']);
});

test('Windows: Steam is the HKLM install path, then HKCU\'s SteamPath, and with neither the protocol launch', async () => {
  const { lookups } = await fixture();
  const asked = [];
  const hkcu = await resolve({}, { platform: 'win32', lookups: {
    ...lookups,
    registry: async (key, value) => {
      asked.push(`${key} ${value}`);
      return key.startsWith('HKCU') ? 'D:/Games/Steam' : null;
    },
  } });
  assert.equal(hkcu.command, path.join('D:/Games/Steam', 'steam.exe'));
  assert.deepEqual(asked, ['HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam InstallPath', 'HKCU\\Software\\Valve\\Steam SteamPath']);

  const none = await resolve({ extraArgs: ['-x'] }, { platform: 'win32', lookups: { ...lookups, registry: async () => null } });
  assert.equal(none.source, 'steam-protocol');
  assert.equal(none.command, 'cmd');
  assert.deepEqual(none.ignoredArgs, ['-x']);
});

test('reg query\'s answer is read for its value, spaces in the path included, and nothing else', () => {
  const answer = '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Valve\\Steam\r\n    InstallPath    REG_SZ    C:\\Program Files (x86)\\Steam\r\n\r\n';
  assert.equal(parseRegQuery(answer, 'InstallPath'), 'C:\\Program Files (x86)\\Steam');
  assert.equal(parseRegQuery(answer, 'SteamPath'), null);
  assert.equal(parseRegQuery('', 'InstallPath'), null);
});

test('a program is on PATH only as an executable file, and the profiles root is r2modman\'s for the platform', async () => {
  const bin = path.join(scratch, `bin-${++counter}`);
  await write(path.join(bin, 'steam'));
  await fs.chmod(path.join(bin, 'steam'), 0o755);
  await write(path.join(bin, 'plain'));
  await fs.chmod(path.join(bin, 'plain'), 0o644);
  await fs.mkdir(path.join(bin, 'folder'));
  const env = { PATH: ['/nonexistent', bin].join(path.delimiter) };

  assert.equal(await realOnPath('steam', env), true);
  assert.equal(await realOnPath('plain', env), false);
  assert.equal(await realOnPath('folder', env), false);
  assert.equal(await realOnPath('absent', env), false);
  assert.equal(await realOnPath('steam', {}), false);

  assert.equal(realProfilesRoot({ APPDATA: '/roaming' }, 'win32'), path.join('/roaming', 'r2modmanPlus-local/Broforce/profiles'));
  assert.equal(realProfilesRoot({}, 'win32'), path.join(os.homedir(), 'AppData/Roaming/r2modmanPlus-local/Broforce/profiles'));
  assert.equal(realProfilesRoot({ APPDATA: '/roaming' }, 'linux'), path.join(os.homedir(), '.config/r2modmanPlus-local/Broforce/profiles'));
});

test('Linux native: the target is the profile\'s real path, with --r2profile and the scripts to make executable', async () => {
  const f = await fixture();
  const linked = path.join(f.home, 'linked-profiles');
  await fs.symlink(f.profiles, linked);

  const launch = await resolve({ extraArgs: ['-x'] }, { lookups: { ...f.lookups, profilesRoot: () => linked } });

  assert.equal(launch.command, 'steam');
  assert.deepEqual(launch.args, [
    '-applaunch', '274190', '--doorstop-enabled', 'true', '--doorstop-target-assembly', f.preloader,
    '--r2profile', 'Default', '-x',
  ]);
  assert.equal(launch.vanilla, false);
  assert.equal(launch.waitsOnExit, false);
  assert.deepEqual(launch.prepare, { scriptsDir: path.join(linked, 'Default') });
});

test('Linux: a vanilla launch carries no --r2profile and prepares nothing, so the wrapper takes its own vanilla path', async () => {
  const f = await fixture();
  const launch = await resolve({ vanilla: true, extraArgs: ['-x'] }, { lookups: f.lookups });

  assert.deepEqual(applaunchArgs(launch), ['--doorstop-enabled', 'false', '-x']);
  assert.equal(launch.vanilla, true);
  assert.equal(launch.prepare, null);
  assert.ok(!launch.args.includes('--vanilla'), 'the path spells vanilla its own way');
});

test('the Doorstop version is the profile\'s, then the game folder\'s, then 3', async () => {
  const fromGame = await fixture({ doorstop: null, gameFiles: { '.doorstop_version': '4.1.0' } });
  assert.equal(applaunchArgs(await resolve({}, { lookups: fromGame.lookups }))[0], '--doorstop-enabled');

  const profileWins = await fixture({ doorstop: '3.4.0', gameFiles: { '.doorstop_version': '4.1.0' } });
  assert.equal(applaunchArgs(await resolve({}, { lookups: profileWins.lookups }))[0], '--doorstop-enable');

  const neither = await fixture({ doorstop: null });
  assert.deepEqual(applaunchArgs(await resolve({ vanilla: true }, { lookups: neither.lookups })), ['--doorstop-enable', 'false']);

  const garbled = await fixture({ doorstop: 'unknown' });
  assert.equal(applaunchArgs(await resolve({}, { lookups: garbled.lookups }))[0], '--doorstop-enable');
});

test('Linux Proton: the target is Z: plus the real path, and the prefix\'s user.reg is the thing to prepare', async () => {
  const f = await fixture({ gameFiles: { 'Broforce.exe': '' } });
  const launch = await resolve({}, { lookups: f.lookups });

  assert.deepEqual(applaunchArgs(launch), [
    '--doorstop-enabled', 'true', '--doorstop-target-assembly', `Z:${f.preloader}`, '--r2profile', 'Default',
  ]);
  assert.deepEqual(launch.prepare, { userReg: path.join(f.steamapps, 'compatdata/274190/pfx/user.reg') });
});

test('BROFORCE_LAUNCH_TYPE decides over auto, which follows .forceproton and a .exe in the game folder', async () => {
  const isProton = async (lookups, env = {}) => 'userReg' in (await resolve({}, { env, lookups })).prepare;

  assert.equal(await isProton((await fixture()).lookups), false, 'nothing in the folder is native');
  assert.equal(await isProton((await fixture({ gameFiles: { '.forceproton': '' } })).lookups), true);
  assert.equal(await isProton((await fixture({ gameFiles: { 'BROFORCE.EXE': '' } })).lookups), true);

  const withExe = (await fixture({ gameFiles: { 'Broforce.exe': '' } })).lookups;
  assert.equal(await isProton(withExe, { BROFORCE_LAUNCH_TYPE: 'native' }), false);
  assert.equal(await isProton((await fixture()).lookups, { BROFORCE_LAUNCH_TYPE: 'proton' }), true);
  assert.equal(await isProton(withExe, { BROFORCE_LAUNCH_TYPE: 'auto' }), true);

  const refused = resolve({}, { env: { BROFORCE_LAUNCH_TYPE: 'wine' }, lookups: withExe });
  await assert.rejects(refused, (err) => err.code === LAUNCH_REFUSED && /BROFORCE_LAUNCH_TYPE must be auto, native or proton/.test(err.message));
});

test('the Steam executable is steam on PATH, else the first root holding steam.sh, Flatpak\'s through flatpak', async () => {
  const f = await fixture();
  const plain = path.join(scratch, `roots-${++counter}/plain`);
  const second = path.join(scratch, `roots-${counter}/second`);
  const flatpakRoot = path.join(scratch, `roots-${counter}/home`, FLATPAK_STEAM_ROOT);
  await write(path.join(second, 'steam.sh'));
  await write(path.join(flatpakRoot, 'steam.sh'));
  const withRoots = (roots, onPath) => ({ ...f.lookups, steamRoots: () => roots, onPath: async (name) => onPath.includes(name) });

  assert.equal((await resolve({}, { lookups: withRoots([second], ['steam']) })).command, 'steam');

  const script = await resolve({}, { lookups: withRoots([plain, second], []) });
  assert.equal(script.command, path.join(second, 'steam.sh'), 'a root with no steam.sh is passed over');
  assert.equal(script.args[0], '-applaunch');

  const flatpak = await resolve({}, { lookups: withRoots([plain, flatpakRoot], ['flatpak']) });
  assert.equal(flatpak.command, 'flatpak');
  assert.deepEqual(flatpak.args.slice(0, 4), ['run', 'com.valvesoftware.Steam', '-applaunch', '274190']);

  const noFlatpak = await resolve({}, { lookups: withRoots([flatpakRoot], []) });
  assert.equal(noFlatpak.source, 'steam-protocol', 'its steam.sh cannot run outside the sandbox');
  assert.equal(noFlatpak.command, 'xdg-open');

  assert.equal((await resolve({}, { lookups: withRoots([], []) })).source, 'steam-protocol');
});

test('BROFORCE_PROFILE names a profile by name or by its folder, and one with no Unity Mod Manager refuses the launch', async () => {
  const f = await fixture({ profile: 'Modded' });
  const byName = await resolve({}, { env: { BROFORCE_PROFILE: 'Modded' }, lookups: f.lookups });
  assert.ok(byName.args.includes(f.preloader));
  assert.deepEqual(byName.args.slice(-2), ['--r2profile', 'Modded']);

  const moved = path.join(scratch, `moved-${++counter}/Broforce/profiles/Elsewhere`);
  const movedPreloader = path.join(moved, 'UMM/Core/UnityModManager.dll');
  await write(movedPreloader);
  const byPath = await resolve({}, { env: { BROFORCE_PROFILE: moved }, lookups: f.lookups });
  assert.ok(byPath.args.includes(movedPreloader));
  assert.deepEqual(byPath.args.slice(-2), ['--r2profile', 'Elsewhere']);

  for (const platform of ['linux', 'win32']) {
    for (const vanilla of [false, true]) {
      await assert.rejects(
        resolve({ vanilla }, { env: { BROFORCE_PROFILE: 'Absent' }, platform, lookups: f.lookups }),
        (err) => err.code === LAUNCH_REFUSED &&
          err.message.includes(path.join(f.profiles, 'Absent/UMM/Core/UnityModManager.dll')) &&
          /BROFORCE_PROFILE/.test(err.message) && /BROFORCE_LAUNCH_CMD/.test(err.message),
      );
    }
  }
});

test('no r2modman profile: a modded launch carries no Doorstop arguments and prepares nothing', async () => {
  for (const f of [await fixture({ profile: null }), await fixture({ profile: 'Other' })]) {
    const launch = await resolve({ extraArgs: ['-x'] }, { lookups: f.lookups });
    assert.deepEqual(applaunchArgs(launch), ['-x']);
    assert.equal(launch.vanilla, false);
    assert.equal(launch.prepare, null);
    assert.equal(launch.waitsOnExit, false);
  }

  const proton = await fixture({ profile: null, gameFiles: { 'Broforce.exe': '' } });
  assert.equal((await resolve({}, { lookups: proton.lookups })).prepare, null, 'no user.reg write for a Doorstop the server did not point');
});

test('no r2modman profile: vanilla is the game folder\'s Doorstop switched off, when it holds one', async () => {
  const cases = [
    [{ 'winhttp.dll': '' }, ['--doorstop-enable', 'false']],
    [{ 'doorstop_config.ini': '', '.doorstop_version': '4.4.1' }, ['--doorstop-enabled', 'false']],
    [{ 'run_umm.sh': '', '.doorstop_version': '3.4.0' }, ['--doorstop-enable', 'false']],
    [{ 'run_umm.sh': '', '.doorstop_version': '4.4.1' }, ['--doorstop-enabled', 'false']],
  ];
  for (const [gameFiles, expected] of cases) {
    const f = await fixture({ profile: null, gameFiles });
    const launch = await resolve({ vanilla: true }, { lookups: f.lookups });
    assert.deepEqual(applaunchArgs(launch), expected, Object.keys(gameFiles).join());
    assert.equal(launch.vanilla, true);
    assert.deepEqual(launch.ignoredArgs, []);
  }
});

test('no r2modman profile and no Doorstop in the game folder: vanilla is not honoured and says so', async () => {
  for (const f of [await fixture({ profile: null }), await fixture({ profile: null, gameFiles: { 'run_umm.sh': '' } })]) {
    const launch = await resolve({ vanilla: true, extraArgs: ['-x'] }, { lookups: f.lookups });
    assert.deepEqual(applaunchArgs(launch), ['-x']);
    assert.equal(launch.vanilla, false);
    assert.deepEqual(launch.ignoredArgs, ['--vanilla']);
    assert.match(launch.ignoredReason, /holds no Doorstop to switch off/);
  }
});

test('Linux refuses a Doorstop target or launchArgs token holding a space; Windows does not', async () => {
  const spaced = await fixture({ root: `with space-${++counter}` });
  await assert.rejects(
    resolve({}, { lookups: spaced.lookups }),
    (err) => err.code === LAUNCH_REFUSED && /issue 8315/.test(err.message) && err.message.includes(spaced.preloader),
  );
  assert.ok((await resolve({}, { platform: 'win32', lookups: spaced.lookups })).args.includes(spaced.preloader));

  const f = await fixture();
  await assert.rejects(
    resolve({ extraArgs: ['two words'] }, { lookups: f.lookups }),
    (err) => err.code === LAUNCH_REFUSED && /launchArgs token "two words"/.test(err.message),
  );
  await assert.rejects(resolve({ vanilla: true, extraArgs: ['two words'] }, { lookups: f.lookups }), /issue 8315/);

  const named = await fixture({ profile: 'My Mods' });
  await assert.rejects(resolve({}, { env: { BROFORCE_PROFILE: 'My Mods' }, lookups: named.lookups }), /issue 8315/);
  assert.ok((await resolve({ extraArgs: ['two words'] }, { platform: 'win32', lookups: f.lookups })).args.includes('two words'));
});

test('the likely causes are split by what each launch path can actually hit', async () => {
  const native = await resolve({}, { lookups: (await fixture()).lookups });
  assert.match(native.startCauses.confirmation, /Allow game launch\?/);
  assert.match(native.startCauses.launchOptions, /linux_wrapper\.sh %command%/);

  const proton = await resolve({}, { lookups: (await fixture({ gameFiles: { 'Broforce.exe': '' } })).lookups });
  assert.match(proton.startCauses.launchOptions, /under Proton, Broforce's Steam Launch Options must be empty/);

  const windows = await resolve({}, { platform: 'win32', lookups: (await fixture()).lookups });
  assert.match(windows.startCauses.confirmation, /Allow game launch\?/);
  assert.equal(windows.startCauses.launchOptions, null);

  const vanillaNative = await resolve({ vanilla: true }, { lookups: (await fixture()).lookups });
  assert.equal(vanillaNative.startCauses.launchOptions, null, 'a vanilla launch needs no wrapper');
});

test('resolveSteamLaunch answers null on macOS, leaving the protocol launch', async () => {
  assert.equal(await resolveSteamLaunch({}, { env: {}, platform: 'darwin', lookups: {} }), null);
  const mac = await resolveLaunchCommand({ vanilla: true, extraArgs: ['-x'] }, {}, 'darwin');
  assert.equal(mac.command, 'open');
  assert.deepEqual(mac.ignoredArgs, ['--vanilla', '-x']);
});

const USER_REG = 'WINE REGISTRY Version 2\n;; All keys relative to \\\\User\n\n' +
  '[Software\\\\Wine\\\\Debug] 1700000000\n#time=1d9\n"RelayExclude"="ntdll"\n\n';
const OVERRIDES = '[Software\\\\Wine\\\\DllOverrides] 1700000000\n#time=1d9\n"d3d9"="native"\n\n';

test('the winhttp override goes into its section, corrects a wrong value, and leaves a right one alone', () => {
  const added = withWinhttpOverride(USER_REG + OVERRIDES);
  assert.ok(added.includes('"d3d9"="native"\n"winhttp"="native,builtin"\n\n'), added);
  assert.ok(added.startsWith(USER_REG), 'other sections are untouched');
  assert.equal(withWinhttpOverride(added), added);

  const wrong = withWinhttpOverride(USER_REG + OVERRIDES.replace('"d3d9"="native"', '"winhttp"="builtin"'));
  assert.ok(wrong.includes('"winhttp"="native,builtin"'));
  assert.ok(!wrong.includes('"winhttp"="builtin"'));

  const noSection = withWinhttpOverride(USER_REG);
  assert.ok(noSection.endsWith('[Software\\\\Wine\\\\DllOverrides]\n"winhttp"="native,builtin"\n'), noSection);
  assert.ok(noSection.startsWith(USER_REG.trimEnd()));

  const atEnd = withWinhttpOverride(USER_REG + OVERRIDES.trimEnd());
  assert.ok(atEnd.endsWith('"d3d9"="native"\n"winhttp"="native,builtin"'), atEnd);
});

const prepare = (target, options = {}) => prepareSteamLaunch(target, { waitMs: 500, pollMs: 10, sleep: (ms) => new Promise((done) => setTimeout(done, ms)), ...options });

async function fixturePrefix(text = USER_REG + OVERRIDES) {
  const pfx = path.join(scratch, `prefix-${++counter}/compatdata/274190/pfx`);
  const userReg = path.join(pfx, 'user.reg');
  await write(userReg, text);
  return { pfx, userReg };
}

const WINESERVER = (prefix, extra = {}) => ({ comm: 'wineserver', environ: `HOME=/h WINEPREFIX=${prefix} LANG=C`, startTicks: 5, ...extra });

test('the user.reg write keeps a .bak only when it changes the file, in the fixture prefix', async () => {
  setProcReader(fakeProcReader({}));
  const { userReg } = await fixturePrefix();

  assert.deepEqual(await prepare({ userReg }), []);
  const written = await fs.readFile(userReg, 'utf8');
  assert.ok(written.includes('"winhttp"="native,builtin"'));
  assert.equal(await fs.readFile(`${userReg}.bak`, 'utf8'), USER_REG + OVERRIDES);

  await fs.rm(`${userReg}.bak`);
  assert.deepEqual(await prepare({ userReg }), []);
  assert.equal(existsSync(`${userReg}.bak`), false, 'an unchanged file keeps no copy');
  assert.equal(await fs.readFile(userReg, 'utf8'), written);
  setProcReader(null);
});

test('a prefix with no user.reg yet is a note, not a failure, and passes the pre-flight', async () => {
  setProcReader(fakeProcReader({}));
  const missing = path.join(scratch, `prefix-${++counter}/pfx/user.reg`);
  for (const userReg of [missing, null]) {
    await preflightSteamLaunch({ userReg });
    const notes = await prepare({ userReg });
    assert.equal(notes.length, 1);
    assert.match(notes[0], /No Proton prefix holds a user\.reg yet/);
  }
  assert.equal(existsSync(missing), false, 'the server never invents a prefix');
  setProcReader(null);
});

test('the write waits for this prefix\'s wineserver to exit, and takes what it saved as it exited', async () => {
  const { pfx, userReg } = await fixturePrefix(USER_REG);
  let sleeps = 0;
  const alive = fakeProcReader({ 900: WINESERVER(`${pfx}/`) });
  setProcReader(alive);
  const notes = await prepare({ userReg }, {
    sleep: async () => {
      if (++sleeps < 3) return;
      await fs.writeFile(userReg, USER_REG + OVERRIDES);
      setProcReader(fakeProcReader({}));
    },
  });

  assert.deepEqual(notes, []);
  assert.equal(sleeps, 3);
  const written = await fs.readFile(userReg, 'utf8');
  assert.ok(written.includes('"d3d9"="native"\n"winhttp"="native,builtin"'), 'the read came after its save, not before it');
  setProcReader(null);
});

test('a wineserver is this prefix\'s by WINEPREFIX, through a symlink and a trailing slash, and no other is waited on', async () => {
  const { pfx, userReg } = await fixturePrefix();
  const linked = path.join(path.dirname(pfx), 'linked-pfx');
  await fs.symlink(pfx, linked);

  assert.equal(await wineserverHoldsPrefix(pfx, fakeProcReader({ 900: WINESERVER(`${linked}/`) })), true, 'Proton\'s own form, by another path');
  assert.equal(await wineserverHoldsPrefix(`${linked}/`, fakeProcReader({ 900: WINESERVER(pfx) })), true);

  const others = {
    900: WINESERVER('/other/compatdata/1/pfx/'),
    901: WINESERVER(`${pfx}/`, { state: 'Z' }),
    902: { comm: 'wineserver', environ: 'HOME=/h' },
    903: { comm: 'wineserver' },
    904: { comm: 'bash', environ: `WINEPREFIX=${pfx}/` },
  };
  setProcReader(fakeProcReader(others));
  assert.equal(await wineserverHoldsPrefix(pfx), false);
  let slept = false;
  assert.deepEqual(await prepare({ userReg }, { sleep: async () => { slept = true; } }), []);
  assert.equal(slept, false);
  setProcReader(null);
});

test('past the bound the override is written anyway and the reply says it may be lost', async () => {
  const { pfx, userReg } = await fixturePrefix();
  setProcReader(fakeProcReader({ 900: WINESERVER(`${pfx}/`) }));

  const started = Date.now();
  const notes = await prepare({ userReg }, { waitMs: 100 });

  assert.ok(Date.now() - started >= 100, 'the bound was waited out');
  assert.equal(notes.length, 1);
  assert.match(notes[0], /still held the Proton prefix after 0\.1s/);
  assert.match(notes[0], /may be lost/);
  assert.ok((await fs.readFile(userReg, 'utf8')).includes('"winhttp"="native,builtin"'));
  setProcReader(null);
});

test('a cancel during the wait stops it and writes nothing', async () => {
  const { pfx, userReg } = await fixturePrefix();
  setProcReader(fakeProcReader({ 900: WINESERVER(`${pfx}/`) }));
  const controller = new AbortController();

  await assert.rejects(
    prepare({ userReg }, { waitMs: 20000, signal: controller.signal, sleep: async () => controller.abort() }),
    (err) => err.code === COMMAND_CANCELLED,
  );
  assert.equal(await fs.readFile(userReg, 'utf8'), USER_REG + OVERRIDES);
  setProcReader(null);
});

test('the pre-flight refuses a user.reg or a folder it could not write, and a profile script it cannot chmod', async () => {
  const { pfx, userReg } = await fixturePrefix();
  await preflightSteamLaunch({ userReg });

  await fs.chmod(userReg, 0o444);
  await assert.rejects(preflightSteamLaunch({ userReg }), (err) => err.code === 'EACCES');
  await fs.chmod(userReg, 0o644);

  await fs.chmod(pfx, 0o555);
  await assert.rejects(preflightSteamLaunch({ userReg }), (err) => err.code === 'EACCES');
  await fs.chmod(pfx, 0o755);

  await fs.rm(userReg);
  await fs.mkdir(userReg);
  await assert.rejects(preflightSteamLaunch({ userReg }), (err) => err.code === 'EISDIR');

  const f = await fixture();
  await fs.symlink(path.join(f.profileDir, 'gone'), path.join(f.profileDir, 'run_umm.sh'));
  await assert.rejects(preflightSteamLaunch({ scriptsDir: f.profileDir }), (err) => err.code === 'ENOENT');
  await preflightSteamLaunch(null);
});

test('a native launch makes the profile\'s scripts executable, through a symlinked profile too', async () => {
  const f = await fixture();
  await write(path.join(f.profileDir, 'run_umm.sh'), '#!/bin/sh\n');
  await write(path.join(f.profileDir, 'notes.txt'), '');
  await fs.chmod(path.join(f.profileDir, 'run_umm.sh'), 0o644);
  await fs.chmod(path.join(f.profileDir, 'notes.txt'), 0o644);
  const linked = path.join(f.home, 'linked-profile');
  await fs.symlink(f.profileDir, linked);

  await preflightSteamLaunch({ scriptsDir: linked });

  assert.equal((await fs.stat(path.join(f.profileDir, 'run_umm.sh'))).mode & 0o777, 0o755);
  assert.equal((await fs.stat(path.join(f.profileDir, 'notes.txt'))).mode & 0o777, 0o644);
});

const isLinux = process.platform === 'linux';
const textOf = (response) => response.content.map((c) => c.text).join('\n');
const launch = (args) => handleToolCall({ params: { name: 'launch_game', arguments: args } });
const noGame = () => setProcReader(fakeProcReader({}));

function clearLaunch() {
  setLaunchResolver();
  setProcReader(null);
  process.env.BROFORCE_LAUNCH_CMD = NO_OP_LAUNCH_CMD;
  process.env.UNITY_INSPECTOR_PORT = NO_LISTENER_PORT;
  unityClient.disconnect();
  unityClient.pointAt({ port: Number(NO_LISTENER_PORT) });
  configureLaunchTiming({ steamStartMs: 120000, startConfirmMs: 15000, startStableMs: 2000, startPollMs: 500, vanillaExitWaitMs: 45000, wineserverExitMs: 10000, wineserverPollMs: 250 });
}

async function stubSteam(t, script, options = {}) {
  const f = await fixture(options);
  const root = path.join(f.home, 'steam-root');
  await write(path.join(root, 'steam.sh'), `#!/bin/sh\n${typeof script === 'function' ? script(f) : script}\n`);
  await fs.chmod(path.join(root, 'steam.sh'), 0o755);
  const lookups = { ...f.lookups, onPath: async () => false, steamRoots: () => [root] };
  setLaunchResolver((requested, _env, platform, config) => resolveLaunchCommand(requested, {}, 'linux', config, lookups));
  delete process.env.BROFORCE_LAUNCH_CMD;
  configureLaunchTiming({ steamStartMs: 800, startConfirmMs: 100, startStableMs: 150, startPollMs: 50, vanillaExitWaitMs: 60000 });
  t.after(clearLaunch);
  return { ...f, steamSh: path.join(root, 'steam.sh') };
}

const gameOnceLaunched = (marker) => setProcReader(conditionalProcReader({}, {
  when: () => fs.access(marker).then(() => true, () => false),
  extra: { 801: { comm: LINUX_GAME_COMM, cwd: '/home/x/.steam/Broforce', startTicks: 200 } },
}));

test('a vanilla launch through a Steam that never exits is confirmed by the game\'s process, not by its exit', { timeout: 30000, skip: !isLinux }, async (t) => {
  const marker = path.join(scratch, `never-exits-${++counter}`);
  await stubSteam(t, `: > '${marker}'\nexec sleep 5`);
  gameOnceLaunched(marker);

  const started = Date.now();
  const payload = JSON.parse(textOf(await launch({ vanilla: true })));

  assert.equal(payload.success, true, payload.message);
  assert.equal(payload.vanilla, true);
  assert.match(payload.message, /without mods/);
  assert.doesNotMatch(payload.message, /still running/);
  assert.match(payload.launchCommand, /-applaunch 274190 --doorstop-enabled false$/);
  assert.ok(Date.now() - started < 4000, 'the launch command\'s exit was never waited for');
});

test('a vanilla launch through Steam that leaves no game is no-process after the cold-start budget, naming the likely causes', { timeout: 30000, skip: !isLinux }, async (t) => {
  await stubSteam(t, 'exit 0', { gameFiles: { 'Broforce.exe': '' } });
  noGame();

  const started = Date.now();
  const payload = JSON.parse(textOf(await launch({ vanilla: true })));

  assert.equal(payload.success, false, payload.message);
  assert.equal(payload.state, 'no-process');
  assert.equal(payload.vanilla, true);
  assert.ok(Date.now() - started >= 800, 'the cold-start budget, not the 100ms confirmation');
  assert.match(payload.message, /0\.8s later/);
  assert.match(payload.message, /Allow game launch\?/);
  assert.match(payload.message, /under Proton, Broforce's Steam Launch Options must be empty/);
  assert.doesNotMatch(payload.message, /exited cleanly/);
});

test('a cancelled vanilla launch through Steam stops waiting out the cold-start budget', { timeout: 30000, skip: !isLinux }, async (t) => {
  await stubSteam(t, 'exit 0');
  noGame();
  configureLaunchTiming({ steamStartMs: 20000 });
  const controller = new AbortController();

  const started = Date.now();
  const pending = handleToolCall({ params: { name: 'launch_game', arguments: { vanilla: true } } }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 200);
  const response = await pending;

  assert.equal(response.isError, true, textOf(response));
  assert.match(textOf(response), /launch_game was cancelled/);
  assert.ok(Date.now() - started < 5000, 'the wait woke on the cancel');
});

test('a Steam executable that exits non-zero ends a vanilla launch\'s wait as launcher-failed', { timeout: 30000, skip: !isLinux }, async (t) => {
  await stubSteam(t, 'sleep 0.1\nexit 9');
  noGame();
  configureLaunchTiming({ steamStartMs: 20000 });

  const started = Date.now();
  const payload = JSON.parse(textOf(await launch({ vanilla: true })));

  assert.equal(payload.success, false);
  assert.equal(payload.state, 'launcher-failed');
  assert.match(payload.message, /exited with status 9/);
  assert.ok(Date.now() - started < 5000, 'the failure ends the wait');
});

test('a Steam executable that exits non-zero ends a modded launch\'s poll as launcher-failed', { timeout: 30000, skip: !isLinux }, async (t) => {
  await stubSteam(t, 'exit 3');
  noGame();
  configureLaunchTiming({ steamStartMs: 60000 });

  const payload = JSON.parse(textOf(await launch({})));

  assert.equal(payload.state, 'launcher-failed', payload.message);
  assert.match(payload.message, /exited with status 3/);
  assert.doesNotMatch(payload.message, /Allow game launch/);
});

test('a modded launch through a Steam that never exits is ready when the inspector answers, its scripts already executable at the spawn', { timeout: 30000, skip: !isLinux }, async (t) => {
  const marker = path.join(scratch, `modded-${++counter}`);
  const mode = path.join(scratch, `modded-mode-${counter}`);
  const f = await stubSteam(t, (fixed) => `stat -c %a '${path.join(fixed.profileDir, 'run_umm.sh')}' > '${mode}'\n: > '${marker}'\nexec sleep 5`);
  await write(path.join(f.profileDir, 'run_umm.sh'), '#!/bin/sh\n');
  await fs.chmod(path.join(f.profileDir, 'run_umm.sh'), 0o644);
  // Undelayed, a chmod moved after the spawn still beats sh starting up
  const realChmod = fs.chmod;
  t.mock.method(fs, 'chmod', async (...args) => {
    await new Promise((done) => setTimeout(done, 300));
    return realChmod(...args);
  });
  gameOnceLaunched(marker);
  configureLaunchTiming({ steamStartMs: 15000 });
  const game = await startStubServer((request, socket) => {
    if (existsSync(marker)) reply(socket, request.id, {});
    else socket.destroy();
  });
  process.env.UNITY_INSPECTOR_PORT = String(game.port);
  t.after(() => game.close());

  const payload = JSON.parse(textOf(await launch({ launchArgs: '-x' })));

  assert.equal(payload.success, true, payload.message);
  assert.ok(payload.launchCommand.endsWith(`--doorstop-target-assembly ${f.preloader} --r2profile Default -x`), payload.launchCommand);
  assert.equal((await fs.readFile(mode, 'utf8')).trim(), '755', 'what the script saw when Steam ran');
});

test('a modded launch through Steam that leaves no process polls the cold-start budget and names the likely causes', { timeout: 30000, skip: !isLinux }, async (t) => {
  await stubSteam(t, 'exit 0');
  noGame();

  const payload = JSON.parse(textOf(await launch({})));

  assert.equal(payload.state, 'no-process', payload.message);
  assert.match(payload.message, /Allow game launch\?/);
  assert.match(payload.message, /linux_wrapper\.sh %command%/);
  assert.doesNotMatch(payload.message, /the launch command exited without leaving a game running/);
});

test('a modded launch through Steam whose game runs with nothing listening names only the Launch Options', { timeout: 30000, skip: !isLinux }, async (t) => {
  const marker = path.join(scratch, `no-mod-${++counter}`);
  await stubSteam(t, `: > '${marker}'`);
  gameOnceLaunched(marker);

  const payload = JSON.parse(textOf(await launch({})));

  assert.equal(payload.state, 'connection-refused', payload.message);
  assert.match(payload.message, /linux_wrapper\.sh %command%/);
  assert.doesNotMatch(payload.message, /Allow game launch/, 'the game is up, so nothing held it back');
  assert.match(payload.message, /wait_for_game/);
});

test('a modded launch through Steam whose port never answers blames neither the confirmation nor the Launch Options', { timeout: 30000, skip: !isLinux }, async (t) => {
  const marker = path.join(scratch, `silent-${++counter}`);
  await stubSteam(t, `: > '${marker}'`);
  gameOnceLaunched(marker);
  const game = await startStubServer((request, socket) => {
    if (!existsSync(marker)) socket.destroy();
    else setTimeout(() => socket.destroy(), 10);
  });
  process.env.UNITY_INSPECTOR_PORT = String(game.port);
  t.after(() => game.close());

  const payload = JSON.parse(textOf(await launch({})));

  assert.equal(payload.state, 'connection-dropped', payload.message);
  assert.doesNotMatch(payload.message, /Allow game launch|Launch Options|Likely causes/);
});

test('a vanilla launch with nothing to switch off is polled as modded and says it ignored --vanilla', { timeout: 30000, skip: !isLinux }, async (t) => {
  await stubSteam(t, 'exit 0', { profile: null });
  noGame();

  const payload = JSON.parse(textOf(await launch({ vanilla: true })));

  assert.notEqual(payload.vanilla, true);
  assert.equal(payload.state, 'no-process', payload.message);
  assert.match(payload.note, /Ignored launch arguments --vanilla — no r2modman profile/);
});

test('the Proton override is written, and a prefix with none yet reaches the reply as a note', { timeout: 30000, skip: !isLinux }, async (t) => {
  const f = await stubSteam(t, 'exit 0', { gameFiles: { 'Broforce.exe': '' } });
  noGame();
  const payload = JSON.parse(textOf(await launch({})));
  assert.match(payload.note, /No Proton prefix holds a user\.reg yet/);

  const userReg = path.join(f.steamapps, 'compatdata/274190/pfx/user.reg');
  await write(userReg, USER_REG + OVERRIDES);
  const second = JSON.parse(textOf(await launch({})));
  assert.equal(second.note, undefined);
  assert.ok((await fs.readFile(userReg, 'utf8')).includes('"winhttp"="native,builtin"'));
});

test('a launch waits for the prefix\'s wineserver before it writes, and past the bound says the override may be lost', { timeout: 30000, skip: !isLinux }, async (t) => {
  const copy = path.join(scratch, `user-reg-held-${++counter}`);
  const f = await stubSteam(t, (fixed) => `cp '${path.join(fixed.steamapps, 'compatdata/274190/pfx/user.reg')}' '${copy}'\nexit 0`, { gameFiles: { 'Broforce.exe': '' } });
  const userReg = path.join(f.steamapps, 'compatdata/274190/pfx/user.reg');
  await write(userReg, USER_REG + OVERRIDES);
  setProcReader(fakeProcReader({ 900: WINESERVER(`${path.dirname(userReg)}/`) }));
  configureLaunchTiming({ wineserverExitMs: 300, wineserverPollMs: 20 });

  const started = Date.now();
  const payload = JSON.parse(textOf(await launch({})));

  assert.ok(Date.now() - started >= 300);
  assert.match(payload.note, /still held the Proton prefix/);
  assert.match(payload.note, /may be lost/);
  assert.ok((await fs.readFile(copy, 'utf8')).includes('"winhttp"="native,builtin"'), 'written anyway');
});

test('a refused launch names its own settings, once, and stops nothing', { timeout: 30000, skip: !isLinux }, async (t) => {
  const marker = path.join(scratch, `not-run-${++counter}`);
  const f = await stubSteam(t, `: > '${marker}'`);
  noGame();
  const lookups = { ...f.lookups, onPath: async () => false, steamRoots: () => [path.dirname(f.steamSh)] };
  setLaunchResolver((requested, _env, platform, config) =>
    resolveLaunchCommand(requested, { BROFORCE_PROFILE: 'Absent' }, 'linux', config, lookups));

  const response = await launch({});

  assert.equal(response.isError, true, textOf(response));
  assert.match(textOf(response), /BROFORCE_PROFILE/);
  assert.doesNotMatch(textOf(response), /BROFORCE_LAUNCH_CMD should hold/);
  assert.equal(existsSync(marker), false);
});

test('a preparation that fails launches nothing and is a tool error', { timeout: 30000, skip: !isLinux }, async (t) => {
  const marker = path.join(scratch, `prep-${++counter}`);
  const f = await stubSteam(t, `: > '${marker}'`);
  noGame();
  const lookups = { ...f.lookups, onPath: async () => false, steamRoots: () => [path.dirname(f.steamSh)] };
  setLaunchResolver(async (requested, _env, platform, config) => {
    const resolved = await resolveLaunchCommand(requested, {}, 'linux', config, lookups);
    return { ...resolved, prepare: { scriptsDir: path.join(scratch, 'no-such-profile') } };
  });

  const response = await launch({});

  assert.equal(response.isError, true, textOf(response));
  assert.match(textOf(response), /Could not prepare the Steam launch/);
  assert.match(textOf(response), /nothing was stopped/);
  assert.equal(existsSync(marker), false);
});

test('--vanilla in launchArgs travels as the vanilla option, turned into the path\'s own spelling', async () => {
  const f = await fixture();
  const composed = composeExtraLaunchArgs({ launchArgs: '-x --vanilla -- --vanilla' });
  assert.deepEqual(composed, { vanilla: true, extraArgs: ['-x', '--', '--vanilla'] });

  const launch = await resolve(composed, { lookups: f.lookups });
  assert.deepEqual(applaunchArgs(launch), ['--doorstop-enabled', 'false', '-x', '--', '--vanilla']);
});

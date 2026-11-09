import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { wineserverHoldsPrefix } from './game-process.js';
import { FLATPAK_STEAM_ROOT, STEAM_APP_ID, cancelledError, findSteamGame, steamRoots } from './unity-client.js';

export const PROFILE_ENV = 'BROFORCE_PROFILE';
export const LAUNCH_TYPE_ENV = 'BROFORCE_LAUNCH_TYPE';
export const LAUNCH_REFUSED = 'LAUNCH_REFUSED';

const DEFAULT_PROFILE = 'Default';
const PRELOADER = ['UMM', 'Core', 'UnityModManager.dll'];
const R2_PROFILES = ['r2modmanPlus-local', 'Broforce', 'profiles'];
// Electron's appData inside the Flatpak sandbox is the app's own XDG_CONFIG_HOME
const FLATPAK_R2_ROOT = ['.var', 'app', 'com.github.ebkr.r2modman', 'config', 'r2modmanPlus-local', 'Broforce'];
const WRAPPER_ARGS = 'wrapper_args.txt';
const LAUNCH_TYPES = ['auto', 'native', 'proton'];
const REGISTRY_TIMEOUT_MS = 5000;
const STEAM_REGISTRY = [
  ['HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'],
  ['HKCU\\Software\\Valve\\Steam', 'SteamPath'],
];
const DLL_OVERRIDES_SECTION = '[Software\\\\Wine\\\\DllOverrides]';
const WINHTTP_OVERRIDE = '"winhttp"="native,builtin"';

function refusal(message) {
  const error = new Error(message);
  error.code = LAUNCH_REFUSED;
  return error;
}

async function isFile(file) {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

export function parseRegQuery(stdout, value) {
  const match = new RegExp(`^\\s*${value}\\s+REG_\\w+\\s+(.+?)\\s*$`, 'm').exec(stdout);
  return match ? match[1] : null;
}

function realRegistryValue(key, value) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/v', value], { timeout: REGISTRY_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      resolve(error ? null : parseRegQuery(stdout, value));
    });
  });
}

export async function realOnPath(name, env) {
  for (const dir of String(env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    try {
      await fs.access(path.join(dir, name), fs.constants.X_OK);
      if (await isFile(path.join(dir, name))) return true;
    } catch {}
  }
  return false;
}

// Electron's appData on Linux, which r2modman's folder hangs off
function linuxConfigHome(env) {
  const xdg = String(env.XDG_CONFIG_HOME ?? '').trim();
  return xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.config');
}

export function realProfilesRoot(env, platform) {
  const config = platform === 'win32'
    ? env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    : linuxConfigHome(env);
  return path.join(config, ...R2_PROFILES);
}

export function realFlatpakDataRoot(platform) {
  return platform === 'linux' ? path.join(os.homedir(), ...FLATPAK_R2_ROOT) : null;
}

export function r2modmanProfileRoots(env = process.env) {
  return [...new Set([
    realProfilesRoot(env, 'linux'),
    path.join(realFlatpakDataRoot('linux'), 'profiles'),
    realProfilesRoot(env, 'win32'),
    path.join(os.homedir(), 'AppData', 'Roaming', ...R2_PROFILES),
  ])];
}

function lookupsFor(given, env, platform) {
  const real = {
    registry: realRegistryValue,
    onPath: (name) => realOnPath(name, env),
    steamRoots: () => steamRoots(),
    findSteamGame: () => findSteamGame(),
    profilesRoot: () => realProfilesRoot(env, platform),
    flatpakDataRoot: () => realFlatpakDataRoot(platform),
  };
  const lookups = {};
  for (const [name, lookup] of Object.entries(real)) {
    lookups[name] = given[name] ?? (process.env.UNITY_INSPECTOR_TEST
      ? () => { throw new Error(`Refusing the real Steam ${name} lookup while UNITY_INSPECTOR_TEST is set: inject it.`); }
      : lookup);
  }
  return lookups;
}

async function windowsSteam(lookups) {
  for (const [key, value] of STEAM_REGISTRY) {
    const dir = await lookups.registry(key, value);
    if (dir) return { command: path.join(dir, 'steam.exe'), args: [] };
  }
  return null;
}

async function linuxSteam(lookups) {
  if (await lookups.onPath('steam')) return { command: 'steam', args: [] };
  for (const root of await lookups.steamRoots()) {
    const script = path.join(root, 'steam.sh');
    if (!(await isFile(script))) continue;
    // Flatpak Steam's steam.sh cannot run outside its sandbox
    if (!root.endsWith(FLATPAK_STEAM_ROOT)) return { command: script, args: [] };
    if (await lookups.onPath('flatpak')) return { command: 'flatpak', args: ['run', 'com.valvesoftware.Steam'] };
  }
  return null;
}

async function profileAt(dir, flatpakRoot = null) {
  const preloader = path.join(dir, ...PRELOADER);
  return (await isFile(preloader)) ? { dir, name: path.basename(dir), preloader, flatpakRoot } : null;
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function resolveProfile(env, lookups, platform) {
  const given = String(env[PROFILE_ENV] ?? '').trim();
  const flatpakRoot = async () => (platform === 'linux' ? lookups.flatpakDataRoot() : null);
  const looked = [];
  const look = async (dir, root = null) => {
    looked.push(path.join(dir, ...PRELOADER));
    return profileAt(dir, root);
  };

  let found;
  if (path.isAbsolute(given)) {
    const root = await flatpakRoot();
    found = await look(given, root && isInside(path.join(root, 'profiles'), given) ? root : null);
  } else {
    const name = given || DEFAULT_PROFILE;
    found = await look(path.join(await lookups.profilesRoot(), name));
    const root = found ? null : await flatpakRoot();
    if (root) found = await look(path.join(root, 'profiles', name), root);
  }
  if (found) return found;
  if (!given) return null;
  throw refusal(
    `Nothing was launched: ${PROFILE_ENV} names a profile with no Unity Mod Manager, ${looked.join(' and ')} ` +
    `${looked.length > 1 ? 'do' : 'does'} not exist. ` +
    `Set ${PROFILE_ENV} to a profile that has one, or BROFORCE_LAUNCH_CMD to a command that starts the game.`
  );
}

async function linuxLaunchType(env, gamePath) {
  const given = String(env[LAUNCH_TYPE_ENV] ?? '').trim().toLowerCase() || 'auto';
  if (!LAUNCH_TYPES.includes(given)) {
    throw refusal(`Nothing was launched: ${LAUNCH_TYPE_ENV} must be auto, native or proton, not "${env[LAUNCH_TYPE_ENV]}".`);
  }
  if (given !== 'auto') return given;
  const entries = gamePath ? await fs.readdir(gamePath).catch(() => []) : [];
  return entries.includes('.forceproton') || entries.some(name => name.toLowerCase().endsWith('.exe')) ? 'proton' : 'native';
}

async function doorstopMajor(dir) {
  if (!dir) return null;
  try {
    const major = Number((await fs.readFile(path.join(dir, '.doorstop_version'), 'utf8')).split('.')[0]);
    return Number.isFinite(major) && major > 0 ? major : null;
  } catch {
    return null;
  }
}

async function gameHoldsDoorstop(gamePath) {
  if (!gamePath) return false;
  const inGame = (name) => isFile(path.join(gamePath, name));
  return (await inGame('winhttp.dll')) || (await inGame('doorstop_config.ini')) ||
    ((await inGame('run_umm.sh')) && (await inGame('.doorstop_version')));
}

function doorstopArgs(major, target = null) {
  const [enabled, assembly] = major > 3
    ? ['--doorstop-enabled', '--doorstop-target-assembly']
    : ['--doorstop-enable', '--doorstop-target'];
  return target === null ? [enabled, 'false'] : [enabled, 'true', assembly, target];
}

function refuseSpaces(doorstop, extraArgs) {
  const spaced = (args) => args.find(arg => /\s/.test(arg));
  const inDoorstop = spaced(doorstop);
  const inExtra = spaced(extraArgs);
  if (inDoorstop === undefined && inExtra === undefined) return;
  const what = inDoorstop !== undefined ? `the Doorstop argument "${inDoorstop}"` : `the launchArgs token "${inExtra}"`;
  throw refusal(
    `Nothing was launched: Steam on Linux splits an -applaunch argument at its spaces, even quoted ` +
    `(steam-for-linux issue 8315), so ${what} would reach the game broken. Remove the space, or set ` +
    `BROFORCE_LAUNCH_CMD to a command that starts the game.`
  );
}

function refuseUnreadableLines(doorstop, extraArgs) {
  const unreadable = [...doorstop, ...extraArgs].find(arg => arg === '' || arg.includes('\n') || arg.startsWith('#'));
  if (unreadable === undefined) return;
  throw refusal(
    `Nothing was launched: the Flatpak r2modman's web_start_wrapper.sh reads one argument per line and skips ` +
    `empty lines and lines starting with #, so ${JSON.stringify(unreadable)} would not reach the game as given. ` +
    `Change that argument, or set BROFORCE_LAUNCH_CMD to a command that starts the game.`
  );
}

function startCauses({ platform, hasProfile, launchType, vanilla, flatpakRoot }) {
  if (flatpakRoot) {
    return {
      confirmation: null,
      launchOptions: `for the Flatpak r2modman's launch arguments to reach the game, Broforce's Steam Launch Options must run "${path.join(flatpakRoot, 'web_start_wrapper.sh')}" before %command%, as r2modman's setup screen gives them`,
    };
  }
  let launchOptions = null;
  if (platform === 'linux' && hasProfile) {
    if (launchType === 'proton') launchOptions = "under Proton, Broforce's Steam Launch Options must be empty";
    else if (!vanilla) launchOptions = "for a native game to load the profile, Broforce's Steam Launch Options must run r2modman's linux_wrapper.sh before %command%, as r2modman's setup screen gives them";
  }
  return { confirmation: 'Steam may be waiting on its "Allow game launch?" confirmation', launchOptions };
}

export async function resolveSteamLaunch({ vanilla = false, extraArgs = [] } = {}, { env = process.env, platform = process.platform, lookups = {} } = {}) {
  if (platform !== 'win32' && platform !== 'linux') return null;
  const look = lookupsFor(lookups, env, platform);
  const steam = platform === 'win32' ? await windowsSteam(look) : await linuxSteam(look);
  if (steam === null) return null;

  const { gamePath, steamapps } = await look.findSteamGame();
  const launchType = platform === 'linux' ? await linuxLaunchType(env, gamePath) : null;
  const profile = await resolveProfile(env, look, platform);
  const major = (profile && await doorstopMajor(profile.dir)) ?? (await doorstopMajor(gamePath)) ?? 3;

  let doorstop = [];
  let prepare = null;
  let vanillaHonoured = vanilla;
  if (vanilla) {
    if (profile || await gameHoldsDoorstop(gamePath)) doorstop = doorstopArgs(major);
    else vanillaHonoured = false;
  } else if (profile) {
    if (platform === 'linux') {
      const real = await fs.realpath(profile.preloader);
      doorstop = [...doorstopArgs(major, launchType === 'proton' ? `Z:${real}` : real), '--r2profile', profile.name];
      prepare = launchType === 'proton'
        ? { userReg: steamapps ? path.join(steamapps, 'compatdata', STEAM_APP_ID, 'pfx', 'user.reg') : null }
        : { scriptsDir: profile.dir };
    } else {
      doorstop = doorstopArgs(major, profile.preloader);
    }
  }
  if (profile?.flatpakRoot) {
    refuseUnreadableLines(doorstop, extraArgs);
    // web_start_wrapper.sh execs a first line naming an existing file as the wrapper; r2modman puts -- there for Proton
    const first = launchType === 'proton' ? '--' : path.join(profile.flatpakRoot, 'linux_wrapper.sh');
    const url = `steam://run/${STEAM_APP_ID}/`;
    return {
      source: 'steam-flatpak-r2modman',
      command: 'xdg-open',
      args: [url],
      display: `xdg-open ${url}`,
      vanilla,
      ignoredArgs: [],
      waitsOnExit: false,
      prepare: {
        ...prepare,
        wrapperArgs: { file: path.join(profile.flatpakRoot, WRAPPER_ARGS), text: [first, ...doorstop, ...extraArgs].join('\n') },
      },
      startCauses: startCauses({ platform, hasProfile: true, launchType, vanilla, flatpakRoot: profile.flatpakRoot }),
    };
  }
  if (platform === 'linux') refuseSpaces(doorstop, extraArgs);

  const args = [...steam.args, '-applaunch', STEAM_APP_ID, ...doorstop, ...extraArgs];
  return {
    source: 'steam-applaunch',
    command: steam.command,
    args,
    display: [steam.command, ...args].join(' '),
    vanilla: vanillaHonoured,
    ignoredArgs: vanilla && !vanillaHonoured ? ['--vanilla'] : [],
    ignoredReason: 'no r2modman profile was found and the game folder holds no Doorstop to switch off, so the game starts the way its install loads mods.',
    waitsOnExit: false,
    prepare,
    startCauses: startCauses({ platform, hasProfile: profile !== null, launchType, vanilla: vanillaHonoured }),
  };
}

export function withWinhttpOverride(text) {
  const lines = text.split('\n');
  const header = lines.findIndex(line => line.startsWith(DLL_OVERRIDES_SECTION));
  if (header === -1) return `${text.replace(/\n*$/, '')}\n\n${DLL_OVERRIDES_SECTION}\n${WINHTTP_OVERRIDE}\n`;

  let end = lines.findIndex((line, index) => index > header && line.length === 0);
  if (end === -1) end = lines.length;
  const existing = lines.findIndex((line, index) => index > header && index < end && /^"winhttp"=/i.test(line));
  if (existing !== -1) lines[existing] = WINHTTP_OVERRIDE;
  else lines.splice(end, 0, WINHTTP_OVERRIDE);
  return lines.join('\n');
}

const NO_PREFIX_NOTE = 'No Proton prefix holds a user.reg yet, so the Doorstop override could not be set; a modded launch needs the game to have run once under Proton.';

async function readUserReg(userReg) {
  try {
    return await fs.readFile(userReg, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function makeScriptsExecutable(dir) {
  const real = await fs.realpath(dir);
  for (const name of await fs.readdir(real)) {
    if (name.endsWith('.sh')) await fs.chmod(await fs.realpath(path.join(real, name)), 0o755);
  }
}

async function checkWritable(file) {
  try {
    await fs.access(file, fs.constants.W_OK);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  await fs.access(path.dirname(file), fs.constants.W_OK);
}

export async function preflightSteamLaunch(prepare) {
  if (!prepare) return;
  if (prepare.scriptsDir) await makeScriptsExecutable(prepare.scriptsDir);
  if (prepare.userReg && (await readUserReg(prepare.userReg)) !== null) await checkWritable(prepare.userReg);
  if (prepare.wrapperArgs) await checkWritable(prepare.wrapperArgs.file);
}

async function writeProtonOverride(userReg, { waitMs, pollMs, sleep, signal = null }) {
  if (userReg === null) return [NO_PREFIX_NOTE];

  const prefix = path.dirname(userReg);
  const deadline = Date.now() + waitMs;
  // A wineserver saves its registry over user.reg as it exits, and Proton waits for that exit before it starts the game, so a write made before then is lost and one read before then overwrites what it saved
  let held = await wineserverHoldsPrefix(prefix);
  while (held && Date.now() < deadline) {
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    if (signal?.aborted) throw cancelledError('launch_game');
    held = await wineserverHoldsPrefix(prefix);
  }

  const text = await readUserReg(userReg);
  if (text === null) return [NO_PREFIX_NOTE];
  const ensured = withWinhttpOverride(text);
  if (ensured !== text) {
    await fs.copyFile(userReg, `${userReg}.bak`);
    await fs.writeFile(userReg, ensured);
  }
  return held
    ? [`A wineserver still held the Proton prefix after ${waitMs / 1000}s, so the Doorstop override in ${userReg} may be lost when it exits, and the game would then come up without its mods.`]
    : [];
}

export async function prepareSteamLaunch(prepare, options) {
  const notes = prepare && 'userReg' in prepare ? await writeProtonOverride(prepare.userReg, options) : [];
  const wrapperArgs = prepare?.wrapperArgs;
  if (wrapperArgs) {
    try {
      await fs.writeFile(wrapperArgs.file, wrapperArgs.text);
    } catch (err) {
      err.wrapperArgs = wrapperArgs.file;
      throw err;
    }
    wrapperArgs.written = true;
  }
  return notes;
}

// web_start_wrapper.sh blanks the file once it has read it, so the server's own text still there means Steam never ran the wrapper
export async function withdrawWrapperArgs(prepare) {
  const wrapperArgs = prepare?.wrapperArgs;
  if (!wrapperArgs?.written) return false;
  try {
    if ((await fs.readFile(wrapperArgs.file, 'utf8')) !== wrapperArgs.text) return false;
    await fs.writeFile(wrapperArgs.file, '');
    return true;
  } catch (err) {
    console.error(`launch_game: could not withdraw the launch arguments in ${wrapperArgs.file}: ${err.message}`);
    return false;
  }
}

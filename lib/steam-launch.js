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

export function realProfilesRoot(env, platform) {
  const config = platform === 'win32'
    ? env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    : path.join(os.homedir(), '.config');
  return path.join(config, ...R2_PROFILES);
}

function lookupsFor(given, env, platform) {
  const real = {
    registry: realRegistryValue,
    onPath: (name) => realOnPath(name, env),
    steamRoots: () => steamRoots(),
    findSteamGame: () => findSteamGame(),
    profilesRoot: () => realProfilesRoot(env, platform),
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

async function resolveProfile(env, lookups) {
  const given = String(env[PROFILE_ENV] ?? '').trim();
  const dir = path.isAbsolute(given) ? given : path.join(await lookups.profilesRoot(), given || DEFAULT_PROFILE);
  const preloader = path.join(dir, ...PRELOADER);
  if (await isFile(preloader)) return { dir, name: path.basename(dir), preloader };
  if (!given) return null;
  throw refusal(
    `Nothing was launched: ${PROFILE_ENV} names a profile with no Unity Mod Manager, ${preloader} does not exist. ` +
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

function startCauses({ platform, hasProfile, launchType, vanilla }) {
  let launchOptions = null;
  if (platform === 'linux' && hasProfile) {
    if (launchType === 'proton') launchOptions = "under Proton, Broforce's Steam Launch Options must be empty";
    else if (!vanilla) launchOptions = "a native game loads the profile only with r2modman's linux_wrapper.sh %command% as its Steam Launch Options";
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
  const profile = await resolveProfile(env, look);
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

export async function preflightSteamLaunch(prepare) {
  if (!prepare) return;
  if (prepare.scriptsDir) await makeScriptsExecutable(prepare.scriptsDir);
  if (!prepare.userReg || (await readUserReg(prepare.userReg)) === null) return;
  await fs.access(prepare.userReg, fs.constants.W_OK);
  await fs.access(path.dirname(prepare.userReg), fs.constants.W_OK);
}

export async function prepareSteamLaunch(prepare, { waitMs, pollMs, sleep, signal = null }) {
  if (!prepare || !('userReg' in prepare)) return [];
  if (prepare.userReg === null) return [NO_PREFIX_NOTE];

  const prefix = path.dirname(prepare.userReg);
  const deadline = Date.now() + waitMs;
  // A wineserver saves its registry over user.reg as it exits, and Proton waits for that exit before it starts the game, so a write made before then is lost and one read before then overwrites what it saved
  let held = await wineserverHoldsPrefix(prefix);
  while (held && Date.now() < deadline) {
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    if (signal?.aborted) throw cancelledError('launch_game');
    held = await wineserverHoldsPrefix(prefix);
  }

  const text = await readUserReg(prepare.userReg);
  if (text === null) return [NO_PREFIX_NOTE];
  const ensured = withWinhttpOverride(text);
  if (ensured !== text) {
    await fs.copyFile(prepare.userReg, `${prepare.userReg}.bak`);
    await fs.writeFile(prepare.userReg, ensured);
  }
  return held
    ? [`A wineserver still held the Proton prefix after ${waitMs / 1000}s, so the Doorstop override in ${prepare.userReg} may be lost when it exits, and the game would then come up without its mods.`]
    : [];
}

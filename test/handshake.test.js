import { NO_TOKEN_FILE } from './support/session.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import {
  HANDSHAKE_PROTOCOL,
  HANDSHAKE_REFUSED,
  HANDSHAKE_TIMEOUT,
  UnityInspectorClient,
  findSteamGame,
  readTokenFile,
  steamLibraryPaths,
  steamTokenSearch,
  tokenFileName,
  tokenSearchIn,
  unityDataDirs,
} from '../lib/unity-client.js';
import { startStubServer, reply } from './support/stub-server.js';

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'inspector-token-'));
test.after(() => fs.rm(scratch, { recursive: true, force: true }));

let dirCounter = 0;
async function tokenDir() {
  const dir = path.join(scratch, `data-${++dirCounter}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

const echo = (request, socket) => reply(socket, request.id, { from: request.method });

function clientFor(stub, { dir = null, connectTimeoutMs = 2000 } = {}) {
  const client = new UnityInspectorClient({ host: '127.0.0.1', port: stub.port, connectTimeoutMs });
  if (dir) client.pointAt({ port: stub.port, tokenSearch: (port) => tokenSearchIn([dir], port) });
  return client;
}

async function writeToken(dir, port, token) {
  const file = path.join(dir, tokenFileName(port));
  await fs.writeFile(file, `${token}\n`);
  return file;
}

async function stubWith(hello, onRequest = echo) {
  return startStubServer(onRequest, { hello });
}

test('a connection opens with a hello carrying the token, and a command follows only once it is accepted', { timeout: 10000 }, async (t) => {
  const stub = await stubWith('accept');
  const dir = await tokenDir();
  await writeToken(dir, stub.port, '  secret-1  ');
  const client = clientFor(stub, { dir });
  t.after(async () => { client.disconnect(); await stub.close(); });

  assert.deepEqual(await client.sendCommand('ping', {}, 3000), { from: 'ping' });

  assert.equal(stub.firstLines.length, 1);
  assert.equal(stub.firstLines[0].method, 'hello', 'the first line on the wire must be the hello');
  assert.match(String(stub.firstLines[0].id), /^\d+-\d+$/);
  assert.deepEqual(stub.hellos, [{ token: 'secret-1', protocol: HANDSHAKE_PROTOCOL }]);
  assert.equal(client.isConnected(), true);
});

test('no command is sent while the hello is unanswered', { timeout: 10000 }, async (t) => {
  const seen = [];
  const stub = await stubWith('silent', (request) => seen.push(request.method));
  const client = clientFor(stub, { dir: await tokenDir(), connectTimeoutMs: 300 });
  t.after(async () => { client.disconnect(); await stub.close(); });

  await assert.rejects(client.sendCommand('ping', {}, 3000));
  assert.deepEqual(stub.firstLines.map((line) => line.method), ['hello']);
  assert.deepEqual(seen, []);
});

test('a mod older than the handshake is named, and the socket is dropped', { timeout: 10000 }, async (t) => {
  const stub = await stubWith('old-mod');
  const client = clientFor(stub, { dir: await tokenDir() });
  t.after(async () => { client.disconnect(); await stub.close(); });

  const error = await client.connect().then(() => null, (err) => err);
  assert.equal(error?.code, HANDSHAKE_REFUSED);
  assert.equal(
    error.message,
    'The Unity Inspector Mod in the game has no connection handshake, so it is older than this server. ' +
    'Update the Unity Inspector Mod.',
  );
  assert.equal(client.isConnected(), false);
  assert.equal(client.socket?.destroyed ?? true, true, 'a refused socket must not stay open');
});

test('sendCommand passes a refusal on unchanged', { timeout: 10000 }, async (t) => {
  const stub = await stubWith('old-mod');
  const client = clientFor(stub, { dir: await tokenDir() });
  t.after(async () => { client.disconnect(); await stub.close(); });

  await assert.rejects(client.sendCommand('ping', {}, 3000), (err) => {
    assert.equal(err.code, HANDSHAKE_REFUSED);
    assert.match(err.message, /older than this server\. Update the Unity Inspector Mod\.$/);
    return true;
  });
});

test('a protocol mismatch says which side to update', { timeout: 10000 }, async (t) => {
  const stub = await stubWith({ protocol: HANDSHAKE_PROTOCOL + 1 });
  const client = clientFor(stub, { dir: await tokenDir() });
  t.after(async () => { client.disconnect(); await stub.close(); });

  await assert.rejects(client.connect(), {
    code: HANDSHAKE_REFUSED,
    message: `The Unity Inspector Mod speaks handshake protocol ${HANDSHAKE_PROTOCOL + 1} and this server speaks ` +
      `${HANDSHAKE_PROTOCOL}. Update the Unity Inspector MCP server. An MCP session whose server files are already updated loads them with the restart_server tool.`,
  });

  client.disconnect();
  stub.hello = { protocol: HANDSHAKE_PROTOCOL - 1 };
  await assert.rejects(client.connect(), {
    code: HANDSHAKE_REFUSED,
    message: `The Unity Inspector Mod speaks handshake protocol ${HANDSHAKE_PROTOCOL - 1} and this server speaks ` +
      `${HANDSHAKE_PROTOCOL}. Update the Unity Inspector Mod.`,
  });

  client.disconnect();
  stub.hello = { acceptAs: HANDSHAKE_PROTOCOL + 1 };
  await assert.rejects(client.connect(), {
    code: HANDSHAKE_REFUSED,
    message: /speaks handshake protocol 2 and this server speaks 1\. Update the Unity Inspector MCP server\. An MCP session whose server files are already updated loads them with the restart_server tool\.$/,
  });
  assert.equal(client.isConnected(), false);
});

test('a refused token names the file it came from and the mod\'s own words', { timeout: 10000 }, async (t) => {
  const stub = await stubWith('refuse');
  const dir = await tokenDir();
  const file = await writeToken(dir, stub.port, 'stale');
  const client = clientFor(stub, { dir });
  t.after(async () => { client.disconnect(); await stub.close(); });

  await assert.rejects(client.connect(), {
    code: HANDSHAKE_REFUSED,
    message: `The Unity Inspector Mod refused the token in ${file}. Invalid token`,
  });
  assert.deepEqual(stub.hellos, [{ token: 'stale', protocol: HANDSHAKE_PROTOCOL }]);
});

test('with no token file the hello carries none and the refusal names where it looked', { timeout: 10000 }, async (t) => {
  const stub = await stubWith('refuse');
  const first = await tokenDir();
  const second = await tokenDir();
  const client = new UnityInspectorClient({ host: '127.0.0.1', port: stub.port, connectTimeoutMs: 2000 });
  client.pointAt({ port: stub.port, tokenSearch: (port) => tokenSearchIn([first, second], port) });
  t.after(async () => { client.disconnect(); await stub.close(); });

  await assert.rejects(client.connect(), {
    code: HANDSHAKE_REFUSED,
    message: `Found no unity-inspector-${stub.port}.token in ${first}, ${second}. ` +
      'The Unity Inspector Mod writes it when its server starts.',
  });
  assert.deepEqual(stub.hellos, [{ token: null, protocol: HANDSHAKE_PROTOCOL }]);
});

test('the user\'s game names UNITY_INSPECTOR_TOKEN_FILE when that file is missing', { timeout: 10000 }, async (t) => {
  const stub = await stubWith('refuse');
  const client = new UnityInspectorClient({ host: '127.0.0.1', port: stub.port, connectTimeoutMs: 2000 });
  t.after(async () => { client.disconnect(); await stub.close(); });

  await assert.rejects(client.connect(), {
    code: HANDSHAKE_REFUSED,
    message: `Found no unity-inspector-${stub.port}.token in ${NO_TOKEN_FILE} (UNITY_INSPECTOR_TOKEN_FILE). ` +
      'The Unity Inspector Mod writes it when its server starts.',
  });
});

test('a hello with no reply times out within the connect budget and is not a refusal', { timeout: 10000 }, async (t) => {
  const stub = await stubWith('silent');
  const client = clientFor(stub, { dir: await tokenDir(), connectTimeoutMs: 300 });
  t.after(async () => { client.disconnect(); await stub.close(); });

  const started = Date.now();
  const error = await client.connect().then(() => null, (err) => err);
  const elapsed = Date.now() - started;

  assert.ok(error, 'connect resolved without a reply to the hello');
  assert.notEqual(error.code, HANDSHAKE_REFUSED);
  assert.equal(error.code, HANDSHAKE_TIMEOUT);
  assert.match(error.message, new RegExp(`127\\.0\\.0\\.1:${stub.port}`));
  assert.ok(elapsed < 2000, `the hello wait ran ${elapsed}ms against a 300ms budget`);
  assert.equal(client.isConnected(), false);
});

test('a socket closed during the hello is the closed-connection path, not a refusal', { timeout: 10000 }, async (t) => {
  const stub = await stubWith('close');
  const client = clientFor(stub, { dir: await tokenDir() });
  t.after(async () => { client.disconnect(); await stub.close(); });

  const error = await client.connect().then(() => null, (err) => err);
  assert.ok(error);
  assert.notEqual(error.code, HANDSHAKE_REFUSED);
  assert.match(error.message, /Connection closed before it was established|ECONNRESET/);
  assert.equal(error.stage, 'handshake');
});

test('the token is read again on every connect', { timeout: 10000 }, async (t) => {
  let current = 'first';
  const stub = await stubWith((params) => (params.token === current ? 'accept' : 'refuse'));
  const dir = await tokenDir();
  await writeToken(dir, stub.port, 'first');
  const client = clientFor(stub, { dir });
  t.after(async () => { client.disconnect(); await stub.close(); });

  assert.deepEqual(await client.sendCommand('ping', {}, 3000), { from: 'ping' });
  client.disconnect();

  current = 'second';
  await writeToken(dir, stub.port, 'second');
  assert.deepEqual(await client.sendCommand('ping', {}, 3000), { from: 'ping' });

  assert.deepEqual(stub.hellos.map((hello) => hello.token), ['first', 'second']);
});

async function fakeHome() {
  const home = path.join(scratch, `home-${++dirCounter}`);
  await fs.mkdir(home, { recursive: true });
  return home;
}

test('the user\'s game is searched for in every data folder, XDG_CONFIG_HOME first when absolute', async () => {
  const home = await fakeHome();
  const unset = await steamTokenSearch(9999, { env: {}, home });
  assert.equal(unset.override, false);
  assert.deepEqual(unset.searched, [
    path.join(home, '.config/unity3d/Free Lives/Broforce'),
    path.join(home, '.var/app/com.valvesoftware.Steam/config/unity3d/Free Lives/Broforce'),
    path.join(home, '.var/app/com.valvesoftware.Steam/.config/unity3d/Free Lives/Broforce'),
    path.join(home, 'AppData/LocalLow/Free Lives/Broforce'),
    path.join(home, 'Library/Application Support/Free Lives/Broforce'),
  ]);
  assert.deepEqual(unset.files, unset.searched.map((dir) => path.join(dir, 'unity-inspector-9999.token')));

  const xdg = path.join(scratch, 'xdg');
  const set = await steamTokenSearch(9999, { env: { XDG_CONFIG_HOME: xdg, USERPROFILE: '/c/Users/someone' }, home });
  assert.deepEqual(set.searched, [
    path.join(xdg, 'unity3d/Free Lives/Broforce'),
    path.join(home, '.config/unity3d/Free Lives/Broforce'),
    path.join(home, '.var/app/com.valvesoftware.Steam/config/unity3d/Free Lives/Broforce'),
    path.join(home, '.var/app/com.valvesoftware.Steam/.config/unity3d/Free Lives/Broforce'),
    path.join('/c/Users/someone', 'AppData/LocalLow/Free Lives/Broforce'),
    path.join(home, 'AppData/LocalLow/Free Lives/Broforce'),
    path.join(home, 'Library/Application Support/Free Lives/Broforce'),
  ]);

  const relative = await steamTokenSearch(9999, { env: { XDG_CONFIG_HOME: 'relative/config' }, home });
  assert.deepEqual(relative.searched, unset.searched, 'a relative XDG_CONFIG_HOME is not a place');
});

test('the search reaches the Proton prefix and, on WSL, every Windows user', async () => {
  const home = await fakeHome();
  const prefix = path.join(scratch, 'pfx');
  const users = path.join(scratch, `wsl-users-${++dirCounter}`);
  await fs.mkdir(path.join(users, 'alice'), { recursive: true });
  await fs.mkdir(path.join(users, 'bob'), { recursive: true });
  await fs.writeFile(path.join(users, 'desktop.ini'), '');

  const { searched } = await steamTokenSearch(4321, { env: {}, home, protonPrefix: prefix, wsl: true, wslUsersRoot: users });
  assert.ok(searched.includes(path.join(prefix, 'drive_c/users/steamuser/AppData/LocalLow/Free Lives/Broforce')));
  assert.ok(searched.includes(path.join(users, 'alice/AppData/LocalLow/Free Lives/Broforce')));
  assert.ok(searched.includes(path.join(users, 'bob/AppData/LocalLow/Free Lives/Broforce')));
  assert.ok(!searched.some((dir) => dir.includes('desktop.ini')));

  const notWsl = await steamTokenSearch(4321, { env: {}, home, wslUsersRoot: users });
  assert.ok(!notWsl.searched.some((dir) => dir.startsWith(users)), 'the Windows users are only searched on WSL');
});

async function installGame(library, { proton = false } = {}) {
  await fs.mkdir(path.join(library, 'steamapps/common/Broforce'), { recursive: true });
  const prefix = path.join(library, 'steamapps/compatdata/274190/pfx');
  if (proton) await fs.mkdir(prefix, { recursive: true });
  return prefix;
}

async function writeLibraryFolders(steamRoot, libraries) {
  await fs.mkdir(path.join(steamRoot, 'steamapps'), { recursive: true });
  const entries = libraries.map((library, i) => `\t"${i}"\n\t{\n\t\t"path"\t\t"${library}"\n\t\t"apps"\n\t\t{\n\t\t}\n\t}`);
  await fs.writeFile(path.join(steamRoot, 'steamapps/libraryfolders.vdf'), `"libraryfolders"\n{\n${entries.join('\n')}\n}\n`);
}

test('libraryfolders.vdf names every library, escapes undone', () => {
  const vdf = '"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"/home/u/.local/share/Steam"\n\t}\n' +
    '\t"1"\n\t{\n\t\t"path"\t\t"/run/media/sd card/Steam"\n\t\t"label"\t\t""\n\t}\n' +
    '\t"2"\n\t{\n\t\t"path"\t\t"D:\\\\Games\\\\Steam"\n\t}\n}\n';
  assert.deepEqual(steamLibraryPaths(vdf), ['/home/u/.local/share/Steam', '/run/media/sd card/Steam', 'D:\\Games\\Steam']);
  assert.deepEqual(steamLibraryPaths('not a vdf'), []);
});

test('the game and its Proton prefix are found in a second Steam library, and the token search reaches that prefix', async () => {
  const home = await fakeHome();
  const second = path.join(scratch, `library-${++dirCounter}`);
  const prefix = await installGame(second, { proton: true });
  await writeLibraryFolders(path.join(home, '.local/share/Steam'), [path.join(home, '.local/share/Steam'), second]);

  assert.deepEqual(await findSteamGame({ home }), { gamePath: path.join(second, 'steamapps/common/Broforce'), protonPrefix: prefix, steamapps: path.join(second, 'steamapps') });

  const client = new UnityInspectorClient({ host: '127.0.0.1', port: 1 });
  await client.detectGamePaths({ home });
  assert.equal(client.protonPrefix, prefix);
  const { searched } = await steamTokenSearch(9999, { env: {}, home, protonPrefix: client.protonPrefix });
  assert.ok(searched.includes(path.join(prefix, 'drive_c/users/steamuser/AppData/LocalLow/Free Lives/Broforce')));
  const { windows } = await unityDataDirs({ env: {}, home, protonPrefix: client.protonPrefix });
  assert.ok(windows.includes(path.join(prefix, 'drive_c/users/steamuser/AppData/LocalLow/Free Lives/Broforce')),
    'the player-log search reads the same folders');
});

test('a game under Flatpak Steam is found, its own libraries included, and its data folders are searched', async () => {
  const home = await fakeHome();
  const flatpakRoot = path.join(home, '.var/app/com.valvesoftware.Steam/.local/share/Steam');
  const prefix = await installGame(flatpakRoot, { proton: true });
  assert.deepEqual(await findSteamGame({ home }), { gamePath: path.join(flatpakRoot, 'steamapps/common/Broforce'), protonPrefix: prefix, steamapps: path.join(flatpakRoot, 'steamapps') });

  const other = await fakeHome();
  const otherRoot = path.join(other, '.var/app/com.valvesoftware.Steam/.local/share/Steam');
  const card = path.join(scratch, `card-${++dirCounter}`);
  await installGame(card);
  await writeLibraryFolders(otherRoot, [otherRoot, card]);
  assert.deepEqual(await findSteamGame({ home: other }), { gamePath: path.join(card, 'steamapps/common/Broforce'), protonPrefix: null, steamapps: path.join(card, 'steamapps') },
    'a native game has no prefix');

  const { searched } = await steamTokenSearch(9999, { env: {}, home });
  assert.ok(searched.includes(path.join(home, '.var/app/com.valvesoftware.Steam/config/unity3d/Free Lives/Broforce')));
  assert.ok(searched.includes(path.join(home, '.var/app/com.valvesoftware.Steam/.config/unity3d/Free Lives/Broforce')));
});

test('a screenshot from a game under Flatpak Steam is translated to where the sandbox put it, only when it is there', async () => {
  const home = await fakeHome();
  const flatpakHome = path.join(home, '.var/app/com.valvesoftware.Steam');
  await installGame(path.join(flatpakHome, '.local/share/Steam'), { proton: true });

  const client = new UnityInspectorClient({ host: '127.0.0.1', port: 1 });
  client.platform = 'linux';
  await client.detectGamePaths({ home });

  const shot = 'r2/profiles/Default/Mods/Unity Inspector Mod/Screenshots/x.png';
  const sandboxed = path.join(flatpakHome, shot);
  await fs.mkdir(path.dirname(sandboxed), { recursive: true });
  await fs.writeFile(sandboxed, 'png');
  assert.equal(await client.translateScreenshotPath(path.join(home, shot)), sandboxed, 'a native path the sandbox moved');
  assert.equal(await client.translateScreenshotPath(`Z:${home}/${shot}`), sandboxed, 'a Proton Z: path the sandbox moved');
  assert.equal(await client.translateScreenshotPath(sandboxed), sandboxed, 'already on the host');
  assert.equal(await client.translateScreenshotPath('/srv/shots/x.png'), '/srv/shots/x.png', 'outside the home');

  const granted = 'granted/profiles/Default/Mods/Unity Inspector Mod/Screenshots/y.png';
  await fs.mkdir(path.dirname(path.join(home, granted)), { recursive: true });
  await fs.writeFile(path.join(home, granted), 'png');
  assert.equal(await client.translateScreenshotPath(path.join(home, granted)), path.join(home, granted),
    'a folder granted to the sandbox keeps its host path');
  assert.equal(await client.translateScreenshotPath(path.join(home, 'nowhere/z.png')), path.join(home, 'nowhere/z.png'),
    'a path found in neither place is left as given');

  client.pointAt({ port: 1, gameConfig: { isAgentInstance: true } });
  assert.equal(await client.translateScreenshotPath(path.join(home, shot)), path.join(home, shot), 'an instance is never under Flatpak Steam');

  const native = new UnityInspectorClient({ host: '127.0.0.1', port: 1 });
  native.platform = 'linux';
  const plain = await fakeHome();
  await installGame(path.join(plain, '.local/share/Steam'));
  await native.detectGamePaths({ home: plain });
  assert.equal(await native.translateScreenshotPath(path.join(plain, shot)), path.join(plain, shot), 'a game outside Flatpak keeps its path');
});

test('no Steam install finds no game', async () => {
  assert.deepEqual(await findSteamGame({ home: await fakeHome() }), { gamePath: null, protonPrefix: null, steamapps: null });
});

test('the newest token file wins', async () => {
  const home = await fakeHome();
  const xdg = path.join(home, 'xdg');
  const search = await steamTokenSearch(7777, { env: { XDG_CONFIG_HOME: xdg }, home });
  const [older, newer] = [search.files[0], search.files[1]];
  for (const file of [older, newer]) await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(older, 'old-token');
  await fs.writeFile(newer, 'new-token\n');
  const past = new Date(Date.now() - 60000);
  await fs.utimes(older, past, past);

  assert.deepEqual(await readTokenFile(search), {
    path: newer, token: 'new-token', searched: search.searched, override: false,
  });

  const none = await readTokenFile(await steamTokenSearch(1, { env: {}, home: await fakeHome() }));
  assert.equal(none.path, null);
  assert.equal(none.token, null);
});

test('UNITY_INSPECTOR_TOKEN_FILE is the file, with no search', async () => {
  const home = await fakeHome();
  const elsewhere = await steamTokenSearch(5555, { env: {}, home });
  await fs.mkdir(path.dirname(elsewhere.files[0]), { recursive: true });
  await fs.writeFile(elsewhere.files[0], 'found-by-search');

  const named = path.join(scratch, 'named.token');
  await fs.writeFile(named, 'named-token');
  const search = await steamTokenSearch(5555, { env: { UNITY_INSPECTOR_TOKEN_FILE: named }, home });
  assert.deepEqual(search, { files: [named], searched: [named], override: true });
  assert.equal((await readTokenFile(search)).token, 'named-token');

  const missing = path.join(scratch, 'missing.token');
  const absent = await readTokenFile(await steamTokenSearch(5555, { env: { UNITY_INSPECTOR_TOKEN_FILE: missing }, home }));
  assert.equal(absent.path, null, 'a missing override falls back to nothing, never to the search');
});

test('the test session reaches neither the real config home nor the real Windows users', async () => {
  assert.equal(process.env.XDG_CONFIG_HOME, undefined);
  const { windows } = await unityDataDirs({ env: {}, home: await fakeHome(), wsl: true });
  assert.ok(!windows.some((dir) => dir.startsWith('/mnt/c/Users')), windows.join('\n'));
});

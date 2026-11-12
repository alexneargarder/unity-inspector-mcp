import { NO_LISTENER_PORT } from './support/session.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { reply, startStubServer } from './support/stub-server.js';

const CLIENT = fileURLToPath(new URL('../run-script.js', import.meta.url));
const OLD_TOKEN = 'a'.repeat(64);
const NEW_TOKEN = 'b'.repeat(64);
const SOURCE = 'public static class Probe { public static void Main() {} }';
const BOUND_MS = 30000;
const USAGE = /^Usage: node run-script\.js --port <port> --token-file <file>/m;

const children = new Set();
const cleanups = [];

afterEach(async () => {
  for (const child of children) child.kill('SIGKILL');
  children.clear();
  while (cleanups.length > 0) await cleanups.pop()();
});

function scratch() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'run-script-test-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'Probe.cs');
  writeFileSync(script, SOURCE);
  return { script, tokenFile: path.join(dir, 'token') };
}

async function stub(handler, options) {
  const server = await startStubServer(handler, options);
  cleanups.push(() => server.close());
  return server;
}

const answering = (result) => (request, socket) => reply(socket, request.id, result);
const scriptLines = (server) => server.lines.filter((line) => line.method === 'execute_script');

function within(promise, what) {
  let timer;
  const bound = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`gave up after ${BOUND_MS}ms waiting for ${what}`)), BOUND_MS);
  });
  return Promise.race([promise, bound]).finally(() => clearTimeout(timer));
}

function runClient(args, client = CLIENT) {
  const child = spawn(process.execPath, [client, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  const out = { stdout: '', stderr: '' };
  const watchers = new Set();
  child.stdout.setEncoding('utf8').on('data', (text) => { out.stdout += text; });
  child.stderr.setEncoding('utf8').on('data', (text) => {
    out.stderr += text;
    for (const watch of [...watchers]) watch();
  });
  const exited = new Promise((resolve) => {
    child.once('close', (code, signal) => {
      children.delete(child);
      for (const watch of [...watchers]) watch();
      resolve({ code, signal, ...out });
    });
  });

  return {
    exit: () => within(exited, 'the client to exit'),
    stderrMatching: (pattern) => within(new Promise((resolve, reject) => {
      const watch = () => {
        if (pattern.test(out.stderr)) {
          watchers.delete(watch);
          resolve();
        } else if (!children.has(child)) {
          watchers.delete(watch);
          reject(new Error(`the client exited before its stderr matched ${pattern}:\n${out.stderr}`));
        }
      };
      watchers.add(watch);
      watch();
    }), `stderr matching ${pattern}`),
  };
}

async function unusedPort() {
  const [low] = readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/).map(Number);
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = 1024 + Math.floor(Math.random() * (low - 1024));
    const free = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error(`no port below ${low} was free`);
}

test('one attempt sends the script with its source, name and args, and prints the reply alone', async () => {
  const { script, tokenFile } = scratch();
  writeFileSync(tokenFile, OLD_TOKEN);
  const result = { success: true, scriptName: 'Probe', loaded: true };
  const server = await stub(answering(result));

  const run = await runClient([
    '--port', String(server.port), '--token-file', tokenFile, '--arg', 'mode=fast', '--arg', 'expr=a=b', script,
  ]).exit();

  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout, `${JSON.stringify(result)}\n`);
  assert.match(run.stderr, /^Connected \d+ ms after the client started; the reply arrived at \d+ ms$/m);
  assert.deepEqual(server.hellos.map((hello) => hello.token), [OLD_TOKEN]);
  assert.deepEqual(server.lines.map((line) => [line.method, line.params]), [[
    'execute_script',
    { source: SOURCE, name: 'Probe', args: { mode: 'fast', expr: 'a=b' }, origin: realpathSync(script) },
  ]]);
});

test('run through a path with a symlinked directory in it, the client still sends the script', async () => {
  const { script, tokenFile } = scratch();
  writeFileSync(tokenFile, OLD_TOKEN);
  const server = await stub(answering({ success: true }));
  const linkDir = mkdtempSync(path.join(os.tmpdir(), 'run-script-link-'));
  cleanups.push(() => rmSync(linkDir, { recursive: true, force: true }));
  const repoLink = path.join(linkDir, 'repo');
  symlinkSync(path.dirname(CLIENT), repoLink, 'dir');
  cleanups.push(() => unlinkSync(repoLink));

  const run = await runClient(['--port', String(server.port), '--token-file', tokenFile, script], path.join(repoLink, 'run-script.js')).exit();

  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout, `${JSON.stringify({ success: true })}\n`);
  assert.equal(scriptLines(server).length, 1);
});

test('a failure reply, in the result or the mod\'s own, is printed and exits 1', async () => {
  const { script, tokenFile } = scratch();
  writeFileSync(tokenFile, OLD_TOKEN);
  const failed = { success: false, error: 'Compilation failed', compilerErrors: ['(1,1): error CS1525'] };
  const inResult = await stub(answering(failed));
  const refused = await stub((request, socket) => {
    socket.write(`${JSON.stringify({ id: request.id, success: false, error: 'Script source is required' })}\n`);
  });

  const compile = await runClient(['--port', String(inResult.port), '--token-file', tokenFile, script]).exit();
  assert.equal(compile.code, 1, compile.stderr);
  assert.equal(compile.stdout, `${JSON.stringify(failed)}\n`);

  const mod = await runClient(['--port', String(refused.port), '--token-file', tokenFile, script]).exit();
  assert.equal(mod.code, 1, mod.stderr);
  assert.equal(mod.stdout, `${JSON.stringify({ success: false, error: 'Script source is required' })}\n`);
  assert.equal(scriptLines(refused).length, 1);
});

test('--wait with nothing listening connects once the game listens, and sends the script once', async () => {
  const { script, tokenFile } = scratch();
  writeFileSync(tokenFile, OLD_TOKEN);
  const port = await unusedPort();

  const client = runClient(['--port', String(port), '--token-file', tokenFile, '--wait', '60', script]);
  await client.stderrMatching(/^Not ready yet: Nothing is listening on 127\.0\.0\.1:\d+/m);
  const server = await stub(answering({ success: true }), { port });
  const run = await client.exit();

  assert.equal(run.code, 0, run.stderr);
  assert.equal(scriptLines(server).length, 1);
});

test('--wait with the token refused connects once the right token is written', async () => {
  const { script, tokenFile } = scratch();
  writeFileSync(tokenFile, OLD_TOKEN);
  const server = await stub(answering({ success: true }), {
    hello: (params) => (params.token === NEW_TOKEN ? 'accept' : 'refuse'),
  });

  const client = runClient(['--port', String(server.port), '--token-file', tokenFile, '--wait', '60', script]);
  await client.stderrMatching(/^Not ready yet: The Unity Inspector Mod refused the token in /m);
  writeFileSync(tokenFile, NEW_TOKEN);
  const run = await client.exit();

  assert.equal(run.code, 0, run.stderr);
  assert.equal(server.hellos[0].token, OLD_TOKEN);
  assert.equal(server.hellos.at(-1).token, NEW_TOKEN);
  assert.equal(scriptLines(server).length, 1);
});

test('--new-token sends the old game nothing, and the script reaches the new game once its token is written', async () => {
  const { script, tokenFile } = scratch();
  writeFileSync(tokenFile, OLD_TOKEN);
  let gameToken = OLD_TOKEN;
  const server = await stub(answering({ success: true }), {
    hello: (params) => (params.token === gameToken ? 'accept' : 'refuse'),
  });

  const client = runClient([
    '--port', String(server.port), '--token-file', tokenFile, '--wait', '60', '--new-token', script,
  ]);
  await client.stderrMatching(/^Not ready yet: .*still holds the token it held when this client started/m);
  assert.equal(server.connectionCount, 0, 'the old game was sent something');

  gameToken = NEW_TOKEN;
  writeFileSync(tokenFile, NEW_TOKEN);
  const run = await client.exit();

  assert.equal(run.code, 0, run.stderr);
  assert.ok(server.hellos.length > 0 && server.hellos.every((hello) => hello.token === NEW_TOKEN));
  assert.equal(scriptLines(server).length, 1);
});

test('--new-token takes a token file rewritten with the same token for the old game', async () => {
  const { script, tokenFile } = scratch();
  writeFileSync(tokenFile, OLD_TOKEN);
  let gameToken = OLD_TOKEN;
  const server = await stub(answering({ success: true }), {
    hello: (params) => (params.token === gameToken ? 'accept' : 'refuse'),
  });

  const client = runClient([
    '--port', String(server.port), '--token-file', tokenFile, '--wait', '60', '--new-token', script,
  ]);
  await client.stderrMatching(/^Not ready yet: .*still holds the token it held when this client started/m);
  writeFileSync(tokenFile, `${OLD_TOKEN}\n`);
  // Several of the client's 100ms checks pass over the rewritten file
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(server.connectionCount, 0, 'a rewrite of the old token was taken for a new game');

  gameToken = NEW_TOKEN;
  writeFileSync(tokenFile, NEW_TOKEN);
  const run = await client.exit();
  assert.equal(run.code, 0, run.stderr);
  assert.ok(server.hellos.every((hello) => hello.token === NEW_TOKEN));
});

test('--new-token takes a different token as new however old the file\'s time, and any token when there was none', async () => {
  const { script, tokenFile } = scratch();
  writeFileSync(tokenFile, OLD_TOKEN);
  const server = await stub(answering({ success: true }), {
    hello: (params) => (params.token === NEW_TOKEN ? 'accept' : 'refuse'),
  });

  const client = runClient([
    '--port', String(server.port), '--token-file', tokenFile, '--wait', '10', '--new-token', script,
  ]);
  await client.stderrMatching(/^Not ready yet: .*still holds the token it held when this client started/m);
  // A copy that keeps the other machine's file time lands already dated an hour before this client
  const copied = `${tokenFile}.copy`;
  writeFileSync(copied, NEW_TOKEN);
  const anHourAgo = new Date(Date.now() - 3600 * 1000);
  utimesSync(copied, anHourAgo, anHourAgo);
  renameSync(copied, tokenFile);
  const run = await client.exit();
  assert.equal(run.code, 0, run.stderr);
  assert.equal(scriptLines(server).length, 1);

  const fresh = scratch();
  const missing = runClient([
    '--port', String(server.port), '--token-file', fresh.tokenFile, '--wait', '10', '--new-token', fresh.script,
  ]);
  await missing.stderrMatching(/^Not ready yet: .*holds no token yet, and --new-token waits for a new one/m);
  writeFileSync(fresh.tokenFile, NEW_TOKEN);
  const first = await missing.exit();
  assert.equal(first.code, 0, first.stderr);
  assert.equal(scriptLines(server).length, 2);
});

test('a wait that runs out exits 3 naming the last cause, and so does one attempt with nothing listening', async () => {
  const { script, tokenFile } = scratch();
  writeFileSync(tokenFile, OLD_TOKEN);
  const refusal = /^Nothing is listening on 127\.0\.0\.1:1, so the ssh tunnel to the remote game is not running/m;

  const waited = await runClient(['--port', NO_LISTENER_PORT, '--token-file', tokenFile, '--wait', '0.3', script]).exit();
  assert.equal(waited.code, 3, waited.stderr);
  assert.match(waited.stderr, /^Not ready yet: Nothing is listening/m);
  assert.match(waited.stderr, refusal);
  assert.equal(waited.stdout, '');

  const once = await runClient(['--port', NO_LISTENER_PORT, '--token-file', tokenFile, script]).exit();
  assert.equal(once.code, 3, once.stderr);
  assert.match(once.stderr, refusal);
  assert.doesNotMatch(once.stderr, /Not ready yet/);
  assert.equal(once.stdout, '');
});

test('a protocol mismatch, or an answer that is not the mod\'s, ends the wait at once', async () => {
  const { script, tokenFile } = scratch();
  writeFileSync(tokenFile, OLD_TOKEN);
  const newer = await stub(answering({ success: true }), { hello: { protocol: 2 } });

  const mismatch = await runClient(['--port', String(newer.port), '--token-file', tokenFile, '--wait', '60', script]).exit();
  assert.equal(mismatch.code, 3, mismatch.stderr);
  assert.match(mismatch.stderr, /speaks handshake protocol 2/);
  assert.equal(newer.connectionCount, 1);

  let connections = 0;
  const other = net.createServer((socket) => {
    connections++;
    socket.on('error', () => {});
    socket.once('data', () => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
  });
  await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => other.close(resolve)));

  const foreign = await runClient([
    '--port', String(other.address().port), '--token-file', tokenFile, '--wait', '60', script,
  ]).exit();
  assert.equal(foreign.code, 3, foreign.stderr);
  assert.match(foreign.stderr, /answered the connection handshake with something other than the Unity Inspector Mod's reply/);
  assert.equal(connections, 1);
});

test('usage errors exit 2 with the usage line and connect to nothing', async () => {
  const { script, tokenFile } = scratch();
  const cases = [
    [['--port', NO_LISTENER_PORT, '--token-file', tokenFile], /No script given/],
    [['--token-file', tokenFile, script], /--port is required/],
    [['--port', NO_LISTENER_PORT, script], /--token-file is required/],
    [['--port', NO_LISTENER_PORT, '--token-file', tokenFile, '--new-token', script], /--new-token needs --wait/],
    [['--port', NO_LISTENER_PORT, '--token-file', tokenFile, '--arg', 'novalue', script], /--arg takes <key>=<value>/],
  ];
  for (const [args, message] of cases) {
    const run = await runClient(args).exit();
    assert.equal(run.code, 2, `${args.join(' ')}: ${run.stderr}`);
    assert.match(run.stderr, message);
    assert.match(run.stderr, USAGE);
    assert.equal(run.stdout, '');
  }
});

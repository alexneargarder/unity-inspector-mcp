#!/usr/bin/env node
import path from 'path';
import { parseArgs } from 'util';

import { readScriptSource } from './lib/script-library.js';
import {
  COMMAND_FAILED,
  DEFAULT_CONNECT_TIMEOUT_MS,
  HANDSHAKE_UNREADABLE,
  UnityInspectorClient,
  isHandshakeRefusal,
  readTokenFile,
  remoteTokenSearch,
  toolCommand,
} from './lib/unity-client.js';

const RETRY_MS = 100;
const USAGE = 'Usage: node run-script.js --port <port> --token-file <file> [--host <host>] [--wait <seconds>] ' +
  '[--new-token] [--arg <key>=<value>]... <script>';
const EXIT_RAN = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const EXIT_UNREACHED = 3;

const log = (line) => process.stderr.write(`${line}\n`);
const sinceStart = () => Math.round(performance.now());
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class UsageError extends Error {}

function parseCommandLine(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        port: { type: 'string' },
        'token-file': { type: 'string' },
        host: { type: 'string', default: '127.0.0.1' },
        wait: { type: 'string' },
        'new-token': { type: 'boolean', default: false },
        arg: { type: 'string', multiple: true, default: [] },
      },
      allowPositionals: true,
    });
  } catch (err) {
    throw new UsageError(err.message);
  }
  const { values, positionals } = parsed;

  if (positionals.length !== 1) {
    throw new UsageError(positionals.length === 0 ? 'No script given' : `One script only, got ${positionals.join(', ')}`);
  }
  if (values.port === undefined) throw new UsageError('--port is required');
  const port = Number(values.port);
  if (!/^\d+$/.test(values.port) || port < 1 || port > 65535) {
    throw new UsageError(`--port takes an integer from 1 to 65535, got ${values.port}`);
  }
  if (!values['token-file']) throw new UsageError('--token-file is required');
  if (!values.host) throw new UsageError('--host must not be empty');

  let waitMs = null;
  if (values.wait !== undefined) {
    const seconds = Number(values.wait);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new UsageError(`--wait takes a positive number of seconds, got ${values.wait}`);
    }
    waitMs = seconds * 1000;
  }
  if (values['new-token'] && waitMs === null) {
    throw new UsageError('--new-token needs --wait: a new token can only arrive while the client waits for it');
  }

  const args = new Map();
  for (const pair of values.arg) {
    const at = pair.indexOf('=');
    if (at <= 0) throw new UsageError(`--arg takes <key>=<value>, got ${pair}`);
    const key = pair.slice(0, at);
    if (args.has(key)) throw new UsageError(`--arg ${key} is given twice`);
    args.set(key, pair.slice(at + 1));
  }

  return {
    script: positionals[0],
    port,
    host: values.host,
    tokenFile: path.resolve(values['token-file']),
    waitMs,
    newToken: values['new-token'],
    args: Object.fromEntries(args),
  };
}

const tokenIn = async (file) => (await readTokenFile(remoteTokenSearch(file))).token;

async function stillOldToken(file, startToken) {
  const token = await tokenIn(file);
  if (token === null) return new Error(`${file} holds no token yet, and --new-token waits for a new one`);
  if (token === startToken) {
    return new Error(`${file} still holds the token it held when this client started, and --new-token waits for a new one`);
  }
  return null;
}

function notReadyYet(err) {
  if (isHandshakeRefusal(err)) return err.refusal === 'token';
  return err.code !== HANDSHAKE_UNREADABLE && err.code !== 'ENOTFOUND';
}

async function connectWhenReady(client, { tokenFile, waitMs, newToken }, startToken) {
  if (waitMs === null) return client.connect();

  let last = null;
  for (;;) {
    const left = waitMs - performance.now();
    if (last && left <= 0) throw last;

    let cause = newToken ? await stillOldToken(tokenFile, startToken) : null;
    if (cause === null) {
      client.connectTimeoutMs = Math.min(DEFAULT_CONNECT_TIMEOUT_MS, Math.max(left, RETRY_MS));
      try {
        await client.connect();
        return;
      } catch (err) {
        if (!notReadyYet(err)) throw err;
        cause = err;
      }
    }
    if (cause.message !== last?.message) log(`Not ready yet: ${cause.message}`);
    last = cause;
    await sleep(Math.max(0, Math.min(RETRY_MS, waitMs - performance.now())));
  }
}

async function main(argv) {
  let options;
  let script;
  try {
    options = parseCommandLine(argv);
    script = await readScriptSource(options.script);
  } catch (err) {
    log(err.message);
    log(USAGE);
    return EXIT_USAGE;
  }

  console.error = () => {};
  const startToken = options.newToken ? await tokenIn(options.tokenFile) : null;

  const client = new UnityInspectorClient({ port: options.port });
  client.pointAt({
    port: options.port,
    gameConfig: { remote: { host: options.host, port: options.port, tokenFile: options.tokenFile } },
    tokenSearch: () => remoteTokenSearch(options.tokenFile),
  });

  try {
    await connectWhenReady(client, options, startToken);
  } catch (err) {
    log(err.message);
    return EXIT_UNREACHED;
  }
  const connectedAt = sinceStart();

  const command = toolCommand('execute_script', {
    source: script.source,
    name: script.name,
    args: options.args,
    origin: script.origin,
  });
  const timing = () => `Connected ${connectedAt} ms after the client started; the reply arrived at ${sinceStart()} ms`;
  try {
    const result = await client.sendCommand(command.method, command.params);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    log(timing());
    return result?.success === true ? EXIT_RAN : EXIT_FAILED;
  } catch (err) {
    if (err.code !== COMMAND_FAILED) {
      log(`Connected ${connectedAt} ms after the client started; no reply came: ${err.message}`);
      return EXIT_FAILED;
    }
    process.stdout.write(`${JSON.stringify({ success: false, error: err.message })}\n`);
    log(timing());
    return EXIT_FAILED;
  } finally {
    client.disconnect('run-script.js is done');
  }
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (err) => {
    log(`run-script.js failed: ${err.stack ?? err.message}`);
    process.exitCode = EXIT_FAILED;
  },
);

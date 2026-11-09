import fs from 'fs/promises';
import path from 'path';

import { SESSION_ID_RE, serverStateDir, sessionFolder } from './instance.js';

export const LAUNCH_RECORDS_DIR_ENV = 'UNITY_INSPECTOR_LAUNCHES_DIR';
export const LAUNCH_RECORD_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
const TARGETS = ['steam', 'instance'];

export function launchRecordsRoot(env = process.env, home) {
  if (env[LAUNCH_RECORDS_DIR_ENV]) return env[LAUNCH_RECORDS_DIR_ENV];
  return path.join(serverStateDir(env, home), 'launches');
}

export function launchRecordFile(env = process.env, home) {
  return path.join(launchRecordsRoot(env, home), `${sessionFolder(env)}.json`);
}

let cache = null;

export function forgetLaunchRecords() {
  cache = null;
}

function parseRecords(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  const records = {};
  for (const target of TARGETS) {
    const record = parsed?.[target];
    if (record === null || typeof record !== 'object') continue;
    records[target] = {
      launchArgs: typeof record.launchArgs === 'string' ? record.launchArgs : null,
      vanilla: record.vanilla === true,
    };
  }
  return records;
}

async function records() {
  const file = launchRecordFile();
  if (cache?.file !== file) {
    const text = await fs.readFile(file, 'utf8').catch(() => null);
    cache = { file, records: text === null ? {} : parseRecords(text) };
  }
  return cache;
}

export async function lastLaunch(target) {
  return (await records()).records[target] ?? null;
}

export async function pruneLaunchRecords(root, keep, { idleMs = LAUNCH_RECORD_IDLE_MS, nowMs = Date.now() } = {}) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    if (!entry.isFile() || file === keep || !entry.name.endsWith('.json') || !SESSION_ID_RE.test(entry.name.slice(0, -5))) continue;
    try {
      if (nowMs - (await fs.lstat(file)).mtimeMs >= idleMs) await fs.rm(file, { force: true });
    } catch {}
  }
}

async function writeAtomically(file, text) {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(temp, text, 'utf8');
    await fs.rename(temp, file);
  } catch (err) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw err;
  }
}

let writeRecordFile = writeAtomically;

export function setLaunchRecordWriter(writer = writeAtomically) {
  writeRecordFile = writer;
}

let writing = Promise.resolve();

async function writeRecords(file) {
  if (cache?.file !== file) return;
  try {
    await writeRecordFile(file, JSON.stringify(cache.records) + '\n');
  } catch (err) {
    console.error(`Could not record the launch in ${file}: ${err.message}`);
    return;
  }
  await pruneLaunchRecords(path.dirname(file), file);
}

export function recordLaunch(target, { launchArgs, vanilla }) {
  const file = launchRecordFile();
  const record = { launchArgs, vanilla };
  if (cache?.file === file) {
    cache.records = { ...cache.records, [target]: record };
    writing = writing.then(() => writeRecords(file));
  } else {
    writing = writing.then(async () => {
      const current = await records();
      current.records = { ...current.records, [target]: record };
      await writeRecords(file);
    });
  }
  return writing;
}

export function launchRecordsWritten() {
  return writing;
}

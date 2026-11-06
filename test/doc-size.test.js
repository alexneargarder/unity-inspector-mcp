import './support/session.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MAX_DOC_CHARS = 40000;
const repo = fileURLToPath(new URL('..', import.meta.url));
const read = (file) => readFileSync(repo + file, 'utf8');
const rules = readdirSync(repo + '.claude/rules').filter((f) => f.endsWith('.md')).map((f) => `.claude/rules/${f}`);

test('CLAUDE.md and every rules file stay within what Claude Code reads on demand', () => {
  for (const file of ['CLAUDE.md', ...rules]) {
    const chars = [...read(file)].length;
    assert.ok(chars < MAX_DOC_CHARS, `${file} is ${chars} characters, limit ${MAX_DOC_CHARS}`);
  }
});

test('every rules file opens with paths: frontmatter', () => {
  for (const file of rules) {
    assert.match(read(file), /^---\npaths:\n/, `${file} does not open with paths: frontmatter`);
  }
});

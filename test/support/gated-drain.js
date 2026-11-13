import fs from 'fs';

const [releaseFile, mark] = process.argv.slice(2);
const markBytes = Buffer.from(mark);
let held = Buffer.alloc(0);
let markEnd = -1;
let released = false;

const write = (bytes) => {
  for (let part = bytes; part.length > 0;) part = part.subarray(fs.writeSync(1, part));
};

process.stdin.on('data', (chunk) => {
  if (released) return write(chunk);
  held = Buffer.concat([held, chunk]);
  if (markEnd === -1) {
    const at = held.indexOf(markBytes);
    const lineEnd = at === -1 ? -1 : held.indexOf('\n', at + markBytes.length);
    if (lineEnd === -1) return;
    markEnd = lineEnd + 1;
    fs.writeFileSync(releaseFile, '');
  }
  if (held.length > markEnd) {
    released = true;
    write(held);
  }
});
process.stdin.on('end', () => {
  if (!released) write(held);
  process.exit(0);
});
process.stdin.on('error', () => process.exit(0));

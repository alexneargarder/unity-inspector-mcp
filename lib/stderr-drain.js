import fs from 'fs';

const limit = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 0;

let kept = 0;
let writable = true;

process.stdin.on('data', (chunk) => {
  if (!writable) return;
  let part = chunk.subarray(0, limit - kept);
  try {
    while (part.length > 0) {
      const written = fs.writeSync(1, part);
      kept += written;
      part = part.subarray(written);
    }
  } catch {
    writable = false;
  }
  if (kept >= limit) writable = false;
});
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));

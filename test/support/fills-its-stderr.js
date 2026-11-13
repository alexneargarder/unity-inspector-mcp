import fs from 'fs';

const [full, marked] = process.argv.slice(2);
const { O_WRONLY, O_NONBLOCK } = fs.constants;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Opened again so its status flags are its own: the end the launch command shares must stay blocking
const pipe = fs.openSync('/proc/self/fd/2', O_WRONLY | O_NONBLOCK);
// A 4 KiB pipe page holds 40 of these with 96 bytes over: room for a short refusal, then none for the 81-byte marker
const chunk = Buffer.alloc(100, '\n');
for (;;) {
  try {
    fs.writeSync(pipe, chunk);
  } catch (err) {
    if (err.code === 'EAGAIN') break;
    throw err;
  }
}
fs.closeSync(pipe);
fs.writeFileSync(full, '');

for (let i = 0; i < 3000 && !fs.existsSync(marked); i++) sleep(10);
fs.writeSync(2, 'child: written once the drain read again\n');

import net from 'net';

import { HANDSHAKE_PROTOCOL } from '../../lib/unity-client.js';

export function answerHello(request, socket, mode) {
  const chosen = typeof mode === 'function' ? mode(request.params ?? {}) : mode;
  const send = (payload) => socket.write(JSON.stringify({ id: request.id, ...payload }) + '\n');
  const sendAndClose = (payload) => socket.end(JSON.stringify({ id: request.id, ...payload }) + '\n');

  if (request.method !== 'hello') {
    sendAndClose({ success: false, error: 'The first message on a connection must be hello' });
    return false;
  }
  if (chosen === 'accept' || chosen === undefined) {
    send({ success: true, result: { protocol: HANDSHAKE_PROTOCOL } });
    return true;
  }
  if (chosen === 'silent') return false;
  if (chosen === 'close') {
    socket.destroy();
    return false;
  }
  if (chosen === 'old-mod') {
    send({ success: false, error: 'Unknown method: hello' });
    return false;
  }
  if (chosen === 'refuse') {
    sendAndClose({ success: false, error: 'Invalid token' });
    return false;
  }
  if (chosen?.acceptAs !== undefined) {
    send({ success: true, result: { protocol: chosen.acceptAs } });
    return true;
  }
  if (chosen?.protocol !== undefined) {
    sendAndClose({ success: false, error: 'Unsupported handshake protocol', protocol: chosen.protocol });
    return false;
  }
  throw new Error(`unknown hello mode ${JSON.stringify(chosen)}`);
}

export function serveConnection(socket, state, onLine) {
  let buffer = '';
  let greeted = null;
  const waiting = [];
  let busy = false;

  const next = () => {
    if (busy || waiting.length === 0 || socket.destroyed) return;
    busy = true;
    onLine(waiting.shift(), served);
  };
  const answered = () => {
    if (!busy) return;
    busy = false;
    setImmediate(next);
  };
  const served = new Proxy(socket, {
    get(target, prop) {
      if (prop === 'write' || prop === 'end') {
        return (...args) => {
          const written = target[prop](...args);
          answered();
          return written;
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  socket.setEncoding('utf8');
  socket.on('data', (text) => {
    buffer += text;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const request = JSON.parse(line);
      if (greeted === null) {
        state.firstLines.push(request);
        if (request.method === 'hello') state.hellos.push(request.params);
        greeted = answerHello(request, socket, state.hello);
        continue;
      }
      if (greeted) {
        (state.lines ??= []).push(request);
        waiting.push(request);
        next();
      }
    }
  });
}

export function startStubServer(onRequest, { hello = 'accept', host = '127.0.0.1' } = {}) {
  return new Promise((resolve) => {
    const sockets = new Set();
    const state = { connectionCount: 0, hello, hellos: [], firstLines: [], lines: [] };

    const server = net.createServer((socket) => {
      sockets.add(socket);
      state.connectionCount++;
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
      serveConnection(socket, state, onRequest);
    });

    server.listen(0, host, () => {
      resolve({
        port: server.address().port,
        get connectionCount() { return state.connectionCount; },
        get hello() { return state.hello; },
        set hello(mode) { state.hello = mode; },
        hellos: state.hellos,
        firstLines: state.firstLines,
        lines: state.lines,
        close: () => new Promise((done) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => done());
        }),
      });
    });
  });
}

export function reply(socket, id, result) {
  socket.write(JSON.stringify({ id, success: true, result }) + '\n');
}

import net from 'net';

export function startStubServer(onRequest) {
  return new Promise((resolve) => {
    const sockets = new Set();
    const state = { connectionCount: 0 };

    const server = net.createServer((socket) => {
      sockets.add(socket);
      state.connectionCount++;
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));

      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        let index;
        while ((index = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!line) continue;
          onRequest(JSON.parse(line), socket);
        }
      });
    });

    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        get connectionCount() { return state.connectionCount; },
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

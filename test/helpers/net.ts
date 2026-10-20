import { once } from 'node:events';
import { createConnection, createServer } from 'node:net';

/** A port on 127.0.0.1 that was free a moment ago. */
export async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** True when something accepts TCP connections on 127.0.0.1:port. */
export async function listening(port: number): Promise<boolean> {
  const socket = createConnection({ port, host: '127.0.0.1' });
  try {
    await once(socket, 'connect');
    return true;
  } catch {
    return false;
  } finally {
    socket.destroy();
  }
}

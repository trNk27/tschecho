// Ember server: serves the built web pages, /healthz, and the /ws room relay.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { MAX_PAYLOAD_BYTES } from '../shared/constants';
import { RoomManager, type Client } from './rooms';

const PORT = Number(process.env.PORT) || 8080;
const CLIENT_DIR = path.resolve(process.env.CLIENT_DIR ?? path.join(process.cwd(), 'dist/client'));
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const PING_INTERVAL_MS = 20_000;

const log = (msg: string) => console.log(`[ember] ${msg}`);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
    "connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};

function isLocalHost(host: string | undefined): boolean {
  return !host || /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) || /^192\.168\.|^10\./.test(host);
}

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x');
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }

  if (pathname === '/' || pathname === '/index.html') pathname = '/host/index.html';
  else if (pathname === '/play' || pathname === '/play/') pathname = '/controller/index.html';

  const file = path.join(CLIENT_DIR, path.normalize(pathname));
  if (!file.startsWith(CLIENT_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }

  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    const ext = path.extname(file);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': pathname.startsWith('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

const server = createServer((req, res) => {
  try {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
      return;
    }
    // Render terminates TLS and tells us the original scheme. Force HTTPS.
    if (req.headers['x-forwarded-proto'] === 'http' && !isLocalHost(req.headers.host)) {
      res.writeHead(301, { Location: `https://${req.headers.host}${req.url ?? '/'}` }).end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    serveStatic(req, res).catch((err) => {
      log(`static error: ${String(err)}`);
      if (!res.headersSent) res.writeHead(500).end();
    });
  } catch (err) {
    log(`http error: ${String(err)}`);
    if (!res.headersSent) res.writeHead(500).end();
  }
});

function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

const rooms = new RoomManager(log);
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES, perMessageDeflate: false });
const clients = new Set<Client>();

server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => socket.destroy());
  const pathname = new URL(req.url ?? '/', 'http://x').pathname;
  if (pathname !== '/ws' || !originAllowed(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const client = rooms.newClient(ws);
    clients.add(client);

    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('message', (data, isBinary) => {
      client.alive = true;
      try {
        if (isBinary) {
          ws.close(1003, 'text only');
          return;
        }
        rooms.handleRaw(client, data.toString());
      } catch (err) {
        log(`message handler error: ${String(err)}`);
      }
    });
    ws.on('close', () => {
      clients.delete(client);
      try {
        rooms.handleClose(client);
      } catch (err) {
        log(`close handler error: ${String(err)}`);
      }
    });
    ws.on('error', (err) => log(`socket error: ${err.message}`));
  });
});

const pingTimer = setInterval(() => {
  for (const client of clients) {
    if (!client.alive) {
      client.ws.terminate();
      continue;
    }
    client.alive = false;
    try {
      client.ws.ping();
    } catch {
      client.ws.terminate();
    }
  }
}, PING_INTERVAL_MS);

process.on('uncaughtException', (err) => log(`uncaught: ${err.stack ?? String(err)}`));
process.on('unhandledRejection', (err) => log(`unhandled rejection: ${String(err)}`));

function shutdown() {
  log('shutting down');
  clearInterval(pingTimer);
  rooms.closeAll();
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, () => log(`listening on :${PORT}, serving ${CLIENT_DIR}`));

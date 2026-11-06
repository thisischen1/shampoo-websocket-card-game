import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createStaticHandler } from './static.js';
import { attachSockets } from './socket.js';
import { INSTANCE_ID, warnIfNotAlone } from './instance.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const PUBLIC = join(ROOT, 'public');
const SHARED = join(ROOT, 'src', 'shared');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// `/shared/` exposes the isomorphic rule modules so the browser imports the
// exact same files the server does — no build step, no duplicated logic.
const serveStatic = createStaticHandler([
  { prefix: '/shared/', root: SHARED },
  { prefix: '/', root: PUBLIC },
]);

export function createApp(options = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://localhost');

      if (pathname === '/healthz') {
        // `instance` is here to be compared, not read: curl this twice, and if
        // the id changes you are running more than one instance and room codes
        // are silently split across them.
        //
        // `no-store` is load-bearing. Every platform puts a proxy in front of
        // this, and a cached answer would return one id no matter how many
        // machines are live — turning the one diagnostic that detects the
        // problem into a confident denial that it exists.
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify({ ok: true, instance: INSTANCE_ID }));
        return;
      }

      const handled = await serveStatic(req, res);
      if (!handled) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
      }
    } catch (err) {
      console.error('request error', err);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  });

  const sockets = attachSockets(server, options);
  server.on('close', sockets.close);
  server.sockets = sockets;
  return server;
}

// Only listen when run directly, so tests can import and bind to port 0.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const server = createApp();
  server.listen(PORT, HOST, () => {
    console.log(`Shampoo listening on http://localhost:${PORT} (instance ${INSTANCE_ID})`);
    // Not awaited: a diagnostic lookup must never delay accepting players.
    warnIfNotAlone();
  });
}

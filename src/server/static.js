import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, normalize, extname, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

/**
 * Resolve a URL pathname to a file inside `root`, rejecting traversal.
 * Returns null if the path escapes root.
 */
function resolveSafe(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;

  // Normalize against a virtual root so `..` can never climb above it.
  const rel = normalize(decoded).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  const full = join(root, rel);
  if (full !== root && !full.startsWith(root + sep)) return null;
  return full;
}

/**
 * Serve a file from one of several mount points.
 * mounts: [{ prefix: '/shared/', root: '/abs/path' }, ...] — longest prefix wins.
 * Falls through to `null` return if nothing matched (caller decides on 404).
 */
export function createStaticHandler(mounts) {
  const sorted = [...mounts].sort((a, b) => b.prefix.length - a.prefix.length);

  return async function handle(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
      return true;
    }

    const pathname = new URL(req.url, 'http://localhost').pathname;
    const mount = sorted.find((m) => pathname === m.prefix.replace(/\/$/, '') || pathname.startsWith(m.prefix));
    if (!mount) return false;

    let rel = pathname.slice(mount.prefix.length);
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';

    const file = resolveSafe(mount.root, rel);
    if (!file) {
      send(res, 400, 'Bad Request');
      return true;
    }

    let info;
    try {
      info = await stat(file);
      if (info.isDirectory()) {
        const idx = resolveSafe(mount.root, join(rel, 'index.html'));
        if (!idx) {
          send(res, 400, 'Bad Request');
          return true;
        }
        info = await stat(idx);
        return streamFile(req, res, idx, info);
      }
    } catch {
      return false;
    }

    return streamFile(req, res, file, info);
  };
}

async function streamFile(req, res, file, info) {
  const etag = `W/"${info.size}-${Math.floor(info.mtimeMs)}"`;
  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag });
    res.end();
    return true;
  }

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': info.size,
    ETag: etag,
    // No long-lived caching: we have no build hashes, so a stale asset after a
    // deploy would break the protocol-version check. Revalidate every time.
    'Cache-Control': 'no-cache',
  });

  if (req.method === 'HEAD') {
    res.end();
    return true;
  }

  // `pipe` would leave the read stream's 'error' unhandled, and an unhandled
  // stream error is an uncaught exception — which takes the process down and
  // every in-memory room with it. The headers are already sent by this point,
  // so the caller's try/catch cannot help either. `pipeline` owns both ends:
  // it destroys the stream on a client abort (phones do this constantly) and
  // routes a read failure here instead of at the top level.
  await pipeline(createReadStream(file), res).catch(() => res.destroy());
  return true;
}

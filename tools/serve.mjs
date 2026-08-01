#!/usr/bin/env node
/**
 * Slag — zero-dependency static development server.
 *
 * ES modules cannot be loaded from `file://` because of CORS, so the game needs
 * to be served over HTTP during development. This server exists only for that
 * purpose: it is intentionally tiny, has no npm dependencies and only serves
 * files that live inside the repository root.
 *
 * Usage:
 *   node tools/serve.mjs                 # http://localhost:8080
 *   node tools/serve.mjs --port 3000     # custom port
 *   node tools/serve.mjs --root dist     # serve another directory
 *   node tools/serve.mjs --host 0.0.0.0  # expose on the local network
 *
 * The `PORT` environment variable is honoured as well (the flag wins).
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

const DEFAULT_PORT = 8080;
const DEFAULT_HOST = '127.0.0.1';

/**
 * Extension -> Content-Type. Anything not listed here is served as a binary
 * blob (`application/octet-stream`), which is the safe default.
 */
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/**
 * Parses `--flag value` and `--flag=value` style arguments.
 * @param {string[]} argv
 * @returns {{ port: number, host: string, root: string }}
 */
function parseArgs(argv) {
  const opts = {
    port: Number.parseInt(process.env.PORT ?? '', 10) || DEFAULT_PORT,
    host: DEFAULT_HOST,
    root: REPO_ROOT,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;

    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    // Inline value (`--port=3000`) or the next argv entry (`--port 3000`).
    const inlineValue = eq === -1 ? null : arg.slice(eq + 1);
    const nextValue = () => (inlineValue !== null ? inlineValue : argv[++i]);

    switch (name) {
      case 'port': {
        const parsed = Number.parseInt(nextValue() ?? '', 10);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
          fail(`Érvénytelen port: ${arg}`);
        }
        opts.port = parsed;
        break;
      }
      case 'host':
        opts.host = nextValue() || DEFAULT_HOST;
        break;
      case 'root':
        opts.root = path.resolve(process.cwd(), nextValue() || '.');
        break;
      case 'help':
        printHelp();
        process.exit(0);
        break;
      default:
        fail(`Ismeretlen kapcsoló: ${arg}`);
    }
  }

  return opts;
}

function printHelp() {
  process.stdout.write(
    [
      'Slag statikus fejlesztői szerver',
      '',
      'Használat: node tools/serve.mjs [kapcsolók]',
      '',
      '  --port <szám>   Port (alapértelmezés: 8080, vagy a PORT környezeti változó)',
      '  --host <cím>    Kötési cím (alapértelmezés: 127.0.0.1)',
      '  --root <mappa>  Kiszolgált gyökérmappa (alapértelmezés: a repo gyökere)',
      '  --help          Ez a súgó',
      '',
    ].join('\n'),
  );
}

/**
 * Prints an error in Hungarian and exits with a non-zero status.
 * @param {string} message
 */
function fail(message) {
  process.stderr.write(`Hiba: ${message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Path resolution (with traversal protection)
// ---------------------------------------------------------------------------

/**
 * Maps a request URL to an absolute path inside `root`.
 * Returns `null` when the request tries to escape the served directory.
 *
 * @param {string} requestUrl raw `req.url`
 * @param {string} root absolute directory that may be served
 * @returns {string|null}
 */
function resolveRequestPath(requestUrl, root) {
  // Strip query string / hash, then percent-decode.
  const withoutQuery = requestUrl.split(/[?#]/, 1)[0];

  let decoded;
  try {
    decoded = decodeURIComponent(withoutQuery);
  } catch {
    return null; // Malformed percent-encoding.
  }

  // NUL bytes and backslashes are never legitimate here.
  if (decoded.includes('\0')) return null;
  const normalizedSeparators = decoded.replace(/\\/g, '/');

  // `path.posix.normalize` collapses `.` and `..`; the leading slash keeps the
  // result anchored, so `/../../etc/passwd` normalizes to `/etc/passwd`.
  const normalized = path.posix.normalize(
    normalizedSeparators.startsWith('/') ? normalizedSeparators : `/${normalizedSeparators}`,
  );

  const absolute = path.resolve(root, `.${normalized}`);

  // Final belt-and-braces check: the result must stay inside `root`.
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (absolute !== root && !absolute.startsWith(rootWithSep)) return null;

  return absolute;
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} title Hungarian, user visible
 * @param {string} detail Hungarian, user visible
 */
function sendError(res, status, title, detail) {
  const body = `<!doctype html>
<html lang="hu">
<head><meta charset="utf-8"><title>${status} — ${title}</title>
<style>
  body { background:#0b0d12; color:#e5e7eb; font:16px/1.6 system-ui, sans-serif;
         display:flex; align-items:center; justify-content:center; height:100vh; margin:0 }
  main { text-align:center; max-width:36rem; padding:2rem }
  h1 { font-size:3rem; margin:0 0 .5rem; color:#ef4444 }
  p { margin:.25rem 0; color:#9ca3af }
  code { color:#fde047 }
</style>
</head>
<body><main><h1>${status}</h1><p><strong>${title}</strong></p><p>${detail}</p></main></body>
</html>
`;
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/**
 * Streams a file to the client.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} absolutePath
 * @param {import('node:fs').Stats} stats
 */
function sendFile(req, res, absolutePath, stats) {
  const type = MIME_TYPES[path.extname(absolutePath).toLowerCase()] ?? 'application/octet-stream';

  const headers = {
    'Content-Type': type,
    'Content-Length': stats.size,
    'Last-Modified': stats.mtime.toUTCString(),
    // Development server: never let the browser cache a stale module.
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  };

  if (req.method === 'HEAD') {
    res.writeHead(200, headers);
    res.end();
    return;
  }

  res.writeHead(200, headers);
  const stream = fs.createReadStream(absolutePath);
  stream.on('error', () => {
    // The headers are already sent at this point, so just cut the connection.
    res.destroy();
  });
  stream.pipe(res);
}

/**
 * Handles a single request.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} root
 */
async function handleRequest(req, res, root) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('A szerver csak GET és HEAD kéréseket szolgál ki.\n');
    return;
  }

  const requestUrl = req.url ?? '/';
  const target = resolveRequestPath(requestUrl, root);

  if (target === null) {
    sendError(res, 403, 'Tiltott útvonal', 'A kért fájl a kiszolgált mappán kívülre mutat.');
    return;
  }

  let stats;
  try {
    stats = await fsp.stat(target);
  } catch {
    // A missing favicon would otherwise show up as a console error in Chrome
    // (and fail the smoke test), so answer it with an empty 204 instead.
    if (requestUrl.split(/[?#]/, 1)[0] === '/favicon.ico') {
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    sendError(res, 404, 'Nincs ilyen fájl', `A kért útvonal nem található: <code>${escapeHtml(requestUrl)}</code>`);
    return;
  }

  if (stats.isDirectory()) {
    // Directories are served through their `index.html`.
    const indexPath = path.join(target, 'index.html');
    try {
      const indexStats = await fsp.stat(indexPath);
      if (indexStats.isFile()) {
        sendFile(req, res, indexPath, indexStats);
        return;
      }
    } catch {
      /* falls through to 404 below */
    }
    sendError(res, 404, 'Nincs index.html', 'Ebben a mappában nincs <code>index.html</code>.');
    return;
  }

  sendFile(req, res, target, stats);
}

/**
 * Minimal HTML escaping for echoed request paths.
 * @param {string} value
 * @returns {string}
 */
function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const options = parseArgs(process.argv.slice(2));

if (!fs.existsSync(options.root) || !fs.statSync(options.root).isDirectory()) {
  fail(`A kiszolgálandó mappa nem létezik: ${options.root}`);
}

const server = http.createServer((req, res) => {
  handleRequest(req, res, options.root).catch(() => {
    if (!res.headersSent) {
      sendError(res, 500, 'Szerverhiba', 'Váratlan hiba történt a kérés kiszolgálása közben.');
    } else {
      res.destroy();
    }
  });
});

server.on('error', (err) => {
  if (/** @type {NodeJS.ErrnoException} */ (err).code === 'EADDRINUSE') {
    fail(`A ${options.port} port már foglalt. Próbáld így: node tools/serve.mjs --port ${options.port + 1}`);
  }
  fail(String(err && err.message ? err.message : err));
});

server.listen(options.port, options.host, () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  // `0.0.0.0` / `::` are not clickable in a terminal, so show `localhost`.
  const shownHost = options.host === '0.0.0.0' || options.host === '::' ? 'localhost' : options.host;
  const url = `http://${shownHost}:${port}/`;

  process.stdout.write(
    [
      '',
      '  SLAG — fejlesztői szerver elindult',
      '',
      `  Nyisd meg a böngészőben:  ${url}`,
      `  Kiszolgált mappa:         ${options.root}`,
      '',
      '  Leállítás: Ctrl+C',
      '',
      '',
    ].join('\n'),
  );
});

// Graceful shutdown so the port is released immediately (the smoke test relies
// on this when it kills the child process).
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    // Do not wait forever for keep-alive sockets.
    setTimeout(() => process.exit(0), 500).unref();
  });
}

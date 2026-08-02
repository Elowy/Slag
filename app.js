/**
 * Slag — belépési pont megosztott tárhelyhez (cPanel „Setup Node.js App”).
 *
 * EZ EGYBEN SZOLGÁLJA KI A JÁTÉKOT ÉS A SZOBÁKAT.
 *
 * A cPanel Node-alkalmazását jellemzően a domain gyökerére állítják, és a
 * Passenger onnantól MINDEN kérést ide irányít — a `styles.css`-t és a
 * `src/*.js`-t is. Ha ez a fájl csak a relay lenne, a játék 404-et kapna.
 * Ezért itt előbb a relay kap esélyt (`/api/...`), és minden más kérést a
 * statikus kiszolgáló teljesít ugyanebből a mappából.
 *
 * Mellékhaszon: a játék és a relay így AZONOS EREDETRŐL jön, tehát semmit nem
 * kell beállítani — a böngésző magától a saját címén keresi a szobákat.
 *
 * BEÁLLÍTÁS a cPanelben:
 *   Application root          : tank.luiz-tech.hu   (ahova a fájlokat tetted)
 *   Application URL           : tank.luiz-tech.hu   (a domain gyökere)
 *   Application startup file  : app.js
 *   Node.js version           : 18 vagy újabb
 *
 * `npm install` NEM kell: a projektnek nincs egyetlen függősége sem.
 *
 * Helyben ugyanígy indítható:
 *   node app.js --port 8080
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { relayRequest } from './tools/relay-server.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const PORT = Number(arg('--port', process.env.PORT || 8080));
const HOST = arg('--host', '0.0.0.0');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Amit soha nem adunk ki böngészőnek.
 *
 * Megosztott tárhelyen az alkalmazás mappája sokszor egyben a webgyökér is,
 * ezért a kiszolgáló-oldali fájlok különben letölthetők lennének.
 */
const BLOCKED = [
  /^\.git(\/|$)/,
  /^node_modules(\/|$)/,
  /^tools(\/|$)/,
  /^app\.js$/,
  /^package(-lock)?\.json$/,
  /^\.env/,
  /(^|\/)\./,            // minden rejtett fájl és mappa
];

function isBlocked(rel) {
  return BLOCKED.some((re) => re.test(rel));
}

function send(res, status, body, headers) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

/**
 * Statikus fájl kiszolgálása a projekt mappájából.
 * A `..` és a szimlinkes kitörés ellen a feloldott útvonalat ellenőrizzük.
 */
async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';

  if (isBlocked(rel)) {
    send(res, 403, 'Ez a fájl nem érhető el.');
    return;
  }

  const abs = path.resolve(ROOT, rel);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) {
    send(res, 403, 'Érvénytelen útvonal.');
    return;
  }

  let stats;
  try {
    stats = await fsp.stat(abs);
  } catch {
    send(res, 404, 'Nincs ilyen fájl.\n\nHa a játékot keresed: az index.html, '
      + 'a styles.css és a src/ mappa ugyanebbe a könyvtárba kell.');
    return;
  }
  if (stats.isDirectory()) {
    res.writeHead(302, { Location: `${pathname.replace(/\/+$/, '')}/` });
    res.end();
    return;
  }

  const ext = path.extname(abs).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  // A HTML sosem cache-elődik (különben egy frissítés után is a régi jönne),
  // a modulok rövid ideig igen.
  const cache = ext === '.html' ? 'no-cache' : 'public, max-age=300';

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stats.size,
    'Cache-Control': cache,
    'Last-Modified': stats.mtime.toUTCString(),
  });

  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(abs).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    // 1. Szobák. Ha nem az övé a kérés, `false`-t ad, és megyünk tovább.
    if (await relayRequest(req, res)) return;

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, 'Nem támogatott metódus.');
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    await serveStatic(req, res, url.pathname);
  } catch (err) {
    if (!res.headersSent) send(res, 500, `Kiszolgálóhiba: ${err.message}`);
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Slag fut:   http://${HOST}:${PORT}`);
  console.log(`Mappa:      ${ROOT}`);
  console.log('Szobák:     /api/health');
});

/**
 * Slag — szoba-relay.
 *
 * MIÉRT KELL EGYÁLTALÁN
 * A játék maga statikus fájlokból áll, és bármelyik tárhelyről elindul. Két
 * böngészőt viszont semmilyen tárhely nem tud összekötni: ahhoz kell egy
 * folyamat, ami fogadja az egyik gépet és továbbadja a másiknak. Ez az.
 * Egyetlen kicsi Node-folyamat, függőség nélkül.
 *
 * MIÉRT RELAY ÉS NEM WEBRTC
 * A WebRTC közvetlen kapcsolatot adna (kisebb késleltetés), de STUN kell hozzá,
 * szigorúbb NAT mögött TURN is — az pedig már nem ingyenes, és a kapcsolat
 * felállása bizonytalan. A relay minden hálózaton átmegy, amin a böngésző el
 * tudja érni a kiszolgálót. Cserébe minden csomag megjárja a szervert, tehát
 * a késleltetés a két fél és a szerver távolságától függ: érdemes olyan
 * helyre tenni, ami mindkét játékoshoz közel van.
 *
 * PROTOKOLL (szándékosan buta, hogy bármilyen tárhelyen működjön)
 *   POST /api/room                  -> { code, id }        új szoba, te vagy a gazda
 *   POST /api/room/:code/join       -> { id, hostId }      csatlakozás
 *   GET  /api/room/:code/events?id= -> text/event-stream   ide jönnek az üzenetek
 *   POST /api/room/:code/send?id=   -> {}                  üzenet a többieknek
 *   GET  /api/health                -> { ok: true, rooms }
 *
 * Az üzenet törzse tetszőleges JSON; a relay nem nézi meg, csak továbbadja.
 * `to` mezővel egy címzettnek, nélküle mindenkinek (a feladót kivéve).
 *
 * Indítás:
 *   node tools/relay-server.mjs --port 8090
 */

import http from 'node:http';
import { randomBytes } from 'node:crypto';

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const PORT = Number(argValue('--port', process.env.PORT || 8090));
const HOST = argValue('--host', '0.0.0.0');

/** Ennyi ideig él egy szoba az utolsó életjel után. */
const ROOM_TTL_MS = 5 * 60 * 1000;
/** Ennél nagyobb üzenetet nem fogadunk el (védekezés a szemét ellen). */
const MAX_BODY = 64 * 1024;
/** Egy szobában ennyi résztvevő lehet (4 játékos + tartalék). */
const MAX_MEMBERS = 8;
/** SSE életben tartó pingek, hogy a proxyk ne bontsák a kapcsolatot. */
const KEEPALIVE_MS = 15000;

/**
 * @typedef {{ id:string, res:http.ServerResponse|null, queue:Array<object>,
 *             seen:number }} Member
 * @typedef {{ code:string, hostId:string, members:Map<string,Member>,
 *             touched:number }} Room
 */

/** @type {Map<string, Room>} */
const rooms = new Map();

/** Ember által felolvasható, félreérthetetlen kód (nincs 0/O, 1/I). */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    const bytes = randomBytes(6);
    for (let i = 0; i < 6; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    if (!rooms.has(code)) return code;
  }
  // Gyakorlatilag elérhetetlen: 32^6 lehetőség.
  return `${Date.now().toString(36).toUpperCase()}`;
}

function makeId() {
  return randomBytes(8).toString('hex');
}

function sweepRooms() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.touched > ROOM_TTL_MS) {
      for (const m of room.members.values()) {
        if (m.res) { try { m.res.end(); } catch { /* már bontva */ } }
      }
      rooms.delete(code);
    }
  }
}
setInterval(sweepRooms, 30000).unref();

// ---------------------------------------------------------------------------
// HTTP segédek
// ---------------------------------------------------------------------------

function cors(res) {
  // A játék más eredetről (a tárhelyről) hívja ezt a kiszolgálót.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  cors(res);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('túl nagy törzs'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) { resolve({}); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('hibás JSON')); }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Kézbesítés
// ---------------------------------------------------------------------------

/** Egyetlen üzenet kiírása egy tag SSE-folyamára (vagy sorba, ha épp nincs). */
function deliver(member, payload) {
  if (member.res) {
    try {
      member.res.write(`data: ${JSON.stringify(payload)}\n\n`);
      return;
    } catch {
      member.res = null;      // bontott kapcsolat, essen sorba
    }
  }
  // A sor csak az újracsatlakozás pillanatáig tart, ezért rövid: a régi
  // állapot-pillanatképek úgyis értéktelenek, mire megérkeznének.
  member.queue.push(payload);
  if (member.queue.length > 64) member.queue.shift();
}

function route(room, fromId, message) {
  const to = typeof message.to === 'string' ? message.to : null;
  const payload = { ...message, from: fromId };
  for (const [id, member] of room.members) {
    if (id === fromId) continue;
    if (to && id !== to) continue;
    deliver(member, payload);
  }
}

function announce(room, type, id) {
  for (const [mid, member] of room.members) {
    if (mid === id) continue;
    deliver(member, { t: type, from: id, hostId: room.hostId });
  }
}

// ---------------------------------------------------------------------------
// Végpontok
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (path === '/api/health') {
    sendJson(res, 200, { ok: true, rooms: rooms.size });
    return;
  }

  // --- új szoba ------------------------------------------------------------
  if (path === '/api/room' && req.method === 'POST') {
    const code = makeCode();
    const id = makeId();
    const room = { code, hostId: id, members: new Map(), touched: Date.now() };
    room.members.set(id, { id, res: null, queue: [], seen: Date.now() });
    rooms.set(code, room);
    sendJson(res, 200, { code, id, hostId: id });
    return;
  }

  const match = path.match(/^\/api\/room\/([A-Z0-9]{4,12})\/(join|events|send|leave)$/i);
  if (!match) {
    sendJson(res, 404, { error: 'ismeretlen végpont' });
    return;
  }

  const code = match[1].toUpperCase();
  const action = match[2].toLowerCase();
  const room = rooms.get(code);
  if (!room) {
    sendJson(res, 404, { error: 'nincs ilyen szoba', code });
    return;
  }
  room.touched = Date.now();

  // --- csatlakozás ---------------------------------------------------------
  if (action === 'join' && req.method === 'POST') {
    if (room.members.size >= MAX_MEMBERS) {
      sendJson(res, 409, { error: 'a szoba tele van' });
      return;
    }
    const id = makeId();
    room.members.set(id, { id, res: null, queue: [], seen: Date.now() });
    announce(room, 'peer-join', id);
    sendJson(res, 200, { id, hostId: room.hostId, code });
    return;
  }

  const id = url.searchParams.get('id') || '';
  const member = room.members.get(id);
  if (!member) {
    sendJson(res, 403, { error: 'ismeretlen résztvevő' });
    return;
  }
  member.seen = Date.now();

  // --- eseményfolyam -------------------------------------------------------
  if (action === 'events' && req.method === 'GET') {
    cors(res);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Nginx elé téve enélkül pufferelne, és a játék akadozna.
      'X-Accel-Buffering': 'no',
    });
    res.write(': slag-relay\n\n');
    member.res = res;

    // Ami a kapcsolat felállása közben érkezett.
    const pending = member.queue.splice(0, member.queue.length);
    for (const p of pending) deliver(member, p);

    const keep = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* bontva */ }
    }, KEEPALIVE_MS);

    req.on('close', () => {
      clearInterval(keep);
      if (member.res === res) member.res = null;
      // A gazda távozása bontja a szobát, a többiek csak kiesnek.
      if (id === room.hostId) {
        announce(room, 'host-gone', id);
        rooms.delete(code);
      } else {
        room.members.delete(id);
        announce(room, 'peer-left', id);
      }
    });
    return;
  }

  // --- üzenetküldés --------------------------------------------------------
  if (action === 'send' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); }
    catch (err) { sendJson(res, 400, { error: String(err.message || err) }); return; }
    route(room, id, body || {});
    sendJson(res, 200, { ok: true });
    return;
  }

  if (action === 'leave' && req.method === 'POST') {
    room.members.delete(id);
    announce(room, 'peer-left', id);
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 405, { error: 'nem támogatott metódus' });
});

server.listen(PORT, HOST, () => {
  console.log(`Slag relay fut:  http://${HOST}:${PORT}`);
  console.log('Állapot:         /api/health');
});

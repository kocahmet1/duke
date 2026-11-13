/* ===========================================================================
   mp-server.mjs -- the game's web server plus the multiplayer handshake.

   Two jobs, one process:

     1. FILES     Serves the game (NUKEM.html and its modules), gzipped and
                  revalidated with ETags so a returning player downloads
                  nothing that has not changed.

     2. SIGNAL    A WebSocket at /signal that puts players in a room and passes
                  the few connection messages two browsers need to find each
                  other. After that the browsers talk DIRECTLY (WebRTC data
                  channels): no gameplay traffic ever passes through here, so
                  this process adds no lag and a restart does not end a match.

   Run it:
     npm run mp                       dev: serves the repo folder, 127.0.0.1:4173
     node server/mp-server.mjs --dist serves dist/client/game (after npm run build)

   Environment:
     PORT / HOST              Render sets PORT; with PORT set we bind 0.0.0.0
     NZ_MAX_PLAYERS           room size, 2..8 (default 4)
     CF_TURN_KEY_ID           Cloudflare Realtime TURN key id      } optional:
     CF_TURN_KEY_API_TOKEN    Cloudflare Realtime TURN API token   } relay fallback
     NZ_STUN                  comma-separated STUN urls ('' for none)
   ======================================================================== */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const ARGS = new Set(process.argv.slice(2));
const DIST = ARGS.has('--dist') || process.env.NZ_DIST === '1';
const ROOT = DIST ? path.join(REPO, 'dist', 'client', 'game') : REPO;
const PORT = Number(process.env.PORT || process.env.NZ_PORT) || 4173;
const HOST = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const MAX_PLAYERS = Math.max(2, Math.min(8, parseInt(process.env.NZ_MAX_PLAYERS || '4', 10) || 4));
/* Must equal NET.PROTO in nz-net.js. Bump both when the wire format changes,
   so a browser holding an old copy of the page is told to refresh instead of
   joining a match it cannot understand. */
const PROTO = 1;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* =============================================================== files == */
const TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);
const COMPRESS = new Set(['.html', '.js', '.css', '.svg']);
/* The dev root is the whole project folder. Only game files go out: nothing
   whose path has a dot- or underscore-folder in it (.git, _shots, _tmp), and
   none of the tooling folders. */
const DENY_DIRS = new Set(['node_modules', 'scripts', 'server', 'dist', 'worker', 'build', 'app', 'x', '-p']);

function resolvePath(urlPath) {
  let p;
  try { p = decodeURIComponent(urlPath); } catch { return null; }
  if (p === '/' || p === '') p = '/NUKEM.html';
  const rel = p.replace(/^\/+/, '');
  const parts = rel.split('/');
  if (parts.some(s => !s || s === '..' || s.startsWith('.') || s.startsWith('_'))) return null;
  if (!DIST && DENY_DIRS.has(parts[0])) return null;
  const ext = path.extname(rel).toLowerCase();
  if (!TYPES.has(ext)) return null;
  const abs = path.resolve(ROOT, rel);
  return abs.startsWith(ROOT + path.sep) ? abs : null;
}

/* path -> { mtimeMs, size, buf, etag, gz } ; gz fills in asynchronously */
const CACHE = new Map();
let BUILD = 'dev';

async function load(abs) {
  const st = await fs.stat(abs);
  if (!st.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' });
  const hit = CACHE.get(abs);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
  let buf = await fs.readFile(abs);
  const ext = path.extname(abs).toLowerCase();
  /* The page carries the build id, so a browser holding a stale copy can be
     told to refresh when it tries to join. */
  if (ext === '.html' && BUILD !== 'dev') {
    buf = Buffer.from(buf.toString('utf8').replace('</head>',
      `<meta name="nz-build" content="${BUILD}">\n</head>`), 'utf8');
  }
  const ent = {
    mtimeMs: st.mtimeMs, size: st.size, buf,
    etag: '"' + crypto.createHash('sha1').update(buf).digest('base64url').slice(0, 20) + '"',
    gz: null, gzBusy: false, ext
  };
  CACHE.set(abs, ent);
  if (COMPRESS.has(ext) && buf.length > 1024) {
    ent.gzBusy = true;
    zlib.gzip(buf, { level: 6 }, (err, out) => { ent.gzBusy = false; if (!err) ent.gz = out; });
  }
  return ent;
}

async function computeBuild() {
  /* A hash of what a player will actually run: the page and every module. */
  const h = crypto.createHash('sha1');
  const names = (await fs.readdir(ROOT)).filter(n => n === 'NUKEM.html' || /^nz-.*\.js$/.test(n)).sort();
  for (const n of names) { h.update(n); h.update(await fs.readFile(path.join(ROOT, n))); }
  return h.digest('hex').slice(0, 12);
}

/* the link-preview picture (og:image) lives next to the game folder, not in it */
const EXTRA = new Map([['/og.png', DIST ? path.join(REPO, 'dist', 'client', 'og.png') : path.join(REPO, 'public', 'og.png')]]);

async function serveFile(req, res, urlPath) {
  if (urlPath === '/favicon.ico') { res.writeHead(204, { 'cache-control': 'public, max-age=86400' }); res.end(); return; }
  const abs = EXTRA.get(urlPath) || resolvePath(urlPath);
  if (!abs) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Not found'); return; }
  let ent;
  try { ent = await load(abs); }
  catch (err) {
    const nf = err && err.code === 'ENOENT';
    res.writeHead(nf ? 404 : 500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(nf ? 'Not found' : 'Server error');
    return;
  }
  const headers = {
    'content-type': TYPES.get(ent.ext) || 'application/octet-stream',
    /* revalidate every time: a 304 costs a round trip, a stale game costs a
       failed join */
    'cache-control': 'no-cache',
    etag: ent.etag,
    vary: 'Accept-Encoding',
    'x-content-type-options': 'nosniff'
  };
  if (req.headers['if-none-match'] === ent.etag) { res.writeHead(304, headers); res.end(); return; }
  const gzOk = ent.gz && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
  const body = gzOk ? ent.gz : ent.buf;
  if (gzOk) headers['content-encoding'] = 'gzip';
  headers['content-length'] = body.length;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') res.end(); else res.end(body);
}

/* ================================================================= ICE == */
/* STUN lets two browsers discover their public addresses and connect
   directly. TURN is the relay for the connections that cannot (shared
   carrier addresses, strict firewalls). Cloudflare's runs on anycast, so the
   relay is the Cloudflare location nearest each player. */
const STUN = (process.env.NZ_STUN !== undefined ? process.env.NZ_STUN : 'stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302')
  .split(',').map(s => s.trim()).filter(Boolean);
const TURN = { servers: null, until: 0, busy: null, failedAt: 0 };

async function fetchTurn() {
  const id = process.env.CF_TURN_KEY_ID, tok = process.env.CF_TURN_KEY_API_TOKEN;
  if (!id || !tok) return null;
  const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(id)}/credentials/generate-ice-servers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl: 86400 }),
    signal: AbortSignal.timeout(5000)
  });
  if (!r.ok) throw new Error(`TURN credentials: HTTP ${r.status}`);
  const j = await r.json();
  const list = Array.isArray(j.iceServers) ? j.iceServers : (j.iceServers ? [j.iceServers] : []);
  /* Browsers block port 53, and a TURN url there only costs a timeout. */
  for (const s of list) {
    const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter(u => typeof u === 'string' && !/:53(\?|$)/.test(u));
    s.urls = urls;
  }
  return list.filter(s => s.urls.length);
}

async function iceServers() {
  const base = STUN.length ? [{ urls: STUN }] : [];
  if (!process.env.CF_TURN_KEY_ID) return base;
  const now = Date.now();
  if (TURN.servers && now < TURN.until) return base.concat(TURN.servers);
  if (now - TURN.failedAt < 60000) return TURN.servers ? base.concat(TURN.servers) : base;
  if (!TURN.busy) {
    TURN.busy = fetchTurn().then(list => {
      TURN.servers = list; TURN.until = Date.now() + 12 * 3600 * 1000;
      log('turn: credentials refreshed');
    }).catch(err => { TURN.failedAt = Date.now(); log('turn:', err.message); })
      .finally(() => { TURN.busy = null; });
  }
  await TURN.busy;
  return TURN.servers ? base.concat(TURN.servers) : base;
}

/* =============================================================== rooms == */
/* code -> { code, level, peers: Map(id -> P), order: [id], created } */
const ROOMS = new Map();
const ROOM_RE = /^[A-Z0-9]{4,8}$/;
const ID_RE = /^[a-z0-9]{6,16}$/;
const COLORS = 8;

function send(ws, msg) {
  if (ws.readyState === 1) { try { ws.send(JSON.stringify(msg)); } catch { /* closing */ } }
}
function cleanName(s) {
  return String(s || '').replace(/[^\p{L}\p{N} ._\-]/gu, '').trim().slice(0, 16) || 'PLAYER';
}
function roomOf(ws) { return ws.nz && ws.nz.room ? ROOMS.get(ws.nz.room) : null; }

function leave(ws) {
  const R = roomOf(ws);
  if (!R || !ws.nz || !ws.nz.id) return;
  const id = ws.nz.id;
  const P = R.peers.get(id);
  if (!P || P.ws !== ws) return;
  R.peers.delete(id);
  R.order = R.order.filter(x => x !== id);
  ws.nz.room = null;
  for (const Q of R.peers.values()) send(Q.ws, { t: 'peer-left', id });
  if (!R.peers.size) { ROOMS.delete(R.code); log(`room ${R.code} closed`); return; }
  if (R.host === id) {
    R.host = R.order[0];
    for (const Q of R.peers.values()) send(Q.ws, { t: 'host', id: R.host });
  }
  log(`room ${R.code}: ${P.name} left (${R.peers.size}/${MAX_PLAYERS})`);
}

async function join(ws, m) {
  if (m.proto !== PROTO) { send(ws, { t: 'error', code: 'version', msg: 'Oyunun bu kopyası eski. Sayfayı yenile.' }); return; }
  if (BUILD !== 'dev' && m.build && m.build !== 'dev' && m.build !== BUILD) {
    send(ws, { t: 'error', code: 'version', msg: 'Oyun güncellendi. Katılmak için sayfayı yenile.' }); return;
  }
  const code = String(m.room || '').toUpperCase();
  if (!ROOM_RE.test(code)) { send(ws, { t: 'error', code: 'room', msg: 'Bu oda kodu geçersiz.' }); return; }
  const level = Math.max(1, Math.min(4, parseInt(m.level, 10) || 2));
  let R = ROOMS.get(code);
  if (!R) {
    if (ROOMS.size >= 500) { send(ws, { t: 'error', code: 'busy', msg: 'Sunucu dolu. Daha sonra tekrar dene.' }); return; }
    R = { code, level, peers: new Map(), order: [], host: null, created: Date.now() };
    ROOMS.set(code, R);
    log(`room ${code} opened (mission ${level})`);
  }
  if (R.level !== level) { send(ws, { t: 'error', code: 'level', level: R.level, msg: `Bu maç ${R.level}. görevde oynanıyor.` }); return; }
  /* a browser re-joining after a dropped socket keeps its id, so its direct
     connections (which never went through here) carry on undisturbed */
  let id = ID_RE.test(m.id || '') ? m.id : null;
  const prior = id && R.peers.get(id);
  if (prior && prior.ws !== ws) {
    if (prior.ws.readyState === 1) { try { prior.ws.close(4000, 'replaced'); } catch { } }
    R.peers.delete(id); R.order = R.order.filter(x => x !== id);
  }
  if (!id || R.peers.has(id)) id = crypto.randomBytes(6).toString('hex');
  if (R.peers.size >= MAX_PLAYERS) { send(ws, { t: 'error', code: 'full', msg: `Bu maç dolu (${MAX_PLAYERS} oyuncu).` }); return; }
  const used = new Set([...R.peers.values()].map(p => p.color));
  let color = 0; while (used.has(color) && color < COLORS - 1) color++;
  const P = { id, name: cleanName(m.name), ws, color, joined: Date.now() };
  const existing = [...R.peers.values()].map(p => ({ id: p.id, name: p.name, color: p.color }));
  R.peers.set(id, P); R.order.push(id);
  if (!R.host || !R.peers.has(R.host)) R.host = id;
  ws.nz.room = code; ws.nz.id = id;
  const ice = await iceServers();
  send(ws, { t: 'welcome', id, room: code, level: R.level, host: R.host, color, max: MAX_PLAYERS, peers: existing, ice });
  for (const Q of R.peers.values()) if (Q.id !== id) send(Q.ws, { t: 'peer-joined', id, name: P.name, color });
  log(`room ${code}: ${P.name} joined (${R.peers.size}/${MAX_PLAYERS})`);
}

function onMessage(ws, raw) {
  if (raw.length > 65536) return;
  /* a modest flood guard: a handshake is tens of messages, not thousands */
  const now = Date.now();
  if (now - ws.nz.winT > 1000) { ws.nz.winT = now; ws.nz.winN = 0; }
  if (++ws.nz.winN > 300) return;
  let m;
  try { m = JSON.parse(raw.toString('utf8')); } catch { return; }
  if (!m || typeof m.t !== 'string') return;
  if (m.t === 'join') { join(ws, m).catch(err => log('join failed:', err.message)); return; }
  const R = roomOf(ws);
  if (!R) return;
  if (m.t === 'signal') {
    const Q = R.peers.get(String(m.to || ''));
    if (Q && Q.ws !== ws) send(Q.ws, { t: 'signal', from: ws.nz.id, data: m.data });
  } else if (m.t === 'name') {
    const P = R.peers.get(ws.nz.id);
    if (!P) return;
    P.name = cleanName(m.name);
    for (const Q of R.peers.values()) if (Q.id !== P.id) send(Q.ws, { t: 'peer-name', id: P.id, name: P.name });
  } else if (m.t === 'ice') {
    iceServers().then(ice => send(ws, { t: 'ice', ice })).catch(() => { });
  }
}

/* ============================================================== server == */
const server = http.createServer((req, res) => {
  const u = new URL(req.url || '/', 'http://localhost');
  if (u.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
  if (u.pathname === '/mp/status') {
    let players = 0; for (const R of ROOMS.values()) players += R.peers.size;
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, rooms: ROOMS.size, players, max: MAX_PLAYERS, build: BUILD, turn: !!process.env.CF_TURN_KEY_ID }));
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  serveFile(req, res, u.pathname).catch(err => { log('serve:', err.message); try { res.writeHead(500); res.end(); } catch { } });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });
server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url || '/', 'http://localhost');
  if (u.pathname !== '/signal') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});
wss.on('connection', ws => {
  ws.nz = { room: null, id: null, alive: true, winT: 0, winN: 0 };
  ws.on('pong', () => { ws.nz.alive = true; });
  ws.on('message', raw => onMessage(ws, raw));
  ws.on('close', () => leave(ws));
  ws.on('error', () => { });
});
/* keepalive: proxies close quiet sockets, and a dead socket must free its slot */
const beat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.nz.alive) { try { ws.terminate(); } catch { } continue; }
    ws.nz.alive = false;
    try { ws.ping(); } catch { }
  }
}, 25000);

if (DIST) {
  try { BUILD = await computeBuild(); }
  catch (err) { console.error(`mp-server: ${ROOT} is not readable (${err.message}). Run "npm run build" first.`); process.exit(1); }
}
server.listen(PORT, HOST, () => {
  log(`Nuke Zone 3D multiplayer server on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/`);
  log(`serving ${DIST ? 'dist/client/game' : 'the project folder'} | rooms of up to ${MAX_PLAYERS} | build ${BUILD}` +
    ` | relay ${process.env.CF_TURN_KEY_ID ? 'Cloudflare TURN' : 'off (direct connections only)'}`);
});

function stop() {
  clearInterval(beat);
  for (const ws of wss.clients) { try { ws.close(1012, 'restarting'); } catch { } }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

"use strict";
/*
 * Taş Kağıt Makas (ve Kertenkele-Spock) — çevrimiçi oyun sunucusu
 *
 * Sunucu hakemdir: hamleler sunucuda tutulur ve iki oyuncu da seçmeden
 * kimseye gönderilmez. Bu yüzden istemci tarafında hile yapılamaz.
 * Tüm durum bellekte tutulur; tek bir sunucu örneğiyle çalışacak şekilde tasarlandı.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const OFFLINE_GRACE_MS = 2 * 60 * 1000;     // bağlantısı kopan oyuncu bu süre içinde dönebilir
const GAME_IDLE_MS = 2 * 60 * 60 * 1000;    // bu kadar hareketsiz kalan oyun silinir
const MSG_PER_SEC = 15;                      // bağlantı başına mesaj sınırı

/* ---------- Oyun kuralları ---------- */
const VARIANTS = {
  klasik: ["tas", "kagit", "makas"],
  spock: ["tas", "kagit", "makas", "kertenkele", "spock"],
};
const BEATS = new Set([
  "makas>kagit", "kagit>tas", "tas>kertenkele", "kertenkele>spock", "spock>makas",
  "makas>kertenkele", "kertenkele>kagit", "kagit>spock", "spock>tas", "tas>makas",
]);
const FIRST_TO = { 3: 2, 5: 3, 7: 4 };
const winner = (a, b) => (a === b ? 0 : BEATS.has(`${a}>${b}`) ? 1 : 2);

/* ---------- Statik dosyalar ---------- */
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/health") { res.writeHead(200); res.end("ok"); return; }
  let rel;
  try { rel = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname); }
  catch (e) { res.writeHead(400); res.end(); return; }
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("Bulunamadı"); return; }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(data);
  });
});

/* ---------- Durum ---------- */
const players = new Map();   // id -> { id, name, ws, gameCode, offlineTimer }
const games = new Map();     // kod -> oyun
let queue = [];              // rastgele rakip arayanlar: { id, variant, bestOf, since }

const isOnline = (p) => !!(p && p.ws && p.ws.readyState === 1);
function send(p, msg) { if (isOnline(p)) p.ws.send(JSON.stringify(msg)); }
function cleanName(n) {
  return String(n ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 20) || "Oyuncu";
}
function genCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let c;
  do { c = Array.from({ length: 5 }, () => chars[crypto.randomInt(chars.length)]).join(""); } while (games.has(c));
  return c;
}

function createGame(host, variant, bestOf, isPrivate) {
  const g = {
    code: genCode(), variant, bestOf, target: FIRST_TO[bestOf], isPrivate,
    p1: host.id, p2: null, match: 1, moves: {}, history: [], rematch: new Set(), left: {},
    updatedAt: Date.now(),
  };
  games.set(g.code, g);
  host.gameCode = g.code;
  return g;
}
const roleOf = (g, id) => (g.p1 === id ? "p1" : g.p2 === id ? "p2" : null);
function score(g) {
  const s = { p1: 0, p2: 0 };
  for (const h of g.history) { const w = winner(h.p1, h.p2); if (w === 1) s.p1++; else if (w === 2) s.p2++; }
  return s;
}
const isFinished = (g) => { const s = score(g); return s.p1 >= g.target || s.p2 >= g.target; };

// Her oyuncuya kendi bakış açısından durum gönderilir. Rakibin bu eldeki hamlesi asla gönderilmez.
function stateFor(g, id) {
  const role = roleOf(g, id), opp = role === "p1" ? "p2" : "p1";
  const s = score(g), oppId = g[opp], oppP = oppId ? players.get(oppId) : null;
  return {
    type: "state", code: g.code, isPrivate: g.isPrivate, variant: g.variant, bestOf: g.bestOf,
    target: g.target, match: g.match, finished: isFinished(g),
    me: { name: players.get(id)?.name || "Oyuncu", score: s[role], choice: g.moves[role] || null, rematch: g.rematch.has(role) },
    opp: oppId ? {
      name: oppP?.name || "Rakip", score: s[opp], chose: !!g.moves[opp],
      online: isOnline(oppP) && oppP.gameCode === g.code, left: !!g.left[opp], rematch: g.rematch.has(opp),
    } : null,
    history: g.history.map((h, i) => {
      const w = winner(h.p1, h.p2);
      return { r: i + 1, mine: h[role], theirs: h[opp], w: w === 0 ? 0 : (w === 1) === (role === "p1") ? 1 : -1 };
    }),
  };
}
function pushState(g) {
  for (const id of [g.p1, g.p2]) {
    if (!id) continue;
    const p = players.get(id);
    if (p && p.gameCode === g.code) send(p, stateFor(g, id));
  }
}

function removeFromQueue(id) { queue = queue.filter((q) => q.id !== id); }

function leaveGame(p) {
  removeFromQueue(p.id);
  const g = p.gameCode ? games.get(p.gameCode) : null;
  p.gameCode = null;
  if (!g) return;
  const role = roleOf(g, p.id);
  if (!g.p2) { games.delete(g.code); return; }
  g.left[role] = true;
  delete g.moves[role];
  g.rematch.delete(role);
  if (g.left.p1 && g.left.p2) games.delete(g.code);
  else pushState(g);
}

function quickMatch(p, variant, bestOf) {
  leaveGame(p);
  const cands = queue
    .filter((q) => q.id !== p.id && q.variant === variant && isOnline(players.get(q.id)))
    .sort((a, b) => ((a.bestOf === bestOf ? 0 : 1) - (b.bestOf === bestOf ? 0 : 1)) || a.since - b.since);
  const c = cands[0];
  if (c) {
    removeFromQueue(c.id);
    const g = createGame(players.get(c.id), variant, c.bestOf, false);
    g.p2 = p.id;
    p.gameCode = g.code;
    pushState(g);
  } else {
    queue.push({ id: p.id, variant, bestOf, since: Date.now() });
    send(p, { type: "seeking", variant, bestOf });
  }
  scheduleStats();
}

/* ---------- Lobi istatistikleri ---------- */
let statsTimer = null;
function scheduleStats() {
  if (statsTimer) return;
  statsTimer = setTimeout(() => {
    statsTimer = null;
    let online = 0;
    for (const p of players.values()) if (isOnline(p)) online++;
    const seeking = { klasik: 0, spock: 0 };
    for (const q of queue) seeking[q.variant]++;
    const msg = { type: "stats", online, seeking };
    for (const p of players.values()) if (!p.gameCode) send(p, msg);
  }, 400);
}

/* ---------- Mesajlar ---------- */
function handle(ws, msg) {
  if (msg.type === "hello") {
    if (typeof msg.id !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(msg.id)) { ws.close(1008, "gecersiz kimlik"); return; }
    let p = players.get(msg.id);
    if (p && p.ws && p.ws !== ws) { try { p.ws.close(4000, "baska sekme"); } catch (e) { /* yok say */ } }
    if (!p) { p = { id: msg.id, name: "", ws: null, gameCode: null, offlineTimer: null }; players.set(p.id, p); }
    p.ws = ws; p.name = cleanName(msg.name);
    clearTimeout(p.offlineTimer);
    ws.playerId = p.id;
    const g = p.gameCode ? games.get(p.gameCode) : null;
    if (g) pushState(g); else { p.gameCode = null; send(p, { type: "lobby" }); }
    scheduleStats();
    return;
  }

  const p = players.get(ws.playerId);
  if (!p || p.ws !== ws) return;
  const g = p.gameCode ? games.get(p.gameCode) : null;

  switch (msg.type) {
    case "setName":
      p.name = cleanName(msg.name);
      if (g) pushState(g);
      break;

    case "quick":
      if (!VARIANTS[msg.variant] || !FIRST_TO[msg.bestOf]) return;
      quickMatch(p, msg.variant, msg.bestOf);
      break;

    case "cancel":
      removeFromQueue(p.id);
      send(p, { type: "lobby" });
      scheduleStats();
      break;

    case "create": {
      if (!VARIANTS[msg.variant] || !FIRST_TO[msg.bestOf]) return;
      leaveGame(p);
      const ng = createGame(p, msg.variant, msg.bestOf, true);
      pushState(ng);
      scheduleStats();
      break;
    }

    case "join": {
      const code = String(msg.code || "").trim().toUpperCase();
      const jg = games.get(code);
      if (!jg) { send(p, { type: "error", msg: "Bu kodla bir oyun bulunamadı." }); return; }
      const r = roleOf(jg, p.id);
      if (r) {                                   // kendi oyununa geri dönüyor
        if (p.gameCode !== code) leaveGame(p);
        removeFromQueue(p.id);
        p.gameCode = code; delete jg.left[r];
        pushState(jg);
        return;
      }
      if (jg.p2) { send(p, { type: "error", msg: "Bu oyun dolu." }); return; }
      leaveGame(p);
      jg.p2 = p.id; p.gameCode = code; jg.updatedAt = Date.now();
      pushState(jg);
      scheduleStats();
      break;
    }

    case "move": {
      if (!g || !g.p2) return;
      const role = roleOf(g, p.id);
      if (!role || isFinished(g) || g.moves[role]) return;
      if (!VARIANTS[g.variant].includes(msg.m)) return;
      g.moves[role] = msg.m;
      g.updatedAt = Date.now();
      if (g.moves.p1 && g.moves.p2) {
        g.history.push({ p1: g.moves.p1, p2: g.moves.p2 });
        g.moves = {};
      }
      pushState(g);
      break;
    }

    case "rematch": {
      if (!g || !isFinished(g)) return;
      const role = roleOf(g, p.id), opp = role === "p1" ? "p2" : "p1";
      if (!role || g.left[opp]) return;
      g.rematch.add(role);
      if (g.rematch.size === 2) {
        g.match++; g.history = []; g.moves = {}; g.rematch.clear();
      }
      g.updatedAt = Date.now();
      pushState(g);
      break;
    }

    case "leave":
      leaveGame(p);
      send(p, { type: "lobby" });
      scheduleStats();
      break;
  }
}

/* ---------- WebSocket ---------- */
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 4 * 1024 });

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.tokens = MSG_PER_SEC;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (raw) => {
    if (ws.tokens <= 0) return;   // çok hızlı mesaj gönderen bağlantıyı yavaşlat
    ws.tokens--;
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;
    try { handle(ws, msg); } catch (e) { console.error("Mesaj işlenemedi:", e); }
  });

  ws.on("close", () => {
    const p = players.get(ws.playerId);
    if (!p || p.ws !== ws) return;
    p.ws = null;
    removeFromQueue(p.id);
    const g = p.gameCode ? games.get(p.gameCode) : null;
    if (g) pushState(g);
    p.offlineTimer = setTimeout(() => {
      if (isOnline(p)) return;
      leaveGame(p);
      players.delete(p.id);
    }, OFFLINE_GRACE_MS);
    scheduleStats();
  });
});

// Mesaj kotası yenileme, ölü bağlantıları temizleme ve eski oyunları silme
setInterval(() => { for (const ws of wss.clients) ws.tokens = MSG_PER_SEC; }, 1000);
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30 * 1000);
setInterval(() => {
  const now = Date.now();
  for (const g of games.values()) {
    if (now - g.updatedAt < GAME_IDLE_MS) continue;
    games.delete(g.code);
    for (const id of [g.p1, g.p2]) {
      const p = id && players.get(id);
      if (p && p.gameCode === g.code) { p.gameCode = null; send(p, { type: "lobby" }); }
    }
  }
}, 5 * 60 * 1000);

server.listen(PORT, () => console.log(`Taş Kağıt Makas sunucusu: http://localhost:${PORT}`));

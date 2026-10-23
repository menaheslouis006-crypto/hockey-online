const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const HK = require('./public/shared.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static('public'));
app.get('/health', (_, res) => res.send('ok'));

// Terrain et réglages
const W = 1000, H = 600, GOAL = 180, GT = (H - GOAL) / 2, GB = GT + GOAL;
const PR = 14;          // rayon de la balle
const HW = 65, HH = 8;  // demi-longueur / demi-épaisseur de la barre
const WIN = 7, SPIN = 4.5, MAXV = 1600, REST = 0.92;
const rooms = new Map();
const BASE = 0.9; // vitesse de balle "normale" (x1.0) : 0.9 = un cran de moins qu'avant
const WL0 = HK.BORDERS.concat(HK.CL0), WL1 = HK.BORDERS.concat(HK.CL1);

const rot = (x, y, a) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const f = n => Math.round(n * 10) / 10;
const reset = r => { r.puck = { x: W / 2, y: H / 2, vx: 0, vy: 0 }; };

function newRoom(fun) {
  const r = { players: [null, null], spect: [], score: [0, 0], freeze: 0, winner: -1, msg: '', cancelFrom: -1, fun: !!fun, spd: 1 };
  reset(r);
  return r;
}
function newPlayer(id, name, side) {
  const x = side === 0 ? 150 : W - 150;
  return { id, name, side, x, y: H / 2, tx: x, ty: H / 2, a: Math.PI / 2, w: 0, vx: 0, vy: 0, r: 0, t: false };
}

// Collision balle (cercle) <-> boîte tournante (barre de joueur ou mur de la map)
function box(p, x, y, a, hw, hh, bvx, bvy, w, e) {
  const [lx, ly] = rot(p.x - x, p.y - y, -a);
  const cx = clamp(lx, -hw, hw), cy = clamp(ly, -hh, hh);
  let dx = lx - cx, dy = ly - cy, d = Math.hypot(dx, dy);
  if (d >= PR) return;
  if (d < 1e-6) { dx = lx; dy = ly; d = Math.hypot(dx, dy) || 1; }
  const [nx, ny] = rot(dx / d, dy / d, a);
  const [rx, ry] = rot(cx, cy, a);
  const vx = bvx - w * ry, vy = bvy + w * rx;
  p.x += nx * (PR - d);
  p.y += ny * (PR - d);
  const vn = (p.vx - vx) * nx + (p.vy - vy) * ny;
  if (vn < 0) { p.vx -= (1 + e) * vn * nx; p.vy -= (1 + e) * vn * ny; }
  const sp = Math.hypot(p.vx, p.vy);
  if (sp > MAXV) { p.vx *= MAXV / sp; p.vy *= MAXV / sp; }
}
const hit = (p, pl) => box(p, pl.x, pl.y, pl.a, HW, HH, pl.vx, pl.vy, pl.w, REST);

function goal(r, side) {
  r.score[side]++;
  reset(r);
  const who = r.players[side] ? r.players[side].name : 'Joueur';
  if (r.score[side] >= WIN) { r.winner = side; r.freeze = 5; r.msg = `${who} gagne la partie !`; }
  else { r.freeze = 1.5; r.msg = `BUT ! ${who}`; }
}

function step(r, dt) {
  if (r.freeze > 0) {
    r.freeze -= dt;
    if (r.freeze <= 0) { if (r.winner >= 0) { r.score = [0, 0]; r.winner = -1; } r.msg = ''; }
  }
  const n = Math.max(4, Math.ceil(4 * r.spd * BASE)), s = dt / n;
  const active = r.freeze <= 0 && (r.players[0] || r.players[1]);
  for (let i = 0; i < n; i++) {
    for (const pl of r.players) if (pl) HK.stepPaddle(pl, pl.tx, pl.ty, pl.r, pl.t, pl.side === 0 ? WL0 : WL1, s, SPIN);
    if (!active) continue;
    const p = r.puck;
    p.x += p.vx * s * r.spd * BASE; p.y += p.vy * s * r.spd * BASE;
    p.vx *= 1 - 0.35 * s * r.spd * BASE; p.vy *= 1 - 0.35 * s * r.spd * BASE;
    for (const pl of r.players) if (pl) hit(p, pl);
    // murs
    if (p.y < PR) { p.y = PR; p.vy = Math.abs(p.vy) * 0.95; }
    if (p.y > H - PR) { p.y = H - PR; p.vy = -Math.abs(p.vy) * 0.95; }
    const inGoal = p.y > GT && p.y < GB;
    if (!inGoal) {
      if (p.x < PR) { p.x = PR; p.vx = Math.abs(p.vx) * 0.95; }
      if (p.x > W - PR) { p.x = W - PR; p.vx = -Math.abs(p.vx) * 0.95; }
    }
    if (p.x < -PR) { goal(r, 1); break; }
    if (p.x > W + PR) { goal(r, 0); break; }
  }
}

// ================= MODE CRÉATIF =================
const KIND = { w: [40, 400], m: [12, 90], c: [12, 90] }; // w = mur (longueur), m = bumper, c = cible (rayon)
function mkObj(r, d) {
  if (!d || !KIND[d.t]) return null;
  const [lo, hi] = KIND[d.t];
  return { id: r.nid++, t: d.t, x: clamp(+d.x || 0, 0, W), y: clamp(+d.y || 0, 0, H), a: clamp(+d.a || 0, -1000, 1000), s: clamp(+d.s || lo, lo, hi) };
}
function mkBall(r, x, y) {
  x = clamp(+x || W / 2, PR, W - PR); y = clamp(+y || H / 2, PR, H - PR);
  return { id: r.nid++, x, y, vx: 0, vy: 0, sx: x, sy: y };
}
function newCRoom(fun) {
  const r = { mode: 'c', pl: {}, objs: [], balls: [], score: 0, nid: 1, ci: 0, fun: !!fun, spd: 1 };
  for (const d of [{ t: 'm', x: 500, y: 200, s: 30 }, { t: 'm', x: 500, y: 400, s: 30 }, { t: 'w', x: 760, y: 300, a: Math.PI / 2, s: 200 }, { t: 'c', x: 900, y: 300, s: 35 }]) r.objs.push(mkObj(r, d));
  r.balls.push(mkBall(r, 300, 300));
  return r;
}
const mapOf = r => ({ o: r.objs, b: r.balls.map(b => [b.id, b.sx, b.sy]) });
const sendMap = (r, code) => io.to(code).emit('map', mapOf(r));
const croom = sock => { const r = rooms.get(sock.data.code); return r && r.mode === 'c' ? r : null; };

function bump(b, o) {
  const dx = b.x - o.x, dy = b.y - o.y, d = Math.hypot(dx, dy), m = PR + o.s;
  if (d >= m || d < 1e-6) return;
  const nx = dx / d, ny = dy / d;
  b.x = o.x + nx * m; b.y = o.y + ny * m;
  let vn = b.vx * nx + b.vy * ny;
  if (vn < 0) { b.vx -= 2 * vn * nx; b.vy -= 2 * vn * ny; vn = -vn; }
  if (vn < 500) { b.vx += nx * (500 - vn); b.vy += ny * (500 - vn); }
}
function cstep(r, dt) {
  const n = Math.max(4, Math.ceil(4 * r.spd * BASE)), s = dt / n, P = Object.values(r.pl), B = r.balls;
  const wl = HK.BORDERS.concat(r.objs.filter(o => o.t === 'w').map(o => ({ x: o.x, y: o.y, a: o.a, hw: o.s / 2, hh: 8, f: true })));
  for (let i = 0; i < n; i++) {
    for (const pl of P) HK.stepPaddle(pl, pl.tx, pl.ty, pl.r, pl.t, wl, s, SPIN);
    for (const b of B) {
      b.x += b.vx * s * r.spd * BASE; b.y += b.vy * s * r.spd * BASE;
      b.vx *= 1 - 0.25 * s * r.spd * BASE; b.vy *= 1 - 0.25 * s * r.spd * BASE;
      for (const pl of P) hit(b, pl);
      for (const o of r.objs) {
        if (o.t === 'w') box(b, o.x, o.y, o.a, o.s / 2, 8, 0, 0, 0, 0.9);
        else if (o.t === 'm') bump(b, o);
        else if (Math.hypot(b.x - o.x, b.y - o.y) < o.s) { r.score++; b.x = b.sx; b.y = b.sy; b.vx = b.vy = 0; }
      }
      if (b.x < PR) { b.x = PR; b.vx = Math.abs(b.vx) * 0.95; }
      if (b.x > W - PR) { b.x = W - PR; b.vx = -Math.abs(b.vx) * 0.95; }
      if (b.y < PR) { b.y = PR; b.vy = Math.abs(b.vy) * 0.95; }
      if (b.y > H - PR) { b.y = H - PR; b.vy = -Math.abs(b.vy) * 0.95; }
      const sp = Math.hypot(b.vx, b.vy);
      if (sp > MAXV) { b.vx *= MAXV / sp; b.vy *= MAXV / sp; }
    }
    for (let j = 0; j < B.length; j++) for (let k = j + 1; k < B.length; k++) {
      const p = B[j], q = B[k];
      const dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy);
      if (d < 2 * PR && d > 0) {
        const nx = dx / d, ny = dy / d, ov = (2 * PR - d) / 2;
        p.x -= nx * ov; p.y -= ny * ov; q.x += nx * ov; q.y += ny * ov;
        const vn = (q.vx - p.vx) * nx + (q.vy - p.vy) * ny;
        if (vn < 0) { p.vx += vn * nx; p.vy += vn * ny; q.vx -= vn * nx; q.vy -= vn * ny; }
      }
    }
  }
}
const csnap = r => ({
  pl: Object.values(r.pl).map(q => [f(q.x), f(q.y), Math.round(q.a * 100) / 100, q.name, q.id, q.ci]),
  b: r.balls.map(b => [b.id, f(b.x), f(b.y)]),
  sc: r.score,
});

function snap(r) {
  return {
    p: [f(r.puck.x), f(r.puck.y)],
    pl: r.players.map(q => q && [f(q.x), f(q.y), Math.round(q.a * 100) / 100, q.name]),
    sc: r.score, fr: r.freeze > 0, w: r.winner, m: r.msg, sp: r.spect.length,
  };
}

setInterval(() => {
  for (const [code, r] of rooms) {
    if (r.mode === 'c') { cstep(r, 1 / 60); io.to(code).emit('c', csnap(r)); continue; }
    step(r, 1 / 60);
    io.to(code).emit('s', snap(r));
  }
}, 1000 / 60);

function leaveRoom(sock) {
  const { code, me } = sock.data;
  sock.data = {};
  const r = rooms.get(code);
  if (!r) return;
  sock.leave(code);
  if (r.mode === 'c') { delete r.pl[sock.id]; if (!Object.keys(r.pl).length) rooms.delete(code); return; }
  r.spect = r.spect.filter(x => x.id !== sock.id);
  r.cancelFrom = -1;
  io.to(code).emit('askend');
  if (me) {
    r.players[me.side] = null;
    r.score = [0, 0]; r.winner = -1; r.freeze = 0; r.msg = '';
    reset(r);
    const next = r.spect.shift();
    if (next) {
      r.players[me.side] = newPlayer(next.id, next.name, me.side);
      const ns = io.sockets.sockets.get(next.id);
      if (ns) ns.data.me = r.players[me.side];
      io.to(next.id).emit('joined', { side: me.side, room: code, mode: 'm', id: next.id, fun: r.fun, spd: r.spd });
    }
  }
  if (!r.players[0] && !r.players[1] && !r.spect.length) rooms.delete(code);
}

io.on('connection', sock => {
  sock.on('join', ({ name, room, mode, fun } = {}) => {
    if (sock.data.code) return;
    name = String(name || '').trim().slice(0, 16) || 'Joueur';
    const code = String(room || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 20) || 'salon';
    let r = rooms.get(code);
    if (!r) rooms.set(code, (r = mode === 'c' ? newCRoom(fun) : newRoom(fun)));
    if (r.mode === 'c' && Object.keys(r.pl).length >= 8) return sock.emit('err', 'Salon plein (8 joueurs max)');
    sock.join(code);
    sock.data = { code, me: null };
    if (r.mode === 'c') {
      const pl = newPlayer(sock.id, name, 0);
      pl.ci = r.ci++ % 8;
      r.pl[sock.id] = sock.data.me = pl;
      sock.emit('joined', { side: 0, room: code, mode: 'c', id: sock.id, fun: r.fun, spd: r.spd });
      sock.emit('map', mapOf(r));
      return;
    }
    const side = r.players.indexOf(null);
    if (side >= 0) r.players[side] = sock.data.me = newPlayer(sock.id, name, side);
    else r.spect.push({ id: sock.id, name });
    sock.emit('joined', { side, room: code, mode: 'm', id: sock.id, fun: r.fun, spd: r.spd });
  });

  sock.on('in', d => {
    const me = sock.data.me;
    if (!me || !d) return;
    me.tx = +d.x || 0;
    me.ty = +d.y || 0;
    me.r = clamp(+d.r || 0, -1, 1);
    me.t = !!d.t;
  });

  // Bouton "Retour au lobby" : seul -> on quitte ; avec un adversaire -> demande d'annulation
  sock.on('leave', () => {
    const { code, me } = sock.data;
    const r = rooms.get(code);
    if (!r) return;
    if (r.mode === 'c') { leaveRoom(sock); return sock.emit('left'); }
    const other = me ? r.players[1 - me.side] : null;
    if (other) {
      r.cancelFrom = me.side;
      io.to(other.id).emit('ask', { name: me.name });
      sock.emit('wait');
    } else {
      leaveRoom(sock);
      sock.emit('left');
    }
  });

  sock.on('answer', ok => {
    const { code, me } = sock.data;
    const r = rooms.get(code);
    if (!r || r.mode === 'c' || !me || r.cancelFrom !== 1 - me.side) return;
    const asker = r.players[1 - me.side];
    r.cancelFrom = -1;
    if (!asker) return;
    if (ok) {
      for (const id of [asker.id, sock.id]) {
        const k = io.sockets.sockets.get(id);
        if (k) { leaveRoom(k); k.emit('left'); }
      }
    } else io.to(asker.id).emit('refused');
  });

  // Vitesse de la balle : seulement dans les salons "fun", réglable par tous les joueurs du salon
  sock.on('spd', v => {
    const code = sock.data.code, r = rooms.get(code);
    if (!r || !r.fun) return;
    r.spd = clamp(Math.round((+v || 1) * 10) / 10, 0.5, 3);
    io.to(code).emit('spd', r.spd);
  });

  // ----- édition de la map (mode créatif) -----
  sock.on('add', d => {
    const r = croom(sock); if (!r || !d) return;
    if (d.t === 'b') { if (r.balls.length < 10) r.balls.push(mkBall(r, d.x, d.y)); }
    else if (r.objs.length < 60) { const o = mkObj(r, d); if (o) r.objs.push(o); }
    sendMap(r, sock.data.code);
  });
  sock.on('del', d => {
    const r = croom(sock); if (!r || !d) return;
    r.objs = r.objs.filter(o => o.id !== d.id);
    r.balls = r.balls.filter(b => b.id !== d.id);
    sendMap(r, sock.data.code);
  });
  sock.on('reset', () => {
    const r = croom(sock); if (!r) return;
    for (const b of r.balls) { b.x = b.sx; b.y = b.sy; b.vx = b.vy = 0; }
    r.score = 0;
  });
  sock.on('clear', () => {
    const r = croom(sock); if (!r) return;
    r.objs = []; r.balls = []; r.score = 0;
    sendMap(r, sock.data.code);
  });
  sock.on('load', d => {
    const r = croom(sock); if (!r || !d) return;
    r.objs = (Array.isArray(d.o) ? d.o.slice(0, 60) : []).map(o => mkObj(r, o)).filter(Boolean);
    r.balls = (Array.isArray(d.b) ? d.b.slice(0, 10) : []).map(b => Array.isArray(b) ? mkBall(r, b[0], b[1]) : null).filter(Boolean);
    r.score = 0;
    sendMap(r, sock.data.code);
  });

  sock.on('disconnect', () => leaveRoom(sock));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Hockey en ligne sur le port ' + PORT));

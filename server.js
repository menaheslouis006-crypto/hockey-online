const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

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

const rot = (x, y, a) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const f = n => Math.round(n * 10) / 10;
const reset = r => { r.puck = { x: W / 2, y: H / 2, vx: 0, vy: 0 }; };

function newRoom() {
  const r = { players: [null, null], spect: [], score: [0, 0], freeze: 0, winner: -1, msg: '', cancelFrom: -1 };
  reset(r);
  return r;
}
function newPlayer(id, name, side) {
  const x = side === 0 ? 150 : W - 150;
  return { id, name, side, x, y: H / 2, tx: x, ty: H / 2, a: Math.PI / 2, w: 0, vx: 0, vy: 0, r: 0, t: false };
}

// Collision balle (cercle) <-> barre (rectangle tournant)
function hit(p, pl) {
  const [lx, ly] = rot(p.x - pl.x, p.y - pl.y, -pl.a);
  const cx = clamp(lx, -HW, HW), cy = clamp(ly, -HH, HH);
  let dx = lx - cx, dy = ly - cy, d = Math.hypot(dx, dy);
  if (d >= PR) return;
  if (d < 1e-6) { dx = lx; dy = ly; d = Math.hypot(dx, dy) || 1; }
  const [nx, ny] = rot(dx / d, dy / d, pl.a);          // normale monde
  const [rx, ry] = rot(cx, cy, pl.a);                  // point de contact relatif
  const vx = pl.vx - pl.w * ry, vy = pl.vy + pl.w * rx; // vitesse de la barre au contact (translation + rotation)
  p.x += nx * (PR - d);
  p.y += ny * (PR - d);
  const vn = (p.vx - vx) * nx + (p.vy - vy) * ny;
  if (vn < 0) { p.vx -= (1 + REST) * vn * nx; p.vy -= (1 + REST) * vn * ny; }
  const s = Math.hypot(p.vx, p.vy);
  if (s > MAXV) { p.vx *= MAXV / s; p.vy *= MAXV / s; }
}

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
  const n = 4, s = dt / n;
  const active = r.freeze <= 0 && (r.players[0] || r.players[1]);
  for (let i = 0; i < n; i++) {
    for (const pl of r.players) if (pl) {
      const lo = pl.side === 0 ? 20 : W / 2 + 10, hi = pl.side === 0 ? W / 2 - 10 : W - 20;
      const tx = clamp(pl.tx, lo, hi), ty = clamp(pl.ty, 20, H - 20);
      let dx = tx - pl.x, dy = ty - pl.y;
      const d = Math.hypot(dx, dy), m = 3000 * s;
      if (d > m) { dx *= m / d; dy *= m / d; }
      pl.vx = dx / s; pl.vy = dy / s; pl.x += dx; pl.y += dy;
      pl.w = pl.r * SPIN; pl.a += pl.w * s;
      if (pl.t) { pl.a = Math.PI / 2; pl.w = 0; }
    }
    if (!active) continue;
    const p = r.puck;
    p.x += p.vx * s; p.y += p.vy * s;
    p.vx *= 1 - 0.35 * s; p.vy *= 1 - 0.35 * s;
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

function snap(r) {
  return {
    p: [f(r.puck.x), f(r.puck.y)],
    pl: r.players.map(q => q && [f(q.x), f(q.y), Math.round(q.a * 100) / 100, q.name]),
    sc: r.score, fr: r.freeze > 0, w: r.winner, m: r.msg, sp: r.spect.length,
  };
}

setInterval(() => {
  for (const [code, r] of rooms) {
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
      io.to(next.id).emit('joined', { side: me.side, room: code });
    }
  }
  if (!r.players[0] && !r.players[1] && !r.spect.length) rooms.delete(code);
}

io.on('connection', sock => {
  sock.on('join', ({ name, room } = {}) => {
    if (sock.data.code) return;
    name = String(name || '').trim().slice(0, 16) || 'Joueur';
    const code = String(room || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 20) || 'salon';
    let r = rooms.get(code);
    if (!r) rooms.set(code, (r = newRoom()));
    sock.join(code);
    sock.data = { code, me: null };
    const side = r.players.indexOf(null);
    if (side >= 0) r.players[side] = sock.data.me = newPlayer(sock.id, name, side);
    else r.spect.push({ id: sock.id, name });
    sock.emit('joined', { side, room: code });
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
    if (!r || !me || r.cancelFrom !== 1 - me.side) return;
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

  sock.on('disconnect', () => leaveRoom(sock));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Hockey en ligne sur le port ' + PORT));

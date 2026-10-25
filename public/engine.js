// Moteur de jeu partagé : le serveur (Node) et le navigateur (modes hors ligne) utilisent exactement le même code
(function (root) {
  const HK = typeof module !== 'undefined' && module.exports ? require('./shared.js') : root.HK;

// Terrain et réglages
const W = 1000, H = 600, GOAL = 180, GT = (H - GOAL) / 2, GB = GT + GOAL;
const PR = 14;          // rayon de la balle
const HW = 65, HH = 8;  // demi-longueur / demi-épaisseur de la barre
const WIN = 7, SPIN = 4.5, MAXV = 1600, REST = 0.92;
const BASE = 0.9; // vitesse de balle "normale" (x1.0) : 0.9 = un cran de moins qu'avant
const WL0 = HK.BORDERS.concat(HK.CL0), WL1 = HK.BORDERS.concat(HK.CL1);

const rot = (x, y, a) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const f = n => Math.round(n * 10) / 10;
const reset = r => { r.puck = { x: W / 2, y: H / 2, vx: 0, vy: 0, om: 0, an: 0 }; };
// Physique "fun" : frottement barre/balle (la balle est entraînée par la barre qui glisse) + effet (rotation) qui fait courber la balle
const MU = 0.45, OMAX = 70, MAGNUS = 0.012;
// Nombre de sous-pas : barre (3000 px/s + rotation) + balle au maximum, jamais plus de ~10 px par sous-pas -> plus de traversée, même à bas FPS
const subs = (dt, k) => clamp(Math.ceil(((3300 + MAXV * k) * dt) / 10), 4, 40);

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
function box(p, x, y, a, hw, hh, bvx, bvy, w, e, mu = MU) {
  const [lx, ly] = rot(p.x - x, p.y - y, -a);
  const cx = clamp(lx, -hw, hw), cy = clamp(ly, -hh, hh);
  let dx = lx - cx, dy = ly - cy, d = Math.hypot(dx, dy);
  if (d >= PR) return;
  if (d < 1e-6) { dx = lx; dy = ly; d = Math.hypot(dx, dy) || 1; }
  const [nx, ny] = rot(dx / d, dy / d, a);
  const [rx, ry] = rot(cx, cy, a);
  const vx = bvx - w * ry, vy = bvy + w * rx; // vitesse du point de contact sur la barre (déplacement + rotation)
  p.x += nx * (PR - d);
  p.y += ny * (PR - d);
  const vn = (p.vx - vx) * nx + (p.vy - vy) * ny;
  if (vn < 0) {
    const jn = -(1 + e) * vn;                   // choc (direction normale)
    p.vx += jn * nx; p.vy += jn * ny;
    const tx = -ny, ty = nx;                    // frottement (direction du contact) : entraîne la balle et lui donne de l'effet
    const slip = (p.vx - vx) * tx + (p.vy - vy) * ty - (p.om || 0) * PR;
    const jt = clamp(-slip / 3, -mu * jn, mu * jn);
    p.vx += jt * tx; p.vy += jt * ty;
    p.om = clamp((p.om || 0) - 2 * jt / PR, -OMAX, OMAX);
  }
  const sp = Math.hypot(p.vx, p.vy);
  if (sp > MAXV) { p.vx *= MAXV / sp; p.vy *= MAXV / sp; }
}
// L'effet (rotation) fait courber la trajectoire (effet Magnus) et s'use petit à petit
function spin(p, s, k) {
  const om = p.om || 0, ax = -MAGNUS * om * p.vy, ay = MAGNUS * om * p.vx;
  p.vx += ax * s * k; p.vy += ay * s * k;
  p.om = om * (1 - 0.5 * s * k);
  p.an = (p.an || 0) + om * s * k;
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
  const n = subs(dt, r.spd * BASE), s = dt / n;
  const active = r.freeze <= 0 && (r.players[0] || r.players[1]);
  for (let i = 0; i < n; i++) {
    for (const pl of r.players) if (pl) HK.stepPaddle(pl, pl.tx, pl.ty, pl.r, pl.t, pl.side === 0 ? WL0 : WL1, s, SPIN);
    if (!active) continue;
    const p = r.puck;
    p.x += p.vx * s * r.spd * BASE; p.y += p.vy * s * r.spd * BASE;
    p.vx *= 1 - 0.35 * s * r.spd * BASE; p.vy *= 1 - 0.35 * s * r.spd * BASE;
    spin(p, s, r.spd * BASE);
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
  return { id: r.nid++, x, y, vx: 0, vy: 0, sx: x, sy: y, om: 0, an: 0 };
}
function newCRoom(fun) {
  const r = { mode: 'c', pl: {}, objs: [], balls: [], score: 0, nid: 1, ci: 0, fun: !!fun, spd: 1 };
  for (const d of [{ t: 'm', x: 500, y: 200, s: 30 }, { t: 'm', x: 500, y: 400, s: 30 }, { t: 'w', x: 760, y: 300, a: Math.PI / 2, s: 200 }, { t: 'c', x: 900, y: 300, s: 35 }]) r.objs.push(mkObj(r, d));
  r.balls.push(mkBall(r, 300, 300));
  return r;
}
const mapOf = r => ({ o: r.objs, b: r.balls.map(b => [b.id, b.sx, b.sy]) });

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
  const n = subs(dt, r.spd * BASE), s = dt / n, P = Object.values(r.pl), B = r.balls;
  const wl = HK.BORDERS.concat(r.objs.filter(o => o.t === 'w').map(o => ({ x: o.x, y: o.y, a: o.a, hw: o.s / 2, hh: 8, f: true })));
  for (let i = 0; i < n; i++) {
    for (const pl of P) HK.stepPaddle(pl, pl.tx, pl.ty, pl.r, pl.t, wl, s, SPIN);
    for (const b of B) {
      b.x += b.vx * s * r.spd * BASE; b.y += b.vy * s * r.spd * BASE;
      b.vx *= 1 - 0.25 * s * r.spd * BASE; b.vy *= 1 - 0.25 * s * r.spd * BASE;
      spin(b, s, r.spd * BASE);
      for (const pl of P) hit(b, pl);
      for (const o of r.objs) {
        if (o.t === 'w') box(b, o.x, o.y, o.a, o.s / 2, 8, 0, 0, 0, 0.9, 0.15);
        else if (o.t === 'm') bump(b, o);
        else if (Math.hypot(b.x - o.x, b.y - o.y) < o.s) { r.score++; b.x = b.sx; b.y = b.sy; b.vx = b.vy = 0; b.om = 0; }
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
  b: r.balls.map(b => [b.id, f(b.x), f(b.y), Math.round((b.an || 0) * 100) / 100]),
  sc: r.score,
});

// ================= BOT (1v1 contre l'ordinateur) =================
const BOTS = {
  easy:   { n: 'facile',    v: 380,  noise: 45, pred: false },
  normal: { n: 'normal',    v: 650,  noise: 20, pred: true },
  hard:   { n: 'difficile', v: 1000, noise: 8,  pred: true },
};
function newBot(level) {
  const b = newPlayer('bot', 'Bot ' + BOTS[level].n, 1);
  return Object.assign(b, { bot: BOTS[level], mx: b.x, my: b.y, nx: 0, ny: 0, nt: 0, t: true, r: 0 });
}
const fold = y => { const hh = H - 2 * PR; let q = (y - PR) % (2 * hh); if (q < 0) q += 2 * hh; if (q > hh) q = 2 * hh - q; return q + PR; };
function botThink(r, dt) {
  const b = r.players[1];
  if (!b || !b.bot) return;
  const P = b.bot, p = r.puck, k = r.spd * BASE;
  const vx = p.vx * k, vy = p.vy * k, sp = Math.hypot(vx, vy);
  b.nt -= dt;
  if (b.nt <= 0) { b.nt = 0.4; b.nx = (Math.random() - 0.5) * 2 * P.noise; b.ny = (Math.random() - 0.5) * 2 * P.noise; }
  const home = W - 90;
  let gx, gy;
  if (p.x > W / 2 - 30 && (sp < 350 || Math.hypot(b.x - p.x, b.y - p.y) < 170)) {
    // attaque : se place derrière la balle puis la pousse vers le but adverse (à gauche)
    if (b.x < p.x + 25) { gx = p.x + 70; gy = p.y + (p.y < H / 2 ? 70 : -70); }
    else { gx = p.x - 25; gy = p.y; }
  } else {
    // défense : reste devant son but, anticipe la trajectoire (rebonds compris) selon le niveau
    gy = P.pred && vx > 5 ? fold(p.y + vy * ((home - p.x) / vx)) : H / 2 + (p.y - H / 2) * 0.5;
    gx = home; gy = clamp(gy, GT - 40, GB + 40);
  }
  gx += b.nx; gy += b.ny;
  let dx = gx - b.mx, dy = gy - b.my;
  const d = Math.hypot(dx, dy), m = P.v * dt;
  if (d > m) { dx *= m / d; dy *= m / d; }
  b.mx += dx; b.my += dy;
  const lag = Math.hypot(b.mx - b.x, b.my - b.y);
  if (lag > 120) { b.mx = b.x + (b.mx - b.x) * 120 / lag; b.my = b.y + (b.my - b.y) * 120 / lag; }
  b.tx = b.mx; b.ty = b.my;
}

function snap(r) {
  return {
    p: [f(r.puck.x), f(r.puck.y), Math.round((r.puck.an || 0) * 100) / 100],
    pl: r.players.map(q => q && [f(q.x), f(q.y), Math.round(q.a * 100) / 100, q.name]),
    sc: r.score, fr: r.freeze > 0, w: r.winner, m: r.msg, sp: r.spect.length, bt: r.botRoom ? 1 : 0,
  };
}


// Édition de la map (mode créatif) : renvoie true si la map a changé
function edit(r, ev, d) {
  if (ev === 'add' && d) {
    if (d.t === 'b') { if (r.balls.length < 10) r.balls.push(mkBall(r, d.x, d.y)); }
    else if (r.objs.length < 60) { const o = mkObj(r, d); if (o) r.objs.push(o); }
    return true;
  }
  if (ev === 'del' && d) {
    r.objs = r.objs.filter(o => o.id !== d.id);
    r.balls = r.balls.filter(b => b.id !== d.id);
    return true;
  }
  if (ev === 'reset') {
    for (const b of r.balls) { b.x = b.sx; b.y = b.sy; b.vx = b.vy = 0; b.om = 0; }
    r.score = 0;
    return false;
  }
  if (ev === 'clear') { r.objs = []; r.balls = []; r.score = 0; return true; }
  if (ev === 'load' && d) {
    r.objs = (Array.isArray(d.o) ? d.o.slice(0, 60) : []).map(o => mkObj(r, o)).filter(Boolean);
    r.balls = (Array.isArray(d.b) ? d.b.slice(0, 10) : []).map(b => Array.isArray(b) ? mkBall(r, b[0], b[1]) : null).filter(Boolean);
    r.score = 0;
    return true;
  }
  return false;
}

  const api = { W, H, clamp, reset, newRoom, newPlayer, step, snap, newCRoom, cstep, csnap, mapOf, mkObj, mkBall, edit, BOTS, newBot, botThink };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.EN = api;
})(typeof window !== 'undefined' ? window : this);

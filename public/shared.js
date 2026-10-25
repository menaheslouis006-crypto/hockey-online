// Physique de la barre partagée par le serveur (Node) et le navigateur : même code des deux côtés
(function (root) {
  const W = 1000, H = 600, HW = 65, HH = 8;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const wrapPi2 = a => Math.atan2(Math.sin(2 * a), Math.cos(2 * a)) / 2; // ramène un angle dans (-90°, 90°]

  // Murs invisibles : les 4 bords du terrain, et la ligne du milieu (mode match)
  const BORDERS = [
    { x: W / 2, y: -60, a: 0, hw: W, hh: 60 }, { x: W / 2, y: H + 60, a: 0, hw: W, hh: 60 },
    { x: -60, y: H / 2, a: 0, hw: 60, hh: H }, { x: W + 60, y: H / 2, a: 0, hw: 60, hh: H },
  ];
  const CL0 = { x: W / 2 + 60, y: H / 2, a: 0, hw: 60, hh: H }; // le joueur de gauche ne passe pas le milieu
  const CL1 = { x: W / 2 - 60, y: H / 2, a: 0, hw: 60, hh: H }; // celui de droite non plus

  // Collision entre deux boîtes tournantes (SAT). Renvoie {nx, ny, d} : direction de B vers A et profondeur
  function sat(A, B) {
    const ax = [Math.cos(A.a), Math.sin(A.a)], ay = [-Math.sin(A.a), Math.cos(A.a)];
    const bx = [Math.cos(B.a), Math.sin(B.a)], by = [-Math.sin(B.a), Math.cos(B.a)];
    const rad = (o, u, v, x, y) => o.hw * Math.abs(x * u[0] + y * u[1]) + o.hh * Math.abs(x * v[0] + y * v[1]);
    let best = null;
    for (const [x, y] of [ax, ay, bx, by]) {
      const dist = (A.x - B.x) * x + (A.y - B.y) * y;
      const ov = rad(A, ax, ay, x, y) + rad(B, bx, by, x, y) - Math.abs(dist);
      if (ov <= 0) return null;
      if (!best || ov < best.d) best = { nx: dist < 0 ? -x : x, ny: dist < 0 ? -y : y, d: ov };
    }
    return best;
  }

  // Un pas de simulation de la barre : suit la souris, tourne, ne traverse pas les murs.
  // Si on force fort contre un mur de la map (wb.f), elle glisse sur le côté et se remet à plat.
  function stepPaddle(pl, tx, ty, rdir, reset, wl, s, spin) {
    tx = clamp(tx, 0, W); ty = clamp(ty, 0, H);
    const ox = pl.x, oy = pl.y;
    let dx = tx - pl.x, dy = ty - pl.y;
    const d = Math.hypot(dx, dy), m = 3000 * s;
    if (d > m) { dx *= m / d; dy *= m / d; }
    pl.x += dx; pl.y += dy;
    pl.w = rdir * spin; pl.a += pl.w * s;
    if (reset) { pl.a = Math.PI / 2; pl.w = 0; }
    let forced = null;
    for (const wb of wl) {
      const c = sat({ x: pl.x, y: pl.y, a: pl.a, hw: HW, hh: HH }, wb);
      if (!c) continue;
      pl.x += c.nx * c.d; pl.y += c.ny * c.d;
      if (wb.f) {
        const pen = -((tx - pl.x) * c.nx + (ty - pl.y) * c.ny); // de combien la souris est "derrière" le mur
        if (pen > 4 && (!forced || pen > forced.pen)) forced = { nx: c.nx, ny: c.ny, pen };
      }
    }
    if (forced) {
      const k = Math.min(1, (forced.pen - 4) / 20);
      const tvx = -forced.ny, tvy = forced.nx;
      const tt = (tx - pl.x) * tvx + (ty - pl.y) * tvy;
      const rel = wrapPi2(pl.a - Math.atan2(tvy, tvx));
      const dir = Math.abs(tt) > 6 ? Math.sign(tt) : (Math.sign(rel) || 1);
      pl.x += tvx * dir * 380 * k * s; pl.y += tvy * dir * 380 * k * s;
      if (!rdir && !reset) pl.a -= rel * Math.min(1, 8 * k * s);
    }
    pl.vx = (pl.x - ox) / s; pl.vy = (pl.y - oy) / s;
  }

  const api = { BORDERS, CL0, CL1, sat, stepPaddle };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.HK = api;
})(typeof window !== 'undefined' ? window : this);

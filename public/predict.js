// Prédiction de la balle en ligne : la balle réagit tout de suite à TA barre (calculée sur ton PC avec le même moteur
// que le serveur), puis le serveur la recale en douceur. Sans ça, tu vois la balle avec le retard du réseau.
(function (root) {
  function create(EN, g) {
    // g : { mode(), me(), myId(), side(), map(), speed() }
    const st = { b: new Map(), grace: 0, opp: {}, pls: [], rtt: 0 };
    const lerp = (a, b, k) => a + (b - a) * k;
    const angDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
    const kNow = () => g.speed() * EN.BASE;
    const oneWay = () => Math.max(0.01, Math.min(0.25, (st.rtt || 0.08) / 2));

    function track(key, q, dt) { // vitesse d'une barre adverse, déduite de ses positions successives
      const t = st.opp[key] || (st.opp[key] = { x: q[0], y: q[1], a: q[2], vx: 0, vy: 0, w: 0 });
      if (dt > 0) {
        t.vx += ((q[0] - t.x) / dt - t.vx) * 0.5; t.vy += ((q[1] - t.y) / dt - t.vy) * 0.5;
        t.w += (angDiff(t.a, q[2]) / dt - t.w) * 0.5;
      }
      t.x = q[0]; t.y = q[1]; t.a = q[2];
      return t;
    }
    function paddles(S, dt) { // la mienne (locale, sans délai) + les autres (dernières positions connues)
      const me = g.me(), out = [];
      if (!S || !me) return out;
      if (g.mode() === 'c') S.pl.forEach(q => out.push(q[4] === g.myId() ? me : track(q[4], q, dt)));
      else S.pl.forEach((q, i) => { if (q) out.push(i === g.side() ? me : track('s' + i, q, dt)); });
      return out;
    }
    function sim(balls, dt, pls) {
      const k = kNow(), map = g.map();
      while (dt > 1e-4) {
        const d = Math.min(dt, 1 / 60), n = EN.subs(d, k), s = d / n; dt -= d;
        for (let i = 0; i < n; i++) {
          if (g.mode() === 'c') EN.ballsSub({ objs: map.o, balls, score: 0 }, pls, s, k);
          else {
            const p = balls[0];
            EN.puckSub(p, pls, s, k);
            if (p.x < -30 || p.x > EN.W + 30) { p.x = Math.max(-30, Math.min(EN.W + 30, p.x)); p.vx = 0; } // dans le but : on attend le serveur
          }
        }
      }
    }
    function spawn(f) { const m = g.map().b.find(b => b[0] === f.id); return Object.assign({}, f, { sx: m ? m[1] : f.x, sy: m ? m[2] : f.y }); }

    // appelé à chaque image affichée
    function frame(S0, dt) {
      const me = g.me();
      if (!me || !S0 || !st.b.size) return;
      st.pls = paddles(S0, dt);
      const fade = Math.exp(-dt / 0.09);
      for (const b of st.b.values()) if (b.ox || b.oy) { b.ox *= fade; b.oy *= fade; }
      const balls = [...st.b.values()], before = balls.map(b => [b.vx, b.vy]);
      sim(balls, dt, st.pls);
      balls.forEach((b, i) => { // si je viens de taper la balle, le serveur ne le sait pas encore : on ignore ses corrections un instant
        if (Math.hypot(b.vx - before[i][0], b.vy - before[i][1]) > 300 && Math.hypot(b.x - me.x, b.y - me.y) < EN.HW + EN.PR + 14) st.grace = performance.now() + (st.rtt || 0.08) * 1000 + 160;
      });
    }

    // appelé à chaque message du serveur
    function reconcile(s) {
      if (!g.me()) return;
      const mc = g.mode() === 'c';
      const fresh = mc ? s.b.map(b => ({ id: b[0], x: b[1], y: b[2], an: b[3], vx: b[4], vy: b[5], om: b[6] }))
                       : [{ id: 'p', x: s.p[0], y: s.p[1], an: s.p[2], vx: s.p[3], vy: s.p[4], om: s.p[5] }];
      if (fresh.some(f => typeof f.vx !== 'number')) return;      // serveur plus ancien : pas de prédiction
      const hold = !mc && s.fr, alive = new Set(), now = performance.now();
      for (const f of fresh) {
        alive.add(f.id);
        const old = st.b.get(f.id);
        if (!old || hold) { st.b.set(f.id, spawn(f)); continue; }
        const est = spawn(f); sim([est], oneWay(), st.pls);      // où est la balle "maintenant" selon le serveur
        const err = Math.hypot(est.x - old.x, est.y - old.y);
        if (err > 140) { // gros écart : on se recale sur le serveur, mais l'affichage glisse vers la bonne place au lieu de sauter (sauf but ou remise au centre)
          if (err < 320) { est.ox = old.x + (old.ox || 0) - est.x; est.oy = old.y + (old.oy || 0) - est.y; }
          st.b.set(f.id, est); continue;
        }
        if (now < st.grace) continue;
        for (const key of ['x', 'y', 'vx', 'vy', 'om', 'an']) old[key] = lerp(old[key], est[key], 0.22);
      }
      for (const id of [...st.b.keys()]) if (!alive.has(id)) st.b.delete(id);
    }

    function overlay(S) { // remplace la balle du serveur par la balle prédite
      if (!S || !g.me() || !st.b.size) return S;
      if (g.mode() === 'c') return Object.assign({}, S, { b: [...st.b.values()].map(b => [b.id, b.x + (b.ox || 0), b.y + (b.oy || 0), b.an]) });
      const p = st.b.get('p');
      return p ? Object.assign({}, S, { p: [p.x + (p.ox || 0), p.y + (p.oy || 0), p.an] }) : S;
    }
    function reset() { st.b.clear(); st.opp = {}; st.pls = []; st.grace = 0; }
    function setRtt(v) { st.rtt = st.rtt ? st.rtt * 0.8 + v * 0.2 : v; }
    return { frame, reconcile, overlay, reset, setRtt, state: st };
  }
  const api = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PRED = api;
})(typeof window !== 'undefined' ? window : this);

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const EN = require('./public/engine.js'); // toute la physique est dans public/engine.js (partagée avec le navigateur)
const { W, H, clamp, reset, newRoom, newPlayer, step, snap, newCRoom, cstep, csnap, mapOf, mkObj, mkBall, BOTS, newBot, botThink } = EN;

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static('public'));
app.get('/health', (_, res) => res.send('ok'));

const rooms = new Map();
const sendMap = (r, code) => io.to(code).emit('map', mapOf(r));
const croom = sock => { const r = rooms.get(sock.data.code); return r && r.mode === 'c' ? r : null; };

setInterval(() => {
  for (const [code, r] of rooms) {
    if (r.mode === 'c') { cstep(r, 1 / 60); io.to(code).emit('c', csnap(r)); continue; }
    if (r.botRoom) botThink(r, 1 / 60);
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
  if (r.botRoom) { rooms.delete(code); return; }
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
  sock.on('join', ({ name, room, mode, fun, bot } = {}) => {
    if (sock.data.code) return;
    name = String(name || '').trim().slice(0, 16) || 'Joueur';
    let code = String(room || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 20) || 'salon';
    const vsBot = mode !== 'c' && BOTS[bot];
    if (vsBot) code = 'bot-' + sock.id; // salon privé : toi contre le bot
    let r = rooms.get(code);
    if (!r) {
      r = mode === 'c' ? newCRoom(fun) : newRoom(fun);
      if (vsBot) { r.botRoom = true; r.players[1] = newBot(bot); }
      rooms.set(code, r);
    }
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
    if (other && !other.bot) {
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

  // ----- édition de la map (mode créatif) : la logique est dans le moteur partagé -----
  for (const ev of ['add', 'del', 'reset', 'clear', 'load']) {
    sock.on(ev, d => { const r = croom(sock); if (r && EN.edit(r, ev, d)) sendMap(r, sock.data.code); });
  }

  sock.on('disconnect', () => leaveRoom(sock));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Hockey en ligne sur le port ' + PORT));

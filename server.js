const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();
const TICK_RATE = 60;
const TICK_MS = 1000 / TICK_RATE;

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return rooms.has(code) ? generateRoomCode() : code;
}

function defaultSettings() {
  return {
    mapId: 'lava_bridge',
    randomWeapon: false,
    modifiers: {
      giantWeapon: false,
      rapidCooldown: false,
      tinyStickman: false
    }
  };
}

io.on('connection', (socket) => {
  socket.on('create_room', ({ name, color, weaponId, settings }) => {
    const code = generateRoomCode();
    const room = {
      code,
      hostId: socket.id,
      state: 'lobby', // 'lobby' | 'playing'
      settings: { ...defaultSettings(), ...(settings || {}), modifiers: { ...defaultSettings().modifiers, ...((settings && settings.modifiers) || {}) } },
      players: new Map()
    };

    room.players.set(socket.id, {
      id: socket.id,
      name: (name || 'Player 1').slice(0, 14),
      color: color || '#38bdf8',
      weaponId: weaponId || 0,
      score: 0,
      alive: true,
      input: { moveX: 0, moveY: 0, aimX: 1, aimY: 0, shield: false },
      netState: null
    });

    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit('room_joined', serializeRoom(room));
  });

  socket.on('join_room', ({ code, name, color, weaponId }) => {
    const cleanCode = (code || '').trim().toUpperCase();
    const room = rooms.get(cleanCode);
    if (!room) {
      socket.emit('room_error', 'Không tìm thấy phòng với mã này!');
      return;
    }
    if (room.players.size >= 4) {
      socket.emit('room_error', 'Phòng đã đủ 4 người chơi!');
      return;
    }

    room.players.set(socket.id, {
      id: socket.id,
      name: (name || `Player ${room.players.size + 1}`).slice(0, 14),
      color: color || '#f472b6',
      weaponId: weaponId || 0,
      score: 0,
      alive: true,
      input: { moveX: 0, moveY: 0, aimX: -1, aimY: 0, shield: false },
      netState: null
    });

    socket.join(cleanCode);
    socket.data.roomCode = cleanCode;
    io.to(cleanCode).emit('room_updated', serializeRoom(room));
    socket.emit('room_joined', serializeRoom(room));
  });

  socket.on('update_player_lobby', ({ color, weaponId, name }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    if (color) p.color = color;
    if (typeof weaponId === 'number') p.weaponId = weaponId;
    if (name) p.name = name.slice(0, 14);
    io.to(room.code).emit('room_updated', serializeRoom(room));
  });

  socket.on('update_room_settings', (newSettings) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) return;
    room.settings = {
      ...room.settings,
      ...newSettings,
      modifiers: {
        ...room.settings.modifiers,
        ...((newSettings && newSettings.modifiers) || {})
      }
    };
    io.to(room.code).emit('room_updated', serializeRoom(room));
  });

  socket.on('start_match', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) return;
    room.state = 'playing';
    room.players.forEach((p) => {
      p.alive = true;
    });
    io.to(room.code).emit('match_started', serializeRoom(room));
  });

  socket.on('player_input', (payload) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.state !== 'playing') return;
    const p = room.players.get(socket.id);
    if (!p) return;
    p.input = payload.input || p.input;
    if (payload.netState) {
      p.netState = payload.netState;
    }
  });

  socket.on('skill_cast', (skillData) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.state !== 'playing') return;
    socket.to(room.code).emit('remote_skill_cast', {
      casterId: socket.id,
      ...skillData
    });
  });

  socket.on('player_ko', ({ victimId, killerId, newRandomWeapon }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const killer = room.players.get(killerId);
    const victim = room.players.get(victimId);
    if (killer && killerId !== victimId) {
      killer.score += 1;
      if (room.settings.randomWeapon && typeof newRandomWeapon === 'number') {
        killer.weaponId = newRandomWeapon;
      }
    }
    if (victim && room.settings.randomWeapon) {
      victim.weaponId = Math.floor(Math.random() * 20);
    }
    io.to(room.code).emit('ko_event', {
      victimId,
      killerId,
      scores: Array.from(room.players.values()).map((pl) => ({
        id: pl.id,
        score: pl.score,
        weaponId: pl.weaponId
      }))
    });
  });

  socket.on('leave_room', () => handleLeave(socket));
  socket.on('disconnect', () => handleLeave(socket));
});

function handleLeave(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  if (!room) return;

  room.players.delete(socket.id);
  socket.leave(code);
  socket.data.roomCode = null;

  if (room.players.size === 0) {
    rooms.delete(code);
    return;
  }

  if (room.hostId === socket.id) {
    room.hostId = room.players.keys().next().value;
  }
  io.to(code).emit('room_updated', serializeRoom(room));
}

function serializeRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    state: room.state,
    settings: room.settings,
    players: Array.from(room.players.values()).map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      weaponId: p.weaponId,
      score: p.score,
      alive: p.alive
    }))
  };
}

setInterval(() => {
  rooms.forEach((room) => {
    if (room.state !== 'playing') return;
    const snapshot = [];
    room.players.forEach((p) => {
      if (p.netState) {
        snapshot.push({
          id: p.id,
          color: p.color,
          weaponId: p.weaponId,
          score: p.score,
          ...p.netState
        });
      }
    });
    io.to(room.code).volatile.emit('world_snapshot', {
      t: Date.now(),
      players: snapshot
    });
  });
}, TICK_MS);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Binlight Stickman Duel server running on http://localhost:${PORT}`);
});
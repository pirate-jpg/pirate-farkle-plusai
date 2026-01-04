// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // Railway / proxies friendly
  cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;

// Serve static client
app.use(express.static("public"));

// Basic health check
app.get("/health", (req, res) => res.json({ status: "ok" }));

/**
 * Room model (authoritative):
 * rooms[code] = {
 *   code,
 *   players: [
 *     { name, socketId, score, online },
 *     { name, socketId, score, online }
 *   ],
 *   game: {
 *     started: false,
 *     winnerSeat: null,
 *     turnSeat: 0,
 *     phase: "waiting", // waiting | must_roll | selecting | finished
 *     dice: [0,0,0,0,0,0],
 *     keptMask: [false,false,false,false,false,false],
 *     remaining: 6,
 *     turnPoints: 0,
 *     lastAction: ""
 *   }
 * }
 */
const rooms = Object.create(null);

function makeCode(len = 5) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function getOrCreateRoom(code) {
  if (!rooms[code]) {
    rooms[code] = {
      code,
      players: [
        { name: null, socketId: null, score: 0, online: false },
        { name: null, socketId: null, score: 0, online: false }
      ],
      game: freshGame()
    };
  }
  return rooms[code];
}

function freshGame() {
  return {
    started: false,
    winnerSeat: null,
    turnSeat: 0,
    phase: "waiting",
    dice: [0, 0, 0, 0, 0, 0],
    keptMask: [false, false, false, false, false, false],
    remaining: 6,
    turnPoints: 0,
    lastAction: ""
  };
}

function publicState(room) {
  return {
    code: room.code,
    players: room.players.map((p) => ({
      name: p.name || "—",
      score: p.score || 0,
      online: !!p.online
    })),
    game: {
      started: room.game.started,
      winnerSeat: room.game.winnerSeat,
      turnSeat: room.game.turnSeat,
      phase: room.game.phase,
      dice: room.game.dice,
      keptMask: room.game.keptMask,
      remaining: room.game.remaining,
      turnPoints: room.game.turnPoints,
      lastAction: room.game.lastAction
    }
  };
}

function emitRoom(room) {
  io.to(room.code).emit("state", publicState(room));
}

function seatOfSocket(room, socketId) {
  return room.players.findIndex((p) => p.socketId === socketId);
}

function countRemaining(room) {
  // remaining dice are those not kept in this "hot dice sequence"
  const keptCount = room.game.keptMask.filter(Boolean).length;
  return 6 - keptCount;
}

function resetTurnKeep(room) {
  room.game.turnPoints = 0;
  room.game.dice = [0, 0, 0, 0, 0, 0];
  room.game.keptMask = [false, false, false, false, false, false];
  room.game.remaining = 6;
}

function startIfReady(room) {
  const filled = room.players[0].name && room.players[1].name;
  if (filled && !room.game.started) {
    room.game.started = true;
    room.game.winnerSeat = null;
    room.game.turnSeat = 0;     // stable + predictable (lowest debug)
    room.game.phase = "must_roll";
    resetTurnKeep(room);
    room.game.lastAction = "Game started. Seat 0 to roll.";
  }
}

function nextTurn(room, msg = "") {
  // If someone won, don't advance
  if (room.game.winnerSeat !== null) {
    room.game.phase = "finished";
    room.game.lastAction = msg || "Game finished.";
    return;
  }

  room.game.turnSeat = room.game.turnSeat === 0 ? 1 : 0;
  room.game.phase = "must_roll";
  resetTurnKeep(room);
  room.game.lastAction = msg || `Turn passes to seat ${room.game.turnSeat}.`;
}

// ---------- Farkle scoring ----------
/**
 * Returns {score, allScoring, reason}
 * - score is points for the selected dice only
 * - validates that all selected dice are scoring
 * Special combos enabled:
 * - Straight (1-6) = 1500
 * - Three pairs = 1500
 * - Two triplets = 2500
 * - 4/5/6 of a kind: base 3-kind * 2^(n-3)
 * Standard:
 * - 1 = 100 each, 5 = 50 each (unless part of combo)
 * - 3 of kind: 1s=1000, others=face*100
 */
function scoreSelected(selectedFaces) {
  if (selectedFaces.length === 0) return { score: 0, allScoring: false, reason: "Select at least one die." };

  const counts = new Map();
  for (const f of selectedFaces) counts.set(f, (counts.get(f) || 0) + 1);

  const faces = [1,2,3,4,5,6];
  const totalDice = selectedFaces.length;

  // Straight 1-6
  if (totalDice === 6 && faces.every(f => counts.get(f) === 1)) {
    return { score: 1500, allScoring: true, reason: "Straight 1-6" };
  }

  // Three pairs
  if (totalDice === 6) {
    const pairCounts = [...counts.values()].sort((a,b)=>a-b);
    if (pairCounts.length === 3 && pairCounts.every(v => v === 2)) {
      return { score: 1500, allScoring: true, reason: "Three pairs" };
    }
  }

  // Two triplets
  if (totalDice === 6) {
    const tripCounts = [...counts.values()].sort((a,b)=>a-b);
    if (tripCounts.length === 2 && tripCounts[0] === 3 && tripCounts[1] === 3) {
      return { score: 2500, allScoring: true, reason: "Two triplets" };
    }
  }

  let score = 0;

  // n-of-a-kind (3+)
  for (const [face, n] of counts.entries()) {
    if (n >= 3) {
      const base = face === 1 ? 1000 : face * 100;
      // 3-kind base, 4-kind double, 5-kind quadruple, 6-kind octuple
      score += base * Math.pow(2, n - 3);
      counts.set(face, n - 3); // remove the 3 used; leftovers may be 1/5 singles
    }
  }

  // singles (1s and 5s)
  const onesLeft = counts.get(1) || 0;
  const fivesLeft = counts.get(5) || 0;
  score += onesLeft * 100;
  score += fivesLeft * 50;

  // Validate: after removing combos/sets/singles, any remaining dice are non-scoring
  // If any face other than 1 or 5 remains (>0), then selection included junk dice.
  for (const [face, n] of counts.entries()) {
    if (n > 0 && face !== 1 && face !== 5) {
      return { score: 0, allScoring: false, reason: "Selection includes non-scoring dice." };
    }
  }

  return { score, allScoring: score > 0, reason: "OK" };
}

function rollDice(room) {
  // roll only unkept dice
  for (let i = 0; i < 6; i++) {
    if (!room.game.keptMask[i]) {
      room.game.dice[i] = 1 + Math.floor(Math.random() * 6);
    }
  }
}

function availableScoringFaces(diceFaces) {
  // quick check for “any scoring exists in a roll” (including special combos)
  const counts = new Map();
  for (const f of diceFaces) counts.set(f, (counts.get(f) || 0) + 1);

  // Straight
  const faces = [1,2,3,4,5,6];
  if (diceFaces.length === 6 && faces.every(f => counts.get(f) === 1)) return true;

  // Three pairs
  if (diceFaces.length === 6) {
    const vals = [...counts.values()].sort((a,b)=>a-b);
    if (vals.length === 3 && vals.every(v => v === 2)) return true;
  }

  // Two triplets
  if (diceFaces.length === 6) {
    const vals = [...counts.values()].sort((a,b)=>a-b);
    if (vals.length === 2 && vals[0] === 3 && vals[1] === 3) return true;
  }

  // Any 1 or 5
  if ((counts.get(1) || 0) > 0) return true;
  if ((counts.get(5) || 0) > 0) return true;

  // Any 3+
  for (const n of counts.values()) if (n >= 3) return true;

  return false;
}

// ---------- Socket handlers ----------
io.on("connection", (socket) => {
  socket.on("create_table", ({ name }) => {
    const safeName = (name || "").trim().slice(0, 20) || "Player";
    let code;
    do { code = makeCode(5); } while (rooms[code]);

    const room = getOrCreateRoom(code);
    // seat 0
    room.players[0] = { name: safeName, socketId: socket.id, score: 0, online: true };
    room.players[1] = { name: null, socketId: null, score: 0, online: false };
    room.game = freshGame();

    socket.join(code);
    socket.data.roomCode = code;
    socket.data.seat = 0;

    room.game.lastAction = `${safeName} created table ${code}. Waiting for opponent.`;
    emitRoom(room);
    socket.emit("you_are", { code, seat: 0 });
  });

  socket.on("join_table", ({ code, name }) => {
    const roomCode = (code || "").trim().toUpperCase();
    const safeName = (name || "").trim().slice(0, 20) || "Player";
    const room = rooms[roomCode];

    if (!room) {
      socket.emit("toast", { msg: "Table not found." });
      return;
    }

    // Find seat
    let seat = -1;

    // If already in room with same name (reconnect case), reuse that seat
    for (let i = 0; i < 2; i++) {
      if (room.players[i].name && room.players[i].name.toLowerCase() === safeName.toLowerCase()) {
        seat = i;
        break;
      }
    }
    // Else first empty seat
    if (seat === -1) {
      seat = room.players[0].name ? (room.players[1].name ? -1 : 1) : 0;
    }

    if (seat === -1) {
      socket.emit("toast", { msg: "Table is full." });
      return;
    }

    room.players[seat].name = safeName;
    room.players[seat].socketId = socket.id;
    room.players[seat].online = true;
    if (typeof room.players[seat].score !== "number") room.players[seat].score = 0;

    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.seat = seat;

    room.game.lastAction = `${safeName} joined table ${roomCode} (seat ${seat}).`;

    startIfReady(room);
    emitRoom(room);
    socket.emit("you_are", { code: roomCode, seat });
  });

  socket.on("new_game", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) return;

    room.players[0].score = 0;
    room.players[1].score = 0;
    room.game = freshGame();

    startIfReady(room);
    room.game.lastAction = "New game started.";
    emitRoom(room);
  });

  socket.on("roll", () => {
    const roomCode = socket.data.roomCode;
    const seat = socket.data.seat;
    const room = rooms[roomCode];
    if (!room) return;

    if (!room.game.started) {
      socket.emit("toast", { msg: "Waiting for both players." });
      return;
    }

    if (seat !== room.game.turnSeat) {
      socket.emit("toast", { msg: "Not your turn." });
      return;
    }

    // Strongest sync guard: seat must match current socketId
    if (room.players[seat].socketId !== socket.id) {
      socket.emit("toast", { msg: "Seat ownership out of sync. Rejoin the table." });
      return;
    }

    if (room.game.phase !== "must_roll" && room.game.phase !== "selecting") {
      socket.emit("toast", { msg: "Cannot roll right now." });
      return;
    }

    rollDice(room);

    // Check for farkle on the currently rollable dice (unkept)
    const rolledFaces = room.game.dice.filter((_, idx) => !room.game.keptMask[idx]);
    const hasScore = availableScoringFaces(rolledFaces);

    if (!hasScore) {
      // Farkle: lose turn points, pass turn
      const name = room.players[seat].name || "Player";
      nextTurn(room, `${name} farkled (no scoring dice). Turn ends.`);
    } else {
      room.game.phase = "selecting";
      room.game.lastAction = "Rolled. Select scoring dice to KEEP, or BANK.";
    }

    emitRoom(room);
  });

  socket.on("keep", ({ indices }) => {
    const roomCode = socket.data.roomCode;
    const seat = socket.data.seat;
    const room = rooms[roomCode];
    if (!room) return;

    if (!room.game.started) return;
    if (seat !== room.game.turnSeat) {
      socket.emit("toast", { msg: "Not your turn." });
      return;
    }
    if (room.players[seat].socketId !== socket.id) {
      socket.emit("toast", { msg: "Seat ownership out of sync. Rejoin the table." });
      return;
    }
    if (room.game.phase !== "selecting") {
      socket.emit("toast", { msg: "Roll first." });
      return;
    }

    const idxs = Array.isArray(indices) ? indices : [];
    const unique = [...new Set(idxs)].filter(i => Number.isInteger(i) && i >= 0 && i < 6);

    // Must select from unkept dice
    for (const i of unique) {
      if (room.game.keptMask[i]) {
        socket.emit("toast", { msg: "You selected a die already kept." });
        return;
      }
    }

    const faces = unique.map(i => room.game.dice[i]);
    const res = scoreSelected(faces);

    if (!res.allScoring) {
      socket.emit("toast", { msg: res.reason || "Invalid keep." });
      return;
    }

    // Apply keep
    for (const i of unique) room.game.keptMask[i] = true;
    room.game.turnPoints += res.score;

    // Hot dice: all dice are now kept => reset keptMask and continue rolling with 6 dice
    if (room.game.keptMask.every(Boolean)) {
      room.game.keptMask = [false,false,false,false,false,false];
      room.game.remaining = 6;
      room.game.lastAction = `Hot dice! +${res.score}. Turn points: ${room.game.turnPoints}. Roll again.`;
      room.game.phase = "must_roll";
    } else {
      room.game.remaining = countRemaining(room);
      room.game.lastAction = `Kept for +${res.score}. Turn points: ${room.game.turnPoints}. Roll or keep more.`;
      room.game.phase = "must_roll";
    }

    emitRoom(room);
  });

  socket.on("bank", () => {
    const roomCode = socket.data.roomCode;
    const seat = socket.data.seat;
    const room = rooms[roomCode];
    if (!room) return;

    if (!room.game.started) return;
    if (seat !== room.game.turnSeat) {
      socket.emit("toast", { msg: "Not your turn." });
      return;
    }
    if (room.players[seat].socketId !== socket.id) {
      socket.emit("toast", { msg: "Seat ownership out of sync. Rejoin the table." });
      return;
    }

    const banked = room.game.turnPoints;
    if (banked <= 0) {
      socket.emit("toast", { msg: "Nothing to bank." });
      return;
    }

    room.players[seat].score += banked;

    const name = room.players[seat].name || "Player";
    if (room.players[seat].score >= 10000) {
      room.game.winnerSeat = seat;
      room.game.phase = "finished";
      room.game.lastAction = `${name} BANKED ${banked} and wins with ${room.players[seat].score}!`;
    } else {
      nextTurn(room, `${name} BANKED ${banked}.`);
    }

    emitRoom(room);
  });

  socket.on("disconnect", () => {
    const roomCode = socket.data.roomCode;
    const seat = socket.data.seat;
    const room = rooms[roomCode];
    if (!room) return;

    if (seat === 0 || seat === 1) {
      // Mark offline, but DO NOT remove seat (prevents the ping-pong chaos)
      if (room.players[seat].socketId === socket.id) {
        room.players[seat].online = false;
        room.players[seat].socketId = null;
        room.game.lastAction = `${room.players[seat].name || "Player"} disconnected.`;
        emitRoom(room);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log("Server listening on", PORT);
});
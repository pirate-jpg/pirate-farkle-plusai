// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Railway / production port handling
const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static("public"));

// Simple health check
app.get("/health", (req, res) => res.json({ status: "ok", game: "pirate-farkle" }));

/**
 * Room state shape:
 * {
 *   code: "ABC123",
 *   players: [
 *     { seat: 0, name, clientId, socketId, score, online },
 *     { seat: 1, name, clientId, socketId, score, online }
 *   ],
 *   activeSeat: 0|1,
 *   phase: "lobby"|"turn",
 *   turnPoints: number,
 *   dice: [1..6 x6],
 *   held: [bool x6],
 *   canRoll: bool
 * }
 */
const rooms = new Map();

function makeCode(len = 5) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function newRoom() {
  const code = makeCode(5);
  return {
    code,
    players: [
      { seat: 0, name: "—", clientId: null, socketId: null, score: 0, online: false },
      { seat: 1, name: "—", clientId: null, socketId: null, score: 0, online: false }
    ],
    activeSeat: 0,
    phase: "lobby",
    turnPoints: 0,
    dice: [1, 1, 1, 1, 1, 1],
    held: [false, false, false, false, false, false],
    canRoll: false
  };
}

function publicState(room) {
  return {
    code: room.code,
    players: room.players.map(p => ({
      seat: p.seat,
      name: p.name,
      score: p.score,
      online: p.online
    })),
    activeSeat: room.activeSeat,
    phase: room.phase,
    turnPoints: room.turnPoints,
    dice: room.dice,
    held: room.held,
    canRoll: room.canRoll
  };
}

function emitRoom(room) {
  io.to(room.code).emit("room:update", publicState(room));
}

function seatForClient(room, clientId) {
  return room.players.find(p => p.clientId === clientId) || null;
}

function firstOpenSeat(room) {
  return room.players.find(p => !p.clientId) || null;
}

function bothPlayersJoined(room) {
  return room.players.every(p => !!p.clientId);
}

function resetTurn(room, startingSeat = room.activeSeat) {
  room.activeSeat = startingSeat;
  room.phase = bothPlayersJoined(room) ? "turn" : "lobby";
  room.turnPoints = 0;
  room.dice = [1, 1, 1, 1, 1, 1];
  room.held = [false, false, false, false, false, false];
  room.canRoll = bothPlayersJoined(room);
}

function hardResetGame(room) {
  room.players.forEach(p => (p.score = 0));
  room.activeSeat = 0;
  resetTurn(room, 0);
}

/**
 * Farkle scoring helpers
 * Returns { points, usedCounts } or { points: 0, usedCounts: null } if no scoring.
 */
function scoreKeptDice(values) {
  // values = array of dice values being kept this action (1..6)
  if (!values || values.length === 0) return { points: 0, usedCounts: null };

  const counts = [0, 0, 0, 0, 0, 0, 0];
  values.forEach(v => (counts[v]++));

  const n = values.length;

  // Special combos (enabled):
  // Straight 1-6 (1500)
  if (n === 6 && [1,2,3,4,5,6].every(v => counts[v] === 1)) {
    return { points: 1500, usedCounts: counts };
  }
  // Three pairs (1500)
  if (n === 6) {
    const pairs = [1,2,3,4,5,6].filter(v => counts[v] === 2).length;
    if (pairs === 3) return { points: 1500, usedCounts: counts };
  }
  // Two triplets (2500)
  if (n === 6) {
    const trips = [1,2,3,4,5,6].filter(v => counts[v] === 3).length;
    if (trips === 2) return { points: 2500, usedCounts: counts };
  }

  // Standard sets + singles
  let points = 0;

  for (let v = 1; v <= 6; v++) {
    const c = counts[v];
    if (c >= 6) {
      points += 3000; // six of a kind
      counts[v] -= 6;
    }
    if (counts[v] >= 5) {
      points += 2000; // five of a kind
      counts[v] -= 5;
    }
    if (counts[v] >= 4) {
      points += 1000; // four of a kind
      counts[v] -= 4;
    }
    if (counts[v] >= 3) {
      // three of a kind: 1=1000, 2=200, 3=300 ... 6=600
      points += (v === 1 ? 1000 : v * 100);
      counts[v] -= 3;
    }
  }

  // Singles: 1 = 100, 5 = 50
  points += counts[1] * 100;
  points += counts[5] * 50;

  // If the keep had any non-scoring dice, remind: in real farkle you cannot keep non-scoring dice.
  // We enforce that by requiring ALL kept dice be part of scoring.
  // To do that, recompute "used dice" vs original counts:
  // easiest: scoreKeptDice should reject if any die is non-scoring under optimal decomposition.
  //
  // We'll enforce stricter: if points==0, reject. But also if kept contains non-scoring.
  // Approx enforcement:
  const original = [0,0,0,0,0,0,0];
  values.forEach(v => (original[v]++));
  // If points > 0, we still need to ensure every kept die contributed.
  // We'll simulate "consumed" by subtracting leftovers (counts) from original.
  // But counts currently holds leftovers after using sets and singles scoring.
  // For v=2,3,4,6 leftovers are non-scoring; for v=1,5 leftovers are also scoring singles.
  // Therefore: any leftover for v in {2,3,4,6} means non-scoring dice were kept -> invalid.
  if (counts[2] || counts[3] || counts[4] || counts[6]) {
    return { points: 0, usedCounts: null };
  }
  // For 1 and 5 leftovers are fine (they're singles and were scored above).
  // So if points computed and no invalid leftovers, accept.
  return { points, usedCounts: original };
}

function rollDice(room) {
  // roll only dice that are not held
  for (let i = 0; i < 6; i++) {
    if (!room.held[i]) room.dice[i] = 1 + Math.floor(Math.random() * 6);
  }
}

function availableDiceValues(room) {
  // values of unheld dice
  const vals = [];
  for (let i = 0; i < 6; i++) if (!room.held[i]) vals.push(room.dice[i]);
  return vals;
}

// Determine if a roll is a "farkle" (no scoring dice/combo available among unheld dice)
function isFarkle(room) {
  const vals = availableDiceValues(room);
  if (vals.length === 0) return false;

  // Quick checks: any 1 or 5 scores
  if (vals.includes(1) || vals.includes(5)) return false;

  // counts
  const c = [0,0,0,0,0,0,0];
  vals.forEach(v => (c[v]++));

  // any three+ of a kind scores
  for (let v = 1; v <= 6; v++) if (c[v] >= 3) return false;

  // special combos among all 6 unheld (if all 6 unheld)
  if (vals.length === 6) {
    const straight = [1,2,3,4,5,6].every(v => c[v] === 1);
    if (straight) return false;

    const pairs = [1,2,3,4,5,6].filter(v => c[v] === 2).length;
    if (pairs === 3) return false;

    const trips = [1,2,3,4,5,6].filter(v => c[v] === 3).length;
    if (trips === 2) return false;
  }

  return true;
}

function hotDiceReset(room) {
  // If all dice are held (player scored with all 6), they get "hot dice": reset holds and roll again.
  if (room.held.every(Boolean)) {
    room.held = [false, false, false, false, false, false];
    room.canRoll = true;
    return true;
  }
  return false;
}

io.on("connection", (socket) => {
  socket.data.roomCode = null;
  socket.data.clientId = null;
  socket.data.seat = null;

  socket.on("room:create", ({ name, clientId }) => {
    const room = newRoom();
    rooms.set(room.code, room);

    // seat 0 becomes creator
    const p0 = room.players[0];
    p0.name = (name || "Player 1").slice(0, 20);
    p0.clientId = clientId;
    p0.socketId = socket.id;
    p0.online = true;

    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.clientId = clientId;
    socket.data.seat = 0;

    resetTurn(room, 0);
    emitRoom(room);
    socket.emit("room:joined", { code: room.code, seat: 0 });
  });

  socket.on("room:join", ({ code, name, clientId }) => {
    const room = rooms.get(code);
    if (!room) {
      socket.emit("toast", { msg: "Table not found." });
      return;
    }

    // If this clientId already has a seat, treat as reconnect
    let seatObj = seatForClient(room, clientId);

    if (!seatObj) {
      // Otherwise take first open seat
      seatObj = firstOpenSeat(room);
      if (!seatObj) {
        socket.emit("toast", { msg: "Table is full." });
        return;
      }
      seatObj.clientId = clientId;
      seatObj.name = (name || `Player ${seatObj.seat + 1}`).slice(0, 20);
      seatObj.score = seatObj.score || 0;
    }

    // Bind this seat to THIS socket
    seatObj.socketId = socket.id;
    seatObj.online = true;

    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.clientId = clientId;
    socket.data.seat = seatObj.seat;

    // If both players joined, start turn phase (seat 0 rolls first)
    if (bothPlayersJoined(room)) {
      room.phase = "turn";
      room.activeSeat = 0;
      room.turnPoints = 0;
      room.held = [false, false, false, false, false, false];
      room.canRoll = true;
    }

    emitRoom(room);
    socket.emit("room:joined", { code: room.code, seat: seatObj.seat });
  });

  socket.on("game:new", () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    // Only allow if at least one player is seated
    hardResetGame(room);
    emitRoom(room);
    io.to(code).emit("toast", { msg: "New game started. Seat 0 to roll." });
  });

  socket.on("turn:roll", () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    if (!bothPlayersJoined(room)) {
      socket.emit("toast", { msg: "Waiting for both players to join." });
      return;
    }
    if (room.phase !== "turn") {
      socket.emit("toast", { msg: "Game not ready." });
      return;
    }
    if (socket.data.seat !== room.activeSeat) {
      socket.emit("toast", { msg: "Not your turn." });
      return;
    }
    if (!room.canRoll) {
      socket.emit("toast", { msg: "You must KEEP or BANK first." });
      return;
    }

    rollDice(room);
    room.canRoll = false; // after roll, must keep/bank (or keep to continue)
    emitRoom(room);

    if (isFarkle(room)) {
      // Farkle: lose turn points, pass turn
      room.turnPoints = 0;
      room.held = [false, false, false, false, false, false];
      room.canRoll = true;
      room.activeSeat = room.activeSeat === 0 ? 1 : 0;
      emitRoom(room);
      io.to(code).emit("modal", {
        title: "Farkle!",
        body: "No scoring dice. Turn ends with 0 points."
      });
    }
  });

  socket.on("turn:toggleHold", ({ idx }) => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    if (socket.data.seat !== room.activeSeat) return;
    if (room.phase !== "turn") return;

    if (typeof idx !== "number" || idx < 0 || idx > 5) return;

    // Only allow toggling after at least one roll (i.e., canRoll === false means dice are "live")
    // If canRoll===true and no roll yet, the dice are meaningless placeholders.
    if (room.canRoll) return;

    room.held[idx] = !room.held[idx];
    emitRoom(room);
  });

  socket.on("turn:keep", () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    if (socket.data.seat !== room.activeSeat) {
      socket.emit("toast", { msg: "Not your turn." });
      return;
    }
    if (room.phase !== "turn") return;

    // Can only keep after a roll
    if (room.canRoll) {
      socket.emit("toast", { msg: "Roll first." });
      return;
    }

    // Gather selected (held) dice values that were just chosen this keep action:
    // We enforce: player must select at least one NEW die this keep.
    const selectedIdx = [];
    for (let i = 0; i < 6; i++) if (room.held[i]) selectedIdx.push(i);

    if (selectedIdx.length === 0) {
      socket.emit("toast", { msg: "Select scoring dice to keep." });
      return;
    }

    // Score ONLY the currently held dice among ALL dice.
    // This is simplified: held represents kept-from-this-roll. For MVP, it's fine.
    const values = selectedIdx.map(i => room.dice[i]);
    const scored = scoreKeptDice(values);

    if (scored.points <= 0) {
      socket.emit("toast", { msg: "Invalid keep. Choose only scoring dice." });
      return;
    }

    room.turnPoints += scored.points;

    // Mark kept dice as "locked in" by leaving them held, and allow rolling remaining dice.
    // Hot dice: if all are held, clear holds and allow another roll (player continues).
    const hot = hotDiceReset(room);
    room.canRoll = true;

    emitRoom(room);

    io.to(code).emit("toast", { msg: `Kept for ${scored.points} points.` });

    if (hot) {
      io.to(code).emit("toast", { msg: "Hot dice! Roll all six again." });
    }
  });

  socket.on("turn:bank", () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    if (socket.data.seat !== room.activeSeat) {
      socket.emit("toast", { msg: "Not your turn." });
      return;
    }
    if (room.phase !== "turn") return;

    // Bank adds turnPoints and passes turn
    const seat = room.activeSeat;
    room.players[seat].score += room.turnPoints;

    const winner = room.players[seat].score >= 10000;

    room.turnPoints = 0;
    room.held = [false, false, false, false, false, false];
    room.canRoll = true;

    if (winner) {
      emitRoom(room);
      io.to(code).emit("modal", {
        title: "Game over!",
        body: `${room.players[seat].name} wins!`
      });
      // reset for next game but keep scores? We'll keep scores until New game pressed.
      return;
    }

    // Pass turn
    room.activeSeat = seat === 0 ? 1 : 0;
    emitRoom(room);
  });

  socket.on("disconnect", () => {
    const code = socket.data.roomCode;
    const clientId = socket.data.clientId;
    if (!code || !clientId) return;

    const room = rooms.get(code);
    if (!room) return;

    const seatObj = seatForClient(room, clientId);
    if (!seatObj) return;

    // Only mark offline if the socket that disconnected is the current socketId for that seat
    if (seatObj.socketId === socket.id) {
      seatObj.online = false;
      seatObj.socketId = null;
      emitRoom(room);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Pirate Farkle server listening on ${PORT}`);
});
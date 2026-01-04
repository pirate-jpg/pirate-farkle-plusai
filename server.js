// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Railway / production port handling
const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static(path.join(__dirname, "public")));

// Basic health check
app.get("/health", (req, res) => res.json({ status: "ok", game: "pirate-farkle-plusai" }));

server.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});

/**
 * Farkle rules (standard-ish):
 * - 1 = 100, 5 = 50
 * - 3-of-kind: 100*face (except 1s = 1000)
 * - 4/5/6-of-kind: doubles each extra die (x2^(n-3))
 * - straight (1-6): 1500 (must use all 6 dice)
 * - three pairs: 1500 (must use all 6 dice)
 * - two triplets: 2500 (must use all 6 dice)
 * Winning score: 10,000
 */

const WIN_SCORE = 10000;

// In-memory rooms: roomCode -> roomState
const rooms = new Map();

function makeRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

function rollDie() {
  return 1 + Math.floor(Math.random() * 6);
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Returns true if the given counts (face->count) contains ANY scoring combination.
 */
function hasAnyScoring(counts) {
  // Straight
  let isStraight = true;
  for (let f = 1; f <= 6; f++) {
    if ((counts[f] || 0) !== 1) {
      isStraight = false;
      break;
    }
  }
  if (isStraight) return true;

  // Three pairs
  let pairs = 0;
  let total = 0;
  for (let f = 1; f <= 6; f++) {
    const c = counts[f] || 0;
    total += c;
    if (c === 2) pairs++;
  }
  if (total === 6 && pairs === 3) return true;

  // Two triplets
  let triplets = 0;
  total = 0;
  for (let f = 1; f <= 6; f++) {
    const c = counts[f] || 0;
    total += c;
    if (c === 3) triplets++;
  }
  if (total === 6 && triplets === 2) return true;

  // Any 1 or 5
  if ((counts[1] || 0) > 0) return true;
  if ((counts[5] || 0) > 0) return true;

  // Any 3+ of a kind
  for (let f = 1; f <= 6; f++) {
    if ((counts[f] || 0) >= 3) return true;
  }
  return false;
}

/**
 * Score a selection of dice (values array length 1..6).
 * Returns { ok: boolean, score: number, detail: string }.
 *
 * IMPORTANT validity rule:
 * - Every die in the selection must be part of a scoring pattern.
 * - Allowed patterns:
 *   * Straight (1-6) [all 6 dice]
 *   * Three pairs [all 6 dice]
 *   * Two triplets [all 6 dice]
 *   * N-of-kind (>=3)
 *   * Singles: 1s and 5s
 * - Any leftover non-scoring die in the selection => invalid.
 */
function scoreSelection(values) {
  if (!Array.isArray(values) || values.length === 0) return { ok: false, score: 0, detail: "No dice selected." };

  const counts = {};
  for (const v of values) counts[v] = (counts[v] || 0) + 1;

  // Special 6-die combos
  if (values.length === 6) {
    // Straight 1-6
    let isStraight = true;
    for (let f = 1; f <= 6; f++) {
      if ((counts[f] || 0) !== 1) {
        isStraight = false;
        break;
      }
    }
    if (isStraight) return { ok: true, score: 1500, detail: "Straight (1-6) = 1500" };

    // Three pairs
    let pairs = 0;
    for (let f = 1; f <= 6; f++) if ((counts[f] || 0) === 2) pairs++;
    if (pairs === 3) return { ok: true, score: 1500, detail: "Three pairs = 1500" };

    // Two triplets
    let triplets = 0;
    for (let f = 1; f <= 6; f++) if ((counts[f] || 0) === 3) triplets++;
    if (triplets === 2) return { ok: true, score: 2500, detail: "Two triplets = 2500" };
  }

  // General scoring (n-of-kind + single 1/5)
  let score = 0;
  let detailParts = [];

  // score n-of-kind first (>=3)
  const remaining = { ...counts };
  for (let f = 1; f <= 6; f++) {
    const c = remaining[f] || 0;
    if (c >= 3) {
      const base = (f === 1) ? 1000 : (f * 100);
      const multiplier = Math.pow(2, c - 3); // 3->1, 4->2, 5->4, 6->8
      const pts = base * multiplier;
      score += pts;
      detailParts.push(`${c}x${f} = ${pts}`);
      remaining[f] -= c; // consume all of that face
    }
  }

  // score single 1s and 5s
  if ((remaining[1] || 0) > 0) {
    const c = remaining[1];
    const pts = c * 100;
    score += pts;
    detailParts.push(`${c}x1 = ${pts}`);
    remaining[1] = 0;
  }

  if ((remaining[5] || 0) > 0) {
    const c = remaining[5];
    const pts = c * 50;
    score += pts;
    detailParts.push(`${c}x5 = ${pts}`);
    remaining[5] = 0;
  }

  // If anything remains, selection included non-scoring dice -> invalid
  for (let f = 1; f <= 6; f++) {
    if ((remaining[f] || 0) > 0) {
      return { ok: false, score: 0, detail: "Selection includes non-scoring dice." };
    }
  }

  if (score <= 0) return { ok: false, score: 0, detail: "No scoring dice selected." };
  return { ok: true, score, detail: detailParts.join(", ") };
}

function makeFreshTurnState() {
  return {
    dice: [1, 1, 1, 1, 1, 1],     // values
    kept: [false, false, false, false, false, false], // whether die is kept this turn
    canRoll: false,               // must roll to start turn
    hasRolled: false,
    turnPoints: 0,
    lastKeepDetail: ""
  };
}

function makeNewRoom(roomCode) {
  return {
    roomCode,
    createdAt: Date.now(),
    players: [
      { socketId: null, name: "", score: 0 },
      { socketId: null, name: "", score: 0 }
    ],
    started: false,
    currentTurn: 0, // 0 or 1
    turn: makeFreshTurnState(),
    log: [], // small event log strings
    winnerIndex: null
  };
}

function publicRoomState(room) {
  // Redact socket IDs, send what UI needs
  return {
    roomCode: room.roomCode,
    started: room.started,
    currentTurn: room.currentTurn,
    winnerIndex: room.winnerIndex,
    players: room.players.map(p => ({ name: p.name, score: p.score, connected: !!p.socketId })),
    turn: clone(room.turn),
    log: room.log.slice(-8)
  };
}

function getSeatIndex(room, socketId) {
  return room.players.findIndex(p => p.socketId === socketId);
}

function otherSeat(seat) {
  return seat === 0 ? 1 : 0;
}

function roomAddLog(room, msg) {
  room.log.push(msg);
  if (room.log.length > 50) room.log.shift();
}

function emitRoom(room) {
  io.to(room.roomCode).emit("room:update", publicRoomState(room));
}

function hardResetGame(room) {
  room.players[0].score = 0;
  room.players[1].score = 0;
  room.started = true;
  room.currentTurn = 0;
  room.turn = makeFreshTurnState();
  room.winnerIndex = null;
  room.log = [];
  roomAddLog(room, "New game started. First to 10,000 wins.");
}

function ensureRoomExists(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return null;
  return room;
}

io.on("connection", (socket) => {
  console.log("socket connected", socket.id);

  socket.on("disconnect", () => {
    // Remove from any room seat
    for (const room of rooms.values()) {
      const idx = getSeatIndex(room, socket.id);
      if (idx !== -1) {
        room.players[idx].socketId = null;
        roomAddLog(room, `${room.players[idx].name || "Player"} disconnected.`);
        // If game over? keep state; allow reconnect later (simple approach)
        emitRoom(room);
      }
    }
  });

  socket.on("room:create", ({ name }) => {
    const cleanName = String(name || "").trim().slice(0, 20) || "Player 1";
    let code = makeRoomCode();
    while (rooms.has(code)) code = makeRoomCode();

    const room = makeNewRoom(code);
    rooms.set(code, room);

    // Seat creator as P1
    room.players[0].socketId = socket.id;
    room.players[0].name = cleanName;

    room.started = false;
    roomAddLog(room, `${cleanName} created table ${code}. Waiting for opponent...`);

    socket.join(code);
    socket.emit("room:joined", { roomCode: code, seatIndex: 0 });
    emitRoom(room);
  });

  socket.on("room:join", ({ roomCode, name }) => {
    const code = String(roomCode || "").trim().toUpperCase();
    const room = ensureRoomExists(code);
    if (!room) {
      socket.emit("ui:modal", { title: "Table not found", message: `No table named "${code}" exists.` });
      return;
    }

    const cleanName = String(name || "").trim().slice(0, 20) || "Player";
    // Find open seat
    const openSeat = room.players.findIndex(p => !p.socketId);
    if (openSeat === -1) {
      socket.emit("ui:modal", { title: "Table full", message: `Table "${code}" already has 2 players.` });
      return;
    }

    room.players[openSeat].socketId = socket.id;
    room.players[openSeat].name = cleanName;
    roomAddLog(room, `${cleanName} joined table ${code}.`);

    socket.join(code);
    socket.emit("room:joined", { roomCode: code, seatIndex: openSeat });

    // Auto-start when both seats filled (and no winner)
    if (room.players[0].socketId && room.players[1].socketId && !room.started) {
      room.started = true;
      room.currentTurn = 0;
      room.turn = makeFreshTurnState();
      room.winnerIndex = null;
      roomAddLog(room, "Both players connected. Game begins!");
      roomAddLog(room, `${room.players[room.currentTurn].name}'s turn. Tap ROLL.`);
    }

    emitRoom(room);
  });

  socket.on("game:new", ({ roomCode }) => {
    const code = String(roomCode || "").trim().toUpperCase();
    const room = ensureRoomExists(code);
    if (!room) return;

    const seat = getSeatIndex(room, socket.id);
    if (seat === -1) return;

    // Let either player start a new game
    hardResetGame(room);
    roomAddLog(room, `${room.players[room.currentTurn].name}'s turn. Tap ROLL.`);
    emitRoom(room);
    io.to(room.roomCode).emit("ui:toast", { message: "New game started." });
  });

  socket.on("turn:roll", ({ roomCode }) => {
    const code = String(roomCode || "").trim().toUpperCase();
    const room = ensureRoomExists(code);
    if (!room || !room.started || room.winnerIndex !== null) return;

    const seat = getSeatIndex(room, socket.id);
    if (seat === -1) return;
    if (seat !== room.currentTurn) {
      socket.emit("ui:toast", { message: "Not your turn." });
      return;
    }

    // Must be allowed to roll
    if (room.turn.hasRolled && !room.turn.canRoll) {
      socket.emit("ui:toast", { message: "You must keep scoring dice or bank." });
      return;
    }

    // Roll only unkept dice
    for (let i = 0; i < 6; i++) {
      if (!room.turn.kept[i]) room.turn.dice[i] = rollDie();
    }
    room.turn.hasRolled = true;
    room.turn.canRoll = false; // after rolling, you must keep something or you might be farkled
    room.turn.lastKeepDetail = "";

    // Check for farkle on unkept dice
    const unkeptValues = [];
    const counts = {};
    for (let i = 0; i < 6; i++) {
      if (!room.turn.kept[i]) {
        const v = room.turn.dice[i];
        unkeptValues.push(v);
        counts[v] = (counts[v] || 0) + 1;
      }
    }

    if (!hasAnyScoring(counts)) {
      // Farkle: lose turn points, end turn
      roomAddLog(room, `${room.players[seat].name} FARKLED! Turn points lost.`);
      room.turn.turnPoints = 0;
      room.turn = makeFreshTurnState();
      room.currentTurn = otherSeat(room.currentTurn);
      roomAddLog(room, `${room.players[room.currentTurn].name}'s turn. Tap ROLL.`);
      io.to(room.roomCode).emit("ui:modal", {
        title: "FARKLE!",
        message: `${room.players[seat].name} rolled no scoring dice and loses the turn.`
      });
      emitRoom(room);
      return;
    }

    roomAddLog(room, `${room.players[seat].name} rolled.`);
    emitRoom(room);
  });

  socket.on("turn:keep", ({ roomCode, indices }) => {
    const code = String(roomCode || "").trim().toUpperCase();
    const room = ensureRoomExists(code);
    if (!room || !room.started || room.winnerIndex !== null) return;

    const seat = getSeatIndex(room, socket.id);
    if (seat === -1) return;
    if (seat !== room.currentTurn) {
      socket.emit("ui:toast", { message: "Not your turn." });
      return;
    }

    if (!room.turn.hasRolled) {
      socket.emit("ui:toast", { message: "Roll first." });
      return;
    }

    const idxs = Array.isArray(indices) ? indices : [];
    const unique = [...new Set(idxs.map(n => Number(n)).filter(n => Number.isInteger(n) && n >= 0 && n < 6))];
    if (unique.length === 0) {
      socket.emit("ui:toast", { message: "Select dice to keep." });
      return;
    }

    // Must be unkept dice only
    for (const i of unique) {
      if (room.turn.kept[i]) {
        socket.emit("ui:toast", { message: "You selected a die that's already kept." });
        return;
      }
    }

    const values = unique.map(i => room.turn.dice[i]);
    const scored = scoreSelection(values);
    if (!scored.ok) {
      socket.emit("ui:toast", { message: `Invalid keep: ${scored.detail}` });
      return;
    }

    // Apply keep
    for (const i of unique) room.turn.kept[i] = true;
    room.turn.turnPoints += scored.score;
    room.turn.lastKeepDetail = scored.detail;
    room.turn.canRoll = true;

    roomAddLog(room, `${room.players[seat].name} kept dice (+${scored.score}). Turn = ${room.turn.turnPoints}.`);

    // Hot dice: if all kept, reset kept to allow rolling all 6 again
    const allKept = room.turn.kept.every(Boolean);
    if (allKept) {
      roomAddLog(room, `${room.players[seat].name} has HOT DICE! Roll all 6 again.`);
      room.turn.kept = [false, false, false, false, false, false];
      room.turn.canRoll = true;
      io.to(room.roomCode).emit("ui:toast", { message: "HOT DICE! All 6 dice are available again." });
    }

    emitRoom(room);
  });

  socket.on("turn:bank", ({ roomCode }) => {
    const code = String(roomCode || "").trim().toUpperCase();
    const room = ensureRoomExists(code);
    if (!room || !room.started || room.winnerIndex !== null) return;

    const seat = getSeatIndex(room, socket.id);
    if (seat === -1) return;
    if (seat !== room.currentTurn) {
      socket.emit("ui:toast", { message: "Not your turn." });
      return;
    }

    if (!room.turn.hasRolled) {
      socket.emit("ui:toast", { message: "Roll first." });
      return;
    }

    if (room.turn.turnPoints <= 0) {
      socket.emit("ui:toast", { message: "No points to bank." });
      return;
    }

    // Bank points
    const pts = room.turn.turnPoints;
    room.players[seat].score += pts;
    roomAddLog(room, `${room.players[seat].name} BANKED ${pts}. Total = ${room.players[seat].score}.`);

    // Win check
    if (room.players[seat].score >= WIN_SCORE) {
      room.winnerIndex = seat;
      roomAddLog(room, `${room.players[seat].name} WINS!`);
      io.to(room.roomCode).emit("ui:modal", {
        title: "🏴‍☠️ GAME OVER",
        message: `${room.players[seat].name} wins with ${room.players[seat].score} points!`
      });
      emitRoom(room);
      return;
    }

    // Next turn
    room.turn = makeFreshTurnState();
    room.currentTurn = otherSeat(room.currentTurn);
    roomAddLog(room, `${room.players[room.currentTurn].name}'s turn. Tap ROLL.`);
    emitRoom(room);
  });

  socket.on("debug:state", ({ roomCode }) => {
    const code = String(roomCode || "").trim().toUpperCase();
    const room = ensureRoomExists(code);
    if (!room) return;
    socket.emit("debug:state", room);
  });
});
// server.js (FULL FILE) — Pirate Farkle 2-player locked-down (no AI yet)
"use strict";

const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// ---- Static ----
// If your repo uses /public like cribbage, keep this:
app.use(express.static(path.join(__dirname, "public")));
// If your repo uses /public and index.html is there:
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// -----------------------------
// Utilities
// -----------------------------
function nowTs() {
  return Date.now();
}
function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
function randInt(min, max) {
  return (Math.random() * (max - min + 1) + min) | 0;
}
function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 5; i++) out += chars[randInt(0, chars.length - 1)];
  return out;
}
function sanitizeName(name) {
  return String(name || "").trim().slice(0, 20);
}
function sanitizeCode(code) {
  return String(code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}

function diceRoll6() {
  return [1, 2, 3, 4, 5, 6].map(() => randInt(1, 6));
}

// -----------------------------
// Farkle scoring (standard + special combos enabled)
// -----------------------------
// Standard scoring conventions (common):
// - Single 1 = 100
// - Single 5 = 50
// - Three of a kind = face*100 (except 1s=1000)
// - Four of a kind = 2x three-kind
// - Five of a kind = 3x three-kind
// - Six of a kind = 4x three-kind
// Special combos enabled:
// - Straight (1-6) = 1500
// - Three pairs = 1500
// - Two triplets = 2500
// - Four-of-a-kind + a pair = 1500
function scoreDice(values) {
  // values: array of dice values that are being kept this step
  if (!values || values.length === 0) return { score: 0, detail: "No dice" };

  const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  for (const v of values) counts[v]++;

  const totalDice = values.length;

  // helper to compute three-kind base
  const threeKindBase = (face) => (face === 1 ? 1000 : face * 100);

  // --- Special combos require ALL dice in the selection (typically 6 dice scenarios)
  // But we allow a keep step to select all remaining dice; special combos apply if selection size is 6.
  if (totalDice === 6) {
    // Straight 1-6
    let isStraight = true;
    for (let f = 1; f <= 6; f++) {
      if (counts[f] !== 1) { isStraight = false; break; }
    }
    if (isStraight) return { score: 1500, detail: "Straight (1–6) = 1500" };

    // Three pairs
    const pairFaces = Object.keys(counts).filter(f => counts[f] === 2);
    if (pairFaces.length === 3) return { score: 1500, detail: "Three pairs = 1500" };

    // Two triplets
    const tripFaces = Object.keys(counts).filter(f => counts[f] === 3);
    if (tripFaces.length === 2) return { score: 2500, detail: "Two triplets = 2500" };

    // Four of a kind + a pair
    const fourFace = Object.keys(counts).find(f => counts[f] === 4);
    const pairFace = Object.keys(counts).find(f => counts[f] === 2);
    if (fourFace && pairFace) return { score: 1500, detail: "4 of a kind + a pair = 1500" };
  }

  // --- Standard scoring
  let score = 0;
  const parts = [];

  // 6/5/4/3 of a kind
  for (let face = 1; face <= 6; face++) {
    const c = counts[face];
    if (c >= 3) {
      const base = threeKindBase(face);
      let mult = 1;
      if (c === 4) mult = 2;
      else if (c === 5) mult = 3;
      else if (c === 6) mult = 4;
      const pts = base * mult;
      score += pts;
      parts.push(`${c}×${face} = ${pts}`);

      // remove them from singles consideration
      counts[face] -= c;
    }
  }

  // Singles (1s and 5s)
  if (counts[1] > 0) {
    const pts = counts[1] * 100;
    score += pts;
    parts.push(`${counts[1]}×1 = ${pts}`);
  }
  if (counts[5] > 0) {
    const pts = counts[5] * 50;
    score += pts;
    parts.push(`${counts[5]}×5 = ${pts}`);
  }

  if (score === 0) return { score: 0, detail: "Farkle (no scoring dice)" };
  return { score, detail: parts.join(" + ") };
}

function isScoringSelection(values) {
  return scoreDice(values).score > 0;
}

// -----------------------------
// Room state model
// -----------------------------
function makeRoom(code) {
  return {
    code,
    createdAt: nowTs(),
    // EXACTLY two players, no AI in this file.
    players: [
      { name: null, socketId: null, score: 0 }, // seat 0
      { name: null, socketId: null, score: 0 }, // seat 1
    ],
    // turn state
    turnIndex: 0,
    dice: diceRoll6(),         // current dice values
    keptMask: [false, false, false, false, false, false], // dice already kept this turn
    turnPoints: 0,             // unbanked points for current player
    started: false,
    gameOver: false,
    winnerIndex: null,

    // UX helpers
    log: [],
    modal: null, // { title, body, ts }
  };
}

const rooms = new Map(); // code -> room

function roomHasTwoPlayers(room) {
  return !!room.players[0].name && !!room.players[1].name;
}

function seatNameTaken(room, name) {
  return room.players.some(p => p.name && p.name.toLowerCase() === name.toLowerCase());
}

function findSeatBySocket(room, socketId) {
  for (let i = 0; i < 2; i++) {
    if (room.players[i].socketId === socketId) return i;
  }
  return -1;
}

function canReconnectToSeat(room, name) {
  // allow reconnect ONLY if a seat has that name and socketId is null (disconnected)
  for (let i = 0; i < 2; i++) {
    const p = room.players[i];
    if (p.name && p.name.toLowerCase() === name.toLowerCase() && !p.socketId) return i;
  }
  return -1;
}

function firstEmptySeat(room) {
  for (let i = 0; i < 2; i++) {
    if (!room.players[i].name) return i;
  }
  return -1;
}

// -----------------------------
// Game lifecycle
// -----------------------------
function resetGame(room) {
  room.players[0].score = 0;
  room.players[1].score = 0;
  room.turnIndex = 0;
  room.dice = diceRoll6();
  room.keptMask = [false, false, false, false, false, false];
  room.turnPoints = 0;
  room.started = true;
  room.gameOver = false;
  room.winnerIndex = null;
  room.log = [];
  room.modal = { title: "New game", body: "First to 10,000. Good luck, captains.", ts: nowTs() };
  room.log.push(`New game started. ${room.players[0].name} goes first.`);
}

function ensureStarted(room) {
  if (room.started) return;
  if (!roomHasTwoPlayers(room)) return;
  resetGame(room);
}

function currentPlayer(room) {
  return room.players[room.turnIndex];
}

function otherIndex(i) {
  return i === 0 ? 1 : 0;
}

function remainingDiceIndices(room) {
  const idxs = [];
  for (let i = 0; i < 6; i++) if (!room.keptMask[i]) idxs.push(i);
  return idxs;
}

function rollDice(room) {
  const idxs = remainingDiceIndices(room);
  for (const i of idxs) room.dice[i] = randInt(1, 6);
}

function endTurnFarkle(room) {
  // lose turnPoints, pass turn
  const loser = room.players[room.turnIndex].name;
  room.turnPoints = 0;
  room.keptMask = [false, false, false, false, false, false];
  room.dice = diceRoll6();
  room.turnIndex = otherIndex(room.turnIndex);
  room.log.push(`${loser} farkled. Turn passes to ${room.players[room.turnIndex].name}.`);
  room.modal = { title: "Farkle!", body: `${loser} scored 0 this turn.`, ts: nowTs() };
}

function endTurnBank(room) {
  const p = room.players[room.turnIndex];
  const pts = room.turnPoints;
  p.score += pts;

  room.log.push(`${p.name} banked ${pts}. Total: ${p.score}.`);

  // win condition
  if (p.score >= 10000) {
    room.gameOver = true;
    room.winnerIndex = room.turnIndex;
    room.modal = { title: "🏆 Game Over", body: `${p.name} wins with ${p.score}!`, ts: nowTs() };
    return;
  }

  // next turn
  room.turnPoints = 0;
  room.keptMask = [false, false, false, false, false, false];
  room.dice = diceRoll6();
  room.turnIndex = otherIndex(room.turnIndex);
  room.modal = { title: "Turn", body: `Now it’s ${room.players[room.turnIndex].name}’s turn.`, ts: nowTs() };
}

function hotDiceIfNeeded(room) {
  // if all 6 dice are kept/scored, reset kept and allow rolling all 6 again
  const allKept = room.keptMask.every(Boolean);
  if (allKept) {
    room.keptMask = [false, false, false, false, false, false];
    room.dice = diceRoll6();
    room.log.push("Hot dice! Roll all six again.");
    room.modal = { title: "🔥 Hot Dice", body: "You scored all dice. Roll all six again!", ts: nowTs() };
  }
}

// -----------------------------
// Emitting state (personalized)
// -----------------------------
function emitRoomState(room) {
  const base = {
    code: room.code,
    players: room.players.map(p => ({ name: p.name, score: p.score })),
    turnIndex: room.turnIndex,
    dice: room.dice.slice(),
    keptMask: room.keptMask.slice(),
    turnPoints: room.turnPoints,
    started: room.started,
    gameOver: room.gameOver,
    winnerIndex: room.winnerIndex,
    log: room.log.slice(-60), // keep it light
    modal: room.modal,
  };

  // Send to each connected player with their seat index
  for (let seat = 0; seat < 2; seat++) {
    const sid = room.players[seat].socketId;
    if (!sid) continue;
    const s = io.sockets.sockets.get(sid);
    if (!s) continue;
    s.emit("state", { ...base, youIndex: seat });
  }
}

// -----------------------------
// Main socket handlers
// -----------------------------
io.on("connection", (socket) => {
  // Store metadata for lookup on disconnect
  socket.data.roomCode = null;
  socket.data.seat = null;

  function err(msg) {
    socket.emit("error_msg", msg);
  }

  function getRoomOrErr() {
    const code = socket.data.roomCode;
    if (!code) return null;
    const room = rooms.get(code);
    if (!room) return null;
    return room;
  }

  function ensureMyTurn(room) {
    const seat = socket.data.seat;
    if (seat === null || seat === undefined) return false;
    if (room.turnIndex !== seat) return false;
    return true;
  }

  // ---- Create table
  socket.on("create_table", ({ name } = {}) => {
    const nm = sanitizeName(name);
    if (!nm) return err("Enter a name.");

    // Create unique code
    let code = makeCode();
    while (rooms.has(code)) code = makeCode();

    const room = makeRoom(code);
    rooms.set(code, room);

    // seat 0 is creator
    room.players[0].name = nm;
    room.players[0].socketId = socket.id;

    socket.data.roomCode = code;
    socket.data.seat = 0;

    socket.join(code);

    room.log.push(`${nm} created table ${code}. Waiting for a second player…`);
    room.modal = { title: "Table created", body: `Share code ${code} with your opponent.`, ts: nowTs() };

    emitRoomState(room);
  });

  // ---- Join table
  socket.on("join_table", ({ code, name } = {}) => {
    const nm = sanitizeName(name);
    const c = sanitizeCode(code);
    if (!nm) return err("Enter a name.");
    if (!c) return err("Enter a table code.");

    const room = rooms.get(c);
    if (!room) return err("Table not found. Check the code.");

    // If this socket already joined somewhere else, leave it cleanly
    if (socket.data.roomCode && socket.data.roomCode !== c) {
      try { socket.leave(socket.data.roomCode); } catch (_e) {}
    }

    // Reconnect rule (only if same name and that seat is disconnected)
    const reconnectSeat = canReconnectToSeat(room, nm);
    if (reconnectSeat !== -1) {
      room.players[reconnectSeat].socketId = socket.id;
      socket.data.roomCode = c;
      socket.data.seat = reconnectSeat;
      socket.join(c);
      room.log.push(`${nm} reconnected.`);
      room.modal = { title: "Reconnected", body: `${nm} is back aboard.`, ts: nowTs() };
      ensureStarted(room);
      emitRoomState(room);
      return;
    }

    // Name collision protection (prevents “same name kicks other tab” behavior)
    if (seatNameTaken(room, nm)) {
      return err("That name is already taken in this table. Use a different name.");
    }

    // Normal join to empty seat
    const seat = firstEmptySeat(room);
    if (seat === -1) return err("Table is full (2 players).");

    room.players[seat].name = nm;
    room.players[seat].socketId = socket.id;

    socket.data.roomCode = c;
    socket.data.seat = seat;

    socket.join(c);

    room.log.push(`${nm} joined table ${c}.`);
    room.modal = { title: "Player joined", body: `${nm} joined.`, ts: nowTs() };

    ensureStarted(room);
    emitRoomState(room);
  });

  // ---- Roll
  socket.on("roll", () => {
    const room = getRoomOrErr();
    if (!room) return;
    if (!room.started) return err("Game not started yet.");
    if (room.gameOver) return err("Game over. Start a new game.");
    if (!ensureMyTurn(room)) return err("Not your turn.");

    // roll remaining dice
    rollDice(room);

    // If after rolling, there are no scoring dice among remaining dice, it's a Farkle.
    const remainingIdxs = remainingDiceIndices(room);
    const remainingVals = remainingIdxs.map(i => room.dice[i]);
    const scoringExists = hasAnyScoringInDice(remainingVals);

    if (!scoringExists) {
      endTurnFarkle(room);
      emitRoomState(room);
      return;
    }

    room.modal = null; // clear modal after action
    emitRoomState(room);
  });

  // ---- Keep
  socket.on("keep", ({ idxs } = {}) => {
    const room = getRoomOrErr();
    if (!room) return;
    if (!room.started) return err("Game not started yet.");
    if (room.gameOver) return err("Game over. Start a new game.");
    if (!ensureMyTurn(room)) return err("Not your turn.");

    const arr = Array.isArray(idxs) ? idxs : [];
    const picked = [...new Set(arr.map(n => Number(n)).filter(n => Number.isFinite(n)))];
    if (picked.length === 0) return err("Select dice to keep.");

    // validate indices and not already kept
    for (const i of picked) {
      if (i < 0 || i > 5) return err("Invalid dice selection.");
      if (room.keptMask[i]) return err("You already kept one of those dice.");
    }

    const values = picked.map(i => room.dice[i]);
    const { score, detail } = scoreDice(values);
    if (score <= 0) return err("That selection doesn’t score. Choose different dice.");

    // Apply keep
    for (const i of picked) room.keptMask[i] = true;
    room.turnPoints += score;

    room.log.push(`${room.players[room.turnIndex].name} kept ${values.join(",")} (+${score}) — ${detail}`);

    // Hot dice
    hotDiceIfNeeded(room);

    room.modal = null;
    emitRoomState(room);
  });

  // ---- Bank
  socket.on("bank", () => {
    const room = getRoomOrErr();
    if (!room) return;
    if (!room.started) return err("Game not started yet.");
    if (room.gameOver) return err("Game over. Start a new game.");
    if (!ensureMyTurn(room)) return err("Not your turn.");

    if (room.turnPoints <= 0) return err("You have no turn points to bank.");

    endTurnBank(room);
    emitRoomState(room);
  });

  // ---- New game (either player can press)
  socket.on("new_game", () => {
    const room = getRoomOrErr();
    if (!room) return;
    if (!roomHasTwoPlayers(room)) return err("Need 2 players to start.");
    resetGame(room);
    emitRoomState(room);
  });

  // ---- Disconnect handling (NO KICKING THE OTHER TAB)
  socket.on("disconnect", () => {
    const code = socket.data.roomCode;
    const seat = socket.data.seat;
    if (!code || seat === null || seat === undefined) return;

    const room = rooms.get(code);
    if (!room) return;

    // Clear ONLY this seat’s socketId; keep the name so they can reconnect
    if (room.players[seat].socketId === socket.id) {
      room.players[seat].socketId = null;
      room.log.push(`${room.players[seat].name} disconnected.`);
      room.modal = { title: "Disconnected", body: `${room.players[seat].name} lost connection.`, ts: nowTs() };
    }

    emitRoomState(room);

    // Optional cleanup: if nobody is connected, delete empty rooms after a while
    // (keep simple for now; you can add a timeout later)
  });
});

// -----------------------------
// Helper: scoring existence in remaining dice
// -----------------------------
function hasAnyScoringInDice(values) {
  if (!values || values.length === 0) return false;
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  for (const v of values) counts[v]++;

  // Singles 1 or 5
  if (counts[1] > 0 || counts[5] > 0) return true;

  // Three of a kind
  for (let f = 1; f <= 6; f++) if (counts[f] >= 3) return true;

  // Special combos possible only when 6 dice remain
  if (values.length === 6) {
    // straight
    let straight = true;
    for (let f = 1; f <= 6; f++) if (counts[f] !== 1) { straight = false; break; }
    if (straight) return true;

    // three pairs
    const pairFaces = Object.keys(counts).filter(f => counts[f] === 2);
    if (pairFaces.length === 3) return true;

    // two triplets
    const tripFaces = Object.keys(counts).filter(f => counts[f] === 3);
    if (tripFaces.length === 2) return true;

    // four + pair
    const fourFace = Object.keys(counts).find(f => counts[f] === 4);
    const pairFace = Object.keys(counts).find(f => counts[f] === 2);
    if (fourFace && pairFace) return true;
  }

  return false;
}

// -----------------------------
server.listen(PORT, () => {
  console.log(`Pirate Farkle server listening on ${PORT}`);
});
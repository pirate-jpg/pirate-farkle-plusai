// server.js
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (req, res) => res.json({ ok: true, game: "pirate-farkle" }));

server.listen(PORT, () => console.log("Server listening on", PORT));

/**
 * Room + game state
 * We keep server authoritative. Client only displays what server says.
 */
const rooms = new Map(); // code -> room

function nowIso() {
  return new Date().toISOString();
}

function randCode(len = 5) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function clampName(name) {
  return (name || "").trim().slice(0, 20) || "Captain";
}

function getSeatBySid(room, sid) {
  return room.players.findIndex((p) => p.sid === sid);
}

function getSeatByNameOffline(room, name) {
  const n = (name || "").trim().toLowerCase();
  if (!n) return -1;
  return room.players.findIndex((p) => !p.sid && p.name.toLowerCase() === n);
}

function broadcastRoom(room) {
  // scrub any sensitive data; keep it simple
  const payload = {
    type: "room",
    code: room.code,
    createdAt: room.createdAt,
    players: room.players.map((p) => ({
      name: p.name,
      online: !!p.sid,
      score: p.score,
    })),
    game: room.game,
  };
  io.to(room.code).emit("room:update", payload);
}

function makeFreshGame(startingTurnIndex = 0) {
  return {
    status: "waiting", // waiting | playing | over
    targetScore: 10000,
    entryMin: 500, // standard: must bank >= 500 once to "get on the board"
    turnIndex: startingTurnIndex,
    dice: [1, 1, 1, 1, 1, 1],
    kept: [false, false, false, false, false, false],
    canRoll: false, // becomes true when both players present & game starts
    turnPoints: 0,
    lastAction: "Create or join a table to begin.",
    log: [],
    winner: null,
  };
}

/**
 * Standard-ish Farkle scoring with special combos enabled.
 * Returns {score, usedMask} for a given selection mask OR for "all scoring dice".
 *
 * Rules implemented:
 * - 1 = 100, 5 = 50 (singles)
 * - 3 of a kind: x * 100 (except 1s = 1000)
 * - 4/5/6 of a kind: double each additional die (3->base, 4->*2, 5->*4, 6->*8)
 * - Straight (1-6): 1500
 * - Three pairs: 1500
 * - Two triplets: 2500
 * - Four of a kind + pair: 1500
 *
 * IMPORTANT: We score ONLY the selected dice. Validation ensures selection is legal.
 */
const SPECIAL_SCORES = {
  straight: 1500,
  threePairs: 1500,
  twoTriplets: 2500,
  fourPlusPair: 1500,
};

function countFaces(dice, mask) {
  const counts = Array(7).fill(0);
  const idxs = [];
  for (let i = 0; i < dice.length; i++) {
    if (mask[i]) {
      counts[dice[i]]++;
      idxs.push(i);
    }
  }
  return { counts, idxs };
}

function isStraight(counts) {
  for (let f = 1; f <= 6; f++) if (counts[f] !== 1) return false;
  return true;
}

function isThreePairs(counts) {
  let pairs = 0;
  for (let f = 1; f <= 6; f++) if (counts[f] === 2) pairs++;
  return pairs === 3;
}

function isTwoTriplets(counts) {
  let trip = 0;
  for (let f = 1; f <= 6; f++) if (counts[f] === 3) trip++;
  return trip === 2;
}

function isFourPlusPair(counts) {
  let has4 = false;
  let has2 = false;
  for (let f = 1; f <= 6; f++) {
    if (counts[f] === 4) has4 = true;
    if (counts[f] === 2) has2 = true;
  }
  return has4 && has2;
}

function scoreSelection(dice, mask) {
  const { counts, idxs } = countFaces(dice, mask);
  const selectedCount = idxs.length;
  if (selectedCount === 0) return { score: 0 };

  // Special combos only apply to exactly 6 dice selected
  if (selectedCount === 6) {
    if (isStraight(counts)) return { score: SPECIAL_SCORES.straight };
    if (isThreePairs(counts)) return { score: SPECIAL_SCORES.threePairs };
    if (isTwoTriplets(counts)) return { score: SPECIAL_SCORES.twoTriplets };
    if (isFourPlusPair(counts)) return { score: SPECIAL_SCORES.fourPlusPair };
  }

  let score = 0;

  // Triples and above
  for (let f = 1; f <= 6; f++) {
    const c = counts[f];
    if (c >= 3) {
      let base = (f === 1) ? 1000 : f * 100;
      // 4/5/6 of a kind doubles each extra die beyond 3
      // 3 -> base, 4 -> base*2, 5 -> base*4, 6 -> base*8
      const mult = 1 << (c - 3);
      score += base * mult;
      counts[f] -= c; // consume
    }
  }

  // Singles (1s and 5s) that remain
  score += counts[1] * 100;
  score += counts[5] * 50;

  return { score };
}

/**
 * Determine which dice are "scoring dice" in the current roll context.
 * We return a boolean array for dice that could be legally kept (as part of some scoring set).
 *
 * For simplicity & low-risk, we compute if there exists ANY scoring for that face:
 * - any 1 or 5 is keepable
 * - any face with count >= 3 is keepable (all dice of that face)
 * - if all 6 unkept dice form a special combo, then all 6 are keepable
 */
function computeKeepable(dice, keptMask) {
  const unkeptMask = dice.map((_, i) => !keptMask[i]);
  const { counts, idxs } = countFaces(dice, unkeptMask);
  const keepable = Array(6).fill(false);

  // Special combos (only for all 6 unkept dice)
  if (idxs.length === 6) {
    if (isStraight(counts) || isThreePairs(counts) || isTwoTriplets(counts) || isFourPlusPair(counts)) {
      return Array(6).fill(true);
    }
  }

  // Triples+
  for (let f = 1; f <= 6; f++) {
    if (counts[f] >= 3) {
      for (let i = 0; i < 6; i++) {
        if (!keptMask[i] && dice[i] === f) keepable[i] = true;
      }
    }
  }

  // Singles 1 and 5
  for (let i = 0; i < 6; i++) {
    if (!keptMask[i] && (dice[i] === 1 || dice[i] === 5)) keepable[i] = true;
  }

  return keepable;
}

function ensureRoom(code) {
  const room = rooms.get(code);
  if (!room) return null;
  if (!room.game) room.game = makeFreshGame(0);
  return room;
}

function startGameIfReady(room) {
  const both = room.players.every((p) => !!p.sid);
  if (both && room.game.status === "waiting") {
    room.game = makeFreshGame(0);
    room.game.status = "playing";
    room.game.canRoll = true;
    room.game.turnIndex = 0;
    room.game.turnPoints = 0;
    room.game.kept = [false, false, false, false, false, false];
    room.game.lastAction = `${room.players[0].name} to start. Press ROLL.`;
    room.game.log = [{ t: nowIso(), msg: "Game started." }];
  }
}

function isPlayersTurn(room, seat, sid) {
  if (!room || room.game.status !== "playing") return false;
  if (seat !== room.game.turnIndex) return false;
  return room.players[seat].sid === sid;
}

function endTurn(room, reason) {
  room.game.turnPoints = 0;
  room.game.kept = [false, false, false, false, false, false];
  room.game.canRoll = true;
  room.game.turnIndex = 1 - room.game.turnIndex;
  room.game.lastAction = reason || `Turn passes to ${room.players[room.game.turnIndex].name}.`;
}

function checkWin(room) {
  const p0 = room.players[0].score;
  const p1 = room.players[1].score;
  if (p0 >= room.game.targetScore) return 0;
  if (p1 >= room.game.targetScore) return 1;
  return null;
}

io.on("connection", (socket) => {
  socket.emit("hello", { ok: true });

  socket.on("room:create", ({ name }) => {
    const cleanName = clampName(name);
    let code = randCode(5);
    while (rooms.has(code)) code = randCode(5);

    const room = {
      code,
      createdAt: nowIso(),
      players: [
        { name: cleanName, sid: socket.id, score: 0 },
        { name: "—", sid: null, score: 0 },
      ],
      game: makeFreshGame(0),
    };

    rooms.set(code, room);
    socket.join(code);
    room.game.lastAction = `Table created. Share code ${code}.`;
    room.game.log.push({ t: nowIso(), msg: `${cleanName} created table ${code}.` });

    broadcastRoom(room);
  });

  socket.on("room:join", ({ code, name }) => {
    const room = ensureRoom((code || "").trim().toUpperCase());
    if (!room) return socket.emit("toast", { type: "error", msg: "Table not found." });

    const cleanName = clampName(name);
    const openSeat = room.players.findIndex((p) => !p.sid);
    if (openSeat === -1) return socket.emit("toast", { type: "error", msg: "Table is full." });

    room.players[openSeat].name = cleanName;
    room.players[openSeat].sid = socket.id;

    socket.join(room.code);

    room.game.log.push({ t: nowIso(), msg: `${cleanName} joined.` });
    room.game.lastAction = `${cleanName} joined.`;
    startGameIfReady(room);
    broadcastRoom(room);
  });

  // ✅ IMPORTANT: sync + auto-reclaim seat on reconnect (fixes “Your turn / not your turn” mismatch)
  socket.on("room:sync", ({ code, name }) => {
    const room = ensureRoom((code || "").trim().toUpperCase());
    if (!room) return;

    socket.join(room.code);

    const cleanName = clampName(name);

    // If already seated by sid, mark as online and keep
    let seat = getSeatBySid(room, socket.id);

    // Otherwise try reclaim: same name, offline
    if (seat === -1) {
      const reclaimSeat = getSeatByNameOffline(room, cleanName);
      if (reclaimSeat !== -1) {
        room.players[reclaimSeat].sid = socket.id;
        room.game.log.push({ t: nowIso(), msg: `${room.players[reclaimSeat].name} reconnected.` });
        room.game.lastAction = `${room.players[reclaimSeat].name} reconnected.`;
        seat = reclaimSeat;
      }
    }

    // If game never started but now both are here, start it
    startGameIfReady(room);

    broadcastRoom(room);
  });

  socket.on("game:new", ({ code }) => {
    const room = ensureRoom((code || "").trim().toUpperCase());
    if (!room) return;

    // Only allow if seated
    const seat = getSeatBySid(room, socket.id);
    if (seat === -1) return socket.emit("toast", { type: "error", msg: "Not seated at this table." });

    room.players[0].score = 0;
    room.players[1].score = 0;
    room.game = makeFreshGame(0);

    // If both online, start immediately
    startGameIfReady(room);

    broadcastRoom(room);
  });

  socket.on("game:roll", ({ code }) => {
    const room = ensureRoom((code || "").trim().toUpperCase());
    if (!room) return;

    const seat = getSeatBySid(room, socket.id);
    if (seat === -1) return socket.emit("toast", { type: "error", msg: "Not seated at this table." });

    if (!isPlayersTurn(room, seat, socket.id)) {
      return socket.emit("toast", { type: "error", msg: "Not your turn." });
    }

    if (!room.game.canRoll) return socket.emit("toast", { type: "error", msg: "You must KEEP or BANK." });

    // Roll unkept dice
    for (let i = 0; i < 6; i++) {
      if (!room.game.kept[i]) {
        room.game.dice[i] = 1 + Math.floor(Math.random() * 6);
      }
    }

    room.game.canRoll = false;

    const keepable = computeKeepable(room.game.dice, room.game.kept);
    const anyKeepable = keepable.some((x) => x);

    if (!anyKeepable) {
      // Farkle! Lose turn points, pass turn
      const name = room.players[seat].name;
      room.game.log.push({ t: nowIso(), msg: `${name} FARKLED! (lost ${room.game.turnPoints})` });
      endTurn(room, `FARKLE! Turn passes to ${room.players[room.game.turnIndex].name}.`);
    } else {
      room.game.lastAction = `${room.players[seat].name} rolled. Select scoring dice and press KEEP.`;
      room.game.log.push({ t: nowIso(), msg: `${room.players[seat].name} rolled.` });
    }

    broadcastRoom(room);
  });

  socket.on("game:keep", ({ code, select }) => {
    const room = ensureRoom((code || "").trim().toUpperCase());
    if (!room) return;

    const seat = getSeatBySid(room, socket.id);
    if (seat === -1) return socket.emit("toast", { type: "error", msg: "Not seated at this table." });

    if (!isPlayersTurn(room, seat, socket.id)) {
      return socket.emit("toast", { type: "error", msg: "Not your turn." });
    }

    // select: boolean[6]
    if (!Array.isArray(select) || select.length !== 6) {
      return socket.emit("toast", { type: "error", msg: "Bad selection." });
    }

    // You can only select dice that are currently unkept
    for (let i = 0; i < 6; i++) {
      if (select[i] && room.game.kept[i]) {
        return socket.emit("toast", { type: "error", msg: "You selected a kept die." });
      }
    }

    // Must select at least one
    if (!select.some(Boolean)) return socket.emit("toast", { type: "error", msg: "Select at least one die." });

    // Must be legal scoring selection:
    // For low-risk, we require that every selected die is "keepable" in current roll context,
    // and selection itself yields score > 0.
    const keepable = computeKeepable(room.game.dice, room.game.kept);
    for (let i = 0; i < 6; i++) {
      if (select[i] && !keepable[i]) {
        return socket.emit("toast", { type: "error", msg: "Selection includes non-scoring die." });
      }
    }

    const { score } = scoreSelection(room.game.dice, select);
    if (!score || score <= 0) {
      return socket.emit("toast", { type: "error", msg: "That selection doesn’t score." });
    }

    // Apply keep
    for (let i = 0; i < 6; i++) if (select[i]) room.game.kept[i] = true;

    room.game.turnPoints += score;
    room.game.canRoll = true; // after keeping, you may roll again or bank

    // Hot dice: if all dice are kept, reset kept and allow rolling all 6
    const allKept = room.game.kept.every(Boolean);
    if (allKept) {
      room.game.kept = [false, false, false, false, false, false];
      room.game.lastAction = `Hot dice! ${room.players[seat].name} kept all dice (+${score}). Roll again.`;
      room.game.log.push({ t: nowIso(), msg: `${room.players[seat].name} HOT DICE (+${score}).` });
    } else {
      room.game.lastAction = `${room.players[seat].name} kept (+${score}). Roll or bank.`;
      room.game.log.push({ t: nowIso(), msg: `${room.players[seat].name} kept (+${score}).` });
    }

    broadcastRoom(room);
  });

  socket.on("game:bank", ({ code }) => {
    const room = ensureRoom((code || "").trim().toUpperCase());
    if (!room) return;

    const seat = getSeatBySid(room, socket.id);
    if (seat === -1) return socket.emit("toast", { type: "error", msg: "Not seated at this table." });

    if (!isPlayersTurn(room, seat, socket.id)) {
      return socket.emit("toast", { type: "error", msg: "Not your turn." });
    }

    if (room.game.turnPoints <= 0) return socket.emit("toast", { type: "error", msg: "No points to bank." });

    // Entry minimum: if player has 0 total, must bank >= entryMin
    const player = room.players[seat];
    if (player.score === 0 && room.game.turnPoints < room.game.entryMin) {
      return socket.emit("toast", { type: "error", msg: `Need ${room.game.entryMin}+ to get on the board.` });
    }

    player.score += room.game.turnPoints;

    room.game.log.push({ t: nowIso(), msg: `${player.name} banked ${room.game.turnPoints}. Total ${player.score}.` });

    // win check
    const winSeat = checkWin(room);
    if (winSeat !== null) {
      room.game.status = "over";
      room.game.winner = winSeat;
      room.game.lastAction = `🏴‍☠️ ${room.players[winSeat].name} wins!`;
      broadcastRoom(room);
      return;
    }

    endTurn(room, `Banked. Turn passes to ${room.players[room.game.turnIndex].name}.`);
    broadcastRoom(room);
  });

  socket.on("disconnect", () => {
    // Mark player offline anywhere they appear
    for (const room of rooms.values()) {
      const seat = getSeatBySid(room, socket.id);
      if (seat !== -1) {
        const name = room.players[seat].name;
        room.players[seat].sid = null;
        room.game.log.push({ t: nowIso(), msg: `${name} disconnected.` });
        room.game.lastAction = `${name} disconnected.`;
        broadcastRoom(room);
      }
    }
  });
});
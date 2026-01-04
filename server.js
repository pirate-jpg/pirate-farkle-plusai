// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static("public"));

// Basic health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", game: "pirate-farkle" });
});

/**
 * FARKLE RULES (standard-ish, with combos enabled)
 * - Single 1 = 100
 * - Single 5 = 50
 * - 3 of a kind: 1s=1000, 2-6 = face*100
 * - 4/5/6 of a kind: double/triple/quadruple the triple score
 * - Straight 1-6 = 1500
 * - Three pairs = 1500
 * - Two triplets = 2500
 * - Four of a kind + a pair = 1500
 * - Hot dice: if all dice score/are kept, reset kept and roll all 6 again in same turn
 */

function countFaces(dice) {
  const counts = new Array(7).fill(0);
  for (const d of dice) counts[d] += 1;
  return counts;
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
  let trips = 0;
  for (let f = 1; f <= 6; f++) if (counts[f] === 3) trips++;
  return trips === 2;
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

function scoreNOfAKind(face, n) {
  // base triple
  let base = face === 1 ? 1000 : face * 100;
  if (n === 3) return base;
  if (n === 4) return base * 2;
  if (n === 5) return base * 3;
  if (n === 6) return base * 4;
  return 0;
}

/**
 * Compute score + which dice are "scoring-selectable" for KEEP
 * for the CURRENT ROLL (only considers non-kept dice).
 *
 * We allow KEEP to include:
 * - any dice that are part of a scoring set (combos or n-of-kind)
 * - any single 1 or 5
 *
 * Note: combos (straight/three-pairs/two-triplets/four+pair) consume ALL dice in the roll.
 */
function evaluateRoll(diceValues) {
  // diceValues length can be 1..6 (only the unkept dice)
  const counts = countFaces(diceValues);
  const selectable = new Array(diceValues.length).fill(false);

  // combos that consume all dice (must be exactly 6 dice in roll)
  if (diceValues.length === 6) {
    if (isStraight(counts)) {
      return {
        rollScore: 1500,
        selectable: selectable.map(() => true),
        combo: "Straight (1–6)",
        comboConsumesAll: true,
      };
    }
    if (isThreePairs(counts)) {
      return {
        rollScore: 1500,
        selectable: selectable.map(() => true),
        combo: "Three pairs",
        comboConsumesAll: true,
      };
    }
    if (isTwoTriplets(counts)) {
      return {
        rollScore: 2500,
        selectable: selectable.map(() => true),
        combo: "Two triplets",
        comboConsumesAll: true,
      };
    }
    if (isFourPlusPair(counts)) {
      return {
        rollScore: 1500,
        selectable: selectable.map(() => true),
        combo: "Four of a kind + a pair",
        comboConsumesAll: true,
      };
    }
  }

  // mark n-of-kind dice as selectable
  for (let face = 1; face <= 6; face++) {
    if (counts[face] >= 3) {
      // all dice of that face are selectable
      for (let i = 0; i < diceValues.length; i++) {
        if (diceValues[i] === face) selectable[i] = true;
      }
    }
  }

  // singles: 1s and 5s selectable (even if also part of n-of-kind)
  for (let i = 0; i < diceValues.length; i++) {
    if (diceValues[i] === 1 || diceValues[i] === 5) selectable[i] = true;
  }

  // rollScore here is NOT what you'll get by selecting arbitrary dice.
  // It’s just "there exists scoring" indicator, but we compute selection score separately.
  const hasScoring = selectable.some(Boolean);
  return {
    rollScore: hasScoring ? 1 : 0,
    selectable,
    combo: null,
    comboConsumesAll: false,
  };
}

/**
 * Score a selection of dice (subset of a roll) with the same rules.
 * This must:
 * - validate the selection is purely scoring
 * - compute points for that selection
 *
 * We support:
 * - selecting all 6 to claim a combo
 * - selecting n-of-kind sets (3/4/5/6)
 * - selecting single 1s and 5s
 *
 * If selection includes non-scoring dice -> invalid
 */
function scoreSelection(selectedValues) {
  if (selectedValues.length === 0) return { ok: false, points: 0, detail: "No dice selected." };

  const counts = countFaces(selectedValues);

  // If selecting 6 dice, allow combos that consume all
  if (selectedValues.length === 6) {
    if (isStraight(counts)) return { ok: true, points: 1500, detail: "Straight (1–6) = 1500" };
    if (isThreePairs(counts)) return { ok: true, points: 1500, detail: "Three pairs = 1500" };
    if (isTwoTriplets(counts)) return { ok: true, points: 2500, detail: "Two triplets = 2500" };
    if (isFourPlusPair(counts)) return { ok: true, points: 1500, detail: "Four + pair = 1500" };
  }

  // Score n-of-kind sets
  let points = 0;
  let detailParts = [];

  // First, handle 3+ of a kind
  for (let face = 1; face <= 6; face++) {
    const n = counts[face];
    if (n >= 3) {
      const p = scoreNOfAKind(face, n);
      points += p;
      detailParts.push(`${n}×${face}${face === 1 ? "s" : "s"} = ${p}`);
      counts[face] = 0; // consume all of that face
    }
  }

  // Remaining dice must be only 1s or 5s as singles
  let ones = counts[1] || 0;
  let fives = counts[5] || 0;

  // Any remaining non-1/5 dice => invalid selection
  for (let face = 2; face <= 6; face++) {
    if (face === 5) continue;
    if (counts[face] > 0) {
      return { ok: false, points: 0, detail: "Selection contains non-scoring dice." };
    }
  }

  if (ones > 0) {
    const p = ones * 100;
    points += p;
    detailParts.push(`${ones}×1 = ${p}`);
  }
  if (fives > 0) {
    const p = fives * 50;
    points += p;
    detailParts.push(`${fives}×5 = ${p}`);
  }

  if (points <= 0) return { ok: false, points: 0, detail: "Selection has no scoring value." };
  return { ok: true, points, detail: detailParts.join(" + ") };
}

function rollDie() {
  return Math.floor(Math.random() * 6) + 1;
}

function makeCode(len = 5) {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // avoid O/0/I/1 confusion
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function newGameState() {
  return {
    stage: "WAITING", // WAITING | IN_PROGRESS | GAME_OVER
    scores: [0, 0],
    turnIndex: 0,
    dice: [0, 0, 0, 0, 0, 0],      // current face values
    kept: [false, false, false, false, false, false], // kept markers for this turn
    canRoll: false,   // after joining + game start, current player can roll
    canKeep: false,
    canBank: false,
    turnPoints: 0,
    lastAction: "—",
    winner: null,
    winningScore: 10000,
  };
}

const rooms = new Map();
// roomCode -> {
//   code, createdAt,
//   players: [{name, sid, online}, {name, sid, online}],
//   game: gameState
// }

function publicRoomState(room) {
  const g = room.game;
  return {
    code: room.code,
    players: room.players.map((p) => ({
      name: p?.name || "—",
      online: !!p?.online,
    })),
    game: {
      stage: g.stage,
      scores: g.scores,
      turnIndex: g.turnIndex,
      dice: g.dice,
      kept: g.kept,
      canRoll: g.canRoll,
      canKeep: g.canKeep,
      canBank: g.canBank,
      turnPoints: g.turnPoints,
      lastAction: g.lastAction,
      winner: g.winner,
      winningScore: g.winningScore,
    },
  };
}

function broadcastRoom(room) {
  io.to(room.code).emit("room:update", publicRoomState(room));
}

function currentPlayerSid(room) {
  const p = room.players[room.game.turnIndex];
  return p?.sid || null;
}

function ensureInProgress(room) {
  const g = room.game;
  if (room.players[0]?.name && room.players[1]?.name) {
    if (g.stage === "WAITING") {
      g.stage = "IN_PROGRESS";
      g.turnIndex = 0; // player 0 starts
      g.turnPoints = 0;
      g.kept = [false, false, false, false, false, false];
      g.dice = [0, 0, 0, 0, 0, 0];
      g.canRoll = true;
      g.canKeep = false;
      g.canBank = false;
      g.lastAction = "Both players joined. Player 1 to roll.";
    }
  }
}

function endTurn(room, reasonText) {
  const g = room.game;
  g.turnPoints = 0;
  g.kept = [false, false, false, false, false, false];
  g.dice = [0, 0, 0, 0, 0, 0];
  g.turnIndex = g.turnIndex === 0 ? 1 : 0;
  g.canRoll = true;
  g.canKeep = false;
  g.canBank = false;
  g.lastAction = reasonText || "Turn ended.";
}

function isMyTurn(room, sid) {
  return currentPlayerSid(room) === sid;
}

io.on("connection", (socket) => {
  socket.emit("hello", { ok: true });

  socket.on("room:create", ({ name }) => {
    const cleanName = (name || "").trim().slice(0, 20) || "Captain";
    let code = makeCode(5);
    while (rooms.has(code)) code = makeCode(5);

    const room = {
      code,
      createdAt: Date.now(),
      players: [
        { name: cleanName, sid: socket.id, online: true },
        null,
      ],
      game: newGameState(),
    };

    rooms.set(code, room);
    socket.join(code);
    room.game.lastAction = `${cleanName} created table. Waiting for opponent…`;
    broadcastRoom(room);
    socket.emit("room:joined", { code, seat: 0, name: cleanName });
  });

  socket.on("room:join", ({ code, name }) => {
    const roomCode = (code || "").trim().toUpperCase();
    const room = rooms.get(roomCode);
    if (!room) {
      socket.emit("error:modal", {
        title: "Table not found",
        body: "That table code doesn’t exist. Check the code and try again.",
      });
      return;
    }

    const cleanName = (name || "").trim().slice(0, 20) || "Captain";

    // Try to reclaim seat by name if offline
    for (let i = 0; i < 2; i++) {
      const p = room.players[i];
      if (p && !p.sid && p.name.toLowerCase() === cleanName.toLowerCase()) {
        p.sid = socket.id;
        p.online = true;
        socket.join(roomCode);
        ensureInProgress(room);
        room.game.lastAction = `${p.name} rejoined.`;
        broadcastRoom(room);
        socket.emit("room:joined", { code: roomCode, seat: i, name: p.name });
        return;
      }
    }

    // Otherwise fill empty seat
    if (!room.players[1]) {
      room.players[1] = { name: cleanName, sid: socket.id, online: true };
      socket.join(roomCode);
      ensureInProgress(room);
      room.game.lastAction = `${cleanName} joined table.`;
      broadcastRoom(room);
      socket.emit("room:joined", { code: roomCode, seat: 1, name: cleanName });
      return;
    }

    socket.emit("error:modal", {
      title: "Table full",
      body: "That table already has two players.",
    });
  });

  socket.on("game:new", ({ code }) => {
    const room = rooms.get((code || "").trim().toUpperCase());
    if (!room) return;

    // Allow either player to reset
    const seat = room.players.findIndex((p) => p?.sid === socket.id);
    if (seat === -1) return;

    room.game = newGameState();
    ensureInProgress(room);
    room.game.lastAction = "New game started.";
    broadcastRoom(room);
  });

  socket.on("turn:roll", ({ code }) => {
    const room = rooms.get((code || "").trim().toUpperCase());
    if (!room) return;

    const g = room.game;

    if (g.stage !== "IN_PROGRESS") return;

    if (!isMyTurn(room, socket.id)) {
      socket.emit("error:toast", "Not your turn.");
      return;
    }
    if (!g.canRoll) {
      socket.emit("error:toast", "You can’t roll right now.");
      return;
    }

    // Roll all unkept dice
    for (let i = 0; i < 6; i++) {
      if (!g.kept[i]) g.dice[i] = rollDie();
    }

    // Evaluate unkept dice for scoring
    const unkeptValues = [];
    const mapIndex = []; // maps unkeptValues position -> die index 0..5
    for (let i = 0; i < 6; i++) {
      if (!g.kept[i]) {
        unkeptValues.push(g.dice[i]);
        mapIndex.push(i);
      }
    }

    const evalRes = evaluateRoll(unkeptValues);
    const hasScoring = evalRes.selectable.some(Boolean);

    if (!hasScoring) {
      // FARKLE: lose turn points, end turn immediately
      g.lastAction = `Farkle! No scoring dice. Turn ends.`;
      io.to(room.code).emit("modal:show", {
        title: "Farkle!",
        body: "No scoring dice. Your turn ends and you bank 0 points.",
        sticky: true,
      });
      endTurn(room, "Farkle — turn passed.");
      broadcastRoom(room);
      return;
    }

    // Player must choose scoring dice to keep (or can roll again only after keep)
    g.canRoll = false;
    g.canKeep = true;
    g.canBank = g.turnPoints > 0; // can bank only if they already have points
    g.lastAction = `Rolled: ${g.dice.join(", ")}`;
    broadcastRoom(room);

    // Send selectable map to clients (derived on client too, but keep server truth)
    io.to(room.code).emit("roll:selectable", {
      code: room.code,
      selectable: mapIndex.reduce((acc, dieIndex, pos) => {
        acc[dieIndex] = evalRes.selectable[pos];
        return acc;
      }, {}),
      comboHint: evalRes.combo,
      comboConsumesAll: evalRes.comboConsumesAll,
    });
  });

  socket.on("turn:keep", ({ code, selected }) => {
    const room = rooms.get((code || "").trim().toUpperCase());
    if (!room) return;

    const g = room.game;

    if (g.stage !== "IN_PROGRESS") return;

    if (!isMyTurn(room, socket.id)) {
      socket.emit("error:toast", "Not your turn.");
      return;
    }
    if (!g.canKeep) {
      socket.emit("error:toast", "You can’t keep right now.");
      return;
    }

    const sel = Array.isArray(selected) ? selected : [];
    const uniq = Array.from(new Set(sel.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 5)));

    if (uniq.length === 0) {
      socket.emit("error:toast", "Select scoring dice first.");
      return;
    }

    // Cannot keep already-kept dice
    for (const idx of uniq) {
      if (g.kept[idx]) {
        socket.emit("error:toast", "You selected a die that is already kept.");
        return;
      }
    }

    // Score selection values
    const selectedValues = uniq.map((i) => g.dice[i]);
    const scored = scoreSelection(selectedValues);
    if (!scored.ok) {
      socket.emit("error:modal", {
        title: "Invalid keep",
        body: scored.detail,
      });
      return;
    }

    // Apply keep
    for (const idx of uniq) g.kept[idx] = true;
    g.turnPoints += scored.points;

    // Hot dice?
    const allKept = g.kept.every(Boolean);
    if (allKept) {
      // Reset kept to allow rolling all 6 again in same turn
      g.kept = [false, false, false, false, false, false];
      g.dice = [0, 0, 0, 0, 0, 0];
      g.canRoll = true;
      g.canKeep = false;
      g.canBank = true; // can bank after scoring
      g.lastAction = `KEEP ${scored.points} (${scored.detail}). HOT DICE! Roll all 6.`;
      io.to(room.code).emit("modal:show", {
        title: "Hot Dice!",
        body: `You used all 6 dice for scoring and earned ${scored.points} points.\nHot Dice: roll all 6 again.`,
        sticky: false,
      });
      broadcastRoom(room);
      return;
    }

    // Otherwise: may roll remaining dice or bank
    g.canRoll = true;
    g.canKeep = false;
    g.canBank = true;
    g.lastAction = `KEEP ${scored.points} (${scored.detail}). Turn points: ${g.turnPoints}.`;
    broadcastRoom(room);
  });

  socket.on("turn:bank", ({ code }) => {
    const room = rooms.get((code || "").trim().toUpperCase());
    if (!room) return;

    const g = room.game;

    if (g.stage !== "IN_PROGRESS") return;

    if (!isMyTurn(room, socket.id)) {
      socket.emit("error:toast", "Not your turn.");
      return;
    }
    if (!g.canBank) {
      socket.emit("error:toast", "You can’t bank right now.");
      return;
    }
    if (g.turnPoints <= 0) {
      socket.emit("error:toast", "You have 0 turn points.");
      return;
    }

    const t = g.turnIndex;
    g.scores[t] += g.turnPoints;

    const scorerName = room.players[t]?.name || `Player ${t + 1}`;
    const banked = g.turnPoints;

    // Check win
    if (g.scores[t] >= g.winningScore) {
      g.stage = "GAME_OVER";
      g.winner = t;
      g.lastAction = `${scorerName} BANKED ${banked} and wins with ${g.scores[t]}!`;
      broadcastRoom(room);

      io.to(room.code).emit("modal:show", {
        title: "Game Over",
        body: `${scorerName} wins!\nFinal score: ${g.scores[0]} – ${g.scores[1]}`,
        sticky: true,
      });
      return;
    }

    // End turn normally
    io.to(room.code).emit("modal:show", {
      title: "Banked",
      body: `${scorerName} banked ${banked} points.\nTurn passes to the other player.`,
      sticky: false,
    });

    endTurn(room, `${scorerName} banked ${banked}. Turn passed.`);
    broadcastRoom(room);
  });

  socket.on("room:sync", ({ code }) => {
    const room = rooms.get((code || "").trim().toUpperCase());
    if (!room) return;
    socket.join(room.code);
    ensureInProgress(room);
    broadcastRoom(room);
  });

  socket.on("disconnect", () => {
    // Mark any player with this sid as offline
    for (const room of rooms.values()) {
      for (let i = 0; i < 2; i++) {
        const p = room.players[i];
        if (p && p.sid === socket.id) {
          p.sid = null;
          p.online = false;
          room.game.lastAction = `${p.name} disconnected.`;
          broadcastRoom(room);
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
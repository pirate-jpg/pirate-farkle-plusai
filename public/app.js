// public/app.js (FULL FILE) — Pirate Farkle client for server.js (2-player locked-down)
"use strict";

const socket = io();

const el = (id) => document.getElementById(id);

// Top
const connPill = el("connPill");

// Join UI
const joinBox = el("joinBox");
const tableBox = el("tableBox");
const nameInput = el("nameInput");
const roomInput = el("roomInput");
const createBtn = el("createBtn");
const joinBtn = el("joinBtn");
const codeValue = el("codeValue");

// Players
const p0Name = el("p0Name");
const p0Score = el("p0Score");
const p0Meta = el("p0Meta");
const p1Name = el("p1Name");
const p1Score = el("p1Score");
const p1Meta = el("p1Meta");
const p0Card = el("p0Card");
const p1Card = el("p1Card");

// Controls
const newGameBtn = el("newGameBtn");
const rollBtn = el("rollBtn");
const keepBtn = el("keepBtn");
const bankBtn = el("bankBtn");

// Game header
const turnPoints = el("turnPoints");
const keepDetail = el("keepDetail");
const turnTag = el("turnTag");
const turnHint = el("turnHint");

// Dice + log
const diceGrid = el("diceGrid");
const logEl = el("log");

// Modal + toast
const modalOverlay = el("modalOverlay");
const modalTitle = el("modalTitle");
const modalBody = el("modalBody");
const modalOkBtn = el("modalOkBtn");
const toast = el("toast");

// Client state
let state = null;
let selected = new Set(); // selected dice indices for KEEP
let lastModalTs = 0;

// ---------- Helpers ----------
function show(node) {
  if (!node) return;
  node.classList.remove("hidden");
}
function hide(node) {
  if (!node) return;
  node.classList.add("hidden");
}

function setConn(status) {
  if (!connPill) return;
  connPill.textContent = status;
  connPill.classList.toggle("ok", status === "Connected");
}

function toastMsg(msg) {
  if (!toast) {
    alert(msg);
    return;
  }
  toast.textContent = msg;
  toast.classList.remove("hidden");
  clearTimeout(toastMsg._t);
  toastMsg._t = setTimeout(() => toast.classList.add("hidden"), 2200);
}

function openModal(title, body) {
  if (!modalOverlay) return;
  modalTitle.textContent = title || "Notice";
  modalBody.textContent = body || "—";
  modalOverlay.classList.remove("hidden");
}
function closeModal() {
  if (!modalOverlay) return;
  modalOverlay.classList.add("hidden");
}

// Scoring (client-side preview only; server remains authoritative)
function scoreDice(values) {
  const counts = {1:0,2:0,3:0,4:0,5:0,6:0};
  for (const v of values) counts[v]++;

  const totalDice = values.length;

  const threeKindBase = (face) => (face === 1 ? 1000 : face * 100);

  // Special combos (only when selecting 6)
  if (totalDice === 6) {
    let straight = true;
    for (let f = 1; f <= 6; f++) if (counts[f] !== 1) { straight = false; break; }
    if (straight) return { score: 1500, detail: "Straight (1–6) = 1500" };

    const pairs = Object.keys(counts).filter(f => counts[f] === 2);
    if (pairs.length === 3) return { score: 1500, detail: "Three pairs = 1500" };

    const trips = Object.keys(counts).filter(f => counts[f] === 3);
    if (trips.length === 2) return { score: 2500, detail: "Two triplets = 2500" };

    const four = Object.keys(counts).find(f => counts[f] === 4);
    const pair = Object.keys(counts).find(f => counts[f] === 2);
    if (four && pair) return { score: 1500, detail: "4 of a kind + a pair = 1500" };
  }

  let score = 0;
  const parts = [];

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
      parts.push(`${c}×${face}=${pts}`);
      counts[face] = 0;
    }
  }

  if (counts[1] > 0) { score += counts[1] * 100; parts.push(`${counts[1]}×1=${counts[1]*100}`); }
  if (counts[5] > 0) { score += counts[5] * 50; parts.push(`${counts[5]}×5=${counts[5]*50}`); }

  if (score === 0) return { score: 0, detail: "No scoring dice" };
  return { score, detail: parts.join(" + ") };
}

function myIndex() {
  return state?.youIndex ?? null;
}
function isMyTurn() {
  const me = myIndex();
  if (me === null) return false;
  return state?.turnIndex === me;
}
function playerLabel(i) {
  const p = state?.players?.[i];
  return p?.name || (i === 0 ? "Player 1" : "Player 2");
}

// ---------- Rendering ----------
function renderPlayers() {
  if (!state) return;

  const p0 = state.players?.[0] || { name: "—", score: 0 };
  const p1 = state.players?.[1] || { name: "—", score: 0 };

  p0Name.textContent = p0.name || "—";
  p0Score.textContent = String(p0.score ?? 0);
  p1Name.textContent = p1.name || "—";
  p1Score.textContent = String(p1.score ?? 0);

  const me = myIndex();
  const turn = state.turnIndex;

  p0Meta.textContent =
    state.started
      ? (turn === 0 ? "🎲 Turn" : "—")
      : "—";
  p1Meta.textContent =
    state.started
      ? (turn === 1 ? "🎲 Turn" : "—")
      : "—";

  // highlight cards
  p0Card?.classList.toggle("activeTurn", turn === 0);
  p1Card?.classList.toggle("activeTurn", turn === 1);

  if (me !== null) {
    p0Card?.classList.toggle("you", me === 0);
    p1Card?.classList.toggle("you", me === 1);
  }
}

function renderHeader() {
  if (!state) return;

  turnPoints.textContent = String(state.turnPoints ?? 0);

  if (!state.started) {
    turnTag.textContent = "Waiting…";
    turnHint.textContent = "Create or join a table to begin.";
    keepDetail.textContent = "—";
    return;
  }

  if (state.gameOver) {
    const w = state.winnerIndex;
    turnTag.textContent = "Game Over";
    turnHint.textContent = `${playerLabel(w)} won. Press New game to play again.`;
    keepDetail.textContent = "—";
    return;
  }

  const me = myIndex();
  const myTurn = isMyTurn();

  turnTag.textContent = myTurn ? "Your turn" : "Waiting…";
  turnHint.textContent = myTurn
    ? "Press ROLL, then tap dice to KEEP, or BANK."
    : `Waiting for ${playerLabel(state.turnIndex)}…`;

  // Preview selection scoring
  const idxs = [...selected];
  if (idxs.length === 0) {
    keepDetail.textContent = "—";
  } else {
    const vals = idxs.map(i => state.dice[i]);
    const sc = scoreDice(vals);
    keepDetail.textContent = sc.score > 0 ? `${sc.detail}` : "Selection doesn’t score";
  }
}

function renderLog() {
  if (!state || !logEl) return;
  logEl.innerHTML = "";
  const lines = state.log || [];
  for (const line of lines.slice(-60)) {
    const div = document.createElement("div");
    div.textContent = line;
    logEl.appendChild(div);
  }
  // auto scroll
  logEl.scrollTop = logEl.scrollHeight;
}

function renderDice() {
  if (!state || !diceGrid) return;

  diceGrid.innerHTML = "";

  const myTurn = isMyTurn();
  const dice = state.dice || [1,1,1,1,1,1];
  const keptMask = state.keptMask || [false,false,false,false,false,false];

  for (let i = 0; i < 6; i++) {
    const die = document.createElement("button");
    die.className = "die";
    die.type = "button";
    die.textContent = String(dice[i]);

    if (keptMask[i]) die.classList.add("kept");
    if (selected.has(i)) die.classList.add("selected");

    // disable die selection if not your turn or game not started or game over
    const selectable = myTurn && state.started && !state.gameOver && !keptMask[i];
    die.disabled = !selectable;

    die.onclick = () => {
      if (!selectable) return;
      if (selected.has(i)) selected.delete(i);
      else selected.add(i);
      renderHeader();
      renderDice(); // update selection highlight
    };

    diceGrid.appendChild(die);
  }

  // buttons enablement
  rollBtn.disabled = !(state.started && !state.gameOver && myTurn);
  keepBtn.disabled = !(state.started && !state.gameOver && myTurn && selected.size > 0);
  bankBtn.disabled = !(state.started && !state.gameOver && myTurn && (state.turnPoints ?? 0) > 0);
}

function renderJoinVsTable() {
  if (!state) {
    show(joinBox);
    hide(tableBox);
    return;
  }

  // If we have a code and youIndex, we’re “in”
  if (state.code && myIndex() !== null) {
    hide(joinBox);
    show(tableBox);
    codeValue.textContent = state.code;
    return;
  }

  // otherwise show join UI
  show(joinBox);
  hide(tableBox);
}

function renderModal() {
  if (!state) return;
  const m = state.modal;
  if (!m || !m.ts) return;

  // show only once per timestamp
  if (m.ts === lastModalTs) return;
  lastModalTs = m.ts;

  // If you’re not in the room yet, don’t modal spam
  // (but still allow “Table created” if you created)
  if (myIndex() === null && (m.title || "").toLowerCase().includes("table") === false) return;

  openModal(m.title, m.body);
}

function renderAll() {
  renderJoinVsTable();
  renderPlayers();
  renderHeader();
  renderDice();
  renderLog();
  renderModal();
}

// ---------- Actions ----------
function doCreate() {
  const nm = (nameInput.value || "").trim();
  if (!nm) return toastMsg("Enter a name.");
  // IMPORTANT: this must match server.js
  socket.emit("create_table", { name: nm });
}

function doJoin() {
  const nm = (nameInput.value || "").trim();
  const code = (roomInput.value || "").trim().toUpperCase();
  if (!nm) return toastMsg("Enter a name.");
  if (!code) return toastMsg("Enter a table code.");
  // IMPORTANT: this must match server.js
  socket.emit("join_table", { code, name: nm });
}

function doRoll() {
  if (!state || !isMyTurn()) return toastMsg("Not your turn.");
  socket.emit("roll");
  selected.clear();
}

function doKeep() {
  if (!state || !isMyTurn()) return toastMsg("Not your turn.");
  const idxs = [...selected].sort((a,b)=>a-b);
  if (idxs.length === 0) return toastMsg("Select dice to keep.");
  socket.emit("keep", { idxs });
  selected.clear();
}

function doBank() {
  if (!state || !isMyTurn()) return toastMsg("Not your turn.");
  socket.emit("bank");
  selected.clear();
}

function doNewGame() {
  socket.emit("new_game");
  selected.clear();
}

// ---------- Wire up UI ----------
createBtn?.addEventListener("click", doCreate);
joinBtn?.addEventListener("click", doJoin);
rollBtn?.addEventListener("click", doRoll);
keepBtn?.addEventListener("click", doKeep);
bankBtn?.addEventListener("click", doBank);
newGameBtn?.addEventListener("click", doNewGame);

modalOkBtn?.addEventListener("click", closeModal);

// Allow Enter to trigger create/join depending on what’s filled
nameInput?.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const code = (roomInput.value || "").trim();
  if (code) doJoin();
  else doCreate();
});
roomInput?.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  doJoin();
});

// ---------- Socket events ----------
socket.on("connect", () => {
  setConn("Connected");
});

socket.on("disconnect", () => {
  setConn("Disconnected");
});

socket.on("error_msg", (msg) => {
  toastMsg(String(msg || "Error"));
});

socket.on("state", (s) => {
  state = s;

  // If the other player farkled / banked etc, selections might be invalid now
  selected.clear();

  renderAll();
});

// initial paint
setConn("Disconnected");
renderAll();
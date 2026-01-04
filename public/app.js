// public/app.js
/* global io */

const socket = io();

let roomCode = "";
let myName = "";
let lastRoom = null;

// UI refs
const connPill = document.getElementById("connPill");

const joinBox = document.getElementById("joinBox");
const tableBox = document.getElementById("tableBox");

const nameInput = document.getElementById("nameInput");
const roomInput = document.getElementById("roomInput");
const createBtn = document.getElementById("createBtn");
const joinBtn = document.getElementById("joinBtn");
const newGameBtn = document.getElementById("newGameBtn");

const codeValue = document.getElementById("codeValue");
const p0Name = document.getElementById("p0Name");
const p1Name = document.getElementById("p1Name");
const p0Score = document.getElementById("p0Score");
const p1Score = document.getElementById("p1Score");
const p0Meta = document.getElementById("p0Meta");
const p1Meta = document.getElementById("p1Meta");

const turnPointsEl = document.getElementById("turnPoints");
const keepDetail = document.getElementById("keepDetail");
const turnTag = document.getElementById("turnTag");
const turnHint = document.getElementById("turnHint");

const diceGrid = document.getElementById("diceGrid");
const rollBtn = document.getElementById("rollBtn");
const keepBtn = document.getElementById("keepBtn");
const bankBtn = document.getElementById("bankBtn");

const logEl = document.getElementById("log");

const modalOverlay = document.getElementById("modalOverlay");
const modalTitle = document.getElementById("modalTitle");
const modalBody = document.getElementById("modalBody");
const modalOkBtn = document.getElementById("modalOkBtn");

const toastEl = document.getElementById("toast");

let selected = [false, false, false, false, false, false];

function setConn(connected) {
  connPill.textContent = connected ? "Connected" : "Disconnected";
  connPill.classList.toggle("connected", connected);
  connPill.classList.toggle("disconnected", !connected);
}

function showToast(msg, ms = 1800) {
  toastEl.textContent = msg;
  toastEl.classList.remove("hidden");
  setTimeout(() => toastEl.classList.add("hidden"), ms);
}

function showModal(title, body) {
  modalTitle.textContent = title;
  modalBody.textContent = body;
  modalOverlay.classList.remove("hidden");
}

function hideModal() {
  modalOverlay.classList.add("hidden");
}

modalOkBtn.addEventListener("click", hideModal);

function getMySeat(room) {
  if (!room) return -1;
  const n = (myName || "").trim().toLowerCase();
  if (!n) return -1;
  const p0 = (room.players[0]?.name || "").toLowerCase();
  const p1 = (room.players[1]?.name || "").toLowerCase();
  if (p0 === n) return 0;
  if (p1 === n) return 1;
  return -1;
}

function render(room) {
  lastRoom = room;

  // Top / table box toggles
  if (room?.code) {
    joinBox.classList.add("hidden");
    tableBox.classList.remove("hidden");
    codeValue.textContent = room.code;
  } else {
    joinBox.classList.remove("hidden");
    tableBox.classList.add("hidden");
  }

  // Players
  const players = room.players || [];
  p0Name.textContent = players[0]?.name ?? "—";
  p1Name.textContent = players[1]?.name ?? "—";
  p0Score.textContent = players[0]?.score ?? 0;
  p1Score.textContent = players[1]?.score ?? 0;

  p0Meta.textContent = players[0]?.online ? "Online" : "Offline";
  p1Meta.textContent = players[1]?.online ? "Online" : "Offline";

  // Game
  const g = room.game || {};
  const mySeat = getMySeat(room);

  // Turn header
  turnPointsEl.textContent = g.turnPoints ?? 0;

  const status = g.status || "waiting";

  if (status === "over") {
    turnTag.textContent = "Game over";
    const winnerSeat = g.winner;
    const winnerName = winnerSeat === 0 ? players[0]?.name : players[1]?.name;
    turnHint.textContent = `${winnerName || "Someone"} wins.`;
    showModal("🏴‍☠️ Game Over", `${winnerName || "Someone"} wins!`);
  } else if (status === "waiting") {
    turnTag.textContent = "Waiting…";
    turnHint.textContent = g.lastAction || "Create or join a table to begin.";
  } else {
    // playing
    const turnIndex = g.turnIndex ?? 0;
    const turnName = players[turnIndex]?.name || "—";
    const isMyTurn = mySeat !== -1 && turnIndex === mySeat;

    turnTag.textContent = isMyTurn ? "Your turn" : "Opponent’s turn";
    turnHint.textContent = g.lastAction || (isMyTurn ? "Press ROLL." : `Waiting for ${turnName}…`);
  }

  // Controls
  const isPlaying = status === "playing";
  const myTurn = isPlaying && (g.turnIndex === getMySeat(room));
  rollBtn.disabled = !myTurn || !g.canRoll;
  keepBtn.disabled = !myTurn || g.canRoll; // must have just rolled (canRoll false) to keep
  bankBtn.disabled = !myTurn || (g.turnPoints || 0) <= 0;

  // Dice render
  renderDice(g.dice || [1, 1, 1, 1, 1, 1], g.kept || [false, false, false, false, false, false], myTurn, g.canRoll);

  // Log
  const logLines = (g.log || []).slice(-10).map((x) => `• ${x.msg}`);
  logEl.textContent = logLines.join("\n") || "";
}

function dieFace(d) {
  // simple dots, but keep it pirate-ish
  const faces = ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];
  return faces[d] || String(d);
}

function renderDice(dice, kept, myTurn, canRoll) {
  diceGrid.innerHTML = "";
  const canSelect = myTurn && !canRoll; // after roll, before keep/bank

  for (let i = 0; i < 6; i++) {
    const btn = document.createElement("button");
    btn.className = "die";
    if (kept[i]) btn.classList.add("kept");
    if (selected[i]) btn.classList.add("selected");

    btn.innerHTML = `<div class="dieFace">${dieFace(dice[i])}</div><div class="dieNum">${dice[i]}</div>`;

    btn.disabled = !canSelect || kept[i];

    btn.addEventListener("click", () => {
      selected[i] = !selected[i];
      renderDice(dice, kept, myTurn, canRoll);
    });

    diceGrid.appendChild(btn);
  }

  keepDetail.textContent = canSelect
    ? "Select scoring dice, then press KEEP."
    : (myTurn ? "Press ROLL or BANK." : "—");
}

// Actions
createBtn.addEventListener("click", () => {
  myName = (nameInput.value || "").trim() || "Captain";
  socket.emit("room:create", { name: myName });
});

joinBtn.addEventListener("click", () => {
  myName = (nameInput.value || "").trim() || "Captain";
  const code = (roomInput.value || "").trim().toUpperCase();
  if (!code) return showToast("Enter a table code.");
  socket.emit("room:join", { code, name: myName });
});

newGameBtn.addEventListener("click", () => {
  if (!roomCode) return;
  socket.emit("game:new", { code: roomCode });
  showToast("New game requested.");
});

rollBtn.addEventListener("click", () => {
  if (!roomCode) return;
  selected = [false, false, false, false, false, false];
  socket.emit("game:roll", { code: roomCode });
});

keepBtn.addEventListener("click", () => {
  if (!roomCode) return;
  socket.emit("game:keep", { code: roomCode, select: selected });
  selected = [false, false, false, false, false, false];
});

bankBtn.addEventListener("click", () => {
  if (!roomCode) return;
  selected = [false, false, false, false, false, false];
  socket.emit("game:bank", { code: roomCode });
});

// Socket events
socket.on("connect", () => {
  setConn(true);
  // ✅ critical: include name so server can reclaim seat on reconnect
  if (roomCode) socket.emit("room:sync", { code: roomCode, name: myName });
});

socket.on("disconnect", () => setConn(false));

socket.on("room:update", (payload) => {
  roomCode = payload.code || roomCode;
  render(payload);
});

socket.on("toast", (t) => {
  showToast(t?.msg || "Something happened.");
});

// Set defaults
nameInput.value = "Captain Jim";
roomInput.value = "";
setConn(false);
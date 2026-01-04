// public/app.js
const socket = io();

let roomCode = null;
let mySeat = null;

let state = null;
let selected = new Set();

const $ = (id) => document.getElementById(id);

const connPill = $("connPill");
const joinBox = $("joinBox");
const tableBox = $("tableBox");
const codeValue = $("codeValue");

const nameInput = $("nameInput");
const roomInput = $("roomInput");
const createBtn = $("createBtn");
const joinBtn = $("joinBtn");
const newGameBtn = $("newGameBtn");

const p0Name = $("p0Name");
const p0Score = $("p0Score");
const p0Meta = $("p0Meta");
const p1Name = $("p1Name");
const p1Score = $("p1Score");
const p1Meta = $("p1Meta");

const turnPointsEl = $("turnPoints");
const keepDetail = $("keepDetail");
const turnTag = $("turnTag");
const turnHint = $("turnHint");

const diceGrid = $("diceGrid");
const rollBtn = $("rollBtn");
const keepBtn = $("keepBtn");
const bankBtn = $("bankBtn");

const logEl = $("log");

const modalOverlay = $("modalOverlay");
const modalTitle = $("modalTitle");
const modalBody = $("modalBody");
const modalOkBtn = $("modalOkBtn");
const toastEl = $("toast");

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove("hidden");
  setTimeout(() => toastEl.classList.add("hidden"), 1800);
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

function log(msg) {
  const line = document.createElement("div");
  line.className = "logLine";
  line.textContent = msg;
  logEl.prepend(line);
}

function setConnected(isConnected) {
  connPill.textContent = isConnected ? "Connected" : "Disconnected";
  connPill.classList.toggle("good", isConnected);
  connPill.classList.toggle("bad", !isConnected);
}

function uiInRoom(inRoom) {
  joinBox.classList.toggle("hidden", inRoom);
  tableBox.classList.toggle("hidden", !inRoom);
}

function diceChar(n) {
  // unicode dice 1-6
  const map = ["", "⚀","⚁","⚂","⚃","⚄","⚅"];
  return map[n] || "□";
}

function renderDice(dice, keptMask) {
  diceGrid.innerHTML = "";
  for (let i = 0; i < 6; i++) {
    const btn = document.createElement("button");
    btn.className = "die";
    const isKept = keptMask?.[i];
    const isSel = selected.has(i);

    btn.textContent = dice[i] ? diceChar(dice[i]) : "□";
    if (isKept) btn.classList.add("kept");
    if (isSel) btn.classList.add("selected");

    btn.disabled = !!isKept || !dice[i]; // can't select kept or empty
    btn.addEventListener("click", () => {
      if (selected.has(i)) selected.delete(i);
      else selected.add(i);
      renderDice(state.game.dice, state.game.keptMask);
    });

    diceGrid.appendChild(btn);
  }
}

function updateUI() {
  if (!state) return;

  codeValue.textContent = state.code || "—";

  // players
  p0Name.textContent = state.players[0].name;
  p0Score.textContent = String(state.players[0].score);
  p0Meta.textContent = state.players[0].online ? (mySeat === 0 ? "You" : "Online") : "Offline";

  p1Name.textContent = state.players[1].name;
  p1Score.textContent = String(state.players[1].score);
  p1Meta.textContent = state.players[1].online ? (mySeat === 1 ? "You" : "Online") : "Offline";

  // game header
  turnPointsEl.textContent = String(state.game.turnPoints || 0);

  const started = state.game.started;
  const finished = state.game.phase === "finished";

  if (!started) {
    turnTag.textContent = "Waiting…";
    turnHint.textContent = "Waiting for both players to join.";
  } else if (finished) {
    const winner = state.game.winnerSeat;
    turnTag.textContent = "Game over";
    turnHint.textContent = winner === null ? "—" : `${state.players[winner].name} wins!`;
    showModal("Game over", `${state.players[winner].name} wins!`);
  } else {
    const isMyTurn = mySeat === state.game.turnSeat;
    turnTag.textContent = isMyTurn ? "Your turn" : "Opponent's turn";
    if (state.game.phase === "must_roll") {
      turnHint.textContent = isMyTurn ? "Press ROLL." : "Waiting for opponent to roll.";
    } else if (state.game.phase === "selecting") {
      turnHint.textContent = isMyTurn ? "Select scoring dice, KEEP, then roll or BANK." : "Opponent selecting dice…";
    } else {
      turnHint.textContent = "—";
    }
  }

  keepDetail.textContent = state.game.lastAction || "—";

  renderDice(state.game.dice, state.game.keptMask);

  const canAct = started && !finished && mySeat === state.game.turnSeat;
  rollBtn.disabled = !canAct;
  keepBtn.disabled = !canAct || selected.size === 0;
  bankBtn.disabled = !canAct || (state.game.turnPoints || 0) <= 0;

  if (state.game.lastAction) log(state.game.lastAction);
}

createBtn.addEventListener("click", () => {
  const name = nameInput.value.trim() || "Player";
  socket.emit("create_table", { name });
});

joinBtn.addEventListener("click", () => {
  const name = nameInput.value.trim() || "Player";
  const code = roomInput.value.trim().toUpperCase();
  if (!code) return showToast("Enter a table code.");
  socket.emit("join_table", { code, name });
});

newGameBtn.addEventListener("click", () => {
  socket.emit("new_game");
});

rollBtn.addEventListener("click", () => {
  selected.clear();
  socket.emit("roll");
});

keepBtn.addEventListener("click", () => {
  const indices = [...selected.values()].sort((a,b)=>a-b);
  selected.clear();
  socket.emit("keep", { indices });
});

bankBtn.addEventListener("click", () => {
  selected.clear();
  socket.emit("bank");
});

// Socket events
socket.on("connect", () => setConnected(true));
socket.on("disconnect", () => setConnected(false));

socket.on("toast", ({ msg }) => showToast(msg));

socket.on("you_are", ({ code, seat }) => {
  roomCode = code;
  mySeat = seat;
  uiInRoom(true);
  showToast(`Joined table ${code} (seat ${seat}).`);
});

socket.on("state", (s) => {
  state = s;
  if (s?.code) {
    roomCode = s.code;
    uiInRoom(true);
  }
  updateUI();
});
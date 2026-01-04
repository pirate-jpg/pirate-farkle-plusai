/* public/app.js */
const socket = io();

let myRoomCode = null;
let mySeat = null; // 0 or 1
let currentState = null;

let selected = new Set();

const el = (id) => document.getElementById(id);

const connPill = el("connPill");

const joinBox = el("joinBox");
const tableBox = el("tableBox");
const nameInput = el("nameInput");
const roomInput = el("roomInput");
const createBtn = el("createBtn");
const joinBtn = el("joinBtn");

const codeValue = el("codeValue");

const p0Card = el("p0Card");
const p1Card = el("p1Card");
const p0Name = el("p0Name");
const p1Name = el("p1Name");
const p0Score = el("p0Score");
const p1Score = el("p1Score");
const p0Meta = el("p0Meta");
const p1Meta = el("p1Meta");

const newGameBtn = el("newGameBtn");

const turnPointsEl = el("turnPoints");
const keepDetailEl = el("keepDetail");
const turnTag = el("turnTag");
const turnHint = el("turnHint");

const diceGrid = el("diceGrid");

const rollBtn = el("rollBtn");
const keepBtn = el("keepBtn");
const bankBtn = el("bankBtn");

const logEl = el("log");

const modalOverlay = el("modalOverlay");
const modalTitle = el("modalTitle");
const modalBody = el("modalBody");
const modalOkBtn = el("modalOkBtn");

const toastEl = el("toast");

function showModal(title, message) {
  modalTitle.textContent = title || "Notice";
  modalBody.textContent = message || "";
  modalOverlay.classList.remove("hidden");
}

function hideModal() {
  modalOverlay.classList.add("hidden");
}

function toast(message) {
  toastEl.textContent = message || "";
  toastEl.classList.remove("hidden");
  setTimeout(() => toastEl.classList.add("hidden"), 1800);
}

modalOkBtn.addEventListener("click", hideModal);

socket.on("connect", () => {
  connPill.textContent = "Connected";
  connPill.classList.add("connected");
});

socket.on("disconnect", () => {
  connPill.textContent = "Disconnected";
  connPill.classList.remove("connected");
});

createBtn.addEventListener("click", () => {
  const name = (nameInput.value || "").trim() || "Player 1";
  socket.emit("room:create", { name });
});

joinBtn.addEventListener("click", () => {
  const name = (nameInput.value || "").trim() || "Player";
  const roomCode = (roomInput.value || "").trim().toUpperCase();
  if (!roomCode) {
    toast("Enter a table code.");
    return;
  }
  socket.emit("room:join", { roomCode, name });
});

newGameBtn.addEventListener("click", () => {
  if (!myRoomCode) return;
  socket.emit("game:new", { roomCode: myRoomCode });
});

rollBtn.addEventListener("click", () => {
  if (!myRoomCode) return;
  socket.emit("turn:roll", { roomCode: myRoomCode });
});

keepBtn.addEventListener("click", () => {
  if (!myRoomCode) return;
  socket.emit("turn:keep", { roomCode: myRoomCode, indices: [...selected] });
  // Clear local selection; server will update state
  selected.clear();
  renderDice();
});

bankBtn.addEventListener("click", () => {
  if (!myRoomCode) return;
  socket.emit("turn:bank", { roomCode: myRoomCode });
});

socket.on("room:joined", ({ roomCode, seatIndex }) => {
  myRoomCode = roomCode;
  mySeat = seatIndex;

  joinBox.classList.add("hidden");
  tableBox.classList.remove("hidden");

  codeValue.textContent = roomCode;
  toast(`Joined table ${roomCode}`);
});

socket.on("ui:modal", ({ title, message }) => {
  showModal(title, message);
});

socket.on("ui:toast", ({ message }) => {
  toast(message);
});

socket.on("room:update", (state) => {
  currentState = state;
  renderAll();
});

function renderAll() {
  if (!currentState) return;

  // Players
  const p0 = currentState.players[0];
  const p1 = currentState.players[1];

  p0Name.textContent = p0.name || "Player 1";
  p1Name.textContent = p1.name || "Player 2";
  p0Score.textContent = String(p0.score ?? 0);
  p1Score.textContent = String(p1.score ?? 0);
  p0Meta.textContent = p0.connected ? "Connected" : "Waiting…";
  p1Meta.textContent = p1.connected ? "Connected" : "Waiting…";

  // Highlight active turn
  p0Card.classList.toggle("activeTurn", currentState.started && currentState.currentTurn === 0);
  p1Card.classList.toggle("activeTurn", currentState.started && currentState.currentTurn === 1);

  // Turn UI
  turnPointsEl.textContent = String(currentState.turn.turnPoints ?? 0);
  keepDetailEl.textContent = currentState.turn.lastKeepDetail ? `Last keep: ${currentState.turn.lastKeepDetail}` : "—";

  if (!currentState.started) {
    turnTag.textContent = "Waiting…";
    turnTag.className = "tag";
    turnHint.textContent = "Waiting for both players to connect.";
  } else if (currentState.winnerIndex !== null) {
    const w = currentState.players[currentState.winnerIndex]?.name || "Winner";
    turnTag.textContent = "Game over";
    turnTag.className = "tag opponent";
    turnHint.textContent = `${w} won. Tap New game to play again.`;
  } else {
    const myTurn = (mySeat === currentState.currentTurn);
    turnTag.textContent = myTurn ? "Your turn" : "Opponent's turn";
    turnTag.className = myTurn ? "tag yourturn" : "tag opponent";
    const who = currentState.players[currentState.currentTurn]?.name || "Opponent";
    turnHint.textContent = myTurn
      ? "ROLL → select scoring dice → KEEP (repeat if you want) → BANK"
      : `${who} is playing…`;
  }

  renderDice();
  renderControls();
  renderLog();
}

function renderLog() {
  logEl.innerHTML = "";
  const lines = currentState.log || [];
  for (const line of lines) {
    const div = document.createElement("div");
    div.textContent = line;
    logEl.appendChild(div);
  }
}

function diceFaceChar(v) {
  // Simple dice glyph-like rendering
  return String(v);
}

function renderDice() {
  diceGrid.innerHTML = "";
  if (!currentState) return;

  const dice = currentState.turn.dice || [1,1,1,1,1,1];
  const kept = currentState.turn.kept || [false,false,false,false,false,false];

  for (let i = 0; i < 6; i++) {
    const die = document.createElement("div");
    die.className = "die";
    die.textContent = diceFaceChar(dice[i]);

    if (kept[i]) die.classList.add("kept");
    if (selected.has(i)) die.classList.add("selected");

    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent = kept[i] ? "kept" : (selected.has(i) ? "selected" : "");
    die.appendChild(sub);

    die.addEventListener("click", () => {
      // Only allow selecting unkept dice
      if (!currentState.started) return;
      if (currentState.winnerIndex !== null) return;
      if (kept[i]) return;

      // Only allow selecting on your turn (keeps confusion down)
      const myTurn = (mySeat === currentState.currentTurn);
      if (!myTurn) return;

      if (selected.has(i)) selected.delete(i);
      else selected.add(i);

      renderDice();
    });

    diceGrid.appendChild(die);
  }
}

function renderControls() {
  if (!currentState) return;

  const myTurn = currentState.started && currentState.winnerIndex === null && (mySeat === currentState.currentTurn);

  // Basic enable/disable
  rollBtn.disabled = !myTurn;
  keepBtn.disabled = !myTurn;
  bankBtn.disabled = !myTurn;

  // Refine based on turn state
  if (!myTurn) return;

  const hasRolled = !!currentState.turn.hasRolled;
  const canRoll = !!currentState.turn.canRoll;
  const turnPoints = Number(currentState.turn.turnPoints || 0);

  // Start of turn: you should roll; KEEP/BANK not useful yet
  if (!hasRolled) {
    rollBtn.disabled = false;
    keepBtn.disabled = true;
    bankBtn.disabled = true;
    return;
  }

  // After roll:
  // - You may KEEP if you have selected dice
  // - You may BANK if you have points
  // - You may ROLL if server says canRoll (after a valid keep)
  rollBtn.disabled = !canRoll;
  keepBtn.disabled = (selected.size === 0);
  bankBtn.disabled = (turnPoints <= 0);
}
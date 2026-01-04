// public/app.js
const socket = io();

const $ = (id) => document.getElementById(id);

const connPill = $("connPill");

const joinBox = $("joinBox");
const tableBox = $("tableBox");

const nameInput = $("nameInput");
const roomInput = $("roomInput");

const createBtn = $("createBtn");
const joinBtn = $("joinBtn");
const newGameBtn = $("newGameBtn");

const codeValue = $("codeValue");

const p0Name = $("p0Name"), p0Score = $("p0Score"), p0Meta = $("p0Meta");
const p1Name = $("p1Name"), p1Score = $("p1Score"), p1Meta = $("p1Meta");

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

// --- per-tab identity (THIS prevents your tab-vs-private tab collision)
function getClientId() {
  const key = "pirateFarkleClientId";
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = (crypto?.randomUUID?.() || Math.random().toString(16).slice(2) + Date.now().toString(16));
    sessionStorage.setItem(key, id);
  }
  return id;
}
const clientId = getClientId();

// Persist room + seat per tab
let roomCode = sessionStorage.getItem("pirateFarkleRoom") || null;
let mySeat = sessionStorage.getItem("pirateFarkleSeat");
mySeat = mySeat === null ? null : Number(mySeat);

function setJoined(code, seat) {
  roomCode = code;
  mySeat = seat;
  sessionStorage.setItem("pirateFarkleRoom", code);
  sessionStorage.setItem("pirateFarkleSeat", String(seat));
}

function clearJoined() {
  roomCode = null;
  mySeat = null;
  sessionStorage.removeItem("pirateFarkleRoom");
  sessionStorage.removeItem("pirateFarkleSeat");
}

function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}\n`;
  logEl.textContent = line + logEl.textContent;
}

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
modalOkBtn.addEventListener("click", () => modalOverlay.classList.add("hidden"));

function setConnected(isConnected) {
  connPill.textContent = isConnected ? "Connected" : "Disconnected";
  connPill.classList.toggle("connected", isConnected);
}

function setUIJoined(joined) {
  joinBox.classList.toggle("hidden", joined);
  tableBox.classList.toggle("hidden", !joined);
}

function renderDice(dice, held, canSelect) {
  diceGrid.innerHTML = "";
  for (let i = 0; i < 6; i++) {
    const die = document.createElement("div");
    die.className = "die" + (held[i] ? " held" : "");
    die.textContent = String(dice[i]);
    die.addEventListener("click", () => {
      if (!canSelect) return;
      socket.emit("turn:toggleHold", { idx: i });
    });
    diceGrid.appendChild(die);
  }
}

function updateFromState(state) {
  // Table
  codeValue.textContent = state.code || "—";

  const players = state.players || [];
  const a = players[0] || { name: "—", score: 0, online: false };
  const b = players[1] || { name: "—", score: 0, online: false };

  p0Name.textContent = a.name;
  p0Score.textContent = a.score;
  p0Meta.textContent = a.online ? "Online" : "Offline";

  p1Name.textContent = b.name;
  p1Score.textContent = b.score;
  p1Meta.textContent = b.online ? "Online" : "Offline";

  // Turn / controls
  turnPointsEl.textContent = String(state.turnPoints ?? 0);

  const bothJoined = players.every(p => p && p.name && p.name !== "—");

  const isMyTurn = (mySeat !== null) && (state.activeSeat === mySeat) && state.phase === "turn";
  const canRoll = !!state.canRoll;
  const canSelectDice = isMyTurn && !canRoll; // after roll, before keep/bank
  const canKeep = isMyTurn && !canRoll;       // must have rolled
  const canBank = isMyTurn;                   // can bank anytime on your turn

  if (!bothJoined) {
    turnTag.textContent = "Waiting…";
    turnHint.textContent = "Waiting for both players to join.";
  } else if (state.phase !== "turn") {
    turnTag.textContent = "Waiting…";
    turnHint.textContent = "Press New game to start.";
  } else if (isMyTurn) {
    turnTag.textContent = "Your turn";
    turnHint.textContent = canRoll ? "Press ROLL." : "Select scoring dice, then KEEP (or BANK).";
  } else {
    turnTag.textContent = "Opponent's turn";
    turnHint.textContent = "Waiting for opponent…";
  }

  rollBtn.disabled = !(isMyTurn && canRoll);
  keepBtn.disabled = !canKeep;
  bankBtn.disabled = !canBank;

  keepDetail.textContent = canSelectDice ? "Tap dice to select scoring dice." : "—";

  renderDice(state.dice || [1,1,1,1,1,1], state.held || [false,false,false,false,false,false], canSelectDice);
}

createBtn.addEventListener("click", () => {
  const name = (nameInput.value || "Player").trim();
  socket.emit("room:create", { name, clientId });
});

joinBtn.addEventListener("click", () => {
  const code = (roomInput.value || "").trim().toUpperCase();
  const name = (nameInput.value || "Player").trim();
  if (!code) return showToast("Enter a table code.");
  socket.emit("room:join", { code, name, clientId });
});

newGameBtn.addEventListener("click", () => socket.emit("game:new"));
rollBtn.addEventListener("click", () => socket.emit("turn:roll"));
keepBtn.addEventListener("click", () => socket.emit("turn:keep"));
bankBtn.addEventListener("click", () => socket.emit("turn:bank"));

socket.on("connect", () => {
  setConnected(true);
  log("Socket connected.");

  // If we previously joined (per tab), attempt re-join as reconnect
  if (roomCode && typeof mySeat === "number") {
    const name = (nameInput.value || "Player").trim();
    socket.emit("room:join", { code: roomCode, name, clientId });
  }
});

socket.on("disconnect", () => {
  setConnected(false);
  log("Socket disconnected.");
});

socket.on("room:joined", ({ code, seat }) => {
  setJoined(code, seat);
  setUIJoined(true);
  showToast(`Joined ${code} as seat ${seat}.`);
  log(`Joined room ${code} seat ${seat}.`);
});

socket.on("room:update", (state) => {
  // If we have a room state, consider ourselves in-table view.
  if (state && state.code) setUIJoined(true);
  updateFromState(state);
});

socket.on("toast", ({ msg }) => {
  if (msg) showToast(msg);
});

socket.on("modal", ({ title, body }) => {
  showModal(title || "Notice", body || "");
});
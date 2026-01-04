// public/app.js
(() => {
  const $ = (id) => document.getElementById(id);

  // UI refs (must match your existing index.html)
  const connPill = $("connPill");

  const joinBox = $("joinBox");
  const tableBox = $("tableBox");

  const nameInput = $("nameInput");
  const createBtn = $("createBtn");
  const roomInput = $("roomInput");
  const joinBtn = $("joinBtn");

  const codeValue = $("codeValue");
  const p0Name = $("p0Name");
  const p0Score = $("p0Score");
  const p0Meta = $("p0Meta");
  const p1Name = $("p1Name");
  const p1Score = $("p1Score");
  const p1Meta = $("p1Meta");

  const newGameBtn = $("newGameBtn");

  const turnPointsEl = $("turnPoints");
  const keepDetailEl = $("keepDetail");
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

  // Socket
  const socket = io();

  // Local client state (render-only)
  let mySeat = null; // 0 or 1
  let myName = "";
  let roomCode = "";

  let state = null;
  let selectableMap = {}; // dieIndex -> true/false for current roll
  let selected = new Set(); // die indices currently selected

  // ---------- UI helpers ----------
  function show(el) {
    el.classList.remove("hidden");
  }
  function hide(el) {
    el.classList.add("hidden");
  }

  function setConn(ok) {
    if (!connPill) return;
    connPill.textContent = ok ? "Connected" : "Disconnected";
    connPill.classList.toggle("ok", ok);
  }

  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.remove("hidden");
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => toastEl.classList.add("hidden"), 1800);
  }

  function modalShow(title, body, sticky) {
    modalTitle.textContent = title || "Notice";
    modalBody.textContent = body || "—";
    show(modalOverlay);
    modalOkBtn.dataset.sticky = sticky ? "1" : "0";
  }

  function modalHide() {
    hide(modalOverlay);
  }

  modalOkBtn.addEventListener("click", () => {
    // If sticky, still dismiss; "sticky" here means it MUST be acknowledged
    modalHide();
  });

  function logLine(text) {
    if (!logEl) return;
    const div = document.createElement("div");
    div.textContent = text;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function safeName() {
    return (nameInput.value || "").trim().slice(0, 20);
  }

  function safeCode() {
    return (roomInput.value || "").trim().toUpperCase();
  }

  // Dice rendering
  function dieFaceEmoji(n) {
    // Use simple pip glyphs (consistent on iOS/desktop)
    const map = {
      1: "⚀",
      2: "⚁",
      3: "⚂",
      4: "⚃",
      5: "⚄",
      6: "⚅",
    };
    return map[n] || "□";
  }

  function clearSelections() {
    selected.clear();
  }

  function canInteract() {
    if (!state) return false;
    if (mySeat === null) return false;
    if (state.game.stage !== "IN_PROGRESS") return false;
    return true;
  }

  function isMyTurn() {
    if (!state) return false;
    return mySeat === state.game.turnIndex;
  }

  function updateButtons() {
    if (!state) return;

    const g = state.game;
    const myTurn = isMyTurn();

    rollBtn.disabled = !(canInteract() && myTurn && g.canRoll);
    keepBtn.disabled = !(canInteract() && myTurn && g.canKeep);
    bankBtn.disabled = !(canInteract() && myTurn && g.canBank);

    // KEEP needs at least 1 selected die
    if (!keepBtn.disabled) {
      keepBtn.disabled = selected.size === 0;
    }
  }

  function renderDice() {
    if (!state) return;
    const g = state.game;

    diceGrid.innerHTML = "";
    clearSelections();
    selectableMap = selectableMap || {};

    // Show only if game is in progress
    if (g.stage !== "IN_PROGRESS") {
      updateButtons();
      return;
    }

    for (let i = 0; i < 6; i++) {
      const v = g.dice[i];
      const kept = g.kept[i];
      const isSelectable = !!selectableMap[i] && !kept && v !== 0;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "die";

      // basic classes (your CSS can style these)
      if (kept) btn.classList.add("kept");
      if (isSelectable) btn.classList.add("selectable");
      if (selected.has(i)) btn.classList.add("selected");

      btn.textContent = v ? dieFaceEmoji(v) : "□";

      btn.addEventListener("click", () => {
        if (!canInteract()) return;
        if (!isMyTurn()) return;
        if (!state.game.canKeep) return;

        // only allow selecting dice that server marked selectable (for the last roll)
        if (!isSelectable) return;

        if (selected.has(i)) selected.delete(i);
        else selected.add(i);

        // re-render selection classes without rebuilding everything
        renderDiceSelectionOnly();
        updateButtons();
      });

      diceGrid.appendChild(btn);
    }

    updateButtons();
  }

  function renderDiceSelectionOnly() {
    // updates button classes without recomputing content
    const buttons = diceGrid.querySelectorAll("button.die");
    buttons.forEach((btn, idx) => {
      btn.classList.toggle("selected", selected.has(idx));
    });
  }

  function render() {
    if (!state) return;

    // Join vs Table view
    if (roomCode) {
      hide(joinBox);
      show(tableBox);
      codeValue.textContent = roomCode;
    } else {
      show(joinBox);
      hide(tableBox);
    }

    // Players
    const p0 = state.players[0];
    const p1 = state.players[1];

    p0Name.textContent = p0?.name || "—";
    p1Name.textContent = p1?.name || "—";

    p0Meta.textContent = p0?.online ? "Online" : "Offline";
    p1Meta.textContent = p1?.online ? "Online" : "Offline";

    p0Score.textContent = String(state.game.scores?.[0] ?? 0);
    p1Score.textContent = String(state.game.scores?.[1] ?? 0);

    // Turn / status
    const g = state.game;

    turnPointsEl.textContent = String(g.turnPoints ?? 0);

    const myTurn = isMyTurn();
    const stage = g.stage;

    if (!roomCode) {
      turnTag.textContent = "Waiting…";
      turnHint.textContent = "Create or join a table to begin.";
    } else if (stage === "WAITING") {
      turnTag.textContent = "Waiting…";
      turnHint.textContent = "Waiting for a second player to join.";
    } else if (stage === "GAME_OVER") {
      turnTag.textContent = "Game over";
      const winner = g.winner === 0 ? p0?.name : p1?.name;
      turnHint.textContent = `${winner || "Someone"} won. Press New game to play again.`;
    } else {
      turnTag.textContent = myTurn ? "Your turn" : "Opponent’s turn";
      turnHint.textContent = myTurn
        ? (g.canRoll ? "Press ROLL." : g.canKeep ? "Select scoring dice, then press KEEP." : g.canBank ? "BANK or ROLL." : "Waiting…")
        : "Waiting for opponent…";
    }

    // Keep detail / last action
    keepDetailEl.textContent = g.lastAction || "—";

    // Dice + buttons
    renderDice();

    // Log (keep it simple: show last actions as they change)
    // We'll add one log line per state update (not too spammy)
    if (g.lastAction && (!render._lastAction || render._lastAction !== g.lastAction)) {
      logLine(g.lastAction);
      render._lastAction = g.lastAction;
    }

    updateButtons();
  }

  // ---------- Socket events ----------
  socket.on("connect", () => {
    setConn(true);
    if (roomCode) socket.emit("room:sync", { code: roomCode });
  });

  socket.on("disconnect", () => {
    setConn(false);
  });

  socket.on("hello", () => {
    setConn(true);
  });

  socket.on("room:joined", ({ code, seat, name }) => {
    roomCode = code;
    mySeat = seat;
    myName = name;
    toast(`Joined table ${code}`);
    socket.emit("room:sync", { code: roomCode });
  });

  socket.on("room:update", (st) => {
    state = st;

    // If room exists but we haven't recorded code (e.g. reload), keep it.
    if (st?.code && !roomCode) roomCode = st.code;

    // If mySeat is unknown after reload, attempt to infer (best-effort)
    // (We can't know reliably without server session; keep mySeat as-is.)
    render();
  });

  socket.on("roll:selectable", ({ selectable, comboHint, comboConsumesAll }) => {
    selectableMap = selectable || {};
    clearSelections();

    if (comboHint && comboConsumesAll) {
      toast(`Combo available: ${comboHint}`);
    } else {
      // normal roll
      // no toast needed every time
    }

    renderDice();
    updateButtons();
  });

  socket.on("modal:show", ({ title, body, sticky }) => {
    modalShow(title, body, sticky);
  });

  socket.on("error:modal", ({ title, body }) => {
    modalShow(title || "Error", body || "—", true);
  });

  socket.on("error:toast", (msg) => {
    toast(msg || "Error");
  });

  // ---------- Button handlers ----------
  createBtn.addEventListener("click", () => {
    const name = safeName();
    if (!name) {
      modalShow("Name required", "Please enter your name first.", true);
      return;
    }
    socket.emit("room:create", { name });
  });

  joinBtn.addEventListener("click", () => {
    const name = safeName();
    const code = safeCode();
    if (!name) {
      modalShow("Name required", "Please enter your name first.", true);
      return;
    }
    if (!code) {
      modalShow("Code required", "Please enter a table code.", true);
      return;
    }
    socket.emit("room:join", { code, name });
  });

  newGameBtn.addEventListener("click", () => {
    if (!roomCode) return;
    socket.emit("game:new", { code: roomCode });
  });

  rollBtn.addEventListener("click", () => {
    if (!roomCode) return;
    if (!isMyTurn()) {
      toast("Not your turn.");
      return;
    }
    // Clear old selection map; server will send fresh selectable after roll
    selectableMap = {};
    clearSelections();
    socket.emit("turn:roll", { code: roomCode });
  });

  keepBtn.addEventListener("click", () => {
    if (!roomCode) return;
    if (!isMyTurn()) {
      toast("Not your turn.");
      return;
    }
    const arr = Array.from(selected);
    if (arr.length === 0) {
      toast("Select scoring dice first.");
      return;
    }
    socket.emit("turn:keep", { code: roomCode, selected: arr });
    // client clears selection; server state will come back
    clearSelections();
    updateButtons();
  });

  bankBtn.addEventListener("click", () => {
    if (!roomCode) return;
    if (!isMyTurn()) {
      toast("Not your turn.");
      return;
    }
    socket.emit("turn:bank", { code: roomCode });
  });

  // Initial UI state
  setConn(false);
  render();
})();
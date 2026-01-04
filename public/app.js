const socket = io();

const status = document.getElementById("status");
const tableInfo = document.getElementById("tableInfo");
const turnStatus = document.getElementById("turnStatus");

let myIndex = null;
let roomCode = null;

socket.on("connect", () => {
  status.textContent = "Connected";
});

socket.on("tableJoined", ({ code, playerIndex }) => {
  roomCode = code;
  myIndex = playerIndex;
});

socket.on("tableUpdate", (room) => {
  tableInfo.innerHTML = `
    <div>Table code: <strong>${roomCode}</strong></div>
    ${room.players.map((p, i) =>
      `<div>${p.name} ${room.turn === i ? "(turn)" : ""}</div>`
    ).join("")}
  `;
  turnStatus.textContent =
    room.turn === myIndex ? "Your turn" : "Opponent’s turn";
});

document.getElementById("createBtn").onclick = () => {
  socket.emit("createTable", {
    name: document.getElementById("nameInput").value || "Player"
  });
};

document.getElementById("joinBtn").onclick = () => {
  socket.emit("joinTable", {
    code: document.getElementById("codeInput").value.toUpperCase(),
    name: document.getElementById("nameInput").value || "Player"
  });
};
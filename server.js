const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static("public"));

const rooms = {}; 
// rooms[code] = { players: [{ id, name, socketId }], turn: 0 }

function makeCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

io.on("connection", (socket) => {
  console.log("connected:", socket.id);

  socket.on("createTable", ({ name }) => {
    const code = makeCode();
    rooms[code] = {
      players: [{ id: 0, name, socketId: socket.id }],
      turn: 0
    };

    socket.join(code);
    socket.emit("tableJoined", { code, playerIndex: 0 });
    io.to(code).emit("tableUpdate", rooms[code]);
  });

  socket.on("joinTable", ({ code, name }) => {
    const room = rooms[code];
    if (!room || room.players.length >= 2) {
      socket.emit("errorMsg", "Unable to join table");
      return;
    }

    const playerIndex = room.players.length;
    room.players.push({ id: playerIndex, name, socketId: socket.id });

    socket.join(code);
    socket.emit("tableJoined", { code, playerIndex });
    io.to(code).emit("tableUpdate", room);
  });

  socket.on("disconnect", () => {
    console.log("disconnected:", socket.id);

    for (const code in rooms) {
      const room = rooms[code];
      const idx = room.players.findIndex(p => p.socketId === socket.id);
      if (idx !== -1) {
        room.players.splice(idx, 1);
        io.to(code).emit("tableUpdate", room);

        if (room.players.length === 0) {
          delete rooms[code];
        }
        break;
      }
    }
  });
});

server.listen(PORT, () => {
  console.log("Server running on", PORT);
});
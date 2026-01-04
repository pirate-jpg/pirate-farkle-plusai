// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Railway / production port handling
const PORT = process.env.PORT || 3000;

// Serve static files later (frontend will live in /public)
app.use(express.static("public"));

// Basic health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", game: "pirate-farkle-plusai" });
});

// Socket.IO
io.on("connection", (socket) => {
  console.log("Player connected:", socket.id);

  socket.on("disconnect", () => {
    console.log("Player disconnected:", socket.id);
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`🏴‍☠️ Pirate Farkle server listening on port ${PORT}`);
});

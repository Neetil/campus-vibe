const { Server } = require('socket.io');
const http = require('http');

const server = http.createServer();
const io = new Server(server, {
  cors: { origin: '*' }, // Update as needed for prod
});

let waiting = null; // Holds a single waiting socket
const partners = new Map(); // Map: socket.id -> partnerSocket.id

io.on('connection', (socket) => {
  // Handle new user ready for chat
  socket.on('findPartner', () => {
    if (waiting && waiting.id !== socket.id) {
      partners.set(socket.id, waiting.id);
      partners.set(waiting.id, socket.id);
      socket.emit('partnerFound');
      waiting.emit('partnerFound');
      waiting = null;
    } else {
      waiting = socket;
    }
  });

  // Relay chat message
  socket.on('chatMessage', (msg) => {
    const partnerId = partners.get(socket.id);
    if (partnerId && io.sockets.sockets.get(partnerId)) {
      io.sockets.sockets.get(partnerId).emit('chatMessage', msg);
    }
  });

  // Handle "next" (disconnect current, look for new)
  socket.on('next', () => {
    const partnerId = partners.get(socket.id);
    if (partnerId && io.sockets.sockets.get(partnerId)) {
      io.sockets.sockets.get(partnerId).emit('partnerDisconnected');
      partners.delete(partnerId);
    }
    partners.delete(socket.id);
    waiting = socket;
    socket.emit('waiting');
    socket.emit('findPartner');
  });

  // Handle leave/disconnect
  socket.on('disconnect', () => {
    if (waiting && waiting.id === socket.id) {
      waiting = null;
    }
    const partnerId = partners.get(socket.id);
    if (partnerId && io.sockets.sockets.get(partnerId)) {
      io.sockets.sockets.get(partnerId).emit('partnerDisconnected');
      partners.delete(partnerId);
    }
    partners.delete(socket.id);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Socket.IO server listening on port ${PORT}`);
});

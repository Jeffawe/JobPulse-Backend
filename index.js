import app from './app.js';
import http from 'http';
import { initializeSocketServer } from './services/memoryStore.js';

// Create HTTP server
const server = http.createServer(app);

// Attach Socket.IO to the same server
initializeSocketServer(server);

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
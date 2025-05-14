import app from './app.js';
import http from 'http';
import { initializeSocketServer } from './services/memoryStore.js';
import './cron/cronJobs.js'
import { monitorMemory, monitorSystem, sendAlert } from './middleware/monitor.js';

// Create HTTP server
const server = http.createServer(app);

// Attach Socket.IO to the same server
initializeSocketServer(server);

const PORT = process.env.PORT || 3000;

setInterval(async () => {
  try {
    await monitorSystem()
    await monitorMemory()
  } catch (err) {
    sendAlert(`Application error: ${err.message}`);
  }
}, 12 * 60 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
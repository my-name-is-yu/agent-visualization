import express from 'express';
import { config } from './config.js';
import { sseClients, runCleanup, initState } from './state.js';
import stateRoutes from './routes/state.js';
import sseRoutes from './routes/sse.js';
import eventRoutes from './routes/event.js';
import completeRoutes from './routes/complete.js';
import approvalRoutes from './routes/approval.js';

// Initialize SQLite + load state
initState();

const app = express();
app.use(express.json({ limit: '5mb' }));

// Mount routes
app.use(stateRoutes);
app.use(sseRoutes);
app.use(eventRoutes);
app.use(completeRoutes);
app.use(approvalRoutes);

// SSE keep-alive
setInterval(() => {
  for (const client of sseClients) {
    try {
      client.write(':keepalive\n\n');
    } catch {
      sseClients.delete(client);
    }
  }
}, config.sseKeepAliveMs);

// Background cleanup
setInterval(runCleanup, config.cleanupIntervalMs);

// Start server
app.listen(config.port, '127.0.0.1', () => {
  console.log(`Agent visualization server running on http://localhost:${config.port}`);
});

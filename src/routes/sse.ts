import { Router } from 'express';
import { sseClients } from '../state.js';

const router = Router();

// GET /events - SSE stream for state change notifications
router.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write('\n');
  sseClients.add(res);
  req.on('close', () => {
    sseClients.delete(res);
  });
});

export default router;

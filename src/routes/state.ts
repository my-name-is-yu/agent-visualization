import { Router } from 'express';
import { buildState, resetState, setLastEventTime, notifyClients } from '../state.js';

const router = Router();

// GET /state - return current state for polling clients (menu bar app)
router.get('/state', (_req, res) => {
  const state = buildState();
  res.json(state);
});

// POST /heartbeat - lightweight Boss activity signal
router.post('/heartbeat', (_req, res) => {
  setLastEventTime(Date.now());
  notifyClients();
  res.json({ ok: true });
});

// POST /reset - clear all state
router.post('/reset', (_req, res) => {
  resetState();
  res.json({ ok: true, message: 'State cleared' });
});

export default router;

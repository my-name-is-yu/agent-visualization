import { Router } from 'express';
import { buildState, resetState, onHeartbeat, onTurnDone, notifyClients, setMenuOpen } from '../state.js';

const router = Router();

// GET /state - return current state for polling clients (menu bar app)
router.get('/state', (_req, res) => {
  const state = buildState();
  res.json(state);
});

// POST /heartbeat - Boss turn started
router.post('/heartbeat', (req, res) => {
  const sessionId = req.body?.session_id as string | undefined;
  onHeartbeat(Date.now(), sessionId);
  notifyClients();
  res.json({ ok: true });
});

// POST /turn-done - Boss turn finished
router.post('/turn-done', (req, res) => {
  const sessionId = req.body?.session_id as string | undefined;
  onTurnDone(Date.now(), sessionId);
  notifyClients();
  res.json({ ok: true });
});

// POST /menu-open - notify server of menu open/close state
router.post('/menu-open', (req, res) => {
  const open = req.body?.open === true;
  setMenuOpen(open);
  res.json({ ok: true });
});

// POST /reset - clear all state
router.post('/reset', (_req, res) => {
  resetState();
  res.json({ ok: true, message: 'State cleared' });
});

export default router;

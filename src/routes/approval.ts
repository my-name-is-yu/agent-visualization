import { Router } from 'express';
import crypto from 'crypto';
import { ApprovalRequestSchema, ApprovalRespondSchema } from '../types.js';
import {
  pendingApprovals, approvalDecisions, approvalEnabled, setApprovalEnabled,
  notifyClients, setApprovalCleanupHandler,
} from '../state.js';
import type { Response } from 'express';

const router = Router();

// Waiters for long-poll: requestId → list of { res, timer } pairs
interface ApprovalWaiter {
  res: Response;
  timer: ReturnType<typeof setTimeout>;
}
const approvalWaiters = new Map<string, ApprovalWaiter[]>();

/** Resolve all waiters for a given requestId with the decision */
export function resolveApprovalWaiters(requestId: string, decision: string): void {
  const waiters = approvalWaiters.get(requestId);
  if (waiters) {
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      try {
        if (!waiter.res.headersSent) {
          waiter.res.json({ status: 'decided', decision });
        }
      } catch { /* client already disconnected */ }
    }
    approvalWaiters.delete(requestId);
  }
}

// POST /approval/request - Hook sends approval request
router.post('/approval/request', (req, res) => {
  if (!approvalEnabled) {
    res.json({ status: 'auto_approved' });
    return;
  }
  const parsed = ApprovalRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { toolName, toolInput, sessionId } = parsed.data;
  const requestId = crypto.randomUUID();
  pendingApprovals.set(requestId, {
    requestId,
    toolName,
    toolInput: toolInput as Record<string, unknown>,
    sessionId,
    createdAt: new Date().toISOString(),
  });
  notifyClients();
  res.json({ status: 'pending', requestId });
});

// GET /approval/response/:id - Hook waits for decision (long-poll)
// ?wait=<seconds> — hold connection until decision arrives or timeout (default: 0 = instant)
router.get('/approval/response/:id', (req, res) => {
  const { id } = req.params;

  // Already decided → respond immediately
  const decision = approvalDecisions.get(id);
  if (decision) {
    res.json({ status: 'decided', decision: decision.decision });
    return;
  }

  // Unknown request
  if (!pendingApprovals.has(id)) {
    res.json({ status: 'unknown' });
    return;
  }

  // Long-poll: wait for decision
  const waitSec = Math.min(Math.max(parseInt(String(req.query.wait)) || 0, 0), 55);
  if (waitSec === 0) {
    res.json({ status: 'pending' });
    return;
  }

  // Timeout → respond pending and clean up
  const removeWaiter = (waiter: ApprovalWaiter) => {
    const waiters = approvalWaiters.get(id);
    if (waiters) {
      const idx = waiters.indexOf(waiter);
      if (idx !== -1) waiters.splice(idx, 1);
      if (waiters.length === 0) approvalWaiters.delete(id);
    }
  };

  const timer = setTimeout(() => {
    removeWaiter(waiter);
    if (!res.headersSent) {
      res.json({ status: 'pending' });
    }
  }, waitSec * 1000);

  const waiter: ApprovalWaiter = { res, timer };

  // Register this response as a waiter
  if (!approvalWaiters.has(id)) {
    approvalWaiters.set(id, []);
  }
  approvalWaiters.get(id)!.push(waiter);

  // Re-check: decision may have arrived between the first check and registration
  const lateDecision = approvalDecisions.get(id);
  if (lateDecision) {
    resolveApprovalWaiters(id, lateDecision.decision);
    return;
  }

  // Clean up on client disconnect
  res.on('close', () => {
    clearTimeout(timer);
    removeWaiter(waiter);
  });
});

// POST /approval/respond - Menu bar sends allow/deny decision
router.post('/approval/respond', (req, res) => {
  const parsed = ApprovalRespondSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { requestId, decision } = parsed.data;
  const pending = pendingApprovals.get(requestId);
  if (!pending) {
    res.status(404).json({ error: 'Unknown or expired request' });
    return;
  }
  pendingApprovals.delete(requestId);
  approvalDecisions.set(requestId, { decision, decidedAt: new Date().toISOString() });
  resolveApprovalWaiters(requestId, decision);
  notifyClients();
  res.json({ ok: true });
});

// POST /approval/toggle - Toggle approval mode ON/OFF
router.post('/approval/toggle', (_req, res) => {
  const newValue = !approvalEnabled;
  setApprovalEnabled(newValue);
  // When turning OFF, auto-approve all pending requests
  if (!newValue) {
    for (const [id] of pendingApprovals) {
      approvalDecisions.set(id, { decision: 'allow', decidedAt: new Date().toISOString() });
      resolveApprovalWaiters(id, 'allow');
    }
    pendingApprovals.clear();
  }
  notifyClients();
  res.json({ ok: true, enabled: newValue });
});

// Register cleanup handler so state.ts can resolve waiters without circular deps
setApprovalCleanupHandler(resolveApprovalWaiters);

export default router;

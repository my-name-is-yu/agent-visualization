import { Router } from 'express';
import { CompleteEventSchema } from '../types.js';
import { findMatchingAgent } from '../matching.js';
import {
  agents, addMessage, notifyClients, persistAgent,
  setLastEventTime, setLastCompletionTime, scheduleAutoReset, addUsage,
} from '../state.js';

const router = Router();

// POST /complete - Boss signals background agent completion
router.post('/complete', (req, res) => {
  setLastEventTime(Date.now());
  const parsed = CompleteEventSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { description, result, tokens, tool_uses, duration_ms, is_error, agent_id, tool_use_id } = parsed.data;

  const matchedRecord = findMatchingAgent(agents, tool_use_id, agent_id);

  if (matchedRecord) {
    const errored = is_error === true;
    matchedRecord.status = errored ? 'errored' : 'completed';
    matchedRecord.ended_at = new Date().toISOString();
    matchedRecord.duration_ms = duration_ms || (Date.now() - new Date(matchedRecord.started_at).getTime());
    matchedRecord.output_preview = typeof result === 'string' ? result.slice(0, 2000) : null;
    matchedRecord.error = errored && typeof result === 'string' ? result.slice(0, 300) : null;
    matchedRecord.usage = {
      total_tokens: tokens || 0,
      tool_uses: tool_uses || 0,
      duration_ms: duration_ms || 0,
    };
    setLastCompletionTime(Date.now());

    addUsage(matchedRecord.session_id, tokens, tool_uses, duration_ms);

    const to_id = matchedRecord.parent_id || '__user__';
    addMessage(matchedRecord.id, to_id, 'Response');
    persistAgent(matchedRecord);
    scheduleAutoReset();
  } else {
    console.warn(`[/complete] No matching agent for description="${description || '(none)'}", agent_id=${agent_id}, tool_use_id=${tool_use_id}`);
    notifyClients();
    res.json({ ok: false, reason: 'no_matching_agent' });
    return;
  }

  notifyClients();
  res.json({ ok: true });
});

export default router;

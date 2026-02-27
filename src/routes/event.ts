import { Router } from 'express';
import { HookEventSchema, type AgentRecord } from '../types.js';
import { makeKey, isError, parseUsage } from '../utils.js';
import { findDeepestRunningAgent, findTaskOutputAgent } from '../matching.js';
import {
  agents, sessionUsage, addMessage, notifyClients, persistAgent,
  setLastEventTime, setLastCompletionTime,
  lastCompletionTime, scheduleAutoReset, cancelAutoReset, resetState,
} from '../state.js';

const router = Router();

// POST /event - receive hook events from Claude Code
router.post('/event', (req, res) => {
  const parsed = HookEventSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  setLastEventTime(Date.now());
  const { session_id, hook_phase, tool_name, tool_input, tool_output, is_error: isErr, tool_use_id: bodyToolUseId } = parsed.data;

  // Non-agent tool calls — just update lastEventTime
  if (tool_name !== 'Task' && tool_name !== 'TaskOutput') {
    notifyClients();
    res.json({ ok: true });
    return;
  }

  // Handle TaskOutput events — marks background agents as completed
  if (tool_name === 'TaskOutput' && hook_phase === 'post') {
    const taskId = (tool_input as Record<string, unknown>).task_id as string || '';
    const matchedRecord = findTaskOutputAgent(agents, taskId, session_id);

    if (matchedRecord) {
      // Guard: skip if already completed by /complete endpoint
      if (matchedRecord.status !== 'running') {
        notifyClients();
        res.json({ ok: true });
        return;
      }
      matchedRecord.last_activity = new Date().toISOString();
      const ended_at = new Date();
      const errored = isError(isErr, tool_output);
      matchedRecord.status = errored ? 'errored' : 'completed';
      matchedRecord.ended_at = ended_at.toISOString();
      matchedRecord.duration_ms = ended_at.getTime() - new Date(matchedRecord.started_at).getTime();
      setLastCompletionTime(Date.now());
      matchedRecord.error = errored && typeof tool_output === 'string'
        ? tool_output.slice(0, 300) : null;
      matchedRecord.output_preview = typeof tool_output === 'string'
        ? tool_output.slice(0, 2000) : null;
      const usage = parseUsage(tool_output);
      if (usage) matchedRecord.usage = usage;
      if (usage && usage.duration_ms) matchedRecord.duration_ms = usage.duration_ms;
      const to_id = matchedRecord.parent_id || '__user__';
      addMessage(matchedRecord.id, to_id, 'Response');
      sessionUsage.agent_count++;
      if (usage) {
        if (usage.total_tokens) sessionUsage.total_tokens += usage.total_tokens;
        if (usage.tool_uses) sessionUsage.tool_uses += usage.tool_uses;
        if (usage.duration_ms) sessionUsage.duration_ms += usage.duration_ms;
      }
      persistAgent(matchedRecord);
      scheduleAutoReset();
    }
    notifyClients();
    res.json({ ok: true });
    return;
  }

  const description = (tool_input as Record<string, unknown>).description as string || tool_name || '';
  const key = bodyToolUseId || makeKey(session_id, description);

  if (hook_phase === 'pre') {
    cancelAutoReset();

    // Check if this is a new batch — reset if no running agents and enough time passed
    let hasRunning = false;
    for (const record of agents.values()) {
      if (record.status === 'running') { hasRunning = true; break; }
    }
    const timeSinceLastCompletion = Date.now() - lastCompletionTime;
    if (!hasRunning && agents.size > 0 && timeSinceLastCompletion > 60_000) {
      resetState();
    }

    const parentAgent = findDeepestRunningAgent(agents, session_id, key);
    const parent_id = parentAgent ? parentAgent.id : '__user__';

    const record: AgentRecord = {
      id: key,
      session_id,
      description,
      prompt: typeof (tool_input as Record<string, unknown>).prompt === 'string'
        ? ((tool_input as Record<string, unknown>).prompt as string).slice(0, 1500)
        : '',
      subagent_type: (tool_input as Record<string, unknown>).subagent_type as string || 'unknown',
      background: Boolean((tool_input as Record<string, unknown>).run_in_background),
      status: 'running',
      started_at: new Date().toISOString(),
      last_activity: new Date().toISOString(),
      ended_at: null,
      duration_ms: null,
      error: null,
      output_preview: null,
      output_file: (tool_input as Record<string, unknown>).output_file as string || null,
      parent_id,
      usage: null,
    };
    agents.set(key, record);
    persistAgent(record);

    const msgType = parent_id === '__user__' ? 'Prompt' : 'TaskCreate';
    addMessage(parent_id, key, msgType);
  }

  if (hook_phase === 'post') {
    // Try to find record by key; if not found, search by session+description+running
    let record = agents.get(key);
    if (!record) {
      for (const [existingKey, r] of agents.entries()) {
        const isMatchable = r.status === 'running' ||
          (r.status === 'errored' && r.error === 'Server restarted while agent was running');
        if (r.session_id === session_id && r.description === description && isMatchable) {
          record = r;
          agents.delete(existingKey);
          record.id = key;
          agents.set(key, record);
          break;
        }
      }
    }
    if (!record) {
      record = {
        id: key,
        session_id,
        description,
        prompt: '',
        subagent_type: (tool_input as Record<string, unknown>).subagent_type as string || 'unknown',
        background: Boolean((tool_input as Record<string, unknown>).run_in_background),
        status: 'running',
        started_at: new Date().toISOString(),
        last_activity: new Date().toISOString(),
        ended_at: null,
        duration_ms: null,
        error: null,
        output_preview: null,
        output_file: null,
        parent_id: '__user__',
        usage: null,
      };
      agents.set(key, record);
    }

    record.last_activity = new Date().toISOString();

    // Detect background agent launch
    const isBgLaunch = record.background &&
      (tool_output == null ||
       (typeof tool_output === 'string' && /Async agent launched/i.test(tool_output)));

    if (isBgLaunch) {
      if (typeof tool_output === 'string') {
        const outputFileMatch = tool_output.match(/output_file:\s*(\S+)/);
        if (outputFileMatch) record.output_file = outputFileMatch[1];
        const agentIdMatch = tool_output.match(/agentId:\s*(\S+)/);
        if (agentIdMatch) record.agentId = agentIdMatch[1];
      }
    } else {
      const ended_at = new Date();
      const errored = isError(isErr, tool_output);

      record.status = errored ? 'errored' : 'completed';
      record.ended_at = ended_at.toISOString();
      record.duration_ms = ended_at.getTime() - new Date(record.started_at).getTime();
      setLastCompletionTime(Date.now());
      record.error = errored && typeof tool_output === 'string'
        ? tool_output.slice(0, 300) : null;
      record.output_preview = typeof tool_output === 'string'
        ? tool_output.slice(0, 2000) : null;

      const outputFileMatch = typeof tool_output === 'string' && tool_output.match(/output_file:\s*(\S+)/);
      if (outputFileMatch) record.output_file = outputFileMatch[1];

      const usage = parseUsage(tool_output);
      if (usage) record.usage = usage;
      if (record.duration_ms < 1000 && usage && usage.duration_ms) {
        record.duration_ms = usage.duration_ms;
      }

      const to_id = record.parent_id || '__user__';
      addMessage(key, to_id, 'Response');

      sessionUsage.agent_count++;
      if (usage) {
        if (usage.total_tokens) sessionUsage.total_tokens += usage.total_tokens;
        if (usage.tool_uses) sessionUsage.tool_uses += usage.tool_uses;
        if (usage.duration_ms) sessionUsage.duration_ms += usage.duration_ms;
      }
    }

    persistAgent(record);
    scheduleAutoReset();
  }

  notifyClients();
  res.json({ ok: true });
});

export default router;

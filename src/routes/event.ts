import { Router } from 'express';
import { HookEventSchema, type AgentRecord } from '../types.js';
import { makeKey, isError, parseUsage } from '../utils.js';
import { findDeepestRunningAgent, findTaskOutputAgent } from '../matching.js';
import {
  agents, addMessage, notifyClients, persistAgent,
  setLastEventTime, setLastCompletionTime,
  lastCompletionTime, scheduleAutoReset, cancelAutoReset, resetState,
  setCurrentTool, summarizeToolInput, addUsage, touchRunningAgents,
} from '../state.js';

const router = Router();

// POST /event - receive hook events from Claude Code
router.post('/event', (req, res) => {
  const parsed = HookEventSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { session_id, hook_phase, tool_name, tool_input, tool_output, is_error: isErr, tool_use_id: bodyToolUseId } = parsed.data;
  setLastEventTime(Date.now(), session_id);

  // Keep all running agents in this session alive (prevents stale detection)
  if (session_id) {
    touchRunningAgents(session_id);
  }

  // Non-agent tool calls — just update lastEventTime
  if (tool_name !== 'Agent' && tool_name !== 'Task' && tool_name !== 'TaskOutput') {
    if (hook_phase === 'pre' && tool_name) {
      const summary = summarizeToolInput(tool_name, tool_input as Record<string, unknown>);
      setCurrentTool({ toolName: tool_name, summary, timestamp: new Date().toISOString() }, session_id);
    }
    notifyClients();
    res.json({ ok: true });
    return;
  }

  // Handle TaskOutput events — marks background agents as completed
  if (tool_name === 'TaskOutput' && hook_phase === 'post') {
    const taskId = (tool_input as Record<string, unknown>).task_id as string || '';
    const matchedRecord = findTaskOutputAgent(agents, taskId, session_id);

    if (matchedRecord) {
      if (matchedRecord.status !== 'running') {
        notifyClients();
        res.json({ ok: true });
        return;
      }
      matchedRecord.last_activity = new Date().toISOString();
      const ended_at = new Date();
      const errored = isError(isErr);
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
      addUsage(matchedRecord.session_id, usage?.total_tokens, usage?.tool_uses, usage?.duration_ms);
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
    // Only create agent records for actual Agent tool calls (not Task/TaskOutput)
    if (tool_name !== 'Agent') {
      notifyClients();
      res.json({ ok: true });
      return;
    }

    cancelAutoReset();

    // Check if this is a new batch — reset if no running agents and enough time passed
    let hasRunning = false;
    for (const record of agents.values()) {
      if (record.status === 'running') { hasRunning = true; break; }
    }
    const timeSinceLastCompletion = Date.now() - lastCompletionTime;
    if (!hasRunning && agents.size > 0 && timeSinceLastCompletion > 60_000) {
      resetState(true);
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
        const agentIdMatch = tool_output.match(/agentId:\s*(\S+)/);
        if (agentIdMatch) record.agentId = agentIdMatch[1];
      }
    } else {
      const ended_at = new Date();
      const errored = isError(isErr);

      record.status = errored ? 'errored' : 'completed';
      record.ended_at = ended_at.toISOString();
      record.duration_ms = ended_at.getTime() - new Date(record.started_at).getTime();
      setLastCompletionTime(Date.now());
      record.error = errored && typeof tool_output === 'string'
        ? tool_output.slice(0, 300) : null;
      record.output_preview = typeof tool_output === 'string'
        ? tool_output.slice(0, 2000) : null;

      const usage = parseUsage(tool_output);
      if (usage) record.usage = usage;
      if (record.duration_ms < 1000 && usage && usage.duration_ms) {
        record.duration_ms = usage.duration_ms;
      }

      const to_id = record.parent_id || '__user__';
      addMessage(key, to_id, 'Response');

      addUsage(record.session_id, usage?.total_tokens, usage?.tool_uses, usage?.duration_ms);
    }

    persistAgent(record);
    scheduleAutoReset();
  }

  notifyClients();
  res.json({ ok: true });
});

export default router;

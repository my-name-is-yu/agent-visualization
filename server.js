const fs = require('fs');
const path = require('path');
const express = require('express');
const crypto = require('crypto');

const PORT = process.env.PORT || 1217;

// Approximate blended cost ~$9/MTok (configurable via env)
const COST_PER_TOKEN = parseFloat(process.env.AGENT_VIZ_COST_PER_MTOK || '9') / 1_000_000;
const BOSS_MODEL = process.env.AGENT_VIZ_BOSS_MODEL || 'opus';
const BOSS_ACTIVE_MS = 30_000;

const app = express();
app.use(express.json({ limit: '5mb' }));

// In-memory agent state
const agents = new Map(); // key -> AgentRecord

// Auto-reset timer: clear state after all agents complete
const AUTO_RESET_MS = parseInt(process.env.AGENT_VIZ_AUTO_RESET_SECONDS || '60', 10) * 1000;
let autoResetTimer = null;
let lastCompletionTime = 0; // timestamp of last agent completion
let lastEventTime = 0; // timestamp of last hook event (tracks Boss activity)

// Ring-buffer for messages (max 200 entries)
const MAX_MESSAGES = 200;
const messages = [];
let messageCounter = 0;

// SSE clients for push notifications
const sseClients = new Set();

// Session usage tracking
const sessionUsage = {
  total_tokens: 0,
  tool_uses: 0,
  duration_ms: 0,
  agent_count: 0,
};

// State persistence
const STATE_FILE = process.env.AGENT_VIZ_STATE_FILE
  || path.join(process.env.HOME || '/tmp', '.agent-visualization-state.json');

let lastSaveTime = 0;
function saveState() {
  try {
    const data = JSON.stringify({
      agents: [...agents.entries()],
      messages,
      messageCounter,
      sessionUsage,
      lastCompletionTime,
    });
    const tmpFile = STATE_FILE + '.tmp';
    fs.writeFileSync(tmpFile, data);
    fs.renameSync(tmpFile, STATE_FILE);
    lastSaveTime = Date.now();
  } catch (e) {
    console.error('[saveState] Failed:', e.message);
  }
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data.agents) {
      for (const [key, record] of data.agents) {
        agents.set(key, record);
      }
    }
    if (data.messages) {
      messages.length = 0;
      messages.push(...data.messages);
    }
    if (data.messageCounter) messageCounter = data.messageCounter;
    if (data.sessionUsage) Object.assign(sessionUsage, data.sessionUsage);
    // Don't restore lastCompletionTime — server restart means old grace period is irrelevant
    lastCompletionTime = 0;
    // Fix 1: Clear stale running agents from a previous crash
    const now = new Date().toISOString();
    let staleCount = 0;
    for (const record of agents.values()) {
      if (record.status === 'running') {
        record.status = 'errored';
        record.error = 'Server restarted while agent was running';
        record.ended_at = now;
        staleCount++;
      }
    }
    if (staleCount > 0) {
      console.log(`[loadState] Marked ${staleCount} stale running agent(s) as errored`);
    }
    console.log(`[loadState] Loaded ${agents.size} agents from ${STATE_FILE}`);
    // Schedule auto-reset if all agents are done (no running agents)
    if (agents.size > 0) {
      scheduleAutoReset();
    }
  } catch (e) {
    console.error('[loadState] Failed:', e.message);
  }
}

function parseUsage(output) {
  if (typeof output !== 'string') return null;
  // Try <usage>...</usage> block format (Claude Code TaskOutput)
  const usageBlock = output.match(/<usage>([\s\S]*?)<\/usage>/);
  const text = usageBlock ? usageBlock[1] : output;
  const totalMatch = text.match(/total_tokens[:\s]+(\d+)/);
  const toolMatch = text.match(/tool_uses[:\s]+(\d+)/);
  const durMatch = text.match(/duration_ms[:\s]+(\d+)/);
  if (!totalMatch && !toolMatch && !durMatch) return null;
  return {
    total_tokens: totalMatch ? parseInt(totalMatch[1], 10) : 0,
    tool_uses: toolMatch ? parseInt(toolMatch[1], 10) : 0,
    duration_ms: durMatch ? parseInt(durMatch[1], 10) : 0,
  };
}

function makeKey(session_id, description) {
  return crypto
    .createHash('sha1')
    .update(`${session_id}:${description}`)
    .digest('hex')
    .slice(0, 12);
}

function isError(is_error, tool_output) {
  if (is_error === true) return true;
  if (is_error === false) return false;
  if (typeof tool_output === 'string') {
    const sample = tool_output.slice(0, 500).toLowerCase();
    return /\berror[:;\s]|\bfailed\b|\bexception\b|\btraceback\b/.test(sample);
  }
  return false;
}

// Find the deepest currently-running agent for a given session_id.
function findDeepestRunningAgent(session_id, excludeKey) {
  let best = null;
  for (const record of agents.values()) {
    if (record.id === excludeKey) continue;
    if (record.session_id !== session_id) continue;
    if (record.status !== 'running') continue;
    if (!best || new Date(record.started_at) > new Date(best.started_at)) {
      best = record;
    }
  }
  return best;
}

function addMessage(from_id, to_id, type) {
  const entry = {
    id: String(++messageCounter),
    from_id,
    to_id,
    type,
    timestamp: new Date().toISOString(),
  };
  messages.push(entry);
  if (messages.length > MAX_MESSAGES) {
    messages.splice(0, messages.length - MAX_MESSAGES);
  }
}

function buildTasks() {
  return Array.from(agents.values()).map((a) => ({
    id: a.id,
    name: a.description,
    status: a.status,
    subagent_type: a.subagent_type,
  }));
}

function buildSessions() {
  const map = new Map();
  for (const a of agents.values()) {
    const sid = a.session_id || 'unknown';
    if (!map.has(sid)) map.set(sid, { session_id: sid, agent_count: 0, running: 0, completed: 0, errored: 0 });
    const s = map.get(sid);
    s.agent_count++;
    if (a.status === 'running') s.running++;
    else if (a.status === 'completed') s.completed++;
    else if (a.status === 'errored') s.errored++;
  }
  return Array.from(map.values());
}

function buildState() {
  const allAgents = Array.from(agents.values());
  const summary = {
    total: allAgents.length,
    running: allAgents.filter((a) => a.status === 'running').length,
    completed: allAgents.filter((a) => a.status === 'completed').length,
    errored: allAgents.filter((a) => a.status === 'errored').length,
  };

  const list = allAgents
    .sort((a, b) => new Date(b.started_at) - new Date(a.started_at))
    .slice(0, 200);

  // Boss + agent combined status
  const hasRunningAgents = summary.running > 0;
  const bossActive = (Date.now() - lastEventTime) < BOSS_ACTIVE_MS;
  let bossStatus;
  if (hasRunningAgents) {
    bossStatus = 'running';  // agents still active → running
  } else if (bossActive) {
    bossStatus = 'running';  // boss recently active (heartbeat/hook) → running
  } else if (allAgents.length > 0) {
    bossStatus = 'done';     // all agents finished, boss inactive → done
  } else {
    bossStatus = 'idle';     // nothing happening → idle
  }

  return {
    type: 'state',
    summary,
    boss: { status: bossStatus, model: BOSS_MODEL },
    agents: list,
    messages: messages.slice(),
    tasks: buildTasks(),
    sessions: buildSessions(),
    usage: { ...sessionUsage, estimated_cost_usd: Math.round(sessionUsage.total_tokens * COST_PER_TOKEN * 10000) / 10000, usage_available: sessionUsage.total_tokens > 0 },
  };
}

function notifyClients() {
  const data = JSON.stringify({ type: 'state-changed', timestamp: Date.now() });
  for (const client of sseClients) {
    try {
      client.write(`data: ${data}\n\n`);
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────

// GET /state - return current state for polling clients (menu bar app)
app.get('/state', (req, res) => {
  const state = buildState();
  res.json(state);
});

// POST /heartbeat - lightweight Boss activity signal
app.post('/heartbeat', (req, res) => {
  lastEventTime = Date.now();
  if (req.body && req.body.model) {
    // Allow runtime model override (not implemented yet, reserved)
  }
  notifyClients();
  res.json({ ok: true });
});

// POST /complete - Boss signals background agent completion
app.post('/complete', (req, res) => {
  lastEventTime = Date.now();
  const { description, result, tokens, tool_uses, duration_ms, is_error } = req.body || {};

  // Find matching running agent by description
  for (const record of agents.values()) {
    if (record.status !== 'running') continue;
    if (description && record.description !== description) continue;

    const errored = is_error === true;
    record.status = errored ? 'errored' : 'completed';
    record.ended_at = new Date().toISOString();
    record.duration_ms = duration_ms || (Date.now() - new Date(record.started_at).getTime());
    record.output_preview = typeof result === 'string' ? result.slice(0, 2000) : null;
    record.error = errored && typeof result === 'string' ? result.slice(0, 300) : null;
    record.usage = {
      total_tokens: tokens || 0,
      tool_uses: tool_uses || 0,
      duration_ms: duration_ms || 0,
    };
    lastCompletionTime = Date.now();

    sessionUsage.agent_count++;
    if (tokens) sessionUsage.total_tokens += tokens;
    if (tool_uses) sessionUsage.tool_uses += tool_uses;
    if (duration_ms) sessionUsage.duration_ms += duration_ms;

    const to_id = record.parent_id || '__user__';
    addMessage(record.id, to_id, 'Response');
    scheduleAutoReset();
    break;
  }

  notifyClients();
  res.json({ ok: true });
  if (Date.now() - lastSaveTime > 5000) saveState();
});

// GET /events - SSE stream for state change notifications
app.get('/events', (req, res) => {
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

// SSE keep-alive: send comment ping every 20 seconds
setInterval(() => {
  for (const client of sseClients) {
    try {
      client.write(':keepalive\n\n');
    } catch (e) {
      sseClients.delete(client);
    }
  }
}, 20_000);

// POST /event - receive hook events from Claude Code
app.post('/event', (req, res) => {
  const body = req.body;

  lastEventTime = Date.now();
  const session_id = body.session_id || '';
  const hook_phase = body.hook_phase;
  const tool_name = body.tool_name || '';
  const tool_input = body.tool_input || {};
  const tool_output = body.tool_output || null;
  const is_error = body.is_error;

  // Non-agent tool calls (Bash, Edit, Write, etc.) — just update lastEventTime
  if (tool_name !== 'Task' && tool_name !== 'TaskOutput') {
    notifyClients();
    res.json({ ok: true });
    return;
  }

  // Handle TaskOutput events — marks background agents as completed
  if (tool_name === 'TaskOutput' && hook_phase === 'post') {
    const taskId = tool_input.task_id || '';
    // Find a running background agent: match by agentId first, fallback to most recent running bg agent
    let matchedRecord = null;
    for (const record of agents.values()) {
      if (record.status === 'running' && record.background && record.agentId === taskId) {
        matchedRecord = record;
        break;
      }
    }
    if (!matchedRecord) {
      // Fallback: pick the oldest running background agent in the same session
      let oldest = null;
      for (const record of agents.values()) {
        if (record.status === 'running' && record.background && record.session_id === session_id) {
          if (!oldest || new Date(record.started_at) < new Date(oldest.started_at)) {
            oldest = record;
          }
        }
      }
      matchedRecord = oldest;
    }
    if (matchedRecord) {
      const record = matchedRecord;
      record.last_activity = new Date().toISOString();
      const ended_at = new Date();
      const errored = isError(is_error, tool_output);
      record.status = errored ? 'errored' : 'completed';
      record.ended_at = ended_at.toISOString();
      record.duration_ms = ended_at - new Date(record.started_at);
      lastCompletionTime = Date.now();
      record.error = errored && typeof tool_output === 'string'
        ? tool_output.slice(0, 300) : null;
      record.output_preview = typeof tool_output === 'string'
        ? tool_output.slice(0, 2000) : null;
      const usage = parseUsage(tool_output);
      if (usage) {
        record.usage = usage;
      }
      if (usage && usage.duration_ms) record.duration_ms = usage.duration_ms;
      const to_id = record.parent_id || '__user__';
      addMessage(record.id, to_id, 'Response');
      sessionUsage.agent_count++;
      if (usage) {
        if (usage.total_tokens) sessionUsage.total_tokens += usage.total_tokens;
        if (usage.tool_uses) sessionUsage.tool_uses += usage.tool_uses;
        if (usage.duration_ms) sessionUsage.duration_ms += usage.duration_ms;
      }
      scheduleAutoReset();
    }
    notifyClients();
    res.json({ ok: true });
    if (Date.now() - lastSaveTime > 5000) saveState();
    return;
  }

  const description = tool_input.description || body.tool_name || '';
  const key = body.tool_use_id || makeKey(session_id, description);

  if (hook_phase === 'pre') {
    cancelAutoReset();

    // If no agents are currently running AND enough time has passed since the last
    // completion, this is a new batch — reset state. The 60s grace period prevents
    // resetting between sequential agent spawns from the same Boss session.
    let hasRunning = false;
    for (const record of agents.values()) {
      if (record.status === 'running') { hasRunning = true; break; }
    }
    const timeSinceLastCompletion = Date.now() - lastCompletionTime;
    if (!hasRunning && agents.size > 0 && timeSinceLastCompletion > 60_000) {
      resetState();
    }

    const parentAgent = findDeepestRunningAgent(session_id, key);
    const parent_id = parentAgent ? parentAgent.id : '__user__';

    const record = {
      id: key,
      session_id,
      description,
      prompt: typeof tool_input.prompt === 'string'
        ? tool_input.prompt.slice(0, 1500)
        : '',
      subagent_type: tool_input.subagent_type || 'unknown',
      background: Boolean(tool_input.run_in_background),
      status: 'running',
      started_at: new Date().toISOString(),
      last_activity: new Date().toISOString(),
      ended_at: null,
      duration_ms: null,
      error: null,
      output_preview: null,
      output_file: tool_input.output_file || null,
      parent_id,
      usage: null,  // { total_tokens, tool_uses, duration_ms }
    };
    agents.set(key, record);

    const msgType = parent_id === '__user__' ? 'Prompt' : 'TaskCreate';
    addMessage(parent_id, key, msgType);
  }

  if (hook_phase === 'post') {
    // Try to find record by key first; if not found, search by session+description+running
    let record = agents.get(key);
    if (!record) {
      for (const [existingKey, r] of agents.entries()) {
        // Match running agents, or errored agents from a server restart (not genuinely errored)
        const isMatchable = r.status === 'running' ||
          (r.status === 'errored' && r.error === 'Server restarted while agent was running');
        if (r.session_id === session_id && r.description === description && isMatchable) {
          record = r;
          // Re-key: delete old key and set under new key
          agents.delete(existingKey);
          record.id = key;
          agents.set(key, record);
          break;
        }
      }
    }
    if (!record) {
      // Post with no matching pre — create a minimal record (duration unknown)
      record = {
        id: key,
        session_id,
        description,
        prompt: '',
        subagent_type: tool_input.subagent_type || 'unknown',
        background: Boolean(tool_input.run_in_background),
        status: 'running',
        started_at: new Date().toISOString(),
        last_activity: new Date().toISOString(),
        ended_at: null,
        duration_ms: null,
        error: null,
        output_preview: null,
        output_file: null,
        parent_id: '__user__',
        usage: null,  // { total_tokens, tool_uses, duration_ms }
      };
      agents.set(key, record);
    }

    // Update last_activity whenever the post hook fires for this agent
    record.last_activity = new Date().toISOString();

    // Detect background agent launch: post fires immediately but agent is still running.
    // For background tasks, tool_output may be null/undefined (not yet available) or
    // a string containing "Async agent launched".
    const isBgLaunch = record.background &&
      (tool_output == null ||
       (typeof tool_output === 'string' && /Async agent launched/i.test(tool_output)));

    if (isBgLaunch) {
      // Extract output_file and agentId but keep agent as "running"
      if (typeof tool_output === 'string') {
        const outputFileMatch = tool_output.match(/output_file:\s*(\S+)/);
        if (outputFileMatch) record.output_file = outputFileMatch[1];
        const agentIdMatch = tool_output.match(/agentId:\s*(\S+)/);
        if (agentIdMatch) record.agentId = agentIdMatch[1];
      }
      // Don't mark as completed — agent is still running in background
    } else {
      // Now update the record
      const ended_at = new Date();
      const errored = isError(is_error, tool_output);

      record.status = errored ? 'errored' : 'completed';
      record.ended_at = ended_at.toISOString();
      record.duration_ms = ended_at - new Date(record.started_at);
      lastCompletionTime = Date.now();
      record.error = errored && typeof tool_output === 'string'
        ? tool_output.slice(0, 300)
        : null;
      record.output_preview = typeof tool_output === 'string'
        ? tool_output.slice(0, 2000)
        : null;

      // Extract output_file path from tool_output
      const outputFileMatch = typeof tool_output === 'string' && tool_output.match(/output_file:\s*(\S+)/);
      if (outputFileMatch) {
        record.output_file = outputFileMatch[1];
      }

      // If duration is suspiciously short (under 1s) and usage has duration, use that instead
      const usage = parseUsage(tool_output);
      if (usage) {
        record.usage = usage;
      }
      if (record.duration_ms < 1000 && usage && usage.duration_ms) {
        record.duration_ms = usage.duration_ms;
      }

      const to_id = record.parent_id || '__user__';
      addMessage(key, to_id, 'Response');

      // Always count the agent; only add token data when available
      sessionUsage.agent_count++;
      if (usage) {
        if (usage.total_tokens) sessionUsage.total_tokens += usage.total_tokens;
        if (usage.tool_uses) sessionUsage.tool_uses += usage.tool_uses;
        if (usage.duration_ms) sessionUsage.duration_ms += usage.duration_ms;
      }
    }

    scheduleAutoReset(); // Check if all agents are now done
  }

  notifyClients();
  res.json({ ok: true });
  if (Date.now() - lastSaveTime > 5000) saveState();
});

function resetState() {
  agents.clear();
  messages.length = 0;
  messageCounter = 0;
  sessionUsage.total_tokens = 0;
  sessionUsage.tool_uses = 0;
  sessionUsage.duration_ms = 0;
  sessionUsage.agent_count = 0;
  lastEventTime = 0;
  saveState();
  notifyClients();
  console.log('[resetState] State cleared');
}

function scheduleAutoReset() {
  if (autoResetTimer) clearTimeout(autoResetTimer);
  autoResetTimer = null;

  // Check if any agents are still running
  for (const record of agents.values()) {
    if (record.status === 'running') return; // still active, don't schedule
  }

  // No running agents — schedule reset
  if (agents.size > 0) {
    console.log(`[autoReset] All agents done. Resetting in ${AUTO_RESET_MS / 1000}s`);
    autoResetTimer = setTimeout(() => {
      // Double-check no new agents started
      for (const record of agents.values()) {
        if (record.status === 'running') {
          console.log('[autoReset] Cancelled — new agent started');
          autoResetTimer = null;
          return;
        }
      }
      const bossStillActive = (Date.now() - lastEventTime) < BOSS_ACTIVE_MS;
      if (bossStillActive) {
        // Boss is still active, reschedule
        scheduleAutoReset();
        return;
      }
      resetState();
      autoResetTimer = null;
    }, AUTO_RESET_MS);
  }
}

function cancelAutoReset() {
  if (autoResetTimer) {
    clearTimeout(autoResetTimer);
    autoResetTimer = null;
    console.log('[autoReset] Cancelled — new agent started');
  }
}

// POST /reset - clear all state
app.post('/reset', (req, res) => {
  resetState();
  res.json({ ok: true, message: 'State cleared' });
});

// Cleanup: every 60s remove completed/errored agents older than configured time
const CLEANUP_MS = parseInt(process.env.AGENT_VIZ_CLEANUP_MINUTES || '30', 10) * 60 * 1000;

setInterval(() => {
  const now = Date.now();

  // Mark stale "running" agents as errored (no activity for 5+ minutes)
  const STALE_MS = 5 * 60 * 1000;
  let markedStale = false;
  for (const record of agents.values()) {
    if (record.status !== 'running') continue;
    const lastAct = new Date(record.last_activity || record.started_at);
    if (now - lastAct > STALE_MS) {
      record.status = 'errored';
      record.error = 'Agent appears stale (no activity for 5+ minutes)';
      record.ended_at = new Date().toISOString();
      record.duration_ms = now - new Date(record.started_at).getTime();
      markedStale = true;
    }
  }
  if (markedStale) {
    notifyClients();
    scheduleAutoReset();
  }

  for (const [key, record] of agents.entries()) {
    if (record.status === 'running') continue;
    const endedAt = record.ended_at ? new Date(record.ended_at).getTime() : 0;
    if (now - endedAt > CLEANUP_MS) {
      agents.delete(key);
    }
  }

  const cutoff = new Date(now - CLEANUP_MS).toISOString();
  while (messages.length > 0 && messages[0].timestamp < cutoff) {
    messages.shift();
  }
}, 60 * 1000);

loadState();

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Agent visualization server running on http://localhost:${PORT}`);
});

setInterval(saveState, 30_000);

process.on('SIGTERM', () => { saveState(); process.exit(0); });
process.on('SIGINT', () => { saveState(); process.exit(0); });

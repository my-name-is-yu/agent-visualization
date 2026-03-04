import type { AgentRecord, Message, SessionUsage, PerSessionState, TaskInfo, AppState, BossState, ApprovalRecord, ApprovalDecision, CurrentToolInfo, LastSessionSummary } from './types.js';
import { config } from './config.js';
import {
  initDb, migrateFromJson,
  saveAgent, deleteAgentFromDb, loadAllAgents, markRunningAgentsAsErrored,
  syncAllAgents, saveMessage, loadAllMessages,
  saveMeta, loadMeta, clearAllTables,
} from './db.js';
import type { Response } from 'express';

// ── In-memory state ───────────────────────────────────────────────────────────

export const agents = new Map<string, AgentRecord>();
export const messages: Message[] = [];
export let messageCounter = 0;

export const sessionUsage: SessionUsage = {
  total_tokens: 0,
  tool_uses: 0,
  duration_ms: 0,
  agent_count: 0,
};

// Approval state
export const pendingApprovals = new Map<string, ApprovalRecord>();
export const approvalDecisions = new Map<string, ApprovalDecision>();
export let approvalEnabled = false;

// Callback for resolving long-poll waiters (set by approval route to avoid circular deps)
let onApprovalCleanup: ((requestId: string, decision: string) => void) | null = null;
export function setApprovalCleanupHandler(handler: (requestId: string, decision: string) => void): void {
  onApprovalCleanup = handler;
}

export function setApprovalEnabled(value: boolean): void {
  approvalEnabled = value;
  try { saveMeta('approvalEnabled', value ? '1' : '0'); } catch { /* ignore */ }
}

// Current tool tracking
export let currentTool: CurrentToolInfo | null = null;
export function setCurrentTool(tool: CurrentToolInfo | null, sessionId?: string): void {
  currentTool = tool;
  if (sessionId) {
    const sess = getOrCreateSession(sessionId);
    sess.currentTool = tool;
  }
}

// Menu open tracking (suppresses auto-reset while menu is displayed)
export let menuIsOpen = false;
let menuOpenedAt = 0;
const MENU_OPEN_TTL_MS = 300_000; // 5 minutes — auto-clear if Swift crashes

export function setMenuOpen(open: boolean): void {
  menuIsOpen = open;
  menuOpenedAt = open ? Date.now() : 0;
}

/**
 * Touch all running agents in a session to prevent stale detection.
 * Called on every hook event so that sub-tool activity keeps parent agents alive.
 */
export function touchRunningAgents(sessionId: string): void {
  const now = new Date().toISOString();
  for (const record of agents.values()) {
    if (record.session_id === sessionId && record.status === 'running') {
      record.last_activity = now;
    }
  }
}

// Session timing
export let sessionStartTime: string | null = null;

// ── Per-session state ────────────────────────────────────────────────────────

interface SessionTimingState {
  lastEventTime: number;
  lastHeartbeatTime: number;
  lastTurnDoneTime: number;
  sessionStartTime: string | null;
  currentTool: CurrentToolInfo | null;
  usage: SessionUsage;
}

export const sessionStates = new Map<string, SessionTimingState>();

function getOrCreateSession(sessionId: string): SessionTimingState {
  let s = sessionStates.get(sessionId);
  if (!s) {
    s = {
      lastEventTime: 0,
      lastHeartbeatTime: 0,
      lastTurnDoneTime: 0,
      sessionStartTime: null,
      currentTool: null,
      usage: { total_tokens: 0, tool_uses: 0, duration_ms: 0, agent_count: 0 },
    };
    sessionStates.set(sessionId, s);
  }
  return s;
}

function findMostActiveSessionId(): string | undefined {
  let best: string | undefined;
  let bestTime = 0;
  for (const [id, state] of sessionStates) {
    if (state.lastEventTime > bestTime) {
      bestTime = state.lastEventTime;
      best = id;
    }
  }
  return best;
}

// Session history (survives reset)
export let lastSessionSummary: LastSessionSummary | null = null;

// Timing state
export let lastEventTime = 0;
export let lastCompletionTime = 0;
export let lastHeartbeatTime = 0;
export let lastTurnDoneTime = 0;
let autoResetTimer: ReturnType<typeof setTimeout> | null = null;

// New session detection threshold (2 minutes of inactivity = new session)
const NEW_SESSION_THRESHOLD_MS = 120_000;
// Done → idle transition threshold (checked against most recent of heartbeat or event time)
const DONE_TO_IDLE_MS = 10_000;

/**
 * Called on heartbeat — signals a new user turn has started.
 * If there was a long gap, resets session timing.
 */
export function onHeartbeat(t: number, sessionId?: string): void {
  // Per-session timing
  const sid = sessionId || findMostActiveSessionId();
  if (sid) {
    const sess = getOrCreateSession(sid);
    if (sess.lastHeartbeatTime > 0 && (t - sess.lastHeartbeatTime) > NEW_SESSION_THRESHOLD_MS) {
      sess.sessionStartTime = null;
    }
    sess.lastHeartbeatTime = t;
    sess.lastEventTime = t;
    if (!sess.sessionStartTime) {
      sess.sessionStartTime = new Date(t).toISOString();
    }
  }

  // Global timing
  if (lastHeartbeatTime > 0 && (t - lastHeartbeatTime) > NEW_SESSION_THRESHOLD_MS) {
    sessionStartTime = null;
  }
  lastHeartbeatTime = t;
  lastEventTime = t;
  if (!sessionStartTime) {
    sessionStartTime = new Date(t).toISOString();
    try { saveMeta('sessionStartTime', sessionStartTime); } catch { /* ignore */ }
  }
}

/**
 * Called on every hook event (tool use). Keeps lastEventTime fresh
 * and sets sessionStartTime on first event.
 */
export function setLastEventTime(t: number, sessionId?: string): void {
  lastEventTime = t;
  if (sessionId) {
    const sess = getOrCreateSession(sessionId);
    sess.lastEventTime = t;
    if (!sess.sessionStartTime) {
      sess.sessionStartTime = new Date(t).toISOString();
    }
  }
  if (!sessionStartTime) {
    sessionStartTime = new Date(t).toISOString();
    try { saveMeta('sessionStartTime', sessionStartTime); } catch { /* ignore */ }
  }
}

export function onTurnDone(t: number, sessionId?: string): void {
  lastTurnDoneTime = t;
  const sid = sessionId || findMostActiveSessionId();
  if (sid) {
    const sess = getOrCreateSession(sid);
    sess.lastTurnDoneTime = t;
  }
}

export function setLastCompletionTime(t: number): void {
  lastCompletionTime = t;
}

/**
 * Add usage stats for a completed agent, updating both global and per-session totals.
 */
export function addUsage(sessionId: string, tokens?: number, toolUses?: number, durationMs?: number): void {
  sessionUsage.agent_count++;
  if (tokens) sessionUsage.total_tokens += tokens;
  if (toolUses) sessionUsage.tool_uses += toolUses;
  if (durationMs) sessionUsage.duration_ms += durationMs;
  usageDirty = true;

  if (sessionId) {
    const sess = getOrCreateSession(sessionId);
    sess.usage.agent_count++;
    if (tokens) sess.usage.total_tokens += tokens;
    if (toolUses) sess.usage.tool_uses += toolUses;
    if (durationMs) sess.usage.duration_ms += durationMs;
  }
}

// Dirty tracking for incremental DB sync
export const dirtyAgentIds = new Set<string>();
let usageDirty = false;

// SSE clients
export const sseClients = new Set<Response>();

// ── SQLite persistence helpers ───────────────────────────────────────────────

export function persistAgent(agent: AgentRecord): void {
  dirtyAgentIds.add(agent.id);
  try {
    saveAgent(agent);
  } catch (err) {
    console.error('[state] Failed to persist agent:', err);
  }
}

function removeAgentFromDb(id: string): void {
  try {
    deleteAgentFromDb(id);
  } catch (err) {
    console.error('[state] Failed to delete agent from DB:', err);
  }
}

function persistMessage(msg: Message): void {
  try {
    saveMessage(msg);
  } catch (err) {
    console.error('[state] Failed to persist message:', err);
  }
}

function persistSessionUsage(): void {
  try {
    saveMeta('sessionUsage', JSON.stringify(sessionUsage));
  } catch (err) {
    console.error('[state] Failed to persist session usage:', err);
  }
}

function persistMessageCounter(): void {
  try {
    saveMeta('messageCounter', String(messageCounter));
  } catch (err) {
    console.error('[state] Failed to persist message counter:', err);
  }
}

// ── Initialize from DB ───────────────────────────────────────────────────────

export function loadFromDb(): void {
  // Load agents
  const dbAgents = loadAllAgents();
  for (const agent of dbAgents) {
    agents.set(agent.id, agent);
  }

  // Mark any running agents as errored (server restart recovery)
  markRunningAgentsAsErrored();
  for (const agent of agents.values()) {
    if (agent.status === 'running') {
      agent.status = 'errored';
      agent.error = 'Server restarted while agent was running';
      agent.ended_at = new Date().toISOString();
    }
  }

  // Load messages
  const dbMessages = loadAllMessages();
  messages.push(...dbMessages);

  // Load meta
  const savedCounter = loadMeta('messageCounter');
  if (savedCounter != null) {
    messageCounter = parseInt(savedCounter, 10) || 0;
  }

  const savedUsage = loadMeta('sessionUsage');
  if (savedUsage) {
    try {
      const parsed = JSON.parse(savedUsage);
      sessionUsage.total_tokens = parsed.total_tokens || 0;
      sessionUsage.tool_uses = parsed.tool_uses || 0;
      sessionUsage.duration_ms = parsed.duration_ms || 0;
      sessionUsage.agent_count = parsed.agent_count || 0;
    } catch { /* ignore */ }
  }

  // Don't restore sessionStartTime — it resets on first event after server restart

  // Restore last session summary
  const savedSummary = loadMeta('lastSessionSummary');
  if (savedSummary) {
    try { lastSessionSummary = JSON.parse(savedSummary); } catch { /* ignore */ }
  }

  // Restore approval enabled state
  const savedApprovalEnabled = loadMeta('approvalEnabled');
  if (savedApprovalEnabled != null) {
    approvalEnabled = savedApprovalEnabled === '1';
  }

  console.log(`[state] Loaded from DB: ${agents.size} agents, ${messages.length} messages`);
}

export function initState(): void {
  initDb();
  migrateFromJson();
  loadFromDb();
}

// ── Messages ──────────────────────────────────────────────────────────────────

export function addMessage(from_id: string, to_id: string, type: string): void {
  messageCounter++;
  const entry: Message = {
    id: String(messageCounter),
    from_id,
    to_id,
    type,
    timestamp: new Date().toISOString(),
  };
  messages.push(entry);
  if (messages.length > config.maxMessages) {
    messages.splice(0, messages.length - config.maxMessages);
  }
  persistMessage(entry);
  persistMessageCounter();
}

// ── SSE Notification ──────────────────────────────────────────────────────────

let dbSyncFailCount = 0;

export function notifyClients(): void {
  // Persist only dirty agents and session usage to SQLite.
  try {
    if (dirtyAgentIds.size > 0) {
      const dirtyAgents = Array.from(dirtyAgentIds)
        .map(id => agents.get(id))
        .filter((a): a is AgentRecord => a != null);
      if (dirtyAgents.length > 0) {
        syncAllAgents(dirtyAgents);
      }
      dirtyAgentIds.clear();
    }
    if (usageDirty) {
      persistSessionUsage();
      usageDirty = false;
    }
    dbSyncFailCount = 0;
  } catch (err) {
    dbSyncFailCount++;
    if (dbSyncFailCount <= 3 || dbSyncFailCount % 10 === 0) {
      console.error(`[state] Failed to sync to DB (count: ${dbSyncFailCount}):`, err);
    }
  }

  const data = JSON.stringify({ type: 'state-changed', timestamp: Date.now() });
  for (const client of sseClients) {
    try {
      client.write(`data: ${data}\n\n`);
    } catch {
      sseClients.delete(client);
    }
  }
}

// ── Tool Summary ──────────────────────────────────────────────────────────────

export function summarizeToolInput(toolName: string, toolInput: Record<string, unknown>): string {
  switch (toolName) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return String(toolInput.file_path || '').split('/').slice(-2).join('/');
    case 'Bash':
      return String(toolInput.command || '').slice(0, 80);
    case 'Grep':
      return `/${toolInput.pattern || ''}/ ${String(toolInput.path || '').split('/').slice(-2).join('/')}`.slice(0, 80);
    case 'Glob':
      return String(toolInput.pattern || '').slice(0, 60);
    case 'WebFetch':
      return String(toolInput.url || '').slice(0, 80);
    case 'WebSearch':
      return String(toolInput.query || '').slice(0, 80);
    default:
      return toolName;
  }
}

// ── Build State ───────────────────────────────────────────────────────────────

function buildTasks(): TaskInfo[] {
  return Array.from(agents.values()).map((a) => ({
    id: a.id,
    name: a.description,
    status: a.status,
    subagent_type: a.subagent_type,
  }));
}

interface AgentCounts {
  agent_count: number;
  running: number;
  completed: number;
  errored: number;
}

/**
 * Single-pass agent counting: returns global summary + per-session counts.
 */
function countAgents(): {
  summary: { total: number; running: number; completed: number; errored: number };
  perSession: Map<string, AgentCounts>;
} {
  const summary = { total: 0, running: 0, completed: 0, errored: 0 };
  const perSession = new Map<string, AgentCounts>();

  for (const a of agents.values()) {
    summary.total++;
    if (a.status === 'running') summary.running++;
    else if (a.status === 'completed') summary.completed++;
    else if (a.status === 'errored') summary.errored++;

    const sid = a.session_id || 'unknown';
    let c = perSession.get(sid);
    if (!c) {
      c = { agent_count: 0, running: 0, completed: 0, errored: 0 };
      perSession.set(sid, c);
    }
    c.agent_count++;
    if (a.status === 'running') c.running++;
    else if (a.status === 'completed') c.completed++;
    else if (a.status === 'errored') c.errored++;
  }

  return { summary, perSession };
}

function isTurnInProgress(heartbeat: number, turnDone: number, lastActivity: number, now: number): boolean {
  const lastKnownActivity = Math.max(heartbeat, lastActivity);
  const inactivityMs = lastKnownActivity > 0 ? now - lastKnownActivity : 0;
  return heartbeat > 0
    && heartbeat > turnDone
    && inactivityMs < config.inactivityDoneMs;
}

function buildSessions(agentCounts: Map<string, AgentCounts>): PerSessionState[] {
  // Merge all known session IDs (from agents and timing states)
  const allSessionIds = new Set([...agentCounts.keys(), ...sessionStates.keys()]);
  const now = Date.now();
  const result: PerSessionState[] = [];

  for (const sid of allSessionIds) {
    const timing = sessionStates.get(sid);
    const counts = agentCounts.get(sid) || { agent_count: 0, running: 0, completed: 0, errored: 0 };

    // Compute per-session boss status
    const hasRunning = counts.running > 0;
    const turnInProgress = timing != null
      && isTurnInProgress(timing.lastHeartbeatTime, timing.lastTurnDoneTime, timing.lastEventTime, now);
    const lastActivity = Math.max(timing?.lastHeartbeatTime || 0, timing?.lastEventTime || 0);
    const activityStale = lastActivity > 0
      && (now - lastActivity) > DONE_TO_IDLE_MS;

    let status: PerSessionState['status'];
    if (hasRunning || turnInProgress) {
      status = 'running';
    } else if (timing?.sessionStartTime && !activityStale) {
      status = 'done';
    } else {
      status = 'idle';
    }

    result.push({
      session_id: sid,
      status,
      currentTool: status === 'running' ? (timing?.currentTool || null) : null,
      sessionStartTime: status === 'idle' ? null : (timing?.sessionStartTime || null),
      usage: timing?.usage || { total_tokens: 0, tool_uses: 0, duration_ms: 0, agent_count: 0 },
      ...counts,
    });
  }

  return result;
}

export function buildState(): AppState {
  const { summary, perSession } = countAgents();

  const list = Array.from(agents.values())
    .sort((a, b) => b.started_at > a.started_at ? 1 : b.started_at < a.started_at ? -1 : 0)
    .slice(0, 200);

  const sessions = buildSessions(perSession);

  // Derive global bossStatus: per-session first, then fall back to global timing
  let bossStatus: BossState['status'] = 'idle';
  for (const s of sessions) {
    if (s.status === 'running') { bossStatus = 'running'; break; }
    if (s.status === 'done') bossStatus = 'done';
  }
  // Fallback to global timing (for backward compat when no per-session timing exists)
  if (bossStatus === 'idle') {
    const hasRunningAgents = summary.running > 0;
    const now = Date.now();
    const turnInProgress = isTurnInProgress(lastHeartbeatTime, lastTurnDoneTime, lastEventTime, now);
    const lastActivity = Math.max(lastHeartbeatTime, lastEventTime);
    const activityStale = lastActivity > 0
      && (now - lastActivity) > DONE_TO_IDLE_MS;

    if (hasRunningAgents || turnInProgress) {
      bossStatus = 'running';
    } else if (sessionStartTime && !activityStale) {
      bossStatus = 'done';
    }
  }

  return {
    type: 'state',
    summary,
    boss: { status: bossStatus, model: config.bossModel },
    agents: list,
    messages: messages.slice(),
    tasks: buildTasks(),
    sessions,
    usage: { ...sessionUsage, usage_available: sessionUsage.total_tokens > 0 },
    approval: {
      enabled: approvalEnabled,
      pending: [...pendingApprovals.values()],
    },
    currentTool: bossStatus === 'running' ? currentTool : null,
    sessionStartTime: bossStatus === 'idle' ? null : sessionStartTime,
    lastSessionSummary,
  };
}

// ── Reset ─────────────────────────────────────────────────────────────────────

export function resetState(silent: boolean = false): void {
  // Snapshot current session before clearing
  if (agents.size > 0 || sessionUsage.total_tokens > 0) {
    lastSessionSummary = {
      totalAgents: agents.size,
      totalTokens: sessionUsage.total_tokens,
      totalToolUses: sessionUsage.tool_uses,
      durationMs: sessionUsage.duration_ms,
      completedAt: new Date().toISOString(),
    };
    try { saveMeta('lastSessionSummary', JSON.stringify(lastSessionSummary)); } catch { /* ignore */ }
  }

  agents.clear();
  messages.length = 0;
  messageCounter = 0;
  sessionUsage.total_tokens = 0;
  sessionUsage.tool_uses = 0;
  sessionUsage.duration_ms = 0;
  sessionUsage.agent_count = 0;
  lastEventTime = 0;
  lastCompletionTime = 0;
  lastHeartbeatTime = 0;
  lastTurnDoneTime = 0;

  // Also clear session-specific state
  currentTool = null;
  sessionStartTime = null;
  sessionStates.clear();
  dirtyAgentIds.clear();

  // Clear approval state and resolve any waiting long-poll requests
  for (const [id] of pendingApprovals) {
    if (onApprovalCleanup) onApprovalCleanup(id, 'allow');
  }
  pendingApprovals.clear();
  approvalDecisions.clear();

  // Clear SQLite tables
  try {
    clearAllTables();
  } catch (err) {
    console.error('[state] Failed to clear DB tables:', err);
  }

  if (!silent) {
    notifyClients();
  }
  console.log('[resetState] State cleared (memory + DB)');
}

// ── Auto-reset ────────────────────────────────────────────────────────────────

export function scheduleAutoReset(): void {
  if (autoResetTimer) clearTimeout(autoResetTimer);
  autoResetTimer = null;

  for (const record of agents.values()) {
    if (record.status === 'running') return;
  }

  if (agents.size > 0) {
    console.log(`[autoReset] All agents done. Resetting in ${config.autoResetMs / 1000}s`);
    autoResetTimer = setTimeout(() => {
      for (const record of agents.values()) {
        if (record.status === 'running') {
          console.log('[autoReset] Cancelled — new agent started');
          autoResetTimer = null;
          return;
        }
      }
      if (menuIsOpen) {
        // Auto-clear if menu has been "open" for too long (e.g. Swift crashed)
        if (menuOpenedAt > 0 && (Date.now() - menuOpenedAt) > MENU_OPEN_TTL_MS) {
          menuIsOpen = false;
          menuOpenedAt = 0;
        } else {
          scheduleAutoReset();
          return;
        }
      }
      const bossStillActive = (Date.now() - lastEventTime) < config.bossActiveMs;
      if (bossStillActive) {
        scheduleAutoReset();
        return;
      }
      resetState();
      autoResetTimer = null;
    }, config.autoResetMs);
  }
}

export function cancelAutoReset(): void {
  if (autoResetTimer) {
    clearTimeout(autoResetTimer);
    autoResetTimer = null;
    console.log('[autoReset] Cancelled — new agent started');
  }
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

export function runCleanup(): void {
  const now = Date.now();

  // Cleanup expired approval data
  for (const [id, record] of approvalDecisions) {
    if (now - new Date(record.decidedAt).getTime() > config.approvalDecisionCleanupMs) {
      approvalDecisions.delete(id);
    }
  }
  for (const [id, record] of pendingApprovals) {
    if (now - new Date(record.createdAt).getTime() > config.pendingApprovalCleanupMs) {
      if (onApprovalCleanup) onApprovalCleanup(id, 'allow');
      pendingApprovals.delete(id);
    }
  }

  // Mark stale running agents as errored
  let markedStale = false;
  for (const record of agents.values()) {
    if (record.status !== 'running') continue;
    const lastActMs = Date.parse(record.last_activity || record.started_at);
    if (isNaN(lastActMs)) continue;
    if (now - lastActMs > config.staleAgentMs) {
      record.status = 'errored';
      record.error = 'Agent appears stale (no activity for 5+ minutes)';
      record.ended_at = new Date().toISOString();
      record.duration_ms = now - new Date(record.started_at).getTime();
      persistAgent(record);
      markedStale = true;
    }
  }
  if (markedStale) {
    notifyClients();
    scheduleAutoReset();
  }

  // Remove old completed/errored agents
  for (const [key, record] of agents.entries()) {
    if (record.status === 'running') continue;
    const endedAtMs = record.ended_at ? Date.parse(record.ended_at) : 0;
    if (isNaN(endedAtMs)) continue;
    if (now - endedAtMs > config.cleanupMs) {
      agents.delete(key);
      removeAgentFromDb(key);
    }
  }

  // Evict stale sessions (no activity for cleanupMs)
  for (const [sid, state] of sessionStates) {
    if (state.lastEventTime > 0 && (now - state.lastEventTime) > config.cleanupMs) {
      sessionStates.delete(sid);
    }
  }

  // Trim old messages
  const cutoff = new Date(now - config.cleanupMs).toISOString();
  let trimCount = 0;
  while (trimCount < messages.length && messages[trimCount].timestamp < cutoff) {
    trimCount++;
  }
  if (trimCount > 0) {
    messages.splice(0, trimCount);
  }
}

import type { AgentRecord, Message, SessionUsage, SessionInfo, TaskInfo, AppState, BossState, ApprovalRecord, ApprovalDecision } from './types.js';
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
}

// Timing state
export let lastEventTime = 0;
export let lastCompletionTime = 0;
let autoResetTimer: ReturnType<typeof setTimeout> | null = null;

export function setLastEventTime(t: number): void {
  lastEventTime = t;
}

export function setLastCompletionTime(t: number): void {
  lastCompletionTime = t;
}

// SSE clients
export const sseClients = new Set<Response>();

// ── SQLite persistence helpers ───────────────────────────────────────────────

export function persistAgent(agent: AgentRecord): void {
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

export function notifyClients(): void {
  // Persist all agents and session usage to SQLite.
  // Routes mutate agent records in-place then call notifyClients(), so this
  // is the single sync point that catches all in-place mutations.
  try {
    syncAllAgents(Array.from(agents.values()));
    persistSessionUsage();
  } catch (err) {
    console.error('[state] Failed to sync to DB:', err);
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

// ── Build State ───────────────────────────────────────────────────────────────

function buildTasks(): TaskInfo[] {
  return Array.from(agents.values()).map((a) => ({
    id: a.id,
    name: a.description,
    status: a.status,
    subagent_type: a.subagent_type,
  }));
}

function buildSessions(): SessionInfo[] {
  const map = new Map<string, SessionInfo>();
  for (const a of agents.values()) {
    const sid = a.session_id || 'unknown';
    if (!map.has(sid)) {
      map.set(sid, { session_id: sid, agent_count: 0, running: 0, completed: 0, errored: 0 });
    }
    const s = map.get(sid)!;
    s.agent_count++;
    if (a.status === 'running') s.running++;
    else if (a.status === 'completed') s.completed++;
    else if (a.status === 'errored') s.errored++;
  }
  return Array.from(map.values());
}

export function buildState(): AppState {
  const allAgents = Array.from(agents.values());
  const summary = {
    total: allAgents.length,
    running: allAgents.filter((a) => a.status === 'running').length,
    completed: allAgents.filter((a) => a.status === 'completed').length,
    errored: allAgents.filter((a) => a.status === 'errored').length,
  };

  const list = allAgents
    .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())
    .slice(0, 200);

  const hasRunningAgents = summary.running > 0;
  const bossActive = (Date.now() - lastEventTime) < config.bossActiveMs;
  let bossStatus: BossState['status'];
  if (hasRunningAgents) {
    bossStatus = 'running';
  } else if (bossActive) {
    bossStatus = 'running';
  } else if (allAgents.length > 0) {
    bossStatus = 'done';
  } else {
    bossStatus = 'idle';
  }

  return {
    type: 'state',
    summary,
    boss: { status: bossStatus, model: config.bossModel },
    agents: list,
    messages: messages.slice(),
    tasks: buildTasks(),
    sessions: buildSessions(),
    usage: { ...sessionUsage, usage_available: sessionUsage.total_tokens > 0 },
    approval: {
      enabled: approvalEnabled,
      pending: [...pendingApprovals.values()],
    },
  };
}

// ── Reset ─────────────────────────────────────────────────────────────────────

export function resetState(): void {
  agents.clear();
  messages.length = 0;
  messageCounter = 0;
  sessionUsage.total_tokens = 0;
  sessionUsage.tool_uses = 0;
  sessionUsage.duration_ms = 0;
  sessionUsage.agent_count = 0;
  lastEventTime = 0;

  // Clear SQLite tables
  try {
    clearAllTables();
  } catch (err) {
    console.error('[state] Failed to clear DB tables:', err);
  }

  notifyClients();
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
    const lastAct = new Date(record.last_activity || record.started_at);
    if (now - lastAct.getTime() > config.staleAgentMs) {
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
    const endedAt = record.ended_at ? new Date(record.ended_at).getTime() : 0;
    if (now - endedAt > config.cleanupMs) {
      agents.delete(key);
      removeAgentFromDb(key);
    }
  }

  // Trim old messages
  const cutoff = new Date(now - config.cleanupMs).toISOString();
  while (messages.length > 0 && messages[0].timestamp < cutoff) {
    messages.shift();
  }
}

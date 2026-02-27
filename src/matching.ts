import type { AgentRecord } from './types.js';

/**
 * Simplified 2-tier matching for /complete endpoint.
 * Tier 1: tool_use_id (Map key — most reliable)
 * Tier 2: agentId (background agent ID from task-notification)
 */
export function findMatchingAgent(
  agents: Map<string, AgentRecord>,
  toolUseId: string | undefined,
  agentId: string | undefined,
): AgentRecord | null {
  // Tier 1: match by tool_use_id (used as Map key)
  if (toolUseId) {
    const record = agents.get(toolUseId);
    if (record && record.status === 'running') return record;
  }

  // Tier 2: match by agentId
  if (agentId) {
    for (const record of agents.values()) {
      if (record.status !== 'running') continue;
      if (record.agentId === agentId) return record;
    }
  }

  if (!toolUseId && !agentId) {
    console.warn('[matching] /complete called without tool_use_id or agent_id');
  }

  return null;
}

/**
 * Find matching agent for TaskOutput events.
 * Tries agentId first, then falls back to oldest running bg agent in same session.
 */
export function findTaskOutputAgent(
  agents: Map<string, AgentRecord>,
  taskId: string,
  sessionId: string,
): AgentRecord | null {
  // Match by agentId
  for (const record of agents.values()) {
    if (record.status === 'running' && record.background && record.agentId === taskId) {
      return record;
    }
  }

  // Fallback: oldest running background agent in same session
  let oldest: AgentRecord | null = null;
  for (const record of agents.values()) {
    if (record.status === 'running' && record.background && record.session_id === sessionId) {
      if (!oldest || new Date(record.started_at) < new Date(oldest.started_at)) {
        oldest = record;
      }
    }
  }
  return oldest;
}

/**
 * Find the deepest (most recently started) running agent for a session.
 */
export function findDeepestRunningAgent(
  agents: Map<string, AgentRecord>,
  sessionId: string,
  excludeKey: string,
): AgentRecord | null {
  let best: AgentRecord | null = null;
  for (const record of agents.values()) {
    if (record.id === excludeKey) continue;
    if (record.session_id !== sessionId) continue;
    if (record.status !== 'running') continue;
    if (!best || new Date(record.started_at) > new Date(best.started_at)) {
      best = record;
    }
  }
  return best;
}

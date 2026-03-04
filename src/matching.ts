import type { AgentRecord } from './types.js';

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

  return null;
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
    if (!best || record.started_at > best.started_at) {
      best = record;
    }
  }
  return best;
}

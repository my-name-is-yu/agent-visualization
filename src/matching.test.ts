import { describe, it, expect, beforeEach } from 'vitest';
import { findTaskOutputAgent, findDeepestRunningAgent } from './matching.js';
import type { AgentRecord } from './types.js';
import { makeAgent } from './__fixtures__/events.js';

describe('findTaskOutputAgent', () => {
  let agents: Map<string, AgentRecord>;

  beforeEach(() => {
    agents = new Map();
  });

  it('matches by agentId', () => {
    const agent = makeAgent({ id: 'key1', agentId: 'task_001', background: true });
    agents.set('key1', agent);

    const result = findTaskOutputAgent(agents, 'task_001', 'session-abc');
    expect(result).toBe(agent);
  });

  it('returns null when agentId does not match (no fallback)', () => {
    const agent = makeAgent({
      id: 'key1',
      background: true,
      session_id: 'session-abc',
      agentId: 'different_task',
    });
    agents.set('key1', agent);

    const result = findTaskOutputAgent(agents, 'nonexistent', 'session-abc');
    expect(result).toBeNull();
  });

  it('does not match non-background agents', () => {
    const agent = makeAgent({ id: 'key1', background: false, agentId: 'task_001' });
    agents.set('key1', agent);

    const result = findTaskOutputAgent(agents, 'task_001', 'session-abc');
    expect(result).toBeNull();
  });
});

describe('findDeepestRunningAgent', () => {
  let agents: Map<string, AgentRecord>;

  beforeEach(() => {
    agents = new Map();
  });

  it('finds most recently started running agent', () => {
    const older = makeAgent({
      id: 'agent-1',
      session_id: 'session-abc',
      started_at: '2024-01-01T00:00:00Z',
    });
    const newer = makeAgent({
      id: 'agent-2',
      session_id: 'session-abc',
      started_at: '2024-01-01T01:00:00Z',
    });
    agents.set('agent-1', older);
    agents.set('agent-2', newer);

    const result = findDeepestRunningAgent(agents, 'session-abc', 'exclude-key');
    expect(result).toBe(newer);
  });

  it('excludes the specified key', () => {
    const agent = makeAgent({ id: 'agent-1', session_id: 'session-abc' });
    agents.set('agent-1', agent);

    const result = findDeepestRunningAgent(agents, 'session-abc', 'agent-1');
    expect(result).toBeNull();
  });

  it('only considers running agents', () => {
    const completed = makeAgent({ id: 'agent-1', session_id: 'session-abc', status: 'completed' });
    agents.set('agent-1', completed);

    const result = findDeepestRunningAgent(agents, 'session-abc', 'exclude');
    expect(result).toBeNull();
  });

  it('only considers agents in the same session', () => {
    const agent = makeAgent({ id: 'agent-1', session_id: 'other-session' });
    agents.set('agent-1', agent);

    const result = findDeepestRunningAgent(agents, 'session-abc', 'exclude');
    expect(result).toBeNull();
  });
});

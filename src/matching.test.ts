import { describe, it, expect, beforeEach } from 'vitest';
import { findMatchingAgent, findTaskOutputAgent, findDeepestRunningAgent } from './matching.js';
import type { AgentRecord } from './types.js';
import { makeAgent } from './__fixtures__/events.js';

describe('findMatchingAgent', () => {
  let agents: Map<string, AgentRecord>;

  beforeEach(() => {
    agents = new Map();
  });

  it('matches by tool_use_id (Tier 1)', () => {
    const agent = makeAgent({ id: 'tu_001' });
    agents.set('tu_001', agent);

    const result = findMatchingAgent(agents, 'tu_001', undefined);
    expect(result).toBe(agent);
  });

  it('matches by agentId (Tier 2)', () => {
    const agent = makeAgent({ id: 'some-key', agentId: 'agent_123' });
    agents.set('some-key', agent);

    const result = findMatchingAgent(agents, undefined, 'agent_123');
    expect(result).toBe(agent);
  });

  it('prefers tool_use_id over agentId', () => {
    const agent1 = makeAgent({ id: 'tu_001', agentId: 'agent_123' });
    const agent2 = makeAgent({ id: 'tu_002', agentId: 'agent_123' });
    agents.set('tu_001', agent1);
    agents.set('tu_002', agent2);

    const result = findMatchingAgent(agents, 'tu_001', 'agent_123');
    expect(result).toBe(agent1);
  });

  it('skips non-running agents', () => {
    const agent = makeAgent({ id: 'tu_001', status: 'completed' });
    agents.set('tu_001', agent);

    const result = findMatchingAgent(agents, 'tu_001', undefined);
    expect(result).toBeNull();
  });

  it('returns null when no match found', () => {
    const agent = makeAgent({ id: 'tu_001' });
    agents.set('tu_001', agent);

    const result = findMatchingAgent(agents, 'tu_999', undefined);
    expect(result).toBeNull();
  });

  it('returns null and warns when neither id provided', () => {
    const result = findMatchingAgent(agents, undefined, undefined);
    expect(result).toBeNull();
  });
});

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

  it('falls back to oldest running bg agent in same session', () => {
    const older = makeAgent({
      id: 'key1',
      background: true,
      session_id: 'session-abc',
      started_at: '2024-01-01T00:00:00Z',
    });
    const newer = makeAgent({
      id: 'key2',
      background: true,
      session_id: 'session-abc',
      started_at: '2024-01-01T01:00:00Z',
    });
    agents.set('key1', older);
    agents.set('key2', newer);

    const result = findTaskOutputAgent(agents, 'nonexistent', 'session-abc');
    expect(result).toBe(older);
  });

  it('does not match non-background agents', () => {
    const agent = makeAgent({ id: 'key1', background: false, session_id: 'session-abc' });
    agents.set('key1', agent);

    const result = findTaskOutputAgent(agents, 'nonexistent', 'session-abc');
    expect(result).toBeNull();
  });

  it('does not match agents from different sessions', () => {
    const agent = makeAgent({ id: 'key1', background: true, session_id: 'other-session' });
    agents.set('key1', agent);

    const result = findTaskOutputAgent(agents, 'nonexistent', 'session-abc');
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

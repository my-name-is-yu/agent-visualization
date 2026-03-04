import type { AgentRecord, Message } from '../types.js';

export const samplePreEvent = {
  session_id: 'session-abc',
  hook_phase: 'pre' as const,
  tool_name: 'Agent',
  tool_use_id: 'tu_001',
  tool_input: {
    description: 'Research auth module',
    prompt: 'Investigate the authentication implementation',
    subagent_type: 'researcher',
    run_in_background: true,
  },
};

export const samplePostEvent = {
  session_id: 'session-abc',
  hook_phase: 'post' as const,
  tool_name: 'Agent',
  tool_use_id: 'tu_001',
  tool_input: {
    description: 'Research auth module',
    subagent_type: 'researcher',
    run_in_background: true,
  },
  tool_output: 'Async agent launched\noutput_file: /tmp/output.txt\nagentId: agent_123',
};

export const samplePostEventCompleted = {
  session_id: 'session-abc',
  hook_phase: 'post' as const,
  tool_name: 'Agent',
  tool_use_id: 'tu_002',
  tool_input: {
    description: 'Fix login bug',
    subagent_type: 'worker',
  },
  tool_output: 'Fixed the login bug by updating the auth handler.\n<usage>\ntotal_tokens: 5000\ntool_uses: 12\nduration_ms: 30000\n</usage>',
};

export function makeAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: 'test-agent-001',
    session_id: 'session-abc',
    description: 'Test agent',
    prompt: 'Do something',
    subagent_type: 'worker',
    background: false,
    status: 'running',
    started_at: new Date().toISOString(),
    last_activity: new Date().toISOString(),
    ended_at: null,
    duration_ms: null,
    error: null,
    output_preview: null,
    parent_id: '__user__',
    usage: null,
    ...overrides,
  };
}

export function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: '1',
    from_id: '__user__',
    to_id: 'agent-001',
    type: 'Prompt',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

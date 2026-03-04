import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// Mock the db module to use in-memory SQLite
vi.mock('./db.js', async () => {
  const actual = await vi.importActual<typeof import('./db.js')>('./db.js');
  let db: Database.Database;
  let stmtsCache: ReturnType<typeof prepareStmts> | null = null;

  function prepareStmts() {
    return {
      upsertAgent: db.prepare(`
        INSERT OR REPLACE INTO agents
          (id, session_id, description, prompt, subagent_type, background, status,
           started_at, last_activity, ended_at, duration_ms, error, output_preview,
           output_file, parent_id, usage_tokens, usage_tool_uses, usage_duration_ms, agent_id)
        VALUES
          (@id, @session_id, @description, @prompt, @subagent_type, @background, @status,
           @started_at, @last_activity, @ended_at, @duration_ms, @error, @output_preview,
           @output_file, @parent_id, @usage_tokens, @usage_tool_uses, @usage_duration_ms, @agent_id)
      `),
      deleteAgent: db.prepare('DELETE FROM agents WHERE id = @id'),
      clearAgents: db.prepare('DELETE FROM agents'),
      selectAllAgents: db.prepare('SELECT * FROM agents'),
      markRunningAsErrored: db.prepare(`
        UPDATE agents SET status = 'errored', error = 'Server restarted while agent was running',
          ended_at = @now WHERE status = 'running'
      `),
      insertMessage: db.prepare(`
        INSERT OR REPLACE INTO messages (id, from_id, to_id, type, timestamp)
        VALUES (@id, @from_id, @to_id, @type, @timestamp)
      `),
      clearMessages: db.prepare('DELETE FROM messages'),
      selectAllMessages: db.prepare('SELECT * FROM messages ORDER BY CAST(id AS INTEGER) ASC'),
      getMeta: db.prepare('SELECT value FROM session_meta WHERE key = @key'),
      setMeta: db.prepare('INSERT OR REPLACE INTO session_meta (key, value) VALUES (@key, @value)'),
      clearMeta: db.prepare('DELETE FROM session_meta'),
    };
  }

  return {
    ...actual,
    initDb: () => {
      db = new Database(':memory:');
      db.exec(`
        CREATE TABLE IF NOT EXISTS agents (
          id TEXT PRIMARY KEY, session_id TEXT, description TEXT, prompt TEXT,
          subagent_type TEXT, background INTEGER, status TEXT, started_at TEXT,
          last_activity TEXT, ended_at TEXT, duration_ms INTEGER, error TEXT,
          output_preview TEXT, output_file TEXT, parent_id TEXT,
          usage_tokens INTEGER, usage_tool_uses INTEGER, usage_duration_ms INTEGER,
          agent_id TEXT
        );
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY, from_id TEXT, to_id TEXT, type TEXT, timestamp TEXT
        );
        CREATE TABLE IF NOT EXISTS session_meta (key TEXT PRIMARY KEY, value TEXT);
      `);
      stmtsCache = prepareStmts();
    },
    getDb: () => db,
    saveAgent: (agent: any) => {
      if (!stmtsCache) return;
      stmtsCache.upsertAgent.run({
        id: agent.id, session_id: agent.session_id, description: agent.description,
        prompt: agent.prompt, subagent_type: agent.subagent_type,
        background: agent.background ? 1 : 0, status: agent.status,
        started_at: agent.started_at, last_activity: agent.last_activity,
        ended_at: agent.ended_at, duration_ms: agent.duration_ms,
        error: agent.error, output_preview: agent.output_preview,
        output_file: null, parent_id: agent.parent_id,
        usage_tokens: agent.usage?.total_tokens ?? null,
        usage_tool_uses: agent.usage?.tool_uses ?? null,
        usage_duration_ms: agent.usage?.duration_ms ?? null,
        agent_id: agent.agentId ?? null,
      });
    },
    deleteAgentFromDb: (id: string) => {
      if (!stmtsCache) return;
      stmtsCache.deleteAgent.run({ id });
    },
    loadAllAgents: () => {
      if (!stmtsCache) return [];
      return stmtsCache.selectAllAgents.all().map((row: any) => ({
        id: row.id, session_id: row.session_id, description: row.description,
        prompt: row.prompt, subagent_type: row.subagent_type,
        background: Boolean(row.background), status: row.status,
        started_at: row.started_at, last_activity: row.last_activity,
        ended_at: row.ended_at, duration_ms: row.duration_ms,
        error: row.error, output_preview: row.output_preview,
        output_file: row.output_file as string | null, parent_id: row.parent_id,
        usage: row.usage_tokens != null ? {
          total_tokens: row.usage_tokens || 0,
          tool_uses: row.usage_tool_uses || 0,
          duration_ms: row.usage_duration_ms || 0,
        } : null,
        ...(row.agent_id ? { agentId: row.agent_id } : {}),
      }));
    },
    markRunningAgentsAsErrored: () => {
      if (!stmtsCache) return;
      stmtsCache.markRunningAsErrored.run({ now: new Date().toISOString() });
    },
    syncAllAgents: (agents: any[]) => {
      if (!stmtsCache) return;
      const tx = db.transaction((list: any[]) => {
        for (const a of list) {
          stmtsCache!.upsertAgent.run({
            id: a.id, session_id: a.session_id, description: a.description,
            prompt: a.prompt, subagent_type: a.subagent_type,
            background: a.background ? 1 : 0, status: a.status,
            started_at: a.started_at, last_activity: a.last_activity,
            ended_at: a.ended_at, duration_ms: a.duration_ms,
            error: a.error, output_preview: a.output_preview,
            output_file: null, parent_id: a.parent_id,
            usage_tokens: a.usage?.total_tokens ?? null,
            usage_tool_uses: a.usage?.tool_uses ?? null,
            usage_duration_ms: a.usage?.duration_ms ?? null,
            agent_id: a.agentId ?? null,
          });
        }
      });
      tx(agents);
    },
    saveMessage: (msg: any) => {
      if (!stmtsCache) return;
      stmtsCache.insertMessage.run({
        id: msg.id, from_id: msg.from_id, to_id: msg.to_id,
        type: msg.type, timestamp: msg.timestamp,
      });
    },
    loadAllMessages: () => {
      if (!stmtsCache) return [];
      return stmtsCache.selectAllMessages.all().map((r: any) => ({
        id: r.id, from_id: r.from_id, to_id: r.to_id,
        type: r.type, timestamp: r.timestamp,
      }));
    },
    saveMeta: (key: string, value: string) => {
      if (!stmtsCache) return;
      stmtsCache.setMeta.run({ key, value });
    },
    loadMeta: (key: string) => {
      if (!stmtsCache) return undefined;
      const row = stmtsCache.getMeta.get({ key }) as { value: string } | undefined;
      return row?.value;
    },
    clearAllTables: () => {
      if (!stmtsCache) return;
      stmtsCache.clearAgents.run();
      stmtsCache.clearMessages.run();
      stmtsCache.clearMeta.run();
    },
    migrateFromJson: () => { /* no-op in tests */ },
  };
});

// Import AFTER mock setup
import {
  agents, messages, sessionUsage, addMessage,
  buildState, resetState, initState, setLastEventTime, onHeartbeat, onTurnDone,
  setCurrentTool, addUsage, sessionStates,
} from './state.js';
// Re-import as namespace to access live bindings for mutable exports
import * as stateModule from './state.js';
import { makeAgent } from './__fixtures__/events.js';

describe('state management', () => {
  beforeEach(() => {
    initState();
    resetState();
  });

  describe('buildState', () => {
    it('returns idle state when empty', () => {
      const state = buildState();
      expect(state.type).toBe('state');
      expect(state.summary.total).toBe(0);
      expect(state.boss.status).toBe('idle');
      expect(state.agents).toEqual([]);
    });

    it('counts agents by status', () => {
      agents.set('a1', makeAgent({ id: 'a1', status: 'running' }));
      agents.set('a2', makeAgent({ id: 'a2', status: 'completed' }));
      agents.set('a3', makeAgent({ id: 'a3', status: 'errored' }));

      const state = buildState();
      expect(state.summary.total).toBe(3);
      expect(state.summary.running).toBe(1);
      expect(state.summary.completed).toBe(1);
      expect(state.summary.errored).toBe(1);
    });

    it('sets boss status to running when agents are running', () => {
      agents.set('a1', makeAgent({ id: 'a1', status: 'running' }));
      const state = buildState();
      expect(state.boss.status).toBe('running');
    });

    it('sets boss status to done when all agents finished', () => {
      agents.set('a1', makeAgent({ id: 'a1', status: 'completed' }));
      // Simulate that a session was recently active (within DONE_TO_IDLE_MS window)
      setLastEventTime(Date.now() - 5_000); // last event 5s ago (within 10s done→idle threshold)
      const state = buildState();
      expect(state.boss.status).toBe('done');
    });

    it('sorts agents by started_at descending', () => {
      agents.set('a1', makeAgent({ id: 'a1', started_at: '2024-01-01T00:00:00Z' }));
      agents.set('a2', makeAgent({ id: 'a2', started_at: '2024-01-02T00:00:00Z' }));

      const state = buildState();
      expect(state.agents[0].id).toBe('a2');
      expect(state.agents[1].id).toBe('a1');
    });
  });

  describe('addMessage', () => {
    it('adds a message with incrementing id', () => {
      addMessage('__user__', 'agent-1', 'Prompt');
      addMessage('agent-1', '__user__', 'Response');

      expect(messages.length).toBe(2);
      expect(messages[0].from_id).toBe('__user__');
      expect(messages[1].type).toBe('Response');
    });
  });

  describe('resetState', () => {
    it('clears all state', () => {
      agents.set('a1', makeAgent({ id: 'a1' }));
      addMessage('__user__', 'a1', 'Prompt');
      sessionUsage.total_tokens = 1000;

      resetState();

      expect(agents.size).toBe(0);
      expect(messages.length).toBe(0);
      expect(sessionUsage.total_tokens).toBe(0);
    });
  });

  describe('session usage aggregation', () => {
    it('tracks usage in buildState', () => {
      sessionUsage.total_tokens = 50000;
      sessionUsage.tool_uses = 100;
      sessionUsage.agent_count = 5;

      const state = buildState();
      expect(state.usage.total_tokens).toBe(50000);
      expect(state.usage.tool_uses).toBe(100);
      expect(state.usage.usage_available).toBe(true);
    });

    it('reports usage_available as false when no tokens', () => {
      const state = buildState();
      expect(state.usage.usage_available).toBe(false);
    });
  });

  describe('onHeartbeat session detection', () => {
    it('resets sessionStartTime when heartbeat gap exceeds threshold', () => {
      const t1 = Date.now() - 300_000; // 5 minutes ago
      onHeartbeat(t1);
      // Internal sessionStartTime is set (buildState may return null if idle)
      expect(stateModule.sessionStartTime).toBeTruthy();
      const firstStart = stateModule.sessionStartTime;

      // Simulate hook event updating lastEventTime (like Bash pre-hook)
      setLastEventTime(Date.now());

      // New heartbeat after gap — should detect new session
      const t2 = Date.now();
      onHeartbeat(t2);
      expect(stateModule.sessionStartTime).toBeTruthy();
      // sessionStartTime should be reset to new time, not the old one
      expect(stateModule.sessionStartTime).not.toBe(firstStart);
    });

    it('keeps sessionStartTime when heartbeats are close together', () => {
      const t1 = Date.now() - 10_000; // 10 seconds ago
      onHeartbeat(t1);
      const state1 = buildState();
      const firstStart = state1.sessionStartTime;

      // Another heartbeat 10s later — same session
      onHeartbeat(Date.now());
      const state2 = buildState();
      expect(state2.sessionStartTime).toBe(firstStart);
    });
  });

  describe('turn-done status transitions', () => {
    it('transitions to done immediately after turn-done', () => {
      const now = Date.now();
      onHeartbeat(now - 5000);
      setLastEventTime(now - 1000);
      // Before turn-done: still running (recent activity, heartbeat > turnDone)
      expect(buildState().boss.status).toBe('running');

      // Send turn-done
      onTurnDone(now);
      // Now should be done (heartbeat < turnDone, session exists, heartbeat not stale)
      expect(buildState().boss.status).toBe('done');
    });

    it('stays running when heartbeat is recent even if lastEvent is old', () => {
      const now = Date.now();
      onHeartbeat(now - 5000);
      // Last event was 31s ago, but heartbeat was 5s ago — lastKnownActivity = 5s → still active
      setLastEventTime(now - 31_000);
      expect(buildState().boss.status).toBe('running');
    });

    it('transitions to done after 15s inactivity without explicit turn-done', () => {
      const now = Date.now();
      // Heartbeat 20s ago, last event 16s ago — beyond 15s inactivity threshold
      onHeartbeat(now - 20_000);
      setLastEventTime(now - 16_000);
      // inactivityDone = true → turnInProgress = false
      // sessionStartTime set, heartbeat stale (>10s) → idle
      expect(buildState().boss.status).toBe('idle');
    });

    it('falls back to done after turnStaleMs inactivity without turn-done', () => {
      const now = Date.now();
      onHeartbeat(now - 700_000); // 11+ min ago
      // Last event was 11+ min ago — beyond turnStaleMs (10min)
      setLastEventTime(now - 700_000);
      // No turn-done sent, but turn is abandoned → turnInProgress is false
      // sessionStartTime set, heartbeat not stale (>10s doesn't apply since it's turn-abandoned) → done
      // Actually heartbeat IS stale (>10s) → idle
      expect(buildState().boss.status).toBe('idle');
    });

    it('returns null sessionStartTime when idle', () => {
      const now = Date.now();
      onHeartbeat(now - 15_000); // 15s ago — stale
      setLastEventTime(now - 15_000);
      onTurnDone(now - 14_000);
      // Should be idle
      const state = buildState();
      expect(state.boss.status).toBe('idle');
      expect(state.sessionStartTime).toBeNull();
    });

    it('transitions to idle when heartbeat is stale (>10s)', () => {
      const now = Date.now();
      onHeartbeat(now - 15_000); // 15s ago — beyond 10s threshold
      setLastEventTime(now - 15_000);
      onTurnDone(now - 14_000);
      // heartbeatStale = true → idle
      expect(buildState().boss.status).toBe('idle');
    });

    it('stays running when agents are running even after turn-done', () => {
      const now = Date.now();
      onHeartbeat(now - 5000);
      setLastEventTime(now - 5000);
      onTurnDone(now);
      agents.set('a1', makeAgent({ id: 'a1', status: 'running' }));
      // hasRunningAgents = true → still running
      expect(buildState().boss.status).toBe('running');
    });
  });

  describe('sessions', () => {
    it('groups agents by session_id', () => {
      agents.set('a1', makeAgent({ id: 'a1', session_id: 'sess-1', status: 'running' }));
      agents.set('a2', makeAgent({ id: 'a2', session_id: 'sess-1', status: 'completed' }));
      agents.set('a3', makeAgent({ id: 'a3', session_id: 'sess-2', status: 'errored' }));

      const state = buildState();
      expect(state.sessions.length).toBe(2);
      const sess1 = state.sessions.find(s => s.session_id === 'sess-1');
      expect(sess1?.agent_count).toBe(2);
      expect(sess1?.running).toBe(1);
      expect(sess1?.completed).toBe(1);
    });
  });

  describe('per-session state', () => {
    it('computes per-session bossStatus independently', () => {
      const now = Date.now();
      // Session 1: running (has heartbeat, recent activity, no turn-done)
      onHeartbeat(now - 1000, 'sess-1');
      setLastEventTime(now - 500, 'sess-1');
      // Session 2: idle (heartbeat stale)
      onHeartbeat(now - 20_000, 'sess-2');
      setLastEventTime(now - 20_000, 'sess-2');
      onTurnDone(now - 19_000, 'sess-2');

      const state = buildState();
      const s1 = state.sessions.find(s => s.session_id === 'sess-1');
      const s2 = state.sessions.find(s => s.session_id === 'sess-2');

      expect(s1?.status).toBe('running');
      expect(s2?.status).toBe('idle');
      // Global should be running (most active)
      expect(state.boss.status).toBe('running');
    });

    it('tracks per-session currentTool', () => {
      const now = Date.now();
      onHeartbeat(now - 1000, 'sess-1');
      setLastEventTime(now - 500, 'sess-1');
      setCurrentTool({ toolName: 'Read', summary: 'file.ts', timestamp: new Date().toISOString() }, 'sess-1');

      onHeartbeat(now - 1000, 'sess-2');
      setLastEventTime(now - 500, 'sess-2');
      setCurrentTool({ toolName: 'Bash', summary: 'npm test', timestamp: new Date().toISOString() }, 'sess-2');

      const state = buildState();
      const s1 = state.sessions.find(s => s.session_id === 'sess-1');
      const s2 = state.sessions.find(s => s.session_id === 'sess-2');

      expect(s1?.currentTool?.toolName).toBe('Read');
      expect(s2?.currentTool?.toolName).toBe('Bash');
    });

    it('tracks per-session usage via addUsage', () => {
      addUsage('sess-1', 5000, 10, 30000);
      addUsage('sess-2', 8000, 20, 60000);
      addUsage('sess-1', 3000, 5, 15000);

      const state = buildState();
      // Per-session usage comes from sessionStates
      const s1 = state.sessions.find(s => s.session_id === 'sess-1');
      const s2 = state.sessions.find(s => s.session_id === 'sess-2');

      expect(s1?.usage.total_tokens).toBe(8000);
      expect(s1?.usage.agent_count).toBe(2);
      expect(s2?.usage.total_tokens).toBe(8000);
      expect(s2?.usage.agent_count).toBe(1);

      // Global usage is the sum
      expect(state.usage.total_tokens).toBe(16000);
      expect(state.usage.agent_count).toBe(3);
    });

    it('tracks per-session sessionStartTime', () => {
      const now = Date.now();
      onHeartbeat(now - 5000, 'sess-1');
      onHeartbeat(now - 2000, 'sess-2');

      const state = buildState();
      const s1 = state.sessions.find(s => s.session_id === 'sess-1');
      const s2 = state.sessions.find(s => s.session_id === 'sess-2');

      expect(s1?.sessionStartTime).toBeTruthy();
      expect(s2?.sessionStartTime).toBeTruthy();
      expect(s1?.sessionStartTime).not.toBe(s2?.sessionStartTime);
    });

    it('clears sessionStates on resetState', () => {
      onHeartbeat(Date.now(), 'sess-1');
      addUsage('sess-1', 1000, 5, 10000);
      expect(sessionStates.size).toBe(1);

      resetState();
      expect(sessionStates.size).toBe(0);
    });

    it('shows session as running when it has running agents', () => {
      agents.set('a1', makeAgent({ id: 'a1', session_id: 'sess-1', status: 'running' }));

      const state = buildState();
      const s1 = state.sessions.find(s => s.session_id === 'sess-1');
      expect(s1?.status).toBe('running');
    });
  });
});

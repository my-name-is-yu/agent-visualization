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
        output_file: agent.output_file, parent_id: agent.parent_id,
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
        output_file: row.output_file, parent_id: row.parent_id,
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
            output_file: a.output_file, parent_id: a.parent_id,
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
  buildState, resetState, initState,
} from './state.js';
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
});

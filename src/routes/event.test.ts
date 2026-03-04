import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// Mock the db module (same pattern as state.test.ts)
vi.mock('../db.js', async () => {
  const actual = await vi.importActual<typeof import('../db.js')>('../db.js');
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
    loadAllAgents: () => [],
    markRunningAgentsAsErrored: () => {},
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
    loadAllMessages: () => [],
    saveMeta: (key: string, value: string) => {
      if (!stmtsCache) return;
      stmtsCache.setMeta.run({ key, value });
    },
    loadMeta: () => undefined,
    clearAllTables: () => {
      if (!stmtsCache) return;
      stmtsCache.clearAgents.run();
      stmtsCache.clearMessages.run();
      stmtsCache.clearMeta.run();
    },
    migrateFromJson: () => {},
  };
});

import { agents, initState, resetState, sessionUsage, sessionStates } from '../state.js';
import { samplePreEvent, samplePostEvent, samplePostEventCompleted } from '../__fixtures__/events.js';

// Import route handlers and create mock req/res
import eventRouter from './event.js';

function createMockRes() {
  const res: any = {
    statusCode: 200,
    _json: null,
    status(code: number) { res.statusCode = code; return res; },
    json(data: any) { res._json = data; },
  };
  return res;
}

function createMockReq(body: any) {
  return { body } as any;
}

// Extract the handler from the router
function getHandler(router: any, method: string, path: string) {
  for (const layer of router.stack) {
    if (layer.route?.path === path && layer.route?.methods[method]) {
      return layer.route.stack[0].handle;
    }
  }
  throw new Error(`No handler found for ${method.toUpperCase()} ${path}`);
}

const eventHandler = getHandler(eventRouter, 'post', '/event');
describe('POST /event', () => {
  beforeEach(() => {
    initState();
    resetState();
  });

  it('creates a running agent on pre-phase Task event', () => {
    const req = createMockReq(samplePreEvent);
    const res = createMockRes();

    eventHandler(req, res);

    expect(res._json).toEqual({ ok: true });
    expect(agents.size).toBe(1);
    const agent = agents.get(samplePreEvent.tool_use_id)!;
    expect(agent.status).toBe('running');
    expect(agent.description).toBe('Research auth module');
    expect(agent.subagent_type).toBe('researcher');
    expect(agent.background).toBe(true);
  });

  it('completes a foreground agent on post-phase', () => {
    // First create via pre
    const preReq = createMockReq({
      ...samplePostEventCompleted,
      hook_phase: 'pre',
      tool_output: undefined,
    });
    eventHandler(preReq, createMockRes());

    // Then complete via post
    const postReq = createMockReq(samplePostEventCompleted);
    const postRes = createMockRes();
    eventHandler(postReq, postRes);

    expect(postRes._json).toEqual({ ok: true });
    const agent = agents.get(samplePostEventCompleted.tool_use_id)!;
    expect(agent.status).toBe('completed');
    expect(agent.usage).toBeTruthy();
    expect(agent.usage!.total_tokens).toBe(5000);
  });

  it('keeps background agent running on post-phase with async launch output', () => {
    // Pre phase
    const preReq = createMockReq(samplePreEvent);
    eventHandler(preReq, createMockRes());

    // Post phase with "Async agent launched" output
    const postReq = createMockReq(samplePostEvent);
    const postRes = createMockRes();
    eventHandler(postReq, postRes);

    expect(postRes._json).toEqual({ ok: true });
    const agent = agents.get(samplePreEvent.tool_use_id)!;
    expect(agent.status).toBe('running');
    expect(agent.agentId).toBe('agent_123');
  });

  it('updates currentTool on non-agent pre-phase events', () => {
    const req = createMockReq({
      session_id: 'session-abc',
      hook_phase: 'pre',
      tool_name: 'Read',
      tool_input: { file_path: '/src/state.ts' },
    });
    const res = createMockRes();
    eventHandler(req, res);

    expect(res._json).toEqual({ ok: true });
    // No agent should be created for non-Task tools
    expect(agents.size).toBe(0);
  });

  it('tracks per-session currentTool from non-agent events', () => {
    const req = createMockReq({
      session_id: 'session-abc',
      hook_phase: 'pre',
      tool_name: 'Read',
      tool_input: { file_path: '/src/state.ts' },
    });
    eventHandler(req, createMockRes());

    const sessState = sessionStates.get('session-abc');
    expect(sessState).toBeTruthy();
    expect(sessState?.currentTool?.toolName).toBe('Read');
    expect(sessState?.currentTool?.summary).toContain('state.ts');
  });

  it('adds usage to per-session state when agent completes', () => {
    // Create agent via pre-phase
    const preReq = createMockReq({
      ...samplePostEventCompleted,
      hook_phase: 'pre',
      tool_output: undefined,
    });
    eventHandler(preReq, createMockRes());

    // Complete via post-phase
    const postReq = createMockReq(samplePostEventCompleted);
    eventHandler(postReq, createMockRes());

    const sessState = sessionStates.get('session-abc');
    expect(sessState).toBeTruthy();
    expect(sessState?.usage.total_tokens).toBe(5000);
    expect(sessState?.usage.agent_count).toBe(1);
  });

  it('isolates usage between different sessions', () => {
    // Agent in session-abc
    const preReq1 = createMockReq({
      ...samplePostEventCompleted,
      hook_phase: 'pre',
      tool_output: undefined,
    });
    eventHandler(preReq1, createMockRes());
    const postReq1 = createMockReq(samplePostEventCompleted);
    eventHandler(postReq1, createMockRes());

    // Agent in session-xyz
    const preReq2 = createMockReq({
      ...samplePostEventCompleted,
      session_id: 'session-xyz',
      tool_use_id: 'tu_003',
      hook_phase: 'pre',
      tool_output: undefined,
    });
    eventHandler(preReq2, createMockRes());
    const postReq2 = createMockReq({
      ...samplePostEventCompleted,
      session_id: 'session-xyz',
      tool_use_id: 'tu_003',
    });
    eventHandler(postReq2, createMockRes());

    const sessAbc = sessionStates.get('session-abc');
    const sessXyz = sessionStates.get('session-xyz');
    expect(sessAbc?.usage.total_tokens).toBe(5000);
    expect(sessXyz?.usage.total_tokens).toBe(5000);
    // Global should be sum
    expect(sessionUsage.total_tokens).toBe(10000);
  });
});


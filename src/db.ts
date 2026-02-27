import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import type { AgentRecord, Message } from './types.js';

let db: Database.Database;

export function getDb(): Database.Database {
  return db;
}

export function initDb(): void {
  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      description TEXT,
      prompt TEXT,
      subagent_type TEXT,
      background INTEGER,
      status TEXT,
      started_at TEXT,
      last_activity TEXT,
      ended_at TEXT,
      duration_ms INTEGER,
      error TEXT,
      output_preview TEXT,
      output_file TEXT,
      parent_id TEXT,
      usage_tokens INTEGER,
      usage_tool_uses INTEGER,
      usage_duration_ms INTEGER,
      agent_id TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      from_id TEXT,
      to_id TEXT,
      type TEXT,
      timestamp TEXT
    );

    CREATE TABLE IF NOT EXISTS session_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
    CREATE INDEX IF NOT EXISTS idx_agents_session_id ON agents(session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
  `);
}

// ── Prepared statements (lazy init) ──────────────────────────────────────────

let _stmts: ReturnType<typeof prepareStatements> | null = null;

function stmts() {
  if (!_stmts) _stmts = prepareStatements();
  return _stmts;
}

function prepareStatements() {
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

// ── Agent persistence ────────────────────────────────────────────────────────

function agentToRow(a: AgentRecord): Record<string, unknown> {
  return {
    id: a.id,
    session_id: a.session_id,
    description: a.description,
    prompt: a.prompt,
    subagent_type: a.subagent_type,
    background: a.background ? 1 : 0,
    status: a.status,
    started_at: a.started_at,
    last_activity: a.last_activity,
    ended_at: a.ended_at,
    duration_ms: a.duration_ms,
    error: a.error,
    output_preview: a.output_preview,
    output_file: a.output_file,
    parent_id: a.parent_id,
    usage_tokens: a.usage?.total_tokens ?? null,
    usage_tool_uses: a.usage?.tool_uses ?? null,
    usage_duration_ms: a.usage?.duration_ms ?? null,
    agent_id: a.agentId ?? null,
  };
}

function rowToAgent(row: Record<string, unknown>): AgentRecord {
  const hasUsage = row.usage_tokens != null || row.usage_tool_uses != null || row.usage_duration_ms != null;
  const agent: AgentRecord = {
    id: row.id as string,
    session_id: row.session_id as string,
    description: row.description as string,
    prompt: row.prompt as string,
    subagent_type: row.subagent_type as string,
    background: Boolean(row.background),
    status: row.status as AgentRecord['status'],
    started_at: row.started_at as string,
    last_activity: row.last_activity as string,
    ended_at: row.ended_at as string | null,
    duration_ms: row.duration_ms as number | null,
    error: row.error as string | null,
    output_preview: row.output_preview as string | null,
    output_file: row.output_file as string | null,
    parent_id: row.parent_id as string,
    usage: hasUsage ? {
      total_tokens: (row.usage_tokens as number) || 0,
      tool_uses: (row.usage_tool_uses as number) || 0,
      duration_ms: (row.usage_duration_ms as number) || 0,
    } : null,
  };
  if (row.agent_id) {
    agent.agentId = row.agent_id as string;
  }
  return agent;
}

export function saveAgent(agent: AgentRecord): void {
  stmts().upsertAgent.run(agentToRow(agent));
}

export function deleteAgentFromDb(id: string): void {
  stmts().deleteAgent.run({ id });
}

export function loadAllAgents(): AgentRecord[] {
  const rows = stmts().selectAllAgents.all() as Record<string, unknown>[];
  return rows.map(rowToAgent);
}

export function markRunningAgentsAsErrored(): void {
  stmts().markRunningAsErrored.run({ now: new Date().toISOString() });
}

// ── Message persistence ──────────────────────────────────────────────────────

export function saveMessage(msg: Message): void {
  stmts().insertMessage.run({
    id: msg.id,
    from_id: msg.from_id,
    to_id: msg.to_id,
    type: msg.type,
    timestamp: msg.timestamp,
  });
}

export function loadAllMessages(): Message[] {
  const rows = stmts().selectAllMessages.all() as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as string,
    from_id: r.from_id as string,
    to_id: r.to_id as string,
    type: r.type as string,
    timestamp: r.timestamp as string,
  }));
}

// ── Session meta persistence ─────────────────────────────────────────────────

export function saveMeta(key: string, value: string): void {
  stmts().setMeta.run({ key, value });
}

export function loadMeta(key: string): string | undefined {
  const row = stmts().getMeta.get({ key }) as { value: string } | undefined;
  return row?.value;
}

// ── Batch sync agents ────────────────────────────────────────────────────────

export function syncAllAgents(agentList: AgentRecord[]): void {
  const upsert = stmts().upsertAgent;
  const tx = db.transaction((list: AgentRecord[]) => {
    for (const agent of list) {
      upsert.run(agentToRow(agent));
    }
  });
  tx(agentList);
}

// ── Clear all tables ─────────────────────────────────────────────────────────

export function clearAllTables(): void {
  stmts().clearAgents.run();
  stmts().clearMessages.run();
  stmts().clearMeta.run();
}

// ── JSON migration ───────────────────────────────────────────────────────────

interface JsonState {
  agents?: Record<string, AgentRecord> | [string, AgentRecord][];
  messages?: Message[];
  messageCounter?: number;
  sessionUsage?: {
    total_tokens: number;
    tool_uses: number;
    duration_ms: number;
    agent_count: number;
  };
}

export function migrateFromJson(): void {
  const jsonPath = config.stateFile;
  if (!fs.existsSync(jsonPath)) return;

  try {
    const raw = fs.readFileSync(jsonPath, 'utf8');
    const data = JSON.parse(raw) as JsonState;

    const insertAgentsTx = db.transaction((agentEntries: [string, AgentRecord][]) => {
      for (const [, agent] of agentEntries) {
        stmts().upsertAgent.run(agentToRow(agent));
      }
    });

    const insertMessagesTx = db.transaction((msgs: Message[]) => {
      for (const msg of msgs) {
        stmts().insertMessage.run({
          id: msg.id,
          from_id: msg.from_id,
          to_id: msg.to_id,
          type: msg.type,
          timestamp: msg.timestamp,
        });
      }
    });

    // Import agents
    if (data.agents) {
      let entries: [string, AgentRecord][];
      if (Array.isArray(data.agents)) {
        entries = data.agents;
      } else {
        entries = Object.entries(data.agents);
      }
      if (entries.length > 0) {
        insertAgentsTx(entries);
      }
    }

    // Import messages
    if (data.messages && data.messages.length > 0) {
      insertMessagesTx(data.messages);
    }

    // Import session meta
    if (data.messageCounter != null) {
      saveMeta('messageCounter', String(data.messageCounter));
    }
    if (data.sessionUsage) {
      saveMeta('sessionUsage', JSON.stringify(data.sessionUsage));
    }

    // Rename old file
    const migratedPath = jsonPath + '.migrated';
    fs.renameSync(jsonPath, migratedPath);
    console.log(`[db] Migrated JSON state to SQLite. Old file renamed to ${path.basename(migratedPath)}`);
  } catch (err) {
    console.error('[db] JSON migration failed:', err);
  }
}

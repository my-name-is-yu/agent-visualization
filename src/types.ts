import { z } from 'zod';

// ── Agent Record ──────────────────────────────────────────────────────────────

export interface AgentUsage {
  total_tokens: number;
  tool_uses: number;
  duration_ms: number;
}

export interface AgentRecord {
  id: string;
  session_id: string;
  description: string;
  prompt: string;
  subagent_type: string;
  background: boolean;
  status: 'running' | 'completed' | 'errored';
  started_at: string;
  last_activity: string;
  ended_at: string | null;
  duration_ms: number | null;
  error: string | null;
  output_preview: string | null;
  output_file: string | null;
  parent_id: string;
  usage: AgentUsage | null;
  agentId?: string;
}

// ── Message ───────────────────────────────────────────────────────────────────

export interface Message {
  id: string;
  from_id: string;
  to_id: string;
  type: string;
  timestamp: string;
}

// ── Session ───────────────────────────────────────────────────────────────────

export interface SessionUsage {
  total_tokens: number;
  tool_uses: number;
  duration_ms: number;
  agent_count: number;
}

export interface SessionInfo {
  session_id: string;
  agent_count: number;
  running: number;
  completed: number;
  errored: number;
}

// ── Boss ──────────────────────────────────────────────────────────────────────

export interface BossState {
  status: 'running' | 'done' | 'idle';
  model: string;
}

// ── Approval ──────────────────────────────────────────────────────────────────

export interface ApprovalRecord {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  sessionId: string;
  createdAt: string;
}

export interface ApprovalDecision {
  decision: string;
  decidedAt: string;
}

// ── Task (for tasks array in state) ───────────────────────────────────────────

export interface TaskInfo {
  id: string;
  name: string;
  status: string;
  subagent_type: string;
}

// ── App State (GET /state response) ───────────────────────────────────────────

export interface AppState {
  type: 'state';
  summary: {
    total: number;
    running: number;
    completed: number;
    errored: number;
  };
  boss: BossState;
  agents: AgentRecord[];
  messages: Message[];
  tasks: TaskInfo[];
  sessions: SessionInfo[];
  usage: SessionUsage & { usage_available: boolean };
  approval: {
    enabled: boolean;
    pending: ApprovalRecord[];
  };
}

// ── Zod Schemas (request validation) ──────────────────────────────────────────

export const HookEventSchema = z.object({
  session_id: z.string().default(''),
  hook_phase: z.enum(['pre', 'post']),
  tool_name: z.string().default(''),
  tool_use_id: z.string().optional(),
  tool_input: z.record(z.unknown()).default({}),
  tool_output: z.union([z.string(), z.null()]).optional(),
  is_error: z.boolean().optional(),
});
export type HookEvent = z.infer<typeof HookEventSchema>;

export const CompleteEventSchema = z.object({
  description: z.string().optional(),
  result: z.string().optional(),
  tokens: z.number().optional(),
  tool_uses: z.number().optional(),
  duration_ms: z.number().optional(),
  is_error: z.boolean().optional(),
  agent_id: z.string().optional(),
  tool_use_id: z.string().optional(),
});
export type CompleteEvent = z.infer<typeof CompleteEventSchema>;

export const ApprovalRequestSchema = z.object({
  toolName: z.string().default('unknown'),
  toolInput: z.record(z.unknown()).default({}),
  sessionId: z.string().default(''),
});
export type ApprovalRequestInput = z.infer<typeof ApprovalRequestSchema>;

export const ApprovalRespondSchema = z.object({
  requestId: z.string(),
  decision: z.string(),
});
export type ApprovalRespondInput = z.infer<typeof ApprovalRespondSchema>;

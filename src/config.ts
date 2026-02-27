import fs from 'fs';
import path from 'path';

export interface Config {
  port: number;
  bossModel: string;
  bossActiveMs: number;
  autoResetMs: number;
  cleanupMs: number;
  staleAgentMs: number;
  maxMessages: number;
  sseKeepAliveMs: number;
  cleanupIntervalMs: number;
  approvalDecisionCleanupMs: number;
  pendingApprovalCleanupMs: number;
  dbPath: string;
  stateFile: string;
}

interface ConfigFile {
  port?: number;
  bossModel?: string;
  bossActiveMs?: number;
  autoResetSeconds?: number;
  cleanupMinutes?: number;
  staleAgentMs?: number;
  maxMessages?: number;
  sseKeepAliveMs?: number;
  cleanupIntervalMs?: number;
  approvalDecisionCleanupMs?: number;
  pendingApprovalCleanupMs?: number;
}

function loadConfigFile(): ConfigFile {
  const configPath = path.join(__dirname, '..', 'config.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(raw) as ConfigFile;
  } catch {
    return {};
  }
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v !== undefined) {
    const n = parseInt(v, 10);
    if (!isNaN(n)) return n;
  }
  return fallback;
}

function envStr(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

export function loadConfig(): Config {
  const file = loadConfigFile();
  const home = process.env.HOME || '/tmp';

  return {
    port: envInt('PORT', envInt('AGENT_VIZ_PORT', file.port ?? 1217)),
    bossModel: envStr('AGENT_VIZ_BOSS_MODEL', file.bossModel ?? 'opus'),
    bossActiveMs: file.bossActiveMs ?? 30_000,
    autoResetMs: envInt('AGENT_VIZ_AUTO_RESET_SECONDS', file.autoResetSeconds ?? 60) * 1000,
    cleanupMs: envInt('AGENT_VIZ_CLEANUP_MINUTES', file.cleanupMinutes ?? 30) * 60 * 1000,
    staleAgentMs: file.staleAgentMs ?? 300_000,
    maxMessages: file.maxMessages ?? 200,
    sseKeepAliveMs: file.sseKeepAliveMs ?? 20_000,
    cleanupIntervalMs: file.cleanupIntervalMs ?? 60_000,
    approvalDecisionCleanupMs: file.approvalDecisionCleanupMs ?? 300_000,
    pendingApprovalCleanupMs: file.pendingApprovalCleanupMs ?? 90_000,
    dbPath: path.join(home, '.agent-visualization.db'),
    stateFile: envStr('AGENT_VIZ_STATE_FILE', path.join(home, '.agent-visualization-state.json')),
  };
}

export const config = loadConfig();

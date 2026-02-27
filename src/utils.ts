import crypto from 'crypto';
import type { AgentUsage } from './types.js';

export function parseUsage(output: unknown): AgentUsage | null {
  if (typeof output !== 'string') return null;
  const usageBlock = output.match(/<usage>([\s\S]*?)<\/usage>/);
  const text = usageBlock ? usageBlock[1] : output;
  const totalMatch = text.match(/total_tokens[:\s]+(\d+)/);
  const toolMatch = text.match(/tool_uses[:\s]+(\d+)/);
  const durMatch = text.match(/duration_ms[:\s]+(\d+)/);
  if (!totalMatch && !toolMatch && !durMatch) return null;
  return {
    total_tokens: totalMatch ? parseInt(totalMatch[1], 10) : 0,
    tool_uses: toolMatch ? parseInt(toolMatch[1], 10) : 0,
    duration_ms: durMatch ? parseInt(durMatch[1], 10) : 0,
  };
}

export function makeKey(session_id: string, description: string): string {
  return crypto
    .createHash('sha1')
    .update(`${session_id}:${description}`)
    .digest('hex')
    .slice(0, 12);
}

export function isError(is_error: boolean | undefined, tool_output: unknown): boolean {
  if (is_error === true) return true;
  if (is_error === false) return false;
  if (typeof tool_output === 'string') {
    const sample = tool_output.slice(0, 500).toLowerCase();
    return /\berror[:;\s]|\bfailed\b|\bexception\b|\btraceback\b/.test(sample);
  }
  return false;
}

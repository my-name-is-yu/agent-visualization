import { describe, it, expect } from 'vitest';
import { parseUsage, makeKey, isError } from './utils.js';

describe('parseUsage', () => {
  it('parses usage block format', () => {
    const output = 'Some result\n<usage>\ntotal_tokens: 5000\ntool_uses: 12\nduration_ms: 30000\n</usage>';
    const result = parseUsage(output);
    expect(result).toEqual({
      total_tokens: 5000,
      tool_uses: 12,
      duration_ms: 30000,
    });
  });

  it('parses inline format without tags', () => {
    const output = 'total_tokens: 1000\ntool_uses: 5\nduration_ms: 10000';
    const result = parseUsage(output);
    expect(result).toEqual({
      total_tokens: 1000,
      tool_uses: 5,
      duration_ms: 10000,
    });
  });

  it('returns null for non-string input', () => {
    expect(parseUsage(null)).toBeNull();
    expect(parseUsage(undefined)).toBeNull();
    expect(parseUsage(123)).toBeNull();
  });

  it('returns null when no usage data found', () => {
    expect(parseUsage('just some text')).toBeNull();
  });

  it('handles partial usage data', () => {
    const result = parseUsage('total_tokens: 500');
    expect(result).toEqual({
      total_tokens: 500,
      tool_uses: 0,
      duration_ms: 0,
    });
  });
});

describe('makeKey', () => {
  it('returns a 12-character hex string', () => {
    const key = makeKey('session-1', 'description-1');
    expect(key).toMatch(/^[0-9a-f]{12}$/);
  });

  it('returns different keys for different inputs', () => {
    const key1 = makeKey('session-1', 'desc-1');
    const key2 = makeKey('session-1', 'desc-2');
    const key3 = makeKey('session-2', 'desc-1');
    expect(key1).not.toBe(key2);
    expect(key1).not.toBe(key3);
  });

  it('returns same key for same inputs', () => {
    const key1 = makeKey('s', 'd');
    const key2 = makeKey('s', 'd');
    expect(key1).toBe(key2);
  });
});

describe('isError', () => {
  it('returns true when is_error is true', () => {
    expect(isError(true, 'success')).toBe(true);
  });

  it('returns false when is_error is false', () => {
    expect(isError(false, 'Error: something')).toBe(false);
  });

  it('detects error patterns in output', () => {
    expect(isError(undefined, 'Error: connection failed')).toBe(true);
    expect(isError(undefined, 'Operation failed')).toBe(true);
    expect(isError(undefined, 'Exception thrown')).toBe(true);
    expect(isError(undefined, 'Traceback (most recent call last)')).toBe(true);
  });

  it('returns false for normal output', () => {
    expect(isError(undefined, 'Task completed successfully')).toBe(false);
  });

  it('returns false for non-string output', () => {
    expect(isError(undefined, null)).toBe(false);
    expect(isError(undefined, undefined)).toBe(false);
  });
});

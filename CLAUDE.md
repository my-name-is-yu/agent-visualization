# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A macOS menu bar tool that visualizes Claude Code's multi-agent system in real time. It tracks agent lifecycle events via Claude Code hooks and displays them in a native Swift menu bar app.

## Commands

```bash
npm run build       # TypeScript compile (outputs to dist/)
npm run dev         # tsc --watch
npm start           # node dist/server.js (port 1217)
npm test            # vitest run
npm run test:watch  # vitest (interactive watch)
npx vitest run src/matching.test.ts  # run a single test file
```

No linter is configured. The Swift menu bar app is compiled separately via `install.sh`.

## Architecture

### Data Flow

```
Claude Code Hooks (PreToolUse/PostToolUse)
  → hook.js (stdin JSON → HTTP POST /event, 500ms timeout)
  → Express server (localhost:1217)
  → state.ts (in-memory Map<string, AgentRecord> + SQLite persistence)
  → SSE /events (push notifications)
  → AgentMenuBar.swift (native macOS, polls /state + listens SSE)
```

Approval flow is separate: `approval-hook.js` → POST `/approval/request` → long-poll `/approval/response/:id` → menu bar responds.

### Key Design Decisions

- **hook.js and approval-hook.js are plain JS** (not TypeScript, not compiled). They run directly as Claude Code hooks and must stay that way.
- **Agent keying**: Agents are keyed in `Map` by `tool_use_id`. Fallback key is a 12-char SHA1 of `session_id:description` (via `makeKey`).
- **`notifyClients()`** is the single mutation gate — it pushes SSE events AND flushes dirty agents to SQLite. Always call it after state changes.
- **Two-layer persistence**: in-memory Map for speed, SQLite (`~/.agent-visualization.db`) for crash recovery. Dirty tracking (`dirtyAgentIds: Set`) batches DB writes.
- **Auto-reset**: when all agents complete, a timer (default 60s) clears state and snapshots the session into `lastSessionSummary`.
- **Boss status** is derived, not stored: based on running agents, heartbeat freshness, and turn-done timing.

### Hook Event Lifecycle

1. **Pre-phase Task/Agent**: Creates `AgentRecord` with `status: 'running'`, assigns parent via `findDeepestRunningAgent`.
2. **Post-phase Task/Agent**: If output matches `/Async agent launched/i`, stays running (background); otherwise → `completed`/`errored`.
3. **Post-phase TaskOutput**: Marks matching background agent as complete.
4. **Non-agent tools** (Read, Write, Bash, etc.): Only update `currentTool` display, no agent record.

## Testing Patterns

- Tests mock `./db.js` to use in-memory SQLite (`:memory:`), not the filesystem.
- Route handlers are extracted from the Express router stack and tested directly (no supertest/HTTP).
- Fixtures in `src/__fixtures__/events.ts` provide `makeAgent()`, `samplePreEvent`, `samplePostEvent`.
- Tests call `initState()` + `resetState()` in `beforeEach` for isolation.

## Config

Runtime config: `config.json` at project root. Config loading precedence: env vars > config.json > defaults (see `src/config.ts`).

State files at runtime: `~/.agent-visualization.db` (SQLite), `~/.agent-visualization-state.json` (legacy, auto-migrated).

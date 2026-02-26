# agent-visualization

A macOS menu bar tool that visualizes Claude Code's multi-agent system in real time. Tracks agent lifecycle events via Claude Code hooks and displays Boss status, running agents, token usage, and cost estimates — without leaving your workflow.

![macOS menu bar agent status display]

## How it works

```
Claude Code Hooks (PreToolUse / PostToolUse)
  → hook.js        (stdin → HTTP bridge, 500ms timeout)
  → server.js      (Express, port 1217, SSE push)
  → AgentMenuBar   (Swift/Cocoa menu bar app, SSE + polling)
```

Claude Code fires hooks on every `Task` tool call. `hook.js` forwards the event to the local Express server, which maintains agent state and pushes updates to the menu bar app via Server-Sent Events.

## Features

- **Menu bar icon** — shows Boss status (idle / running / done) at a glance
- **Agent list** — running, completed, and errored agents with subagent type and duration
- **Agent detail view** — prompt, output preview, token count, tool uses, and duration
- **Copy buttons** — copy prompt or output to clipboard from the detail view
- **Session usage** — cumulative tokens, tool uses, and estimated cost for the session
- **macOS notifications** — native notification on agent completion or error
- **Auto-reset** — clears state after all agents complete (configurable timeout)
- **State persistence** — survives server restarts; stale running agents are marked errored on reload

## Prerequisites

- macOS 13 (Ventura) or later
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed
- Node.js v18 or later
- Xcode Command Line Tools (`xcode-select --install`)

## Installation

```bash
git clone https://github.com/my-name-is-yu/agent-visualization.git
cd agent-visualization
./install.sh
```

`install.sh` handles everything automatically:

1. Installs npm dependencies
2. Compiles `AgentMenuBar.swift` into a native app bundle
3. Copies icon resources into the bundle
4. Ad-hoc code signs the app (required for macOS notifications)
5. Creates LaunchAgent plists for both the server and menu bar app
6. Loads both services via `launchctl`

After install, look for the icon in your macOS menu bar.

## Manual configuration

After running `install.sh`, add the following to your Claude Code configuration.

### 1. Claude Code hooks (`~/.claude/settings.json`)

Add the `hooks` block so Claude Code forwards `Task` events to the server:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Task",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/agent-visualization/hook.js --phase pre"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Task",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/agent-visualization/hook.js --phase post"
          }
        ]
      },
      {
        "matcher": "TaskOutput",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/agent-visualization/hook.js --phase post"
          }
        ]
      }
    ]
  }
}
```

Replace `/path/to/agent-visualization` with the absolute path to this repository.

### 2. Boss Activity Signal (`~/.claude/CLAUDE.md`)

Add these signals to your CLAUDE.md so the menu bar reflects Boss activity:

**Boss Activity Signal** — run once at the start of each user request:

```bash
curl -sX POST http://127.0.0.1:1217/heartbeat > /dev/null 2>&1
```

**Background Agent Completion Signal** — call when a background agent finishes:

```bash
curl -sX POST http://127.0.0.1:1217/complete \
  -H "Content-Type: application/json" \
  -d '{"description":"<agent description>","result":"<output>","tokens":<n>,"tool_uses":<n>,"duration_ms":<n>}' \
  > /dev/null 2>&1
```

See the [multi-agent protocol setup](https://github.com/my-name-is-yu/claude-code-multi-agent-setup) for a complete CLAUDE.md template.

## Environment variables

| Variable | Description | Default |
|---|---|---|
| `AGENT_VIZ_PORT` | Server port | `1217` |
| `AGENT_VIZ_COST_PER_MTOK` | Cost per million tokens (USD) | `9` |
| `AGENT_VIZ_BOSS_MODEL` | Boss model display name in menu bar | `opus` |
| `AGENT_VIZ_AUTO_RESET_SECONDS` | Seconds after all agents complete before state resets | `60` |
| `AGENT_VIZ_CLEANUP_MINUTES` | Minutes to retain completed agent records | `30` |

Set environment variables in the LaunchAgent plist at `~/Library/LaunchAgents/com.agent-visualization.plist` using the `EnvironmentVariables` key, then reload the service.

## API endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/state` | Full agent state (polling) |
| `GET` | `/events` | SSE stream for state-change notifications |
| `POST` | `/event` | Receive hook events from Claude Code |
| `POST` | `/heartbeat` | Signal Boss activity |
| `POST` | `/complete` | Signal background agent completion |
| `POST` | `/reset` | Clear all state |

## Troubleshooting

**Check server state:**
```bash
curl http://localhost:1217/state
```

**Check processes:**
```bash
pgrep -f "node.*server.js"   # server
pgrep -f AgentMenuBar         # menu bar app
```

**View logs:**
```
~/Library/Logs/agent-visualization/server.log
~/Library/Logs/agent-visualization/server.err
~/Library/Logs/agent-visualization/menubar.log
~/Library/Logs/agent-visualization/menubar.err
```

**Restart server:**
```bash
launchctl kickstart -k gui/$(id -u)/com.agent-visualization
```

**Restart menu bar app:**
```bash
launchctl kickstart -k gui/$(id -u)/com.agent-visualization.menubar
```

**Uninstall:**
```bash
launchctl unload ~/Library/LaunchAgents/com.agent-visualization.plist
launchctl unload ~/Library/LaunchAgents/com.agent-visualization.menubar.plist
```

## Project structure

```
agent-visualization/
  server.js              # Express server — agent state, SSE push, auto-reset
  hook.js                # Claude Code hook — reads stdin, POSTs to server (500ms timeout)
  install.sh             # Automated installer
  package.json           # Node.js manifest (express dependency)
  Icon.png               # Menu bar icon (color)
  IconBlack.png          # Menu bar icon (monochrome)
  menubar/
    AgentMenuBar.swift   # Native macOS menu bar app source
    AgentMenuBar.app/    # Compiled app bundle (created by install.sh)
      Contents/
        MacOS/           # Compiled binary
        Resources/       # Icons
        Info.plist       # App bundle metadata
```

## Related

- [claude-code-multi-agent-setup](https://github.com/my-name-is-yu/claude-code-multi-agent-setup) — CLAUDE.md multi-agent protocol that this tool is designed to work with

## License

MIT

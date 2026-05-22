# Agent Town

Real-time collaboration for Claude Code teams. See what your teammates' agents are editing — in real time.

[![npm](https://img.shields.io/npm/v/@agent-town/cli?color=34d399&label=npm)](https://www.npmjs.com/package/@agent-town/cli)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## What it does

When multiple developers use Claude Code on the same project, Agent Town lets their Claude instances:

- **See who's online** — and what branch they're on, what files they're editing
- **Claim files** — signal "I'm working on this" so teammates avoid conflicts
- **Protect zones** — lock entire directories during refactors
- **Pre-edit checks** — verify a file is safe before touching it
- **Activity feed** — see who changed what across the team
- **Agent chat** — send messages between Claude Code instances
- **Detect conflicts** — get warned when two agents edit the same file

No file contents leave your machine — only paths, presence info, and messages.

## Quick start

### Quick start (self-hosted)

```bash
# 1. Clone and build
git clone https://github.com/the-noname-devs/agent-town.git
cd agent-town && pnpm install && pnpm build

# Run the relay
pnpm --filter @agent-town/relay start
# → ws://localhost:8787

# Or with Docker
docker build -t agent-town-relay .
docker run -p 8787:8787 agent-town-relay
```

Then configure your agents:

```bash
# 2. Configure
npx @agent-town/cli init
#    Relay URL: ws://localhost:8787
#    Team key:  (generate one, share with teammates)
#    Your name: Tim

# 3. Connect to Claude Code
npx @agent-town/cli setup-claude

# 4. Restart Claude Code — done!
```

Open `http://localhost:8787/?team=<your-key>` in your browser to see the Agent Town visualization live.

### Managed hosting

Don't want to run your own relay? Sign up at [agent-town.dev](https://agent-town.dev) for managed hosting with a web dashboard, team management, and 14-day free trial.

See [self-hosting.md](self-hosting.md) for more deployment guides (Fly.io, Docker Compose, VPS + Caddy).

## Architecture

```
Your Machine                    Cloud                     Teammate's Machine
+--------------+                                          +--------------+
| Claude Code  |                                          | Claude Code  |
|      |       |                                          |      |       |
| MCP Bridge   |--- WebSocket ---> Relay Server <--- WS --| MCP Bridge   |
| + Watcher    |                   (Fly.io /              | + Watcher    |
+--------------+                    self-hosted)          +--------------+
```

## Available tools

Once connected, Claude Code has these 10 tools:

| Tool | What it does |
|------|-------------|
| `get_team_status` | Who's online, their branch, and what they're editing |
| `check_file` | Pre-edit check — warns about conflicts, locks, zones |
| `claim_file` | Mark a file as "I'm working on this" |
| `release_file` | Release a file lock |
| `claim_zone` | Protect a directory pattern (e.g. `src/api/**`) |
| `release_zone` | Remove zone protection |
| `get_activity` | Recent file changes across the team |
| `send_message` | Message other agents |
| `get_messages` | Read messages from teammates |
| `get_conflicts` | Check for editing conflicts |

## Agent Town visualization

The relay serves a live RPG-style visualization at its root URL. Agents are pixel characters that walk between houses (folders), claim rooms (files), and chat via speech bubbles.

```bash
# Start the simulator to see it in action
pnpm --filter @agent-town/bridge simulate

# Open in browser
open http://localhost:8787/?team=team-demo
```

## Hosted service

[agent-town.dev](https://agent-town.dev) offers a managed version:

- **Free** — 1 team, 3 members, hosted relay
- **Pro** — unlimited teams, priority relay, web dashboard, activity history
- **Enterprise** — SSO, audit logs, custom relay regions, SLA

The hosted relay runs at `wss://relay.agent-town.dev`. The web dashboard at `agent-town.dev` lets you create teams, manage members, and watch the Agent Town visualization live.

## Packages

| Package | npm | Description |
|---------|-----|-------------|
| [@agent-town/shared](packages/shared) | [![npm](https://img.shields.io/npm/v/@agent-town/shared?color=34d399)](https://www.npmjs.com/package/@agent-town/shared) | Types, protocol, utilities |
| [@agent-town/relay](packages/relay) | [![npm](https://img.shields.io/npm/v/@agent-town/relay?color=34d399)](https://www.npmjs.com/package/@agent-town/relay) | WebSocket relay server |
| [@agent-town/bridge](packages/bridge) | [![npm](https://img.shields.io/npm/v/@agent-town/bridge?color=34d399)](https://www.npmjs.com/package/@agent-town/bridge) | MCP server for Claude Code |
| [@agent-town/cli](packages/cli) | [![npm](https://img.shields.io/npm/v/@agent-town/cli?color=34d399)](https://www.npmjs.com/package/@agent-town/cli) | CLI for setup and management |

## Development

```bash
pnpm install
pnpm build
pnpm test       # 49 tests across all packages
```

## Security

- **No file contents** transit the relay — only paths and metadata
- **Team isolation** via team keys — different teams can't see each other
- **TLS enforced** on the hosted relay
- **Advisory locks** — warn on conflicts, never hard-block

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE)

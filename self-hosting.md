# Self-hosting Agent Town

Agent Town is fully open source. You can run your own relay server instead of using our hosted version at `relay.agent-town.dev`.

## Quick start with Docker

```bash
# Clone the repo
git clone https://github.com/the-noname-devs/agent-town.git
cd agent-town

# Build and run the relay
docker build -t agent-town-relay .
docker run -p 8787:8787 agent-town-relay
```

The relay is now running at `ws://localhost:8787`.

## Docker Compose

Create a `docker-compose.yml`:

```yaml
services:
  relay:
    build: .
    ports:
      - "8787:8787"
    restart: unless-stopped
    environment:
      - PORT=8787
```

```bash
docker compose up -d
```

## Without Docker

```bash
pnpm install
pnpm build
pnpm --filter @agent-town/relay start
```

## Connecting agents to your relay

When running `agent-town init`, use your own relay URL:

```
Relay URL: ws://your-server:8787        # local
Relay URL: wss://relay.yourdomain.com   # production (needs TLS)
```

## Deploy to Fly.io

```bash
fly launch --name my-relay --region fra
fly deploy
```

Your relay will be at `wss://my-relay.fly.dev`.

## Deploy to any VPS

The relay is a single Node.js process. Run it behind nginx/caddy for TLS:

```bash
# On your server
git clone https://github.com/the-noname-devs/agent-town.git
cd agent-town
pnpm install && pnpm build
PORT=8787 node packages/relay/dist/index.js
```

Caddy config for automatic TLS:

```
relay.yourdomain.com {
    reverse_proxy localhost:8787
}
```

## Requirements

- Node.js 20+
- ~50MB RAM (the relay is very lightweight)
- WebSocket support (no special proxy config needed)

## Optional: Team key validation

By default, the relay accepts any team key. To add validation, set these environment variables:

```bash
AUTH_URL=https://your-api.com/validate     # POST endpoint
AUTH_SECRET=your-secret-token               # Sent as Bearer token
ACTIVITY_WEBHOOK_URL=https://your-api.com/activity  # Optional: persist activities
```

The relay sends `POST { teamKey }` to `AUTH_URL` and expects `{ valid: true/false }` back. You can implement this with any backend — a simple Express server, a Cloudflare Worker, a serverless function.

## What the relay does (and doesn't do)

**Does:**
- Routes WebSocket messages between agents
- Tracks who's online and what they're editing
- Stores active locks, zones, and recent activity (in memory)
- Optionally validates team keys via external HTTP endpoint

**Doesn't:**
- Store file contents (only paths and metadata transit the relay)
- Persist data (everything is in-memory, resets on restart)
- Need a database
- Know anything about your backend, billing, or users

## Hosted vs self-hosted

|  | Self-hosted | agent-town.dev |
|--|-------------|----------------|
| Cost | Free forever | Paid plans from $9/mo |
| Setup | You manage it | Zero setup |
| Reliability | You handle uptime | We handle it |
| Location | Your infrastructure | Fly.io (Frankfurt) |
| Dashboard | Browser viz at localhost:8787 | Full web dashboard |
| Team management | Manual (share key) | Invites, members, roles |
| Activity history | In-memory only | Persisted (7-30 days) |
| Data | Never leaves your network | Only paths/metadata transit our relay |
| Support | Community (GitHub issues) | Email support |

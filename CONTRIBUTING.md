# Contributing to Agent Town

Thanks for your interest in contributing! Agent Town is an open-source project and we welcome contributions of all kinds.

## Getting started

```bash
git clone https://github.com/the-noname-devs/agent-town.git
cd agent-town
pnpm install
pnpm build
pnpm test
```

## Project structure

```
packages/
  shared/    Types, protocol, utilities (no dependencies)
  relay/     WebSocket relay server (Fly.io / self-hosted)
  bridge/    MCP server for Claude Code (runs locally)
  cli/       CLI for setup and configuration
apps/
  web/       Next.js dashboard + marketing site
```

## Development workflow

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Run `pnpm build && pnpm test` to verify everything passes
4. Open a pull request with a clear description

## Code conventions

- TypeScript strict mode everywhere
- No `any` types (except where explicitly needed in town-renderer)
- Tests for all new relay/bridge features (vitest)
- Keep packages small and focused

## What to work on

- Check [open issues](https://github.com/the-noname-devs/agent-town/issues) for bugs and feature requests
- Issues labeled `good first issue` are great starting points
- If you want to work on something bigger, open an issue first to discuss

## Testing

```bash
pnpm test          # Run all tests (49 tests across 4 packages)
pnpm build         # Build all packages
pnpm --filter @agent-town/relay test   # Test specific package
```

## Commit messages

We use conventional-ish commit messages:

```
feat: add branch awareness to team status
fix: prevent EMFILE crash in FileWatcher
docs: update self-hosting guide
```

## Releasing

Releases are managed by maintainers. If you're a maintainer:

```bash
# Bump versions
pnpm -r exec -- npm version patch

# Publish to npm
pnpm -r publish --access public --no-git-checks
```

## Code of conduct

Be kind, be constructive, be helpful. We're building tools for collaboration — let's practice what we preach.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

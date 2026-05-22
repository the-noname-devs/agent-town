#!/usr/bin/env node

import { init } from "./commands/init.js";
import { login } from "./commands/login.js";
import { status } from "./commands/status.js";
import { setupClaude } from "./commands/setup-claude.js";

const command = process.argv[2];

switch (command) {
  case "init":
    await init();
    break;
  case "login":
    await login();
    break;
  case "status":
    await status();
    break;
  case "setup-claude":
    await setupClaude();
    break;
  case "help":
  case undefined:
    printHelp();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
}

function printHelp(): void {
  console.log(`
agent-town - Real-time collaboration for Claude Code teams

Usage:
  agent-town <command>

Commands:
  login          Sign in via browser and auto-configure (recommended)
  init           Manual setup — paste relay URL and team key
  status         Show current team status from the relay server
  setup-claude   Configure Claude Code to use agent-town (MCP + hooks)
  help           Show this help message

Examples:
  agent-town login
  agent-town setup-claude
`);
}

#!/usr/bin/env node

import { BridgeMcpServer } from "./mcp-server.js";

const server = new BridgeMcpServer();
server.start().catch((err) => {
  console.error("Failed to start bridge MCP server:", err);
  process.exit(1);
});

#!/usr/bin/env node

import { RelayServer } from "./server.js";

const port = parseInt(process.env.PORT || "8787", 10);

const server = new RelayServer({
  port,
  authUrl: process.env.AUTH_URL,
  authSecret: process.env.AUTH_SECRET,
  activityWebhookUrl: process.env.ACTIVITY_WEBHOOK_URL,
});

server.start();

process.on("SIGINT", () => {
  console.log("\nShutting down relay server...");
  server.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  server.stop();
  process.exit(0);
});

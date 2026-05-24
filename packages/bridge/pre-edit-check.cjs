#!/usr/bin/env node
/**
 * PreToolUse Hook — checks if a file is safe to edit before Claude proceeds.
 * Blocks the edit if another agent has the file locked or it's in a protected zone.
 * Fails open (allows) on any error or timeout.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

try {
  const input = JSON.parse(fs.readFileSync("/dev/stdin", "utf-8"));
  const filePath = input.tool_input?.file_path || input.tool_input?.path || "";
  const cwd = input.cwd || process.cwd();

  if (!filePath) {
    // No file path — allow
    console.log(JSON.stringify({}));
    process.exit(0);
  }

  const configPath = path.join(os.homedir(), ".agent-town", "config.json");
  if (!fs.existsSync(configPath)) {
    console.log(JSON.stringify({}));
    process.exit(0);
  }

  const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  if (!config.relayUrl || !config.teamKey) {
    console.log(JSON.stringify({}));
    process.exit(0);
  }

  // Get session-specific identity
  let userName = config.userName;
  let agentId = config.agentId || "";
  if (input.session_id) {
    const sessFile = path.join(os.homedir(), ".agent-town", "sessions", input.session_id + ".json");
    try {
      if (fs.existsSync(sessFile)) {
        const sess = JSON.parse(fs.readFileSync(sessFile, "utf-8"));
        userName = sess.userName || userName;
        agentId = sess.agentId || agentId;
      }
    } catch {}
  }

  // Make path relative to cwd
  let relativePath = filePath;
  if (path.isAbsolute(filePath) && cwd) {
    relativePath = path.relative(cwd, filePath);
  }

  const relayHttp = config.relayUrl
    .replace("wss://", "https://")
    .replace("ws://", "http://");

  const url = `${relayHttp}/check-conflict?teamKey=${encodeURIComponent(config.teamKey)}&path=${encodeURIComponent(relativePath)}&agentId=${encodeURIComponent(agentId)}&userName=${encodeURIComponent(userName)}`;

  // Use AbortController for timeout
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  fetch(url, { signal: controller.signal })
    .then((res) => res.json())
    .then((data) => {
      clearTimeout(timeout);
      if (data.allowed === false && data.reason) {
        console.log(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: `⚠️ ${data.reason} — coordinate via send_message first`,
          },
        }));
      } else {
        // File is clear
        console.log(JSON.stringify({}));
      }
    })
    .catch(() => {
      clearTimeout(timeout);
      // Fail open — allow on any error
      console.log(JSON.stringify({}));
    });
} catch {
  // Fail open
  console.log(JSON.stringify({}));
}

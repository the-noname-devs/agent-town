#!/usr/bin/env node
/**
 * PreToolUse Hook — checks if a file is safe to edit before Claude proceeds.
 * Blocks the edit if another agent has the file locked or it's in a protected zone.
 * Fails open (allows) on any error or timeout.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

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

  // Get session-specific identity from active bridge file
  let userName = config.userName;
  let agentId = config.agentId || "";
  try {
    const activeDir = path.join(os.homedir(), ".agent-town", "active");
    if (fs.existsSync(activeDir)) {
      const hookCwd = cwd;
      let best = null;
      for (const f of fs.readdirSync(activeDir)) {
        if (!f.endsWith(".json")) continue;
        try {
          const s = JSON.parse(fs.readFileSync(path.join(activeDir, f), "utf-8"));
          if (s.cwd === hookCwd) { userName = s.userName; agentId = s.agentId; best = null; break; }
          if (!best || s.startedAt > best.startedAt) best = s;
        } catch {}
      }
      if (best) { userName = best.userName; agentId = best.agentId; }
    }
  } catch {}

  // Make path relative to git root (or cwd fallback)
  let relativePath = filePath;
  try {
    const dir = path.dirname(filePath);
    const root = execSync("git rev-parse --show-toplevel", { cwd: dir, encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] }).trim();
    relativePath = path.relative(root, filePath).replace(/\\/g, "/");
  } catch {
    if (path.isAbsolute(filePath) && cwd) {
      relativePath = path.relative(cwd, filePath).replace(/\\/g, "/");
    }
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

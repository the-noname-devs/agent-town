#!/usr/bin/env node
/**
 * PreToolUse Hook — checks if a file is safe to edit before Claude proceeds.
 * Blocks the edit if another agent has the file locked or it's in a protected zone.
 * Fails open (allows) on any error or timeout.
 *
 * Side effect: for Write tool, snapshots the current file line count into a
 * tiny cache under ~/.agent-town/pre-edit-cache.json so the PostToolUse hook
 * can compute lines added/removed (Edit tool gets that from tool_input directly).
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

function countLines(content) {
  if (!content) return 0;
  // Number of \n + 1 if file isn't empty (trailing newline counts as the
  // line it terminates, so we don't add 1 for content ending in \n).
  const n = (content.match(/\n/g) || []).length;
  return n + (content.endsWith("\n") || content === "" ? 0 : 1);
}

function snapshotForWrite(input) {
  const toolName = input.tool_name || "";
  if (toolName !== "Write") return;
  const filePath = input.tool_input?.file_path || input.tool_input?.path || "";
  if (!filePath) return;

  let lines = 0;
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    lines = countLines(raw);
  } catch {
    // File doesn't exist yet → 0 lines pre-write
  }

  const cachePath = path.join(os.homedir(), ".agent-town", "pre-edit-cache.json");
  let cache = {};
  try {
    if (fs.existsSync(cachePath)) cache = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
  } catch { /* ignore */ }
  cache[filePath] = { lines, ts: Date.now() };

  // Garbage collect anything older than 10 minutes
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const k of Object.keys(cache)) {
    if (!cache[k] || cache[k].ts < cutoff) delete cache[k];
  }

  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(cache));
  } catch { /* ignore */ }
}

try {
  const input = JSON.parse(fs.readFileSync("/dev/stdin", "utf-8"));
  const filePath = input.tool_input?.file_path || input.tool_input?.path || "";
  const cwd = input.cwd || process.cwd();

  if (!filePath) {
    console.log(JSON.stringify({}));
    process.exit(0);
  }

  // Snapshot before kicking off the network check (sync, fast).
  snapshotForWrite(input);

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
        console.log(JSON.stringify({}));
      }
    })
    .catch(() => {
      clearTimeout(timeout);
      console.log(JSON.stringify({}));
    });
} catch {
  console.log(JSON.stringify({}));
}

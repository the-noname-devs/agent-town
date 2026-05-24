#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

// --- Git info ---
// Finds git root + remote repo name for the given file
function getGitInfo(filePath) {
  try {
    const dir = path.dirname(filePath);
    const root = execSync("git rev-parse --show-toplevel", { cwd: dir, encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] }).trim();
    let repo = path.basename(root); // fallback: folder name
    try {
      const remote = execSync("git remote get-url origin", { cwd: dir, encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] }).trim();
      // Parse "git@github.com:org/repo.git" or "https://github.com/org/repo.git"
      const match = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
      if (match) repo = match[1]; // "org/repo"
    } catch {}
    const relativePath = path.relative(root, filePath).replace(/\\/g, "/");
    return { repo, relativePath, root };
  } catch {
    return null; // not in a git repo
  }
}

// --- Session identity ---
// Reads the active bridge's identity (written by MCP bridge on startup)
function getSessionIdentity(config, cwd) {
  try {
    const activeDir = path.join(os.homedir(), ".agent-town", "active");
    if (!fs.existsSync(activeDir)) return { userName: config.userName, agentId: config.agentId };
    let best = null;
    for (const f of fs.readdirSync(activeDir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(activeDir, f), "utf-8"));
        if (s.cwd === cwd) return { userName: s.userName, agentId: s.agentId };
        if (!best || s.startedAt > best.startedAt) best = s;
      } catch {}
    }
    if (best) return { userName: best.userName, agentId: best.agentId };
  } catch {}
  return { userName: config.userName, agentId: config.agentId };
}

// --- Auto-chat messages ---
function generateChat(filePath) {
  const file = path.basename(filePath);
  const dir = path.basename(path.dirname(filePath));
  const ext = path.extname(file);
  const messages = [
    `tweaking ${file}`,
    `fixing something in ${dir}/`,
    `updating ${file}`,
    `working on ${dir}/${file}`,
    `improving ${dir}/`,
  ];
  if (file.includes("route") || file.includes("api")) messages.push(`API work on ${file}`, `adjusting ${dir}/ API`);
  if (file.includes("test")) messages.push(`writing tests`, `testing ${dir}/`);
  if (file.includes("config") || file.includes("setting")) messages.push(`updating config`);
  if (ext === ".css" || ext === ".scss" || ext === ".tsx") messages.push(`styling ${dir}/`);
  if (file.includes("schema") || file.includes("migration")) messages.push(`touching the schema — careful!`);
  if (dir === "components" || dir === "ui") messages.push(`building UI in ${dir}/`);
  return messages[Math.floor(Math.random() * messages.length)];
}

// --- Main ---
try {
  const input = JSON.parse(fs.readFileSync("/dev/stdin", "utf-8"));
  const filePath = input.tool_input?.file_path || input.tool_input?.path || "";
  if (!filePath) process.exit(0);

  const configPath = path.join(os.homedir(), ".agent-town", "config.json");
  if (!fs.existsSync(configPath)) process.exit(0);

  const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

  // Detect git repo + relative path
  const gitInfo = getGitInfo(filePath);
  let relativePath, repo;
  if (gitInfo) {
    relativePath = gitInfo.relativePath;
    repo = gitInfo.repo;
    // Filter: if config.repos is set, only track allowed repos
    if (config.repos && config.repos.length > 0) {
      // Match by full "org/repo" or just repo name
      const repoName = repo.includes("/") ? repo.split("/").pop() : repo;
      const allowed = config.repos.some(r => r === repo || r.endsWith("/" + repoName) || r === repoName);
      if (!allowed) process.exit(0); // private repo, don't track
    }
  } else {
    // Fallback: not in git, use cwd-relative
    relativePath = path.relative(input.cwd || process.cwd(), filePath).replace(/\\/g, "/");
    repo = undefined;
  }

  const hookCwd = input.cwd || process.cwd();
  const { userName, agentId } = getSessionIdentity(config, hookCwd);
  const relayHttp = config.relayUrl.replace("wss://", "https://").replace("ws://", "http://");
  const chat = generateChat(filePath);

  fetch(relayHttp + "/file-change", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      teamKey: config.teamKey,
      agentId,
      userName,
      path: relativePath,
      repo,
      action: "edit",
      chat,
    }),
  }).catch(() => {});

  setTimeout(() => process.exit(0), 500);
} catch {
  process.exit(0);
}

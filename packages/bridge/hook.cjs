#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

// --- Git info ---
function getGitInfo(filePath) {
  try {
    const dir = path.dirname(filePath);
    const root = execSync("git rev-parse --show-toplevel", { cwd: dir, encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] }).trim();
    let repo = path.basename(root);
    try {
      const remote = execSync("git remote get-url origin", { cwd: dir, encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] }).trim();
      const match = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
      if (match) repo = match[1];
    } catch {}
    const relativePath = path.relative(root, filePath).replace(/\\/g, "/");
    return { repo, relativePath, root };
  } catch {
    return null;
  }
}

// --- Session identity ---
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

// --- Smart chat: only on area changes, meaningful summaries ---
function getEditTracker() {
  const trackerPath = path.join(os.homedir(), ".agent-town", "edit-tracker.json");
  try {
    if (fs.existsSync(trackerPath)) {
      const data = JSON.parse(fs.readFileSync(trackerPath, "utf-8"));
      // Reset if older than 30 min
      if (Date.now() - data.lastEdit > 30 * 60 * 1000) return null;
      return data;
    }
  } catch {}
  return null;
}

function saveEditTracker(tracker) {
  const trackerPath = path.join(os.homedir(), ".agent-town", "edit-tracker.json");
  try { fs.writeFileSync(trackerPath, JSON.stringify(tracker)); } catch {}
}

function getArea(relativePath) {
  const parts = relativePath.split("/");
  // Find the most meaningful area name
  // e.g. "apps/builder/src/section-templates/hero.tsx" → "section-templates"
  // e.g. "packages/relay/src/server.ts" → "relay"
  const skip = new Set(["src", "app", "lib", "dist", "pages", "api"]);
  for (const p of parts.slice(0, -1)) {
    if (!skip.has(p) && !p.startsWith("[") && !p.startsWith(".")) return p;
  }
  return parts.length > 1 ? parts[parts.length - 2] : "root";
}

function generateSmartChat(relativePath, tracker) {
  const area = getArea(relativePath);
  const file = path.basename(relativePath);
  const ext = path.extname(file);

  // First edit or new session
  if (!tracker) {
    return { chat: `starting work in ${area}/`, shouldSend: true, summary: `Working on ${area}` };
  }

  const prevArea = tracker.currentArea;
  const editCount = (tracker.areaEditCount || 0) + 1;

  // Detect file type context
  const typeLabel =
    ["tsx", "jsx", "vue", "svelte"].includes(ext.slice(1)) ? "UI" :
    file.includes("route") || file.includes("api") ? "API" :
    file.includes("migration") || file.includes("schema") ? "DB" :
    file.includes("test") ? "test" :
    [".css", ".scss"].includes(ext) ? "style" :
    [".json", ".yaml", ".toml"].includes(ext) ? "config" :
    file.includes("hook") || file.includes("middleware") ? "infra" :
    null;

  const tag = typeLabel ? `[${typeLabel}]` : "";

  // Same area — contextual per-file message
  if (prevArea === area) {
    const chat = `${tag} ${area}/${file}`.trim();
    // Update summary at milestones
    const summary = editCount === 5 ? `Deep in ${area} (${editCount} files)` :
                    editCount === 15 ? `Major work on ${area} (${editCount} files)` :
                    null;
    return { chat, shouldSend: true, summary };
  }

  // Area changed — announce the switch
  const chat = prevArea
    ? `${tag} → ${area}/${file} (was in ${prevArea}/)`
    : `${tag} starting ${area}/${file}`;

  return { chat: chat.trim(), shouldSend: true, summary: `Working on ${area}` };
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
    if (config.repos && config.repos.length > 0) {
      const repoName = repo.includes("/") ? repo.split("/").pop() : repo;
      const allowed = config.repos.some(r => r === repo || r.endsWith("/" + repoName) || r === repoName);
      if (!allowed) process.exit(0);
    }
  } else {
    relativePath = path.relative(input.cwd || process.cwd(), filePath).replace(/\\/g, "/");
    repo = undefined;
  }

  const hookCwd = input.cwd || process.cwd();
  const { userName, agentId } = getSessionIdentity(config, hookCwd);
  const relayHttp = config.relayUrl.replace("wss://", "https://").replace("ws://", "http://");

  // Smart chat: track areas, only message on changes
  const tracker = getEditTracker();
  const area = getArea(relativePath);
  const { chat, shouldSend, summary } = generateSmartChat(relativePath, tracker);

  // Update tracker
  saveEditTracker({
    currentArea: area,
    areaEditCount: tracker && tracker.currentArea === area ? (tracker.areaEditCount || 0) + 1 : 1,
    lastEdit: Date.now(),
    totalEdits: (tracker?.totalEdits || 0) + 1,
  });

  // Send file change (always)
  const body = {
    teamKey: config.teamKey,
    agentId,
    userName,
    path: relativePath,
    repo,
    action: "edit",
  };
  if (shouldSend && chat) body.chat = chat;

  fetch(relayHttp + "/file-change", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});

  // Update work summary (separate call, non-blocking)
  if (summary) {
    fetch(relayHttp + "/file-change", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        teamKey: config.teamKey,
        agentId,
        userName,
        path: "",
        action: "edit",
        chat: null,
        workSummary: summary,
      }),
    }).catch(() => {});
  }

  setTimeout(() => process.exit(0), 500);
} catch {
  process.exit(0);
}

#!/usr/bin/env node
/**
 * PostToolUse hook — fires after Edit/Write tool runs.
 *
 * Goals:
 *  - Always report the file change to the relay (so the dashboard sees activity).
 *  - Coalesce auto-chats: emit at most ONE chat per agent every COALESCE_MS,
 *    summarising the burst rather than spamming one ping per file.
 *  - Refresh the rolling work-summary at a steady cadence so teammates always
 *    see "what they're working on" with file count + last touched file.
 *  - Use a folder-based tag map (more reliable than filename regex).
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

// ── Tunables ───────────────────────────────────────────────────────────────
const COALESCE_MS = 12_000;     // min interval between auto-chats per agent
const SUMMARY_INTERVAL_MS = 90_000; // refresh work summary at most this often
const TRACKER_TTL_MS = 30 * 60 * 1000; // reset session after this much idle time

// ── Git info ───────────────────────────────────────────────────────────────
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

// ── Session identity ───────────────────────────────────────────────────────
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

// ── Edit tracker (persisted across hook invocations) ───────────────────────
/**
 * Shape:
 *   {
 *     currentArea: string,
 *     areaEditCount: number,
 *     totalEdits: number,
 *     lastEdit: number,
 *     lastChatAt: number,
 *     lastSummaryAt: number,
 *     pendingFiles: { file: string, area: string, tag: string }[],
 *   }
 */
function getEditTracker() {
  const trackerPath = path.join(os.homedir(), ".agent-town", "edit-tracker.json");
  try {
    if (fs.existsSync(trackerPath)) {
      const data = JSON.parse(fs.readFileSync(trackerPath, "utf-8"));
      if (Date.now() - data.lastEdit > TRACKER_TTL_MS) return null;
      return data;
    }
  } catch {}
  return null;
}

function saveEditTracker(tracker) {
  const trackerPath = path.join(os.homedir(), ".agent-town", "edit-tracker.json");
  try { fs.writeFileSync(trackerPath, JSON.stringify(tracker)); } catch {}
}

// ── Path → area + tag ──────────────────────────────────────────────────────
const SKIP_PARTS = new Set(["src", "app", "lib", "dist", "pages", "build"]);

function getArea(relativePath) {
  const parts = relativePath.split("/");
  for (const p of parts.slice(0, -1)) {
    if (!SKIP_PARTS.has(p) && !p.startsWith("[") && !p.startsWith(".")) return p;
  }
  return parts.length > 1 ? parts[parts.length - 2] : "root";
}

/**
 * Folder-segment → tag map. Pick the most specific match in path order, since
 * folder-name signal beats filename regex for accuracy.
 */
const FOLDER_TAGS = [
  { folder: "auth", tag: "auth" },
  { folder: "billing", tag: "billing" },
  { folder: "payments", tag: "billing" },
  { folder: "stripe", tag: "billing" },
  { folder: "supabase", tag: "DB" },
  { folder: "migrations", tag: "DB" },
  { folder: "schema", tag: "DB" },
  { folder: "schemas", tag: "DB" },
  { folder: "db", tag: "DB" },
  { folder: "api", tag: "API" },
  { folder: "routes", tag: "API" },
  { folder: "components", tag: "UI" },
  { folder: "ui", tag: "UI" },
  { folder: "pages", tag: "UI" },
  { folder: "tests", tag: "test" },
  { folder: "__tests__", tag: "test" },
  { folder: "docs", tag: "docs" },
  { folder: "hooks", tag: "infra" },
  { folder: "middleware", tag: "infra" },
  { folder: "scripts", tag: "infra" },
  { folder: "ci", tag: "infra" },
  { folder: ".github", tag: "infra" },
  { folder: "styles", tag: "style" },
];

const EXT_TAGS = {
  tsx: "UI", jsx: "UI", vue: "UI", svelte: "UI",
  css: "style", scss: "style", less: "style",
  sql: "DB",
  md: "docs", mdx: "docs",
  json: "config", yaml: "config", yml: "config", toml: "config", env: "config",
};

function getTag(relativePath) {
  const parts = relativePath.split("/");
  for (const p of parts) {
    const lower = p.toLowerCase();
    const hit = FOLDER_TAGS.find((m) => m.folder === lower);
    if (hit) return hit.tag;
  }
  const file = parts[parts.length - 1];
  const ext = (file.split(".").pop() || "").toLowerCase();
  if (ext in EXT_TAGS) return EXT_TAGS[ext];
  return null;
}

// ── Aggregate burst → 1 chat line ──────────────────────────────────────────
function buildBurstChat(tracker, currentArea, previousArea, latestFile) {
  const files = tracker.pendingFiles || [];
  const n = files.length;
  const tags = [...new Set(files.map((f) => f.tag).filter(Boolean))];
  const tagStr = tags.length ? "[" + tags.join("/") + "] " : "";
  const lastName = path.basename(latestFile);

  // Switched area in this burst
  if (previousArea && previousArea !== currentArea) {
    if (n === 1) return `${tagStr}→ ${currentArea}/ (was in ${previousArea}/)`;
    return `${tagStr}→ ${currentArea}/ · ${n} edits (was in ${previousArea}/)`;
  }

  // Same area, single edit
  if (n === 1) return `${tagStr}${currentArea}/${lastName}`;

  // Same area, multiple edits
  return `${tagStr}${currentArea}/ · ${n} edits, last: ${lastName}`;
}

function buildSummary(tracker, currentArea, repo) {
  const totalArea = tracker.areaEditCount || 0;
  const mins = Math.max(1, Math.round((Date.now() - (tracker.areaStartedAt || tracker.lastEdit)) / 60_000));
  const repoPart = repo ? ` · ${repo.split("/").pop()}` : "";
  if (totalArea >= 15) return `Major work on ${currentArea}/ (${totalArea} files, ${mins}m)${repoPart}`;
  if (totalArea >= 5) return `Deep in ${currentArea}/ (${totalArea} files, ${mins}m)${repoPart}`;
  return `Working on ${currentArea}/${repoPart}`;
}

// ── Lines added/removed ────────────────────────────────────────────────────
function countLines(content) {
  if (!content) return 0;
  const n = (content.match(/\n/g) || []).length;
  return n + (content.endsWith("\n") || content === "" ? 0 : 1);
}

function computeLineDelta(input, filePath) {
  const toolName = input.tool_name || "";
  const ti = input.tool_input || {};

  if (toolName === "Edit") {
    const oldS = ti.old_string || "";
    const newS = ti.new_string || "";
    const removed = countLines(oldS);
    const added = countLines(newS);
    // `replace_all` would multiply both numbers by occurrence count; we don't
    // have that count here, treat as 1× — slight under-count is fine for
    // dashboard-grade visualization.
    return { linesAdded: added, linesRemoved: removed };
  }

  if (toolName === "Write") {
    const newS = ti.content || "";
    const added = countLines(newS);
    let removed = 0;
    try {
      const cachePath = path.join(os.homedir(), ".agent-town", "pre-edit-cache.json");
      if (fs.existsSync(cachePath)) {
        const cache = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
        const entry = cache[filePath];
        if (entry && typeof entry.lines === "number") {
          removed = entry.lines;
          delete cache[filePath];
          try { fs.writeFileSync(cachePath, JSON.stringify(cache)); } catch {}
        }
      }
    } catch { /* ignore */ }
    return { linesAdded: added, linesRemoved: removed };
  }

  return { linesAdded: undefined, linesRemoved: undefined };
}

// ── Main ───────────────────────────────────────────────────────────────────
try {
  const input = JSON.parse(fs.readFileSync("/dev/stdin", "utf-8"));
  const filePath = input.tool_input?.file_path || input.tool_input?.path || "";
  if (!filePath) process.exit(0);

  const configPath = path.join(os.homedir(), ".agent-town", "config.json");
  if (!fs.existsSync(configPath)) process.exit(0);
  const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

  // Resolve git context → relative path + repo
  const gitInfo = getGitInfo(filePath);
  let relativePath, repo;
  if (gitInfo) {
    relativePath = gitInfo.relativePath;
    repo = gitInfo.repo;
    // Repo allowlist (from team config)
    if (config.repos && config.repos.length > 0) {
      const repoName = repo.includes("/") ? repo.split("/").pop() : repo;
      const allowed = config.repos.some((r) => r === repo || r.endsWith("/" + repoName) || r === repoName);
      if (!allowed) process.exit(0);
    }
  } else {
    relativePath = path.relative(input.cwd || process.cwd(), filePath).replace(/\\/g, "/");
    repo = undefined;
  }

  const hookCwd = input.cwd || process.cwd();
  const { userName, agentId } = getSessionIdentity(config, hookCwd);
  const relayHttp = config.relayUrl.replace("wss://", "https://").replace("ws://", "http://");
  const now = Date.now();

  // ── Update tracker (always) ──────────────────────────────────────────────
  const tracker = getEditTracker();
  const area = getArea(relativePath);
  const tag = getTag(relativePath);
  const previousArea = tracker ? tracker.currentArea : null;
  const sameArea = tracker && tracker.currentArea === area;

  const nextTracker = {
    currentArea: area,
    areaEditCount: sameArea ? (tracker.areaEditCount || 0) + 1 : 1,
    areaStartedAt: sameArea ? (tracker.areaStartedAt || tracker.lastEdit || now) : now,
    totalEdits: (tracker?.totalEdits || 0) + 1,
    lastEdit: now,
    lastChatAt: tracker?.lastChatAt || 0,
    lastSummaryAt: tracker?.lastSummaryAt || 0,
    pendingFiles: tracker?.pendingFiles || [],
  };

  // Append to pending burst
  nextTracker.pendingFiles.push({
    file: relativePath,
    area,
    tag: tag || "",
  });
  // Keep burst window manageable (cap 50 to avoid runaway)
  if (nextTracker.pendingFiles.length > 50) {
    nextTracker.pendingFiles = nextTracker.pendingFiles.slice(-50);
  }

  // ── Decide whether to emit a chat NOW ────────────────────────────────────
  const areaChanged = previousArea && previousArea !== area;
  const burstLargeEnough = nextTracker.pendingFiles.length >= 3;
  const intervalElapsed = now - nextTracker.lastChatAt > COALESCE_MS;
  const isFirstEverEdit = !tracker;

  let chatLine = null;
  if (isFirstEverEdit || areaChanged || (intervalElapsed && nextTracker.pendingFiles.length > 0) || burstLargeEnough) {
    chatLine = buildBurstChat(nextTracker, area, areaChanged ? previousArea : null, relativePath);
    nextTracker.lastChatAt = now;
    nextTracker.pendingFiles = [];
  }

  // ── Decide whether to refresh work summary ───────────────────────────────
  let summary = null;
  const summaryDue = now - (nextTracker.lastSummaryAt || 0) > SUMMARY_INTERVAL_MS;
  if (isFirstEverEdit || areaChanged || summaryDue) {
    summary = buildSummary(nextTracker, area, repo);
    nextTracker.lastSummaryAt = now;
  }

  saveEditTracker(nextTracker);

  // ── Compute lines added/removed ────────────────────────────────────────
  // For Edit we get the delta directly from tool_input. For Write we look it
  // up from the pre-edit-check snapshot. Either side may be undefined; the
  // dashboard renders gracefully when one is missing.
  const { linesAdded, linesRemoved } = computeLineDelta(input, filePath);

  // ── Send file change (always) ────────────────────────────────────────────
  const body = {
    teamKey: config.teamKey,
    agentId,
    userName,
    path: relativePath,
    repo,
    action: "edit",
  };
  if (chatLine) body.chat = chatLine;
  if (typeof linesAdded === "number") body.linesAdded = linesAdded;
  if (typeof linesRemoved === "number") body.linesRemoved = linesRemoved;

  fetch(relayHttp + "/file-change", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});

  // ── Update work summary in a separate, non-blocking POST ────────────────
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

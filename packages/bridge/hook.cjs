#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const os = require("os");

// --- Session identity ---
// Each Claude Code session gets a unique number (tmsn-1, tmsn-2, etc.)
// Stored in ~/.agent-town/sessions/ keyed by session_id
function getSessionIdentity(config, sessionId) {
  if (!sessionId) return { userName: config.userName, agentId: config.agentId };

  const sessDir = path.join(os.homedir(), ".agent-town", "sessions");
  try { fs.mkdirSync(sessDir, { recursive: true }); } catch {}

  const sessFile = path.join(sessDir, sessionId + ".json");

  // Check if this session already has an identity
  if (fs.existsSync(sessFile)) {
    try {
      const sess = JSON.parse(fs.readFileSync(sessFile, "utf-8"));
      return { userName: sess.userName, agentId: sess.agentId };
    } catch {}
  }

  // Assign a new number — find the highest existing number for this user
  let maxNum = 0;
  try {
    const files = fs.readdirSync(sessDir);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(sessDir, f), "utf-8"));
        if (s.baseUser === config.userName && typeof s.num === "number") {
          maxNum = Math.max(maxNum, s.num);
        }
      } catch {}
    }
  } catch {}

  const num = maxNum + 1;
  const userName = config.userName + "-" + num;
  const agentId = "agent-sess-" + sessionId.slice(0, 12);
  const sessData = { userName, agentId, baseUser: config.userName, num, createdAt: Date.now() };

  try { fs.writeFileSync(sessFile, JSON.stringify(sessData)); } catch {}

  return { userName, agentId };
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

  if (file.includes("route") || file.includes("api")) {
    messages.push(`API work on ${file}`, `adjusting ${dir}/ API`);
  }
  if (file.includes("test")) {
    messages.push(`writing tests`, `testing ${dir}/`);
  }
  if (file.includes("config") || file.includes("setting")) {
    messages.push(`updating config`);
  }
  if (ext === ".css" || ext === ".scss" || ext === ".tsx") {
    messages.push(`styling ${dir}/`);
  }
  if (file.includes("schema") || file.includes("migration")) {
    messages.push(`touching the schema — careful!`);
  }
  if (dir === "components" || dir === "ui") {
    messages.push(`building UI in ${dir}/`);
  }

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
  const { userName, agentId } = getSessionIdentity(config, input.session_id);

  // Cleanup old sessions (>24h) — non-blocking
  try {
    const sessDir = path.join(os.homedir(), ".agent-town", "sessions");
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const f of fs.readdirSync(sessDir)) {
      const fp = path.join(sessDir, f);
      try { if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp); } catch {}
    }
  } catch {}

  const relayHttp = config.relayUrl.replace("wss://", "https://").replace("ws://", "http://");
  const relativePath = path.relative(input.cwd || process.cwd(), filePath);
  const chat = generateChat(filePath);

  fetch(relayHttp + "/file-change", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      teamKey: config.teamKey,
      agentId,
      userName,
      path: relativePath,
      action: "edit",
      chat,
    }),
  }).catch(() => {});

  setTimeout(() => process.exit(0), 500);
} catch {
  process.exit(0);
}

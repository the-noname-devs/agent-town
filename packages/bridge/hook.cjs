#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const os = require("os");

// Fun auto-messages based on what's being edited
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

try {
  const input = JSON.parse(fs.readFileSync("/dev/stdin", "utf-8"));
  const filePath = input.tool_input?.file_path || input.tool_input?.path || "";
  if (!filePath) process.exit(0);

  const configPath = path.join(os.homedir(), ".agent-town", "config.json");
  if (!fs.existsSync(configPath)) process.exit(0);

  const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  const relayHttp = config.relayUrl.replace("wss://", "https://").replace("ws://", "http://");
  const relativePath = path.relative(input.cwd || process.cwd(), filePath);
  const chat = generateChat(filePath);

  fetch(relayHttp + "/file-change", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      teamKey: config.teamKey,
      agentId: config.agentId,
      userName: config.userName,
      path: relativePath,
      action: "edit",
      chat: chat,
    }),
  }).catch(() => {});

  setTimeout(() => process.exit(0), 500);
} catch {
  process.exit(0);
}

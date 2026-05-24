#!/usr/bin/env node
/**
 * UserPromptSubmit Hook — injects team status as context before Claude processes a message.
 * Claude automatically knows who's working on what without needing to ask.
 * Fails silently on any error (no context injected, no block).
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

try {
  // Read stdin (hook input)
  const input = JSON.parse(fs.readFileSync("/dev/stdin", "utf-8"));

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
  let agentId = config.agentId || "";
  try {
    const activeDir = path.join(os.homedir(), ".agent-town", "active");
    if (fs.existsSync(activeDir)) {
      let best = null;
      for (const f of fs.readdirSync(activeDir)) {
        if (!f.endsWith(".json")) continue;
        try {
          const s = JSON.parse(fs.readFileSync(path.join(activeDir, f), "utf-8"));
          if (!best || s.startedAt > best.startedAt) best = s;
        } catch {}
      }
      if (best) agentId = best.agentId;
    }
  } catch {}

  const relayHttp = config.relayUrl
    .replace("wss://", "https://")
    .replace("ws://", "http://");

  const url = `${relayHttp}/team-context?teamKey=${encodeURIComponent(config.teamKey)}&agentId=${encodeURIComponent(agentId)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  fetch(url, { signal: controller.signal })
    .then((res) => res.json())
    .then((data) => {
      clearTimeout(timeout);

      const parts = [];

      // Teammates
      if (data.agents && data.agents.length > 0) {
        for (const agent of data.agents) {
          let line = `${agent.name} (${agent.status})`;
          if (agent.branch) line += ` on ${agent.branch}`;
          if (agent.activeFiles?.length > 0) {
            const files = agent.activeFiles.map((f) => f.split(/[\\/]/).slice(-2).join("/"));
            line += `, editing: ${files.join(", ")}`;
          }
          if (agent.workSummary) line += ` — "${agent.workSummary}"`;
          parts.push(line);
        }
      }

      // Protected zones
      if (data.zones && data.zones.length > 0) {
        for (const zone of data.zones) {
          parts.push(`⚠️ Protected zone: ${zone.pattern} by ${zone.owner}${zone.reason ? ` (${zone.reason})` : ""}`);
        }
      }

      // Recent activity
      if (data.recentActivity && data.recentActivity !== "no recent activity") {
        parts.push(`Recent: ${data.recentActivity}`);
      }

      if (parts.length === 0) {
        // No teammates online — no context needed
        console.log(JSON.stringify({}));
        return;
      }

      const teamInfo = `[Agent Town] Teammates: ${parts.join(" | ")}`;
      const instruction = `\n[Agent Town Instructions] You are part of a team. Before starting work, call set_work_summary with a short sentence describing what you're about to do (e.g. "Refactoring auth flow to use JWT tokens"). Update it when your focus changes. Also use send_message to communicate important decisions or blockers to teammates. Check teammate summaries above to avoid conflicts.`;

      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: teamInfo + instruction,
        },
      }));
    })
    .catch(() => {
      clearTimeout(timeout);
      console.log(JSON.stringify({}));
    });
} catch {
  console.log(JSON.stringify({}));
}

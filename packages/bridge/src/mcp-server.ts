import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { RelayClient } from "./relay-client.js";
import { FileWatcher, type FileEvent } from "./file-watcher.js";
import { generateAgentId } from "@agent-town/shared";
import type { BridgeConfig, TeamState, ServerConflictMessage, ServerChatMessage } from "@agent-town/shared";

function loadConfig(): BridgeConfig {
  const configPath = join(homedir(), ".agent-town", "config.json");
  if (!existsSync(configPath)) {
    throw new Error(
      `Config not found at ${configPath}. Run 'npx @agent-town/cli login' (or 'init' for self-hosted).`
    );
  }
  return JSON.parse(readFileSync(configPath, "utf-8"));
}

function getCurrentBranch(): string | undefined {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return undefined;
  }
}

export class BridgeMcpServer {
  private mcp: McpServer;
  private relay: RelayClient | null = null;
  private watcher: FileWatcher | null = null;
  private pendingConflicts: ServerConflictMessage[] = [];
  private pendingChats: ServerChatMessage[] = [];
  private branchPollTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.mcp = new McpServer({
      name: "agent-town",
      version: "0.2.0",
    });

    this.registerTools();
  }

  async start(): Promise<void> {
    // Try to connect to relay if config exists
    try {
      const config = loadConfig();
      // Generate a unique agentId per MCP session so multiple Claude Code
      // windows don't kick each other off the relay
      const sessionConfig = { ...config, agentId: generateAgentId() };
      this.relay = new RelayClient(sessionConfig);
      this.relay.on("conflict", (msg: ServerConflictMessage) => {
        this.pendingConflicts.push(msg);
      });
      this.relay.on("chat", (msg: ServerChatMessage) => {
        this.pendingChats.push(msg);
      });

      // Detect git branch before connecting
      const branch = getCurrentBranch();
      this.relay.setBranch(branch);
      this.relay.connect();

      // Poll branch every 10s — send immediate heartbeat on change
      let lastBranch = branch;
      this.branchPollTimer = setInterval(() => {
        const newBranch = getCurrentBranch();
        if (this.relay && newBranch !== lastBranch) {
          lastBranch = newBranch;
          this.relay.setBranch(newBranch);
          // Send heartbeat immediately so the relay sees the change
          this.relay.sendHeartbeat();
        }
      }, 10_000);

      // Kein FileWatcher — verbraucht zu viel RAM/CPU auf großen Monorepos
      // und blockiert Heartbeats. File-Tracking läuft über die MCP Tools
      // (claim_file wird automatisch bei Edit/Write via PostToolUse Hook aufgerufen).
    } catch {
      // Config not found — tools will report "not connected"
    }

    const transport = new StdioServerTransport();
    await this.mcp.connect(transport);
  }

  private registerTools(): void {
    this.mcp.tool(
      "get_team_status",
      "See who's online, what branch they're on, and what files they're editing",
      {},
      async () => {
        if (!this.relay?.isConnected()) {
          return {
            content: [{ type: "text", text: "Not connected to relay. Run 'npx @agent-town/cli login' to configure (or 'init' for self-hosted)." }],
          };
        }

        const state: TeamState = this.relay.getState();

        if (state.agents.length === 0) {
          return {
            content: [{ type: "text", text: "No team members currently online." }],
          };
        }

        const lines: string[] = ["## Team Status\n"];

        for (const agent of state.agents) {
          const statusIcon = agent.status === "online" ? "🟢" : agent.status === "idle" ? "🟡" : "⚫";
          const branchInfo = agent.branch ? ` on \`${agent.branch}\`` : "";
          lines.push(`${statusIcon} **${agent.userName}** (${agent.status})${branchInfo}`);
          if (agent.activeFiles.length > 0) {
            lines.push(`  Editing: ${agent.activeFiles.join(", ")}`);
          }
        }

        if (state.locks.length > 0) {
          lines.push("\n## Active File Locks\n");
          for (const lock of state.locks) {
            lines.push(`- \`${lock.path}\` — ${lock.userName}`);
          }
        }

        if (state.zones.length > 0) {
          lines.push("\n## Protected Zones\n");
          for (const zone of state.zones) {
            const reason = zone.reason ? ` (${zone.reason})` : "";
            lines.push(`- \`${zone.pattern}\` — ${zone.userName}${reason}`);
          }
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      }
    );

    this.mcp.tool(
      "check_file",
      "Check if a file is safe to edit — warns about conflicts, active locks, and protected zones BEFORE you make changes",
      { path: z.string().describe("Relative file path to check") },
      async ({ path }) => {
        if (!this.relay?.isConnected()) {
          return {
            content: [{ type: "text", text: "Not connected to relay." }],
          };
        }

        const state: TeamState = this.relay.getState();
        const warnings: string[] = [];

        // Check if another agent has this file locked
        const lock = state.locks.find((l) => l.path === path);
        if (lock && lock.agentId !== this.relay["config"].agentId) {
          warnings.push(`⚠️ **${lock.userName}** is currently editing this file`);
        }

        // Check protected zones
        for (const zone of state.zones) {
          if (zone.agentId !== this.relay["config"].agentId) {
            if (this.pathMatchesPattern(path, zone.pattern)) {
              const reason = zone.reason ? `: ${zone.reason}` : "";
              warnings.push(`🚫 File is inside protected zone \`${zone.pattern}\` claimed by **${zone.userName}**${reason}`);
            }
          }
        }

        // Check if another agent on the same branch is editing nearby files
        const myAgentId = this.relay["config"].agentId;
        const me = state.agents.find((a) => a.agentId === myAgentId);
        const dir = path.includes("/") ? path.substring(0, path.lastIndexOf("/")) : "";

        for (const agent of state.agents) {
          if (agent.agentId === myAgentId) continue;
          if (me?.branch && agent.branch && me.branch === agent.branch) {
            const nearbyFiles = agent.activeFiles.filter((f) => {
              const fDir = f.includes("/") ? f.substring(0, f.lastIndexOf("/")) : "";
              return fDir === dir;
            });
            if (nearbyFiles.length > 0) {
              warnings.push(
                `⚠️ **${agent.userName}** is editing files in the same directory on branch \`${agent.branch}\`: ${nearbyFiles.join(", ")}`
              );
            }
          }
        }

        if (warnings.length === 0) {
          return {
            content: [{ type: "text", text: `✅ \`${path}\` is clear — no conflicts or locks.` }],
          };
        }

        return {
          content: [{ type: "text", text: `## Pre-edit Check: \`${path}\`\n\n${warnings.join("\n")}` }],
        };
      }
    );

    this.mcp.tool(
      "claim_file",
      "Mark a file as being actively edited by you, so other team members know not to edit it",
      { path: z.string().describe("Relative file path to claim") },
      async ({ path }) => {
        if (!this.relay?.isConnected()) {
          return {
            content: [{ type: "text", text: "Not connected to relay." }],
          };
        }

        this.relay.claimFile(path);
        return {
          content: [{ type: "text", text: `Claimed file: ${path}` }],
        };
      }
    );

    this.mcp.tool(
      "release_file",
      "Release a file lock so other team members can edit it",
      { path: z.string().describe("Relative file path to release") },
      async ({ path }) => {
        if (!this.relay?.isConnected()) {
          return {
            content: [{ type: "text", text: "Not connected to relay." }],
          };
        }

        this.relay.releaseFile(path);
        return {
          content: [{ type: "text", text: `Released file: ${path}` }],
        };
      }
    );

    this.mcp.tool(
      "claim_zone",
      "Protect an entire directory or file pattern so teammates are warned before editing anything inside it",
      {
        pattern: z.string().describe("Directory or glob pattern to protect (e.g. 'src/api/' or 'src/auth/**')"),
        reason: z.string().optional().describe("Why you're protecting this zone (e.g. 'refactoring auth module')"),
      },
      async ({ pattern, reason }) => {
        if (!this.relay?.isConnected()) {
          return {
            content: [{ type: "text", text: "Not connected to relay." }],
          };
        }

        this.relay.claimZone(pattern, reason);
        const reasonText = reason ? ` (${reason})` : "";
        return {
          content: [{ type: "text", text: `Protected zone: \`${pattern}\`${reasonText}` }],
        };
      }
    );

    this.mcp.tool(
      "release_zone",
      "Remove protection from a directory or pattern so teammates can freely edit it again",
      { pattern: z.string().describe("The exact pattern used when claiming the zone") },
      async ({ pattern }) => {
        if (!this.relay?.isConnected()) {
          return {
            content: [{ type: "text", text: "Not connected to relay." }],
          };
        }

        this.relay.releaseZone(pattern);
        return {
          content: [{ type: "text", text: `Released zone: \`${pattern}\`` }],
        };
      }
    );

    this.mcp.tool(
      "send_message",
      "Send a message to other team members' Claude Code instances",
      { message: z.string().describe("Message to send to the team") },
      async ({ message }) => {
        if (!this.relay?.isConnected()) {
          return {
            content: [{ type: "text", text: "Not connected to relay." }],
          };
        }

        this.relay.sendChat(message);
        return {
          content: [{ type: "text", text: `Message sent to team: "${message}"` }],
        };
      }
    );

    this.mcp.tool(
      "get_activity",
      "See recent file changes across the team — who changed what and when",
      {
        limit: z.number().optional().describe("Max entries to return (default: 20)"),
      },
      async ({ limit }) => {
        if (!this.relay?.isConnected()) {
          return {
            content: [{ type: "text", text: "Not connected to relay." }],
          };
        }

        const state: TeamState = this.relay.getState();
        const activities = state.activities ?? [];
        const maxEntries = limit ?? 20;
        const recent = activities.slice(-maxEntries).reverse();

        if (recent.length === 0) {
          return {
            content: [{ type: "text", text: "No recent activity." }],
          };
        }

        const lines: string[] = ["## Recent Activity\n"];
        for (const entry of recent) {
          const time = new Date(entry.timestamp).toLocaleTimeString();
          const icon = entry.action === "edit" ? "✏️" : entry.action === "write" ? "📝" : entry.action === "delete" ? "🗑️" : entry.action === "claim" ? "🔒" : "🔓";
          lines.push(`- ${icon} **${entry.userName}** ${entry.action} \`${entry.path}\` (${time})`);
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      }
    );

    this.mcp.tool(
      "get_conflicts",
      "Check if there are any file editing conflicts with other team members",
      {},
      async () => {
        if (this.pendingConflicts.length === 0) {
          return {
            content: [{ type: "text", text: "No conflicts detected." }],
          };
        }

        const lines = ["## File Conflicts\n"];
        for (const c of this.pendingConflicts) {
          const zoneInfo = c.zone ? ` (zone: \`${c.zone}\`)` : "";
          lines.push(
            `- \`${c.path}\`: ${c.claimedBy.userName} and ${c.requestedBy.userName} both editing${zoneInfo}`
          );
        }

        const result = lines.join("\n");
        this.pendingConflicts = [];
        return {
          content: [{ type: "text", text: result }],
        };
      }
    );

    this.mcp.tool(
      "get_messages",
      "Check for messages from other team members",
      {},
      async () => {
        if (this.pendingChats.length === 0) {
          return {
            content: [{ type: "text", text: "No new messages." }],
          };
        }

        const lines = ["## Team Messages\n"];
        for (const c of this.pendingChats) {
          const time = new Date(c.timestamp).toLocaleTimeString();
          lines.push(`- **${c.from.userName}** (${time}): ${c.message}`);
        }

        const result = lines.join("\n");
        this.pendingChats = [];
        return {
          content: [{ type: "text", text: result }],
        };
      }
    );
  }

  private pathMatchesPattern(path: string, pattern: string): boolean {
    if (pattern.endsWith("/**")) {
      const prefix = pattern.slice(0, -3);
      return path.startsWith(prefix + "/") || path === prefix;
    }
    if (pattern.endsWith("/")) {
      return path.startsWith(pattern);
    }
    return path === pattern || path.startsWith(pattern + "/");
  }
}

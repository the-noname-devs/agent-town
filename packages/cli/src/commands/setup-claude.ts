import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export async function setupClaude(): Promise<void> {
  const configPath = join(homedir(), ".agent-town", "config.json");

  if (!existsSync(configPath)) {
    console.error("Not configured. Run 'agent-town init' first.");
    process.exit(1);
  }

  console.log("Setting up Claude Code integration...\n");

  // 1. Setup MCP server in ~/.claude.json
  const claudeConfigPath = join(homedir(), ".claude.json");
  let claudeConfig: Record<string, unknown> = {};

  if (existsSync(claudeConfigPath)) {
    claudeConfig = JSON.parse(readFileSync(claudeConfigPath, "utf-8"));
  }

  const mcpServers = (claudeConfig.mcpServers as Record<string, unknown>) ?? {};
  mcpServers["agent-town"] = {
    command: "npx",
    args: ["@agent-town/bridge"],
    env: {},
  };
  claudeConfig.mcpServers = mcpServers;

  writeFileSync(claudeConfigPath, JSON.stringify(claudeConfig, null, 2) + "\n");
  console.log(`MCP server added to ${claudeConfigPath}`);

  // 2. Setup hooks in ~/.claude/settings.json
  const settingsPath = join(homedir(), ".claude", "settings.json");
  let settings: Record<string, unknown> = {};

  if (existsSync(settingsPath)) {
    settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
  } else {
    mkdirSync(dirname(settingsPath), { recursive: true });
  }

  const hooks = (settings.hooks as Record<string, unknown[]>) ?? {};

  // Remove old hooks, add new MCP-based hook
  hooks.PostToolUse = [
    ...(hooks.PostToolUse ?? []).filter(
      (h: unknown) => {
        const hook = h as Record<string, unknown>;
        return !hook.__agentBridge && !hook.__agentTown;
      }
    ),
    {
      __agentTown: true,
      matcher: "Edit|Write",
      hooks: [
        {
          type: "mcp_tool",
          server: "agent-town",
          tool: "claim_file",
          input: { path: "${tool_input.file_path}" },
        },
      ],
    },
  ];

  settings.hooks = hooks;

  // Add agent-town to allowed tools
  const allowedTools = (settings.allowedTools as string[]) ?? [];
  const bridgeTools = [
    "mcp__agent-town__get_team_status",
    "mcp__agent-town__check_file",
    "mcp__agent-town__claim_file",
    "mcp__agent-town__release_file",
    "mcp__agent-town__claim_zone",
    "mcp__agent-town__release_zone",
    "mcp__agent-town__send_message",
    "mcp__agent-town__get_activity",
    "mcp__agent-town__get_conflicts",
    "mcp__agent-town__get_messages",
  ];
  for (const tool of bridgeTools) {
    if (!allowedTools.includes(tool)) {
      allowedTools.push(tool);
    }
  }
  settings.allowedTools = allowedTools;

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  console.log(`Allowed tools added to ${settingsPath}`);

  console.log(`\nSetup complete! Claude Code will now:`);
  console.log(`   - Auto-connect to the relay when starting`);
  console.log(`   - Have tools to check team status and manage file locks`);
  console.log(`\nRestart Claude Code to activate.`);
}

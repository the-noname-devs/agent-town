import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export async function setupClaude(): Promise<void> {
  const configPath = join(homedir(), ".agent-town", "config.json");

  if (!existsSync(configPath)) {
    console.error("Not configured. Run 'agent-town login' or 'agent-town init' first.");
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

  // Helper: filter out old agent-town hooks
  const filterOld = (arr: unknown[]) => (arr ?? []).filter((h: unknown) => {
    const hook = h as Record<string, unknown>;
    return !hook.__agentBridge && !hook.__agentTown;
  });

  // Resolve hook script paths (use installed package or local dev)
  const bridgePkg = join(dirname(require.resolve("@agent-town/bridge/package.json")), "..");
  let hookDir: string;
  try {
    hookDir = dirname(require.resolve("@agent-town/bridge/package.json"));
  } catch {
    // Fallback for local development
    hookDir = join(homedir(), ".agent-town");
  }

  // PreToolUse — block edits on locked files / protected zones
  hooks.PreToolUse = [
    ...filterOld(hooks.PreToolUse as unknown[]),
    {
      __agentTown: true,
      matcher: "Edit|Write",
      hooks: [
        {
          type: "command",
          command: `node ${join(hookDir, "pre-edit-check.cjs")}`,
          timeout: 5000,
        },
      ],
    },
  ];

  // PostToolUse — claim files after edit (existing behavior)
  hooks.PostToolUse = [
    ...filterOld(hooks.PostToolUse as unknown[]),
    {
      __agentTown: true,
      matcher: "Edit|Write",
      hooks: [
        {
          type: "command",
          command: `node ${join(hookDir, "hook.cjs")}`,
        },
      ],
    },
  ];

  // UserPromptSubmit — inject team context before Claude processes a message
  hooks.UserPromptSubmit = [
    ...filterOld(hooks.UserPromptSubmit as unknown[]),
    {
      __agentTown: true,
      hooks: [
        {
          type: "command",
          command: `node ${join(hookDir, "team-context-hook.cjs")}`,
          timeout: 5000,
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
    "mcp__agent-town__set_work_summary",
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
  console.log(`   - Auto-check for conflicts before editing files (PreToolUse)`);
  console.log(`   - Auto-inject team status into every conversation (UserPromptSubmit)`);
  console.log(`   - Auto-claim files after editing (PostToolUse)`);
  console.log(`   - Have 11 tools for team coordination`);
  console.log(`\nRestart Claude Code to activate.`);
}

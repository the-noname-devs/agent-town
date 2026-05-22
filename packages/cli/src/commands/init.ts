import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { generateAgentId, generateTeamKey, type BridgeConfig } from "@agent-town/shared";

function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

export async function init(): Promise<void> {
  const configDir = join(homedir(), ".agent-town");
  const configPath = join(configDir, "config.json");

  console.log("🔧 Agent Town Setup\n");

  // Load existing config if present
  let existing: Partial<BridgeConfig> = {};
  if (existsSync(configPath)) {
    existing = JSON.parse(readFileSync(configPath, "utf-8"));
    console.log("Existing config found. Press Enter to keep current values.\n");
  }

  const relayUrl = await prompt(
    "Relay server URL",
    existing.relayUrl || "ws://localhost:8787"
  );

  const teamKey = await prompt(
    "Team key (share with teammates)",
    existing.teamKey || generateTeamKey()
  );

  const userName = await prompt(
    "Your name",
    existing.userName || process.env.USER || "developer"
  );

  const agentId = existing.agentId || generateAgentId();
  const machineId = existing.machineId || `${homedir().split("/").pop()}-${Date.now().toString(36)}`;

  const config: BridgeConfig = {
    relayUrl,
    teamKey,
    userName,
    agentId,
    machineId,
  };

  mkdirSync(configDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  console.log(`\n✅ Config saved to ${configPath}`);
  console.log(`\n📋 Share this team key with your teammate:`);
  console.log(`   ${teamKey}\n`);
  console.log(`Next steps:`);
  console.log(`  1. Start the relay:  cd packages/relay && pnpm start`);
  console.log(`  2. Setup Claude:     agent-town setup-claude`);
}

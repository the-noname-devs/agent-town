import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import type { BridgeConfig } from "@agent-town/shared";

const DASHBOARD_URL = process.env.AGENT_TOWN_URL || "https://agent-town.dev";

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function login(): Promise<void> {
  const code = randomBytes(16).toString("hex");
  const authUrl = `${DASHBOARD_URL}/cli-auth?code=${code}`;

  console.log("\n🔗 Opening browser for authentication...\n");
  console.log(`   If it doesn't open, visit: ${authUrl}\n`);

  // Try to open browser
  const { exec } = await import("node:child_process");
  const platform = process.platform;
  const openCmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
  exec(`${openCmd} "${authUrl}"`);

  console.log("⏳ Waiting for authentication...");

  // Poll for completion
  const pollUrl = `${DASHBOARD_URL}/api/cli-auth/poll?code=${code}`;
  let attempts = 0;
  const maxAttempts = 120; // 2 minutes

  while (attempts < maxAttempts) {
    await new Promise((r) => setTimeout(r, 1000));
    attempts++;

    try {
      const res = await fetch(pollUrl);
      if (!res.ok) continue;

      const data = await res.json() as {
        completed?: boolean;
        teams?: Array<{ id: string; name: string; team_key: string; relay_url: string }>;
      };

      if (!data.completed || !data.teams) continue;

      console.log("\n✅ Authenticated!\n");

      if (data.teams.length === 0) {
        console.log("No teams found. Create one at " + DASHBOARD_URL);
        return;
      }

      // Let user pick a team
      let selectedTeam = data.teams[0];
      if (data.teams.length > 1) {
        console.log("Select a team:\n");
        data.teams.forEach((t, i) => {
          console.log(`  ${i + 1}. ${t.name}`);
        });
        const choice = await prompt(`\nTeam number [1]: `);
        const idx = parseInt(choice || "1") - 1;
        if (idx >= 0 && idx < data.teams.length) {
          selectedTeam = data.teams[idx];
        }
      } else {
        console.log(`Team: ${selectedTeam.name}`);
      }

      // Write config
      const configDir = join(homedir(), ".agent-town");
      const configPath = join(configDir, "config.json");

      let existing: Partial<BridgeConfig> = {};
      if (existsSync(configPath)) {
        existing = JSON.parse(readFileSync(configPath, "utf-8"));
      }

      const config: BridgeConfig = {
        relayUrl: selectedTeam.relay_url,
        teamKey: selectedTeam.team_key,
        userName: existing.userName || process.env.USER || "developer",
        agentId: existing.agentId || `agent-${randomBytes(6).toString("hex")}`,
        machineId: existing.machineId || `${homedir().split("/").pop()}-${Date.now().toString(36)}`,
      };

      mkdirSync(configDir, { recursive: true });
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

      console.log(`\n✅ Config saved to ${configPath}`);
      console.log(`\nNext step:`);
      console.log(`  agent-town setup-claude\n`);
      return;
    } catch {
      // Retry
    }
  }

  console.error("\n❌ Authentication timed out. Please try again.");
  process.exit(1);
}

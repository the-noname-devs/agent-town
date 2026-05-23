import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { BridgeConfig, TeamState } from "@agent-town/shared";

export async function status(): Promise<void> {
  const configPath = join(homedir(), ".agent-town", "config.json");

  if (!existsSync(configPath)) {
    console.error("Not configured. Run 'agent-town login' or 'agent-town init' first.");
    process.exit(1);
  }

  const config: BridgeConfig = JSON.parse(readFileSync(configPath, "utf-8"));
  const httpUrl = config.relayUrl.replace(/^ws/, "http");

  try {
    const response = await fetch(`${httpUrl}/status`);
    const data = (await response.json()) as Record<string, TeamState>;

    const teamState = Object.values(data).find(
      (state) => state.agents.length > 0
    );

    if (!teamState || teamState.agents.length === 0) {
      console.log("No agents currently online.");
      return;
    }

    console.log("Agent Town Status\n");

    for (const agent of teamState.agents) {
      const icon = agent.status === "online" ? "🟢" : agent.status === "idle" ? "🟡" : "⚫";
      const branchInfo = agent.branch ? ` [${agent.branch}]` : "";
      console.log(`${icon} ${agent.userName} (${agent.status})${branchInfo}`);
      if (agent.activeFiles.length > 0) {
        for (const file of agent.activeFiles) {
          console.log(`   📝 ${file}`);
        }
      }
    }

    if (teamState.locks.length > 0) {
      console.log("\nActive locks:");
      for (const lock of teamState.locks) {
        console.log(`  🔒 ${lock.path} — ${lock.userName}`);
      }
    }

    if (teamState.zones && teamState.zones.length > 0) {
      console.log("\nProtected zones:");
      for (const zone of teamState.zones) {
        const reason = zone.reason ? ` (${zone.reason})` : "";
        console.log(`  🛡️  ${zone.pattern} — ${zone.userName}${reason}`);
      }
    }

    if (teamState.activities && teamState.activities.length > 0) {
      const recent = teamState.activities.slice(-5).reverse();
      console.log("\nRecent activity:");
      for (const entry of recent) {
        const time = new Date(entry.timestamp).toLocaleTimeString();
        console.log(`  ${entry.userName} ${entry.action} ${entry.path} (${time})`);
      }
    }
  } catch (err) {
    console.error(`Cannot reach relay at ${httpUrl}`);
    console.error("Is the relay server running?");
    process.exit(1);
  }
}

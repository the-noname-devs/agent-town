#!/usr/bin/env node
import { generateAgentId, type BridgeConfig } from "@agent-town/shared";
import { RelayClient } from "./relay-client.js";

const RELAY_URL = process.env.RELAY_URL ?? "ws://localhost:8787";
const TEAM_KEY = process.env.TEAM_KEY ?? "team-demo";
const BOT_COUNT = Math.max(2, Number(process.env.BOT_COUNT ?? "2"));

const NAMES = ["Daniel", "Tim", "Mira", "Jonas"];

const FILE_POOL = [
  "monorepo/apps/crm/src/app/page.tsx",
  "monorepo/apps/crm/src/lib/supabase.ts",
  "monorepo/packages/db/schema.ts",
  "monorepo/apps/web/src/index.ts",
  "agent-town/packages/relay/src/server.ts",
  "agent-town/packages/bridge/src/file-watcher.ts",
  "crawlguard/src/lib/email.ts",
  "ki-kmu-website/src/pages/index.tsx",
];
const HOT_FILE = "monorepo/packages/db/schema.ts";

const CHATTER = [
  "refactoring auth, don't merge yet",
  "anyone touching the db schema?",
  "pushing a fix in 5",
  " wer ist an den routes dran?",
  "found a bug in the session handler",
  "lgtm, merging",
  "rebasing onto main now",
  "careful, migrations are running",
];

interface Bot {
  client: RelayClient;
  name: string;
  held: Set<string>;
}

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)] as T;
}
function jitter(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

const bots: Bot[] = [];

function makeBot(name: string): Bot {
  const config: BridgeConfig = {
    relayUrl: RELAY_URL,
    teamKey: TEAM_KEY,
    userName: name,
    agentId: generateAgentId(),
    machineId: "sim-" + name.toLowerCase(),
    heartbeatInterval: 15_000,
  };
  const client = new RelayClient(config);
  const bot: Bot = { client, name, held: new Set() };

  client.on("connected", () => console.log(`🟢 ${name} connected`));
  client.on("conflict", (m: { path: string }) =>
    console.log(`⚠  ${name} hit a conflict on ${m.path}`)
  );

  client.connect();
  return bot;
}

function tick(bot: Bot): void {
  if (!bot.client.isConnected()) return;
  const roll = Math.random();

  if (roll < 0.4) {
    // claim + edit a file
    const file = pick(FILE_POOL);
    bot.client.claimFile(file);
    bot.held.add(file);
    setTimeout(() => bot.client.reportFileChange(file, "edit"), 300);
    console.log(`📝 ${bot.name} editing ${file}`);
  } else if (roll < 0.6 && bot.held.size > 0) {
    // release a held file
    const file = pick([...bot.held]);
    bot.client.releaseFile(file);
    bot.held.delete(file);
    console.log(`🔓 ${bot.name} released ${file}`);
  } else if (roll < 0.85) {
    // chat
    bot.client.sendChat(pick(CHATTER));
  } else {
    // report an edit on the hot file to provoke conflicts
    bot.client.claimFile(HOT_FILE);
    bot.held.add(HOT_FILE);
    bot.client.reportFileChange(HOT_FILE, "edit");
  }
}

function start(): void {
  console.log(`Agent Town simulator → ${RELAY_URL} (team: ${TEAM_KEY}, bots: ${BOT_COUNT})`);
  for (let i = 0; i < BOT_COUNT; i++) {
    bots.push(makeBot(NAMES[i % NAMES.length] as string));
  }

  // staggered per-bot tick loops
  setTimeout(() => {
    for (const bot of bots) {
      const loop = (): void => {
        tick(bot);
        setTimeout(loop, jitter(1500, 4000));
      };
      setTimeout(loop, jitter(0, 1500));
    }
  }, 1000);
}

function shutdown(): void {
  console.log("\nShutting down bots…");
  for (const bot of bots) bot.client.disconnect();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start();

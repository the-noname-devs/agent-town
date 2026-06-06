import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

export interface SetupClaudeOptions {
  /** Use the local clone of @agent-town/bridge instead of the published npm pkg.
   *  Lets maintainers iterate on the bridge without publishing. */
  dev?: boolean;
}

export async function setupClaude(opts: SetupClaudeOptions = {}): Promise<void> {
  const configPath = join(homedir(), ".agent-town", "config.json");

  if (!existsSync(configPath)) {
    console.error("Not configured. Run 'agent-town login' or 'agent-town init' first.");
    process.exit(1);
  }

  console.log(`Setting up Claude Code integration${opts.dev ? " (dev mode)" : ""}...\n`);

  // ── 1. Locate the bridge package (dev: local clone; prod: published npm pkg)
  const bridgeDir = locateBridgePackage(opts.dev);
  if (!bridgeDir) {
    if (opts.dev) {
      console.error(
        "Dev mode: could not find a local clone of @agent-town/bridge.\n" +
        "Expected packages/bridge/ to live under the same repo as @agent-town/cli."
      );
    } else {
      console.error(
        "Could not resolve @agent-town/bridge. Install it first:\n" +
        "  npm i -g @agent-town/bridge\n" +
        "or run setup-claude from the same project root as agent-town."
      );
    }
    process.exit(1);
  }
  const distEntry = join(bridgeDir, "dist", "index.js");
  if (!existsSync(distEntry)) {
    console.error(`Bridge dist not found at ${distEntry}. Run 'pnpm --filter @agent-town/bridge build' first.`);
    process.exit(1);
  }

  // ── 2. Configure MCP server in ~/.claude.json
  const claudeConfigPath = join(homedir(), ".claude.json");
  let claudeConfig: Record<string, unknown> = {};
  if (existsSync(claudeConfigPath)) {
    claudeConfig = JSON.parse(readFileSync(claudeConfigPath, "utf-8"));
  }

  const mcpServers = (claudeConfig.mcpServers as Record<string, unknown>) ?? {};
  if (opts.dev) {
    // Dev mode → spawn node against the local dist. Always uses freshest build.
    mcpServers["agent-town"] = {
      command: "node",
      args: [distEntry],
      env: {},
    };
  } else {
    // Prod mode: pick the best command to spawn the bridge on this machine.
    // Auto-detects around the npm 11 + Node 24/26 npx bin-resolution bug so
    // setup works regardless of which Node/npm the user is on.
    const cmd = resolveProdCommand();
    mcpServers["agent-town"] = { command: cmd.command, args: cmd.args, env: {} };
    console.log(`Bridge launch: ${cmd.source}`);
  }
  claudeConfig.mcpServers = mcpServers;

  writeFileSync(claudeConfigPath, JSON.stringify(claudeConfig, null, 2) + "\n");
  console.log(`MCP server added to ${claudeConfigPath}`);

  // ── 3. Configure hooks in ~/.claude/settings.json
  const settingsPath = join(homedir(), ".claude", "settings.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
  } else {
    mkdirSync(dirname(settingsPath), { recursive: true });
  }

  const hooks = (settings.hooks as Record<string, unknown[]>) ?? {};

  // Strip any previously-installed agent-town hooks so we can rewrite cleanly.
  const filterOld = (arr: unknown[]) =>
    (arr ?? []).filter((h: unknown) => {
      const hook = h as Record<string, unknown>;
      return !hook.__agentBridge && !hook.__agentTown;
    });

  // Hook scripts live alongside the bridge package (not under dist/).
  // bridgeDir already resolves to the package root in both dev and prod modes.
  const preEditScript = join(bridgeDir, "pre-edit-check.cjs");
  const postEditScript = join(bridgeDir, "hook.cjs");
  const teamContextScript = join(bridgeDir, "team-context-hook.cjs");

  const hookOk = existsSync(preEditScript) && existsSync(postEditScript) && existsSync(teamContextScript);
  if (!hookOk) {
    console.log(`⚠ Hook scripts missing under ${bridgeDir}. Falling back to MCP-only.`);
  }

  hooks.PreToolUse = [
    ...filterOld(hooks.PreToolUse as unknown[]),
    ...(hookOk
      ? [
          {
            __agentTown: true,
            matcher: "Edit|Write",
            hooks: [
              { type: "command", command: `node ${preEditScript}`, timeout: 5000 },
            ],
          },
        ]
      : []),
  ];

  hooks.PostToolUse = [
    ...filterOld(hooks.PostToolUse as unknown[]),
    ...(hookOk
      ? [
          {
            __agentTown: true,
            matcher: "Edit|Write",
            hooks: [{ type: "command", command: `node ${postEditScript}`, timeout: 5000 }],
          },
        ]
      : [
          // Fallback when hook scripts are unavailable (e.g. bridge installed
          // without the .cjs hook files alongside dist/).
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
        ]),
  ];

  hooks.UserPromptSubmit = [
    ...filterOld(hooks.UserPromptSubmit as unknown[]),
    ...(hookOk
      ? [
          {
            __agentTown: true,
            hooks: [
              { type: "command", command: `node ${teamContextScript}`, timeout: 5000 },
            ],
          },
        ]
      : []),
  ];

  settings.hooks = hooks;

  // Allowlist all MCP tools so Claude can call them without prompting.
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
    "mcp__agent-town__set_intent",
    "mcp__agent-town__share_thought",
  ];
  for (const tool of bridgeTools) {
    if (!allowedTools.includes(tool)) allowedTools.push(tool);
  }
  settings.allowedTools = allowedTools;

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  console.log(`Allowed tools added to ${settingsPath}`);

  console.log(`\nMode: ${opts.dev ? "DEV (local clone)" : "PROD (npm pkg)"}`);
  console.log(`Bridge: ${bridgeDir}`);
  console.log(`\nSetup complete! Claude Code will now:`);
  console.log(`   - Auto-check for conflicts before editing files (PreToolUse)`);
  console.log(`   - Auto-inject team status into every conversation (UserPromptSubmit)`);
  console.log(`   - Auto-claim files after editing (PostToolUse)`);
  console.log(`   - Have ${bridgeTools.length} tools for team coordination`);
  console.log(`\nRestart Claude Code to activate.`);
}

/**
 * Try to find the bridge package on disk.
 *
 * - In `dev` mode we walk up from the CLI's own location looking for a sibling
 *   `packages/bridge/` (works when the repo is checked out and we're running
 *   either the built CLI or `pnpm dev`).
 * - In prod mode we ask Node's resolver — works when @agent-town/bridge is a
 *   regular dependency or globally installed.
 */
function locateBridgePackage(dev: boolean | undefined): string | undefined {
  if (dev) {
    return findLocalBridge();
  }

  try {
    const url = import.meta.resolve("@agent-town/bridge/package.json");
    return dirname(new URL(url).pathname);
  } catch {
    // Fall through to filesystem search — covers the case where setup-claude
    // is invoked from a sibling repo without bridge installed as a dep.
    return findLocalBridge();
  }
}

function findLocalBridge(): string | undefined {
  // Walk up from this file's directory looking for packages/bridge with a
  // valid package.json. Handles both `src/` (dev) and `dist/` (built) layouts.
  const startUrl = new URL(import.meta.url);
  let dir = dirname(startUrl.pathname);

  for (let depth = 0; depth < 8; depth++) {
    const candidate = join(dir, "packages", "bridge", "package.json");
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, "utf-8")) as { name?: string };
        if (pkg.name === "@agent-town/bridge") {
          return dirname(candidate);
        }
      } catch {
        /* ignore */
      }
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

// Avoid unused-import warning when statSync is dropped by tree-shakers
void statSync;

// ─── Prod-mode bridge launcher resolution ──────────────────────────────────
//
// Three strategies, picked in priority order:
//
//   1. `bridge` (or `agent-town-bridge` / `agent-town-mcp`) already in PATH
//      — typically means the user globally installed the pkg. Cheapest.
//   2. `npx -y @agent-town/bridge` — fast and self-updating, but currently
//      broken on npm 11 (ships with Node 24+).
//   3. Auto-install `@agent-town/bridge` globally as a fallback, then use the
//      resulting bin path. One-time cost; works everywhere.
//
// Returning the absolute bin path (rather than just "bridge") avoids relying
// on Claude Code inheriting the user's PATH when it spawns the MCP server.
interface ProdCommand {
  command: string;
  args: string[];
  source: string;
}

function tryWhich(bin: string): string | null {
  try {
    const out = execSync(`command -v ${bin}`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function npxIsBroken(): boolean {
  try {
    const npmVer = execSync("npm --version", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    const major = parseInt(npmVer.split(".")[0], 10);
    // npm 11+ fails to resolve scoped-pkg bins via `npx` — confirmed broken
    // on npm 11.x bundled with Node 24/26. npm 10 (Node 20/22 LTS) works.
    return major >= 11;
  } catch {
    // If we can't even probe npm, assume worst-case so we install globally.
    return true;
  }
}

function resolveProdCommand(): ProdCommand {
  // 1. Globally installed already?
  const existing = tryWhich("bridge") || tryWhich("agent-town-bridge") || tryWhich("agent-town-mcp");
  if (existing) {
    return { command: existing, args: [], source: `globally installed at ${existing}` };
  }

  // 2. Can we use npx?
  if (!npxIsBroken()) {
    return { command: "npx", args: ["-y", "@agent-town/bridge"], source: "npx (current npm supports it)" };
  }

  // 3. Auto-install globally as fallback. Loud + slow so the user sees it.
  console.log("");
  console.log(`⚠  Node ${process.versions.node} ships an npm that mis-resolves npx bins.`);
  console.log(`   Installing @agent-town/bridge globally as a one-time fallback…`);
  try {
    execSync("npm i -g @agent-town/bridge", { stdio: "inherit" });
  } catch {
    throw new Error(
      "Auto-install failed. Run this manually, then re-run `agent-town setup-claude`:\n" +
        "  npm i -g @agent-town/bridge"
    );
  }
  const installed = tryWhich("bridge");
  if (!installed) {
    throw new Error(
      "Global install completed but `bridge` is not on PATH. Add your npm global bin dir to PATH:\n" +
        "  echo 'export PATH=\"$(npm bin -g):$PATH\"' >> ~/.zshrc"
    );
  }
  return { command: installed, args: [], source: `auto-installed at ${installed}` };
}

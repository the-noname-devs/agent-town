import { createServer, type IncomingMessage, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import {
  MessageType,
  AgentStatus,
  LockStatus,
  parseMessage,
  createMessage,
  type AgentInfo,
  type FileLock,
  type ActivityEntry,
  type ProtectedZone,
  type TeamState,
  type ClientMessage,
  type RegisterMessage,
  type ServerStateMessage,
  type ServerConflictMessage,
  type ServerErrorMessage,
  type ServerAckMessage,
  type ServerChatMessage,
} from "@agent-town/shared";

interface ConnectedAgent {
  ws: WebSocket;
  info: AgentInfo;
  teamKey: string;
}

const FALLBACK_HTML =
  "<!doctype html><meta charset=utf-8><title>Agent Town</title>" +
  "<body style=\"font-family:system-ui;padding:2rem\"><h1>Agent Town</h1>" +
  "<p>Dashboard asset not found. Run <code>pnpm build</code> to bundle it.</p></body>";

function loadDashboardHtml(): Buffer {
  try {
    const htmlPath = fileURLToPath(new URL("../public/index.html", import.meta.url));
    return readFileSync(htmlPath);
  } catch {
    console.warn("Dashboard HTML not found — serving inline fallback.");
    return Buffer.from(FALLBACK_HTML, "utf-8");
  }
}

interface RelayOptions {
  port: number;
  heartbeatTimeout?: number;
  lockTtl?: number;
  maxActivities?: number;
  /** URL to POST team key validation requests to. If not set, all keys are accepted. */
  authUrl?: string;
  /** Secret token sent as Bearer auth to the validation endpoint. */
  authSecret?: string;
  /** URL to POST activity events to for persistence. Optional. */
  activityWebhookUrl?: string;
}

interface TeamKeyCache {
  valid: boolean;
  expiresAt: number;
}

export class RelayServer {
  private httpServer: Server;
  private wss: WebSocketServer;
  private agents = new Map<string, ConnectedAgent>();
  private locks = new Map<string, FileLock>();
  private zones = new Map<string, ProtectedZone & { teamKey: string }>();
  private activities = new Map<string, ActivityEntry[]>();
  private teamKeyCache = new Map<string, TeamKeyCache>();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private readonly heartbeatTimeout: number;
  private readonly lockTtl: number;
  private readonly maxActivities: number;
  private readonly port: number;
  private readonly dashboardHtml: Buffer;
  private readonly authUrl?: string;
  private readonly authSecret?: string;
  private readonly activityWebhookUrl?: string;
  private readonly authEnabled: boolean;

  constructor(options: RelayOptions) {
    this.port = options.port;
    this.heartbeatTimeout = options.heartbeatTimeout ?? 90_000;
    this.lockTtl = options.lockTtl ?? 120_000;
    this.maxActivities = options.maxActivities ?? 50;
    this.authUrl = options.authUrl;
    this.authSecret = options.authSecret;
    this.activityWebhookUrl = options.activityWebhookUrl;
    this.authEnabled = !!(this.authUrl);
    this.dashboardHtml = loadDashboardHtml();

    if (this.authEnabled) {
      console.log("Auth enabled — validating team keys via", this.authUrl);
    } else {
      console.log("Auth disabled — accepting all team keys (self-hosted mode)");
    }

    this.httpServer = createServer((req, res) => {
      if (req.url === "/" || req.url === "/index.html" || req.url?.startsWith("/?")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(this.dashboardHtml);
        return;
      }
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", agents: this.agents.size }));
        return;
      }
      if (req.url === "/status") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(this.getTeamStates()));
        return;
      }
      // POST /file-change — HTTP endpoint for PostToolUse hooks to report file edits
      if (req.url === "/file-change" && req.method === "POST") {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => {
          try {
            const { teamKey, agentId, userName, path, action, chat, repo, workSummary } = JSON.parse(body);
            if (teamKey && path) {
              // Find agent by ID first, then fallback to matching by teamKey + userName (or base userName)
              let matchedAgentId = agentId;
              const baseUser = userName ? userName.replace(/-\d+$/, "") : "";
              if (!this.agents.has(agentId)) {
                for (const [id, agent] of this.agents) {
                  if (agent.teamKey !== teamKey) continue;
                  const agentBase = agent.info.userName.replace(/-\d+$/, "");
                  if (agent.info.userName === userName || agentBase === baseUser) {
                    matchedAgentId = id;
                    break;
                  }
                }
              }

              // Update agent's repo if provided
              if (repo && this.agents.has(matchedAgentId)) {
                (this.agents.get(matchedAgentId)!.info as any).repo = repo;
              }

              // Report the file change if we found the agent
              if (this.agents.has(matchedAgentId)) {
                this.handleFileChange(matchedAgentId, path, action || "edit");
              }

              // Add to activity log
              this.addActivity(teamKey, {
                agentId: matchedAgentId || "unknown",
                userName: userName || "unknown",
                path,
                action: action || "edit",
                timestamp: Date.now(),
                repo,
              });

              // Send auto-chat if provided
              if (chat && this.agents.has(matchedAgentId)) {
                this.handleChat(matchedAgentId, chat);
              }

              // Update work summary if provided
              if (workSummary && this.agents.has(matchedAgentId)) {
                (this.agents.get(matchedAgentId)!.info as any).workSummary = workSummary;
              }

              this.broadcastState(teamKey);
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false }));
          }
        });
        return;
      }
      // GET /check-conflict — PreToolUse hook checks if a file is safe to edit
      if (req.url?.startsWith("/check-conflict") && req.method === "GET") {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const teamKey = url.searchParams.get("teamKey") || "";
        const path = url.searchParams.get("path") || "";
        const agentId = url.searchParams.get("agentId") || "";
        const userName = url.searchParams.get("userName") || "";

        if (!teamKey || !path) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ allowed: true }));
          return;
        }

        // Check file lock — allow if same agent OR same base user (tmsn matches tmsn-1, tmsn-2)
        const lock = this.locks.get(path);
        const baseUser = userName.replace(/-\d+$/, "");
        const lockBaseUser = lock ? lock.userName.replace(/-\d+$/, "") : "";
        const isSelf = lock && (lock.agentId === agentId || (baseUser && baseUser === lockBaseUser));
        if (lock && !isSelf && lock.status === LockStatus.Active) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ allowed: false, reason: `${lock.userName} is editing this file`, lockedBy: lock.userName }));
          return;
        }

        // Check zone violations — allow if same agent OR same base user
        for (const [, zone] of this.zones) {
          const zoneBaseUser = zone.userName.replace(/-\d+$/, "");
          const isZoneSelf = zone.agentId === agentId || (baseUser && baseUser === zoneBaseUser);
          if (zone.teamKey === teamKey && !isZoneSelf && this.pathMatchesPattern(path, zone.pattern)) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ allowed: false, reason: `File is inside protected zone '${zone.pattern}' by ${zone.userName}${zone.reason ? ` (${zone.reason})` : ""}`, lockedBy: zone.userName, zone: zone.pattern }));
            return;
          }
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ allowed: true }));
        return;
      }

      // GET /team-context — UserPromptSubmit hook gets team status for context injection
      if (req.url?.startsWith("/team-context") && req.method === "GET") {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const teamKey = url.searchParams.get("teamKey") || "";
        const agentId = url.searchParams.get("agentId") || "";

        const agents: { name: string; status: string; branch?: string; activeFiles: string[]; workSummary?: string }[] = [];
        for (const [, agent] of this.agents) {
          if (agent.teamKey === teamKey && agent.info.agentId !== agentId && agent.info.machineId !== "observer") {
            agents.push({
              name: agent.info.userName,
              status: agent.info.status,
              branch: agent.info.branch,
              activeFiles: agent.info.activeFiles,
              workSummary: (agent.info as any).workSummary,
            });
          }
        }

        const zones: { pattern: string; owner: string; reason?: string }[] = [];
        for (const [, zone] of this.zones) {
          if (zone.teamKey === teamKey && zone.agentId !== agentId) {
            zones.push({ pattern: zone.pattern, owner: zone.userName, reason: zone.reason });
          }
        }

        // Recent activity summary (last 10 min)
        const tenMinAgo = Date.now() - 10 * 60 * 1000;
        const recentActs = (this.activities.get(teamKey) ?? []).filter(a => a.timestamp > tenMinAgo && a.agentId !== agentId);
        const actSummary: Record<string, { count: number; folders: Set<string> }> = {};
        for (const act of recentActs) {
          if (!actSummary[act.userName]) actSummary[act.userName] = { count: 0, folders: new Set() };
          actSummary[act.userName].count++;
          const folder = act.path.split(/[\\/]/).slice(-2, -1)[0] || "root";
          actSummary[act.userName].folders.add(folder);
        }
        const recentActivity = Object.entries(actSummary).map(([name, s]) => `${name}: ${s.count} edits in ${[...s.folders].join(", ")}`).join("; ");

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ agents, zones, recentActivity: recentActivity || "no recent activity" }));
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));
  }

  start(): void {
    this.httpServer.listen(this.port, () => {
      console.log(`Agent Town Relay running on port ${this.port}`);
    });

    this.heartbeatInterval = setInterval(() => {
      this.cleanupStale();
    }, 30_000);
  }

  stop(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    this.wss.close();
    this.httpServer.close();
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    let registered = false;
    let agentId: string | null = null;

    const timeout = setTimeout(() => {
      if (!registered) {
        ws.close(4001, "Registration timeout");
      }
    }, 10_000);

    ws.on("message", (data) => {
      let msg: ClientMessage;
      try {
        msg = parseMessage(data.toString()) as ClientMessage;
      } catch {
        this.sendError(ws, "PARSE_ERROR", "Invalid message format");
        return;
      }

      if (!registered && msg.type !== MessageType.Register) {
        this.sendError(ws, "NOT_REGISTERED", "Must register first");
        return;
      }

      switch (msg.type) {
        case MessageType.Register:
          clearTimeout(timeout);
          agentId = msg.agentId;
          this.handleRegister(ws, msg).then((ok) => { registered = ok; });
          break;
        case MessageType.Heartbeat:
          this.handleHeartbeat(msg.agentId, msg.branch);
          break;
        case MessageType.FileClaim:
          this.handleFileClaim(msg.agentId, msg.path);
          break;
        case MessageType.FileRelease:
          this.handleFileRelease(msg.agentId, msg.path);
          break;
        case MessageType.FileChange:
          this.handleFileChange(msg.agentId, msg.path, msg.action);
          break;
        case MessageType.SendChat:
          this.handleChat(msg.agentId, msg.message);
          break;
        case MessageType.ZoneClaim:
          this.handleZoneClaim(msg.agentId, msg.pattern, msg.reason);
          break;
        case MessageType.ZoneRelease:
          this.handleZoneRelease(msg.agentId, msg.pattern);
          break;
        case MessageType.UpdateSummary:
          if (agentId) {
            const summaryAgent = this.agents.get(agentId);
            if (summaryAgent) {
              (summaryAgent.info as any).workSummary = msg.summary;
              this.broadcastState(summaryAgent.teamKey);
            }
          }
          break;
      }
    });

    ws.on("close", () => {
      clearTimeout(timeout);
      if (agentId) {
        this.handleDisconnect(agentId);
      }
    });

    ws.on("error", () => {
      clearTimeout(timeout);
      if (agentId) {
        this.handleDisconnect(agentId);
      }
    });
  }

  private async handleRegister(ws: WebSocket, msg: RegisterMessage): Promise<boolean> {
    // Validate team key if auth is enabled
    if (this.authEnabled) {
      const valid = await this.validateTeamKey(msg.teamKey);
      if (!valid) {
        this.sendError(ws, "INVALID_TEAM_KEY", "Invalid or expired team key. Sign up at https://agent-town.dev");
        ws.close(4001, "Invalid team key");
        return false;
      }
    }

    const existing = this.agents.get(msg.agentId);
    if (existing) {
      existing.ws.close(4002, "Replaced by new connection");
    }

    const agent: ConnectedAgent = {
      ws,
      teamKey: msg.teamKey,
      info: {
        agentId: msg.agentId,
        userName: msg.userName,
        machineId: msg.machineId,
        status: AgentStatus.Online,
        connectedAt: Date.now(),
        lastHeartbeat: Date.now(),
        activeFiles: [],
        branch: msg.branch,
      },
    };

    this.agents.set(msg.agentId, agent);
    console.log(`Agent registered: ${msg.userName} (${msg.agentId})`);

    this.sendAck(ws, MessageType.Register);
    this.broadcastState(msg.teamKey);
    return true;
  }

  private handleHeartbeat(agentId: string, branch?: string): void {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.info.lastHeartbeat = Date.now();
      agent.info.status = AgentStatus.Online;
      if (branch !== undefined) {
        const changed = agent.info.branch !== branch;
        agent.info.branch = branch;
        if (changed) {
          this.broadcastState(agent.teamKey);
        }
      }
    }
  }

  private handleFileClaim(agentId: string, path: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    // Check zone violations
    const zoneConflict = this.checkZoneViolation(agentId, path, agent.teamKey);
    if (zoneConflict) {
      const conflict: ServerConflictMessage = {
        type: MessageType.Conflict,
        path,
        claimedBy: {
          agentId: zoneConflict.agentId,
          userName: zoneConflict.userName,
        },
        requestedBy: {
          agentId,
          userName: agent.info.userName,
        },
        zone: zoneConflict.pattern,
      };
      agent.ws.send(createMessage(conflict));
    }

    const existingLock = this.locks.get(path);
    if (existingLock && existingLock.agentId !== agentId && existingLock.status === LockStatus.Active) {
      const claimedByAgent = this.agents.get(existingLock.agentId);
      const conflict: ServerConflictMessage = {
        type: MessageType.Conflict,
        path,
        claimedBy: {
          agentId: existingLock.agentId,
          userName: existingLock.userName,
        },
        requestedBy: {
          agentId,
          userName: agent.info.userName,
        },
      };
      agent.ws.send(createMessage(conflict));

      if (claimedByAgent) {
        claimedByAgent.ws.send(createMessage(conflict));
      }
    }

    // Advisory lock — always grant, but warn on conflict
    this.locks.set(path, {
      path,
      agentId,
      userName: agent.info.userName,
      claimedAt: Date.now(),
      status: LockStatus.Active,
    });

    if (!agent.info.activeFiles.includes(path)) {
      agent.info.activeFiles.push(path);
    }

    this.addActivity(agent.teamKey, {
      agentId,
      userName: agent.info.userName,
      path,
      action: "claim",
      timestamp: Date.now(),
    });

    this.sendAck(agent.ws, MessageType.FileClaim);
    this.broadcastState(agent.teamKey);
  }

  private handleFileRelease(agentId: string, path: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    const lock = this.locks.get(path);
    if (lock && lock.agentId === agentId) {
      this.locks.delete(path);
    }

    agent.info.activeFiles = agent.info.activeFiles.filter((f) => f !== path);

    this.addActivity(agent.teamKey, {
      agentId,
      userName: agent.info.userName,
      path,
      action: "release",
      timestamp: Date.now(),
    });

    this.sendAck(agent.ws, MessageType.FileRelease);
    this.broadcastState(agent.teamKey);
  }

  private handleFileChange(agentId: string, path: string, action: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    this.addActivity(agent.teamKey, {
      agentId,
      userName: agent.info.userName,
      path,
      action: action as ActivityEntry["action"],
      timestamp: Date.now(),
    });

    // Auto-claim on change if not already claimed
    if (!this.locks.has(path)) {
      this.handleFileClaim(agentId, path);
    } else {
      const lock = this.locks.get(path)!;
      if (lock.agentId !== agentId) {
        this.handleFileClaim(agentId, path);
      }
    }
  }

  private handleChat(agentId: string, message: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    const chat: ServerChatMessage = {
      type: MessageType.Chat,
      from: { agentId, userName: agent.info.userName },
      message,
      timestamp: Date.now(),
    };

    // Broadcast to all team members
    for (const [, other] of this.agents) {
      if (other.teamKey === agent.teamKey && other.ws.readyState === WebSocket.OPEN) {
        other.ws.send(createMessage(chat));
      }
    }
  }

  private handleZoneClaim(agentId: string, pattern: string, reason?: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    this.zones.set(`${agent.teamKey}:${pattern}`, {
      pattern,
      agentId,
      userName: agent.info.userName,
      reason,
      claimedAt: Date.now(),
      teamKey: agent.teamKey,
    });

    this.sendAck(agent.ws, MessageType.ZoneClaim);
    this.broadcastState(agent.teamKey);
  }

  private handleZoneRelease(agentId: string, pattern: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    const key = `${agent.teamKey}:${pattern}`;
    const zone = this.zones.get(key);
    if (zone && zone.agentId === agentId) {
      this.zones.delete(key);
    }

    this.sendAck(agent.ws, MessageType.ZoneRelease);
    this.broadcastState(agent.teamKey);
  }

  private checkZoneViolation(
    agentId: string,
    path: string,
    teamKey: string
  ): ProtectedZone | null {
    for (const [, zone] of this.zones) {
      if (zone.teamKey !== teamKey || zone.agentId === agentId) continue;
      if (this.pathMatchesPattern(path, zone.pattern)) {
        return zone;
      }
    }
    return null;
  }

  private pathMatchesPattern(path: string, pattern: string): boolean {
    // Support glob-like patterns: "src/api/**" or exact prefix "src/api/"
    if (pattern.endsWith("/**")) {
      const prefix = pattern.slice(0, -3);
      return path.startsWith(prefix + "/") || path === prefix;
    }
    if (pattern.endsWith("/")) {
      return path.startsWith(pattern);
    }
    // Exact match or prefix match
    return path === pattern || path.startsWith(pattern + "/");
  }

  private async validateTeamKey(teamKey: string): Promise<boolean> {
    // Check cache first (valid for 60 seconds)
    const cached = this.teamKeyCache.get(teamKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.valid;
    }

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.authSecret) {
        headers["Authorization"] = `Bearer ${this.authSecret}`;
      }

      const res = await fetch(this.authUrl!, {
        method: "POST",
        headers,
        body: JSON.stringify({ teamKey }),
      });

      if (!res.ok) {
        console.error(`Team key validation failed: HTTP ${res.status}`);
        // Fail open on API errors to avoid outage
        return true;
      }

      const data = await res.json() as { valid: boolean; reason?: string };
      const valid = !!data.valid;

      this.teamKeyCache.set(teamKey, {
        valid,
        expiresAt: Date.now() + 300_000, // 5 min cache
      });

      if (!valid) {
        console.log(`Team key rejected: ${teamKey.slice(0, 12)}...${data.reason ? ` (${data.reason})` : ""}`);
      }

      return valid;
    } catch (err) {
      console.error("Team key validation error:", err);
      // Fail open on network errors
      return true;
    }
  }

  private handleDisconnect(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    const teamKey = agent.teamKey;

    // Release all locks held by this agent
    for (const [path, lock] of this.locks) {
      if (lock.agentId === agentId) {
        this.locks.delete(path);
      }
    }

    // Release all zones held by this agent
    for (const [key, zone] of this.zones) {
      if (zone.agentId === agentId) {
        this.zones.delete(key);
      }
    }

    this.agents.delete(agentId);
    console.log(`Agent disconnected: ${agentId}`);

    this.broadcastState(teamKey);
  }

  private addActivity(teamKey: string, entry: ActivityEntry): void {
    let list = this.activities.get(teamKey);
    if (!list) {
      list = [];
      this.activities.set(teamKey, list);
    }
    list.push(entry);
    if (list.length > this.maxActivities) {
      this.activities.set(teamKey, list.slice(-this.maxActivities));
    }

    // Persist activity via webhook if configured (async, non-blocking)
    if (this.activityWebhookUrl) {
      this.persistActivity(teamKey, entry);
    }
  }

  private persistActivity(teamKey: string, entry: ActivityEntry): void {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.authSecret) {
      headers["Authorization"] = `Bearer ${this.authSecret}`;
    }

    fetch(this.activityWebhookUrl!, {
      method: "POST",
      headers,
      body: JSON.stringify({
        teamKey,
        agent: entry.userName,
        path: entry.path,
        action: entry.action,
      }),
    }).catch(() => {
      // Fire-and-forget — don't block relay operations
    });
  }

  private cleanupStale(): void {
    const now = Date.now();
    const teamsToUpdate = new Set<string>();

    // Expire idle agents
    for (const [agentId, agent] of this.agents) {
      if (now - agent.info.lastHeartbeat > this.heartbeatTimeout) {
        console.log(`Agent timed out: ${agentId}`);
        agent.ws.close(4003, "Heartbeat timeout");
        teamsToUpdate.add(agent.teamKey);
        this.handleDisconnect(agentId);
      } else if (now - agent.info.lastHeartbeat > 60_000) {
        agent.info.status = AgentStatus.Idle;
        teamsToUpdate.add(agent.teamKey);
      }
    }

    // Expire old locks
    for (const [path, lock] of this.locks) {
      if (now - lock.claimedAt > this.lockTtl) {
        lock.status = LockStatus.Expired;
        this.locks.delete(path);
      }
    }

    for (const teamKey of teamsToUpdate) {
      this.broadcastState(teamKey);
    }
  }

  private broadcastState(teamKey: string): void {
    const state = this.getTeamState(teamKey);
    const msg = createMessage<ServerStateMessage>({
      type: MessageType.State,
      state,
    });

    for (const [, agent] of this.agents) {
      if (agent.teamKey === teamKey && agent.ws.readyState === WebSocket.OPEN) {
        agent.ws.send(msg);
      }
    }
  }

  private getTeamState(teamKey: string): TeamState {
    const agents: AgentInfo[] = [];
    const lockSet = new Set<string>();

    for (const [, agent] of this.agents) {
      if (agent.teamKey === teamKey) {
        agents.push({ ...agent.info });
        for (const file of agent.info.activeFiles) {
          lockSet.add(file);
        }
      }
    }

    const locks: FileLock[] = [];
    for (const [, lock] of this.locks) {
      if (agents.some((a) => a.agentId === lock.agentId)) {
        locks.push({ ...lock });
      }
    }

    const zones: ProtectedZone[] = [];
    for (const [, zone] of this.zones) {
      if (zone.teamKey === teamKey) {
        const { teamKey: _, ...zoneData } = zone;
        zones.push(zoneData);
      }
    }

    const activities = this.activities.get(teamKey) ?? [];

    return { agents, locks, activities, zones };
  }

  private getTeamStates(): Record<string, TeamState> {
    const teams = new Set<string>();
    for (const [, agent] of this.agents) {
      teams.add(agent.teamKey);
    }
    const result: Record<string, TeamState> = {};
    for (const teamKey of teams) {
      result[teamKey] = this.getTeamState(teamKey);
    }
    return result;
  }

  private sendError(ws: WebSocket, code: string, message: string): void {
    const msg: ServerErrorMessage = { type: MessageType.Error, code, message };
    ws.send(createMessage(msg));
  }

  private sendAck(ws: WebSocket, replyTo: MessageType): void {
    const msg: ServerAckMessage = { type: MessageType.Ack, replyTo };
    ws.send(createMessage(msg));
  }
}

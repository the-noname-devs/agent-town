// --- Enums ---

export enum MessageType {
  // Client -> Server
  Register = "register",
  Heartbeat = "heartbeat",
  FileClaim = "file_claim",
  FileRelease = "file_release",
  FileChange = "file_change",
  SendChat = "send_chat",
  ZoneClaim = "zone_claim",
  ZoneRelease = "zone_release",
  UpdateSummary = "update_summary",
  UpdateIntent = "update_intent",
  ShareThought = "share_thought",

  // Server -> Client
  State = "state",
  Conflict = "conflict",
  Chat = "chat",
  Thought = "thought",
  Error = "error",
  Ack = "ack",
}

export enum AgentStatus {
  Online = "online",
  Idle = "idle",
  Offline = "offline",
}

export enum LockStatus {
  Active = "active",
  Expired = "expired",
}

// --- Data Structures ---

/**
 * Structured intent — what the agent is trying to accomplish + why.
 * Set explicitly by the agent via `set_intent`; broadcast in team state so
 * teammates see the goal, not just the file edits.
 */
export interface AgentIntent {
  /** Short task name. e.g. "Refactoring auth to JWT". */
  task: string;
  /** Why this task is being done. e.g. "session cookies are too brittle for the SPA". */
  why?: string;
  /** Path globs the agent expects to touch. e.g. ["src/auth/**", "src/middleware/**"]. */
  scope?: string[];
  /** When this intent was set/updated. */
  updatedAt: number;
}

export interface AgentInfo {
  agentId: string;
  userName: string;
  machineId: string;
  status: AgentStatus;
  connectedAt: number;
  lastHeartbeat: number;
  activeFiles: string[];
  branch?: string;
  /** Rolling auto-summary of recent work — broadcast at intervals from the hook. */
  workSummary?: string;
  /** Structured intent set explicitly by the agent. */
  intent?: AgentIntent;
  repo?: string;
}

export interface FileLock {
  path: string;
  agentId: string;
  userName: string;
  claimedAt: number;
  status: LockStatus;
}

export interface PresenceUpdate {
  agentId: string;
  userName: string;
  status: AgentStatus;
  activeFiles: string[];
}

export interface ActivityEntry {
  agentId: string;
  userName: string;
  path: string;
  action: "edit" | "write" | "delete" | "claim" | "release";
  timestamp: number;
  repo?: string;
  /** Lines added in this edit. Approximation: counts every newline incl. whitespace. */
  linesAdded?: number;
  /** Lines removed in this edit. Approximation: counts every newline incl. whitespace. */
  linesRemoved?: number;
}

export interface ProtectedZone {
  pattern: string;
  agentId: string;
  userName: string;
  reason?: string;
  claimedAt: number;
}

export interface TeamState {
  agents: AgentInfo[];
  locks: FileLock[];
  activities: ActivityEntry[];
  zones: ProtectedZone[];
}

// --- Client Messages ---

export interface RegisterMessage {
  type: MessageType.Register;
  agentId: string;
  userName: string;
  machineId: string;
  teamKey: string;
  branch?: string;
}

export interface HeartbeatMessage {
  type: MessageType.Heartbeat;
  agentId: string;
  branch?: string;
}

export interface FileClaimMessage {
  type: MessageType.FileClaim;
  agentId: string;
  path: string;
}

export interface FileReleaseMessage {
  type: MessageType.FileRelease;
  agentId: string;
  path: string;
}

export interface FileChangeMessage {
  type: MessageType.FileChange;
  agentId: string;
  path: string;
  action: "edit" | "write" | "delete";
}

export interface SendChatMessage {
  type: MessageType.SendChat;
  agentId: string;
  message: string;
}

export interface ZoneClaimMessage {
  type: MessageType.ZoneClaim;
  agentId: string;
  pattern: string;
  reason?: string;
}

export interface ZoneReleaseMessage {
  type: MessageType.ZoneRelease;
  agentId: string;
  pattern: string;
}

export interface UpdateSummaryMessage {
  type: MessageType.UpdateSummary;
  summary: string;
}

export interface UpdateIntentMessage {
  type: MessageType.UpdateIntent;
  task: string;
  why?: string;
  scope?: string[];
}

export interface ShareThoughtMessage {
  type: MessageType.ShareThought;
  agentId: string;
  /** A short thought / reasoning snippet. */
  thought: string;
  /** Optional kind, helps the dashboard render. */
  kind?: "decision" | "blocker" | "insight" | "plan" | "note";
}

// --- Server Messages ---

export interface ServerStateMessage {
  type: MessageType.State;
  state: TeamState;
}

export interface ServerConflictMessage {
  type: MessageType.Conflict;
  path: string;
  claimedBy: { agentId: string; userName: string };
  requestedBy: { agentId: string; userName: string };
  zone?: string;
}

export interface ServerChatMessage {
  type: MessageType.Chat;
  from: { agentId: string; userName: string };
  message: string;
  timestamp: number;
}

export interface ServerThoughtMessage {
  type: MessageType.Thought;
  from: { agentId: string; userName: string };
  thought: string;
  kind?: "decision" | "blocker" | "insight" | "plan" | "note";
  timestamp: number;
}

export interface ServerErrorMessage {
  type: MessageType.Error;
  code: string;
  message: string;
}

export interface ServerAckMessage {
  type: MessageType.Ack;
  replyTo: MessageType;
}

// --- Union Types ---

export type ClientMessage =
  | RegisterMessage
  | HeartbeatMessage
  | FileClaimMessage
  | FileReleaseMessage
  | FileChangeMessage
  | SendChatMessage
  | ZoneClaimMessage
  | ZoneReleaseMessage
  | UpdateSummaryMessage
  | UpdateIntentMessage
  | ShareThoughtMessage;

export type ServerMessage =
  | ServerStateMessage
  | ServerConflictMessage
  | ServerChatMessage
  | ServerThoughtMessage
  | ServerErrorMessage
  | ServerAckMessage;

export type BridgeMessage = ClientMessage | ServerMessage;

// --- Config ---

export interface BridgeConfig {
  relayUrl: string;
  teamKey: string;
  userName: string;
  agentId: string;
  machineId: string;
  watchPaths?: string[];
  heartbeatInterval?: number;
  lockTtl?: number;
  repos?: string[];
}

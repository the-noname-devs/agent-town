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

  // Server -> Client
  State = "state",
  Conflict = "conflict",
  Chat = "chat",
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

export interface AgentInfo {
  agentId: string;
  userName: string;
  machineId: string;
  status: AgentStatus;
  connectedAt: number;
  lastHeartbeat: number;
  activeFiles: string[];
  branch?: string;
  workSummary?: string;
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
  | UpdateSummaryMessage;

export type ServerMessage =
  | ServerStateMessage
  | ServerConflictMessage
  | ServerChatMessage
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
}

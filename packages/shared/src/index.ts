export { MessageType, AgentStatus, LockStatus } from "./types.js";
export type {
  AgentInfo,
  AgentIntent,
  FileLock,
  PresenceUpdate,
  ActivityEntry,
  ProtectedZone,
  TeamState,
  BridgeMessage,
  RegisterMessage,
  HeartbeatMessage,
  FileClaimMessage,
  FileReleaseMessage,
  FileChangeMessage,
  SendChatMessage,
  ZoneClaimMessage,
  ZoneReleaseMessage,
  UpdateSummaryMessage,
  UpdateIntentMessage,
  ShareThoughtMessage,
  ServerStateMessage,
  ServerConflictMessage,
  ServerChatMessage,
  ServerThoughtMessage,
  ServerErrorMessage,
  ServerAckMessage,
  ClientMessage,
  ServerMessage,
  BridgeConfig,
} from "./types.js";

export { createMessage, parseMessage } from "./protocol.js";
export { generateAgentId, generateTeamKey } from "./utils.js";

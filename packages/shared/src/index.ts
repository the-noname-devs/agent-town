export { MessageType, AgentStatus, LockStatus } from "./types.js";
export type {
  AgentInfo,
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
  ServerStateMessage,
  ServerConflictMessage,
  ServerChatMessage,
  ServerErrorMessage,
  ServerAckMessage,
  ClientMessage,
  ServerMessage,
  BridgeConfig,
} from "./types.js";

export { createMessage, parseMessage } from "./protocol.js";
export { generateAgentId, generateTeamKey } from "./utils.js";

import WebSocket from "ws";
import { EventEmitter } from "node:events";
import {
  MessageType,
  createMessage,
  parseMessage,
  type BridgeConfig,
  type ServerMessage,
  type TeamState,
  type RegisterMessage,
  type HeartbeatMessage,
  type FileClaimMessage,
  type FileReleaseMessage,
  type FileChangeMessage,
  type SendChatMessage,
  type ZoneClaimMessage,
  type ZoneReleaseMessage,
  type ClientMessage,
} from "@agent-town/shared";

export class RelayClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private config: BridgeConfig;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private currentState: TeamState = { agents: [], locks: [], activities: [], zones: [] };
  private connected = false;
  private currentBranch: string | undefined;

  constructor(config: BridgeConfig) {
    super();
    this.config = config;
  }

  connect(): void {
    if (this.ws) {
      this.ws.close();
    }

    try {
      this.ws = new WebSocket(this.config.relayUrl);
    } catch (err) {
      this.scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      this.connected = true;
      this.register();
      this.startHeartbeat();
      this.emit("connected");
    });

    this.ws.on("message", (data) => {
      try {
        const msg = parseMessage(data.toString()) as ServerMessage;
        this.handleMessage(msg);
      } catch {
        // ignore malformed messages
      }
    });

    this.ws.on("close", () => {
      this.connected = false;
      this.stopHeartbeat();
      this.emit("disconnected");
      this.scheduleReconnect();
    });

    this.ws.on("error", () => {
      // close event will fire after this
    });
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getState(): TeamState {
    return this.currentState;
  }

  setBranch(branch: string | undefined): void {
    this.currentBranch = branch;
  }

  claimFile(path: string): void {
    this.send({
      type: MessageType.FileClaim,
      agentId: this.config.agentId,
      path,
    });
  }

  releaseFile(path: string): void {
    this.send({
      type: MessageType.FileRelease,
      agentId: this.config.agentId,
      path,
    });
  }

  reportFileChange(path: string, action: "edit" | "write" | "delete"): void {
    this.send({
      type: MessageType.FileChange,
      agentId: this.config.agentId,
      path,
      action,
    });
  }

  sendHeartbeat(): void {
    this.send({
      type: MessageType.Heartbeat,
      agentId: this.config.agentId,
      branch: this.currentBranch,
    });
  }

  sendChat(message: string): void {
    this.send({
      type: MessageType.SendChat,
      agentId: this.config.agentId,
      message,
    });
  }

  sendSummary(summary: string): void {
    this.send({
      type: MessageType.UpdateSummary,
      summary,
    } as any);
  }

  claimZone(pattern: string, reason?: string): void {
    this.send({
      type: MessageType.ZoneClaim,
      agentId: this.config.agentId,
      pattern,
      reason,
    });
  }

  releaseZone(pattern: string): void {
    this.send({
      type: MessageType.ZoneRelease,
      agentId: this.config.agentId,
      pattern,
    });
  }

  private register(): void {
    this.send({
      type: MessageType.Register,
      agentId: this.config.agentId,
      userName: this.config.userName,
      machineId: this.config.machineId,
      teamKey: this.config.teamKey,
      branch: this.currentBranch,
    });
  }

  private startHeartbeat(): void {
    const interval = this.config.heartbeatInterval ?? 30_000;
    this.heartbeatTimer = setInterval(() => {
      this.send({
        type: MessageType.Heartbeat,
        agentId: this.config.agentId,
        branch: this.currentBranch,
      });
    }, interval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case MessageType.State:
        this.currentState = msg.state;
        this.emit("state", msg.state);
        break;
      case MessageType.Conflict:
        this.emit("conflict", msg);
        break;
      case MessageType.Chat:
        this.emit("chat", msg);
        break;
      case MessageType.Error:
        this.emit("error", msg);
        break;
      case MessageType.Ack:
        this.emit("ack", msg);
        break;
    }
  }

  private send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(createMessage(msg));
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 5_000);
  }
}

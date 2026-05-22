import { describe, it, expect, beforeEach, afterEach } from "vitest";
import WebSocket from "ws";
import { RelayServer } from "../server.js";
import {
  MessageType,
  createMessage,
  parseMessage,
  type RegisterMessage,
  type FileClaimMessage,
  type FileReleaseMessage,
  type SendChatMessage,
  type HeartbeatMessage,
  type ServerMessage,
  type ServerStateMessage,
  type ServerConflictMessage,
  type ServerChatMessage,
} from "@agent-town/shared";

const TEST_PORT = 9787;

function connectAgent(
  agentId: string,
  userName: string,
  teamKey: string
): Promise<{ ws: WebSocket; messages: ServerMessage[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);
    const messages: ServerMessage[] = [];

    ws.on("open", () => {
      const register: RegisterMessage = {
        type: MessageType.Register,
        agentId,
        userName,
        machineId: "test-machine",
        teamKey,
      };
      ws.send(createMessage(register));
    });

    ws.on("message", (data) => {
      const msg = parseMessage(data.toString()) as ServerMessage;
      messages.push(msg);

      // Resolve after receiving the initial state broadcast
      if (msg.type === MessageType.State) {
        resolve({ ws, messages });
      }
    });

    ws.on("error", reject);
  });
}

function waitForStateWith(
  ws: WebSocket,
  predicate: (msg: ServerStateMessage) => boolean,
  timeout = 2000
): Promise<ServerStateMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timeout waiting for matching state")), timeout);
    const handler = (data: WebSocket.Data) => {
      const msg = parseMessage(data.toString()) as ServerMessage;
      if (msg.type === MessageType.State && predicate(msg as ServerStateMessage)) {
        clearTimeout(timer);
        ws.off("message", handler);
        resolve(msg as ServerStateMessage);
      }
    };
    ws.on("message", handler);
  });
}

function waitForMessage(
  ws: WebSocket,
  type: MessageType,
  timeout = 2000
): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeout);

    const handler = (data: WebSocket.Data) => {
      const msg = parseMessage(data.toString()) as ServerMessage;
      if (msg.type === type) {
        clearTimeout(timer);
        ws.off("message", handler);
        resolve(msg);
      }
    };

    ws.on("message", handler);
  });
}

describe("RelayServer", () => {
  let server: RelayServer;

  beforeEach(() => {
    server = new RelayServer({ port: TEST_PORT, heartbeatTimeout: 5000, lockTtl: 10000 });
    server.start();
  });

  afterEach(() => {
    server.stop();
  });

  it("should accept agent registration", async () => {
    const { ws, messages } = await connectAgent("agent-1", "alice", "team-1");

    // Should have received an ack and state
    const ack = messages.find((m) => m.type === MessageType.Ack);
    expect(ack).toBeDefined();

    const state = messages.find((m) => m.type === MessageType.State) as ServerStateMessage;
    expect(state).toBeDefined();
    expect(state.state.agents).toHaveLength(1);
    expect(state.state.agents[0].userName).toBe("alice");

    ws.close();
  });

  it("should broadcast state when agents join", async () => {
    const { ws: ws1 } = await connectAgent("agent-1", "alice", "team-1");

    // When agent 2 joins, agent 1 should get a state update
    const statePromise = waitForMessage(ws1, MessageType.State);
    const { ws: ws2 } = await connectAgent("agent-2", "bob", "team-1");

    const state = (await statePromise) as ServerStateMessage;
    expect(state.state.agents).toHaveLength(2);

    ws1.close();
    ws2.close();
  });

  it("should handle file claims and conflicts", async () => {
    const { ws: ws1 } = await connectAgent("agent-1", "alice", "team-1");
    const { ws: ws2 } = await connectAgent("agent-2", "bob", "team-1");

    // Drain any pending state messages from agent-2 joining
    await waitForMessage(ws1, MessageType.State).catch(() => {});

    // Alice claims a file
    const claim1: FileClaimMessage = {
      type: MessageType.FileClaim,
      agentId: "agent-1",
      path: "src/index.ts",
    };

    const statePromise = waitForStateWith(ws1, (s) => s.state.locks.length > 0);
    ws1.send(createMessage(claim1));

    const stateAfterClaim = await statePromise;
    expect(stateAfterClaim.state.locks).toHaveLength(1);
    expect(stateAfterClaim.state.locks[0].path).toBe("src/index.ts");
    expect(stateAfterClaim.state.locks[0].userName).toBe("alice");

    // Bob tries to claim the same file — should get conflict
    const conflictPromise = waitForMessage(ws2, MessageType.Conflict);
    const claim2: FileClaimMessage = {
      type: MessageType.FileClaim,
      agentId: "agent-2",
      path: "src/index.ts",
    };
    ws2.send(createMessage(claim2));

    const conflict = (await conflictPromise) as ServerConflictMessage;
    expect(conflict.path).toBe("src/index.ts");
    expect(conflict.claimedBy.userName).toBe("alice");
    expect(conflict.requestedBy.userName).toBe("bob");

    ws1.close();
    ws2.close();
  });

  it("should handle file release", async () => {
    const { ws: ws1 } = await connectAgent("agent-1", "alice", "team-1");

    // Claim then release
    ws1.send(
      createMessage<FileClaimMessage>({
        type: MessageType.FileClaim,
        agentId: "agent-1",
        path: "src/index.ts",
      })
    );
    await waitForMessage(ws1, MessageType.State);

    ws1.send(
      createMessage<FileReleaseMessage>({
        type: MessageType.FileRelease,
        agentId: "agent-1",
        path: "src/index.ts",
      })
    );

    const state = (await waitForMessage(ws1, MessageType.State)) as ServerStateMessage;
    expect(state.state.locks).toHaveLength(0);
    expect(state.state.agents[0].activeFiles).toHaveLength(0);

    ws1.close();
  });

  it("should broadcast chat messages", async () => {
    const { ws: ws1 } = await connectAgent("agent-1", "alice", "team-1");
    const { ws: ws2 } = await connectAgent("agent-2", "bob", "team-1");

    const chatPromise = waitForMessage(ws2, MessageType.Chat);

    ws1.send(
      createMessage<SendChatMessage>({
        type: MessageType.SendChat,
        agentId: "agent-1",
        message: "Hey Bob, I'm working on the auth module",
      })
    );

    const chat = (await chatPromise) as ServerChatMessage;
    expect(chat.from.userName).toBe("alice");
    expect(chat.message).toBe("Hey Bob, I'm working on the auth module");

    ws1.close();
    ws2.close();
  });

  it("should clean up locks on disconnect", async () => {
    const { ws: ws1 } = await connectAgent("agent-1", "alice", "team-1");
    const { ws: ws2 } = await connectAgent("agent-2", "bob", "team-1");

    // Alice claims a file
    ws1.send(
      createMessage<FileClaimMessage>({
        type: MessageType.FileClaim,
        agentId: "agent-1",
        path: "src/index.ts",
      })
    );
    await waitForMessage(ws2, MessageType.State);

    // Alice disconnects — Bob should see updated state with no locks
    const statePromise = waitForMessage(ws2, MessageType.State);
    ws1.close();

    const state = (await statePromise) as ServerStateMessage;
    expect(state.state.locks).toHaveLength(0);
    expect(state.state.agents).toHaveLength(1);
    expect(state.state.agents[0].userName).toBe("bob");

    ws2.close();
  });

  it("should isolate teams", async () => {
    const { ws: ws1, messages: msgs1 } = await connectAgent("agent-1", "alice", "team-1");
    const { ws: ws2, messages: msgs2 } = await connectAgent("agent-2", "bob", "team-2");

    // Alice should only see herself
    const aliceState = msgs1.find((m) => m.type === MessageType.State) as ServerStateMessage;
    expect(aliceState.state.agents).toHaveLength(1);
    expect(aliceState.state.agents[0].userName).toBe("alice");

    // Bob should only see himself
    const bobState = msgs2.find((m) => m.type === MessageType.State) as ServerStateMessage;
    expect(bobState.state.agents).toHaveLength(1);
    expect(bobState.state.agents[0].userName).toBe("bob");

    ws1.close();
    ws2.close();
  });

  it("should handle heartbeat", async () => {
    const { ws: ws1 } = await connectAgent("agent-1", "alice", "team-1");

    // Send heartbeat — should not error
    ws1.send(
      createMessage<HeartbeatMessage>({
        type: MessageType.Heartbeat,
        agentId: "agent-1",
      })
    );

    // Small wait to make sure server processes it
    await new Promise((r) => setTimeout(r, 100));

    ws1.close();
  });

  it("should provide health endpoint", async () => {
    const response = await fetch(`http://localhost:${TEST_PORT}/health`);
    const data = await response.json();
    expect(data.status).toBe("ok");
    expect(typeof data.agents).toBe("number");
  });
});

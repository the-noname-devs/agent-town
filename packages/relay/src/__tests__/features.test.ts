import { describe, it, expect, beforeEach, afterEach } from "vitest";
import WebSocket from "ws";
import { RelayServer } from "../server.js";
import {
  MessageType,
  createMessage,
  parseMessage,
  type RegisterMessage,
  type HeartbeatMessage,
  type FileClaimMessage,
  type FileChangeMessage,
  type SendChatMessage,
  type ZoneClaimMessage,
  type ZoneReleaseMessage,
  type ServerMessage,
  type ServerStateMessage,
  type ServerConflictMessage,
} from "@agent-town/shared";

const TEST_PORT = 9789;

function connectAgent(
  agentId: string,
  userName: string,
  teamKey: string,
  branch?: string
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
        branch,
      };
      ws.send(createMessage(register));
    });

    ws.on("message", (data) => {
      const msg = parseMessage(data.toString()) as ServerMessage;
      messages.push(msg);

      if (msg.type === MessageType.State) {
        resolve({ ws, messages });
      }
    });

    ws.on("error", reject);
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

describe("Branch Awareness", () => {
  let server: RelayServer;

  beforeEach(() => {
    server = new RelayServer({ port: TEST_PORT });
    server.start();
  });

  afterEach(() => {
    server.stop();
  });

  it("should include branch in agent info on register", async () => {
    const { ws, messages } = await connectAgent("agent-1", "alice", "team-1", "feat/auth");

    const state = messages.find((m) => m.type === MessageType.State) as ServerStateMessage;
    expect(state.state.agents[0].branch).toBe("feat/auth");

    ws.close();
  });

  it("should register without branch", async () => {
    const { ws, messages } = await connectAgent("agent-1", "alice", "team-1");

    const state = messages.find((m) => m.type === MessageType.State) as ServerStateMessage;
    expect(state.state.agents[0].branch).toBeUndefined();

    ws.close();
  });

  it("should update branch via heartbeat", async () => {
    const { ws } = await connectAgent("agent-1", "alice", "team-1", "main");

    const statePromise = waitForStateWith(ws, (s) => s.state.agents[0]?.branch === "feat/new");

    ws.send(
      createMessage<HeartbeatMessage>({
        type: MessageType.Heartbeat,
        agentId: "agent-1",
        branch: "feat/new",
      })
    );

    const state = await statePromise;
    expect(state.state.agents[0].branch).toBe("feat/new");

    ws.close();
  });

  it("should show branches for multiple agents", async () => {
    const { ws: ws1 } = await connectAgent("agent-1", "alice", "team-1", "main");
    const statePromise = waitForStateWith(ws1, (s) => s.state.agents.length === 2);
    const { ws: ws2 } = await connectAgent("agent-2", "bob", "team-1", "feat/api");

    const state = await statePromise;
    const alice = state.state.agents.find((a) => a.userName === "alice");
    const bob = state.state.agents.find((a) => a.userName === "bob");
    expect(alice?.branch).toBe("main");
    expect(bob?.branch).toBe("feat/api");

    ws1.close();
    ws2.close();
  });
});

describe("Activity Feed", () => {
  let server: RelayServer;

  beforeEach(() => {
    server = new RelayServer({ port: TEST_PORT, maxActivities: 10 });
    server.start();
  });

  afterEach(() => {
    server.stop();
  });

  it("should track file claim activities", async () => {
    const { ws } = await connectAgent("agent-1", "alice", "team-1");

    ws.send(
      createMessage<FileClaimMessage>({
        type: MessageType.FileClaim,
        agentId: "agent-1",
        path: "src/index.ts",
      })
    );

    const state = (await waitForMessage(ws, MessageType.State)) as ServerStateMessage;
    expect(state.state.activities.length).toBeGreaterThan(0);

    const claimActivity = state.state.activities.find(
      (a) => a.action === "claim" && a.path === "src/index.ts"
    );
    expect(claimActivity).toBeDefined();
    expect(claimActivity!.userName).toBe("alice");

    ws.close();
  });

  it("should track file change activities", async () => {
    const { ws } = await connectAgent("agent-1", "alice", "team-1");

    ws.send(
      createMessage<FileChangeMessage>({
        type: MessageType.FileChange,
        agentId: "agent-1",
        path: "src/app.ts",
        action: "edit",
      })
    );

    const state = (await waitForMessage(ws, MessageType.State)) as ServerStateMessage;
    const editActivity = state.state.activities.find(
      (a) => a.action === "edit" && a.path === "src/app.ts"
    );
    expect(editActivity).toBeDefined();
    expect(editActivity!.userName).toBe("alice");

    ws.close();
  });

  it("should limit activity entries to maxActivities", async () => {
    const { ws } = await connectAgent("agent-1", "alice", "team-1");

    // Generate 15 changes (max is 10)
    for (let i = 0; i < 15; i++) {
      ws.send(
        createMessage<FileChangeMessage>({
          type: MessageType.FileChange,
          agentId: "agent-1",
          path: `src/file-${i}.ts`,
          action: "edit",
        })
      );
    }

    // Wait for the last state update to settle
    let lastState: ServerStateMessage | null = null;
    await new Promise<void>((resolve) => {
      const handler = (data: WebSocket.Data) => {
        const msg = parseMessage(data.toString()) as ServerMessage;
        if (msg.type === MessageType.State) {
          lastState = msg as ServerStateMessage;
        }
      };
      ws.on("message", handler);
      setTimeout(() => {
        ws.off("message", handler);
        resolve();
      }, 500);
    });

    expect(lastState).not.toBeNull();
    // maxActivities is 10, each FileChange also triggers a claim, but the server caps the list
    expect(lastState!.state.activities.length).toBeLessThanOrEqual(10);

    ws.close();
  });

  it("should show activities from multiple agents", async () => {
    const { ws: ws1 } = await connectAgent("agent-1", "alice", "team-1");
    const { ws: ws2 } = await connectAgent("agent-2", "bob", "team-1");

    // Wait for the state update from agent 2 joining
    await waitForMessage(ws1, MessageType.State).catch(() => {});

    ws1.send(
      createMessage<FileClaimMessage>({
        type: MessageType.FileClaim,
        agentId: "agent-1",
        path: "src/auth.ts",
      })
    );
    await waitForMessage(ws1, MessageType.State);

    ws2.send(
      createMessage<FileClaimMessage>({
        type: MessageType.FileClaim,
        agentId: "agent-2",
        path: "src/api.ts",
      })
    );

    // Wait for state that contains activities from both agents
    const state = await waitForStateWith(ws2, (s) => {
      const hasAlice = s.state.activities.some((a) => a.userName === "alice");
      const hasBob = s.state.activities.some((a) => a.userName === "bob");
      return hasAlice && hasBob;
    });

    expect(state.state.activities.find((a) => a.userName === "alice")).toBeDefined();
    expect(state.state.activities.find((a) => a.userName === "bob")).toBeDefined();

    ws1.close();
    ws2.close();
  });
});

describe("Protected Zones", () => {
  let server: RelayServer;

  beforeEach(() => {
    server = new RelayServer({ port: TEST_PORT });
    server.start();
  });

  afterEach(() => {
    server.stop();
  });

  it("should claim a zone", async () => {
    const { ws } = await connectAgent("agent-1", "alice", "team-1");

    ws.send(
      createMessage<ZoneClaimMessage>({
        type: MessageType.ZoneClaim,
        agentId: "agent-1",
        pattern: "src/api/**",
        reason: "refactoring API layer",
      })
    );

    const state = (await waitForMessage(ws, MessageType.State)) as ServerStateMessage;
    expect(state.state.zones).toHaveLength(1);
    expect(state.state.zones[0].pattern).toBe("src/api/**");
    expect(state.state.zones[0].userName).toBe("alice");
    expect(state.state.zones[0].reason).toBe("refactoring API layer");

    ws.close();
  });

  it("should release a zone", async () => {
    const { ws } = await connectAgent("agent-1", "alice", "team-1");

    ws.send(
      createMessage<ZoneClaimMessage>({
        type: MessageType.ZoneClaim,
        agentId: "agent-1",
        pattern: "src/api/**",
      })
    );
    await waitForMessage(ws, MessageType.State);

    ws.send(
      createMessage<ZoneReleaseMessage>({
        type: MessageType.ZoneRelease,
        agentId: "agent-1",
        pattern: "src/api/**",
      })
    );

    const state = (await waitForMessage(ws, MessageType.State)) as ServerStateMessage;
    expect(state.state.zones).toHaveLength(0);

    ws.close();
  });

  it("should warn when claiming a file inside a protected zone", async () => {
    const { ws: ws1 } = await connectAgent("agent-1", "alice", "team-1");
    const { ws: ws2 } = await connectAgent("agent-2", "bob", "team-1");

    // Alice protects src/api/
    ws1.send(
      createMessage<ZoneClaimMessage>({
        type: MessageType.ZoneClaim,
        agentId: "agent-1",
        pattern: "src/api/**",
      })
    );
    await waitForMessage(ws2, MessageType.State);

    // Bob tries to claim a file inside the zone
    const conflictPromise = waitForMessage(ws2, MessageType.Conflict);
    ws2.send(
      createMessage<FileClaimMessage>({
        type: MessageType.FileClaim,
        agentId: "agent-2",
        path: "src/api/routes.ts",
      })
    );

    const conflict = (await conflictPromise) as ServerConflictMessage;
    expect(conflict.path).toBe("src/api/routes.ts");
    expect(conflict.claimedBy.userName).toBe("alice");
    expect(conflict.zone).toBe("src/api/**");

    ws1.close();
    ws2.close();
  });

  it("should not warn when zone owner edits inside their own zone", async () => {
    const { ws } = await connectAgent("agent-1", "alice", "team-1");

    ws.send(
      createMessage<ZoneClaimMessage>({
        type: MessageType.ZoneClaim,
        agentId: "agent-1",
        pattern: "src/api/**",
      })
    );
    await waitForMessage(ws, MessageType.State);

    // Alice claims a file inside her own zone — should NOT get a conflict
    ws.send(
      createMessage<FileClaimMessage>({
        type: MessageType.FileClaim,
        agentId: "agent-1",
        path: "src/api/routes.ts",
      })
    );

    const state = (await waitForMessage(ws, MessageType.State)) as ServerStateMessage;
    expect(state.state.locks).toHaveLength(1);
    expect(state.state.locks[0].path).toBe("src/api/routes.ts");

    ws.close();
  });

  it("should clean up zones on disconnect", async () => {
    const { ws: ws1 } = await connectAgent("agent-1", "alice", "team-1");
    const { ws: ws2 } = await connectAgent("agent-2", "bob", "team-1");

    ws1.send(
      createMessage<ZoneClaimMessage>({
        type: MessageType.ZoneClaim,
        agentId: "agent-1",
        pattern: "src/auth/**",
      })
    );
    await waitForMessage(ws2, MessageType.State);

    const statePromise = waitForStateWith(ws2, (s) => s.state.zones.length === 0);
    ws1.close();

    const state = await statePromise;
    expect(state.state.zones).toHaveLength(0);

    ws2.close();
  });

  it("should isolate zones between teams", async () => {
    const { ws: ws1, messages: msgs1 } = await connectAgent("agent-1", "alice", "team-1");
    const { ws: ws2, messages: msgs2 } = await connectAgent("agent-2", "bob", "team-2");

    ws1.send(
      createMessage<ZoneClaimMessage>({
        type: MessageType.ZoneClaim,
        agentId: "agent-1",
        pattern: "src/**",
      })
    );
    const state1 = (await waitForMessage(ws1, MessageType.State)) as ServerStateMessage;
    expect(state1.state.zones).toHaveLength(1);

    // Bob on team-2 should not see Alice's zone
    ws2.send(
      createMessage<FileClaimMessage>({
        type: MessageType.FileClaim,
        agentId: "agent-2",
        path: "src/index.ts",
      })
    );
    const state2 = (await waitForMessage(ws2, MessageType.State)) as ServerStateMessage;
    expect(state2.state.zones).toHaveLength(0);

    ws1.close();
    ws2.close();
  });

  it("should match zone patterns with directory prefix", async () => {
    const { ws: ws1 } = await connectAgent("agent-1", "alice", "team-1");
    const { ws: ws2 } = await connectAgent("agent-2", "bob", "team-1");

    // Alice protects "src/api/" (directory prefix)
    ws1.send(
      createMessage<ZoneClaimMessage>({
        type: MessageType.ZoneClaim,
        agentId: "agent-1",
        pattern: "src/api/",
      })
    );
    await waitForMessage(ws2, MessageType.State);

    // Bob edits a file inside — should conflict
    const conflictPromise = waitForMessage(ws2, MessageType.Conflict);
    ws2.send(
      createMessage<FileClaimMessage>({
        type: MessageType.FileClaim,
        agentId: "agent-2",
        path: "src/api/users.ts",
      })
    );

    const conflict = (await conflictPromise) as ServerConflictMessage;
    expect(conflict.zone).toBe("src/api/");

    // Bob edits a file outside — should NOT conflict
    ws2.send(
      createMessage<FileClaimMessage>({
        type: MessageType.FileClaim,
        agentId: "agent-2",
        path: "src/utils/helpers.ts",
      })
    );

    const state = await waitForStateWith(ws2, (s) =>
      s.state.locks.some((l) => l.path === "src/utils/helpers.ts")
    );
    expect(state.state.locks.some((l) => l.path === "src/utils/helpers.ts")).toBe(true);

    ws1.close();
    ws2.close();
  });
});

describe("Auto-Conflict Prevention", () => {
  let server: RelayServer;

  beforeEach(() => {
    server = new RelayServer({ port: TEST_PORT });
    server.start();
  });

  afterEach(() => {
    server.stop();
  });

  it("should send conflict when file change triggers auto-claim on locked file", async () => {
    const { ws: ws1 } = await connectAgent("agent-1", "alice", "team-1");
    const { ws: ws2 } = await connectAgent("agent-2", "bob", "team-1");

    // Alice claims a file
    ws1.send(
      createMessage<FileClaimMessage>({
        type: MessageType.FileClaim,
        agentId: "agent-1",
        path: "src/shared.ts",
      })
    );
    await waitForMessage(ws1, MessageType.State);

    // Bob makes a file change (auto-claim) on the same file
    const conflictPromise = waitForMessage(ws2, MessageType.Conflict);
    ws2.send(
      createMessage<FileChangeMessage>({
        type: MessageType.FileChange,
        agentId: "agent-2",
        path: "src/shared.ts",
        action: "edit",
      })
    );

    const conflict = (await conflictPromise) as ServerConflictMessage;
    expect(conflict.claimedBy.userName).toBe("alice");
    expect(conflict.requestedBy.userName).toBe("bob");

    ws1.close();
    ws2.close();
  });

  it("should send zone conflict on file change inside protected zone", async () => {
    const { ws: ws1 } = await connectAgent("agent-1", "alice", "team-1");
    const { ws: ws2 } = await connectAgent("agent-2", "bob", "team-1");

    // Alice protects the auth directory
    ws1.send(
      createMessage<ZoneClaimMessage>({
        type: MessageType.ZoneClaim,
        agentId: "agent-1",
        pattern: "src/auth/**",
      })
    );
    await waitForMessage(ws2, MessageType.State);

    // Bob makes a change inside the zone
    const conflictPromise = waitForMessage(ws2, MessageType.Conflict);
    ws2.send(
      createMessage<FileChangeMessage>({
        type: MessageType.FileChange,
        agentId: "agent-2",
        path: "src/auth/login.ts",
        action: "write",
      })
    );

    const conflict = (await conflictPromise) as ServerConflictMessage;
    expect(conflict.zone).toBe("src/auth/**");
    expect(conflict.claimedBy.userName).toBe("alice");

    ws1.close();
    ws2.close();
  });
});

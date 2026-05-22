import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { RelayServer } from "../../../relay/src/server.js";
import { RelayClient } from "../relay-client.js";
import type { BridgeConfig, TeamState, ServerConflictMessage } from "@agent-town/shared";

const TEST_PORT = 9790;

function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    relayUrl: `ws://localhost:${TEST_PORT}`,
    teamKey: "team-test",
    userName: "tester",
    agentId: "agent-test-1",
    machineId: "machine-test",
    heartbeatInterval: 60_000,
    ...overrides,
  };
}

function waitForEvent(emitter: RelayClient, event: string, timeout = 3000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${event}`)), timeout);
    emitter.once(event, (data: unknown) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

describe("RelayClient - Branch Awareness", () => {
  let server: RelayServer;

  beforeEach(() => {
    server = new RelayServer({ port: TEST_PORT });
    server.start();
  });

  afterEach(() => {
    server.stop();
  });

  it("should send branch on connect", async () => {
    const client = new RelayClient(makeConfig());
    client.setBranch("feat/auth");

    client.connect();
    const state = (await waitForEvent(client, "state")) as TeamState;

    expect(state.agents[0].branch).toBe("feat/auth");

    client.disconnect();
  });

  it("should work without branch set", async () => {
    const client = new RelayClient(makeConfig());

    client.connect();
    const state = (await waitForEvent(client, "state")) as TeamState;

    expect(state.agents[0].branch).toBeUndefined();

    client.disconnect();
  });

  it("should show branches for two clients", async () => {
    const client1 = new RelayClient(makeConfig({ agentId: "agent-a", userName: "alice" }));
    const client2 = new RelayClient(makeConfig({ agentId: "agent-b", userName: "bob" }));

    client1.setBranch("main");
    client2.setBranch("feat/api");

    client1.connect();
    await waitForEvent(client1, "state");

    client2.connect();
    // Wait for state with both agents
    const state = await new Promise<TeamState>((resolve) => {
      const handler = (s: unknown) => {
        const teamState = s as TeamState;
        if (teamState.agents.length === 2) {
          client1.off("state", handler);
          resolve(teamState);
        }
      };
      client1.on("state", handler);
    });

    const alice = state.agents.find((a) => a.userName === "alice");
    const bob = state.agents.find((a) => a.userName === "bob");
    expect(alice?.branch).toBe("main");
    expect(bob?.branch).toBe("feat/api");

    client1.disconnect();
    client2.disconnect();
  });
});

describe("RelayClient - Protected Zones", () => {
  let server: RelayServer;

  beforeEach(() => {
    server = new RelayServer({ port: TEST_PORT });
    server.start();
  });

  afterEach(() => {
    server.stop();
  });

  it("should claim and release zones", async () => {
    const client = new RelayClient(makeConfig());

    client.connect();
    await waitForEvent(client, "state");

    client.claimZone("src/api/**", "refactoring");
    const state = (await waitForEvent(client, "state")) as TeamState;

    expect(state.zones).toHaveLength(1);
    expect(state.zones[0].pattern).toBe("src/api/**");
    expect(state.zones[0].reason).toBe("refactoring");

    client.releaseZone("src/api/**");
    const state2 = (await waitForEvent(client, "state")) as TeamState;
    expect(state2.zones).toHaveLength(0);

    client.disconnect();
  });

  it("should receive conflict when editing in another agent's zone", async () => {
    const client1 = new RelayClient(makeConfig({ agentId: "agent-a", userName: "alice" }));
    const client2 = new RelayClient(makeConfig({ agentId: "agent-b", userName: "bob" }));

    client1.connect();
    await waitForEvent(client1, "state");

    client2.connect();
    await waitForEvent(client2, "state");

    // Alice protects a zone
    client1.claimZone("src/auth/**");
    await waitForEvent(client1, "state");

    // Bob claims a file inside
    const conflictPromise = waitForEvent(client2, "conflict");
    client2.claimFile("src/auth/login.ts");

    const conflict = (await conflictPromise) as ServerConflictMessage;
    expect(conflict.zone).toBe("src/auth/**");
    expect(conflict.claimedBy.userName).toBe("alice");

    client1.disconnect();
    client2.disconnect();
  });
});

describe("RelayClient - Activity Feed", () => {
  let server: RelayServer;

  beforeEach(() => {
    server = new RelayServer({ port: TEST_PORT });
    server.start();
  });

  afterEach(() => {
    server.stop();
  });

  it("should include activities in state", async () => {
    const client = new RelayClient(makeConfig());

    client.connect();
    await waitForEvent(client, "state");

    client.claimFile("src/index.ts");
    const state = (await waitForEvent(client, "state")) as TeamState;

    expect(state.activities.length).toBeGreaterThan(0);
    expect(state.activities.some((a) => a.path === "src/index.ts")).toBe(true);

    client.disconnect();
  });

  it("should track file change activities", async () => {
    const client = new RelayClient(makeConfig());

    client.connect();
    await waitForEvent(client, "state");

    client.reportFileChange("src/app.ts", "edit");
    const state = (await waitForEvent(client, "state")) as TeamState;

    const editActivity = state.activities.find(
      (a) => a.action === "edit" && a.path === "src/app.ts"
    );
    expect(editActivity).toBeDefined();

    client.disconnect();
  });

  it("should have activities from multiple agents", async () => {
    const client1 = new RelayClient(makeConfig({ agentId: "agent-a", userName: "alice" }));
    const client2 = new RelayClient(makeConfig({ agentId: "agent-b", userName: "bob" }));

    client1.connect();
    await waitForEvent(client1, "state");

    client2.connect();
    await waitForEvent(client2, "state");
    // Drain the state update that client1 gets when client2 joins
    await waitForEvent(client1, "state").catch(() => {});

    client1.claimFile("src/auth.ts");
    await waitForEvent(client1, "state");

    client2.claimFile("src/api.ts");
    // Wait for the state that contains both activities (bob gets a broadcast with full state)
    const state = await new Promise<TeamState>((resolve) => {
      const handler = (s: unknown) => {
        const teamState = s as TeamState;
        const hasAlice = teamState.activities.some((a) => a.userName === "alice");
        const hasBob = teamState.activities.some((a) => a.userName === "bob");
        if (hasAlice && hasBob) {
          client2.off("state", handler);
          resolve(teamState);
        }
      };
      client2.on("state", handler);
    });

    expect(state.activities.find((a) => a.userName === "alice")).toBeDefined();
    expect(state.activities.find((a) => a.userName === "bob")).toBeDefined();

    client1.disconnect();
    client2.disconnect();
  });
});

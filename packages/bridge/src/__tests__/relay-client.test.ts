import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { RelayServer } from "../../../relay/src/server.js";
import { RelayClient } from "../relay-client.js";
import type { BridgeConfig, TeamState } from "@agent-town/shared";

const TEST_PORT = 9788;

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

describe("RelayClient", () => {
  let server: RelayServer;

  beforeEach(() => {
    server = new RelayServer({ port: TEST_PORT });
    server.start();
  });

  afterEach(() => {
    server.stop();
  });

  it("should connect and receive state", async () => {
    const client = new RelayClient(makeConfig());
    const statePromise = waitForEvent(client, "state");

    client.connect();
    const state = (await statePromise) as TeamState;

    expect(state.agents).toHaveLength(1);
    expect(state.agents[0].userName).toBe("tester");
    expect(client.isConnected()).toBe(true);

    client.disconnect();
  });

  it("should claim and release files", async () => {
    const client = new RelayClient(makeConfig());
    const connectedPromise = waitForEvent(client, "state");
    client.connect();
    await connectedPromise;

    client.claimFile("src/app.ts");
    const state = (await waitForEvent(client, "state")) as TeamState;

    expect(state.locks).toHaveLength(1);
    expect(state.locks[0].path).toBe("src/app.ts");

    client.releaseFile("src/app.ts");
    const state2 = (await waitForEvent(client, "state")) as TeamState;
    expect(state2.locks).toHaveLength(0);

    client.disconnect();
  });

  it("should detect conflicts between two clients", async () => {
    const client1 = new RelayClient(makeConfig({ agentId: "agent-a", userName: "alice" }));
    const client2 = new RelayClient(makeConfig({ agentId: "agent-b", userName: "bob" }));

    client1.connect();
    await waitForEvent(client1, "state");

    client2.connect();
    await waitForEvent(client2, "state");

    // Alice claims file
    client1.claimFile("shared.ts");
    await waitForEvent(client1, "state");

    // Bob claims same file — should trigger conflict
    const conflictPromise = waitForEvent(client2, "conflict");
    client2.claimFile("shared.ts");
    const conflict = await conflictPromise;

    expect(conflict).toBeDefined();

    client1.disconnect();
    client2.disconnect();
  });

  it("should send and receive chat messages", async () => {
    const client1 = new RelayClient(makeConfig({ agentId: "agent-a", userName: "alice" }));
    const client2 = new RelayClient(makeConfig({ agentId: "agent-b", userName: "bob" }));

    client1.connect();
    await waitForEvent(client1, "state");

    client2.connect();
    await waitForEvent(client2, "state");

    const chatPromise = waitForEvent(client2, "chat");
    client1.sendChat("Hello Bob!");

    const chat = (await chatPromise) as { from: { userName: string }; message: string };
    expect(chat.from.userName).toBe("alice");
    expect(chat.message).toBe("Hello Bob!");

    client1.disconnect();
    client2.disconnect();
  });

  it("should report state via getState()", async () => {
    const client = new RelayClient(makeConfig());
    client.connect();
    await waitForEvent(client, "state");

    const state = client.getState();
    expect(state.agents.length).toBeGreaterThanOrEqual(1);

    client.disconnect();
  });
});

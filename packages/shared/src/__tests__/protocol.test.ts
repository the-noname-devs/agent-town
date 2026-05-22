import { describe, it, expect } from "vitest";
import { createMessage, parseMessage, MessageType } from "../index.js";
import type { RegisterMessage, ServerStateMessage } from "../index.js";

describe("protocol", () => {
  it("should serialize and deserialize a client message", () => {
    const msg: RegisterMessage = {
      type: MessageType.Register,
      agentId: "agent-abc123",
      userName: "alice",
      machineId: "machine-1",
      teamKey: "team-xyz",
    };

    const serialized = createMessage(msg);
    expect(typeof serialized).toBe("string");

    const deserialized = parseMessage(serialized);
    expect(deserialized).toEqual(msg);
  });

  it("should serialize and deserialize a server message", () => {
    const msg: ServerStateMessage = {
      type: MessageType.State,
      state: {
        agents: [
          {
            agentId: "agent-1",
            userName: "alice",
            machineId: "m1",
            status: "online" as const,
            connectedAt: 1000,
            lastHeartbeat: 2000,
            activeFiles: ["src/index.ts"],
          },
        ],
        locks: [],
      },
    };

    const serialized = createMessage(msg);
    const deserialized = parseMessage(serialized);
    expect(deserialized).toEqual(msg);
  });

  it("should throw on invalid message", () => {
    expect(() => parseMessage("not json")).toThrow();
    expect(() => parseMessage("{}")).toThrow("missing type field");
    expect(() => parseMessage("null")).toThrow();
  });
});

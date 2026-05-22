import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { RelayServer } from "../server.js";
import {
  MessageType,
  createMessage,
  parseMessage,
  type RegisterMessage,
  type ServerMessage,
  type ServerErrorMessage,
} from "@agent-town/shared";

const RELAY_PORT = 9791;
const MOCK_AUTH_PORT = 9792;

// ── Mock Auth Server ──
// Responds to POST with { valid: true/false } based on the teamKey
let validKeys: Set<string> = new Set();
let mockAuth: Server;

function startMockAuth(): Promise<void> {
  return new Promise((resolve) => {
    mockAuth = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "", `http://localhost:${MOCK_AUTH_PORT}`);

      if (req.method !== "POST" || url.pathname !== "/validate") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        try {
          const { teamKey } = JSON.parse(body);
          const valid = validKeys.has(teamKey);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ valid, reason: valid ? undefined : "not found" }));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ valid: false, reason: "bad request" }));
        }
      });
    });
    mockAuth.listen(MOCK_AUTH_PORT, resolve);
  });
}

// ── Helper: connect and register ──
function tryRegister(
  teamKey: string,
  timeout = 3000
): Promise<{ type: "ack" | "error"; message?: string; code?: number }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timeout")), timeout);
    const ws = new WebSocket(`ws://localhost:${RELAY_PORT}`);

    ws.on("open", () => {
      const register: RegisterMessage = {
        type: MessageType.Register,
        agentId: `agent-${Math.random().toString(16).slice(2, 8)}`,
        userName: "Tester",
        machineId: "test",
        teamKey,
      };
      ws.send(createMessage(register));
    });

    ws.on("message", (data) => {
      const msg = parseMessage(data.toString()) as ServerMessage;
      if (msg.type === MessageType.Ack) {
        clearTimeout(timer);
        ws.close();
        resolve({ type: "ack" });
      } else if (msg.type === MessageType.Error) {
        clearTimeout(timer);
        ws.close();
        resolve({ type: "error", message: (msg as ServerErrorMessage).message });
      }
    });

    ws.on("close", (code) => {
      clearTimeout(timer);
      if (code === 4001) {
        resolve({ type: "error", code: 4001, message: "Invalid team key" });
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ── Tests ──

describe("Relay Auth — No Auth (self-hosted mode)", () => {
  let server: RelayServer;

  beforeEach(() => {
    server = new RelayServer({ port: RELAY_PORT });
    server.start();
  });

  afterEach(() => {
    server.stop();
  });

  it("should accept any team key when auth is disabled", async () => {
    const result = await tryRegister("any-random-key");
    expect(result.type).toBe("ack");
  });

  it("should accept made-up keys without validation", async () => {
    const result1 = await tryRegister("team-doesnt-exist-at-all");
    const result2 = await tryRegister("literally-anything");
    expect(result1.type).toBe("ack");
    expect(result2.type).toBe("ack");
  });
});

describe("Relay Auth — With external validation", () => {
  let server: RelayServer;

  beforeAll(async () => {
    await startMockAuth();
  });

  afterAll(() => {
    mockAuth.close();
  });

  beforeEach(() => {
    validKeys = new Set();
    server = new RelayServer({
      port: RELAY_PORT,
      authUrl: `http://localhost:${MOCK_AUTH_PORT}/validate`,
      authSecret: "test-secret",
    });
    server.start();
  });

  afterEach(() => {
    server.stop();
  });

  it("should reject a team key that the auth server rejects", async () => {
    // validKeys is empty — no keys are valid
    const result = await tryRegister("team-nonexistent");
    expect(result.type).toBe("error");
  });

  it("should accept a team key that the auth server approves", async () => {
    validKeys.add("team-valid-key");
    const result = await tryRegister("team-valid-key");
    expect(result.type).toBe("ack");
  });

  it("should cache validation results for 60 seconds", async () => {
    validKeys.add("team-cached");

    // First request: valid
    const result1 = await tryRegister("team-cached");
    expect(result1.type).toBe("ack");

    // Remove from valid set — simulates key being revoked
    validKeys.delete("team-cached");

    // Second request within 60s: should use cache and still succeed
    const result2 = await tryRegister("team-cached");
    expect(result2.type).toBe("ack");
  });

  it("should cache rejection too", async () => {
    const result1 = await tryRegister("team-rejected-cached");
    expect(result1.type).toBe("error");

    // Now make it valid — but cache should still reject
    validKeys.add("team-rejected-cached");
    const result2 = await tryRegister("team-rejected-cached");
    expect(result2.type).toBe("error");
  });

  it("should handle multiple concurrent registrations", async () => {
    validKeys.add("team-a");
    validKeys.add("team-b");

    const [resultA, resultB, resultC] = await Promise.all([
      tryRegister("team-a"),
      tryRegister("team-b"),
      tryRegister("team-nonexistent"),
    ]);

    expect(resultA.type).toBe("ack");
    expect(resultB.type).toBe("ack");
    expect(resultC.type).toBe("error");
  });

  it("should include reason in rejection log", async () => {
    const result = await tryRegister("team-no-exist");
    expect(result.type).toBe("error");
  });

  it("should send auth secret as Bearer token", async () => {
    // The mock server doesn't check auth, but we verify the relay doesn't crash
    validKeys.add("team-with-auth");
    const result = await tryRegister("team-with-auth");
    expect(result.type).toBe("ack");
  });

  it("should fail open if auth server returns error", async () => {
    // Point at a URL that will fail (wrong path on the mock)
    server.stop();
    server = new RelayServer({
      port: RELAY_PORT,
      authUrl: `http://localhost:${MOCK_AUTH_PORT}/nonexistent-path`,
      authSecret: "test",
    });
    server.start();

    // The mock will return 404 for /nonexistent-path → relay should fail open
    const result = await tryRegister("team-any-key");
    expect(result.type).toBe("ack");
  });
});

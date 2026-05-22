import { describe, it, expect } from "vitest";
import { generateAgentId, generateTeamKey } from "../index.js";

describe("utils", () => {
  it("should generate unique agent IDs", () => {
    const id1 = generateAgentId();
    const id2 = generateAgentId();
    expect(id1).toMatch(/^agent-[a-f0-9]{12}$/);
    expect(id2).toMatch(/^agent-[a-f0-9]{12}$/);
    expect(id1).not.toBe(id2);
  });

  it("should generate unique team keys", () => {
    const key1 = generateTeamKey();
    const key2 = generateTeamKey();
    expect(key1).toMatch(/^team-[a-f0-9]{32}$/);
    expect(key2).toMatch(/^team-[a-f0-9]{32}$/);
    expect(key1).not.toBe(key2);
  });
});

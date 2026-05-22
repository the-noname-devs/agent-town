import { describe, it, expect } from "vitest";
import { generateAgentId, generateTeamKey } from "@agent-town/shared";

describe("CLI config generation", () => {
  it("should generate valid agent IDs", () => {
    const id = generateAgentId();
    expect(id).toMatch(/^agent-[a-f0-9]{12}$/);
  });

  it("should generate valid team keys", () => {
    const key = generateTeamKey();
    expect(key).toMatch(/^team-[a-f0-9]{32}$/);
  });
});

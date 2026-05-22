import { randomBytes } from "node:crypto";

export function generateAgentId(): string {
  return `agent-${randomBytes(6).toString("hex")}`;
}

export function generateTeamKey(): string {
  return `team-${randomBytes(16).toString("hex")}`;
}

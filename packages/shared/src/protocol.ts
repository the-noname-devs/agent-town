import type { BridgeMessage } from "./types.js";

export function createMessage<T extends BridgeMessage>(msg: T): string {
  return JSON.stringify(msg);
}

export function parseMessage(raw: string): BridgeMessage {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || !parsed.type) {
    throw new Error("Invalid message: missing type field");
  }
  return parsed as BridgeMessage;
}

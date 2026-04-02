import { createHash, createHmac, randomBytes } from "node:crypto";

const PROTOCOL_NAME = "a2hmarket-a2a";
const SCHEMA_VERSION = "1.0.0";

export interface A2AEnvelope {
  protocol: string;
  schema_version: string;
  message_type: string;
  message_id: string;
  trace_id: string;
  sender_id: string;
  target_id: string;
  timestamp: string;
  nonce: string;
  payload: Record<string, unknown>;
  payload_hash: string;
  signature: string;
}

/**
 * Recursively canonicalize a value to a deterministic JSON-like string.
 * Object keys are sorted alphabetically.
 * Matches Go protocol.canonicalize and JS a2a-protocol.js.
 */
export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" || typeof value === "bigint") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const pairs = keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k]));
    return "{" + pairs.join(",") + "}";
  }
  return JSON.stringify(value);
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function randomId(prefix: string): string {
  return `${prefix}_${Date.now()}_${randomHex(4)}`;
}

/** Format current time as Beijing time ISO8601, matching Go beijingTimeISO. */
function beijingTimeISO(): string {
  const now = new Date();
  const beijing = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const iso = beijing.toISOString(); // e.g. "2026-03-24T12:00:00.000Z"
  // Replace Z with +08:00
  return iso.replace("Z", "+08:00");
}

/** Build an unsigned A2A envelope. */
export function buildEnvelope(
  senderId: string,
  targetId: string,
  messageType: string,
  payload: Record<string, unknown>
): A2AEnvelope {
  const payloadHash = sha256Hex(canonicalize(payload));
  return {
    protocol: PROTOCOL_NAME,
    schema_version: SCHEMA_VERSION,
    message_type: messageType,
    message_id: randomId("msg"),
    trace_id: randomId("trace"),
    sender_id: senderId,
    target_id: targetId,
    timestamp: beijingTimeISO(),
    nonce: randomHex(8),
    payload,
    payload_hash: payloadHash,
    signature: "",
  };
}

/** Sign an envelope, returning a new copy with the signature field set. */
export function signEnvelope(agentKey: string, envelope: A2AEnvelope): A2AEnvelope {
  // Remove signature, canonicalize the rest, HMAC
  const unsigned = { ...envelope, signature: "" };
  // Convert to plain object for canonicalization (remove signature key entirely)
  const obj: Record<string, unknown> = { ...unsigned };
  delete obj.signature;
  const sigPayload = canonicalize(obj);
  const sig = createHmac("sha256", agentKey).update(sigPayload).digest("hex");
  return { ...envelope, signature: sig };
}

import { createHmac } from "node:crypto";

/**
 * Compute HTTP request signature.
 *
 * Algorithm (matches Go api.ComputeHTTPSignature):
 *   payload = "{METHOD}&{path}&{agentId}&{timestamp}"
 *   signature = HMAC-SHA256(agentKey, payload).hex()
 */
export function computeHttpSignature(
  agentKey: string,
  method: string,
  path: string,
  agentId: string,
  timestamp: string
): string {
  const payload = `${method.toUpperCase()}&${path}&${agentId}&${timestamp}`;
  return createHmac("sha256", agentKey).update(payload).digest("hex");
}

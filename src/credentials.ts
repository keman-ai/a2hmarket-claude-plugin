import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface A2HCredentials {
  agentId: string;
  agentKey: string;
  apiUrl: string;
  mqttUrl: string;
}

const CREDS_DIR = join(homedir(), ".a2h_store", "a2h_config");
const CREDS_FILE = join(CREDS_DIR, "credentials.json");

// Fallback paths
const OPENCLAW_CREDS = join(homedir(), ".openclaw", "credentials", "a2h_credentials.json");
const LEGACY_CREDS = join(homedir(), ".openclaw", "a2hmarket", "credentials.json");

export function loadCredentials(): A2HCredentials {
  // Try paths in order
  for (const path of [CREDS_FILE, OPENCLAW_CREDS, LEGACY_CREDS]) {
    if (!existsSync(path)) continue;
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8"));
      const agentId = raw.agent_id ?? raw.agentId ?? "";
      const agentKey = raw.agent_key ?? raw.agentKey ?? raw.secret ?? "";
      if (!agentId || !agentKey) continue;
      return {
        agentId,
        agentKey,
        apiUrl: (raw.api_url ?? raw.apiUrl ?? "https://api.a2hmarket.ai").replace(/\/+$/, ""),
        mqttUrl: raw.mqtt_url ?? raw.mqttUrl ?? "mqtts://post-cn-e4k4o78q702.mqtt.aliyuncs.com:8883",
      };
    } catch { continue; }
  }

  throw new Error(
    "A2H Market credentials not found. Run the setup first:\n" +
    "  npx -y @a2hmarket/openclaw-plugin install\n" +
    "Or create ~/.a2h_store/a2h_config/credentials.json manually.",
  );
}

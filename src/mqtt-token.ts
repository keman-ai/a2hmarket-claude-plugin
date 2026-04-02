import { computeHttpSignature } from "./signer.js";
import { randomBytes } from "node:crypto";

const TOKEN_PATH = "/mqtt-token/api/v1/token";
const MQTT_CLIENT_GROUP_ID = "GID_agent";
const TOKEN_REFRESH_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

export interface MqttCredential {
  clientId: string;
  username: string;
  password: string;
  expireTime: number; // Unix ms
}

export function buildClientId(agentId: string): string {
  return `${MQTT_CLIENT_GROUP_ID}@@@${agentId}`;
}

export function buildConnectionClientId(agentId: string, instanceId: string): string {
  return `${MQTT_CLIENT_GROUP_ID}@@@${agentId}_rt_${instanceId}`;
}

export function buildSendClientId(agentId: string): string {
  const suffix = randomBytes(4).toString("hex");
  return `${MQTT_CLIENT_GROUP_ID}@@@${agentId}_pub_${suffix}`;
}

export function incomingTopic(agentId: string): string {
  return `P2P_TOPIC/p2p/${buildClientId(agentId)}`;
}

export function outgoingTopic(targetAgentId: string): string {
  return `P2P_TOPIC/p2p/${buildClientId(targetAgentId)}`;
}

export class MqttTokenClient {
  private apiUrl: string;
  private agentId: string;
  private agentKey: string;
  private cache = new Map<string, MqttCredential>();

  constructor(apiUrl: string, agentId: string, agentKey: string) {
    this.apiUrl = apiUrl.replace(/\/+$/, "");
    this.agentId = agentId;
    this.agentKey = agentKey;
  }

  async getToken(clientId: string, forceRefresh = false): Promise<MqttCredential> {
    if (!forceRefresh) {
      const cached = this.cache.get(clientId);
      if (cached && cached.expireTime - Date.now() > TOKEN_REFRESH_THRESHOLD_MS) {
        return cached;
      }
    }
    this.cache.delete(clientId);

    const cred = await this.fetchToken(clientId);
    this.cache.set(clientId, cred);
    return cred;
  }

  invalidate(clientId: string): void {
    this.cache.delete(clientId);
  }

  private async fetchToken(clientId: string): Promise<MqttCredential> {
    const url = this.apiUrl + TOKEN_PATH;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = computeHttpSignature(
      this.agentKey,
      "POST",
      TOKEN_PATH,
      this.agentId,
      timestamp
    );

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agent-Id": this.agentId,
        "X-Timestamp": timestamp,
        "X-Agent-Signature": signature,
      },
      body: JSON.stringify({ client_id: clientId }),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`MQTT token HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }

    const result = (await resp.json()) as {
      success: boolean;
      data: {
        client_id: string;
        username: string;
        password: string;
        expire_time: number;
      };
      error?: string;
    };

    if (!result.success) {
      throw new Error(`MQTT token server error: ${result.error ?? "unknown"}`);
    }

    return {
      clientId: result.data.client_id,
      username: result.data.username,
      password: result.data.password,
      expireTime: result.data.expire_time,
    };
  }
}

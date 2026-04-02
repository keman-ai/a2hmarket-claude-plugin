import mqtt from "mqtt";
import {
  MqttTokenClient,
  buildClientId,
  buildSendClientId,
  incomingTopic,
  outgoingTopic,
} from "./mqtt-token.js";

const DEFAULT_QOS = 1 as const;
const KEEP_ALIVE_SEC = 60;
const CONNECT_TIMEOUT_MS = 15_000;

const RECONNECT_DELAYS_SEC = [1, 2, 4, 8, 16, 30];

export interface MqttMessage {
  topic: string;
  payload: string;
}

function normalizeBrokerUrl(raw: string): string {
  raw = raw.trim();
  if (raw.startsWith("ssl://") || raw.startsWith("tcp://")) return raw;
  if (raw.startsWith("mqtts://")) return "ssl://" + raw.slice("mqtts://".length);
  if (raw.startsWith("mqtt://")) return "tcp://" + raw.slice("mqtt://".length);
  return "ssl://" + raw;
}

export class MqttTransport {
  private brokerUrl: string;
  private tokenClient: MqttTokenClient;
  private agentId: string;
  private clientId: string;
  private cleanSession: boolean;
  private client: mqtt.MqttClient | null = null;
  private messageHandler: ((msg: MqttMessage) => void) | null = null;
  private reconnectHandler: (() => void) | null = null;
  private closed = false;
  private reconnecting = false;

  constructor(
    brokerUrl: string,
    tokenClient: MqttTokenClient,
    agentId: string,
    opts?: { clientId?: string; cleanSession?: boolean }
  ) {
    this.brokerUrl = normalizeBrokerUrl(brokerUrl);
    this.tokenClient = tokenClient;
    this.agentId = agentId;
    // Must use base clientId (no suffix) for RocketMQ P2P delivery
    this.clientId = opts?.clientId ?? buildClientId(agentId);
    this.cleanSession = opts?.cleanSession ?? false;
  }

  onMessage(handler: (msg: MqttMessage) => void): void {
    this.messageHandler = handler;
  }

  onReconnect(handler: () => void): void {
    this.reconnectHandler = handler;
  }

  async connect(): Promise<void> {
    const cred = await this.tokenClient.getToken(this.clientId, false);

    this.client = mqtt.connect(this.brokerUrl, {
      clientId: this.clientId,
      username: cred.username,
      password: cred.password,
      clean: this.cleanSession,
      keepalive: KEEP_ALIVE_SEC,
      connectTimeout: CONNECT_TIMEOUT_MS,
      reconnectPeriod: 0, // manual reconnect
      rejectUnauthorized: false, // match Go InsecureSkipVerify
      protocol: this.brokerUrl.startsWith("ssl://") ? "mqtts" : "mqtt",
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("MQTT connect timeout")), CONNECT_TIMEOUT_MS);
      this.client!.on("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      this.client!.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    this.client.on("message", (topic, payload) => {
      this.messageHandler?.({ topic, payload: payload.toString() });
    });

    this.client.on("close", () => {
      if (!this.closed) {
        this.reconnectLoop();
      }
    });
  }

  async subscribe(): Promise<void> {
    if (!this.client) throw new Error("MQTT not connected");
    const topic = incomingTopic(this.agentId);
    await this.client.subscribeAsync(topic, { qos: DEFAULT_QOS });
  }

  async publish(targetAgentId: string, payload: unknown): Promise<void> {
    if (!this.client) throw new Error("MQTT not connected");
    const topic = outgoingTopic(targetAgentId);
    const data = JSON.stringify(payload);
    await this.client.publishAsync(topic, data, { qos: DEFAULT_QOS });
  }

  isConnected(): boolean {
    return this.client?.connected ?? false;
  }

  close(): void {
    this.closed = true;
    this.client?.end(false); // graceful close — flush pending packets
    this.client = null;
  }

  /** Force-close immediately (for reconnect cleanup). */
  forceClose(): void {
    this.closed = true;
    this.client?.end(true);
    this.client = null;
  }

  // ─── Reconnect ──────────────────────────────────────────────────

  private async reconnectLoop(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;

    try {
      let attempt = 0;
      while (!this.closed) {
        const delaySec = RECONNECT_DELAYS_SEC[Math.min(attempt, RECONNECT_DELAYS_SEC.length - 1)];
        await sleep(delaySec * 1000);
        attempt++;

        try {
          const cred = await this.tokenClient.getToken(this.clientId, true);

          this.client?.end(true); // force-close old connection for reconnect
          this.client = mqtt.connect(this.brokerUrl, {
            clientId: this.clientId,
            username: cred.username,
            password: cred.password,
            clean: false,
            keepalive: KEEP_ALIVE_SEC,
            connectTimeout: CONNECT_TIMEOUT_MS,
            reconnectPeriod: 0,
            rejectUnauthorized: false,
            protocol: this.brokerUrl.startsWith("ssl://") ? "mqtts" : "mqtt",
          });

          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("timeout")), CONNECT_TIMEOUT_MS);
            this.client!.on("connect", () => {
              clearTimeout(timer);
              resolve();
            });
            this.client!.on("error", (err) => {
              clearTimeout(timer);
              reject(err);
            });
          });

          this.client.on("message", (topic, payload) => {
            this.messageHandler?.({ topic, payload: payload.toString() });
          });

          this.client.on("close", () => {
            if (!this.closed) this.reconnectLoop();
          });

          // Resubscribe
          await this.subscribe();
          this.reconnectHandler?.();
          return;
        } catch {
          // Retry
          process.stderr.write(`a2hmarket: MQTT reconnect attempt ${attempt} failed\n`);
        }
      }
    } finally {
      this.reconnecting = false;
    }
  }
}

/** Create a short-lived transport for one-shot publish (send command). */
export function createSendTransport(
  brokerUrl: string,
  tokenClient: MqttTokenClient,
  agentId: string
): MqttTransport {
  return new MqttTransport(brokerUrl, tokenClient, agentId, {
    clientId: buildSendClientId(agentId),
    cleanSession: true,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

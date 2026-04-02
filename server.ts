/**
 * A2H Market MCP Server for Claude Code
 *
 * Architecture:
 *   MQTT long connection → receive A2A messages → mcp.notification → Claude
 *   Claude → MCP tools → A2H Market HTTP API / MQTT send
 *
 * Modeled after the Discord channel plugin pattern.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { loadCredentials, type A2HCredentials } from "./src/credentials.js";
import { A2HApiClient } from "./src/api-client.js";
import { MqttTokenClient } from "./src/mqtt-token.js";
import { MqttTransport } from "./src/mqtt-transport.js";
import { buildEnvelope, signEnvelope } from "./src/protocol.js";

// ── Load credentials ─────────────────────────────────────────────────

let creds: A2HCredentials;
let apiClient: A2HApiClient;

try {
  creds = loadCredentials();
  apiClient = new A2HApiClient(creds);
  process.stderr.write(`a2hmarket: loaded credentials for ${creds.agentId}\n`);
} catch (err) {
  process.stderr.write(`a2hmarket: ${(err as Error).message}\n`);
  process.exit(1);
}

// ── MCP Server ───────────────────────────────────────────────────────

const mcp = new Server(
  { name: "a2hmarket", version: "0.1.0" },
  {
    capabilities: {
      tools: {},
      experimental: {
        "claude/channel": {},
      },
    },
    instructions: [
      "A2H Market — AI agent marketplace. You trade on behalf of the human.",
      "",
      "Messages from other agents arrive as <channel source=\"a2hmarket\" ...>.",
      "Reply using the a2h_send tool. Your text output does NOT reach the other agent.",
      "",
      "Critical rules:",
      "- You are a proxy, not a decision-maker. For pricing, orders, payments: ask the human first.",
      "- Read the a2hmarket skill for detailed playbooks on buying, selling, and negotiation.",
    ].join("\n"),
  },
);

// ── Tool definitions ─────────────────────────────────────────────────

const TOOLS = [
  {
    name: "a2h_status",
    description: "Check A2H Market connection status and agent ID.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "a2h_send",
    description:
      "Send a message to another agent on A2H Market. " +
      "Use for all outbound messages — replies and proactive outreach.",
    inputSchema: {
      type: "object" as const,
      properties: {
        target_agent_id: { type: "string", description: "Target agent ID (ag_...)" },
        text: { type: "string", description: "Message text" },
        order_id: { type: "string", description: "Order ID if order-related (WKS...)" },
        works_id: { type: "string", description: "Works/post ID if discussing a post" },
      },
      required: ["target_agent_id", "text"],
    },
  },
  {
    name: "a2h_works_search",
    description: "Search marketplace for services (type=3), demands (type=2), or discussions (type=4).",
    inputSchema: {
      type: "object" as const,
      properties: {
        keyword: { type: "string", description: "Search keyword" },
        type: { type: "number", description: "2=demand, 3=service, 4=discussion" },
        agent_id: { type: "string", description: "Filter by agent ID" },
        page: { type: "number", description: "Page (1-based, default 1)" },
        page_size: { type: "number", description: "Results per page (default 10)" },
      },
      required: ["keyword"],
    },
  },
  {
    name: "a2h_works_list",
    description: "List the agent's own works posts.",
    inputSchema: {
      type: "object" as const,
      properties: {
        type: { type: "number", description: "2=demand, 3=service, 4=discussion" },
        page: { type: "number", description: "Page (default 1)" },
      },
    },
  },
  {
    name: "a2h_works_publish",
    description:
      "Publish a new service or demand post. For type=3: set price_type (FIXED/NEGOTIABLE), currency (CNY/USD), and price fields.",
    inputSchema: {
      type: "object" as const,
      properties: {
        type: { type: "number", description: "2=demand, 3=service" },
        title: { type: "string", description: "Post title" },
        content: { type: "string", description: "Post content" },
        price_type: { type: "string", description: "FIXED or NEGOTIABLE (type=3)" },
        currency: { type: "string", description: "CNY or USD (type=3)" },
        fixed_price: { type: "number", description: "Price in cents (FIXED)" },
        price_min: { type: "number", description: "Min price in cents (NEGOTIABLE)" },
        price_max: { type: "number", description: "Max price in cents (NEGOTIABLE)" },
        service_method: { type: "string", description: "online or offline" },
      },
      required: ["type", "title", "content"],
    },
  },
  {
    name: "a2h_order_create",
    description:
      "Create an order (seller side). Requires human approval first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        customer_id: { type: "string", description: "Buyer agent ID" },
        title: { type: "string", description: "Order title" },
        content: { type: "string", description: "Order description" },
        price_cent: { type: "number", description: "Price in cents" },
        currency: { type: "string", description: "CNY or USD" },
        product_id: { type: "string", description: "Works ID" },
        order_type: { type: "number", description: "2 or 3" },
      },
      required: ["customer_id", "title", "content", "price_cent", "currency", "product_id", "order_type"],
    },
  },
  {
    name: "a2h_order_action",
    description: "Perform order action: confirm, reject, cancel, confirm-received, confirm-service-completed.",
    inputSchema: {
      type: "object" as const,
      properties: {
        order_id: { type: "string", description: "Order ID" },
        action: { type: "string", description: "confirm|reject|cancel|confirm-received|confirm-service-completed" },
      },
      required: ["order_id", "action"],
    },
  },
  {
    name: "a2h_order_list",
    description: "List orders. role=sales (seller) or role=purchase (buyer).",
    inputSchema: {
      type: "object" as const,
      properties: {
        role: { type: "string", description: "sales or purchase" },
        status: { type: "string", description: "Filter by status" },
        page: { type: "number" },
        page_size: { type: "number" },
      },
      required: ["role"],
    },
  },
  {
    name: "a2h_order_get",
    description: "Get order details by order ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        order_id: { type: "string", description: "Order ID" },
      },
      required: ["order_id"],
    },
  },
  {
    name: "a2h_profile_get",
    description: "Get current agent's profile (nickname, avatar, etc).",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "a2h_inbox_history",
    description: "Get message history with a specific peer agent.",
    inputSchema: {
      type: "object" as const,
      properties: {
        peer_id: { type: "string", description: "Peer agent ID" },
        limit: { type: "number", description: "Max messages (default 20)" },
      },
      required: ["peer_id"],
    },
  },
];

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

// ── Tool execution ───────────────────────────────────────────────────

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const params = (req.params.arguments ?? {}) as Record<string, unknown>;

  try {
    switch (req.params.name) {
      case "a2h_status": {
        return ok({ agent_id: creds.agentId, authenticated: true, mqtt: mqttConnected });
      }

      case "a2h_send": {
        const targetId = params.target_agent_id as string;
        const text = params.text as string;
        if (!targetId || !text) throw new Error("target_agent_id and text are required");

        const payload: Record<string, unknown> = { text };
        if (params.order_id) payload.orderId = params.order_id;
        if (params.works_id) payload.worksId = params.works_id;

        // Auto-extract orderId/worksId from text
        if (!payload.orderId) {
          const m = text.match(/\b(WKS[a-f0-9]{30,})\b/i);
          if (m) payload.orderId = m[1];
        }

        const envelope = buildEnvelope(creds.agentId, targetId, "chat.request", payload);
        const signed = signEnvelope(creds.agentKey, envelope);

        const tokenClient = new MqttTokenClient(creds.apiUrl, creds.agentId, creds.agentKey);
        const { createSendTransport } = await import("./src/mqtt-transport.js");
        const transport = createSendTransport(creds.mqttUrl, tokenClient, creds.agentId);
        await transport.connect();
        await transport.publish(targetId, signed);
        await new Promise(r => setTimeout(r, 300));
        transport.close();

        return ok({ message_id: signed.message_id, target_id: targetId });
      }

      case "a2h_works_search": {
        const body = {
          serviceInfo: params.keyword ?? "",
          type: params.type,
          pageNum: Math.max(0, ((params.page as number) || 1) - 1),
          pageSize: (params.page_size as number) || 10,
          ...(params.agent_id ? { agentId: params.agent_id } : {}),
        };
        const data = await apiClient.postJSON("/findu-match/api/v1/inner/match/works_search", body);
        return ok(data);
      }

      case "a2h_works_list": {
        const page = (params.page as number) || 1;
        const qs = `?pageNum=${Math.max(0, page - 1)}&pageSize=20${params.type != null ? `&type=${params.type}` : ""}`;
        const data = await apiClient.getJSON("/findu-user/api/v1/user/works/public" + qs, "/findu-user/api/v1/user/works/public");
        return ok(data);
      }

      case "a2h_works_publish": {
        const extendInfo: Record<string, unknown> = { pois: [], serviceMethod: (params.service_method as string) || "online" };
        if (params.price_type) extendInfo.priceType = params.price_type;
        if (params.currency) extendInfo.currency = params.currency;
        if (params.fixed_price != null) extendInfo.fixedPrice = params.fixed_price;
        if (params.price_min != null) extendInfo.priceMin = params.price_min;
        if (params.price_max != null) extendInfo.priceMax = params.price_max;

        const data = await apiClient.postJSON("/findu-user/api/v1/user/works/change-requests", {
          type: params.type, title: params.title, content: params.content, extendInfo,
        });
        return ok(data);
      }

      case "a2h_order_create": {
        const data = await apiClient.postJSON("/findu-trade/api/v1/orders/create", {
          providerId: creds.agentId,
          customerId: params.customer_id,
          title: params.title,
          content: params.content,
          price: params.price_cent,
          currency: params.currency,
          productId: params.product_id,
          orderType: params.order_type,
        });
        return ok(data);
      }

      case "a2h_order_action": {
        const action = params.action as string;
        const valid = ["confirm", "reject", "cancel", "confirm-received", "confirm-service-completed"];
        if (!valid.includes(action)) throw new Error(`Invalid action. Must be: ${valid.join(", ")}`);
        const data = await apiClient.postJSON(`/findu-trade/api/v1/orders/${params.order_id}/${action}`, {});
        return ok(data ?? { ok: true });
      }

      case "a2h_order_list": {
        const role = params.role as string;
        const endpoint = role === "sales" ? "/findu-trade/api/v1/orders/sales-orders" : "/findu-trade/api/v1/orders/purchase-orders";
        const qs = `?page=${(params.page as number) || 1}&pageSize=${(params.page_size as number) || 10}${params.status ? `&status=${params.status}` : ""}`;
        const data = await apiClient.getJSON(endpoint + qs, endpoint);
        return ok(data);
      }

      case "a2h_order_get": {
        const data = await apiClient.getJSON(`/findu-trade/api/v1/orders/${params.order_id}/detail`);
        return ok(data);
      }

      case "a2h_profile_get": {
        const data = await apiClient.getJSON("/findu-user/api/v1/user/profile/public");
        return ok(data);
      }

      case "a2h_inbox_history": {
        const qs = `?peerId=${params.peer_id}&limit=${(params.limit as number) || 20}`;
        const data = await apiClient.getJSON("/agent-message/api/v1/agents/sessions/messages" + qs, "/agent-message/api/v1/agents/sessions/messages");
        return ok(data);
      }

      default:
        return { content: [{ type: "text" as const, text: `unknown tool: ${req.params.name}` }], isError: true };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text" as const, text: `${req.params.name} failed: ${msg}` }], isError: true };
  }
});

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

// ── MQTT Listener (real-time A2A messages) ────────────────────────────

let mqttConnected = false;

async function startMqttListener() {
  const tokenClient = new MqttTokenClient(creds.apiUrl, creds.agentId, creds.agentKey);

  // Use base clientId for P2P delivery (no suffix)
  const { buildClientId, incomingTopic } = await import("./src/mqtt-token.js");

  const transport = new MqttTransport(creds.mqttUrl, tokenClient, creds.agentId);

  transport.onMessage((msg) => {
    try {
      const envelope = JSON.parse(msg.payload);
      const senderId = envelope.sender_id ?? "";
      const text = envelope.payload?.text ?? "";

      // Skip own messages
      if (senderId === creds.agentId) return;

      process.stderr.write(`a2hmarket: inbound from ${senderId}: ${text.slice(0, 80)}\n`);

      // Build metadata
      const meta: Record<string, string> = {
        sender_id: senderId,
        message_id: envelope.message_id ?? "",
        message_type: envelope.message_type ?? "",
        ts: envelope.timestamp ?? new Date().toISOString(),
      };
      if (envelope.payload?.orderId) meta.order_id = String(envelope.payload.orderId);
      if (envelope.payload?.worksId) meta.works_id = String(envelope.payload.worksId);

      // Push to Claude via MCP notification
      mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: text || "(empty message)",
          meta: {
            ...meta,
            source: "a2hmarket",
          },
        },
      }).catch((err) => {
        process.stderr.write(`a2hmarket: notification failed: ${err}\n`);
      });
    } catch (err) {
      process.stderr.write(`a2hmarket: parse error: ${err}\n`);
    }
  });

  try {
    await transport.connect();
    await transport.subscribe();
    mqttConnected = true;
    process.stderr.write(`a2hmarket: MQTT connected, listening for messages\n`);
  } catch (err) {
    process.stderr.write(`a2hmarket: MQTT connect failed: ${(err as Error).message}\n`);
    // Non-fatal: tools still work, just no real-time messages
  }
}

// ── Start ─────────────────────────────────────────────────────────────

await mcp.connect(new StdioServerTransport());

// Start MQTT listener in background (non-blocking)
startMqttListener().catch((err) => {
  process.stderr.write(`a2hmarket: MQTT listener error: ${err}\n`);
});

// Graceful shutdown
let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write("a2hmarket: shutting down\n");
  setTimeout(() => process.exit(0), 2000);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.stdin.on("end", shutdown);

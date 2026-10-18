/**
 * WebSocket Real-time Log Streaming — R-003.
 * Phase C Week 11-12: Real-time log streaming to dashboard.
 *
 * Provides WebSocket endpoint /api/observability/ws for pushing
 * live request/response logs, metrics updates, and alerts to the dashboard.
 */

import { Hono } from "hono";

interface WSMessage {
  type: "log" | "metrics" | "alert" | "heartbeat" | "subscribe" | "unsubscribe" | "ping" | "pong" | "welcome" | "subscribed" | "unsubscribed" | "stats" | "error" | "getStats";
  payload: any;
  timestamp: string;
}

interface WSClient {
  ws: any; // Deno WebSocket
  subscriptions: Set<string>;
  connectedAt: number;
  lastPing: number;
}

const clients = new Map<string, WSClient>();
let clientCounter = 0;

// Cleanup stale clients every 30 seconds
setInterval(() => {
  const now = Date.now();
  for (const [id, client] of clients) {
    if (now - client.lastPing > 60000) {
      try { client.ws.close(1001, "timeout"); } catch {}
      clients.delete(id);
    }
  }
}, 30000);

/** Broadcast message to all clients with matching subscription */
function broadcast(type: WSMessage["type"], payload: any, subscription: string) {
  const msg: WSMessage = { type, payload, timestamp: new Date().toISOString() };
  const data = JSON.stringify(msg);
  
  for (const [, client] of clients) {
    if (client.subscriptions.has(subscription) || client.subscriptions.has("*")) {
      try {
        client.ws.send(data);
      } catch {
        // Client disconnected, will be cleaned up
      }
    }
  }
}

/** Broadcast metrics update */
export function broadcastMetrics(metrics: any) {
  broadcast("metrics", metrics, "metrics");
}

/** Broadcast new log entry */
export function broadcastLog(log: any) {
  broadcast("log", log, "logs");
}

/** Broadcast alert */
export function broadcastAlert(alert: any) {
  broadcast("alert", alert, "alerts");
}

/** Get connected client count */
export function getClientCount(): number {
  return clients.size;
}

/** Get client stats */
export function getClientStats(): { total: number; bySubscription: Record<string, number> } {
  const bySubscription: Record<string, number> = {};
  for (const client of clients.values()) {
    for (const sub of client.subscriptions) {
      bySubscription[sub] = (bySubscription[sub] || 0) + 1;
    }
  }
  return { total: clients.size, bySubscription };
}

/** WebSocket routes using native Deno upgrade */
const wsRoutes = new Hono();

wsRoutes.get("/ws", async (c: any) => {
  // Upgrade to WebSocket using Deno native API
  const upgrade = c.req.header("upgrade");
  if (upgrade !== "websocket") {
    return c.text("Expected WebSocket upgrade", 400);
  }
  
  const { socket, response } = Deno.upgradeWebSocket(c.req.raw);
  const clientId = `ws_${++clientCounter}_${Date.now()}`;
  const client: WSClient = {
    ws: socket,
    subscriptions: new Set(["logs", "metrics", "alerts", "errors"]),
    connectedAt: Date.now(),
    lastPing: Date.now(),
  };
  
  clients.set(clientId, client);
  console.log(`[WS] Client connected: ${clientId} (total: ${clients.size})`);
  
  socket.onopen = () => {
    socket.send(JSON.stringify({
      type: "welcome",
      payload: { clientId, serverTime: new Date().toISOString() },
      timestamp: new Date().toISOString(),
    }));
  };
  
  socket.onmessage = (evt) => {
    client.lastPing = Date.now();
    
    try {
      const msg: WSMessage = JSON.parse(evt.data as string);
      
      switch (msg.type) {
        case "subscribe": {
          const channels = Array.isArray(msg.payload?.channels) ? msg.payload.channels : [msg.payload?.channel].filter(Boolean);
          for (const ch of channels) {
            if (["logs", "metrics", "alerts", "errors", "*"].includes(ch)) {
              client.subscriptions.add(ch);
            }
          }
          socket.send(JSON.stringify({
            type: "subscribed",
            payload: { channels: [...client.subscriptions] },
            timestamp: new Date().toISOString(),
          }));
          break;
        }
        case "unsubscribe": {
          const channels = Array.isArray(msg.payload?.channels) ? msg.payload.channels : [msg.payload?.channel].filter(Boolean);
          for (const ch of channels) {
            client.subscriptions.delete(ch);
          }
          socket.send(JSON.stringify({
            type: "unsubscribed",
            payload: { channels: [...client.subscriptions] },
            timestamp: new Date().toISOString(),
          }));
          break;
        }
        case "ping": {
          socket.send(JSON.stringify({
            type: "pong",
            payload: { serverTime: new Date().toISOString() },
            timestamp: new Date().toISOString(),
          }));
          break;
        }
        case "getStats": {
          socket.send(JSON.stringify({
            type: "stats",
            payload: getClientStats(),
            timestamp: new Date().toISOString(),
          }));
          break;
        }
      }
    } catch {
      socket.send(JSON.stringify({
        type: "error",
        payload: { message: "Invalid message format" },
        timestamp: new Date().toISOString(),
      }));
    }
  };
  
  socket.onclose = () => {
    clients.delete(clientId);
    console.log(`[WS] Client disconnected: ${clientId} (total: ${clients.size})`);
  };
  
  socket.onerror = () => {
    clients.delete(clientId);
  };
  
  return response;
});

// REST endpoint for client stats
wsRoutes.get("/ws/stats", (c: any) => {
  return c.json(getClientStats());
});

export const wsObservability = wsRoutes;
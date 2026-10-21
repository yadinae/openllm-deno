/**
 * MCP (Model Context Protocol) Service — Server/Client for P-CORE-010.
 * Phase C Week 13-14: MCP 协议支持。
 *
 * Implements MCP Server (exposing tools/resources) and MCP Client (connecting to servers).
 * Transport: stdio, HTTP+SSE, WebSocket.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface MCPPrompt {
  name: string;
  description: string;
  arguments?: Array<{ name: string; description: string; required?: boolean }>;
}

export interface MCPServerCapabilities {
  tools?: { listChanged?: boolean };
  resources?: { subscribe?: boolean; listChanged?: boolean };
  prompts?: { listChanged?: boolean };
  logging?: boolean;
}

export interface MCPClientCapabilities {
  roots?: { listChanged?: boolean };
  sampling?: boolean;
}

export interface MCPInitializeRequest {
  protocolVersion: string;
  capabilities: MCPClientCapabilities;
  clientInfo: { name: string; version: string };
}

export interface MCPInitializeResponse {
  protocolVersion: string;
  capabilities: MCPServerCapabilities;
  serverInfo: { name: string; version: string };
}

export interface MCPCallToolRequest {
  name: string;
  arguments: Record<string, unknown>;
}

export interface MCPCallToolResult {
  content: Array<{ type: "text" | "image" | "resource"; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

export interface MCPListToolsResult {
  tools: MCPTool[];
}

export interface MCPListResourcesResult {
  resources: MCPResource[];
}

export interface MCPReadResourceRequest {
  uri: string;
}

export interface MCPReadResourceResult {
  contents: Array<{ uri: string; mimeType?: string; text?: string; blob?: string }>;
}

/** Built-in tools for OpenLLM */
const BUILTIN_TOOLS: MCPTool[] = [
  {
    name: "openllm.chat",
    description: "Chat completion via OpenLLM gateway",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: "Model ID (e.g., openai/gpt-4o)" },
        messages: { 
          type: "array", 
          items: { 
            type: "object", 
            properties: { role: { type: "string" }, content: { type: "string" } },
            required: ["role", "content"]
          }
        },
        max_tokens: { type: "number", description: "Max tokens", default: 1000 },
        temperature: { type: "number", description: "Temperature", default: 0.7 },
      },
      required: ["model", "messages"],
    },
  },
  {
    name: "openllm.models",
    description: "List available models",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "Filter by provider" },
        free_only: { type: "boolean", description: "Only free models", default: false },
      },
    },
  },
  {
    name: "openllm.embeddings",
    description: "Generate embeddings",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: "Embedding model ID" },
        input: { type: "array", items: { type: "string" } },
      },
      required: ["model", "input"],
    },
  },
  {
    name: "openllm.search",
    description: "Web search",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        engine: { type: "string", default: "brave" },
        count: { type: "number", default: 10 },
      },
      required: ["query"],
    },
  },
  {
    name: "openllm.media",
    description: "Generate image/video/audio",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string" },
        prompt: { type: "string" },
        width: { type: "number" },
        height: { type: "number" },
      },
      required: ["model", "prompt"],
    },
  },
];

/** Built-in resources */
const BUILTIN_RESOURCES: MCPResource[] = [
  {
    uri: "openllm://models",
    name: "Model Catalog",
    description: "List of all available models with pricing and capabilities",
    mimeType: "application/json",
  },
  {
    uri: "openllm://providers",
    name: "Provider Registry",
    description: "Registered providers and their status",
    mimeType: "application/json",
  },
  {
    uri: "openllm://health",
    name: "System Health",
    description: "Current system health and metrics",
    mimeType: "application/json",
  },
];

/** MCP Server Class */
export class MCPServer {
  private tools: Map<string, MCPTool> = new Map();
  private resources: Map<string, MCPResource> = new Map();
  private prompts: Map<string, MCPPrompt> = new Map();
  private toolHandlers: Map<string, (args: any) => Promise<MCPCallToolResult>> = new Map();
  private resourceHandlers: Map<string, (uri: string) => Promise<MCPReadResourceResult>> = new Map();

  // Gateway context (set via initGatewayContext)
  private chatHandler?: (args: any) => Promise<MCPCallToolResult>;
  private modelsHandler?: (args: any) => Promise<MCPCallToolResult>;
  private embeddingsHandler?: (args: any) => Promise<MCPCallToolResult>;
  private searchHandler?: (args: any) => Promise<MCPCallToolResult>;
  private mediaHandler?: (args: any) => Promise<MCPCallToolResult>;
  private modelsResourceHandler?: () => Promise<MCPReadResourceResult>;
  private providersResourceHandler?: () => Promise<MCPReadResourceResult>;
  private healthResourceHandler?: () => Promise<MCPReadResourceResult>;

  constructor(private serverInfo = { name: "OpenLLM", version: "1.0.0" }) {
    // Register built-in tools
    for (const tool of BUILTIN_TOOLS) {
      this.tools.set(tool.name, tool);
    }
    // Register built-in resources
    for (const resource of BUILTIN_RESOURCES) {
      this.resources.set(resource.uri, resource);
    }
  }

  /** Initialize gateway context handlers (call once from api.ts after services are ready) */
  initGatewayContext(ctx: {
    chatHandler: (args: any) => Promise<MCPCallToolResult>;
    modelsHandler: (args: any) => Promise<MCPCallToolResult>;
    embeddingsHandler: (args: any) => Promise<MCPCallToolResult>;
    searchHandler: (args: any) => Promise<MCPCallToolResult>;
    mediaHandler: (args: any) => Promise<MCPCallToolResult>;
    modelsResourceHandler: () => Promise<MCPReadResourceResult>;
    providersResourceHandler: () => Promise<MCPReadResourceResult>;
    healthResourceHandler: () => Promise<MCPReadResourceResult>;
  }): void {
    this.chatHandler = ctx.chatHandler;
    this.modelsHandler = ctx.modelsHandler;
    this.embeddingsHandler = ctx.embeddingsHandler;
    this.searchHandler = ctx.searchHandler;
    this.mediaHandler = ctx.mediaHandler;
    this.modelsResourceHandler = ctx.modelsResourceHandler;
    this.providersResourceHandler = ctx.providersResourceHandler;
    this.healthResourceHandler = ctx.healthResourceHandler;

    // Register built-in tool handlers
    if (ctx.chatHandler) this.toolHandlers.set("openllm.chat", ctx.chatHandler);
    if (ctx.modelsHandler) this.toolHandlers.set("openllm.models", ctx.modelsHandler);
    if (ctx.embeddingsHandler) this.toolHandlers.set("openllm.embeddings", ctx.embeddingsHandler);
    if (ctx.searchHandler) this.toolHandlers.set("openllm.search", ctx.searchHandler);
    if (ctx.mediaHandler) this.toolHandlers.set("openllm.media", ctx.mediaHandler);

    // Register built-in resource handlers
    if (ctx.modelsResourceHandler) this.resourceHandlers.set("openllm://models", () => ctx.modelsResourceHandler!());
    if (ctx.providersResourceHandler) this.resourceHandlers.set("openllm://providers", () => ctx.providersResourceHandler!());
    if (ctx.healthResourceHandler) this.resourceHandlers.set("openllm://health", () => ctx.healthResourceHandler!());
  }

  /** Register a custom tool */
  registerTool(tool: MCPTool, handler: (args: any) => Promise<MCPCallToolResult>): void {
    this.tools.set(tool.name, tool);
    this.toolHandlers.set(tool.name, handler);
  }

  /** Register a custom resource */
  registerResource(resource: MCPResource, handler: (uri: string) => Promise<MCPReadResourceResult>): void {
    this.resources.set(resource.uri, resource);
    this.resourceHandlers.set(resource.uri, handler);
  }

  /** Register a custom prompt */
  registerPrompt(prompt: MCPPrompt): void {
    this.prompts.set(prompt.name, prompt);
  }

  /** Handle initialize request */
  async handleInitialize(req: MCPInitializeRequest): Promise<MCPInitializeResponse> {
    return {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: { listChanged: true },
        resources: { subscribe: true, listChanged: true },
        prompts: { listChanged: true },
        logging: true,
      },
      serverInfo: this.serverInfo,
    };
  }

  /** Handle tools/list */
  async handleListTools(): Promise<MCPListToolsResult> {
    return { tools: [...this.tools.values()] };
  }

  /** Handle tools/call */
  async handleCallTool(req: MCPCallToolRequest): Promise<MCPCallToolResult> {
    const handler = this.toolHandlers.get(req.name);
    if (!handler) {
      return {
        content: [{ type: "text", text: `Tool ${req.name} not found` }],
        isError: true,
      };
    }
    try {
      return await handler(req.arguments);
    } catch (e) {
      return {
        content: [{ type: "text", text: `Tool error: ${e instanceof Error ? e.message : String(e)}` }],
        isError: true,
      };
    }
  }

  /** Handle resources/list */
  async handleListResources(): Promise<MCPListResourcesResult> {
    return { resources: [...this.resources.values()] };
  }

  /** Handle resources/read */
  async handleReadResource(req: MCPReadResourceRequest): Promise<MCPReadResourceResult> {
    const handler = this.resourceHandlers.get(req.uri);
    if (!handler) {
      throw new Error(`Resource ${req.uri} not found`);
    }
    return await handler(req.uri);
  }

  /** Get Hono app for HTTP transport */
  getHttpApp(): Hono {
    const app = new Hono();
    app.use("*", cors());

    // MCP over HTTP (JSON-RPC)
    app.post("/mcp", async (c) => {
      const body = await c.req.json() as { method: string; params?: any; id?: string | number };
      
      let result: any;
      let error: any;

      try {
        switch (body.method) {
          case "initialize":
            result = await this.handleInitialize(body.params);
            break;
          case "tools/list":
            result = await this.handleListTools();
            break;
          case "tools/call":
            result = await this.handleCallTool(body.params);
            break;
          case "resources/list":
            result = await this.handleListResources();
            break;
          case "resources/read":
            result = await this.handleReadResource(body.params);
            break;
          case "prompts/list":
            result = { prompts: [...this.prompts.values()] };
            break;
          default:
            throw new Error(`Method not found: ${body.method}`);
        }
      } catch (e) {
        error = { code: -32603, message: e instanceof Error ? e.message : String(e) };
      }

      return c.json({
        jsonrpc: "2.0",
        id: body.id,
        result,
        error,
      });
    });

    // SSE endpoint for streaming
    app.get("/mcp/sse", async (c: any) => {
      const upgrade = c.req.header("upgrade");
      if (upgrade !== "websocket") {
        return c.text("WebSocket upgrade required for SSE", 400);
      }
      
      const deno = (globalThis as any).Deno;
      const { socket, response } = deno.upgradeWebSocket(c.req.raw);
      
      socket.onopen = () => {
        // Send initialization
        socket.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
      };
      
      socket.onmessage = async (evt: any) => {
        try {
          const msg = JSON.parse(evt.data as string);
          let result: any;
          
          switch (msg.method) {
            case "tools/list":
              result = await this.handleListTools();
              break;
            case "tools/call":
              result = await this.handleCallTool(msg.params);
              break;
            case "resources/list":
              result = await this.handleListResources();
              break;
            case "resources/read":
              result = await this.handleReadResource(msg.params);
              break;
            default:
              result = { error: { code: -32601, message: "Method not found" } };
          }
          
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
        } catch (e) {
          socket.send(JSON.stringify({ 
            jsonrpc: "2.0", 
            id: (JSON.parse(evt.data as string) as any).id, 
            error: { code: -32603, message: String(e) } 
          }));
        }
      };
      
      return response;
    });

    return app;
  }
}

/** MCP Client Class */
export class MCPClient {
  private baseUrl: string;
  private apiKey?: string;
  private initialized = false;

  constructor(baseUrl: string, apiKey?: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
  }

  async initialize(clientInfo = { name: "OpenLLM-Client", version: "1.0.0" }): Promise<MCPInitializeResponse> {
    const res = await this.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { roots: { listChanged: true }, sampling: true },
      clientInfo,
    });
    this.initialized = true;
    return res;
  }

  async listTools(): Promise<MCPTool[]> {
    const res = await this.call("tools/list");
    return res.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<MCPCallToolResult> {
    return await this.call("tools/call", { name, arguments: args });
  }

  async listResources(): Promise<MCPResource[]> {
    const res = await this.call("resources/list");
    return res.resources;
  }

  async readResource(uri: string): Promise<MCPReadResourceResult> {
    return await this.call("resources/read", { uri });
  }

  private async call(method: string, params?: any): Promise<any> {
    const res = await fetch(`${this.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey ? { "Authorization": `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id: Date.now() }),
    });

    const data = await res.json() as { result?: any; error?: any };
    if (data.error) throw new Error(data.error.message);
    return data.result;
  }
}

/** Global MCP server instance */
export const mcpServer = new MCPServer();

/** Start MCP HTTP server */
export function startMcpHttpServer(port: number = 3001): void {
  const app = mcpServer.getHttpApp();
  const deno = (globalThis as any).Deno;
  deno.serve({ port, hostname: "0.0.0.0" }, app.fetch);
  console.log(`[MCP] HTTP server started on port ${port}`);
}
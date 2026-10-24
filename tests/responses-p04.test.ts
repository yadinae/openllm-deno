/**
 * Unit tests for the ported Responses API translation layer (P0-4).
 * Pure, no DB/server required. Validates the translation surface the 7KB stub
 * never tested.
 */
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { Hono } from "hono";
import responsesRouter, {
  toChatMessages,
  toChatTools,
  responsesInputHasFileIdImage,
  responsesInputRequestsComputerUse,
  webSearchCallToText,
} from "../routes/responses.ts";

/** Exercise the route via Hono's in-process fetch (no TCP server needed). */
async function call(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const app = new Hono();
  app.route("/v1", responsesRouter);
  const res = await app.request(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

Deno.test("Responses: 400 on missing input", async () => {
  const r = await call("/v1/responses", { model: "auto" });
  assertEquals(r.status, 400);
  assert(r.json.error.message.includes("input: required"));
});

Deno.test("Responses: 422 on computer-use", async () => {
  const r = await call("/v1/responses", { model: "auto", input: [{ type: "computer_call", call_id: "c1", action: {} }] });
  assertEquals(r.status, 422);
  assert(r.json.error.code === "no_computer_use_model");
});

Deno.test("Responses: 422 on file_id-only image", async () => {
  const input = [
    { type: "message", role: "user", content: [{ type: "input_image", image_url: { file_id: "file-abc" } }] },
  ];
  assert(responsesInputHasFileIdImage({ model: "auto", input } as never) === true);
  const r = await call("/v1/responses", { model: "auto", input });
  assertEquals(r.status, 422);
  assert(r.json.error.code === "unsupported_image_input");
});

Deno.test("Responses: 400 on unknown item type", async () => {
  const r = await call("/v1/responses", { model: "auto", input: [{ type: "quantum_tunnel_call", id: "x" }] });
  assertEquals(r.status, 400);
});

Deno.test("Responses: requestsComputerUse catches computer tool + items", () => {
  assert(responsesInputRequestsComputerUse({ model: "auto", input: [{ type: "message", role: "user", content: "hi" }] } as never) === false);
  assert(responsesInputRequestsComputerUse({ model: "auto", input: "hi", tools: [{ type: "computer", use: "computer_use" }] } as never) === true);
  assert(responsesInputRequestsComputerUse({ model: "auto", input: [{ type: "computer_call", call_id: "c", action: {} }] } as never) === true);
});

Deno.test("Responses: web_search_call replay note", () => {
  assertEquals(webSearchCallToText({ type: "web_search_call", action: { query: "hello", sources: [{ url: "https://a.example" }] } } as never),
    "[Searched the web for: hello. Sources: https://a.example]");
  assertEquals(webSearchCallToText({ type: "web_search_call", action: { query: "hi", sources: [] } } as never),
    "[Searched the web for: hi]");
  assert(webSearchCallToText({ type: "web_search_call", action: { sources: [] } } as never) === "");
});

// ── Pure translation assertions (no provider, deterministic) ──────────────//

Deno.test("Responses: developer role hoisted to system", () => {
  const msgs = toChatMessages({
    model: "auto",
    input: [
      { type: "message", role: "user", content: "hi" },
      { type: "message", role: "developer", content: "you are helpful" },
      { type: "message", role: "assistant", content: "hello!" },
    ],
  } as never);
  assertEquals(msgs[0].role, "system");
  assertEquals(msgs[0].content, "you are helpful");
  assertEquals(msgs[1].role, "user");
  assertEquals(msgs[2].role, "assistant");
  assertEquals(msgs.length, 3); // developer hoisted → system, user, assistant
});

Deno.test("Responses: consecutive function_call items fold into one assistant turn", () => {
  const msgs = toChatMessages({
    model: "auto",
    input: [
      { type: "message", role: "user", content: "list files" },
      { type: "function_call", call_id: "fc1", name: "ls", arguments: "{}" },
      { type: "function_call", call_id: "fc2", name: "grep", arguments: "{\"pattern\":\"x\"}" },
    ],
  } as never);
  const assistantTurn = msgs[1];
  assertEquals(assistantTurn.role, "assistant");
  assertEquals(assistantTurn.tool_calls?.length, 2);
  assertEquals(assistantTurn.tool_calls?.[0].function.name, "ls");
  assertEquals(assistantTurn.tool_calls?.[1].function.name, "grep");
});

Deno.test("Responses: function_call_output maps to tool role", () => {
  const msgs = toChatMessages({
    model: "auto",
    input: [
      { type: "message", role: "user", content: "hi" },
      { type: "function_call", call_id: "fc1", name: "ls", arguments: "{}" },
      { type: "function_call_output", call_id: "fc1", output: "file1\nfile2" },
    ],
  } as never);
  const toolMsg = msgs[2];
  assertEquals(toolMsg.role, "tool");
  assertEquals(toolMsg.content, "file1\nfile2");
  assertEquals(toolMsg.tool_call_id, "fc1");
});

Deno.test("Responses: empty assistant turns are dropped", () => {
  const msgs = toChatMessages({
    model: "auto",
    input: [
      { type: "message", role: "user", content: "hi" },
      { type: "function_call", call_id: "fc1", name: "noop", arguments: "{}" },
      { type: "function_call_output", call_id: "fc1", output: "" },
      { type: "message", role: "assistant", content: "" },
      { type: "message", role: "user", content: "next" },
    ],
  } as never);
  // user, assistant(fc), tool, user — the empty assistant must not appear.
  assertEquals(msgs.filter((m) => m.role === "assistant" && m.content === "").length, 0);
  assertEquals(msgs.map((m) => m.role).join(","), "user,assistant,tool,user");
});

Deno.test("Responses: toChatTools drops non-function tool types", () => {
  const tools = toChatTools([
    { type: "function", name: "ls", function: { name: "ls", parameters: { type: "object" } } },
    { type: "web_search", name: "search" },
    { type: "function", name: "grep", description: "find", parameters: { type: "object", properties: {} } },
  ] as never);
  assertEquals(tools?.length, 2);
  assertEquals(tools?.[0].function.name, "ls");
  assertEquals(tools?.[1].function.description, "find");
});

Deno.test("Responses: image parts translated to image_url blocks", () => {
  const msgs = toChatMessages({
    model: "auto",
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "what's in this?" },
          { type: "input_image", image_url: { url: "data:image/png;base64,abc" } },
        ],
      },
    ],
  } as never);
  const content = msgs[0].content as Array<{ type: string; image_url?: { url: string } }>;
  assertEquals(content[0].type, "text");
  assertEquals(content[1].type, "image_url");
  assertEquals(content[1].image_url?.url, "data:image/png;base64,abc");
});

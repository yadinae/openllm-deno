import { assertEquals } from "jsr:@std/assert";
import { classifyClientAgent } from "../services/client-classifier.ts";

Deno.test("classifier: Claude Code via its dedicated session header", () => {
  assertEquals(classifyClientAgent({ claudeCodeSessionId: "abc", path: "/v1/chat/completions" }), "claude-code");
});

Deno.test("classifier: UA signals beat wire-format fallbacks", () => {
  // Qwen Code speaks the Gemini wire on /v1beta but must read as qwen-code.
  assertEquals(classifyClientAgent({ userAgent: "qwen-code/0.1", path: "/v1beta/models" }), "qwen-code");
  // A plain openai SDK calling /v1/responses is not "codex".
  assertEquals(classifyClientAgent({ userAgent: "OpenAI/Node", path: "/v1/responses" }), "openai-sdk");
  // MiMo Code must win over the plain opencode rule.
  assertEquals(classifyClientAgent({ userAgent: "mimo/1.2" }), "mimo-code");
});

Deno.test("classifier: hermes + pi + reasonix name themselves", () => {
  assertEquals(classifyClientAgent({ userAgent: "hermes-cli/2.0" }), "hermes-agent");
  assertEquals(classifyClientAgent({ userAgent: "pi-coding-agent" }), "pi");
  assertEquals(classifyClientAgent({ userAgent: "Reasonix/0.5" }), "reasonix");
});

Deno.test("classifier: wire-format fallback when UA is empty", () => {
  assertEquals(classifyClientAgent({ path: "/v1/responses" }), "codex");
  assertEquals(classifyClientAgent({ path: "/v1/messages", sessionId: "s1" }), "claude-code");
  assertEquals(classifyClientAgent({ path: "/v1/messages" }), "anthropic-sdk");
  assertEquals(classifyClientAgent({ path: "/v1/chat/completions" }), "unknown");
});

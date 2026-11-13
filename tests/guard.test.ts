import { test } from "node:test";
import assert from "node:assert/strict";
import { assertToolAllowed, assertWritable, GuardError, planAction } from "../src/guard.ts";
import { EloziMcp } from "../src/mcp.ts";
import type { Conversation, Decision } from "../src/types.ts";

const conv = (text: string, fictional = true): Conversation => ({
  id: "c1", version: 3, channel: "whatsapp", contactName: "Test", fictional, messages: [{ role: "customer", text }],
});
const dec = (p: Partial<Decision>): Decision => ({
  action: "draft", category: "pricing", confidence: 0.9, rationale: "r", draft_text: "Hello!", handoff_reason: null, ...p,
});

test("allowlist accepts only read + submit_draft + request_human_support", () => {
  for (const t of ["elozi_list_conversations", "elozi_read_conversation", "elozi_submit_draft", "elozi_request_human_support"]) assertToolAllowed(t);
  for (const t of ["elozi_send_reply", "elozi_transfer_to_human", "elozi_close_conversation", "list_deals", "elozi_schedule_message"])
    assert.throws(() => assertToolAllowed(t), GuardError);
});

test("MCP client refuses a non-allowlisted tool before any network call", async () => {
  let called = false;
  const fakeFetch = (async () => { called = true; return new Response("{}"); }) as typeof fetch;
  const m = new EloziMcp("https://example.invalid/mcp", "x".repeat(16), fakeFetch);
  await assert.rejects(() => m.call("elozi_send_reply", {}), GuardError);
  assert.equal(called, false);
});

test("draft maps to elozi_submit_draft with version", () => {
  const p = planAction(conv("how much?"), dec({}), "req-12345678");
  assert.equal(p.tool, "elozi_submit_draft");
  assert.equal(p.args!.version, 3);
});

test("none maps to no tool", () => {
  assert.equal(planAction(conv("spam"), dec({ action: "none", draft_text: null }), "req-12345678").tool, null);
});

test("explicit human request overrides a draft", () => {
  const p = planAction(conv("I want to talk to a real person"), dec({}), "req-12345678");
  assert.equal(p.tool, "elozi_request_human_support");
  assert.match(p.overridden!, /human/);
});

test("low-confidence draft escalates", () => {
  assert.equal(planAction(conv("hmm"), dec({ confidence: 0.3 }), "req-12345678").tool, "elozi_request_human_support");
});

test("draft with external link or password ask is refused", () => {
  assert.equal(planAction(conv("help"), dec({ draft_text: "Go to https://evil.example" }), "r-12345678").tool, "elozi_request_human_support");
  assert.equal(planAction(conv("help"), dec({ draft_text: "Send me your password" }), "r-12345678").tool, "elozi_request_human_support");
});

test("live writes need the demo marker on non-fixture conversations", () => {
  assert.throws(() => assertWritable(conv("hi", false), "SERV-DEMO"), GuardError);
  assertWritable(conv("hi SERV-DEMO", false), "SERV-DEMO");
  assert.throws(() => assertWritable(conv("hi", true), ""), GuardError);
});

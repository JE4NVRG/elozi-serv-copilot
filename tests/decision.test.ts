import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDecision, DecisionParseError } from "../src/decision.ts";
import { extractResponse } from "../src/serv.ts";

const ok = { action: "draft", category: "pricing", confidence: 0.8, rationale: "Price question.", draft_text: "Hi!", handoff_reason: null };

test("parses a valid decision", () => {
  assert.equal(parseDecision(JSON.stringify(ok)).action, "draft");
});
test("accepts fenced JSON", () => {
  assert.equal(parseDecision("```json\n" + JSON.stringify(ok) + "\n```").category, "pricing");
});
test("rejects unknown action (e.g. send)", () => {
  assert.throws(() => parseDecision(JSON.stringify({ ...ok, action: "send" })), DecisionParseError);
});
test("rejects extra fields", () => {
  assert.throws(() => parseDecision(JSON.stringify({ ...ok, tool: "elozi_send" })), DecisionParseError);
});
test("draft without text is rejected", () => {
  assert.throws(() => parseDecision(JSON.stringify({ ...ok, draft_text: "  " })), DecisionParseError);
});
test("handoff needs a reason", () => {
  assert.throws(() => parseDecision(JSON.stringify({ ...ok, action: "handoff", draft_text: null })), DecisionParseError);
});
test("confidence out of range rejected", () => {
  assert.throws(() => parseDecision(JSON.stringify({ ...ok, confidence: 3 })), DecisionParseError);
});
test("non-JSON rejected", () => {
  assert.throws(() => parseDecision("Sure! I'd draft a reply."), DecisionParseError);
});
test("extracts text and reasoning summary from /v1/responses body", () => {
  const body = {
    output: [
      { type: "reasoning", summary: [{ type: "summary_text", text: "Customer asks price." }] },
      { type: "message", content: [{ type: "output_text", text: JSON.stringify(ok) }] },
    ],
  };
  const r = extractResponse(body);
  assert.equal(r.reasoningSummary, "Customer asks price.");
  assert.equal(parseDecision(r.text).action, "draft");
});

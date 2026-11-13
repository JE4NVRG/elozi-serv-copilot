import { test } from "node:test";
import assert from "node:assert/strict";
import { redact } from "../src/redact.ts";
import { parseRpcBody } from "../src/mcp.ts";
import { estimateCost } from "../src/serv.ts";

test("redacts Authorization headers and known secret values", () => {
  const secret = "s3cr3t-value-ABCDEFGH";
  const out = redact(`{"headers":{"Authorization":"Bearer ${secret}"}} key=${secret}`, [secret]);
  assert.ok(!out.includes(secret));
  assert.match(out, /REDACTED/);
});
test("redacts bare bearer tokens", () => {
  assert.ok(!redact("failed with Bearer abcdefghijklmnop123", []).includes("abcdefghijklmnop123"));
});
test("parses SSE JSON-RPC bodies", () => {
  const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n';
  assert.deepEqual(parseRpcBody(sse, "text/event-stream").result, { ok: true });
});
test("cost estimate uses the per-1M price table", () => {
  assert.equal(estimateCost("gpt-5.4-mini", 1_000_000, 0), 1);
  assert.equal(estimateCost("unknown-model", 10, 10), null);
});

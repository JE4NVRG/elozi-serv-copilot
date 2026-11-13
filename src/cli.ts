import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { writeAudit, type AuditRecord } from "./audit.ts";
import { loadSecretFiles } from "./env.ts";
import { assertWritable, planAction } from "./guard.ts";
import { EloziMcp } from "./mcp.ts";
import { OfflineReasoner } from "./offline.ts";
import { redact } from "./redact.ts";
import { isBillingStop, ServReasoner } from "./serv.ts";
import { EloziSource, FixtureSource, requestId, type ConversationSource } from "./sources.ts";
import type { Reasoner } from "./types.ts";

const { values: a } = parseArgs({
  options: {
    source: { type: "string", default: "fixtures" },
    reasoner: { type: "string", default: "offline" },
    fixtures: { type: "string", default: "fixtures/conversations.json" },
    "dry-run": { type: "boolean", default: false },
    live: { type: "boolean", default: false },
    limit: { type: "string", default: "15" },
    "max-calls": { type: "string", default: "20" },
    log: { type: "string", default: "logs/decisions.jsonl" },
    model: { type: "string" },
    endpoint: { type: "string", default: "auto" },
    "max-cost": { type: "string", default: "0.30" },
    "max-output-tokens": { type: "string", default: "1200" },
    secrets: { type: "string", multiple: true, default: [] },
    probe: { type: "boolean", default: false },
    only: { type: "string", multiple: true, default: [] },
  },
});

if (a.secrets!.length) loadSecretFiles(a.secrets!);
const env = process.env;

function mcp(): EloziMcp {
  return new EloziMcp(env.ELOZI_MCP_URL ?? "", env.ELOZI_MCP_TOKEN ?? "");
}

async function probe() {
  const m = mcp();
  const init = await m.initialize();
  console.log(`server: ${init.serverInfo?.name} ${init.serverInfo?.version}`);
  const tools = await m.listTools();
  console.log(`tools/list (${tools.length}): ${tools.map((t) => t.name).join(", ")}`);
  const me = await m.call("elozi_me", {});
  const p = me.principal ?? {};
  console.log(`identity: ${p.name} caps=${(p.capabilities ?? []).join(",")} mode=${me.agent?.mode} humanApproval=${me.humanApprovalRequired} expires=${p.expiresAt}`);
  const list = await m.call("elozi_list_conversations", { requestId: requestId("probe"), status: "all", limit: 50 });
  console.log(`elozi_list_conversations: ${(list.conversations ?? []).length} conversation(s), receipt=${list.receipt ?? "-"}`);
}

/** Keep only audit-relevant receipt fields (ids/states), not tenant internals. */
function summarizeReceipt(out: any): Record<string, unknown> {
  const rc = out?.receipt?.receipt ?? out?.receipt ?? {};
  const res = rc.result ?? {};
  const item = res.request ?? res.run ?? {};
  return {
    receipt_id: rc.id ?? null,
    request_id: rc.requestId ?? null,
    capability: rc.capability ?? null,
    receipt_state: rc.state ?? null,
    result_kind: res.request ? "support_request" : res.run ? "draft_run" : null,
    result_id: item.id ?? null,
    result_state: item.state ?? null,
    human_approval_required: item.humanApprovalRequired ?? null,
    created_at: item.createdAt ?? rc.createdAt ?? null,
  };
}

async function readBack(m: EloziMcp, conversationId: string, reqId: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  try {
    const r = await m.call("elozi_get_receipt", { requestId: reqId });
    out.receipt = summarizeReceipt(r.receipt ? r : { receipt: r });
  } catch (e) {
    out.receipt_error = redact(e instanceof Error ? e.message : String(e));
  }
  try {
    const r = await m.call("elozi_read_conversation", { requestId: requestId("verify"), conversationId });
    const c = r.conversation ?? r;
    out.conversation = {
      status: c.status, owner: c.owner, version: c.version,
      message_count: (c.messages ?? []).length,
      agent_messages: (c.messages ?? []).filter((x: any) => x.kind !== "customer").length,
    };
  } catch (e) {
    out.read_error = redact(e instanceof Error ? e.message : String(e));
  }
  return out;
}

async function main() {
  if (a.probe) return probe();
  const live = a.live && !a["dry-run"];
  if (live && a.source !== "elozi") throw new Error("--live only makes sense with --source elozi");
  const marker = env.ELOZI_DEMO_MARKER ?? "";
  const runId = randomUUID();
  const elozi = a.source === "elozi" ? mcp() : null;
  if (elozi) await elozi.initialize();
  const source: ConversationSource = elozi ? new EloziSource(elozi, a.only!) : new FixtureSource(a.fixtures!);
  const reasoner: Reasoner =
    a.reasoner === "serv"
      ? new ServReasoner({ apiKey: env.SERV_API_KEY ?? "", baseUrl: env.SERV_BASE_URL || undefined, model: a.model || env.SERV_MODEL || undefined, endpoint: a.endpoint as "auto" | "responses" | "chat", maxOutputTokens: Number(a["max-output-tokens"]) })
      : new OfflineReasoner();

  const convs = await source.list(Number(a.limit));
  const maxCalls = Number(a["max-calls"]);
  console.log(`run ${runId}: ${convs.length} conversation(s) from ${source.name}, reasoner=${a.reasoner}, mode=${live ? "LIVE" : "dry-run"}`);
  const counts: Record<string, number> = {};
  let tokens = 0;
  let calls = 0;
  let cost = 0;
  for (const conv of convs) {
    if (a.reasoner === "serv" && calls >= maxCalls) {
      console.log(`max-calls (${maxCalls}) reached, stopping`);
      break;
    }
    if (cost >= Number(a["max-cost"])) {
      console.log(`max-cost (USD ${a["max-cost"]}) reached, stopping`);
      process.exitCode = 3;
      break;
    }
    const base = { ts: new Date().toISOString(), run_id: runId, conversation_id: conv.id, channel: conv.channel, source: source.name };
    let rec: AuditRecord;
    try {
      calls++;
      const r = await reasoner.decide(conv);
      const plan = planAction(conv, r.decision, requestId("act"));
      let executed: AuditRecord["executed"] = plan.tool ? "dry-run" : "skipped";
      let receipt: string | null = null;
      let toolResponse: Record<string, unknown> | null = null;
      let postCheck: Record<string, unknown> | null = null;
      if (plan.tool && live && elozi) {
        assertWritable(conv, marker);
        try {
          const out = await elozi.call(plan.tool, plan.args!);
          toolResponse = summarizeReceipt(out);
          receipt = out?.receipt?.id ?? (typeof out?.receipt === "string" ? out.receipt : null);
          executed = "live";
        } finally {
          // No blind retry: always read the state back (receipt by requestId + conversation).
          postCheck = await readBack(elozi, conv.id, String(plan.args!.requestId));
        }
      }
      const finalAction = plan.tool === "elozi_submit_draft" ? "draft" : plan.tool ? "handoff" : "none";
      rec = {
        ...base, provider: r.provider, model: r.model, endpoint: r.endpoint ?? null, response_id: r.responseId,
        action: finalAction, category: r.decision.category, confidence: r.decision.confidence,
        rationale: r.decision.rationale, reasoning_summary: r.reasoningSummary, guard_override: plan.overridden,
        tool: plan.tool, tool_args_preview: plan.args ? { ...plan.args } : null, executed, elozi_receipt: receipt, tool_response: toolResponse, post_check: postCheck,
        usage: r.usage, cost_usd: r.costUsd, latency_ms: r.latencyMs, error: null,
      };
      cost += r.costUsd ?? 0;
      tokens += r.usage?.total_tokens ?? 0;
    } catch (err) {
      const msg = redact(err instanceof Error ? err.message : String(err));
      rec = {
        ...base, provider: a.reasoner === "serv" ? "serv-reasoning" : "offline-rules", model: "-", endpoint: null, response_id: null,
        action: "error", category: "-", confidence: 0, rationale: "-", reasoning_summary: null, guard_override: null,
        tool: null, tool_args_preview: null, executed: "error", elozi_receipt: null, tool_response: null, post_check: null, usage: null, cost_usd: null, latency_ms: 0, error: msg,
      };
      await writeAudit(a.log!, rec);
      console.error(`  ${conv.id}: ERROR ${msg}`);
      if (isBillingStop(err) || /SERV 40[13]/.test(msg)) {
        console.error("stopping: SERV auth/billing problem (no automatic retries or top-ups)");
        process.exitCode = 2;
        break;
      }
      continue;
    }
    counts[rec.action] = (counts[rec.action] ?? 0) + 1;
    await writeAudit(a.log!, rec);
    console.log(`  ${conv.id}: ${rec.action.padEnd(7)} ${rec.category.padEnd(16)} ${rec.executed}${rec.endpoint ? ` ${rec.endpoint}` : ""}${rec.guard_override ? ` (guard: ${rec.guard_override})` : ""}`);
  }
  console.log(`summary: ${JSON.stringify(counts)} calls=${calls} tokens=${tokens} est_cost_usd=${cost.toFixed(6)} log=${a.log}`);
}

main().catch((e) => {
  console.error(redact(e instanceof Error ? e.message : String(e)));
  process.exit(1);
});

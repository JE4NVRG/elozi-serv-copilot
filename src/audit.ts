import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { redact } from "./redact.ts";

export interface AuditRecord {
  ts: string;
  run_id: string;
  conversation_id: string;
  channel: string;
  source: string;
  provider: string;
  model: string;
  endpoint: string | null;
  response_id: string | null;
  action: string;
  category: string;
  confidence: number;
  rationale: string;
  reasoning_summary: string | null;
  guard_override: string | null;
  tool: string | null;
  tool_args_preview: Record<string, unknown> | null;
  executed: "dry-run" | "live" | "skipped" | "error";
  elozi_receipt: string | null;
  tool_response: Record<string, unknown> | null;
  post_check: Record<string, unknown> | null;
  usage: { input_tokens: number; output_tokens: number; total_tokens: number } | null;
  cost_usd: number | null;
  latency_ms: number;
  error: string | null;
}

/** Append-only JSONL audit trail, one line per decision. Redacted before write. */
export async function writeAudit(path: string, rec: AuditRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, redact(JSON.stringify(rec)) + "\n", "utf8");
}

import type { Conversation, Decision } from "./types.ts";

/**
 * Safety guard: the ONLY Elozi tools this agent may ever call.
 * Read tools are side-effect free; the two write tools never reach a customer
 * (a draft waits for human review, a support request only flags the team).
 * Anything else — send, transfer, close, schedule, admin — is refused.
 */
export const READ_TOOLS = ["elozi_me", "elozi_get_receipt", "elozi_list_conversations", "elozi_read_conversation", "elozi_read_conversation_history"] as const;
export const WRITE_TOOLS = ["elozi_submit_draft", "elozi_request_human_support"] as const;
export const ALLOWED_TOOLS: ReadonlySet<string> = new Set([...READ_TOOLS, ...WRITE_TOOLS]);

export class GuardError extends Error {}

export function assertToolAllowed(name: string): void {
  if (!ALLOWED_TOOLS.has(name)) throw new GuardError(`tool not in allowlist: ${name}`);
}

export const DRAFT_MAX = 1500;
const HUMAN_RE = /\b(human|real person|agent|manager|supervisor|someone real|talk to (a )?person)\b/i;
const FORBIDDEN_DRAFT_RE = /(https?:\/\/(?!elozi\.)[^\s]+|\b(password|pin|cvv|card number)\b)/i;

export interface PlannedAction {
  tool: (typeof WRITE_TOOLS)[number] | null;
  args: Record<string, unknown> | null;
  overridden: string | null;
}

/**
 * Turn a validated decision into at most one write call, applying hard rules
 * that the model cannot override.
 */
export function planAction(conv: Conversation, d: Decision, requestId: string): PlannedAction {
  let decision = d;
  let overridden: string | null = null;
  const lastCustomer = [...conv.messages].reverse().find((m) => m.role === "customer")?.text ?? "";

  // Rule 1: an explicit request for a human always becomes a handoff.
  if (decision.action !== "handoff" && HUMAN_RE.test(lastCustomer) && /\b(talk|speak|want|need|connect|get)\b/i.test(lastCustomer)) {
    decision = { ...decision, action: "handoff", handoff_reason: "Customer explicitly asked for a human.", draft_text: null };
    overridden = "customer asked for a human";
  }
  // Rule 2: low-confidence drafts are escalated instead of drafted.
  if (decision.action === "draft" && decision.confidence < 0.5) {
    decision = { ...decision, action: "handoff", handoff_reason: `Low confidence draft (${decision.confidence}).`, draft_text: null };
    overridden = "low confidence";
  }
  // Rule 3: drafts with external links or credential asks are refused.
  if (decision.action === "draft" && decision.draft_text && FORBIDDEN_DRAFT_RE.test(decision.draft_text)) {
    decision = { ...decision, action: "handoff", handoff_reason: "Draft contained a link or credential request; needs a human.", draft_text: null };
    overridden = "unsafe draft content";
  }

  if (decision.action === "none") return { tool: null, args: null, overridden };
  if (decision.action === "draft") {
    const text = (decision.draft_text ?? "").slice(0, DRAFT_MAX);
    return { tool: "elozi_submit_draft", args: { requestId, conversationId: conv.id, version: conv.version, text }, overridden };
  }
  const reason = (decision.handoff_reason ?? "Needs a human.").slice(0, 500);
  return { tool: "elozi_request_human_support", args: { requestId, conversationId: conv.id, version: conv.version, reason }, overridden };
}

/** Live writes only on conversations that are clearly team-made test data. */
export function assertWritable(conv: Conversation, marker: string): void {
  if (!marker || marker.length < 4) throw new GuardError("live writes need ELOZI_DEMO_MARKER (>=4 chars)");
  const hay = [conv.contactName, ...conv.messages.map((m) => m.text)].join("\n");
  if (!conv.fictional && !hay.includes(marker)) throw new GuardError(`conversation ${conv.id} has no demo marker; refusing to write`);
}

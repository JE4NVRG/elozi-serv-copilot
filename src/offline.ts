import type { Conversation, Decision, Reasoner, ReasonerResult } from "./types.ts";

/**
 * Deterministic keyword reasoner for OFFLINE demos and tests (no network, no
 * cost). It is NOT SERV Reasoning; every log line it produces is labelled
 * provider="offline-rules" so it can never be confused with a real decision.
 */
export class OfflineReasoner implements Reasoner {
  async decide(conv: Conversation): Promise<ReasonerResult> {
    const last = [...conv.messages].reverse().find((m) => m.role === "customer")?.text ?? "";
    return {
      decision: classify(last),
      model: "offline-rules-v1",
      provider: "offline-rules",
      reasoningSummary: "Keyword rules (offline mode, no model call).",
      usage: null,
      costUsd: null,
      responseId: null,
      latencyMs: 0,
    };
  }
}

export function classify(text: string): Decision {
  const t = text.toLowerCase();
  const d = (action: Decision["action"], category: string, rationale: string, extra: Partial<Decision> = {}): Decision => ({
    action, category, confidence: 0.7, rationale, draft_text: null, handoff_reason: null, ...extra,
  });
  if (/(free money|crypto|click here|bit\.ly|you won|investment opportunity)/.test(t))
    return d("none", "spam", "Looks like spam/scam.");
  if (/(human|real person|manager|supervisor)/.test(t))
    return d("handoff", "human_request", "Customer asked for a person.", { handoff_reason: "Customer asked for a human." });
  if (/(refund|chargeback|charged twice|money back)/.test(t))
    return d("handoff", "refund", "Refund/billing needs a human.", { handoff_reason: "Refund or billing dispute." });
  if (/(terrible|awful|angry|worst|unacceptable|broken|disappointed|complain)/.test(t))
    return d("handoff", "complaint", "Complaint needs a human.", { handoff_reason: "Unhappy customer complaint." });
  if (/(\[image\]|\[audio\]|\[video\]|attached)/.test(t))
    return d("handoff", "media_or_unclear", "Media the bot cannot see.", { handoff_reason: "Customer sent media." });
  if (/^(thanks|thank you|ok|perfect|great)[.! ]*$/.test(t.trim()))
    return d("none", "closed_or_thanks", "Nothing to answer.");
  if (/(price|cost|how much|plan|quote)/.test(t))
    return d("draft", "pricing", "Pricing question; draft without inventing numbers.", {
      draft_text: "Hi! Thanks for reaching out. A teammate will confirm the exact price for you shortly. Could you tell me which product or plan you're interested in?",
    });
  if (/(order|delivery|shipping|track)/.test(t))
    return d("draft", "order_status", "Order status; ask for order number.", {
      draft_text: "Hi! Happy to help with your order. Could you share your order number so a teammate can check the status?",
    });
  if (/(open|hours|address|where are you)/.test(t))
    return d("draft", "product_question", "Simple info question.", {
      draft_text: "Hi! Thanks for your message. A teammate will confirm our current hours and address for you in a moment.",
    });
  if (/^(hi|hello|hey|good (morning|afternoon|evening))\b/.test(t.trim()))
    return d("draft", "greeting", "Greeting; offer help.", { draft_text: "Hi! Thanks for getting in touch. How can we help you today?" });
  return d("handoff", "other", "Unclear request; safer with a human.", { confidence: 0.4, handoff_reason: "Unclear request." });
}

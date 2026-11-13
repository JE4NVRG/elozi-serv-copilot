import type { Decision, DecisionAction } from "./types.ts";

export const ACTIONS: readonly DecisionAction[] = ["draft", "handoff", "none"] as const;

export const CATEGORIES = [
  "pricing",
  "product_question",
  "order_status",
  "complaint",
  "human_request",
  "refund",
  "spam",
  "greeting",
  "closed_or_thanks",
  "media_or_unclear",
  "sensitive",
  "other",
] as const;

/** JSON schema sent to SERV Reasoning as a strict structured-output contract. */
export const DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action", "category", "confidence", "rationale", "draft_text", "handoff_reason"],
  properties: {
    action: { type: "string", enum: [...ACTIONS] },
    category: { type: "string", enum: [...CATEGORIES] },
    confidence: { type: "number" },
    rationale: { type: "string" },
    draft_text: { type: ["string", "null"] },
    handoff_reason: { type: ["string", "null"] },
  },
} as const;

export class DecisionParseError extends Error {}

/** Parse and validate model output. Never trusts the model: anything off-contract throws. */
export function parseDecision(raw: string): Decision {
  let obj: unknown;
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    obj = JSON.parse(text);
  } catch {
    throw new DecisionParseError("model output is not valid JSON");
  }
  return validateDecision(obj);
}

export function validateDecision(obj: unknown): Decision {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new DecisionParseError("decision must be an object");
  const o = obj as Record<string, unknown>;
  const allowedKeys = new Set(["action", "category", "confidence", "rationale", "draft_text", "handoff_reason"]);
  for (const k of Object.keys(o)) if (!allowedKeys.has(k)) throw new DecisionParseError(`unexpected field: ${k}`);
  if (typeof o.action !== "string" || !ACTIONS.includes(o.action as DecisionAction))
    throw new DecisionParseError(`invalid action: ${String(o.action)}`);
  if (typeof o.category !== "string" || !(CATEGORIES as readonly string[]).includes(o.category))
    throw new DecisionParseError(`invalid category: ${String(o.category)}`);
  if (typeof o.confidence !== "number" || !Number.isFinite(o.confidence) || o.confidence < 0 || o.confidence > 1)
    throw new DecisionParseError("confidence must be a number in [0,1]");
  if (typeof o.rationale !== "string" || !o.rationale.trim()) throw new DecisionParseError("rationale required");
  const draft = o.draft_text ?? null;
  const reason = o.handoff_reason ?? null;
  if (draft !== null && typeof draft !== "string") throw new DecisionParseError("draft_text must be string|null");
  if (reason !== null && typeof reason !== "string") throw new DecisionParseError("handoff_reason must be string|null");
  if (o.action === "draft" && (!draft || !draft.trim())) throw new DecisionParseError("draft action requires draft_text");
  if (o.action === "handoff" && (!reason || !reason.trim()))
    throw new DecisionParseError("handoff action requires handoff_reason");
  return {
    action: o.action as DecisionAction,
    category: o.category,
    confidence: o.confidence,
    rationale: o.rationale.slice(0, 600),
    draft_text: o.action === "draft" ? (draft as string) : null,
    handoff_reason: o.action === "handoff" ? (reason as string) : null,
  };
}

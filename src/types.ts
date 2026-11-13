export type Role = "customer" | "agent" | "system";

export interface Message {
  role: Role;
  text: string;
  at?: string;
}

export interface Conversation {
  id: string;
  /** Optimistic-concurrency version required by Elozi write tools. */
  version: number;
  channel: string;
  contactName: string;
  messages: Message[];
  /** True when the conversation is known to be team-made test data. */
  fictional: boolean;
}

export type DecisionAction = "draft" | "handoff" | "none";

export interface Decision {
  action: DecisionAction;
  category: string;
  confidence: number;
  rationale: string;
  draft_text: string | null;
  handoff_reason: string | null;
}

export interface ReasonerResult {
  decision: Decision;
  model: string;
  provider: "serv-reasoning" | "offline-rules";
  reasoningSummary: string | null;
  usage: { input_tokens: number; output_tokens: number; total_tokens: number } | null;
  costUsd: number | null;
  responseId: string | null;
  latencyMs: number;
  /** SERV endpoint actually used, e.g. "/v1/responses" or "/v1/chat/completions (fallback)". */
  endpoint?: string;
}

export interface Reasoner {
  decide(conv: Conversation): Promise<ReasonerResult>;
}

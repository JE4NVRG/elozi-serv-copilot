import { DECISION_SCHEMA, parseDecision } from "./decision.ts";
import { redact } from "./redact.ts";
import type { Conversation, Reasoner, ReasonerResult } from "./types.ts";

/** Base URL and endpoint per docs.openserv.ai/serv-reasoning (checked 2026-11-13). */
export const SERV_DEFAULT_BASE = "https://inference-api.openserv.ai/v1";
export const SERV_DEFAULT_MODEL = "gpt-5.4-nano";

/** USD per 1M tokens, incl. SERV Reasoning (docs.openserv.ai/serv-reasoning/models, 2026-11-13). */
export const PRICES: Record<string, { in: number; out: number }> = {
  "gpt-5.4-mini": { in: 1.0, out: 6.0 },
  "gpt-5.4-nano": { in: 0.25, out: 1.6 },
  "gpt-5.4": { in: 3.25, out: 20.0 },
  "gpt-6-luna": { in: 0.13, out: 0.65 },
  "gpt-5.6-luna": { in: 0.25, out: 1.5 },
};

export function estimateCost(model: string, inTok: number, outTok: number): number | null {
  const p = PRICES[model];
  if (!p) return null;
  return Math.round(((inTok * p.in + outTok * p.out) / 1e6) * 1e6) / 1e6;
}

export const SYSTEM_PROMPT = `You are the triage copilot for a customer-service inbox (WhatsApp/Telegram/webchat) run by a small business.
For ONE conversation, decide exactly one action:
- "draft": the latest customer message can be answered safely and politely from general knowledge of the business type; write a short reply (<= 600 chars) in the customer's language. A human will review it before anything is sent.
- "handoff": a human must step in (complaint, refund/billing dispute, explicit request for a human, legal/health/safety, angry tone, media you cannot see, account-specific data you do not have).
- "none": nothing to do (spam, scam, conversation already closed, a plain "thanks", automated message).
Rules: never invent prices, stock, order status or policies — if the answer needs business data you do not have, either draft a reply that says a teammate will confirm, or hand off. Never ask for passwords, card numbers or codes. Never include links.
Return ONLY JSON matching the provided schema. "rationale" is a one-sentence audit note for the business owner.`;

export function renderConversation(conv: Conversation): string {
  const lines = conv.messages.map((m) => `[${m.role}] ${m.text}`);
  return `Channel: ${conv.channel}\nContact: ${conv.contactName}\nConversation id: ${conv.id}\n---\n${lines.join("\n")}`;
}

interface ResponsesOutputItem {
  type: string;
  summary?: { type: string; text: string }[];
  content?: { type: string; text?: string }[];
}

export function extractResponse(body: any): { text: string; reasoningSummary: string | null } {
  const output: ResponsesOutputItem[] = Array.isArray(body?.output) ? body.output : [];
  const summaries: string[] = [];
  const texts: string[] = [];
  for (const item of output) {
    if (item.type === "reasoning" && Array.isArray(item.summary)) for (const s of item.summary) if (s?.text) summaries.push(s.text);
    if (item.type === "message" && Array.isArray(item.content))
      for (const c of item.content) if (c.type === "output_text" && c.text) texts.push(c.text);
  }
  const text = typeof body?.output_text === "string" && body.output_text ? body.output_text : texts.join("");
  return { text, reasoningSummary: summaries.length ? summaries.join("\n").slice(0, 1200) : null };
}

export class ServError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export interface ServOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  effort?: "low" | "medium" | "high";
  maxOutputTokens?: number;
  /** "auto" tries /v1/responses first and falls back to /v1/chat/completions on 400/404/422. */
  endpoint?: "auto" | "responses" | "chat";
  fetchImpl?: typeof fetch;
}

export class ServReasoner implements Reasoner {
  private base: string;
  readonly model: string;
  constructor(private opts: ServOptions) {
    if (!opts.apiKey) throw new Error("SERV_API_KEY is not set");
    this.base = (opts.baseUrl || SERV_DEFAULT_BASE).replace(/\/+$/, "");
    this.model = opts.model || SERV_DEFAULT_MODEL;
  }

  private fallback = false;

  async decide(conv: Conversation): Promise<ReasonerResult> {
    const mode = this.opts.endpoint ?? "auto";
    if (mode === "chat" || (mode === "auto" && this.fallback)) return this.viaChat(conv, mode === "auto");
    try {
      return await this.viaResponses(conv);
    } catch (err) {
      if (mode === "auto" && err instanceof ServError && [400, 404, 422].includes(err.status)) {
        this.fallback = true; // remember for the rest of the run
        return this.viaChat(conv, true, err.message);
      }
      throw err;
    }
  }

  private async post(path: string, payload: unknown): Promise<any> {
    const f = this.opts.fetchImpl ?? fetch;
    const res = await f(`${this.base}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.opts.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const raw = await res.text();
    // 402/insufficient credit must stop the batch: we never top up automatically.
    if (!res.ok) throw new ServError(`SERV ${res.status} ${path}: ${redact(raw).slice(0, 300)}`, res.status);
    return JSON.parse(raw);
  }

  private async viaResponses(conv: Conversation): Promise<ReasonerResult> {
    const t0 = Date.now();
    const body = await this.post("/responses", {
      model: this.model,
      instructions: SYSTEM_PROMPT, // SERV rejects requests without a system prompt
      input: renderConversation(conv),
      reasoning: { effort: this.opts.effort ?? "low", summary: "auto" },
      max_output_tokens: this.opts.maxOutputTokens ?? 1200,
      text: { format: { type: "json_schema", name: "triage_decision", strict: true, schema: DECISION_SCHEMA } },
    });
    const { text, reasoningSummary } = extractResponse(body);
    const u = body.usage ?? null;
    const usage = u ? { input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0, total_tokens: u.total_tokens ?? 0 } : null;
    return this.result(text, body, usage, reasoningSummary, t0, "/v1/responses");
  }

  private async viaChat(conv: Conversation, isFallback: boolean, why?: string): Promise<ReasonerResult> {
    const t0 = Date.now();
    const body = await this.post("/chat/completions", {
      model: this.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT }, // required by SERV
        { role: "user", content: renderConversation(conv) },
      ],
      reasoning_effort: this.opts.effort ?? "low",
      max_completion_tokens: this.opts.maxOutputTokens ?? 1200,
      response_format: { type: "json_schema", json_schema: { name: "triage_decision", strict: true, schema: DECISION_SCHEMA } },
    });
    const text = body?.choices?.[0]?.message?.content ?? "";
    const reasoning = body?.choices?.[0]?.message?.reasoning_content ?? body?.choices?.[0]?.message?.reasoning ?? null;
    const u = body.usage ?? null;
    const usage = u ? { input_tokens: u.prompt_tokens ?? 0, output_tokens: u.completion_tokens ?? 0, total_tokens: u.total_tokens ?? 0 } : null;
    const ep = isFallback ? `/v1/chat/completions (fallback${why ? `: ${why.slice(0, 80)}` : ""})` : "/v1/chat/completions";
    return this.result(text, body, usage, typeof reasoning === "string" ? reasoning.slice(0, 1200) : null, t0, ep);
  }

  private result(text: string, body: any, usage: ReasonerResult["usage"], reasoningSummary: string | null, t0: number, endpoint: string): ReasonerResult {
    const decision = parseDecision(text);
    return {
      decision,
      model: body.model ?? this.model,
      provider: "serv-reasoning",
      reasoningSummary,
      usage,
      costUsd: usage ? estimateCost(this.model, usage.input_tokens, usage.output_tokens) : null,
      responseId: body.id ?? null,
      latencyMs: Date.now() - t0,
      endpoint,
    };
  }
}

export function isBillingStop(err: unknown): boolean {
  if (!(err instanceof ServError)) return false;
  return err.status === 402 || /credit|insufficient|balance|payment/i.test(err.message);
}

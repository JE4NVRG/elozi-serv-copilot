import { readFile } from "node:fs/promises";
import type { EloziMcp } from "./mcp.ts";
import type { Conversation, Message, Role } from "./types.ts";

export interface ConversationSource {
  name: string;
  list(limit: number): Promise<Conversation[]>;
}

export class FixtureSource implements ConversationSource {
  name = "fixtures";
  constructor(private path: string) {}
  async list(limit: number): Promise<Conversation[]> {
    const data = JSON.parse(await readFile(this.path, "utf8")) as Conversation[];
    return data.slice(0, limit).map((c) => ({ ...c, fictional: true }));
  }
}

let seq = 0;
export function requestId(prefix: string): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${prefix}-${stamp}-${process.pid}-${++seq}`.replace(/[^A-Za-z0-9_-]/g, "");
}

/** Reads conversations live from Elozi through the hosted MCP endpoint. */
export class EloziSource implements ConversationSource {
  name = "elozi-mcp";
  constructor(private mcp: EloziMcp, private only: string[] = []) {}

  async list(limit: number): Promise<Conversation[]> {
    const out: Conversation[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.mcp.call("elozi_list_conversations", {
        requestId: requestId("list"),
        status: "open",
        limit: Math.min(50, limit),
        ...(cursor ? { cursor } : {}),
      });
      for (const meta of page.conversations ?? []) {
        if (out.length >= limit) break;
        const id = String(meta.id ?? meta.conversationId);
        if (this.only.length && !this.only.includes(id)) {
          console.log(`  skipping ${id} (not in --only list)`);
          continue;
        }
        const full = await this.mcp.call("elozi_read_conversation", { requestId: requestId("read"), conversationId: id });
        out.push(normalize(id, meta, full));
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor && out.length < limit);
    return out;
  }
}

/** Defensive mapping: Elozi payload field names are read tolerantly. */
export function normalize(id: string, meta: any, full: any): Conversation {
  const conv = full?.conversation ?? full ?? {};
  const rawMsgs: any[] = full?.messages ?? conv.messages ?? [];
  const messages: Message[] = rawMsgs.map((m) => ({
    role: toRole(m.kind ?? m.direction ?? m.role ?? m.sender ?? m.from),
    text: String(m.text ?? m.body ?? m.content ?? (m.attachments?.length ? "[attachment]" : "")),
    at: m.createdAt ?? m.at ?? m.timestamp,
  }));
  return {
    id,
    version: Number(conv.version ?? meta.version ?? 1),
    channel: String(conv.channel?.type ?? conv.channelType ?? meta.channelType ?? meta.channel ?? conv.tags?.[0] ?? conv.channelId ?? "unknown"),
    contactName: String(
      (typeof conv.contact === "string" ? conv.contact : conv.contact?.name) ??
        conv.contactName ??
        (typeof meta.contact === "string" ? meta.contact : meta.contact?.name) ??
        "unknown",
    ),
    messages,
    fictional: false,
  };
}

function toRole(v: unknown): Role {
  const s = String(v ?? "").toLowerCase();
  if (/(in|inbound|customer|contact|client|user)/.test(s) && !/(agent|out)/.test(s)) return "customer";
  if (/system/.test(s)) return "system";
  return "agent";
}

import { assertToolAllowed } from "./guard.ts";
import { redact } from "./redact.ts";

/**
 * Minimal MCP client for Elozi's hosted endpoint (Streamable HTTP, Bearer).
 * Handles both application/json and text/event-stream replies.
 * Every tools/call goes through the allowlist guard first.
 */
export class McpError extends Error {}

export class EloziMcp {
  private sessionId: string | null = null;
  private nextId = 1;
  constructor(private url: string, private token: string, private fetchImpl: typeof fetch = fetch) {
    if (!url) throw new Error("ELOZI_MCP_URL is not set");
    if (!token) throw new Error("ELOZI_MCP_TOKEN is not set");
  }

  private async rpc(method: string, params: unknown): Promise<any> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    const id = this.nextId++;
    const res = await this.fetchImpl(this.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    const text = await res.text();
    if (!res.ok) throw new McpError(`MCP HTTP ${res.status}: ${redact(text).slice(0, 300)}`);
    const msg = parseRpcBody(text, res.headers.get("content-type") ?? "");
    if (msg.error) throw new McpError(`MCP error ${msg.error.code}: ${redact(msg.error.message)}`);
    return msg.result;
  }

  async initialize(): Promise<any> {
    const r = await this.rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "elozi-serv-copilot", version: "0.1.0" },
    });
    return r;
  }

  async listTools(): Promise<{ name: string; description?: string }[]> {
    const r = await this.rpc("tools/list", {});
    return r.tools ?? [];
  }

  async call(name: string, args: Record<string, unknown>): Promise<any> {
    assertToolAllowed(name);
    const r = await this.rpc("tools/call", { name, arguments: args });
    if (r?.isError) throw new McpError(`${name} failed: ${redact(r.content?.[0]?.text ?? "unknown").slice(0, 300)}`);
    if (r?.structuredContent) return r.structuredContent;
    const t = r?.content?.find((c: any) => c.type === "text")?.text;
    try {
      return t ? JSON.parse(t) : r;
    } catch {
      return { text: t };
    }
  }
}

export function parseRpcBody(text: string, contentType: string): any {
  if (contentType.includes("text/event-stream")) {
    const datas = text
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    for (let i = datas.length - 1; i >= 0; i--) {
      try {
        const m = JSON.parse(datas[i]!);
        if (m && (m.result !== undefined || m.error !== undefined)) return m;
      } catch {}
    }
    throw new McpError("no JSON-RPC result in SSE stream");
  }
  return JSON.parse(text);
}

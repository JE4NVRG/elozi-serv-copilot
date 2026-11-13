import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

/** Tiny static server for the audit page: serves web/ and the JSONL log. */
const root = process.cwd();
const port = Number(process.env.PORT ?? 8787);
const logPath = process.env.LOG_PATH ?? "logs/decisions.jsonl";
const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".jsonl": "application/x-ndjson" };

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  let file = url.pathname === "/" ? "web/index.html" : url.pathname === "/decisions.jsonl" ? logPath : join("web", normalize(url.pathname).replace(/^(\.\.[/\\])+/, ""));
  try {
    const body = await readFile(join(root, file));
    res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream", "Content-Security-Policy": "default-src 'self'" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`audit page: http://127.0.0.1:${port}/`));

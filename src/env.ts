import { readFileSync } from "node:fs";

/**
 * Load KEY=VALUE lines from secret files into process.env without ever
 * printing them. Lines that are not KEY=VALUE are ignored.
 * OPENSERV_API_KEY is accepted as an alias of SERV_API_KEY.
 */
export function loadSecretFiles(paths: string[]): string[] {
  const loaded: string[] = [];
  for (const p of paths) {
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (!m) continue;
      let v = m[2]!.trim();
      if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
      if (!process.env[m[1]!]) process.env[m[1]!] = v;
      loaded.push(m[1]!);
    }
  }
  if (!process.env.SERV_API_KEY && process.env.OPENSERV_API_KEY) process.env.SERV_API_KEY = process.env.OPENSERV_API_KEY;
  return loaded; // names only
}

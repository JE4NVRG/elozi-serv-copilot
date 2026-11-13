/**
 * Secret redaction. Every string that may reach a log, an error message or
 * stdout goes through redact(). Known secret values from the environment are
 * masked verbatim, and Authorization/Bearer headers are masked by pattern.
 */
const SECRET_ENV = ["SERV_API_KEY", "OPENSERV_API_KEY", "ELOZI_MCP_TOKEN"];

export function secretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  return SECRET_ENV.map((k) => env[k]).filter((v): v is string => !!v && v.length >= 8);
}

export function redact(input: unknown, secrets: string[] = secretValues()): string {
  let s = typeof input === "string" ? input : safeStringify(input);
  for (const v of secrets) s = s.split(v).join("[REDACTED]");
  s = s.replace(/(authorization["']?\s*[:=]\s*["']?)(bearer\s+)?[^\s"',}]+/gi, "$1[REDACTED]");
  s = s.replace(/bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]");
  s = s.replace(/(x-openserv-key["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1[REDACTED]");
  return s;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

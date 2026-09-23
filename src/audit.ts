import fs from "node:fs";
import path from "node:path";

export interface AuditEntry {
  ts?: string;
  kind: "tool" | "http" | "notify" | "system";
  name: string;
  args?: Record<string, unknown>;
  source?: string;
  outcome: "ok" | "error" | "denied";
  error?: string;
  ms?: number;
  detail?: string;
}

const TRUNCATE = 300;

function compact(args: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!args) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string" && v.length > TRUNCATE) out[k] = v.slice(0, TRUNCATE) + `…(+${v.length - TRUNCATE})`;
    else out[k] = v;
  }
  return out;
}

export class Audit {
  private ready = false;

  constructor(
    readonly filePath: string,
    private readonly echo: (line: string) => void = (l) => process.stderr.write(l + "\n"),
  ) {}

  record(entry: AuditEntry): void {
    const full = { ts: new Date().toISOString(), ...entry, args: compact(entry.args) };
    const line = JSON.stringify(full);
    try {
      if (!this.ready) {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        this.ready = true;
      }
      fs.appendFileSync(this.filePath, line + "\n", { mode: 0o600 });
    } catch (e) {
      this.echo(`audit: cannot write ${this.filePath}: ${(e as Error).message}`);
    }
    const summary = `[${full.ts}] ${full.kind}:${full.name} ${full.outcome}${full.ms != null ? ` ${full.ms}ms` : ""}${full.error ? ` — ${full.error}` : ""}`;
    this.echo(summary);
  }
}

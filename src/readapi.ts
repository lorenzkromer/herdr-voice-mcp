// Read-only HTTP API for browser clients (e.g. a dashboard), next to the MCP endpoint.
//
//   GET  <path>/agents          → { generated_at, instances, hidden, agents: [...] }
//   GET  <path>/agents/stream   → text/event-stream, event "agents" with the same body on every change
//   OPTIONS                     → CORS preflight (no auth, browsers send none)
//
// Strictly read-only: the same agent fields as the `status` tool, no terminal output, no commands.
// Authentication: a dedicated read token, only in the Authorization header. A token (or anything
// that looks like one) in the query string is rejected, so it cannot leak through URLs.
// CORS: only the configured origins get CORS headers; other origins are refused.
//
// Browsers' EventSource cannot send an Authorization header; read the stream with fetch() and a
// ReadableStream instead.

import type http from "node:http";
import { tokensEqual } from "./auth.js";
import type { Audit } from "./audit.js";
import type { AgencyConfig } from "./config.js";
import type { Fleet, FleetBoard } from "./fleet.js";
import type { AgentView } from "./projects.js";

export interface ReadApiAgent {
  instance: string;
  handle: string;
  name: string | null;
  kind: string;
  status: string;
  project: string;
  project_name: string;
  workspace: string;
  topic: string | null;
  /** When the current state began (ISO); for states that predate the service, the service start. */
  since: string | null;
  /** False when `since` is only a lower bound (state already present when the service started). */
  since_exact: boolean;
  /** Seconds in the current state; null when the start is unknown. */
  seconds_in_state: number | null;
}

export interface ReadApiBody {
  generated_at: string;
  instances: Array<{ name: string; reachable: boolean; error?: string }>;
  /** Live agents outside the allowed projects (not listed). */
  hidden: number;
  agents: ReadApiAgent[];
}

export function agentsBody(fleet: Fleet, b: FleetBoard, now = Date.now()): ReadApiBody {
  const agents = b.agents.map((a: AgentView): ReadApiAgent => {
    const t = fleet.of(a).tracker.get(a.pane_id);
    const exact = !!t?.exact;
    return {
      instance: a.instance ?? fleet.label ?? "local",
      handle: a.handle,
      name: a.name,
      kind: a.kind ?? "unknown",
      status: a.status,
      project: a.project,
      project_name: a.project_name,
      workspace: a.workspace_label,
      topic: a.topic,
      since: t ? t.since.toISOString() : null,
      since_exact: exact,
      seconds_in_state: t && exact ? Math.max(0, Math.round((now - t.since.getTime()) / 1000)) : null,
    };
  });
  return {
    generated_at: new Date(now).toISOString(),
    instances: fleet.instances.map((i) => {
      const down = b.unreachable.find((u) => u.instance === i.name);
      return { name: i.name ?? fleet.label ?? "local", reachable: !down, ...(down ? { error: down.error } : {}) };
    }),
    hidden: b.hidden,
    agents,
  };
}

/** Fingerprint of what a viewer sees; excludes timestamps that change on every poll. */
function fingerprint(body: ReadApiBody): string {
  return JSON.stringify([body.instances, body.hidden, body.agents.map((a) => [a.instance, a.handle, a.status, a.topic, a.since, a.project, a.name])]);
}

const STREAM_POLL_MS = 5_000;
const STREAM_KEEPALIVE_MS = 25_000;
const MAX_STREAMS = 20;

export class ReadApi {
  private streams = new Set<http.ServerResponse>();
  private pollTimer: NodeJS.Timeout | null = null;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private last: { body: ReadApiBody; fp: string } | null = null;
  private refreshing = false;

  constructor(
    private readonly cfg: AgencyConfig,
    private readonly fleet: Fleet,
    private readonly audit: Audit,
  ) {
    // Push a fresh snapshot soon after any state change instead of waiting for the next poll.
    for (const inst of fleet.instances) inst.tracker.onTransition(() => this.scheduleRefresh(300));
  }

  get path(): string {
    return this.cfg.read_api.path;
  }

  /** True when the request belongs to this API (the caller then must not handle it further). */
  matches(pathname: string): boolean {
    return this.cfg.read_api.enabled && (pathname === this.path || pathname.startsWith(this.path + "/"));
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL, source: string): Promise<void> {
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : null;
    const allowed = origin === null || this.cfg.read_api.allowed_origins.includes(origin);
    if (!allowed) {
      this.audit.record({ kind: "http", name: url.pathname, source, outcome: "denied", error: `origin not allowed: ${origin}` });
      send(res, 403, { error: "origin not allowed" });
      return;
    }
    const cors: Record<string, string> = origin
      ? { "access-control-allow-origin": origin, vary: "Origin", "access-control-expose-headers": "content-type" }
      : {};

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        ...cors,
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "Authorization, Accept, Cache-Control",
        "access-control-max-age": "600",
      });
      res.end();
      return;
    }
    if (req.method !== "GET") {
      send(res, 405, { error: "read-only API: only GET" }, { ...cors, allow: "GET, OPTIONS" });
      return;
    }
    // Secrets never travel in URLs: refuse any query string that could carry one.
    for (const key of url.searchParams.keys()) {
      if (/token|key|secret|auth|bearer|pass/i.test(key)) {
        this.audit.record({ kind: "http", name: url.pathname, source, outcome: "denied", error: "credential in query string" });
        send(res, 400, { error: "credentials must be sent in the Authorization header, never in the URL" }, cors);
        return;
      }
    }
    const who = this.authenticate(req);
    if (!who) {
      this.audit.record({ kind: "http", name: url.pathname, source, outcome: "denied", error: "unauthorized" });
      send(res, 401, { error: "unauthorized" }, { ...cors, "www-authenticate": 'Bearer realm="agency-read"' });
      return;
    }

    const sub = url.pathname.slice(this.path.length);
    if (sub === "/agents") {
      try {
        const body = await this.snapshot();
        send(res, 200, body, { ...cors, "cache-control": "no-store" });
      } catch (e) {
        send(res, 502, { error: (e as Error).message }, cors);
      }
      return;
    }
    if (sub === "/agents/stream") {
      if (this.streams.size >= MAX_STREAMS) {
        send(res, 503, { error: "too many open streams" }, cors);
        return;
      }
      this.audit.record({ kind: "http", name: url.pathname, source, outcome: "ok", detail: `stream opened by ${who}` });
      res.writeHead(200, { ...cors, "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
      res.write(`retry: 5000\n\n`);
      this.streams.add(res);
      res.on("close", () => {
        this.streams.delete(res);
        if (!this.streams.size) this.stopTimers();
      });
      this.startTimers();
      try {
        const body = await this.snapshot();
        writeEvent(res, body);
      } catch (e) {
        res.write(`event: error\ndata: ${JSON.stringify({ error: (e as Error).message })}\n\n`);
      }
      return;
    }
    send(res, 404, { error: "not found" }, cors);
  }

  /** Name of the matching read token, or null. */
  private authenticate(req: http.IncomingMessage): string | null {
    const h = req.headers.authorization;
    if (typeof h !== "string" || !/^Bearer\s+/i.test(h)) return null;
    const presented = h.replace(/^Bearer\s+/i, "").trim();
    for (const t of this.cfg.read_api.tokens) if (tokensEqual(presented, t.token)) return t.name;
    return null;
  }

  private async snapshot(): Promise<ReadApiBody> {
    const board = await this.fleet.board();
    const body = agentsBody(this.fleet, board);
    this.last = { body, fp: fingerprint(body) };
    return body;
  }

  private scheduleRefresh(ms: number): void {
    if (!this.streams.size || this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, ms);
  }

  /** Loads the board once for all streams and sends it when something visible changed. */
  private async refresh(): Promise<void> {
    if (this.refreshing || !this.streams.size) return;
    this.refreshing = true;
    try {
      const before = this.last?.fp;
      const body = await this.snapshot();
      if (this.last && this.last.fp !== before) for (const s of this.streams) writeEvent(s, body);
    } catch {
      /* next poll retries */
    } finally {
      this.refreshing = false;
    }
  }

  private startTimers(): void {
    if (!this.pollTimer) this.pollTimer = setInterval(() => void this.refresh(), STREAM_POLL_MS);
    if (!this.keepaliveTimer) this.keepaliveTimer = setInterval(() => { for (const s of this.streams) s.write(`: keepalive\n\n`); }, STREAM_KEEPALIVE_MS);
  }

  private stopTimers(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.pollTimer = this.keepaliveTimer = this.refreshTimer = null;
  }

  close(): void {
    for (const s of this.streams) s.end();
    this.streams.clear();
    this.stopTimers();
  }
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function writeEvent(res: http.ServerResponse, body: ReadApiBody): void {
  res.write(`event: agents\ndata: ${JSON.stringify(body)}\n\n`);
}

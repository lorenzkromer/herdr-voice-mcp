// MCP tool definitions. One McpServer instance is created per HTTP request
// (stateless transport); the shared context (Herdr client, tracker, audit)
// lives for the whole process.

import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Audit } from "./audit.js";
import type { AgencyConfig } from "./config.js";
import { HerdrClient, HerdrError, type AgentInfo, type AgentStatus, type PaneReadResult, type ReadSource } from "./herdr.js";
import { agentLabel, agentLine, clock, clockSeconds, formatBoard, formatStandup, ELAPSED, PROGRESS, STATUS_WORD, trimTail, type StandupItem } from "./format.js";
import { findProjectWorkspace, loadBoard, matchProject, resolveTarget, type AgentView, type Board } from "./projects.js";
import { handOver, idempotent, MAX_DELIVERIES, recentDeliveries, recordDelivery, requestInFlight, type HandoverResult } from "./delivery.js";
import type { Tracker } from "./tracker.js";

export interface ToolContext {
  cfg: AgencyConfig;
  client: HerdrClient;
  tracker: Tracker;
  audit: Audit;
  /** Free-form origin for the audit log (remote address, "stdio", ...). */
  source: string;
}

const StatusEnum = z.enum(["idle", "working", "blocked", "done", "unknown"]);

const TARGET_HELP =
  "Best: the target string shown by status/standup (e.g. \"steerbase/codex\"). Also accepted: agent name, pane ID (w4:p1), " +
  "workspace label, \"<workspace or project>/<agent name, tab or kind>\", project name/alias; optionally prefixed with the instance name (\"<instance>/...\"). Ambiguous targets return the candidates.";

/** Keys an operator may send to a blocked agent UI. Deliberately small. */
export const ALLOWED_KEYS = new Set([
  "enter", "esc", "tab", "space", "backspace",
  "up", "down", "left", "right",
  "y", "n", "a", "1", "2", "3", "4", "5", "6", "7", "8", "9",
  "ctrl+c",
]);

const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** Process-wide memory of recent deliveries (pane + text → time), shared by all per-request server instances. */
const recentSends = new Map<string, Date>();

/** Time budgets that keep every tool call well below the client's ~30 s transport limit. */
const SEND_HANDOVER_MS = 15_000;
const SPAWN_BUDGET_MS = 25_000;
/** Minimum time left for the first task after a spawn; less than this and the task is reported as not delivered. */
const SPAWN_MIN_HANDOVER_MS = 5_000;

/** Per pane: fingerprint and time of the last `read`, for the "changed since last read" hint. */
const lastReads = new Map<string, { fingerprint: string; at: Date }>();

/** Codes with which agent.read refuses while the agent is busy; pane.read still works then. */
const READ_FALLBACK_CODES = /not_idle|not_ready|busy/;

/**
 * Reads an agent's terminal. agent.read can refuse while the agent works (agent_not_idle);
 * the raw pane read shows the same terminal, so fall back to it instead of failing.
 */
async function readScreen(client: HerdrClient, pane_id: string, lines: number, source: ReadSource = "recent_unwrapped"): Promise<PaneReadResult> {
  try {
    return await client.agentRead(pane_id, lines, source);
  } catch (e) {
    if (e instanceof HerdrError && READ_FALLBACK_CODES.test(e.code)) return client.paneRead(pane_id, lines, source);
    throw e;
  }
}

/** Screen content without lines whose timers tick, so an unchanged screen compares equal. */
function fingerprint(body: string): string {
  return body
    .split("\n")
    .filter((l) => !PROGRESS.test(l))
    .map((l) => l.replace(ELAPSED, ""))
    .join("\n");
}

function text(t: string, structured?: Record<string, unknown>, isError = false): CallToolResult {
  const r: CallToolResult = { content: [{ type: "text", text: t }] };
  if (structured) r.structuredContent = structured;
  if (isError) r.isError = true;
  return r;
}

function errorText(e: unknown): string {
  if (e instanceof HerdrError) return `Herdr error ${e.code}: ${e.message}`;
  return `Error: ${(e as Error).message ?? String(e)}`;
}

function viewJson(a: AgentView) {
  return {
    instance: a.instance,
    handle: a.handle,
    pane_id: a.pane_id,
    name: a.name,
    kind: a.kind,
    status: a.status,
    project: a.project,
    project_name: a.project_name,
    workspace: a.workspace_label,
    tab: a.tab_label,
    topic: a.topic,
    cwd: a.cwd,
  };
}

function describeMany(agents: AgentView[], reason: string): string {
  return `${reason}. Please be more specific. Candidates:\n${agents.map((a) => `- target "${a.handle}" (${a.project_name}) ${STATUS_WORD[a.status]}${a.topic ? ` · ${a.topic}` : ""}`).join("\n")}`;
}

/** One unmistakable sentence per handover outcome. */
function handoverSentence(h: HandoverResult, who: string): string {
  switch (h.outcome) {
    case "delivered":
      return `Delivered to ${who}.`;
    case "unknown":
      return `The task was handed to ${who}, but it is UNKNOWN whether it arrived (${h.reason}). Do not resend blindly; check with read or deliveries first.`;
    case "failed":
      return `NOT delivered to ${who}: nothing arrived (${h.reason}). It is safe to send it again.`;
  }
}

function handoverJson(h: HandoverResult): Record<string, unknown> {
  return {
    delivered: h.outcome === "delivered",
    delivery: h.outcome,
    delivery_reason: h.reason ?? null,
    delivery_attempts: h.attempts,
    // "effect": something may have changed on the agent's side; request_id replays such results.
    effect: h.outcome !== "failed",
    ...(h.outcome === "delivered" ? { delivered_at: new Date().toISOString() } : {}),
  };
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "")
    .slice(0, 24) || "agent";
}

export function createMcpServer(ctx: ToolContext): McpServer {
  const { cfg, client, tracker, audit } = ctx;
  const instance = cfg.instance_name ?? null;
  const server = new McpServer(
    { name: "agency", title: instance ? `Agency – ${instance}` : "Agency", version: "0.1.0" },
    {
      instructions:
        `Controls the coding agents${instance ? ` on the Herdr instance "${instance}"` : " of one Herdr instance"} (Claude Code, Codex, …) for voice use. ` +
        "Address agents by the target string that status/standup show" +
        (instance ? `; a leading "${instance}/" is accepted` : "") +
        ". Pass a fresh request_id to send and reuse it on retries; after a transport error check deliveries instead of resending.",
    },
  );

  /** Wraps a tool body with timing, audit logging and error mapping. */
  const run = async (name: string, args: Record<string, unknown>, body: () => Promise<CallToolResult>): Promise<CallToolResult> => {
    const t0 = Date.now();
    try {
      const result = await body();
      audit.record({ kind: "tool", name, args, source: ctx.source, outcome: result.isError ? "error" : "ok", ms: Date.now() - t0 });
      return result;
    } catch (e) {
      const msg = errorText(e);
      audit.record({ kind: "tool", name, args, source: ctx.source, outcome: "error", error: msg, ms: Date.now() - t0 });
      return text(msg, undefined, true);
    }
  };

  const board = async (): Promise<Board> => {
    const b = await loadBoard(client, cfg);
    for (const a of b.agents) {
      // Keep the tracker in sync even if the subscription dropped.
      tracker.observe({ pane_id: a.pane_id, agent_status: a.status, state_change_seq: a.state_change_seq } as unknown as AgentInfo);
    }
    return b;
  };

  // ------------------------------------------------------------------ status
  server.registerTool(
    "status",
    {
      title: "Board: all agents",
      description:
        "The board: all allowed coding agents with status (blocked = needs a decision, done = finished and not yet reviewed, working, idle), project, workspace and time in the current state. " +
        "Use for 'How are things?', 'What is the web agent doing?'. With only='attention' shows only blocked and done.",
      inputSchema: {
        project: z.string().optional().describe("Only agents of this project (key, name or alias)."),
        only: z.enum(["all", "attention"]).optional().describe("'attention' shows only agents that are finished or need a decision."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      run("status", args, async () => {
        const b = await board();
        let agents = b.agents;
        if (args.project) {
          const p = matchProject(cfg, args.project);
          if (!p) return text(`Unknown project "${args.project}". Allowed: ${Object.values(cfg.projects).map((x) => x.name).join(", ")}.`, undefined, true);
          agents = agents.filter((a) => a.project === p.key);
        }
        const out = formatBoard(agents, tracker, { hidden: args.project ? 0 : b.hidden, attentionOnly: args.only === "attention", instance });
        return text(out, { instance, agents: agents.map(viewJson), hidden: b.hidden });
      }),
  );

  // ----------------------------------------------------------------- standup
  server.registerTool(
    "standup",
    {
      title: "Stand-up",
      description:
        "The narrated view: who finished, who has been waiting for a decision and since when, including the last output lines of those agents. " +
        "Use for 'Let's do a stand-up', 'What's new?'. Remembers the time so the next stand-up can tell 'new' from 'already reported'.",
      inputSchema: {
        lines: z.number().int().min(0).max(100).optional().describe("Output lines per agent (default from config, 0 = none)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      run("standup", args, async () => {
        const b = await board();
        const lines = args.lines ?? cfg.read.standup_lines;
        const attention = b.agents.filter((a) => a.status === "blocked" || a.status === "done");
        const rest = b.agents.filter((a) => a.status !== "blocked" && a.status !== "done");
        const last = tracker.lastStandupAt;
        const items: StandupItem[] = await Promise.all(
          attention.map(async (agent) => {
            const t = tracker.get(agent.pane_id);
            const isNew = !last || !t || t.since.getTime() > last.getTime();
            let tail: string | null = null;
            if (lines > 0) {
              try {
                const r = await readScreen(client, agent.pane_id, Math.max(lines * 3, 40));
                tail = trimTail(r.text, lines);
              } catch (e) {
                tail = `(output not readable: ${errorText(e)})`;
              }
            }
            return { agent, isNew, tail };
          }),
        );
        const out = formatStandup(items, rest, tracker, last, instance);
        tracker.lastStandupAt = new Date();
        return text(out, {
          instance,
          attention: items.map((i) => ({ ...viewJson(i.agent), is_new: i.isNew, tail: i.tail })),
          others: rest.map(viewJson),
        });
      }),
  );

  // -------------------------------------------------------------------- read
  server.registerTool(
    "read",
    {
      title: "Read an agent's output",
      description:
        "The last lines of an agent's terminal, so you can summarize what happened or what the agent is asking. " +
        "Works while the agent is busy, too. Each answer carries the read time and whether the screen changed since the previous read of that agent " +
        "(changed_since_last_read: false means the agent has printed nothing new – do not retell the old content as news).",
      inputSchema: {
        target: z.string().describe(TARGET_HELP),
        lines: z.number().int().min(1).max(cfg.read.max_lines).optional().describe(`Number of lines (default ${cfg.read.default_lines}).`),
        source: z.enum(["recent_unwrapped", "visible", "recent", "detection"]).optional().describe("Default recent_unwrapped (log-like). visible = the currently visible screen."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      run("read", args, async () => {
        const b = await board();
        const res = resolveTarget(b, cfg, args.target);
        if (res.kind === "none") return text(res.reason, undefined, true);
        if (res.kind === "many") return text(describeMany(res.agents, res.reason), { candidates: res.agents.map(viewJson) }, true);
        const a = res.agent;
        const lines = Math.min(args.lines ?? cfg.read.default_lines, cfg.read.max_lines);
        // Agent TUIs pad the bottom of the screen with blank rows; fetch more and keep `lines` non-empty ones.
        const r = await readScreen(client, a.pane_id, Math.min(lines * 2 + 20, cfg.read.max_lines + 40), args.source ?? "recent_unwrapped");
        const body = trimTail(r.text, lines);
        const now = new Date();
        const fp = fingerprint(body);
        const prev = lastReads.get(a.pane_id);
        lastReads.set(a.pane_id, { fingerprint: fp, at: now });
        const changed = prev ? prev.fingerprint !== fp : null;
        const stamp =
          changed === null
            ? `Read at ${clockSeconds(now)} (first read of this agent since the service started).`
            : changed
              ? `Read at ${clockSeconds(now)}. CHANGED since the previous read at ${clockSeconds(prev!.at)}.`
              : `Read at ${clockSeconds(now)}. UNCHANGED since the previous read at ${clockSeconds(prev!.at)} – nothing new on screen.`;
        const head = `${agentLine(a, tracker)}\n${stamp}\nLast ${lines} lines${r.truncated ? " (truncated)" : ""}:\n`;
        return text(head + body, {
          agent: viewJson(a),
          text: body,
          truncated: r.truncated,
          read_at: now.toISOString(),
          changed_since_last_read: changed,
          previous_read_at: prev?.at.toISOString() ?? null,
        });
      }),
  );

  // -------------------------------------------------------------------- send
  server.registerTool(
    "send",
    {
      title: "Send a task to an agent",
      description:
        "Delivers a prompt to a running agent. If the agent is not ready for input yet (e.g. just started), it waits and retries for up to " + SEND_HANDOVER_MS / 1000 + " seconds. " +
        "The answer always states one of: delivered; delivered but outcome unknown (never resend blindly then); or NOT delivered (nothing arrived, safe to send again). " +
        "After a delivery it watches a few seconds for an immediate question or answer; usually the agent is still working – check later with wait, status or read. " +
        "IMPORTANT: always pass a fresh request_id and reuse the SAME request_id when retrying after a transport error – the server then returns the original result instead of delivering twice. " +
        "Without request_id, check with deliveries whether the task arrived before sending again. " +
        "An identical text to the same agent is refused within " + cfg.send.dedupe_minutes + " minutes unless force=true. " +
        "Refuses to send while the agent is waiting for a decision (use keys or read then).",
      inputSchema: {
        target: z.string().describe(TARGET_HELP),
        text: z.string().min(1).describe("The task, exactly as it should be given to the agent."),
        settle_seconds: z.number().int().min(0).max(20).optional().describe(`How long to watch for an immediate state after delivery (default ${cfg.send.settle_seconds}, 0 = not at all).`),
        force: z.boolean().optional().describe("Send the same text again despite a recent delivery."),
        request_id: z.string().min(1).max(100).optional().describe("Caller-chosen idempotency key (any unique string). A retry with the same request_id returns the first result and never delivers twice."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => run("send", args, () => idempotent("send", args.request_id, () => doSend(args))),
  );

  async function doSend(args: { target: string; text: string; settle_seconds?: number; force?: boolean; request_id?: string }): Promise<CallToolResult> {
    const b = await board();
    const res = resolveTarget(b, cfg, args.target);
    if (res.kind === "none") return text(res.reason, undefined, true);
    if (res.kind === "many") return text(describeMany(res.agents, res.reason), { candidates: res.agents.map(viewJson) }, true);
    const a = res.agent;
    if (a.status === "blocked") {
      const r = await readScreen(client, a.pane_id, 30);
      return text(
        `${agentLabel(a)} is waiting for a decision and does not accept a new task. NOT delivered. Current screen:\n${trimTail(r.text, 20)}`,
        { agent: viewJson(a), delivered: false, blocked: true },
        true,
      );
    }

    // Duplicate guard: the same text to the same agent within the window (covers callers without request_id).
    const key = `${a.pane_id}\u0000${args.text.trim()}`;
    const recent = recentSends.get(key);
    const windowMs = cfg.send.dedupe_minutes * 60_000;
    if (recent && !args.force && Date.now() - recent.getTime() < windowMs) {
      return text(
        `This exact task was already delivered to ${agentLabel(a)} at ${clock(recent)}. Not sent again. Check with read what became of it; if it really should run again: force=true.`,
        { agent: viewJson(a), delivered: false, duplicate: true, delivered_at: recent.toISOString() },
        true,
      );
    }

    const h = await handOver(client, a.pane_id, args.text, SEND_HANDOVER_MS);
    recordDelivery({ at: new Date(), pane_id: a.pane_id, handle: a.handle, project: a.project_name, text: args.text, request_id: args.request_id ?? null, via: "send", outcome: h.outcome, reason: h.reason });
    if (h.outcome !== "failed") {
      recentSends.set(key, new Date());
      for (const [k, t] of recentSends) if (Date.now() - t.getTime() > Math.max(windowMs, 60_000)) recentSends.delete(k);
    }
    if (h.outcome !== "delivered") {
      return text(`${handoverSentence(h, agentLabel(a))}`, { agent: viewJson(a), ...handoverJson(h) }, true);
    }
    if (h.agent) tracker.observe(h.agent);

    // Short settle window: catches an immediate approval dialog or a trivial answer.
    const settleMs = (args.settle_seconds ?? cfg.send.settle_seconds) * 1000;
    let status: AgentStatus = "working";
    let extra = "";
    if (settleMs > 0) {
      try {
        const settled = await client.agentWait(a.pane_id, ["idle", "done", "blocked"], settleMs);
        tracker.observe(settled);
        status = settled.agent_status;
        const r = await readScreen(client, a.pane_id, 40);
        extra = `\nLast output:\n${trimTail(r.text, 15)}`;
      } catch {
        // Timeout means "still working"; any other error here must not turn a delivery into a failure.
      }
    }
    const waited = h.attempts > 1 || h.ms > 2000 ? ` (the agent needed ${Math.round(h.ms / 1000)} s to accept it)` : "";
    const msg =
      status === "working"
        ? `Task delivered to ${agentLabel(a)} (${a.project_name})${waited}. The agent is working; get the result later with wait, status or read.`
        : `Task delivered to ${agentLabel(a)} (${a.project_name})${waited}. Already now: ${STATUS_WORD[status]}.${extra}`;
    return text(msg, { agent: viewJson(a), ...handoverJson(h), status_after: status });
  }

  // -------------------------------------------------------------- deliveries
  server.registerTool(
    "deliveries",
    {
      title: "Recent handovers to agents",
      description:
        "Lists what send, spawn and keys handed to agents recently (time, agent, text or keys, request_id, outcome: delivered / unknown / failed). " +
        "Use it after a transport error or when unsure whether something arrived, instead of sending again. Kept in memory since the service started (last " + MAX_DELIVERIES + ").",
      inputSchema: {
        target: z.string().optional().describe("Only handovers to this agent (" + TARGET_HELP + ")"),
        request_id: z.string().optional().describe("Only the handover made with this request_id."),
        minutes: z.number().int().min(1).max(24 * 60).optional().describe("Look back this many minutes (default 60)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      run("deliveries", args, async () => {
        let list = recentDeliveries(Date.now() - (args.minutes ?? 60) * 60_000);
        if (args.request_id) list = list.filter((d) => d.request_id === args.request_id);
        if (args.target) {
          const res = resolveTarget(await board(), cfg, args.target);
          if (res.kind === "many") return text(describeMany(res.agents, res.reason), { candidates: res.agents.map(viewJson) }, true);
          // An agent that is gone can still be matched by its old handle or pane id.
          const pane = res.kind === "one" ? res.agent.pane_id : null;
          const q = args.target.trim().toLowerCase();
          list = list.filter((d) => d.pane_id === pane || d.handle.toLowerCase() === q || d.pane_id.toLowerCase() === q);
        }
        const window = `in the last ${args.minutes ?? 60} minutes`;
        if (!list.length) {
          const pending = args.request_id && ["send", "spawn", "keys"].some((t) => requestInFlight(t, args.request_id!)) ? " (a call with this request_id is still in progress)" : "";
          return text(`Nothing was handed over ${window}${args.request_id ? ` with request_id "${args.request_id}"` : ""}${args.target ? ` to "${args.target}"` : ""}${pending}.`, { deliveries: [] });
        }
        const outcomeWord = { delivered: "delivered", unknown: "OUTCOME UNKNOWN (may have arrived)", failed: "NOT delivered" } as const;
        const lines = list.map(
          (d) =>
            `- ${clockSeconds(d.at)} → "${d.handle}" (${d.project}) via ${d.via}: ${outcomeWord[d.outcome]}${d.reason && d.outcome !== "delivered" ? ` (${d.reason})` : ""}${d.request_id ? `, request_id ${d.request_id}` : ""}: ${d.text.length > 160 ? d.text.slice(0, 160) + "…" : d.text}`,
        );
        return text(`${list.length} handover${list.length === 1 ? "" : "s"} ${window}:\n${lines.join("\n")}`, {
          deliveries: list.map((d) => ({ ...d, at: d.at.toISOString() })),
        });
      }),
  );

  // -------------------------------------------------------------------- wait
  server.registerTool(
    "wait",
    {
      title: "Briefly wait for an agent",
      description:
        `Waits at most ${cfg.send.max_wait_seconds} seconds until an agent is ready, done or blocked, then returns state and last output. ` +
        "If time runs out the agent is still working – just call again later. For longer tasks status/standup is the better way.",
      inputSchema: {
        target: z.string().describe(TARGET_HELP),
        timeout_seconds: z.number().int().min(1).max(cfg.send.max_wait_seconds).optional().describe(`Wait time in seconds (default ${Math.min(20, cfg.send.max_wait_seconds)}).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      run("wait", args, async () => {
        const b = await board();
        const res = resolveTarget(b, cfg, args.target);
        if (res.kind === "none") return text(res.reason, undefined, true);
        if (res.kind === "many") return text(describeMany(res.agents, res.reason), { candidates: res.agents.map(viewJson) }, true);
        const a = res.agent;
        const timeoutMs = Math.min(args.timeout_seconds ?? 20, cfg.send.max_wait_seconds) * 1000;
        try {
          const after = await client.agentWait(a.pane_id, ["idle", "done", "blocked"], timeoutMs);
          tracker.observe(after);
          const r = await readScreen(client, a.pane_id, 40);
          return text(`${agentLabel(a)} (${a.project_name}): ${STATUS_WORD[after.agent_status]}.\nLast output:\n${trimTail(r.text, 15)}`, {
            agent: viewJson(a),
            status: after.agent_status,
          });
        } catch (e) {
          if (e instanceof HerdrError && e.code === "timeout") {
            return text(`${agentLabel(a)} (${a.project_name}) is still working (after ${Math.round(timeoutMs / 1000)} seconds). Call wait or status again later.`, {
              agent: viewJson(a),
              status: "working",
              timed_out: true,
            });
          }
          throw e;
        }
      }),
  );

  // -------------------------------------------------------------------- keys
  server.registerTool(
    "keys",
    {
      title: "Keys for a blocked agent",
      description:
        "Answers a question or menu of a blocked agent with logical keys (enter, esc, y, n, up, down, 1-9, ctrl+c). " +
        "Check with read first what is being asked. Only for dialogs, not for dictating text – use send for that. " +
        "Keys are never retried by the server: pass a request_id and reuse it when retrying after a transport error, so a key is not pressed twice.",
      inputSchema: {
        target: z.string().describe(TARGET_HELP),
        keys: z.array(z.string()).min(1).max(10).describe("Key sequence, e.g. ['y','enter'] or ['down','enter']."),
        request_id: z.string().min(1).max(100).optional().describe("Caller-chosen idempotency key. A retry with the same request_id returns the first result and never presses the keys twice."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      run("keys", args, () =>
        idempotent("keys", args.request_id, async () => {
          const bad = args.keys.filter((k) => !ALLOWED_KEYS.has(k.toLowerCase()));
          if (bad.length) return text(`Keys not allowed: ${bad.join(", ")}. Allowed: ${[...ALLOWED_KEYS].join(", ")}.`, undefined, true);
          const b = await board();
          const res = resolveTarget(b, cfg, args.target);
          if (res.kind === "none") return text(res.reason, undefined, true);
          if (res.kind === "many") return text(describeMany(res.agents, res.reason), { candidates: res.agents.map(viewJson) }, true);
          const a = res.agent;
          const keys = args.keys.map((k) => k.toLowerCase());
          const log = (outcome: "delivered" | "unknown" | "failed", reason?: string) =>
            recordDelivery({ at: new Date(), pane_id: a.pane_id, handle: a.handle, project: a.project_name, text: keys.join(" "), request_id: args.request_id ?? null, via: "keys", outcome, reason });
          try {
            await client.agentSendKeys(a.pane_id, keys);
          } catch (e) {
            // A timeout or dropped socket may still have pressed the keys; an explicit refusal did not.
            const maybe = e instanceof HerdrError && ["timeout", "connection_closed"].includes(e.code);
            log(maybe ? "unknown" : "failed", errorText(e));
            return text(
              maybe
                ? `It is UNKNOWN whether the keys ${keys.join(" ")} reached ${agentLabel(a)} (${errorText(e)}). Check with read before pressing again.`
                : `Keys ${keys.join(" ")} were NOT sent to ${agentLabel(a)}: ${errorText(e)}.`,
              { agent: viewJson(a), sent: false, effect: maybe },
              true,
            );
          }
          log("delivered");
          // Reporting the aftermath must not turn a successful key press into an error.
          let state = "";
          let status_after: AgentStatus | null = null;
          try {
            await new Promise((r) => setTimeout(r, 1500));
            const after = await client.agentGet(a.pane_id);
            tracker.observe(after);
            status_after = after.agent_status;
            const r = await readScreen(client, a.pane_id, 30);
            state = ` State now: ${STATUS_WORD[after.agent_status]}.\nScreen:\n${trimTail(r.text, 15)}`;
          } catch (e) {
            state = ` (Could not read the state afterwards: ${errorText(e)}.)`;
          }
          return text(`Sent keys ${keys.join(" ")} to ${agentLabel(a)}.${state}`, { agent: viewJson(a), sent: true, effect: true, status_after });
        }),
      ),
  );

  // ------------------------------------------------------------------- spawn
  server.registerTool(
    "spawn",
    {
      title: "Start a new agent",
      description:
        "Starts a new coding agent (e.g. claude or codex) in an allowed project: a new tab in the project's open workspace (or a new workspace if none is open), working directory = project root. " +
        "Optionally with a first task: the server waits until the new agent accepts input and hands the task over. The answer says explicitly whether the first task was delivered; " +
        "if not, the agent is running without it and the task must be sent with send. " +
        "Pass a request_id and reuse it when retrying after a transport error, so no second agent is started. Arbitrary shell commands are never passed through.",
      inputSchema: {
        project: z.string().describe("Project key, name or alias."),
        kind: z.string().optional().describe(`Agent kind: ${cfg.agent_kinds.join(" | ")} (default from project config, otherwise ${cfg.agent_kinds[0]}).`),
        name: z.string().optional().describe("Unique name for the agent (a-z, 0-9, -, _; generated by default)."),
        prompt: z.string().optional().describe("First task, handed over as soon as the agent is ready."),
        label: z.string().optional().describe("Tab label in Herdr (default: the agent name)."),
        request_id: z.string().min(1).max(100).optional().describe("Caller-chosen idempotency key. A retry with the same request_id returns the first result and never starts a second agent."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => run("spawn", args, () => idempotent("spawn", args.request_id, () => doSpawn(args))),
  );

  async function doSpawn(args: { project: string; kind?: string; name?: string; prompt?: string; label?: string; request_id?: string }): Promise<CallToolResult> {
    const deadline = Date.now() + SPAWN_BUDGET_MS;
    const p = matchProject(cfg, args.project);
    if (!p) return text(`Unknown project "${args.project}". Allowed: ${Object.values(cfg.projects).map((x) => x.name).join(", ")}.`, undefined, true);
    const kind = (args.kind ?? p.project.default_kind ?? cfg.agent_kinds[0]).toLowerCase();
    if (!cfg.agent_kinds.includes(kind)) return text(`Agent kind "${kind}" is not allowed. Allowed: ${cfg.agent_kinds.join(", ")}.`, undefined, true);

    const [existing, workspaces] = await Promise.all([client.agentList(), client.workspaceList()]);
    const taken = new Set(existing.map((a) => a.name).filter((n): n is string => !!n));
    let name = args.name ? args.name.toLowerCase() : "";
    if (name && !AGENT_NAME_RE.test(name)) return text(`Invalid agent name "${args.name}". Allowed: a-z, 0-9, - and _, at most 32 characters, starting with a letter.`, undefined, true);
    if (name && taken.has(name)) return text(`The name "${name}" is already taken.`, undefined, true);
    if (!name) {
      const base = `${slugify(p.key)}-${kind}`;
      let n = 1;
      name = base;
      while (taken.has(name)) name = `${base}-${++n}`;
    }

    const root = path.resolve(p.project.root);
    const primary = findProjectWorkspace(workspaces, existing, p.key, p.project, root);
    const label = args.label ?? name;
    let pane_id: string;
    let where: string;
    let wsLabel: string;
    let created: { kind: "tab" | "workspace"; id: string };
    if (primary) {
      const t = await client.tabCreate(primary.workspace_id, root, label);
      pane_id = t.root_pane.pane_id;
      wsLabel = primary.label;
      where = `new tab "${label}" in workspace "${primary.label}"`;
      created = { kind: "tab", id: t.tab.tab_id };
    } else {
      const w = await client.workspaceCreate(path.basename(root), root);
      pane_id = w.root_pane.pane_id;
      wsLabel = w.workspace.label;
      where = `new workspace "${w.workspace.label}"`;
      created = { kind: "workspace", id: w.workspace.workspace_id };
    }
    const handle = `${wsLabel}/${name}`;
    const base = { pane_id, name, handle, kind, project: p.key, created, effect: true };
    const taskNotDelivered = args.prompt ? " The first task was NOT delivered – nothing arrived; send it with send once the agent is ready." : "";

    // From here on something exists on the machine: report, never throw, so a request_id replay covers it.
    try {
      // The fresh shell needs a moment before agent.start accepts the pane.
      let agent: AgentInfo | null = null;
      let lastErr: unknown = null;
      while (Date.now() < deadline - SPAWN_MIN_HANDOVER_MS) {
        try {
          agent = await client.agentStart(name, kind, pane_id, Math.max(3_000, deadline - Date.now() - SPAWN_MIN_HANDOVER_MS));
          break;
        } catch (e) {
          lastErr = e;
          if (e instanceof HerdrError && e.code === "agent_not_ready") break; // started but blocked (e.g. trust prompt)
          if (e instanceof HerdrError && /not_ready|busy|shell|prompt|foreground/i.test(e.code + e.message)) {
            await new Promise((r) => setTimeout(r, 1000));
            continue;
          }
          break;
        }
      }

      if (!agent) {
        if (lastErr instanceof HerdrError && lastErr.code === "agent_not_ready") {
          // The agent is present but waiting for input at startup (e.g. a trust prompt).
          let screen = "";
          try {
            screen = trimTail((await client.paneRead(pane_id, 30)).text, 15);
          } catch {
            /* ignore */
          }
          if (args.prompt) recordDelivery({ at: new Date(), pane_id, handle, project: p.project.name, text: args.prompt, request_id: args.request_id ?? null, via: "spawn", outcome: "failed", reason: "agent waits for input at startup" });
          return text(
            `${kind} was started as "${handle}" in ${where}, but is waiting for input at startup.${taskNotDelivered} Screen:\n${screen}\nAnswer with keys (e.g. enter) or check with read.`,
            { ...base, status: "blocked", delivered: false, delivery: args.prompt ? "failed" : null },
            true,
          );
        }
        if (args.prompt) recordDelivery({ at: new Date(), pane_id, handle, project: p.project.name, text: args.prompt, request_id: args.request_id ?? null, via: "spawn", outcome: "failed", reason: `agent did not start: ${errorText(lastErr)}` });
        return text(
          `A ${where} was opened for ${kind} "${name}", but the agent did not confirm its start (${lastErr ? errorText(lastErr) : "time budget used up"}).${taskNotDelivered} Check with status or read.`,
          { ...base, status: "unknown", delivered: false, delivery: args.prompt ? "failed" : null },
          true,
        );
      }

      tracker.observe(agent);
      if (!args.prompt) {
        return text(`${kind} is running as "${handle}" in ${where}, directory ${root}. It has no task yet.`, { ...base, status: agent.agent_status });
      }
      const h = await handOver(client, pane_id, args.prompt, Math.max(SPAWN_MIN_HANDOVER_MS, deadline - Date.now()));
      recordDelivery({ at: new Date(), pane_id, handle, project: p.project.name, text: args.prompt, request_id: args.request_id ?? null, via: "spawn", outcome: h.outcome, reason: h.reason });
      if (h.agent) tracker.observe(h.agent);
      const started = `${kind} is running as "${handle}" in ${where}, directory ${root}.`;
      const json = { ...base, status: h.agent?.agent_status ?? agent.agent_status, ...handoverJson(h), effect: true };
      if (h.outcome === "delivered") {
        return text(`${started} The first task was delivered${h.attempts > 1 ? ` after the agent became ready (${Math.round(h.ms / 1000)} s)` : ""}; the agent is working.`, json);
      }
      return text(`${started} ${handoverSentence(h, `"${handle}"`).replace("It is safe to send it again.", "Send it with send.")}`, json, true);
    } catch (e) {
      return text(`A ${where} was opened for ${kind} "${name}", but starting it failed: ${errorText(e)}.${taskNotDelivered} Check with status.`, { ...base, status: "unknown", delivered: false }, true);
    }
  }

  // ---------------------------------------------------------------- projects
  server.registerTool(
    "projects",
    {
      title: "Allowed projects",
      description: "Lists the allowed projects with keys, aliases and the number of running agents. Helps map spoken names.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      run("projects", {}, async () => {
        const b = await board();
        const rows = Object.entries(cfg.projects).map(([key, p]) => {
          const agents = b.agents.filter((a) => a.project === key);
          const counts = agents.reduce<Record<string, number>>((acc, a) => ((acc[a.status] = (acc[a.status] ?? 0) + 1), acc), {});
          return { key, name: p.name, aliases: p.aliases, root: p.root, agents: agents.length, by_status: counts };
        });
        const lines = rows.map(
          (r) =>
            `- ${r.name} (key ${r.key}${r.aliases.length ? `, also: ${r.aliases.join(", ")}` : ""}): ${r.agents} agent${r.agents === 1 ? "" : "s"}${
              r.agents ? ` – ${Object.entries(r.by_status).map(([s, n]) => `${n} ${s}`).join(", ")}` : ""
            }`,
        );
        const head = instance ? `Projects on ${instance}:\n` : "";
        return text(head + (lines.length ? lines.join("\n") : "No projects allowed. Add them to the config under 'projects'."), { instance, projects: rows });
      }),
  );

  return server;
}

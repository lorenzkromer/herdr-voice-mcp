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
import { loadBoard, matchProject, resolveTarget, type AgentView, type Board } from "./projects.js";
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

/** send calls by caller-chosen request_id; a retry with the same id gets the original result. */
const sendRequests = new Map<string, { at: Date; result: Promise<CallToolResult> }>();
const REQUEST_ID_TTL_MS = 60 * 60_000;

interface Delivery {
  at: Date;
  pane_id: string;
  handle: string;
  project: string;
  text: string;
  request_id: string | null;
  via: "send" | "spawn";
  /** delivered = Herdr confirmed the prompt; stalled = typed in, but no reaction observed. */
  outcome: "delivered" | "stalled";
}
/** Log of recent deliveries, newest last, so a caller can check after a dropped connection. */
const deliveries: Delivery[] = [];
const MAX_DELIVERIES = 100;

function recordDelivery(d: Delivery): void {
  deliveries.push(d);
  if (deliveries.length > MAX_DELIVERIES) deliveries.splice(0, deliveries.length - MAX_DELIVERIES);
}

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
        "Delivers a prompt to a running agent and acknowledges delivery right away. It then watches for only a few seconds whether the agent immediately asks a question or is already done; " +
        "usually it is still working – check later with wait, status or read. " +
        "IMPORTANT: always pass a fresh request_id and reuse the SAME request_id when retrying after a transport error – the server then returns the original result instead of delivering twice. " +
        "Without request_id, never retry blindly; check with deliveries (or read) whether the task arrived. " +
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
    async (args) =>
      run("send", args, async () => {
        if (!args.request_id) return doSend(args);
        for (const [k, v] of sendRequests) if (Date.now() - v.at.getTime() > REQUEST_ID_TTL_MS) sendRequests.delete(k);
        const earlier = sendRequests.get(args.request_id);
        if (earlier) {
          const r = await earlier.result;
          const first = r.content[0]?.type === "text" ? r.content[0].text : "";
          return {
            ...r,
            content: [{ type: "text", text: `Replay: request_id "${args.request_id}" was already handled at ${clockSeconds(earlier.at)}; nothing was sent again. The original answer was:\n${first}` }],
            structuredContent: { ...(r.structuredContent ?? {}), replayed: true, first_handled_at: earlier.at.toISOString() },
          };
        }
        const entry = { at: new Date(), result: doSend(args) };
        sendRequests.set(args.request_id, entry);
        const r = await entry.result.catch((e) => {
          sendRequests.delete(args.request_id!);
          throw e;
        });
        // Only a delivery is final; a refusal (unknown target, blocked, ...) may be retried with the same id.
        if (r.structuredContent?.delivered !== true) sendRequests.delete(args.request_id);
        return r;
      }),
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
            `${agentLabel(a)} is waiting for a decision and does not accept a new task. Current screen:\n${trimTail(r.text, 20)}`,
            { agent: viewJson(a), blocked: true },
            true,
          );
        }

        // Idempotency guard against duplicate delivery after a dropped connection.
        const key = `${a.pane_id}\u0000${args.text.trim()}`;
        const recent = recentSends.get(key);
        const windowMs = cfg.send.dedupe_minutes * 60_000;
        if (recent && !args.force && Date.now() - recent.getTime() < windowMs) {
          return text(
            `This exact task was already delivered to ${agentLabel(a)} at ${clock(recent)}. Not sent again. Check with read what became of it; if it really should run again: force=true.`,
            { agent: viewJson(a), duplicate: true, delivered_at: recent.toISOString() },
            true,
          );
        }

        let delivered: AgentInfo;
        try {
          delivered = await client.agentPrompt(a.pane_id, args.text);
        } catch (e) {
          if (e instanceof HerdrError && e.code === "agent_prompt_stalled") {
            recentSends.set(key, new Date());
            recordDelivery({ at: new Date(), pane_id: a.pane_id, handle: a.handle, project: a.project_name, text: args.text, request_id: args.request_id ?? null, via: "send", outcome: "stalled" });
            return text(
              `The text was sent to ${agentLabel(a)}, but Herdr observed no reaction. Delivered, outcome unknown – check with read, do not resend blindly.`,
              { agent: viewJson(a), delivered: true, stalled: true },
              true,
            );
          }
          throw e;
        }
        recentSends.set(key, new Date());
        recordDelivery({ at: new Date(), pane_id: a.pane_id, handle: a.handle, project: a.project_name, text: args.text, request_id: args.request_id ?? null, via: "send", outcome: "delivered" });
        for (const [k, t] of recentSends) if (Date.now() - t.getTime() > Math.max(windowMs, 60_000)) recentSends.delete(k);
        tracker.observe(delivered);

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
          } catch (e) {
            if (!(e instanceof HerdrError && e.code === "timeout")) throw e;
          }
        }
        const msg =
          status === "working"
            ? `Task delivered to ${agentLabel(a)} (${a.project_name}). The agent is working; get the result later with wait, status or read.`
            : `Task delivered to ${agentLabel(a)} (${a.project_name}). Already now: ${STATUS_WORD[status]}.${extra}`;
        return text(msg, { agent: viewJson(a), delivered: true, delivered_at: new Date().toISOString(), status_after: status });
  }

  // -------------------------------------------------------------- deliveries
  server.registerTool(
    "deliveries",
    {
      title: "Recent task deliveries",
      description:
        "Lists tasks that send/spawn delivered recently (time, agent, text, request_id). Use it after a transport error or when unsure whether a task arrived, " +
        "instead of sending again. Kept in memory since the service started (last " + MAX_DELIVERIES + ").",
      inputSchema: {
        target: z.string().optional().describe("Only deliveries to this agent (" + TARGET_HELP + ")"),
        request_id: z.string().optional().describe("Only the delivery made with this request_id."),
        minutes: z.number().int().min(1).max(24 * 60).optional().describe("Look back this many minutes (default 60)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      run("deliveries", args, async () => {
        const since = Date.now() - (args.minutes ?? 60) * 60_000;
        let list = deliveries.filter((d) => d.at.getTime() >= since);
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
          const pending = args.request_id && sendRequests.has(args.request_id) ? " (a send with this request_id is still in progress)" : "";
          return text(`No deliveries ${window}${args.request_id ? ` with request_id "${args.request_id}"` : ""}${args.target ? ` to "${args.target}"` : ""}${pending}.`, { deliveries: [] });
        }
        const lines = list.map(
          (d) => `- ${clockSeconds(d.at)} → "${d.handle}" (${d.project}) via ${d.via}${d.outcome === "stalled" ? ", typed in but no reaction seen" : ""}${d.request_id ? `, request_id ${d.request_id}` : ""}: ${d.text.length > 160 ? d.text.slice(0, 160) + "…" : d.text}`,
        );
        return text(`${list.length} deliver${list.length === 1 ? "y" : "ies"} ${window}:\n${lines.join("\n")}`, {
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
        "Check with read first what is being asked. Only for dialogs, not for dictating text – use send for that.",
      inputSchema: {
        target: z.string().describe(TARGET_HELP),
        keys: z.array(z.string()).min(1).max(10).describe("Key sequence, e.g. ['y','enter'] or ['down','enter']."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      run("keys", args, async () => {
        const bad = args.keys.filter((k) => !ALLOWED_KEYS.has(k.toLowerCase()));
        if (bad.length) return text(`Keys not allowed: ${bad.join(", ")}. Allowed: ${[...ALLOWED_KEYS].join(", ")}.`, undefined, true);
        const b = await board();
        const res = resolveTarget(b, cfg, args.target);
        if (res.kind === "none") return text(res.reason, undefined, true);
        if (res.kind === "many") return text(describeMany(res.agents, res.reason), { candidates: res.agents.map(viewJson) }, true);
        const a = res.agent;
        await client.agentSendKeys(a.pane_id, args.keys.map((k) => k.toLowerCase()));
        await new Promise((r) => setTimeout(r, 1500));
        const after = await client.agentGet(a.pane_id);
        tracker.observe(after);
        const r = await readScreen(client, a.pane_id, 30);
        return text(
          `Sent keys ${args.keys.join(" ")} to ${agentLabel(a)}. State now: ${STATUS_WORD[after.agent_status]}.\nScreen:\n${trimTail(r.text, 15)}`,
          { agent: viewJson(a), status_after: after.agent_status },
        );
      }),
  );

  // ------------------------------------------------------------------- spawn
  server.registerTool(
    "spawn",
    {
      title: "Start a new agent",
      description:
        "Starts a new coding agent (e.g. claude or codex) in an allowed project: a new tab in the project's workspace (or a new workspace if none is open), working directory = project root. " +
        "Optionally with a first task. Arbitrary shell commands are never passed through.",
      inputSchema: {
        project: z.string().describe("Project key, name or alias."),
        kind: z.string().optional().describe(`Agent kind: ${cfg.agent_kinds.join(" | ")} (default from project config, otherwise ${cfg.agent_kinds[0]}).`),
        name: z.string().optional().describe("Unique name for the agent (a-z, 0-9, -, _; generated by default)."),
        prompt: z.string().optional().describe("First task, sent right after start."),
        label: z.string().optional().describe("Tab label in Herdr (default: the agent name)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      run("spawn", args, async () => {
        const p = matchProject(cfg, args.project);
        if (!p) return text(`Unknown project "${args.project}". Allowed: ${Object.values(cfg.projects).map((x) => x.name).join(", ")}.`, undefined, true);
        const kind = (args.kind ?? p.project.default_kind ?? cfg.agent_kinds[0]).toLowerCase();
        if (!cfg.agent_kinds.includes(kind)) return text(`Agent kind "${kind}" is not allowed. Allowed: ${cfg.agent_kinds.join(", ")}.`, undefined, true);

        const existing = await client.agentList();
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

        // Find the primary workspace of the project (not a linked worktree).
        const workspaces = await client.workspaceList();
        const root = path.resolve(p.project.root);
        const primary =
          workspaces.find((w) => w.worktree && !w.worktree.is_linked_worktree && path.resolve(w.worktree.repo_root) === root) ??
          workspaces.find((w) => !w.worktree && [p.key, p.project.name, path.basename(root)].map((s) => s.toLowerCase()).includes(w.label.toLowerCase()));

        let pane_id: string;
        let where: string;
        let created: { kind: "tab" | "workspace"; id: string };
        const label = args.label ?? name;
        if (primary) {
          const t = await client.tabCreate(primary.workspace_id, root, label);
          pane_id = t.root_pane.pane_id;
          where = `new tab "${label}" in workspace "${primary.label}"`;
          created = { kind: "tab", id: t.tab.tab_id };
        } else {
          const w = await client.workspaceCreate(path.basename(root), root);
          pane_id = w.root_pane.pane_id;
          where = `new workspace "${w.workspace.label}"`;
          created = { kind: "workspace", id: w.workspace.workspace_id };
        }

        // The fresh shell needs a moment before agent.start accepts the pane.
        let agent: AgentInfo | null = null;
        let lastErr: unknown = null;
        for (let attempt = 0; attempt < 6; attempt++) {
          if (attempt) await new Promise((r) => setTimeout(r, 1000));
          try {
            agent = await client.agentStart(name, kind, pane_id, 90_000);
            break;
          } catch (e) {
            lastErr = e;
            if (e instanceof HerdrError && e.code === "agent_not_ready") break; // started but blocked (e.g. trust prompt)
            if (e instanceof HerdrError && /not_ready|busy|shell|prompt|foreground/i.test(e.code + e.message)) continue;
            throw e;
          }
        }

        if (!agent) {
          // agent_not_ready: the agent is present but blocked during startup.
          if (lastErr instanceof HerdrError && lastErr.code === "agent_not_ready") {
            let screen = "";
            try {
              screen = trimTail((await client.paneRead(pane_id, 30)).text, 15);
            } catch {
              /* ignore */
            }
            return text(
              `${kind} was started in ${where} (${pane_id}, name "${name}"), but is already waiting for input at startup. Screen:\n${screen}\nAnswer with keys (e.g. enter) or check with read.`,
              { pane_id, name, kind, project: p.key, status: "blocked", created },
            );
          }
          throw lastErr ?? new Error("agent.start failed");
        }

        tracker.observe(agent);
        let promptNote = "";
        if (args.prompt) {
          try {
            await client.agentPrompt(pane_id, args.prompt);
            recordDelivery({ at: new Date(), pane_id, handle: `${primary?.label ?? path.basename(root)}/${name}`, project: p.project.name, text: args.prompt, request_id: null, via: "spawn", outcome: "delivered" });
            promptNote = " The first task was delivered; the agent is working.";
          } catch (e) {
            promptNote = ` The first task could not be delivered (${errorText(e)}).`;
          }
        }
        return text(
          `${kind} is running as "${name}" in ${where} (${pane_id}), directory ${root}.${promptNote}`,
          { pane_id, name, kind, project: p.key, status: agent.agent_status, created },
        );
      }),
  );

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

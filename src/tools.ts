// MCP tool definitions. One McpServer instance is created per HTTP request
// (stateless transport); the shared context (Herdr client, tracker, audit)
// lives for the whole process.

import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Audit } from "./audit.js";
import type { AgencyConfig } from "./config.js";
import { HerdrClient, HerdrError, type AgentInfo, type AgentStatus } from "./herdr.js";
import { agentLabel, agentLine, clock, formatBoard, formatStandup, STATUS_WORD, trimTail, type StandupItem } from "./format.js";
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
  return `${reason}. Please be more specific. Candidates:\n${agents.map((a) => `- ${agentLabel(a)} [${a.pane_id}] ${STATUS_WORD[a.status]}${a.topic ? ` · ${a.topic}` : ""}`).join("\n")}`;
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
  const server = new McpServer({ name: "agency", version: "0.1.0" });

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
        const out = formatBoard(agents, tracker, { hidden: args.project ? 0 : b.hidden, attentionOnly: args.only === "attention" });
        return text(out, { agents: agents.map(viewJson), hidden: b.hidden });
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
                const r = await client.agentRead(agent.pane_id, Math.max(lines * 3, 40));
                tail = trimTail(r.text, lines);
              } catch (e) {
                tail = `(output not readable: ${errorText(e)})`;
              }
            }
            return { agent, isNew, tail };
          }),
        );
        const out = formatStandup(items, rest, tracker, last);
        tracker.lastStandupAt = new Date();
        return text(out, {
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
        "target: agent name, pane ID, project name/alias or workspace label.",
      inputSchema: {
        target: z.string().describe("Agent name, pane ID (w4:p1), project or workspace label."),
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
        const r = await client.agentRead(a.pane_id, Math.min(lines * 2 + 20, cfg.read.max_lines + 40), args.source ?? "recent_unwrapped");
        const body = trimTail(r.text, lines);
        const head = `${agentLine(a, tracker)}\nLast ${lines} lines${r.truncated ? " (truncated)" : ""}:\n`;
        return text(head + body, { agent: viewJson(a), text: body, truncated: r.truncated });
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
        "IMPORTANT: if the connection drops during this call, the task still counts as delivered. Never retry blindly; check with read first. " +
        "An identical text to the same agent is refused within " + cfg.send.dedupe_minutes + " minutes unless force=true. " +
        "Refuses to send while the agent is waiting for a decision (use keys or read then).",
      inputSchema: {
        target: z.string().describe("Agent name, pane ID, project or workspace label."),
        text: z.string().min(1).describe("The task, exactly as it should be given to the agent."),
        settle_seconds: z.number().int().min(0).max(20).optional().describe(`How long to watch for an immediate state after delivery (default ${cfg.send.settle_seconds}, 0 = not at all).`),
        force: z.boolean().optional().describe("Send the same text again despite a recent delivery."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      run("send", args, async () => {
        const b = await board();
        const res = resolveTarget(b, cfg, args.target);
        if (res.kind === "none") return text(res.reason, undefined, true);
        if (res.kind === "many") return text(describeMany(res.agents, res.reason), { candidates: res.agents.map(viewJson) }, true);
        const a = res.agent;
        if (a.status === "blocked") {
          const r = await client.agentRead(a.pane_id, 30);
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
            return text(
              `The text was sent to ${agentLabel(a)}, but Herdr observed no reaction. Delivered, outcome unknown – check with read, do not resend blindly.`,
              { agent: viewJson(a), delivered: true, stalled: true },
              true,
            );
          }
          throw e;
        }
        recentSends.set(key, new Date());
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
            const r = await client.agentRead(a.pane_id, 40);
            extra = `\nLast output:\n${trimTail(r.text, 15)}`;
          } catch (e) {
            if (!(e instanceof HerdrError && e.code === "timeout")) throw e;
          }
        }
        const msg =
          status === "working"
            ? `Task delivered to ${agentLabel(a)} (${a.project_name}). The agent is working; get the result later with wait, status or read.`
            : `Task delivered to ${agentLabel(a)} (${a.project_name}). Already now: ${STATUS_WORD[status]}.${extra}`;
        return text(msg, { agent: viewJson(a), delivered: true, status_after: status });
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
        target: z.string().describe("Agent name, pane ID, project or workspace label."),
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
          const r = await client.agentRead(a.pane_id, 40);
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
        target: z.string().describe("Agent name, pane ID, project or workspace label."),
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
        const r = await client.agentRead(a.pane_id, 30);
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
        return text(lines.length ? lines.join("\n") : "No projects allowed. Add them to the config under 'projects'.", { projects: rows });
      }),
  );

  return server;
}

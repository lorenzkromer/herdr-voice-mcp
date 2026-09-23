// Speech-friendly summaries. Claude reads these and retells them in the
// user's language; the goal is compact text without IDs in the foreground.

import type { AgentStatus } from "./herdr.js";
import type { AgentView } from "./projects.js";
import type { Tracker } from "./tracker.js";

export function humanDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s === 1 ? "1 second" : `${s} seconds`;
  const m = Math.round(s / 60);
  if (m < 60) return m === 1 ? "1 minute" : `${m} minutes`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h < 24) return rest ? `${h} h ${rest} min` : h === 1 ? "1 hour" : `${h} hours`;
  const d = Math.floor(h / 24);
  return d === 1 ? "1 day" : `${d} days`;
}

export const STATUS_WORD: Record<AgentStatus, string> = {
  blocked: "needs a decision",
  done: "finished, not yet reviewed",
  working: "working",
  idle: "ready",
  unknown: "state unclear",
};

export const STATUS_ORDER: AgentStatus[] = ["blocked", "done", "working", "idle", "unknown"];

export function agentLabel(a: AgentView): string {
  const who = a.name ?? (a.kind ? `${a.kind} agent` : "agent");
  const where = a.workspace_label && a.workspace_label !== a.project_name ? ` in "${a.workspace_label}"` : "";
  return `${who}${where}`;
}

export function sinceText(a: AgentView, tracker: Tracker, now = Date.now()): string {
  const t = tracker.get(a.pane_id);
  if (!t || !tracker.ready) return "";
  const dur = humanDuration(now - t.since.getTime());
  return t.previous === null ? ` (for at least ${dur})` : ` (for ${dur})`;
}

export function agentLine(a: AgentView, tracker: Tracker, now = Date.now()): string {
  const topic = a.topic ? ` · topic: ${a.topic}` : "";
  return `- ${a.project_name}: ${agentLabel(a)} [${a.kind ?? "?"}, ${a.pane_id}] ${STATUS_WORD[a.status]}${sinceText(a, tracker, now)}${topic}`;
}

export function clock(d = new Date()): string {
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function capitalize(s: string): string {
  return s[0].toUpperCase() + s.slice(1);
}

export function formatBoard(agents: AgentView[], tracker: Tracker, opts: { hidden: number; attentionOnly?: boolean }): string {
  const now = Date.now();
  const attention = agents.filter((a) => a.status === "blocked" || a.status === "done");
  const projects = new Set(agents.map((a) => a.project));
  const head = `Board at ${clock()}: ${plural(agents.length, "agent", "agents")} in ${plural(projects.size, "project", "projects")}, ${attention.length} need attention.`;
  const lines: string[] = [head];
  const shown = opts.attentionOnly ? attention : agents;
  for (const status of STATUS_ORDER) {
    const group = shown.filter((a) => a.status === status);
    if (!group.length) continue;
    lines.push("");
    lines.push(`${capitalize(STATUS_WORD[status])}:`);
    for (const a of group) lines.push(agentLine(a, tracker, now));
  }
  if (opts.attentionOnly && !attention.length) lines.push("Nobody needs anything right now.");
  if (opts.hidden) lines.push("", `(${plural(opts.hidden, "more agent runs", "more agents run")} outside the allowed projects and ${opts.hidden === 1 ? "is" : "are"} not shown.)`);
  return lines.join("\n");
}

export interface StandupItem {
  agent: AgentView;
  isNew: boolean;
  tail: string | null;
}

/** Terminal chrome that carries no information for a spoken summary. */
const CHROME = [
  /^[─━═\-_=\s]+$/, // rulers
  /^\s*[❯>›]\s*$/, // empty input prompt
  /^\s*⏵⏵/, // Claude Code mode line
  /^\s*[⬆⚠].*\/gsd-update/, // plugin nag bar
  /Update installed · Restart to update/,
  /^\s*\? for shortcuts/,
  /^\s*Esc to cancel · Tab to amend\s*$/,
];

export function trimTail(text: string, maxLines: number): string {
  const lines = text
    .split("\n")
    .map((l) => l.replace(/\s+$/g, ""))
    .filter((l) => l.trim().length > 0 && !CHROME.some((re) => re.test(l)));
  return lines.slice(-maxLines).join("\n");
}

export function formatStandup(items: StandupItem[], rest: AgentView[], tracker: Tracker, lastStandupAt: Date | null): string {
  const now = Date.now();
  const lines: string[] = [];
  const since = lastStandupAt ? `Since the last stand-up (${clock(lastStandupAt)})` : "First stand-up since the service started";
  const blocked = items.filter((i) => i.agent.status === "blocked");
  const done = items.filter((i) => i.agent.status === "done");
  lines.push(`${since}: ${done.length} finished, ${blocked.length} waiting for a decision, ${rest.filter((a) => a.status === "working").length} still working.`);

  const section = (title: string, list: StandupItem[]) => {
    if (!list.length) return;
    lines.push("", `${title}:`);
    for (const it of list) {
      lines.push(`${agentLine(it.agent, tracker, now)}${it.isNew ? " — NEW" : " — already reported last time"}`);
      if (it.tail) {
        lines.push("  Last output:");
        for (const l of it.tail.split("\n")) lines.push(`    ${l}`);
      }
    }
  };
  section("Needs a decision", blocked);
  section("Finished", done);

  const working = rest.filter((a) => a.status === "working");
  const idle = rest.filter((a) => a.status === "idle");
  if (working.length) {
    lines.push("", "Still working:");
    for (const a of working) lines.push(agentLine(a, tracker, now));
  }
  if (idle.length) {
    lines.push("", `Ready without a task: ${idle.map((a) => `${a.project_name} (${agentLabel(a)})`).join(", ")}.`);
  }
  return lines.join("\n");
}

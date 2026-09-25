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

/**
 * How long the agent has been in its state. A state that was already present when the
 * service started has no known start, so it is reported as "since before <start>" rather
 * than as a duration that would look precise.
 */
/** A tracker, or a lookup of the tracker responsible for an agent (one per Herdr instance). */
export type Trackers = Tracker | ((a: AgentView) => Tracker);

function trackerOf(trackers: Trackers, a: AgentView): Tracker {
  return typeof trackers === "function" ? trackers(a) : trackers;
}

export function sinceText(a: AgentView, trackers: Trackers, now = Date.now()): string {
  const tracker = trackerOf(trackers, a);
  const t = tracker.get(a.pane_id);
  if (!t || !tracker.ready) return "";
  if (!t.exact) return ` (since before ${clock(tracker.startedAt, now)}, when the service started)`;
  return ` (for ${humanDuration(now - t.since.getTime())})`;
}

export function agentLine(a: AgentView, tracker: Trackers, now = Date.now()): string {
  const topic = a.topic ? ` · topic: ${a.topic}` : "";
  return `- ${a.project_name}: "${a.handle}" (${a.kind ?? "?"}) ${STATUS_WORD[a.status]}${sinceText(a, tracker, now)}${topic}`;
}

/** Time of day; prefixed with "yesterday" or the date when it is not today. */
export function clock(d = new Date(), now = Date.now()): string {
  const hm = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const day = (x: Date) => x.toDateString();
  const today = new Date(now);
  if (day(d) === day(today)) return hm;
  const yesterday = new Date(now - 86_400_000);
  if (day(d) === day(yesterday)) return `yesterday ${hm}`;
  return `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} ${hm}`;
}

/** Time of day with seconds, for read stamps. */
export function clockSeconds(d = new Date()): string {
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function capitalize(s: string): string {
  return s[0].toUpperCase() + s.slice(1);
}

/** " on Office" when an instance name is configured, "" otherwise. */
export function onInstance(instance: string | null | undefined): string {
  return instance ? ` on ${instance}` : "";
}

/** One line per instance that did not answer. */
function unreachableLines(unreachable: Array<{ instance: string; error: string }> | undefined): string[] {
  if (!unreachable?.length) return [];
  return ["", ...unreachable.map((u) => `${u.instance} is NOT reachable right now (${u.error}); its agents are missing from this list.`)];
}

export function formatBoard(
  agents: AgentView[],
  tracker: Trackers,
  opts: { hidden: number; attentionOnly?: boolean; instance?: string | null; unreachable?: Array<{ instance: string; error: string }> },
): string {
  const now = Date.now();
  const attention = agents.filter((a) => a.status === "blocked" || a.status === "done");
  const projects = new Set(agents.map((a) => a.project));
  const head = `Board${onInstance(opts.instance)} at ${clock()}: ${plural(agents.length, "agent", "agents")} in ${plural(projects.size, "project", "projects")}, ${attention.length} need attention.`;
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
  lines.push(...unreachableLines(opts.unreachable));
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
  /^[\s│┃|]*[╭╰┌└][─━\s]*[╮╯┐┘]?[\s│┃|]*$/, // top/bottom of an input box
  /^\s*[│┃]\s*[>❯›]?\s*[│┃]\s*$/, // empty input box row
  /^[\u2800-\u28ff\s]+$/, // braille spinner / logo art
  /^\s*(?:shift\+tab|ctrl\+[a-z]) to /, // key hints
  /^\s*\S+ (?:minimal|low|medium|high|xhigh) · [~/]/, // Codex footer: model · effort · cwd
  /^\s*[⬆⚠].*│.*│/, // status bar with separators
  /^\s*⎿\s+Tip: /, // Claude Code tips
];

/**
 * Progress lines whose spinners and timers tick every second ("✢ Gusting… (5m 52s · ↓ 32.5k tokens)",
 * "Working (12s · esc to interrupt)"); kept for reading, ignored when comparing reads.
 */
export const PROGRESS = /\b(?:esc|Esc) to interrupt\b|^\s*\S\s+[^\s()]+(?:…|\.\.\.)\s*\(/;
/** Trailing elapsed-time stamps on tool lines ("⏺ Running tests · 2s"). */
export const ELAPSED = /\s+·\s+\d+(?:\.\d+)?\s*(?:ms|s|m|min)(?:\s+\d+s)?\s*$/;

export function trimTail(text: string, maxLines: number): string {
  const lines = text
    .split("\n")
    .map((l) => l.replace(/\s+$/g, ""))
    .filter((l) => l.trim().length > 0 && !CHROME.some((re) => re.test(l)));
  return lines.slice(-maxLines).join("\n");
}

export function formatStandup(
  items: StandupItem[],
  rest: AgentView[],
  tracker: Trackers,
  lastStandupAt: Date | null,
  instance?: string | null,
  unreachable?: Array<{ instance: string; error: string }>,
): string {
  const now = Date.now();
  const lines: string[] = [];
  const since = lastStandupAt ? `Since the last stand-up (${clock(lastStandupAt)})` : "First stand-up since the service started";
  const blocked = items.filter((i) => i.agent.status === "blocked");
  const done = items.filter((i) => i.agent.status === "done");
  lines.push(`Stand-up${onInstance(instance)}. ${since}: ${done.length} finished, ${blocked.length} waiting for a decision, ${rest.filter((a) => a.status === "working").length} still working.`);

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
  lines.push(...unreachableLines(unreachable));
  return lines.join("\n");
}

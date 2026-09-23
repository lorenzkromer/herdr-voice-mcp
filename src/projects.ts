// Whitelist and target resolution.
//
// Only agents that can be attributed to a configured project are visible to
// the MCP tools. Attribution uses, in order:
//   1. the workspace's git repo root (Herdr reports it for worktree workspaces)
//   2. the agent's cwd lying below a project root / extra root
//   3. the agent's cwd lying below a linked-worktree location derived from
//      `worktree_patterns` and the repo's basename

import path from "node:path";
import type { AgencyConfig, ProjectConfig } from "./config.js";
import type { AgentInfo, AgentStatus, HerdrClient, TabInfo, WorkspaceInfo } from "./herdr.js";

export interface AgentView {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  /** Live agent name (may be null; Herdr names are optional). */
  name: string | null;
  /** Agent kind, e.g. "claude" or "codex". */
  kind: string | null;
  status: AgentStatus;
  cwd: string | null;
  workspace_label: string;
  tab_label: string | null;
  /** Project key from config. Agents without a project are filtered out before this is exposed. */
  project: string;
  project_name: string;
  /** Terminal title stripped of status glyphs; usually the topic of the session. */
  topic: string | null;
  state_change_seq: number;
  focused: boolean;
}

export interface Board {
  agents: AgentView[];
  workspaces: WorkspaceInfo[];
  /** Number of live agents that were hidden by the whitelist. */
  hidden: number;
}

function isBelow(cwd: string, root: string): boolean {
  const c = path.resolve(cwd);
  const r = path.resolve(root);
  return c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

export function projectRoots(cfg: AgencyConfig, key: string): string[] {
  const p = cfg.projects[key];
  if (!p) return [];
  const repo = path.basename(p.root);
  const derived = cfg.worktree_patterns.map((pat) => pat.replace("{repo}", repo));
  return [p.root, ...p.extra_roots, ...derived];
}

/** Returns the project key for an agent, or null when it is not whitelisted. */
export function projectForAgent(cfg: AgencyConfig, agent: Pick<AgentInfo, "cwd" | "foreground_cwd">, workspace?: WorkspaceInfo | null): string | null {
  const repoRoot = workspace?.worktree?.repo_root ?? null;
  for (const [key, p] of Object.entries(cfg.projects)) {
    if (repoRoot && [p.root, ...p.extra_roots].some((r) => path.resolve(r) === path.resolve(repoRoot))) return key;
  }
  const cwd = agent.cwd ?? agent.foreground_cwd ?? null;
  if (!cwd) return null;
  for (const key of Object.keys(cfg.projects)) {
    if (projectRoots(cfg, key).some((r) => isBelow(cwd, r))) return key;
  }
  return null;
}

/** Lowercase, German umlauts → ae/oe/ue/ss, punctuation → space. Makes spoken names comparable. */
export function normalizeQuery(s: string): string {
  return s
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[\s._\-/]+/g, " ")
    .trim();
}

/** Finds a project by key, name or alias. Case-insensitive; dots, dashes and underscores are ignored. */
export function matchProject(cfg: AgencyConfig, query: string): { key: string; project: ProjectConfig } | null {
  const q = normalizeQuery(query);
  if (!q) return null;
  for (const [key, p] of Object.entries(cfg.projects)) {
    const names = [key, p.name, path.basename(p.root), ...p.aliases].map(normalizeQuery);
    if (names.includes(q)) return { key, project: p };
  }
  // Fall back to substring match if unique.
  const hits = Object.entries(cfg.projects).filter(([key, p]) =>
    [key, p.name, path.basename(p.root), ...p.aliases].map(normalizeQuery).some((n) => n.includes(q) || q.includes(n)),
  );
  if (hits.length === 1) return { key: hits[0][0], project: hits[0][1] };
  return null;
}

export async function loadBoard(client: HerdrClient, cfg: AgencyConfig): Promise<Board> {
  const [agents, workspaces] = await Promise.all([client.agentList(), client.workspaceList()]);
  const wsById = new Map(workspaces.map((w) => [w.workspace_id, w]));

  const visible: AgentView[] = [];
  let hidden = 0;
  const wsNeedingTabs = new Set<string>();

  for (const a of agents) {
    const ws = wsById.get(a.workspace_id) ?? null;
    const key = projectForAgent(cfg, a, ws);
    if (!key) {
      hidden++;
      continue;
    }
    wsNeedingTabs.add(a.workspace_id);
    visible.push({
      pane_id: a.pane_id,
      workspace_id: a.workspace_id,
      tab_id: a.tab_id,
      name: a.name ?? null,
      kind: a.agent ?? null,
      status: a.agent_status,
      cwd: a.cwd ?? a.foreground_cwd ?? null,
      workspace_label: ws?.label ?? a.workspace_id,
      tab_label: null,
      project: key,
      project_name: cfg.projects[key].name,
      topic: a.terminal_title_stripped ?? a.title ?? null,
      state_change_seq: a.state_change_seq ?? 0,
      focused: a.focused,
    });
  }

  // Tab labels: one call per workspace that hosts visible agents.
  const tabLists = await Promise.all(
    [...wsNeedingTabs].map(async (id) => {
      try {
        return await client.tabList(id);
      } catch {
        return [] as TabInfo[];
      }
    }),
  );
  const tabById = new Map<string, TabInfo>();
  for (const list of tabLists) for (const t of list) tabById.set(t.tab_id, t);
  for (const v of visible) v.tab_label = tabById.get(v.tab_id)?.label ?? null;

  return { agents: visible, workspaces, hidden };
}

export type Resolution =
  | { kind: "one"; agent: AgentView }
  | { kind: "many"; agents: AgentView[]; reason: string }
  | { kind: "none"; reason: string };

/**
 * Resolves a spoken/typed target to exactly one visible agent.
 * Accepts: live agent name, pane id, project key/name/alias, workspace label, tab label.
 * Optionally narrows by status (e.g. only blocked agents).
 */
export function resolveTarget(board: Board, cfg: AgencyConfig, target: string, statusFilter?: AgentStatus[]): Resolution {
  const raw = target.trim();
  const q = normalizeQuery(raw);
  let pool = board.agents;
  if (statusFilter?.length) pool = pool.filter((a) => statusFilter.includes(a.status));

  const byName = pool.filter((a) => a.name && a.name.toLowerCase() === raw.toLowerCase());
  if (byName.length === 1) return { kind: "one", agent: byName[0] };

  const byPane = pool.filter((a) => a.pane_id.toLowerCase() === raw.toLowerCase());
  if (byPane.length === 1) return { kind: "one", agent: byPane[0] };

  const byWorkspace = pool.filter((a) => normalizeQuery(a.workspace_label) === q);
  if (byWorkspace.length === 1) return { kind: "one", agent: byWorkspace[0] };
  if (byWorkspace.length > 1) return { kind: "many", agents: byWorkspace, reason: `several agents in workspace "${raw}"` };

  const byTab = pool.filter((a) => a.tab_label && normalizeQuery(a.tab_label) === q);
  if (byTab.length === 1) return { kind: "one", agent: byTab[0] };

  const proj = matchProject(cfg, raw);
  if (proj) {
    const inProject = pool.filter((a) => a.project === proj.key);
    if (inProject.length === 1) return { kind: "one", agent: inProject[0] };
    if (inProject.length > 1) return { kind: "many", agents: inProject, reason: `several agents in project "${proj.project.name}"` };
    return { kind: "none", reason: `no${statusFilter?.length ? " matching" : ""} agent is running in project "${proj.project.name}"` };
  }

  // Loose name match (spoken names lose punctuation).
  const loose = pool.filter((a) => a.name && normalizeQuery(a.name) === q);
  if (loose.length === 1) return { kind: "one", agent: loose[0] };
  const fuzzy = pool.filter((a) => (a.name && normalizeQuery(a.name).includes(q)) || (a.topic && normalizeQuery(a.topic).includes(q)));
  if (fuzzy.length === 1) return { kind: "one", agent: fuzzy[0] };
  if (fuzzy.length > 1) return { kind: "many", agents: fuzzy, reason: `"${raw}" matches several agents` };

  return { kind: "none", reason: `no agent or project named "${raw}" found` };
}

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
  /** Speakable name of the Herdr instance the agent runs on (config instance_name), or null. */
  instance: string | null;
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
  /**
   * Stable, speakable address: "<workspace>/<name, tab label or kind>", with "@<pane id>"
   * appended only when that would otherwise be ambiguous. Always accepted as a target.
   */
  handle: string;
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

/**
 * Returns the project key for an agent, or null when it is not whitelisted.
 * When several project roots contain the agent's directory (a project rooted at a parent
 * folder of other projects), the most specific (longest) root wins, independent of the
 * order in the config.
 */
export function projectForAgent(cfg: AgencyConfig, agent: Pick<AgentInfo, "cwd" | "foreground_cwd">, workspace?: WorkspaceInfo | null): string | null {
  const repoRoot = workspace?.worktree?.repo_root ?? null;
  for (const [key, p] of Object.entries(cfg.projects)) {
    if (repoRoot && [p.root, ...p.extra_roots].some((r) => path.resolve(r) === path.resolve(repoRoot))) return key;
  }
  const cwd = agent.cwd ?? agent.foreground_cwd ?? null;
  if (!cwd) return null;
  let best: { key: string; depth: number } | null = null;
  for (const key of Object.keys(cfg.projects)) {
    for (const r of projectRoots(cfg, key)) {
      const depth = path.resolve(r).length;
      if (isBelow(cwd, r) && (!best || depth > best.depth)) best = { key, depth };
    }
  }
  return best?.key ?? null;
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
      instance: cfg.instance_name ?? null,
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
      handle: "",
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
  assignHandles(visible);

  return { agents: visible, workspaces, hidden };
}

/** Fills `handle` for every agent; see AgentView.handle. */
export function assignHandles(agents: AgentView[]): void {
  const base = (a: AgentView) => `${a.workspace_label}/${a.name ?? (isCustomTabLabel(a.tab_label) ? a.tab_label : null) ?? a.kind ?? "agent"}`;
  const counts = new Map<string, number>();
  for (const a of agents) counts.set(normalizeQuery(base(a)), (counts.get(normalizeQuery(base(a))) ?? 0) + 1);
  for (const a of agents) a.handle = counts.get(normalizeQuery(base(a)))! > 1 ? `${base(a)}@${a.pane_id}` : base(a);
}

/**
 * The workspace `spawn` should add a tab to, or null to create a new one. In order:
 *   1. Herdr's worktree info says it is the project's primary checkout;
 *   2. its label names the project (key, name, root basename or alias; spoken-name
 *      tolerant, so "Herdr Voice MCP" matches "herdr-voice-mcp");
 *   3. it already hosts an agent working in the project root. Automation run
 *      workspaces ("auto: ...") are skipped here; they come and go per run.
 */
export function findProjectWorkspace(
  workspaces: WorkspaceInfo[],
  agents: Pick<AgentInfo, "workspace_id" | "cwd" | "foreground_cwd">[],
  key: string,
  project: ProjectConfig,
  root: string,
): WorkspaceInfo | null {
  const byWorktree = workspaces.find((w) => w.worktree && !w.worktree.is_linked_worktree && path.resolve(w.worktree.repo_root) === root);
  if (byWorktree) return byWorktree;
  const names = new Set([key, project.name, path.basename(root), ...project.aliases].map(normalizeQuery));
  const byLabel = workspaces.find((w) => !w.worktree?.is_linked_worktree && names.has(normalizeQuery(w.label)));
  if (byLabel) return byLabel;
  const counts = new Map<string, number>();
  for (const a of agents) {
    const cwd = a.cwd ?? a.foreground_cwd;
    if (cwd && path.resolve(cwd) === root) counts.set(a.workspace_id, (counts.get(a.workspace_id) ?? 0) + 1);
  }
  const candidates = workspaces.filter((w) => counts.has(w.workspace_id) && !w.worktree?.is_linked_worktree && !/^auto:/i.test(w.label));
  candidates.sort((a, b) => counts.get(b.workspace_id)! - counts.get(a.workspace_id)!);
  return candidates[0] ?? null;
}

/** Herdr generates tab labels like "1 · codex › Fix login | repo"; only short hand-set labels make good handles. */
function isCustomTabLabel(label: string | null): label is string {
  return !!label && label.length <= 24 && !/[·›|]/.test(label) && !/^\d+$/.test(label.trim());
}

/** Pane IDs as they come out of speech: "W1Y p1", "w1y-p1", "w1yp1" all mean "w1Y:p1". */
function paneKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export type Resolution =
  | { kind: "one"; agent: AgentView }
  | { kind: "many"; agents: AgentView[]; reason: string }
  | { kind: "none"; reason: string };

/**
 * Resolves a spoken/typed target to exactly one visible agent.
 * Accepts: handle ("workspace/name"), pane id (also spoken variants), live agent name,
 * workspace label, tab label, "<workspace or project>/<name, tab, kind or topic>",
 * project key/name/alias, part of the session topic.
 * Exact matches of different kinds that point at different agents are reported as
 * ambiguous instead of silently preferring one kind (a name must not beat a workspace).
 * Optionally narrows by status (e.g. only blocked agents).
 */
export function resolveTarget(board: Board, cfg: AgencyConfig, target: string, statusFilter?: AgentStatus[]): Resolution {
  let raw = target.trim();
  let pool = board.agents;
  if (statusFilter?.length) pool = pool.filter((a) => statusFilter.includes(a.status));

  // 0. Optional instance prefix: "Office/shop/codex", or just "Office". Narrows the pool to that
  //    instance and resolves the rest as usual (with one instance it only checks and strips).
  const instances = new Set([cfg.instance_name, ...board.agents.map((a) => a.instance)].filter((n): n is string => !!n));
  for (const inst of instances) {
    const ni = normalizeQuery(inst);
    const slash = raw.indexOf("/");
    const head = normalizeQuery(slash >= 0 ? raw.slice(0, slash) : raw);
    if (head !== ni) continue;
    pool = pool.filter((a) => (a.instance ?? cfg.instance_name) === inst);
    raw = slash >= 0 ? raw.slice(slash + 1).trim() : "";
    if (!raw) return pickOne(pool, `several agents on ${inst}`, `no${statusFilter?.length ? " matching" : ""} agent on ${inst}`);
    break;
  }
  const q = normalizeQuery(raw);
  if (!q) return { kind: "none", reason: "empty target" };

  // 1. Unambiguous addresses: handle, pane id (optionally as "...@<pane id>").
  const byHandle = pool.filter((a) => normalizeQuery(a.handle) === q);
  if (byHandle.length === 1) return { kind: "one", agent: byHandle[0] };
  const at = raw.lastIndexOf("@");
  const paneQuery = paneKey(at >= 0 ? raw.slice(at + 1) : raw);
  const byPane = pool.filter((a) => paneKey(a.pane_id) === paneQuery);
  if (byPane.length === 1) return { kind: "one", agent: byPane[0] };

  // 2. Qualified: "<workspace or project>/<rest>".
  const slash = raw.indexOf("/");
  if (slash > 0) {
    const left = raw.slice(0, slash);
    const right = normalizeQuery(raw.slice(slash + 1));
    const lq = normalizeQuery(left);
    let scope = pool.filter((a) => normalizeQuery(a.workspace_label) === lq);
    if (!scope.length) {
      const proj = matchProject(cfg, left);
      if (proj) scope = pool.filter((a) => a.project === proj.key);
    }
    if (scope.length) {
      if (!right) return pickOne(scope, `several agents in "${left}"`);
      const exact = scope.filter((a) => [a.name, a.tab_label, a.kind].some((n) => n && normalizeQuery(n) === right));
      if (exact.length) return pickOne(exact, `"${raw}" matches several agents`);
      const partial = scope.filter((a) => [a.name, a.tab_label, a.topic].some((n) => n && normalizeQuery(n).includes(right)));
      if (partial.length) return pickOne(partial, `"${raw}" matches several agents`);
      return { kind: "none", reason: `nothing called "${raw.slice(slash + 1)}" in "${left}"` };
    }
  }

  // 3. Exact name / workspace label / tab label, all considered together.
  const exactHits = new Map<string, { agent: AgentView; via: string[] }>();
  const add = (list: AgentView[], via: string) => {
    for (const a of list) {
      const e = exactHits.get(a.pane_id) ?? { agent: a, via: [] };
      e.via.push(via);
      exactHits.set(a.pane_id, e);
    }
  };
  add(pool.filter((a) => a.name && normalizeQuery(a.name) === q), "agent name");
  add(pool.filter((a) => normalizeQuery(a.workspace_label) === q), "workspace");
  add(pool.filter((a) => a.tab_label && normalizeQuery(a.tab_label) === q), "tab");
  if (exactHits.size === 1) return { kind: "one", agent: [...exactHits.values()][0].agent };
  if (exactHits.size > 1) {
    const kinds = new Set([...exactHits.values()].flatMap((e) => e.via));
    const reason = kinds.size > 1 ? `"${raw}" is both ${[...kinds].join(" and ")} of different agents` : `several agents match "${raw}" by ${[...kinds][0]}`;
    return { kind: "many", agents: [...exactHits.values()].map((e) => e.agent), reason };
  }

  // 4. Project.
  const proj = matchProject(cfg, raw);
  if (proj) {
    const inProject = pool.filter((a) => a.project === proj.key);
    if (inProject.length === 1) return { kind: "one", agent: inProject[0] };
    if (inProject.length > 1) return { kind: "many", agents: inProject, reason: `several agents in project "${proj.project.name}"` };
    return { kind: "none", reason: `no${statusFilter?.length ? " matching" : ""} agent is running in project "${proj.project.name}"` };
  }

  // 5. Partial name or topic.
  const fuzzy = pool.filter((a) => (a.name && normalizeQuery(a.name).includes(q)) || (a.topic && normalizeQuery(a.topic).includes(q)));
  if (fuzzy.length === 1) return { kind: "one", agent: fuzzy[0] };
  if (fuzzy.length > 1) return { kind: "many", agents: fuzzy, reason: `"${raw}" matches several agents` };

  return { kind: "none", reason: `no agent or project named "${raw}" found${statusFilter?.length ? ` with status ${statusFilter.join("/")}` : ""}` };
}

function pickOne(list: AgentView[], reason: string, noneReason = "no matching agent"): Resolution {
  if (!list.length) return { kind: "none", reason: noneReason };
  return list.length === 1 ? { kind: "one", agent: list[0] } : { kind: "many", agents: list, reason };
}

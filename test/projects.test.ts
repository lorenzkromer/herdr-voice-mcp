import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseConfig } from "../src/config.js";
import type { WorkspaceInfo } from "../src/herdr.js";
import { assignHandles, findProjectWorkspace, matchProject, projectForAgent, resolveTarget, type AgentView, type Board } from "../src/projects.js";

const home = os.homedir();
const cfg = parseConfig({
  worktree_patterns: ["~/development/.herdr-worktrees/{repo}", "~/worktrees/{repo}"],
  projects: {
    "acme": { name: "Acme Web App", root: "~/development/acme-web", aliases: ["acme web", "rocket"] },
    "shop": { name: "Shop Backend", root: "~/development/shop-backend", aliases: ["öl", "storefront"] },
  },
});

function ws(id: string, label: string, repo_root?: string, linked = false): WorkspaceInfo {
  return {
    workspace_id: id,
    number: 1,
    label,
    focused: false,
    pane_count: 1,
    tab_count: 1,
    active_tab_id: `${id}:t1`,
    agent_status: "idle",
    worktree: repo_root ? { repo_key: repo_root + "/.git", repo_name: path.basename(repo_root), repo_root, checkout_path: repo_root, is_linked_worktree: linked } : null,
  };
}

test("projectForAgent: cwd below root", () => {
  assert.equal(projectForAgent(cfg, { cwd: path.join(home, "development/acme-web/src") }, null), "acme");
});

test("projectForAgent: repo root from workspace wins for linked worktrees", () => {
  const w = ws("w9", "feature-x", path.join(home, "development/shop-backend"), true);
  assert.equal(projectForAgent(cfg, { cwd: "/somewhere/else" }, w), "shop");
});

test("projectForAgent: derived worktree patterns", () => {
  assert.equal(projectForAgent(cfg, { cwd: path.join(home, "development/.herdr-worktrees/acme-web/feature-x") }, null), "acme");
  assert.equal(projectForAgent(cfg, { cwd: path.join(home, "worktrees/shop-backend/integration") }, null), "shop");
});

test("projectForAgent: outside whitelist is null", () => {
  assert.equal(projectForAgent(cfg, { cwd: path.join(home, "development/other-repo") }, null), null);
  assert.equal(projectForAgent(cfg, { cwd: path.join(home, "development/acme-web-other") }, null), null);
});

test("matchProject: key, name, alias, spoken variants", () => {
  assert.equal(matchProject(cfg, "acme")?.key, "acme");
  assert.equal(matchProject(cfg, "Acme Web App")?.key, "acme");
  assert.equal(matchProject(cfg, "ROCKET")?.key, "acme");
  assert.equal(matchProject(cfg, "acme web")?.key, "acme");
  assert.equal(matchProject(cfg, "ÖL")?.key, "shop");
  assert.equal(matchProject(cfg, "oel")?.key, "shop");
  assert.equal(matchProject(cfg, "a"), null);
  assert.equal(matchProject(cfg, "other-repo"), null);
});

function agent(over: Partial<AgentView>): AgentView {
  return {
    instance: null,
    pane_id: "w1:p1",
    workspace_id: "w1",
    tab_id: "w1:t1",
    name: null,
    kind: "claude",
    status: "idle",
    cwd: null,
    workspace_label: "acme-web",
    tab_label: null,
    project: "acme",
    project_name: "Acme Web App",
    topic: null,
    state_change_seq: 0,
    focused: false,
    handle: "",
    ...over,
  };
}

function mkBoard(agents: AgentView[]): Board {
  assignHandles(agents);
  return { agents, workspaces: [], hidden: 0 };
}

const one = (r: ReturnType<typeof resolveTarget>) => (r.kind === "one" ? r.agent.pane_id : r.kind);

test("resolveTarget: name, pane, project, ambiguity", () => {
  const board = mkBoard([
    agent({ pane_id: "w1:p1", name: "reviewer", status: "blocked" }),
    agent({ pane_id: "w2:p1", workspace_id: "w2", workspace_label: "feature-x", topic: "Checkout" }),
    agent({ pane_id: "w3:p1", workspace_id: "w3", project: "shop", project_name: "Shop Backend", workspace_label: "shop-backend" }),
  ]);
  assert.equal((resolveTarget(board, cfg, "reviewer") as { agent: AgentView }).agent.pane_id, "w1:p1");
  assert.equal((resolveTarget(board, cfg, "W2:P1") as { agent: AgentView }).agent.pane_id, "w2:p1");
  assert.equal((resolveTarget(board, cfg, "shop backend") as { agent: AgentView }).agent.pane_id, "w3:p1");
  assert.equal((resolveTarget(board, cfg, "checkout") as { agent: AgentView }).agent.pane_id, "w2:p1");
  const many = resolveTarget(board, cfg, "rocket");
  assert.equal(many.kind, "many");
  const narrowed = resolveTarget(board, cfg, "rocket", ["blocked"]);
  assert.equal(narrowed.kind, "one");
  assert.equal(resolveTarget(board, cfg, "other-repo").kind, "none");
});

test("resolveTarget: a name does not silently beat a workspace of the same name", () => {
  // Live case: an agent named "steerbase" sits in another project's workspace, while the
  // workspace "steerbase" hosts the codex agent that was meant.
  const board = mkBoard([
    agent({ pane_id: "wN:p2", workspace_id: "wN", name: "steerbase", workspace_label: "am-alpengarten-de" }),
    agent({ pane_id: "w22:p1", workspace_id: "w22", kind: "codex", workspace_label: "steerbase", project: "shop", project_name: "Shop Backend" }),
  ]);
  const r = resolveTarget(board, cfg, "steerbase");
  assert.equal(r.kind, "many");
  assert.match((r as { reason: string }).reason, /agent name and workspace/);
  assert.equal(one(resolveTarget(board, cfg, "steerbase/codex")), "w22:p1");
  assert.equal(one(resolveTarget(board, cfg, "am-alpengarten-de/steerbase")), "wN:p2");
});

test("resolveTarget: spoken pane ids and handles", () => {
  const board = mkBoard([
    agent({ pane_id: "w1Y:p1", workspace_id: "w1Y", workspace_label: "integration", name: "dgv-1100" }),
    agent({ pane_id: "w1X:p1", workspace_id: "w1X", workspace_label: "integration", name: "dgv-1049" }),
  ]);
  for (const t of ["w1Y:p1", "w1y p1", "W1Y-P1", "w1yp1"]) assert.equal(one(resolveTarget(board, cfg, t)), "w1Y:p1", t);
  assert.equal(board.agents[0].handle, "integration/dgv-1100");
  assert.equal(one(resolveTarget(board, cfg, "integration/dgv-1100")), "w1Y:p1");
  assert.equal(one(resolveTarget(board, cfg, "Integration / DGV 1049")), "w1X:p1");
  assert.equal(resolveTarget(board, cfg, "integration").kind, "many");
});

test("assignHandles: duplicates get the pane id appended", () => {
  const agents = [
    agent({ pane_id: "w7:p1", workspace_label: "development" }),
    agent({ pane_id: "w1H:p1", workspace_label: "development" }),
    agent({ pane_id: "w3:p1", workspace_label: "shop", tab_label: "api" }),
  ];
  const board = mkBoard(agents);
  assert.deepEqual(agents.map((a) => a.handle), ["development/claude@w7:p1", "development/claude@w1H:p1", "shop/api"]);
  assert.equal(one(resolveTarget(board, cfg, "development/claude@w1H:p1")), "w1H:p1");
  assert.equal(resolveTarget(board, cfg, "development/claude").kind, "many");
});

test("projectForAgent: the most specific root wins, whatever the config order", () => {
  const nested = parseConfig({
    projects: {
      dev: { name: "Development", root: "~/development" },
      acme: { name: "Acme Web App", root: "~/development/acme-web" },
    },
  });
  assert.equal(projectForAgent(nested, { cwd: path.join(home, "development/acme-web/src") }, null), "acme");
  assert.equal(projectForAgent(nested, { cwd: path.join(home, "development") }, null), "dev");
  assert.equal(projectForAgent(nested, { cwd: path.join(home, "development/other-repo") }, null), "dev");
});

test("resolveTarget: an instance prefix narrows and is stripped", () => {
  const named = parseConfig({ ...{ instance_name: "Control Room" }, projects: { acme: { name: "Acme Web App", root: "~/development/acme-web" } } });
  const board = mkBoard([
    agent({ instance: "Control Room", pane_id: "w1:p1", workspace_label: "acme-web", kind: "codex" }),
    agent({ instance: "Control Room", pane_id: "w2:p1", workspace_id: "w2", workspace_label: "feature-x" }),
  ]);
  assert.equal(one(resolveTarget(board, named, "Control Room/acme-web/codex")), "w1:p1");
  assert.equal(one(resolveTarget(board, named, "control room / feature-x")), "w2:p1");
  assert.equal(resolveTarget(board, named, "Control Room").kind, "many");
  // Without the prefix everything works as before.
  assert.equal(one(resolveTarget(board, named, "acme-web/codex")), "w1:p1");
});

test("findProjectWorkspace: label variants, then agents in the root; automation workspaces skipped", () => {
  const root = path.join(home, "development/acme-web");
  const p = cfg.projects.acme;
  assert.equal(findProjectWorkspace([ws("w2", "other"), ws("w3", "Acme-Web")], [], "acme", p, root)?.workspace_id, "w3");
  const agents = [
    { workspace_id: "w5", cwd: root },
    { workspace_id: "w6", cwd: root },
    { workspace_id: "w6", cwd: root },
    { workspace_id: "w7", cwd: path.join(root, "sub") },
  ];
  const list = [ws("w5", "auto: nightly"), ws("w6", "my desk"), ws("w7", "elsewhere")];
  assert.equal(findProjectWorkspace(list, agents, "acme", p, root)?.workspace_id, "w6");
  assert.equal(findProjectWorkspace([ws("w5", "auto: nightly")], agents, "acme", p, root), null);
});

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseConfig } from "../src/config.js";
import type { WorkspaceInfo } from "../src/herdr.js";
import { matchProject, projectForAgent, resolveTarget, type AgentView, type Board } from "../src/projects.js";

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
    ...over,
  };
}

test("resolveTarget: name, pane, project, ambiguity", () => {
  const board: Board = {
    agents: [
      agent({ pane_id: "w1:p1", name: "reviewer", status: "blocked" }),
      agent({ pane_id: "w2:p1", workspace_id: "w2", workspace_label: "feature-x", topic: "Checkout" }),
      agent({ pane_id: "w3:p1", workspace_id: "w3", project: "shop", project_name: "Shop Backend", workspace_label: "shop-backend" }),
    ],
    workspaces: [],
    hidden: 0,
  };
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

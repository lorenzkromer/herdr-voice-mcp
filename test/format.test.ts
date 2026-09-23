import assert from "node:assert/strict";
import { test } from "node:test";
import { formatBoard, humanDuration, trimTail } from "../src/format.js";
import type { AgentView } from "../src/projects.js";
import { Tracker } from "../src/tracker.js";
import { HerdrClient } from "../src/herdr.js";

test("humanDuration", () => {
  assert.equal(humanDuration(5_000), "5 seconds");
  assert.equal(humanDuration(60_000), "1 minute");
  assert.equal(humanDuration(25 * 60_000), "25 minutes");
  assert.equal(humanDuration(3 * 3600_000), "3 hours");
  assert.equal(humanDuration(90 * 60_000), "1 h 30 min");
});

test("trimTail drops rulers and blank lines", () => {
  const t = trimTail("a\n\n────────\nb   \nc\n", 2);
  assert.equal(t, "b\nc");
});

test("formatBoard groups by status and counts attention", () => {
  const tracker = new Tracker(new HerdrClient("/nonexistent"));
  const mk = (pane_id: string, status: AgentView["status"], project_name = "Acme Web App"): AgentView => ({
    pane_id,
    workspace_id: "w1",
    tab_id: "w1:t1",
    name: null,
    kind: "claude",
    status,
    cwd: null,
    workspace_label: "acme-web",
    tab_label: null,
    project: "acme",
    project_name,
    topic: "Checkout",
    state_change_seq: 1,
    focused: false,
  });
  const out = formatBoard([mk("w1:p1", "blocked"), mk("w2:p1", "working"), mk("w3:p1", "done")], tracker, { hidden: 2 });
  assert.match(out, /3 agents in 1 project, 2 need attention/);
  assert.match(out, /Needs a decision:/);
  assert.match(out, /Finished, not yet reviewed:/);
  assert.match(out, /2 more agents run/);
  const attention = formatBoard([mk("w2:p1", "working")], tracker, { hidden: 0, attentionOnly: true });
  assert.match(attention, /Nobody needs anything right now/);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { sinceText } from "../src/format.js";
import { HerdrClient, type AgentInfo, type AgentStatus } from "../src/herdr.js";
import type { AgentView } from "../src/projects.js";
import { Tracker } from "../src/tracker.js";

function info(pane_id: string, agent_status: AgentStatus, state_change_seq?: number): AgentInfo {
  return { terminal_id: "t", pane_id, tab_id: "w1:t1", workspace_id: "w1", agent: "claude", agent_status, focused: false, revision: 0, state_change_seq };
}

function tracker(): Tracker {
  const t = new Tracker(new HerdrClient("/nonexistent"));
  return t;
}

test("states seen at startup are not exact, later changes are", () => {
  const t = tracker();
  t.observe(info("w1:p1", "done", 10), true);
  t.ready = true;
  assert.equal(t.get("w1:p1")!.exact, false);
  t.observe(info("w1:p1", "working", 12));
  assert.equal(t.get("w1:p1")!.exact, true);
  assert.equal(t.get("w1:p1")!.previous, "done");
});

test("a seq jump with an unchanged status counts as a missed change", () => {
  const t = tracker();
  t.observe(info("w1:p1", "done", 10), true);
  t.ready = true;
  const before = t.get("w1:p1")!.since;
  // done → working → done happened unseen; only the seq tells.
  assert.equal(t.observe(info("w1:p1", "done", 17)), true);
  const s = t.get("w1:p1")!;
  assert.equal(s.exact, true);
  assert.ok(s.since.getTime() >= before.getTime());
  // Same seq again: nothing new.
  assert.equal(t.observe(info("w1:p1", "done", 17)), false);
});

test("an event without seq does not make the next poll look like a change", () => {
  const t = tracker();
  t.observe(info("w1:p1", "idle", 10), true);
  t.ready = true;
  t.observe(info("w1:p1", "working")); // event payload: no seq
  assert.equal(t.get("w1:p1")!.seq, null);
  assert.equal(t.observe(info("w1:p1", "working", 11)), false); // poll adopts the seq
  assert.equal(t.get("w1:p1")!.seq, 11);
});

test("sinceText: unknown start is reported as 'since before', not as a duration", () => {
  const t = tracker();
  t.observe(info("w1:p1", "done", 10), true);
  t.ready = true;
  const view = { pane_id: "w1:p1" } as AgentView;
  assert.match(sinceText(view, t), /since before \d\d:\d\d, when the service started/);
  t.observe(info("w1:p1", "working", 11));
  assert.match(sinceText(view, t, Date.now() + 5 * 60_000), /\(for 5 minutes\)/);
});

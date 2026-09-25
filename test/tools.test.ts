import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Audit } from "../src/audit.js";
import { parseConfig } from "../src/config.js";
import { HerdrClient } from "../src/herdr.js";
import { createMcpServer } from "../src/tools.js";
import { Tracker } from "../src/tracker.js";

// Fake Herdr with one working agent whose agent.read refuses while busy (agent_not_idle).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-tools-"));
const sockPath = path.join(dir, "fake.sock");
const home = os.homedir();
let server: net.Server;
let prompts = 0;
let screen = "first line\nsecond line";
/** agent.prompt refuses this many times with agent_not_ready (a freshly started agent). */
let notReadyPrompts = 0;
/** Error code agent.prompt answers with instead of accepting, or null. */
let promptError: string | null = null;
let keysSent: string[][] = [];
let tabsCreated = 0;
let workspacesCreated = 0;
let started: string[] = [];

const agentInfo = () => ({
  terminal_id: "t1", pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", agent: "claude", name: null,
  agent_status: "working", cwd: path.join(home, "development/acme-web"), focused: false, revision: 1, state_change_seq: 5,
});

before(async () => {
  server = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (c) => {
      buf += c.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const req = JSON.parse(buf.slice(0, nl));
      const reply = (result: unknown) => sock.end(JSON.stringify({ id: req.id, result }) + "\n");
      const fail = (code: string) => sock.end(JSON.stringify({ id: req.id, error: { code, message: code } }) + "\n");
      switch (req.method) {
        case "agent.list": return reply({ agents: [agentInfo()] });
        case "workspace.list": return reply({ workspaces: [{ workspace_id: "w1", number: 1, label: "Acme Web", focused: false, pane_count: 1, tab_count: 1, active_tab_id: "w1:t1", agent_status: "working" }] });
        case "tab.list": return reply({ tabs: [] });
        case "agent.prompt":
          if (notReadyPrompts > 0) {
            notReadyPrompts--;
            return fail("agent_not_ready");
          }
          if (promptError) return fail(promptError);
          prompts++;
          return reply({ agent: agentInfo() });
        case "agent.get": return reply({ agent: agentInfo() });
        case "agent.send_keys": keysSent.push(req.params.keys); return reply({});
        case "agent.wait": return fail("timeout");
        case "tab.create": tabsCreated++; return reply({ tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p2" } });
        case "workspace.create": workspacesCreated++; return reply({ workspace: { workspace_id: "w9", label: req.params.label }, tab: { tab_id: "w9:t1" }, root_pane: { pane_id: "w9:p1" } });
        case "agent.start": started.push(req.params.name); return reply({ agent: { ...agentInfo(), pane_id: req.params.pane_id, name: req.params.name, agent_status: "idle" } });
        case "agent.read": return fail("agent_not_idle");
        case "pane.read": return reply({ read: { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", source: req.params.source, format: "text", text: screen + "\n✻ Working… (12s · esc to interrupt)\n", revision: 1, truncated: false } });
        default: return fail("unknown_method");
      }
    });
  });
  await new Promise<void>((r) => server.listen(sockPath, r));
});

after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function connect() {
  const cfg = parseConfig({ instance_name: "Control Room", socket: sockPath, audit_log: path.join(dir, "audit.jsonl"), projects: { acme: { name: "Acme Web App", root: "~/development/acme-web" } } });
  const client = new HerdrClient(sockPath);
  const tracker = new Tracker(client);
  const mcp = createMcpServer({ cfg, client, tracker, audit: new Audit(cfg.audit_log, () => {}), source: "test" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await mcp.connect(a);
  const c = new Client({ name: "test", version: "0" });
  await c.connect(b);
  return c;
}

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0].text);

test("send with the same request_id delivers once and replays the first answer", async () => {
  const c = await connect();
  const args = { target: "Acme Web/claude", text: "run the tests", settle_seconds: 0, request_id: "req-1" };
  const first = await c.callTool({ name: "send", arguments: args });
  assert.equal((first.structuredContent as { delivered: boolean }).delivered, true);
  const again = await c.callTool({ name: "send", arguments: args });
  assert.equal(prompts, 1);
  assert.match(textOf(again), /Replay: request_id "req-1"/);
  assert.equal((again.structuredContent as { replayed: boolean }).replayed, true);

  const d = await c.callTool({ name: "deliveries", arguments: { request_id: "req-1" } });
  assert.match(textOf(d), /1 handover .*\n.*"Acme Web\/claude".*request_id req-1: run the tests/);
});

test("read falls back to pane.read while busy and reports whether the screen changed", async () => {
  const c = await connect();
  const r1 = await c.callTool({ name: "read", arguments: { target: "Acme Web" } });
  assert.match(textOf(r1), /first read of this agent/);
  assert.match(textOf(r1), /second line/);
  // Only the ticking progress line differs → unchanged.
  const r2 = await c.callTool({ name: "read", arguments: { target: "Acme Web" } });
  assert.equal((r2.structuredContent as { changed_since_last_read: boolean }).changed_since_last_read, false);
  assert.match(textOf(r2), /UNCHANGED/);
  screen += "\nthird line";
  const r3 = await c.callTool({ name: "read", arguments: { target: "Acme Web" } });
  assert.equal((r3.structuredContent as { changed_since_last_read: boolean }).changed_since_last_read, true);
});

test("the instance name reaches the client and the board", async () => {
  const c = await connect();
  assert.equal(c.getServerVersion()?.title, "Agency – Control Room");
  assert.match(c.getInstructions() ?? "", /Herdr instance "Control Room"/);
  const s = await c.callTool({ name: "status", arguments: {} });
  assert.match(textOf(s), /^Board on Control Room at /);
  assert.equal((s.structuredContent as { instance: string }).instance, "Control Room");
  const p = await c.callTool({ name: "projects", arguments: {} });
  assert.match(textOf(p), /^Projects on Control Room:/);
  const r = await c.callTool({ name: "read", arguments: { target: "Control Room/Acme Web/claude" } });
  assert.equal(r.isError, undefined);
});

test("send waits while the agent is not ready yet and then delivers", async () => {
  const c = await connect();
  const before = prompts;
  notReadyPrompts = 2;
  const r = await c.callTool({ name: "send", arguments: { target: "Acme Web/claude", text: "task after warm-up", settle_seconds: 0 } });
  assert.equal(r.isError, undefined, textOf(r));
  assert.equal(prompts, before + 1);
  const sc = r.structuredContent as { delivery: string; delivery_attempts: number };
  assert.equal(sc.delivery, "delivered");
  assert.equal(sc.delivery_attempts, 3);
});

test("send reports NOT delivered on a refusal and logs it", async () => {
  const c = await connect();
  promptError = "agent_rejected";
  const r = await c.callTool({ name: "send", arguments: { target: "Acme Web/claude", text: "refused task", settle_seconds: 0, request_id: "req-refused" } });
  promptError = null;
  assert.equal(r.isError, true);
  assert.match(textOf(r), /NOT delivered .*nothing arrived/);
  assert.equal((r.structuredContent as { effect: boolean }).effect, false);
  const d = await c.callTool({ name: "deliveries", arguments: { request_id: "req-refused" } });
  assert.match(textOf(d), /NOT delivered \(agent_rejected/);
  // A failed handover is not final: the same request_id may be retried and then delivers.
  const again = await c.callTool({ name: "send", arguments: { target: "Acme Web/claude", text: "refused task", settle_seconds: 0, request_id: "req-refused" } });
  assert.equal((again.structuredContent as { delivery: string }).delivery, "delivered");
});

test("send marks a stalled prompt as outcome unknown, never retried", async () => {
  const c = await connect();
  const before = prompts;
  promptError = "agent_prompt_stalled";
  const r = await c.callTool({ name: "send", arguments: { target: "Acme Web/claude", text: "maybe typed", settle_seconds: 0 } });
  promptError = null;
  assert.equal(prompts, before);
  assert.equal((r.structuredContent as { delivery: string }).delivery, "unknown");
  assert.match(textOf(r), /UNKNOWN whether it arrived/);
});

test("spawn hands the first task over once the new agent is ready", async () => {
  const c = await connect();
  const before = prompts;
  notReadyPrompts = 2; // "agent w1:p2 is not an active named agent" right after start
  const r = await c.callTool({ name: "spawn", arguments: { project: "acme", name: "fresh-one", prompt: "first task", request_id: "spawn-1" } });
  assert.equal(r.isError, undefined, textOf(r));
  assert.equal(prompts, before + 1);
  assert.match(textOf(r), /first task was delivered/);
  // The workspace is found by its spoken-style label ("Acme Web" for root acme-web): a tab, not a new workspace.
  assert.equal(workspacesCreated, 0);
  assert.equal(tabsCreated, 1);
  // A retry with the same request_id starts nothing.
  const again = await c.callTool({ name: "spawn", arguments: { project: "acme", name: "fresh-one", prompt: "first task", request_id: "spawn-1" } });
  assert.equal((again.structuredContent as { replayed: boolean }).replayed, true);
  assert.deepEqual(started, ["fresh-one"]);
});

test("spawn says clearly when only the agent is running and the task is missing", async () => {
  const c = await connect();
  promptError = "agent_rejected";
  const r = await c.callTool({ name: "spawn", arguments: { project: "acme", name: "no-task", prompt: "lost task" } });
  promptError = null;
  assert.equal(r.isError, true);
  assert.match(textOf(r), /is running as "Acme Web\/no-task".*NOT delivered/s);
  const sc = r.structuredContent as { effect: boolean; delivered: boolean; handle: string };
  assert.equal(sc.effect, true);
  assert.equal(sc.delivered, false);
});

test("keys with the same request_id are pressed only once", async () => {
  const c = await connect();
  keysSent = [];
  const args = { target: "Acme Web/claude", keys: ["y", "enter"], request_id: "keys-1" };
  await c.callTool({ name: "keys", arguments: args });
  const again = await c.callTool({ name: "keys", arguments: args });
  assert.deepEqual(keysSent, [["y", "enter"]]);
  assert.equal((again.structuredContent as { replayed: boolean }).replayed, true);
  const d = await c.callTool({ name: "deliveries", arguments: { request_id: "keys-1" } });
  assert.match(textOf(d), /via keys: delivered.*: y enter/);
});

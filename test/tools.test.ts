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
        case "workspace.list": return reply({ workspaces: [{ workspace_id: "w1", number: 1, label: "acme-web", focused: false, pane_count: 1, tab_count: 1, active_tab_id: "w1:t1", agent_status: "working" }] });
        case "tab.list": return reply({ tabs: [] });
        case "agent.prompt": prompts++; return reply({ agent: agentInfo() });
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
  const args = { target: "acme-web/claude", text: "run the tests", settle_seconds: 0, request_id: "req-1" };
  const first = await c.callTool({ name: "send", arguments: args });
  assert.equal((first.structuredContent as { delivered: boolean }).delivered, true);
  const again = await c.callTool({ name: "send", arguments: args });
  assert.equal(prompts, 1);
  assert.match(textOf(again), /Replay: request_id "req-1"/);
  assert.equal((again.structuredContent as { replayed: boolean }).replayed, true);

  const d = await c.callTool({ name: "deliveries", arguments: { request_id: "req-1" } });
  assert.match(textOf(d), /1 delivery .*\n.*"acme-web\/claude".*request_id req-1: run the tests/);
});

test("read falls back to pane.read while busy and reports whether the screen changed", async () => {
  const c = await connect();
  const r1 = await c.callTool({ name: "read", arguments: { target: "acme-web" } });
  assert.match(textOf(r1), /first read of this agent/);
  assert.match(textOf(r1), /second line/);
  // Only the ticking progress line differs → unchanged.
  const r2 = await c.callTool({ name: "read", arguments: { target: "acme-web" } });
  assert.equal((r2.structuredContent as { changed_since_last_read: boolean }).changed_since_last_read, false);
  assert.match(textOf(r2), /UNCHANGED/);
  screen += "\nthird line";
  const r3 = await c.callTool({ name: "read", arguments: { target: "acme-web" } });
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
  const r = await c.callTool({ name: "read", arguments: { target: "Control Room/acme-web/claude" } });
  assert.equal(r.isError, undefined);
});

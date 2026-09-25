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
import { Fleet, instancesFromConfig } from "../src/fleet.js";
import { createMcpServer } from "../src/tools.js";

// Two fake Herdr servers that deliberately share pane id and workspace label ("w1:p1" in "shop"):
// the dangerous case for addressing across machines.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-fleet-"));
const home = os.homedir();

interface Fake {
  sock: string;
  server: net.Server;
  prompts: string[];
  started: string[];
}

function fakeHerdr(name: string, root: string): Fake {
  const f: Fake = { sock: path.join(dir, `${name}.sock`), server: null as unknown as net.Server, prompts: [], started: [] };
  const agent = (over: Record<string, unknown> = {}) => ({
    terminal_id: "t1", pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", agent: "claude", name: null,
    agent_status: "idle", cwd: root, focused: false, revision: 1, state_change_seq: 3, ...over,
  });
  f.server = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (c) => {
      buf += c.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const req = JSON.parse(buf.slice(0, nl));
      const reply = (result: unknown) => sock.end(JSON.stringify({ id: req.id, result }) + "\n");
      const fail = (code: string) => sock.end(JSON.stringify({ id: req.id, error: { code, message: code } }) + "\n");
      switch (req.method) {
        case "agent.list": return reply({ agents: [agent()] });
        case "workspace.list": return reply({ workspaces: [{ workspace_id: "w1", number: 1, label: "shop", focused: false, pane_count: 1, tab_count: 1, active_tab_id: "w1:t1", agent_status: "idle" }] });
        case "tab.list": return reply({ tabs: [] });
        case "agent.get": return reply({ agent: agent() });
        case "agent.prompt": f.prompts.push(req.params.text); return reply({ agent: agent({ agent_status: "working" }) });
        case "agent.read": case "pane.read": return reply({ read: { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", source: "x", format: "text", text: `${name} screen`, revision: 1, truncated: false } });
        case "agent.wait": return fail("timeout");
        case "workspace.create": return reply({ workspace: { workspace_id: "w9", label: req.params.label }, tab: { tab_id: "w9:t1" }, root_pane: { pane_id: "w9:p1" } });
        case "tab.create": return reply({ tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p2" } });
        case "agent.start": f.started.push(req.params.name); return reply({ agent: agent({ pane_id: req.params.pane_id, name: req.params.name }) });
        default: return fail("unknown_method");
      }
    });
  });
  return f;
}

const office = fakeHerdr("office", path.join(home, "development/shop"));
const homeBox = fakeHerdr("home", "/home/agent/development/shop");

before(async () => {
  await Promise.all([office, homeBox].map((f) => new Promise<void>((r) => f.server.listen(f.sock, r))));
});

after(() => {
  office.server.close();
  homeBox.server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function config(homeSocket = homeBox.sock) {
  return parseConfig({
    instance_name: "Office",
    socket: office.sock,
    audit_log: path.join(dir, "audit.jsonl"),
    projects: { shop: { name: "Shop", root: "~/development/shop" }, office_only: { name: "Office Only", root: "~/development/office-only" } },
    instances: [{ name: "Home", socket: homeSocket, projects: { shop: { name: "Shop", root: "/home/agent/development/shop" } } }],
  });
}

async function connect(homeSocket?: string) {
  const cfg = config(homeSocket);
  const fleet = new Fleet(instancesFromConfig(cfg, () => {}), cfg);
  const mcp = createMcpServer({ cfg, fleet, audit: new Audit(cfg.audit_log, () => {}), source: "test" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await mcp.connect(a);
  const c = new Client({ name: "test", version: "0" });
  await c.connect(b);
  return c;
}

const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0].text;

test("config: instances need instance_name, unique names and absolute remote roots", () => {
  assert.throws(() => parseConfig({ instances: [{ name: "Home", socket: "/x" }] }), /instance_name must be set/);
  assert.throws(() => parseConfig({ instance_name: "Home", instances: [{ name: "home", socket: "/x" }] }), /used twice/);
  assert.throws(
    () => parseConfig({ instance_name: "Office", instances: [{ name: "Home", socket: "/x", projects: { p: { name: "P", root: "~/p" } } }] }),
    /must be an absolute path/,
  );
});

test("status merges both machines; handles start with the instance", async () => {
  const c = await connect();
  const r = await c.callTool({ name: "status", arguments: {} });
  assert.match(textOf(r), /^Board on Office \+ Home at /);
  const handles = (r.structuredContent as { agents: Array<{ handle: string }> }).agents.map((a) => a.handle).sort();
  assert.deepEqual(handles, ["Home/shop/claude", "Office/shop/claude"]);
});

test("a target that exists on both machines is ambiguous, a qualified one is not", async () => {
  const c = await connect();
  for (const t of ["shop/claude", "w1:p1", "shop"]) {
    const r = await c.callTool({ name: "read", arguments: { target: t } });
    assert.equal(r.isError, true, t);
  }
  const r = await c.callTool({ name: "read", arguments: { target: "Home/shop/claude" } });
  assert.match(textOf(r), /home screen/);
});

test("send reaches only the named machine; duplicate guard is per machine", async () => {
  const c = await connect();
  const before = { o: office.prompts.length, h: homeBox.prompts.length };
  await c.callTool({ name: "send", arguments: { target: "Home/shop/claude", text: "same text", settle_seconds: 0 } });
  await c.callTool({ name: "send", arguments: { target: "Office/shop/claude", text: "same text", settle_seconds: 0 } });
  assert.equal(homeBox.prompts.length, before.h + 1);
  assert.equal(office.prompts.length, before.o + 1);
  const d = await c.callTool({ name: "deliveries", arguments: { target: "Home/shop/claude" } });
  assert.match(textOf(d), /1 handover .*"Home\/shop\/claude"/s);
});

test("while a machine is unreachable, writing tools need a named target", async () => {
  const c = await connect(path.join(dir, "missing.sock"));
  const s = await c.callTool({ name: "status", arguments: {} });
  assert.match(textOf(s), /Home is NOT reachable right now/);
  const before = office.prompts.length;
  const refused = await c.callTool({ name: "send", arguments: { target: "shop/claude", text: "unqualified", settle_seconds: 0 } });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /might also mean an agent there. Nothing was done/);
  const refusedHome = await c.callTool({ name: "send", arguments: { target: "Home/shop/claude", text: "to the dead one", settle_seconds: 0 } });
  assert.match(textOf(refusedHome), /Home is not reachable right now/);
  const ok = await c.callTool({ name: "send", arguments: { target: "Office/shop/claude", text: "named", settle_seconds: 0 } });
  assert.equal(ok.isError, undefined, textOf(ok));
  assert.equal(office.prompts.length, before + 1);
});

test("spawn picks the only machine with the project, asks when there are several", async () => {
  const c = await connect();
  const ambiguous = await c.callTool({ name: "spawn", arguments: { project: "shop", name: "x-one" } });
  assert.equal(ambiguous.isError, true);
  assert.match(textOf(ambiguous), /exists on several machines: Office, Home. Nothing was started/);

  const onHome = await c.callTool({ name: "spawn", arguments: { project: "Home/shop", name: "x-two" } });
  assert.equal(onHome.isError, undefined, textOf(onHome));
  assert.deepEqual(homeBox.started.slice(-1), ["x-two"]);
  assert.equal((onHome.structuredContent as { handle: string }).handle, "Home/shop/x-two");

  const byParam = await c.callTool({ name: "spawn", arguments: { project: "shop", instance: "office", name: "x-three" } });
  assert.equal(byParam.isError, undefined, textOf(byParam));
  assert.deepEqual(office.started.slice(-1), ["x-three"]);

  const officeOnly = await c.callTool({ name: "spawn", arguments: { project: "office only", name: "x-four" } });
  assert.equal(officeOnly.isError, undefined, textOf(officeOnly));
  assert.deepEqual(office.started.slice(-1), ["x-four"]);
});

test("projects lists each machine separately", async () => {
  const c = await connect();
  const r = await c.callTool({ name: "projects", arguments: {} });
  assert.match(textOf(r), /Projects on Office:\n- Shop .*1 agent.*\n- Office Only.*\n\nProjects on Home:\n- Shop .*1 agent/s);
});

test("an instance prefix works even while that machine has no agents", async () => {
  const c = await connect();
  const r = await c.callTool({ name: "read", arguments: { target: "Home/shop/nobody" } });
  assert.equal(r.isError, true);
  // Must not fall back to candidates on another machine.
  assert.doesNotMatch(textOf(r), /Office\//);
});

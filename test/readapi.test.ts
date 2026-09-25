import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { Audit } from "../src/audit.js";
import { parseConfig } from "../src/config.js";
import { Fleet, instancesFromConfig } from "../src/fleet.js";
import { ReadApi } from "../src/readapi.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-readapi-"));
const sockPath = path.join(dir, "herdr.sock");
const home = os.homedir();
const TOKEN = "r".repeat(40);
const ORIGIN = "http://localhost:5178";
let herdr: net.Server;
let server: http.Server;
let base = "";
let api: ReadApi;

before(async () => {
  herdr = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (c) => {
      buf += c.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const req = JSON.parse(buf.slice(0, nl));
      const reply = (result: unknown) => sock.end(JSON.stringify({ id: req.id, result }) + "\n");
      if (req.method === "agent.list")
        return reply({ agents: [{ terminal_id: "t", pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", agent: "codex", name: "dachs", agent_status: "working", cwd: path.join(home, "development/shop"), focused: false, revision: 1, state_change_seq: 4, terminal_title_stripped: "Refactor checkout" }] });
      if (req.method === "workspace.list") return reply({ workspaces: [{ workspace_id: "w1", number: 1, label: "shop", focused: false, pane_count: 1, tab_count: 1, active_tab_id: "w1:t1", agent_status: "working" }] });
      if (req.method === "tab.list") return reply({ tabs: [] });
      sock.end(JSON.stringify({ id: req.id, error: { code: "unknown_method", message: "x" } }) + "\n");
    });
  });
  await new Promise<void>((r) => herdr.listen(sockPath, r));

  const cfg = parseConfig({
    instance_name: "Office",
    socket: sockPath,
    audit_log: path.join(dir, "audit.jsonl"),
    projects: { shop: { name: "Shop", root: "~/development/shop" } },
    read_api: { enabled: true, tokens: [{ name: "dashboard", token: TOKEN }], allowed_origins: [ORIGIN] },
  });
  const fleet = new Fleet(instancesFromConfig(cfg, () => {}), cfg);
  api = new ReadApi(cfg, fleet, new Audit(cfg.audit_log, () => {}));
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (api.matches(url.pathname)) return void api.handle(req, res, url, "test");
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
});

after(() => {
  api.close();
  server.close();
  herdr.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const auth = { Authorization: `Bearer ${TOKEN}` };

test("GET /api/agents: the status tool's agent fields, nothing from the screen", async () => {
  const r = await fetch(`${base}/api/agents`, { headers: auth });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { agents: Array<Record<string, unknown>>; instances: unknown[] };
  assert.equal(body.agents.length, 1);
  const a = body.agents[0];
  assert.deepEqual(
    Object.keys(a).sort(),
    ["handle", "instance", "kind", "name", "project", "project_name", "seconds_in_state", "since", "since_exact", "status", "topic", "workspace"],
  );
  assert.equal(a.instance, "Office");
  assert.equal(a.handle, "shop/dachs");
  assert.equal(a.kind, "codex");
  assert.equal(a.status, "working");
  assert.equal(a.topic, "Refactor checkout");
  assert.deepEqual(body.instances, [{ name: "Office", reachable: true }]);
});

test("no token, a wrong token or a token in the URL are refused", async () => {
  assert.equal((await fetch(`${base}/api/agents`)).status, 401);
  assert.equal((await fetch(`${base}/api/agents`, { headers: { Authorization: "Bearer " + "x".repeat(40) } })).status, 401);
  const inUrl = await fetch(`${base}/api/agents?token=${TOKEN}`, { headers: auth });
  assert.equal(inUrl.status, 400);
  assert.match(await inUrl.text(), /Authorization header, never in the URL/);
});

test("CORS only for the configured origin", async () => {
  const pre = await fetch(`${base}/api/agents`, { method: "OPTIONS", headers: { Origin: ORIGIN, "Access-Control-Request-Headers": "authorization" } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), ORIGIN);
  assert.match(pre.headers.get("access-control-allow-headers") ?? "", /Authorization/);
  const ok = await fetch(`${base}/api/agents`, { headers: { ...auth, Origin: ORIGIN } });
  assert.equal(ok.headers.get("access-control-allow-origin"), ORIGIN);
  const evil = await fetch(`${base}/api/agents`, { headers: { ...auth, Origin: "https://evil.example" } });
  assert.equal(evil.status, 403);
  assert.equal(evil.headers.get("access-control-allow-origin"), null);
});

test("writing methods are refused", async () => {
  assert.equal((await fetch(`${base}/api/agents`, { method: "POST", headers: auth, body: "{}" })).status, 405);
});

test("the stream sends a snapshot right away", async () => {
  const ac = new AbortController();
  const r = await fetch(`${base}/api/agents/stream`, { headers: auth, signal: ac.signal });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = r.body!.getReader();
  let text = "";
  while (!text.includes("event: agents")) text += new TextDecoder().decode((await reader.read()).value);
  while (!/event: agents\ndata: .*\n\n/.test(text)) text += new TextDecoder().decode((await reader.read()).value);
  const data = JSON.parse(text.match(/event: agents\ndata: (.*)\n\n/)![1]);
  assert.equal(data.agents[0].handle, "shop/dachs");
  ac.abort();
});

test("config: tokens required, origins exact, path separate from the MCP endpoint", () => {
  assert.throws(() => parseConfig({ read_api: { enabled: true } }), /at least one entry/);
  const tokens = [{ name: "t", token: TOKEN }];
  assert.throws(() => parseConfig({ read_api: { enabled: true, tokens, allowed_origins: ["http://localhost:5178/"] } }), /must be exactly an origin/);
  assert.throws(() => parseConfig({ read_api: { enabled: true, tokens, allowed_origins: ["*"] } }), /not an origin/);
  assert.throws(() => parseConfig({ read_api: { enabled: true, tokens, path: "/mcp" } }), /must not overlap/);
  assert.throws(() => parseConfig({ read_api: { enabled: true, tokens: [{ name: "t", token: "short" }] } }));
});
